import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchJsonResponse, sendApnsRequest } from './notification-transport.js';
import { TransactionalJsonStore } from './transactional-json-store.js';
import {
  Environment,
  SignedDataVerifier
} from '@apple/app-store-server-library';
import {
  OVERGROUND_LINES,
  TUBE_LINES,
  createApnsJwt,
  isPermanentApnsError,
  parseApnsReason
} from './live-activity.js';

export const DISRUPTION_ALERT_CONTRACT_VERSION = 2;
export const DISRUPTION_ALERT_CONTRACT_VERSIONS = new Set([1, 2]);
export const DISRUPTION_ALERT_LINES = new Map([
  ...TUBE_LINES,
  ...OVERGROUND_LINES
]);
export const TUBEBOARD_BUNDLE_ID = 'OllyJ.My-Train-Times';
export const PREMIUM_PRODUCT_IDS = new Set([
  'uk.net.jeffers.tubeboard.premium.monthly',
  'uk.net.jeffers.tubeboard.premium.yearly',
  'uk.net.jeffers.tubeboard.premium.lifetime'
]);

const APPLE_ROOT_CERTIFICATE_URLS = [
  new URL('../certificates/AppleRootCA-G2.pem', import.meta.url),
  new URL('../certificates/AppleRootCA-G3.pem', import.meta.url)
];

const DEFAULT_INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;
const NOTIFICATION_EXPIRY_MS = 60 * 60 * 1000;
const MAX_QUEUE_ATTEMPTS = 5;

export function loadDisruptionAlertConfig(env = process.env) {
  return {
    dataFile: env.DISRUPTION_ALERT_DATA_FILE || path.join('data', 'disruption-alerts.json'),
    workerEnabled: env.DISRUPTION_ALERT_WORKER_ENABLED === 'true',
    workerIntervalMs: parsePositiveInteger(env.DISRUPTION_ALERT_WORKER_INTERVAL_MS, 60_000),
    inactivityMs: parsePositiveInteger(env.DISRUPTION_ALERT_INACTIVITY_DAYS, 90) * 24 * 60 * 60 * 1000,
    encryptionKey: parseEncryptionKey(env.DISRUPTION_ALERT_ENCRYPTION_KEY || ''),
    tflAppKey: env.TFL_APP_KEY || '',
    bundleId: env.APNS_BUNDLE_ID || TUBEBOARD_BUNDLE_ID,
    appAppleId: parsePositiveInteger(env.APP_STORE_APP_ID, 6_779_771_046),
    apns: {
      teamId: env.APNS_TEAM_ID || '',
      keyId: env.APNS_KEY_ID || '',
      authKeyPath: env.APNS_AUTH_KEY_PATH || '',
      authKey: env.APNS_AUTH_KEY || '',
      bundleId: env.APNS_BUNDLE_ID || TUBEBOARD_BUNDLE_ID
    }
  };
}

export function validateRegistrationPayload(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const errors = [];

  if (!DISRUPTION_ALERT_CONTRACT_VERSIONS.has(payload.contractVersion)) {
    errors.push('contractVersion must be 1 or 2');
  }

  for (const field of [
    'installID',
    'deviceTokenHex',
    'transactionJWS',
    'tokenUpdatedAt',
    'appBundleID',
    'appVersion',
    'buildNumber',
    'apnsEnvironment',
    'storeEnvironment'
  ]) {
    if (typeof payload[field] !== 'string' || payload[field].trim() === '') {
      errors.push(`${field} is required`);
    }
  }

  if (typeof payload.installID === 'string' && !isUUID(payload.installID)) {
    errors.push('installID must be a UUID');
  }

  if (typeof payload.deviceTokenHex === 'string' && !/^[a-fA-F0-9]{32,512}$/.test(payload.deviceTokenHex)) {
    errors.push('deviceTokenHex is invalid');
  }

  if (typeof payload.transactionJWS === 'string' && (payload.transactionJWS.length < 100 || payload.transactionJWS.length > 20_000)) {
    errors.push('transactionJWS is invalid');
  }

  const supportedLines = payload.contractVersion === 1 ? TUBE_LINES : DISRUPTION_ALERT_LINES;
  if (!Array.isArray(payload.selectedLineIDs)
      || payload.selectedLineIDs.length < 1
      || payload.selectedLineIDs.length > supportedLines.size
      || payload.selectedLineIDs.some((lineID) => !supportedLines.has(lineID))
      || new Set(payload.selectedLineIDs).size !== payload.selectedLineIDs.length) {
    errors.push(`selectedLineIDs must contain 1 to ${supportedLines.size} lines supported by contract v${payload.contractVersion}`);
  }

  if (!['severeOnly', 'allDisruptions'].includes(payload.severity)) {
    errors.push('severity must be severeOnly or allDisruptions');
  }

  if (typeof payload.quietHoursEnabled !== 'boolean') {
    errors.push('quietHoursEnabled must be a boolean');
  }

  for (const field of ['quietHoursStartMinutes', 'quietHoursEndMinutes']) {
    if (!Number.isInteger(payload[field]) || payload[field] < 0 || payload[field] > 1439) {
      errors.push(`${field} must be an integer from 0 through 1439`);
    }
  }

  if (typeof payload.timeZone !== 'string' || !isTimeZone(payload.timeZone)) {
    errors.push('timeZone must be a valid IANA time zone');
  }

  if (typeof payload.serviceResumedAlerts !== 'boolean') {
    errors.push('serviceResumedAlerts must be a boolean');
  }

  if (typeof payload.tokenUpdatedAt === 'string' && Number.isNaN(Date.parse(payload.tokenUpdatedAt))) {
    errors.push('tokenUpdatedAt is invalid');
  }

  if (typeof payload.appBundleID === 'string' && payload.appBundleID !== TUBEBOARD_BUNDLE_ID) {
    errors.push(`appBundleID must be ${TUBEBOARD_BUNDLE_ID}`);
  }

  for (const field of ['appVersion', 'buildNumber']) {
    if (typeof payload[field] === 'string' && payload[field].length > 40) {
      errors.push(`${field} is too long`);
    }
  }

  if (!['production', 'sandbox'].includes(payload.apnsEnvironment)) {
    errors.push('apnsEnvironment must be production or sandbox');
  }

  if (!['production', 'sandbox'].includes(payload.storeEnvironment)) {
    errors.push('storeEnvironment must be production or sandbox');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      contractVersion: payload.contractVersion,
      installID: String(payload.installID || '').trim().toLowerCase(),
      deviceTokenHex: String(payload.deviceTokenHex || '').trim().toLowerCase(),
      transactionJWS: String(payload.transactionJWS || '').trim(),
      selectedLineIDs: [...new Set(Array.isArray(payload.selectedLineIDs) ? payload.selectedLineIDs : [])].sort(),
      severity: payload.severity,
      quietHoursEnabled: payload.quietHoursEnabled,
      quietHoursStartMinutes: payload.quietHoursStartMinutes,
      quietHoursEndMinutes: payload.quietHoursEndMinutes,
      timeZone: String(payload.timeZone || '').trim(),
      serviceResumedAlerts: payload.serviceResumedAlerts,
      tokenUpdatedAt: String(payload.tokenUpdatedAt || '').trim(),
      appBundleID: String(payload.appBundleID || '').trim(),
      appVersion: String(payload.appVersion || '').trim(),
      buildNumber: String(payload.buildNumber || '').trim(),
      apnsEnvironment: String(payload.apnsEnvironment || '').trim(),
      storeEnvironment: String(payload.storeEnvironment || '').trim()
    }
  };
}

export function validateDeletePayload(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const errors = [];
  if (!DISRUPTION_ALERT_CONTRACT_VERSIONS.has(payload.contractVersion)) {
    errors.push('contractVersion must be 1 or 2');
  }
  if (typeof payload.installID !== 'string' || !isUUID(payload.installID)) {
    errors.push('installID must be a UUID');
  }
  return {
    ok: errors.length === 0,
    errors,
    value: {
      contractVersion: payload.contractVersion,
      installID: String(payload.installID || '').trim().toLowerCase()
    }
  };
}

export async function verifyPremiumTransaction(
  transactionJWS,
  storeEnvironment,
  config,
  now = new Date(),
  verifierFactory = createSignedDataVerifier
) {
  const verifier = await verifierFactory(storeEnvironment, config);
  const transaction = await verifier.verifyAndDecodeTransaction(transactionJWS);

  if (transaction.bundleId !== config.bundleId) {
    throw validationError('Premium transaction belongs to a different app');
  }
  if (!PREMIUM_PRODUCT_IDS.has(transaction.productId)) {
    throw validationError('Premium transaction has an unsupported product');
  }
  if (transaction.revocationDate !== undefined && transaction.revocationDate !== null) {
    throw validationError('Premium transaction is revoked');
  }

  const expiresAt = transaction.expiresDate === undefined || transaction.expiresDate === null
    ? null
    : new Date(transaction.expiresDate);
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)) {
    throw validationError('Premium transaction is expired');
  }

  return {
    productID: transaction.productId,
    expiresAt: expiresAt?.toISOString() || null,
    verifiedAt: now.toISOString()
  };
}

export async function createSignedDataVerifier(storeEnvironment, config) {
  const roots = await loadAppleRootCertificates();
  if (roots.length === 0) {
    throw new Error('No Apple Root CA is available in the Node trust store');
  }

  const environment = storeEnvironment === 'production'
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
  const appAppleId = environment === Environment.PRODUCTION ? config.appAppleId : undefined;
  return new SignedDataVerifier(
    roots,
    true,
    environment,
    config.bundleId,
    appAppleId
  );
}

export async function loadAppleRootCertificates(certificateURLs = APPLE_ROOT_CERTIFICATE_URLS) {
  return Promise.all(certificateURLs.map(async (certificateURL) => {
    const certificate = await fs.readFile(certificateURL);
    try {
      const parsed = new X509Certificate(certificate);
      if (!/Apple Root CA - G[23]/i.test(parsed.subject)) {
        throw new Error(`Unexpected certificate subject: ${parsed.subject}`);
      }
      return parsed.raw;
    } catch (error) {
      throw new Error(`Apple root certificate is invalid: ${error.message}`);
    }
  }));
}

export class DisruptionAlertStore extends TransactionalJsonStore {
  constructor(filePath, encryptionKey) {
    super(filePath, { records: [], lineStates: {}, queue: [] }, (parsed) => ({
      records: Array.isArray(parsed.records) ? parsed.records : [],
      lineStates: parsed.lineStates && typeof parsed.lineStates === 'object'
        ? parsed.lineStates
        : {},
      queue: Array.isArray(parsed.queue) ? parsed.queue : []
    }));
    this.encryptionKey = encryptionKey;
  }

  async upsert(payload, entitlement, now = new Date()) {
    return this.transaction((state) => {
      requireEncryptionKey(this.encryptionKey);
      const installDigest = digest(payload.installID);
      const tokenDigest = digest(payload.deviceTokenHex);
      const existingIndex = state.records.findIndex((record) => record.installDigest === installDigest);
      const previous = existingIndex >= 0 ? state.records[existingIndex] : {};
      const record = {
        ...previous,
        contractVersion: payload.contractVersion,
        installDigest,
        tokenDigest,
        encryptedToken: encryptToken(payload.deviceTokenHex, this.encryptionKey),
        selectedLineIDs: payload.selectedLineIDs,
        severity: payload.severity,
        quietHoursEnabled: payload.quietHoursEnabled,
        quietHoursStartMinutes: payload.quietHoursStartMinutes,
        quietHoursEndMinutes: payload.quietHoursEndMinutes,
        timeZone: payload.timeZone,
        serviceResumedAlerts: payload.serviceResumedAlerts,
        appBundleID: payload.appBundleID,
        appVersion: payload.appVersion,
        buildNumber: payload.buildNumber,
        apnsEnvironment: payload.apnsEnvironment,
        premiumProductID: entitlement.productID,
        premiumExpiresAt: entitlement.expiresAt,
        entitlementVerifiedAt: entitlement.verifiedAt,
        createdAt: previous.createdAt || now.toISOString(),
        updatedAt: now.toISOString(),
        lastNotificationAt: previous.lastNotificationAt || null
      };

      state.records = state.records.filter((candidate, index) => {
        if (index === existingIndex) return true;
        return candidate.tokenDigest !== tokenDigest;
      });
      if (existingIndex >= 0) {
        const replacementIndex = state.records.findIndex((candidate) => candidate.installDigest === installDigest);
        state.records[replacementIndex] = record;
      } else {
        state.records.push(record);
      }
      return { value: { expiresAt: record.premiumExpiresAt } };
    });
  }

  async deleteByInstallID(installID) {
    return this.transaction((state) => {
      const installDigest = digest(installID);
      const before = state.records.length;
      const queuedBefore = state.queue.length;
      state.records = state.records.filter((record) => record.installDigest !== installDigest);
      state.queue = state.queue.filter((item) => item.installDigest !== installDigest);
      return {
        changed: state.records.length !== before || state.queue.length !== queuedBefore,
        value: state.records.length !== before
      };
    });
  }

  async deleteByInstallDigest(installDigest) {
    return this.transaction((state) => {
      const before = state.records.length;
      const queuedBefore = state.queue.length;
      state.records = state.records.filter((record) => record.installDigest !== installDigest);
      state.queue = state.queue.filter((item) => item.installDigest !== installDigest);
      return {
        changed: state.records.length !== before || state.queue.length !== queuedBefore
      };
    });
  }

  async activeRecords(now = new Date(), inactivityMs = DEFAULT_INACTIVITY_MS) {
    await this.purgeExpired(now, inactivityMs);
    return this.snapshot((state) => state.records);
  }

  async purgeExpired(now = new Date(), inactivityMs = DEFAULT_INACTIVITY_MS) {
    return this.transaction((state) => {
      const nowMs = now.getTime();
      const retained = state.records.filter((record) => {
        const updatedAt = Date.parse(record.updatedAt || '');
        const premiumExpiresAt = Date.parse(record.premiumExpiresAt || '');
        const inactive = !Number.isFinite(updatedAt) || nowMs - updatedAt > inactivityMs;
        const expired = Number.isFinite(premiumExpiresAt) && premiumExpiresAt <= nowMs;
        return !inactive && !expired;
      });
      const retainedDigests = new Set(retained.map((record) => record.installDigest));
      const queue = state.queue.filter((item) => {
        return retainedDigests.has(item.installDigest) && Date.parse(item.expiresAt) > nowMs;
      });
      const changed = retained.length !== state.records.length || queue.length !== state.queue.length;
      state.records = retained;
      state.queue = queue;
      return { changed };
    });
  }

  async observeStatuses(statuses, now = new Date()) {
    return this.transaction((state) => {
      const transitions = [];
      for (const status of statuses) {
        const fingerprint = statusFingerprint(status);
        const previous = state.lineStates[status.lineID];
        const observationCount = previous?.observedFingerprint === fingerprint
          ? (previous.observationCount || 0) + 1
          : 1;
        const next = {
          observedFingerprint: fingerprint,
          observationCount,
          observedStatus: status,
          stableFingerprint: previous?.stableFingerprint || null,
          stableStatus: previous?.stableStatus || null,
          updatedAt: now.toISOString()
        };

        if (observationCount >= 2 && next.stableFingerprint !== fingerprint) {
          if (next.stableFingerprint !== null && next.stableStatus) {
            transitions.push({ before: next.stableStatus, after: status, fingerprint });
          }
          next.stableFingerprint = fingerprint;
          next.stableStatus = status;
        }
        state.lineStates[status.lineID] = next;
      }
      return { value: transitions };
    });
  }

  async enqueue(transitions, records, now = new Date()) {
    return this.transaction((state) => {
      const existing = new Set(state.queue.map((item) => item.id));
      const currentRecords = new Map(state.records.map((record) => [record.installDigest, record]));
      for (const transition of transitions) {
        for (const candidate of records) {
          // A worker may have read registrations before an opt-out was committed.
          const record = currentRecords.get(candidate.installDigest);
          if (!record) continue;
          if (!record.selectedLineIDs.includes(transition.after.lineID)
              || !shouldNotify(record, transition, now)) continue;
          const id = `${record.installDigest}:${transition.after.lineID}:${transition.fingerprint}`;
          if (existing.has(id)) continue;
          state.queue.push({
            id,
            installDigest: record.installDigest,
            lineID: transition.after.lineID,
            payload: buildAlertPayload(transition, record.contractVersion || 1),
            collapseID: `tubeboard-${transition.after.lineID}`,
            attempts: 0,
            nextAttemptAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + NOTIFICATION_EXPIRY_MS).toISOString()
          });
          existing.add(id);
        }
      }
    });
  }

  async dueQueue(now = new Date()) {
    await this.load();
    const nowMs = now.getTime();
    return this.snapshot((state) => state.queue.filter((item) => {
      return Date.parse(item.nextAttemptAt) <= nowMs && Date.parse(item.expiresAt) > nowMs;
    }));
  }

  recordForQueueItem(item) {
    return this.snapshot((state) => state.records.find((record) => record.installDigest === item.installDigest));
  }

  decryptedToken(record) {
    requireEncryptionKey(this.encryptionKey);
    return decryptToken(record.encryptedToken, this.encryptionKey);
  }

  async markQueueSuccess(itemID, now = new Date()) {
    return this.transaction((state) => {
      const item = state.queue.find((candidate) => candidate.id === itemID);
      const record = item ? state.records.find((candidate) => candidate.installDigest === item.installDigest) : null;
      if (record) record.lastNotificationAt = now.toISOString();
      state.queue = state.queue.filter((item) => item.id !== itemID);
    });
  }

  async markQueueRetry(itemID, now = new Date()) {
    return this.transaction((state) => {
      const item = state.queue.find((candidate) => candidate.id === itemID);
      if (!item) return { changed: false };
      item.attempts += 1;
      if (item.attempts >= MAX_QUEUE_ATTEMPTS) {
        state.queue = state.queue.filter((candidate) => candidate.id !== itemID);
      } else {
        const delayMs = Math.min(15 * 60 * 1000, 2 ** item.attempts * 60_000);
        item.nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();
      }
    });
  }
}

export function normalizeTubeStatuses(input) {
  const lines = Array.isArray(input) ? input : [];
  return lines.flatMap((line) => {
    if (!DISRUPTION_ALERT_LINES.has(line.id) || !Array.isArray(line.lineStatuses) || line.lineStatuses.length === 0) {
      return [];
    }
    const candidate = [...line.lineStatuses].sort((left, right) => {
      return numericSeverity(left.statusSeverity) - numericSeverity(right.statusSeverity);
    })[0];
    const severity = numericSeverity(candidate.statusSeverity);
    return [{
      lineID: line.id,
      lineName: line.name || DISRUPTION_ALERT_LINES.get(line.id),
      severity,
      status: cleanText(candidate.statusSeverityDescription || (severity === 10 ? 'Good Service' : 'Disruption')),
      reason: cleanText(candidate.reason || ''),
      isDisrupted: severity !== 10
    }];
  });
}

export function shouldNotify(record, transition, now = new Date()) {
  if (isWithinQuietHours(record, now)) return false;
  if (!transition.after.isDisrupted) {
    return transition.before.isDisrupted && record.serviceResumedAlerts;
  }
  return record.severity === 'allDisruptions' || transition.after.severity <= 8;
}

export function isWithinQuietHours(record, now = new Date()) {
  if (!record.quietHoursEnabled || record.quietHoursStartMinutes === record.quietHoursEndMinutes) {
    return false;
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: record.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const current = hour * 60 + minute;
  const start = record.quietHoursStartMinutes;
  const end = record.quietHoursEndMinutes;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function buildAlertPayload(transition, contractVersion = DISRUPTION_ALERT_CONTRACT_VERSION) {
  const status = transition.after;
  const resumed = !status.isDisrupted;
  const title = resumed
    ? `${status.lineName} — Good Service Resumed`
    : `${status.lineName} — ${status.status}`;
  const body = resumed
    ? 'Service has returned to normal.'
    : status.reason || `${status.status} on the ${status.lineName} line.`;
  return {
    aps: {
      alert: { title, body },
      sound: 'default',
      'thread-id': `line-${status.lineID}`,
      'interruption-level': 'active'
    },
    deepLink: `tubeboard://line-status/${encodeURIComponent(status.lineID)}`,
    lineID: status.lineID,
    contractVersion
  };
}

export async function pushDisruptionAlert(record, token, item, config, options = {}) {
  if (!config.apns.teamId || !config.apns.keyId || (!config.apns.authKey && !config.apns.authKeyPath)) {
    throw retryableError('APNs is not configured', 10 * 60 * 1000);
  }
  const jwt = await createApnsJwt(config.apns);
  const host = record.apnsEnvironment === 'sandbox'
    ? 'api.sandbox.push.apple.com'
    : 'api.push.apple.com';
  const { status, body } = await sendApnsRequest(host, {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    authorization: `bearer ${jwt}`,
    'apns-push-type': 'alert',
    'apns-topic': record.appBundleID || config.apns.bundleId,
    'apns-priority': '10',
    'apns-expiration': String(Math.floor(Date.parse(item.expiresAt) / 1000)),
    'apns-collapse-id': item.collapseID,
    'content-type': 'application/json'
  }, item.payload, options);
  if (status === 200) return { status };
  const reason = parseApnsReason(body);
  const error = new Error(`APNs rejected disruption alert: ${status} ${reason}`);
  error.status = status;
  error.reason = reason;
  error.permanent = isPermanentApnsError(status, reason);
  error.retryable = status === 429 || status >= 500;
  throw error;
}

export async function runDisruptionAlertWorkerCycle({
  store,
  config,
  fetchImpl = fetch,
  pushImpl = pushDisruptionAlert,
  logger = console,
  now = new Date(),
  signal
}) {
  signal?.throwIfAborted();
  await processQueue({ store, config, pushImpl, logger, now, signal });
  const records = await store.activeRecords(now, config.inactivityMs);
  if (records.length === 0) return { registrations: 0, transitions: 0, queued: 0 };

  const url = new URL('https://api.tfl.gov.uk/Line/Mode/tube,overground/Status');
  if (config.tflAppKey) url.searchParams.set('app_key', config.tflAppKey);
  const response = await fetchJsonResponse(url, fetchImpl, { signal });
  if (!response.ok) throw retryableError(`TfL status request failed: ${response.status}`, 120_000);
  const statuses = normalizeTubeStatuses(response.value);
  const transitions = await store.observeStatuses(statuses, now);
  await store.enqueue(transitions, records, now);
  const queued = (await store.dueQueue(now)).length;
  await processQueue({ store, config, pushImpl, logger, now, signal });
  logger.info(`Disruption alert cycle: ${records.length} registrations, ${transitions.length} stable changes, ${queued} sends considered`);
  return { registrations: records.length, transitions: transitions.length, queued };
}

async function processQueue({ store, config, pushImpl, logger, now, signal }) {
  for (const item of await store.dueQueue(now)) {
    signal?.throwIfAborted();
    const record = store.recordForQueueItem(item);
    if (!record) {
      await store.markQueueSuccess(item.id, now);
      continue;
    }
    try {
      await pushImpl(record, store.decryptedToken(record), item, config, { signal });
      await store.markQueueSuccess(item.id, now);
    } catch (error) {
      signal?.throwIfAborted();
      if (error.permanent) {
        await store.deleteByInstallDigest(record.installDigest);
        logger.warn(`Disruption alert registration removed after permanent APNs error: ${error.reason || 'rejected'}`);
      } else {
        await store.markQueueRetry(item.id, now);
        logger.warn(`Disruption alert send scheduled for retry: ${error.message}`);
      }
    }
  }
}

export function encryptToken(token, key) {
  requireEncryptionKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

export function decryptToken(value, key) {
  requireEncryptionKey(key);
  if (!value || value.algorithm !== 'aes-256-gcm') throw new Error('Stored alert token is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function statusFingerprint(status) {
  return digest(`${status.lineID}|${status.severity}|${status.status}|${status.reason}`);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseEncryptionKey(raw) {
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function requireEncryptionKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('DISRUPTION_ALERT_ENCRYPTION_KEY must contain 32 bytes');
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function numericSeverity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 10;
}

function isUUID(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
}

function isTimeZone(value) {
  if (typeof value !== 'string' || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validationError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function retryableError(message, backoffMs) {
  const error = new Error(message);
  error.retryable = true;
  error.backoffMs = backoffMs;
  return error;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
