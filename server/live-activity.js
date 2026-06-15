import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import path from 'node:path';

export const TUBE_LINES = new Map([
  ['bakerloo', 'Bakerloo'],
  ['central', 'Central'],
  ['circle', 'Circle'],
  ['district', 'District'],
  ['hammersmith-city', 'Hammersmith & City'],
  ['jubilee', 'Jubilee'],
  ['metropolitan', 'Metropolitan'],
  ['northern', 'Northern'],
  ['piccadilly', 'Piccadilly'],
  ['victoria', 'Victoria'],
  ['waterloo-city', 'Waterloo & City']
]);

const APPLE_REFERENCE_UNIX_SECONDS = 978307200;
const TOKEN_REDACTION = '[redacted]';

export function loadConfig(env = process.env) {
  return {
    dataFile: env.LIVE_ACTIVITY_DATA_FILE || path.join('data', 'live-activities.json'),
    workerEnabled: env.LIVE_ACTIVITY_WORKER_ENABLED !== 'false',
    workerIntervalMs: parsePositiveInteger(env.LIVE_ACTIVITY_WORKER_INTERVAL_MS, 90_000),
    maxActiveMs: parsePositiveInteger(env.LIVE_ACTIVITY_MAX_ACTIVE_HOURS, 8) * 60 * 60 * 1000,
    retentionMs: parsePositiveInteger(env.LIVE_ACTIVITY_RETENTION_HOURS, 24) * 60 * 60 * 1000,
    tokenRateLimit: parsePositiveInteger(env.LIVE_ACTIVITY_TOKEN_RATE_LIMIT, 6),
    tokenRateWindowMs: parsePositiveInteger(env.LIVE_ACTIVITY_TOKEN_RATE_WINDOW_MS, 60_000),
    tflAppKey: env.TFL_APP_KEY || '',
    apns: {
      teamId: env.APNS_TEAM_ID || '',
      keyId: env.APNS_KEY_ID || '',
      authKeyPath: env.APNS_AUTH_KEY_PATH || '',
      authKey: env.APNS_AUTH_KEY || '',
      bundleId: env.APNS_BUNDLE_ID || 'OllyJ.My-Train-Times'
    }
  };
}

export class LiveActivityStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { records: [] };
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state.records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    this.loaded = true;
  }

  async save() {
    await this.load();
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpFile = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpFile, `${JSON.stringify(this.state, null, 2)}\n`);
      await fs.rename(tmpFile, this.filePath);
    });
    return this.writeQueue;
  }

  async upsertToken(payload, now = new Date()) {
    await this.load();
    const nowIso = now.toISOString();
    const matchIndex = this.state.records.findIndex((record) => {
      if (record.environment !== payload.environment) {
        return false;
      }

      if (record.activityID === payload.activityID) {
        return true;
      }

      return record.installID === payload.installID
        && record.stationID === payload.stationID
        && record.lineID === payload.lineID;
    });

    const previous = matchIndex >= 0 ? this.state.records[matchIndex] : {};
    const record = {
      ...previous,
      installID: payload.installID,
      activityID: payload.activityID,
      stationID: payload.stationID,
      lineID: payload.lineID,
      selectionMode: payload.selectionMode,
      platformID: payload.platformID,
      platformHeading: payload.platformHeading,
      platformLabel: payload.platformLabel,
      platformDirection: payload.platformDirection,
      pushTokenHex: payload.pushTokenHex,
      tokenUpdatedAt: payload.tokenUpdatedAt,
      appBundleID: payload.appBundleID,
      appVersion: payload.appVersion,
      buildNumber: payload.buildNumber,
      environment: payload.environment,
      active: true,
      createdAt: previous.createdAt || nowIso,
      updatedAt: nowIso,
      endedAt: null,
      endReason: null,
      apnsFailureReason: null
    };

    if (matchIndex >= 0) {
      this.state.records[matchIndex] = record;
    } else {
      this.state.records.push(record);
    }

    await this.save();
    return redactRecord(record);
  }

  async endActivity(payload, now = new Date()) {
    await this.load();
    const record = this.state.records.find((candidate) => {
      return candidate.activityID === payload.activityID
        && candidate.installID === payload.installID
        && candidate.active !== false;
    });

    if (!record) {
      return false;
    }

    record.active = false;
    record.endedAt = payload.endedAt || now.toISOString();
    record.endReason = payload.reason || 'unknown';
    record.updatedAt = now.toISOString();
    await this.save();
    return true;
  }

  async listActive(now = new Date(), config = loadConfig()) {
    await this.load();
    const nowMs = now.getTime();
    return this.state.records.filter((record) => {
      if (record.active === false) {
        return false;
      }

      const createdAt = Date.parse(record.createdAt || record.tokenUpdatedAt || record.updatedAt);
      if (Number.isFinite(createdAt) && nowMs - createdAt > config.maxActiveMs) {
        return false;
      }

      const backoffUntil = Date.parse(record.backoffUntil || '');
      return !Number.isFinite(backoffUntil) || backoffUntil <= nowMs;
    });
  }

  async markPushed(activityID, environment, info, now = new Date()) {
    await this.load();
    const record = this.findByActivity(activityID, environment);
    if (!record) {
      return;
    }

    record.lastPushAt = now.toISOString();
    record.lastSuccessAt = now.toISOString();
    record.updatedAt = now.toISOString();
    record.consecutiveEmptyCycles = info.emptyArrivals ? (record.consecutiveEmptyCycles || 0) + 1 : 0;
    record.backoffUntil = null;
    await this.save();
  }

  async markBackoff(activityID, environment, delayMs, reason, now = new Date()) {
    await this.load();
    const record = this.findByActivity(activityID, environment);
    if (!record) {
      return;
    }

    record.backoffUntil = new Date(now.getTime() + delayMs).toISOString();
    record.backoffReason = reason;
    record.updatedAt = now.toISOString();
    await this.save();
  }

  async deactivate(activityID, environment, reason, now = new Date()) {
    await this.load();
    const record = this.findByActivity(activityID, environment);
    if (!record) {
      return;
    }

    record.active = false;
    record.endedAt = now.toISOString();
    record.apnsFailureReason = reason;
    record.updatedAt = now.toISOString();
    await this.save();
  }

  async expireOld(now = new Date(), config = loadConfig()) {
    await this.load();
    const nowMs = now.getTime();
    let changed = false;

    for (const record of this.state.records) {
      if (record.active === false) {
        continue;
      }

      const createdAt = Date.parse(record.createdAt || record.tokenUpdatedAt || record.updatedAt);
      const lastSuccessAt = Date.parse(record.lastSuccessAt || record.updatedAt || record.tokenUpdatedAt);
      const tooOld = Number.isFinite(createdAt) && nowMs - createdAt > config.maxActiveMs;
      const tooStale = Number.isFinite(lastSuccessAt) && nowMs - lastSuccessAt > config.retentionMs;

      if (tooOld || tooStale) {
        record.active = false;
        record.endedAt = now.toISOString();
        record.endReason = tooOld ? 'maxActivityLifetimeReached' : 'retentionExpired';
        record.updatedAt = now.toISOString();
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  findByActivity(activityID, environment) {
    return this.state.records.find((record) => {
      return record.activityID === activityID && record.environment === environment;
    });
  }
}

export class TokenRateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  check(key, now = Date.now()) {
    const bucket = this.buckets.get(key) || [];
    const fresh = bucket.filter((timestamp) => now - timestamp < this.windowMs);
    fresh.push(now);
    this.buckets.set(key, fresh);
    return fresh.length <= this.limit;
  }
}

export function validateTokenPayload(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const errors = [];
  const requiredStringFields = [
    'installID',
    'activityID',
    'stationID',
    'lineID',
    'pushTokenHex',
    'tokenUpdatedAt',
    'appBundleID',
    'appVersion',
    'buildNumber',
    'environment'
  ];

  for (const field of requiredStringFields) {
    if (typeof payload[field] !== 'string' || payload[field].trim() === '') {
      errors.push(`${field} is required`);
    }
  }

  if (typeof payload.stationID === 'string' && !/^[A-Za-z0-9_-]{3,80}$/.test(payload.stationID)) {
    errors.push('stationID is invalid');
  }

  if (typeof payload.lineID === 'string' && !TUBE_LINES.has(payload.lineID)) {
    errors.push('lineID is not a supported Tube line');
  }

  const explicitSelectionMode = optionalString(payload.selectionMode);
  const selectionMode = inferSelectionMode(payload);
  if (explicitSelectionMode && !['platform', 'allPlatforms'].includes(explicitSelectionMode)) {
    errors.push('selectionMode must be platform or allPlatforms');
  }

  if (selectionMode === 'platform' && !optionalString(payload.platformID)) {
    errors.push('platformID is required when selectionMode is platform');
  }

  if (typeof payload.pushTokenHex === 'string' && !/^[a-fA-F0-9]{32,512}$/.test(payload.pushTokenHex)) {
    errors.push('pushTokenHex is invalid');
  }

  if (typeof payload.tokenUpdatedAt === 'string' && Number.isNaN(Date.parse(payload.tokenUpdatedAt))) {
    errors.push('tokenUpdatedAt is invalid');
  }

  if (typeof payload.environment === 'string' && !['production', 'sandbox'].includes(payload.environment)) {
    errors.push('environment must be production or sandbox');
  }

  if (typeof payload.appBundleID === 'string' && !/^[A-Za-z0-9.-]+$/.test(payload.appBundleID)) {
    errors.push('appBundleID is invalid');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      installID: String(payload.installID || '').trim(),
      activityID: String(payload.activityID || '').trim(),
      stationID: String(payload.stationID || '').trim(),
      lineID: String(payload.lineID || '').trim(),
      selectionMode,
      platformID: optionalString(payload.platformID),
      platformHeading: optionalString(payload.platformHeading),
      platformLabel: optionalString(payload.platformLabel),
      platformDirection: optionalString(payload.platformDirection),
      pushTokenHex: String(payload.pushTokenHex || '').trim().toLowerCase(),
      tokenUpdatedAt: String(payload.tokenUpdatedAt || '').trim(),
      appBundleID: String(payload.appBundleID || '').trim(),
      appVersion: String(payload.appVersion || '').trim(),
      buildNumber: String(payload.buildNumber || '').trim(),
      environment: String(payload.environment || '').trim()
    }
  };
}

export function validateEndPayload(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const errors = [];

  for (const field of ['installID', 'activityID']) {
    if (typeof payload[field] !== 'string' || payload[field].trim() === '') {
      errors.push(`${field} is required`);
    }
  }

  if (payload.endedAt !== undefined && (typeof payload.endedAt !== 'string' || Number.isNaN(Date.parse(payload.endedAt)))) {
    errors.push('endedAt is invalid');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      installID: String(payload.installID || '').trim(),
      activityID: String(payload.activityID || '').trim(),
      endedAt: payload.endedAt ? new Date(payload.endedAt).toISOString() : null,
      reason: typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : 'unknown'
    }
  };
}

export async function fetchTfLState(record, config, fetchImpl = fetch) {
  const [arrivals, statuses] = await Promise.all([
    fetchTfLArrivals(record.stationID, config, fetchImpl),
    fetchTfLStatuses(config, fetchImpl)
  ]);

  return buildContentState(record, arrivals, statuses);
}

export async function fetchTfLArrivals(stationID, config, fetchImpl = fetch) {
  const arrivalsUrl = new URL(`https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(stationID)}/Arrivals`);

  if (config.tflAppKey) {
    arrivalsUrl.searchParams.set('app_key', config.tflAppKey);
  }

  const response = await fetchImpl(arrivalsUrl);

  if (response.status === 429) {
    const error = new Error('TfL rate limited the request');
    error.retryable = true;
    error.backoffMs = 5 * 60 * 1000;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`TfL arrivals request failed: ${response.status}`);
    error.retryable = true;
    error.backoffMs = 2 * 60 * 1000;
    throw error;
  }

  const arrivals = await response.json();
  return Array.isArray(arrivals) ? arrivals : [];
}

export async function fetchTfLStatuses(config, fetchImpl = fetch) {
  const statusesUrl = new URL('https://api.tfl.gov.uk/Line/Mode/tube/Status');

  if (config.tflAppKey) {
    statusesUrl.searchParams.set('app_key', config.tflAppKey);
  }

  const response = await fetchImpl(statusesUrl);

  if (response.status === 429) {
    const error = new Error('TfL rate limited the request');
    error.retryable = true;
    error.backoffMs = 5 * 60 * 1000;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`TfL status request failed: ${response.status}`);
    error.retryable = true;
    error.backoffMs = 2 * 60 * 1000;
    throw error;
  }

  const statuses = await response.json();
  return Array.isArray(statuses) ? statuses : [];
}

export function buildContentState(record, arrivals, statuses, now = new Date()) {
  const lineName = TUBE_LINES.get(record.lineID) || titleCase(record.lineID);
  const lineArrivals = arrivals.filter((arrival) => matchesLine(arrival, record.lineID, lineName));
  const selectedArrivals = applySelectionMode(record, lineArrivals);
  const filteredArrivals = selectedArrivals
    .map((arrival) => normalizeArrival(arrival, now))
    .filter(Boolean)
    .sort((a, b) => {
      const aTime = a.expectedArrivalDate ? a.expectedArrivalDate.getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.expectedArrivalDate ? b.expectedArrivalDate.getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    })
    .slice(0, 3);

  const status = normalizeStatus(statuses, record.lineID);
  const stationName = cleanStationName(
    filteredArrivals[0]?.stationName
      || lineArrivals[0]?.stationName
      || record.stationID
  );
  const updatedAt = now;
  const staleAt = new Date(now.getTime() + 90_000);
  const platform = filteredArrivals[0]?.platform || getSelectedPlatformLabel(record);

  return {
    stationName,
    lineName,
    platform,
    arrivals: filteredArrivals.map((arrival, index) => ({
      id: arrival.id || `arrival-${index + 1}`,
      destination: arrival.destination,
      expectedArrival: arrival.expectedArrivalDate ? toSwiftDateSeconds(arrival.expectedArrivalDate) : null,
      countdownText: arrival.countdownText
    })),
    status: status.status,
    statusReason: status.statusReason,
    isDisrupted: status.isDisrupted,
    updatedAt: toSwiftDateSeconds(updatedAt),
    staleAt: toSwiftDateSeconds(staleAt)
  };
}

export function buildApnsPayload(contentState, now = new Date()) {
  const staleAt = new Date(now.getTime() + 150_000);
  return {
    aps: {
      timestamp: toUnixSeconds(now),
      event: 'update',
      'content-state': contentState,
      'stale-date': toUnixSeconds(staleAt)
    }
  };
}

export async function pushLiveActivityUpdate(record, payload, config) {
  if (!config.apns.teamId || !config.apns.keyId || (!config.apns.authKey && !config.apns.authKeyPath)) {
    const error = new Error('APNs is not configured');
    error.retryable = true;
    error.backoffMs = 10 * 60 * 1000;
    throw error;
  }

  const jwt = await createApnsJwt(config.apns);
  const host = record.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const topicBundleId = record.appBundleID || config.apns.bundleId;
  const client = http2.connect(`https://${host}`);

  return new Promise((resolve, reject) => {
    client.on('error', reject);
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${record.pushTokenHex}`,
      authorization: `bearer ${jwt}`,
      'apns-push-type': 'liveactivity',
      'apns-topic': `${topicBundleId}.push-type.liveactivity`,
      'apns-priority': '10',
      'content-type': 'application/json'
    });

    let status = 0;
    let body = '';

    request.setEncoding('utf8');
    request.on('response', (headers) => {
      status = Number(headers[':status'] || 0);
    });
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      client.close();
      if (status === 200) {
        resolve({ status });
        return;
      }

      const reason = parseApnsReason(body);
      const error = new Error(`APNs rejected Live Activity push: ${status} ${reason}`);
      error.status = status;
      error.reason = reason;
      error.permanent = isPermanentApnsError(status, reason);
      error.retryable = status === 429 || status >= 500;
      error.backoffMs = status === 429 ? 5 * 60 * 1000 : 2 * 60 * 1000;
      reject(error);
    });
    request.on('error', (error) => {
      client.close();
      reject(error);
    });
    request.end(JSON.stringify(payload));
  });
}

export async function runLiveActivityWorkerCycle({ store, config, fetchImpl = fetch, pushImpl = pushLiveActivityUpdate, logger = console }) {
  const now = new Date();
  await store.expireOld(now, config);
  const records = await store.listActive(now, config);
  if (records.length === 0) {
    return;
  }

  let statuses = [];
  try {
    statuses = await fetchTfLStatuses(config, fetchImpl);
  } catch (error) {
    for (const record of records) {
      await store.markBackoff(record.activityID, record.environment, error.backoffMs || 120_000, error.message, now);
    }
    logger.warn(`Live Activity worker backed off all records: ${error.message}`);
    return;
  }

  const arrivalsByStation = new Map();

  for (const record of records) {
    try {
      if (!arrivalsByStation.has(record.stationID)) {
        arrivalsByStation.set(record.stationID, await fetchTfLArrivals(record.stationID, config, fetchImpl));
      }

      const contentState = buildContentState(record, arrivalsByStation.get(record.stationID), statuses);
      const emptyArrivals = contentState.arrivals.length === 0;

      if (emptyArrivals && !contentState.isDisrupted && (record.consecutiveEmptyCycles || 0) >= 5) {
        await store.markBackoff(record.activityID, record.environment, 5 * 60 * 1000, 'emptyArrivals', now);
        continue;
      }

      const payload = buildApnsPayload(contentState, now);
      await pushImpl(record, payload, config);
      await store.markPushed(record.activityID, record.environment, { emptyArrivals }, now);
    } catch (error) {
      if (error.permanent) {
        await store.deactivate(record.activityID, record.environment, error.reason || 'permanentApnsError', now);
        logger.warn(`Live Activity ${record.activityID} deactivated after permanent APNs error: ${error.reason || error.message}`);
        continue;
      }

      if (error.retryable || error.backoffMs) {
        await store.markBackoff(record.activityID, record.environment, error.backoffMs || 120_000, error.message, now);
        logger.warn(`Live Activity ${record.activityID} backed off: ${error.message}`);
        continue;
      }

      logger.error(`Live Activity ${record.activityID} update failed: ${error.message}`);
    }
  }
}

export function redactRecord(record) {
  return {
    ...record,
    pushTokenHex: TOKEN_REDACTION
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function matchesLine(arrival, lineID, lineName) {
  if (arrival?.lineId) {
    return String(arrival.lineId).toLowerCase() === lineID;
  }

  return String(arrival?.lineName || '').toLowerCase() === lineName.toLowerCase();
}

function applySelectionMode(record, arrivals) {
  if (getRecordSelectionMode(record) !== 'platform') {
    return arrivals;
  }

  return arrivals.filter((arrival) => matchesSelectedPlatform(arrival, record));
}

function getRecordSelectionMode(record) {
  if (record.selectionMode === 'platform' || record.selectionMode === 'allPlatforms') {
    return record.selectionMode;
  }

  return record.platformID ? 'platform' : 'allPlatforms';
}

function matchesSelectedPlatform(arrival, record) {
  const arrivalPlatform = firstPresent([
    arrival.platformName,
    arrival.platformDirection,
    arrival.direction,
    arrival.towards
  ]);

  if (record.platformID && normalizePlatformID(arrivalPlatform) === normalizePlatformID(record.platformID)) {
    return true;
  }

  if (record.platformHeading && normalizePlatformID(arrivalPlatform) === normalizePlatformID(record.platformHeading)) {
    return true;
  }

  const platformLabel = optionalString(record.platformLabel);
  const platformDirection = optionalString(record.platformDirection);
  if (!platformLabel || !platformDirection) {
    return false;
  }

  const platformText = String(arrivalPlatform || '').toLowerCase();
  const directionText = firstPresent([
    arrival.platformDirection,
    arrival.direction,
    arrival.towards
  ]);
  const directionMatches = String(directionText || '').toLowerCase().includes(platformDirection.toLowerCase())
    || platformText.includes(platformDirection.toLowerCase());

  return platformText.includes(platformLabel.toLowerCase()) && directionMatches;
}

function getSelectedPlatformLabel(record) {
  if (getRecordSelectionMode(record) !== 'platform') {
    return null;
  }

  return optionalString(record.platformHeading)
    || [optionalString(record.platformDirection), optionalString(record.platformLabel)].filter(Boolean).join(' - ')
    || optionalString(record.platformLabel)
    || optionalString(record.platformDirection)
    || null;
}

function inferSelectionMode(payload) {
  if (payload.selectionMode === 'platform' || payload.selectionMode === 'allPlatforms') {
    return payload.selectionMode;
  }

  return typeof payload.platformID === 'string' && payload.platformID.trim() ? 'platform' : 'allPlatforms';
}

export function normalizePlatformID(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/\s+and\s+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeArrival(arrival, now) {
  const expectedArrivalDate = arrival.expectedArrival ? new Date(arrival.expectedArrival) : null;
  const validDate = expectedArrivalDate && !Number.isNaN(expectedArrivalDate.getTime()) ? expectedArrivalDate : null;
  const destination = cleanDestination(arrival.destinationName || arrival.towards || 'Unknown destination');

  return {
    id: arrival.id || arrival.vehicleId || arrival.timing?.tripId || '',
    stationName: arrival.stationName || arrival.commonName || '',
    platform: firstPresent([
      arrival.platformName,
      arrival.platformDirection,
      arrival.direction,
      arrival.towards
    ]),
    destination,
    expectedArrivalDate: validDate,
    countdownText: validDate ? formatCountdown(validDate, now) : 'Due'
  };
}

function normalizeStatus(statuses, lineID) {
  const line = statuses.find((item) => String(item.id || '').toLowerCase() === lineID);
  const lineStatus = line?.lineStatuses?.find((status) => status.statusSeverity !== 10)
    || line?.lineStatuses?.[0]
    || null;
  const severity = Number(lineStatus?.statusSeverity);
  const isDisrupted = Number.isFinite(severity) ? severity !== 10 : false;

  return {
    status: lineStatus?.statusSeverityDescription || 'Good Service',
    statusReason: lineStatus?.reason || null,
    isDisrupted
  };
}

function cleanDestination(value) {
  return String(value || 'Unknown destination')
    .replace(/\s+Underground Station$/i, '')
    .replace(/\s+Rail Station$/i, '')
    .replace(/\s+DLR Station$/i, '')
    .trim();
}

function cleanStationName(value) {
  return cleanDestination(value).replace(/^940GZZLU/i, '').trim() || String(value || '').trim();
}

function firstPresent(values) {
  const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return value ? value.trim() : null;
}

function titleCase(value) {
  return String(value || '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatCountdown(date, now) {
  const seconds = Math.max(0, Math.floor((date.getTime() - now.getTime()) / 1000));
  if (seconds === 0) {
    return 'Here';
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function toSwiftDateSeconds(date) {
  return date.getTime() / 1000 - APPLE_REFERENCE_UNIX_SECONDS;
}

async function createApnsJwt(apnsConfig) {
  const privateKey = await readApnsKey(apnsConfig);
  const header = base64UrlJson({ alg: 'ES256', kid: apnsConfig.keyId });
  const claims = base64UrlJson({ iss: apnsConfig.teamId, iat: toUnixSeconds(new Date()) });
  const input = `${header}.${claims}`;
  const signature = crypto.sign('SHA256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${input}.${base64Url(signature)}`;
}

async function readApnsKey(apnsConfig) {
  if (apnsConfig.authKey) {
    return apnsConfig.authKey.replace(/\\n/g, '\n');
  }

  return fs.readFile(apnsConfig.authKeyPath, 'utf8');
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseApnsReason(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed.reason || 'Unknown';
  } catch {
    return body || 'Unknown';
  }
}

function isPermanentApnsError(status, reason) {
  return status === 410
    || (status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic', 'TopicDisallowed', 'BadTopic'].includes(reason));
}
