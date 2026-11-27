import { applyPublicationAuthority } from './station-board-publication.js';
import { readPublicationAsset } from './timetable-publication-resource.js';
import crypto from 'node:crypto';
import { parseBoundedJSON } from './bounded-json.js';
import { selectedTimetableEntry, qualifyTimetable, timetableHTTPObservation, regularTimetableWindow, validatedPublicationProof } from './station-board-timetable.js';
import fs from 'node:fs';
import { replacementFrequencyWithdrawal, retainAvailability, legacyClosureSources, blocksScheduled, availabilityBoundaries, qualifyAvailability, wireAvailability, containsServiceClosed, knownNonClosure, activeClosure, expiredBarrier, completePlannedApplicability } from './station-board-availability.js';
import { fetchJsonResponse } from './notification-transport.js';

export const STATION_BOARD_CONTRACT = 'station-board-v2';
const catalogue = JSON.parse(fs.readFileSync(new URL('../contracts/station-board-catalogue-v2.json', import.meta.url)));
export const STATION_BOARD_LINES = new Map(catalogue.lines.map((line) => [line.lineID, line]));
export const STATION_BOARD_STATIONS = new Map(catalogue.stations.map((station) => [station.stationID, station]));
const regularOrigins = JSON.parse(fs.readFileSync(new URL('../contracts/station-board-regular-origins-v1.json', import.meta.url))).lines;
const journeyTargetEvidence = JSON.parse(fs.readFileSync(new URL('../contracts/station-board-journey-target-evidence-v1.json', import.meta.url))).boards;
const APPLE_EPOCH = 978307200000;
const key = (value) => String(value || '').toLowerCase().replace(/ (underground|rail|dlr) station/g, '').replace(/\s*\([^)]*\)/g, '').replace(/\s+(station|terminus)$/, '').trim().replace(/\s+/g, ' ');
const hash = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const objectRow = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isoClock = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return NaN;
  return Date.parse(value);
};
const swift = (ms) => (ms - APPLE_EPOCH) / 1000;
const sourceKey = (source) => ['timetable', 'unified-timetable'].includes(source) ? 'timetable' : source;
const plannedSource = (event) => event.kind === 'outgoingDeparture' && event.timeEvidence === 'scheduledDeparture' && ['timetable', 'journey-planner', 'rail-departures', 'regular-timetable'].includes(sourceKey(event.sourceID)) ? sourceKey(event.sourceID) : null;
const planned = (event) => ['timetable', 'journey-planner'].includes(sourceKey(event.sourceID)) || (event.kind === 'outgoingDeparture' && event.timeEvidence === 'scheduledDeparture');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function regularOriginRule(record) {
  const line = regularOrigins[record.lineID];
  return { physicalEnd: line?.physicalEnds.includes(record.stationID) === true,
    exclusiveFirstCalls: line?.exclusiveFirstCalls[record.stationID] || [] };
}

export function supportsRegularOrigin(record) {
  const rule = regularOriginRule(record);
  return record.supportsRegularTimetable === true && record.selectionMode === 'allPlatforms'
    && !record.platformID && (rule.physicalEnd || rule.exclusiveFirstCalls.length > 0);
}

function hasExclusiveStartingCall(event, rule) {
  const route = Array.isArray(event.routeStationIDs) ? event.routeStationIDs : [];
  const first = event.nextScheduledStopID ?? route.find(stop => stop !== event.stationID);
  return rule.exclusiveFirstCalls.includes(first);
}

function ordinaryDirection(body, record, path) {
  const options = body?.disambiguation?.disambiguationOptions;
  if (!Array.isArray(options) || !options.every(option =>
    typeof option?.description === 'string' && typeof option.uri === 'string')) return null;
  const origin = key(STATION_BOARD_STATIONS.get(record.stationID)?.stationName);
  if (!origin) return null;
  const matching = options.filter(option => {
    const ends = option.description.split(' - ').map(key);
    return ends.length === 2 && ends[0] === origin && ends[1] && ends[1] !== origin;
  });
  const uris = new Set(matching.map(option => option.uri));
  return uris.size === 1
    ? ['inbound', 'outbound'].find(direction => uris.has(path + '?direction=' + direction)) ?? null
    : null;
}

function ordinaryReceipt(response) {
  if (!response.ok || response.status !== 200) return {};
  const { age, date, 'cache-control': cacheControl } = response.headers;
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl || '');
  const apparentAge = response.completedAt - Date.parse(date);
  if (!maxAge || Number(maxAge[1]) <= 0 || Number(maxAge[1]) > 43200
    || !Number.isFinite(apparentAge) || apparentAge < -5000) return {};
  if (age === undefined) return { retryable: apparentAge <= 43200000 };
  if (typeof age !== 'string' || !/^\d+$/.test(age.trim())) return {};
  const observation = httpObservation(response.headers, response.completedAt, 43200000, { cacheRequired: true });
  return observation ? { observation } : { retryable: true };
}

// Row IDs bind the service day, booked minute and complete ordered call path.
const ordinaryWorkingKeys = events => canonical(events.map(e => e.id).sort());

function ordinaryContext(previous, events, source, signature, record, now) {
  if (source.expiresAt <= now) return null;
  const proof = { signature, observedAt: source.observedAt };
  const context = { observedAt: source.observedAt, expiresAt: source.expiresAt, events,
    evidence: { ordinaryTimetable: proof } };
  const retained = (previous?.events || []).filter(e => usable(e, record, now));
  const earlierProof = previous?.evidence?.ordinaryTimetable;
  if ((!earlierProof && !retained.length) || source.observedAt > previous.observedAt) return context;
  if (source.expiresAt <= Math.max(...retained.map(e => e.expiresAt))) return null;
  if (earlierProof && earlierProof.signature !== signature) return null;

  // A legacy cache proves only its retained overlap. An equal or older
  // receipt cannot confer authority on the unobserved rest of the day.
  const retainedByID = new Map(retained.map(e => [e.id, e]));
  if (!earlierProof) {
    const lastRetainedTime = Math.max(...retained.map(e => e.time));
    if (ordinaryWorkingKeys(retained) !== ordinaryWorkingKeys(events.filter(e => e.time <= lastRetainedTime))) return null;
    context.evidence = { ordinaryOverlap: true };
  }

  proof.observedAt = Math.max(earlierProof?.observedAt ?? -Infinity, source.observedAt);
  context.observedAt = previous.observedAt;
  context.events = (earlierProof ? events : events.filter(e => retainedByID.has(e.id))).map(e => ({
    ...e, receivedAt: retainedByID.get(e.id)?.receivedAt ?? proof.observedAt,
  }));
  return context;
}

export function validBoard(stationID, lineID) { return STATION_BOARD_STATIONS.get(stationID)?.lineIDs.includes(lineID) === true; }
function lineStations(lineID) { return [...STATION_BOARD_STATIONS.values()].filter((station) => station.lineIDs.includes(lineID)); }
function named(name, lineID) {
  const stations = lineStations(lineID), exact = stations.filter((station) => key(station.stationName) === key(name));
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const aliases = stations.filter((station) => key(station.stationName).replace(/^london /, '') === key(name).replace(/^london /, ''));
  return aliases.length === 1 ? aliases[0] : null;
}
function endpoint(row, record, nameField = 'destinationName', idField = 'destinationNaptanId') {
  const id = text(row[idField]), name = text(row[nameField]);
  const station = id ? STATION_BOARD_STATIONS.get(id.toUpperCase()) : named(name, record.lineID);
  if (!station || !station.lineIDs.includes(record.lineID)) return null;
  if (name && !['check front of train', 'see front of train'].includes(key(name)) && key(name) !== key(station.stationName)) return null;
  return station;
}
export function httpObservation(headers, now, lifetime, { cacheRequired = false, futureSkew = 5_000 } = {}) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const date = Date.parse(h.date || ''), age = Number(h.age);
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(h['cache-control'] || '');
  if (!Number.isFinite(date) || h.age === undefined || !Number.isFinite(age) || age < 0 || date > now + futureSkew || (cacheRequired && !maxAge)) return null;
  const effectiveAge = Math.max(age * 1000, Math.max(0, now - date));
  const observedAt = now - effectiveAge;
  const expiresAt = observedAt + Math.min(lifetime, maxAge ? Number(maxAge[1]) * 1000 : lifetime);
  return now < expiresAt ? { observedAt, expiresAt } : null;
}
// Clockless station empties retain generic HTTP expiry, but a blank Age is
// not an observed integer zero and cannot acquire source-clearing authority.
function stationEmptyObservation(headers, now) {
  const age = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'age')?.[1];
  if (typeof age !== 'string' || !/^\d+$/.test(age.trim())) return null;
  return httpObservation(headers, now, 120000);
}

// Timestamped predictions have their own original observation lifetime. HTTP
// max-age controls response-cache reuse; it is not a replacement row clock.
// This does not relax the strict qualifier used by clockless/planned authority.
export function stationArrivalObservation(headers, now) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const date = Date.parse(h.date || '');
  if (!Number.isFinite(date) || typeof h.age !== 'string' || !/^\d+$/.test(h.age.trim())) return null;
  const age = Number(h.age), apparentAge = Math.max(age * 1000, Math.max(0, now - date));
  if (!Number.isFinite(age) || date > now + 5000 || apparentAge > 60000) return null;
  const observedAt = now - apparentAge;
  return { observedAt, expiresAt: observedAt + 120000 };
}

export const STATION_ARRIVAL_ATTEMPT_FLOOR_MS = 30000;
const STATION_ARRIVAL_REFRESH_INTERVAL_MS = 60000;
function retryAfterDelay(value, now) {
  if (typeof value !== 'string') return 0;
  if (/^\d+$/.test(value.trim())) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) && now + delay <= 8640000000000000 ? delay : 0;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// One owner is shared across full/source-only cycles. It retains admission
// clocks and in-flight work, never a completed body as an HTTP cache hit.
export class StationArrivalReader {
  #entries = new Map();

  observeNotBefore(url, notBefore, rateLimitedUntil = 0) {
    if (!Number.isFinite(notBefore) || notBefore <= 0) return;
    const key = `activity-live-source:${url.href}`;
    const entry = this.#entries.get(key) || { nextAttemptAt: 0, rateLimitedUntil: 0, promise: null };
    entry.nextAttemptAt = Math.max(entry.nextAttemptAt, notBefore);
    if (Number.isFinite(rateLimitedUntil)) entry.rateLimitedUntil = Math.max(entry.rateLimitedUntil, rateLimitedUntil);
    this.#entries.set(key, entry);
  }

  read(url, { fetchImpl = fetch, signal, clock = () => Date.now(), publicResponses = new Map(), notBefore = 0, rateLimitedUntil = 0, attemptFloorMs = STATION_ARRIVAL_ATTEMPT_FLOOR_MS } = {}) {
    signal?.throwIfAborted();
    const key = `activity-live-source:${url.href}`;
    const now = clock();
    for (const [other, entry] of this.#entries) if (!entry.promise && entry.nextAttemptAt <= now) this.#entries.delete(other);
    // A persisted cooldown is source/URL authority, including on a deferred
    // read or a second waiter joining already-running work after a restart.
    const restoredFloor = Math.max(Number.isFinite(notBefore) ? notBefore : 0, Number.isFinite(rateLimitedUntil) ? rateLimitedUntil : 0);
    this.observeNotBefore(url, restoredFloor, rateLimitedUntil);
    const entry = this.#entries.get(key) || { nextAttemptAt: 0, rateLimitedUntil: 0, promise: null };
    this.#entries.set(key, entry);
    const withAdmission = response => ({
      ...response, nextAttemptAt: entry.nextAttemptAt,
      ...(entry.rateLimitedUntil > now ? { rateLimitedUntil: entry.rateLimitedUntil } : {}),
    });
    const admittedResult = promise => promise.then(response => {
      signal?.throwIfAborted();
      entry.nextAttemptAt = Math.max(entry.nextAttemptAt, response.nextAttemptAt || 0);
      entry.rateLimitedUntil = Math.max(entry.rateLimitedUntil, response.rateLimitedUntil || 0);
      return withAdmission(response);
    });
    if (publicResponses.has(key)) return admittedResult(publicResponses.get(key));
    if (entry.promise) return admittedResult(entry.promise);
    if (entry.nextAttemptAt > now) {
      // One cycle has one URL admission outcome, even if slower supplemental
      // work crosses the floor before its later registrations are visited.
      const deferred = Promise.resolve(withAdmission({ ok: false, deferred: true, completedAt: now }));
      publicResponses.set(key, deferred);
      return deferred;
    }
    entry.nextAttemptAt = now + attemptFloorMs;
    entry.promise = (async () => {
      try {
        let response = await fetchJsonResponse(url, fetchImpl, { signal, includeHeaders: true });
        if (response.ok && response.headers.age === undefined) response = await fetchJsonResponse(url, fetchImpl, { signal, includeHeaders: true });
        const completedAt = clock();
        if (response.status === 429) {
          entry.rateLimitedUntil = Math.max(entry.rateLimitedUntil, completedAt + Math.max(300000, retryAfterDelay(response.retryAfter, completedAt)));
          entry.nextAttemptAt = Math.max(entry.nextAttemptAt, entry.rateLimitedUntil);
        }
        else if (response.status >= 500) entry.nextAttemptAt = Math.max(entry.nextAttemptAt, completedAt + 120000);
        if (response.ok && Buffer.byteLength(JSON.stringify(response.value)) > 2000000) response = { ok: false };
        return immutable(structuredClone(withAdmission({ ...response, completedAt })));
      } catch (error) {
        signal?.throwIfAborted();
        entry.nextAttemptAt = Math.max(entry.nextAttemptAt, clock() + 120000);
        return { ok: false, completedAt: clock(), nextAttemptAt: entry.nextAttemptAt };
      } finally {
        entry.promise = null;
      }
    })();
    publicResponses.set(key, entry.promise);
    return admittedResult(entry.promise);
  }
}

function nextStationArrivalRefresh(cache, now, notBefore, workerIntervalMs) {
  const source = cache.sources?.['station-arrivals'];
  const deadlines = (source?.events || []).map(e => e.expiresAt).filter(Number.isFinite);
  if (Number.isFinite(source?.expiresAt)) deadlines.push(source.expiresAt);
  const interval = Math.min(STATION_ARRIVAL_REFRESH_INTERVAL_MS, workerIntervalMs);
  const beforeExpiry = deadlines.length ? Math.min(...deadlines) - 15000 : Infinity;
  return Math.max(notBefore, Math.min(now + interval, beforeExpiry));
}

export async function refreshStationArrivals(record, previous, config, fetchImpl, now, signal, clock, publicResponses, arrivalReader, sharedReadDue = false) {
  signal?.throwIfAborted();
  if (!sharedReadDue && previous.arrivalsRefreshAt > now) return mergeContexts(previous, {}, record, now);
  const url = new URL(`https://api.tfl.gov.uk/StopPoint/${record.stationID}/Arrivals`);
  if (config.tflAppKey) url.searchParams.set('app_key', config.tflAppKey);
  const response = await arrivalReader.read(url, { fetchImpl, signal, clock, publicResponses,
    notBefore: previous.arrivalsNotBefore, rateLimitedUntil: previous.arrivalsRateLimitedUntil });
  return mergeStationArrivalRead(record, previous, response, clock(), config.workerIntervalMs);
}

export function activityRailDeparturesURL(stationID, lineID, tflAppKey) {
  const url = new URL(`https://api.tfl.gov.uk/StopPoint/${stationID}/ArrivalDepartures`);
  url.searchParams.set('lineIds', lineID);
  if (tflAppKey) url.searchParams.set('app_key', tflAppKey);
  return url;
}

function readRailDepartures(url, previous, arrivalReader, options) {
  return arrivalReader.read(url, { ...options, attemptFloorMs: STATION_ARRIVAL_REFRESH_INTERVAL_MS,
    notBefore: previous.railDeparturesNotBefore, rateLimitedUntil: previous.railDeparturesRateLimitedUntil });
}

function railDepartureSource(record, response, now) {
  const age = response.headers?.age;
  if (!response.ok || response.status !== 200 || typeof age !== 'string' || !/^\d+$/.test(age.trim())) return undefined;
  const events = parseRailDepartures(response.value, record, response.headers, response.completedAt);
  if (events.length) return { observedAt: Math.max(...events.map(event => event.receivedAt)), events };
  if (Array.isArray(response.value) && response.value.length === 0) {
    const observation = httpObservation(response.headers, response.completedAt, 90000, { cacheRequired: true });
    if (observation?.expiresAt > now) return { ...observation, events };
  }
}

function railDepartureReceipt(record, previous, response, source, now) {
  return {
    railDepartureAttempt: boardSourceAttempt(response, source, previous.sources?.['rail-departures'],
      previous.railDepartureAttempt, record, now),
    railDeparturesNotBefore: response.nextAttemptAt,
    railDeparturesRateLimitedUntil: response.rateLimitedUntil,
  };
}

export async function refreshRailDepartures(record, previous, config, fetchImpl, now, signal, clock, publicResponses, arrivalReader, sharedReadDue = false) {
  if (!STATION_BOARD_LINES.get(record.lineID)?.qualifiedRailDepartureSource || (!sharedReadDue && previous.railDeparturesNotBefore > now)) return previous;
  const url = activityRailDeparturesURL(record.stationID, record.lineID, config.tflAppKey);
  const response = await readRailDepartures(url, previous, arrivalReader, { fetchImpl, signal, clock, publicResponses });
  const completedAt = clock();
  const source = railDepartureSource(record, response, completedAt);
  return mergeContexts(previous, { sources: source ? { 'rail-departures': source } : {},
    ...railDepartureReceipt(record, previous, response, source, completedAt) }, record, completedAt);
}

function mergeStationArrivalRead(record, previous, response, now, workerIntervalMs) {
  const sources = {};
  if (response.ok && response.status === 200) {
    const observation = Array.isArray(response.value) && response.value.length === 0
      ? stationEmptyObservation(response.headers, response.completedAt)
      : stationArrivalObservation(response.headers, response.completedAt);
    const events = parseStationArrivals(response.value, record, response.headers, response.completedAt);
    if (events.length || observation && Array.isArray(response.value) && response.value.length === 0) {
      sources['station-arrivals'] = { observedAt: events.length ? Math.max(...events.map(e => e.receivedAt)) : observation.observedAt, expiresAt: observation?.expiresAt, events };
    }
  }
  const stationArrivalAttempt = boardSourceAttempt(response, sources['station-arrivals'], previous.sources?.['station-arrivals'],
    previous.stationArrivalAttempt, record, now);
  const merged = mergeContexts(previous, { sources, stationArrivalAttempt, arrivalsRateLimitedUntil: response.rateLimitedUntil }, record, now);
  const notBefore = Math.max(previous.arrivalsNotBefore || 0, response.nextAttemptAt || now + STATION_ARRIVAL_ATTEMPT_FLOOR_MS);
  const nextRefresh = response.deferred ? notBefore : nextStationArrivalRefresh(merged, now, notBefore, workerIntervalMs);
  return { ...merged, arrivalsNotBefore: notBefore, arrivalsRefreshAt: nextRefresh };
}

const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function londonLocal(ms) {
  const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function londonClock(value) {
  if (typeof value !== 'string') return NaN;
  if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return isoClock(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)) return NaN;
  const utc = Date.parse(`${value}Z`);
  const matches = [utc - 3_600_000, utc].filter((candidate) => londonLocal(candidate) === value);
  return matches.length === 1 ? matches[0] : NaN;
}
function midnight(now) {
  const day = londonLocal(now).slice(0, 10), next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return londonClock(`${next}T00:00:00`);
}
function event(record, sourceID, facts, observation) {
  return { stationID: record.stationID, lineID: record.lineID, sourceID, receivedAt: observation.observedAt, expiresAt: observation.expiresAt, ...facts };
}
function arrivalAlternatives(rows) {
  const unique = [...new Map(rows.map((row) => [canonical(row), row])).values()];
  const broad = new Map();
  for (const row of unique) {
    if (!text(row.id) || !text(row.vehicleId) || ['0', '000', 'unknown'].includes(key(row.vehicleId)) || !text(row.currentLocation) || !Number.isFinite(isoClock(row.timestamp)) || !Number.isFinite(isoClock(row.timing?.read))) continue;
    const stable = { ...row }; delete stable.platformName; delete stable.expectedArrival; delete stable.timeToStation; delete stable.timeToLive;
    if (stable.timing) { stable.timing = { ...stable.timing }; delete stable.timing.timeToLive; }
    const signature = canonical(stable), group = broad.get(signature) || []; group.push(row); broad.set(signature, group);
  }
  const broadByRow = new Map();
  for (const [signature, group] of broad) {
    const platforms = group.map((row) => text(row.platformName)?.toLowerCase()), clocks = group.map((row) => isoClock(row.expectedArrival));
    if (group.length > 1 && platforms.every(Boolean) && new Set(platforms).size === group.length && clocks.every(Number.isFinite) && Math.max(...clocks) - Math.min(...clocks) <= 90000) for (const row of group) broadByRow.set(canonical(row), signature);
  }
  const groups = new Map();
  for (const row of unique) {
    const facts = { ...row }; delete facts.platformName;
    const signature = broadByRow.get(canonical(row)) || (text(row.id) ? canonical(facts) : canonical(row)), group = groups.get(signature) || []; group.push(row); groups.set(signature, group);
  }
  return [...groups.values()].map((group) => ({ ...group[0], __unknownPlatform: new Set(group.map((row) => row.platformName)).size > 1, __unknownClock: new Set(group.map((row) => row.expectedArrival)).size > 1 }));
}
export function parseStationArrivals(rows, record, headers, now) {
  const observation = stationArrivalObservation(headers, now);
  if (!observation || !Array.isArray(rows) || rows.length > 2000 || rows.some((row) => !objectRow(row))) return [];
  const seen = new Set();
  return arrivalAlternatives(rows).flatMap((row) => {
    if (row.naptanId !== record.stationID || row.lineId !== record.lineID || seen.has(canonical(row))) return [];
    seen.add(canonical(row));
    const destination = endpoint(row, record), time = isoClock(row.expectedArrival), timestamp = isoClock(row.timestamp);
    if (!destination || !Number.isFinite(time) || time < now || !Number.isFinite(timestamp) || timestamp > now + 5000 || timestamp + 120000 <= now) return [];
    const receivedAt = Math.min(observation.observedAt, timestamp);
    // Repeated calls can only change self-endpoint classification when the
    // source actually provides an ordered route and current call position.
    const stops = row.routeStationIDs, index = row.selectedStopIndex;
    const loop = Array.isArray(stops) && Number.isInteger(index) && index >= 0 && index < stops.length && stops[index] === record.stationID && stops.at(-1) === destination.stationID && index < stops.length - 1;
    const incoming = destination.stationID === record.stationID && !loop;
    return [event(record, 'station-arrivals', { id: `arrival:${hash(row)}`, kind: incoming ? 'incomingArrival' : 'throughArrival', destination: destination.stationName, destinationStationID: destination.stationID,
      time: row.__unknownClock ? null : time, timeEvidence: row.__unknownClock ? null : 'arrivalPrediction', platform: row.__unknownPlatform ? null : usablePlatform(row.platformName), direction: row.__unknownPlatform ? null : publicDirection(row.platformName, row.direction), providerDirection: text(row.direction), via: routeVia(row.towards, destination, record.lineID), receivedAt,
      expiresAt: Math.min(observation.expiresAt, receivedAt + 120000) }, observation)];
  });
}
function usablePlatform(value) { const v = text(value); return v && !['unknown', 'platform unknown', 'tbc', '-'].includes(v.toLowerCase()) ? v : null; }
function publicDirection(...values) {
  const labels = new Set([...values.join(' ').matchAll(/\b(?:(north|south|east|west)[\s-]*bound|(?:inner|outer)[\s-]+rail)\b/gi)]
    .map(match => match[0].toLowerCase().replace(/[\s-]+/g, '').replace(/rail$/, ' rail')));
  if (labels.size !== 1) return null;
  const [label] = labels;
  return label.replace(/\b\w/g, letter => letter.toUpperCase());
}
function routeVia(towards, destination, lineID) {
  if (!text(towards)) return null;
  const parts = towards.split(/ via /i);
  if (parts.length > 2 || (key(parts[0]) !== key(destination.stationName) && !(key(parts[0]).length >= 4 && key(destination.stationName).startsWith(`${key(parts[0])} `)))) return undefined;
  if (parts.length === 1) return null;
  if (['cx', 'charing cross'].includes(key(parts[1]))) return 'Charing Cross';
  if (key(parts[1]) === 'bank') return 'Bank';
  return named(parts[1], lineID)?.stationName;
}
export function parseDestinationFacts(rows, record, headers, now) {
  const observation = httpObservation(headers, now, 60_000, { cacheRequired: true });
  if (!observation || !Array.isArray(rows) || rows.length > 5000 || rows.some((row) => !objectRow(row))) return [];
  const selected = STATION_BOARD_STATIONS.get(record.stationID), names = [key(selected?.stationName)];
  if (record.stationID === '940GZZLUERC' && ['circle', 'district', 'hammersmith-city'].includes(record.lineID)) names.push('edgware road');
  const locations = new Map();
  for (const row of rows) {
    if (row.lineId !== record.lineID) continue;
    const timestamp = isoClock(row.timestamp), read = isoClock(row.timing?.read);
    // Unified predictions expose source-read as timing.read. It must be a
    // validated source clock, never a countdown or downstream departure.
    if (![timestamp, read].every(Number.isFinite) || timestamp > now + 5000 || read > now + 5000 || timestamp + 60000 <= now || read + 90000 <= now) continue;
    const location = text(row.currentLocation)?.replace(/\s+/g, ' '), normalized = key(location);
    let platform = null, matched = false;
    for (const name of names) {
      if (normalized === `at ${name}`) matched = true;
      const prefix = `at ${name} platform `;
      if (normalized.startsWith(prefix) && /^[a-z0-9][a-z0-9/-]{0,7}$/i.test(normalized.slice(prefix.length))) { matched = true; platform = `Platform ${normalized.slice(prefix.length).toUpperCase()}`; }
    }
    if (!matched) continue;
    const downstream = STATION_BOARD_STATIONS.get(row.naptanId), destination = endpoint(row, record), via = destination ? routeVia(row.towards, destination, record.lineID) : undefined;
    const valid = downstream && downstream.stationID !== record.stationID && key(downstream.stationName) === key(row.stationName) && isoClock(row.expectedArrival) > now && destination && destination.stationID !== record.stationID && via !== undefined;
    const group = locations.get(platform || 'station') || [];
    group.push({ valid, destination, via, platform, vehicle: text(row.vehicleId), direction: text(row.direction), read, expiresAt: Math.min(observation.expiresAt, timestamp + 60000, read + 90000) });
    locations.set(platform || 'station', group);
  }
  return [...locations.values()].flatMap((group) => {
    if (group.some((item) => !item.valid) || new Set(group.map((item) => item.vehicle).filter(Boolean)).size > 1 || new Set(group.map((item) => item.direction).filter(Boolean)).size > 1 || new Set(group.map((item) => canonical([item.destination?.stationID, item.via]))).size !== 1) return [];
    const first = group[0];
    return [event(record, 'at-station-destination', { id: `destination:${hash([record.lineID, first.destination.stationID, first.via, first.platform])}`, kind: 'outgoingDestinationOnly', destination: first.destination.stationName,
      destinationStationID: first.destination.stationID, via: first.via, platform: first.platform, time: null, timeEvidence: null, providerDirection: first.direction,
      receivedAt: Math.max(...group.map((item) => item.read)), expiresAt: Math.min(...group.map((item) => item.expiresAt)) }, observation)];
  });
}
export function parseRailDepartures(rows, record, headers, now) {
  if (!STATION_BOARD_LINES.get(record.lineID)?.qualifiedRailDepartureSource || !Array.isArray(rows) || rows.length > 500 || rows.some((row) => !objectRow(row) || row.naptanId !== record.stationID)) return [];
  const observation = httpObservation(headers, now, 90_000, { cacheRequired: true });
  if (!observation) return [];
  const unique = [...new Map(rows.map((row) => [canonical(row), row])).values()];
  const alternatives = new Map();
  for (const row of unique) { const facts = { ...row }; delete facts.platformName; const signature = canonical(facts); alternatives.set(signature, (alternatives.get(signature) || 0) + 1); }
  return unique.flatMap((row) => {
    const destination = endpoint(row, record), status = text(row.departureStatus)?.toLowerCase(), estimated = isoClock(row.estimatedTimeOfDeparture), scheduled = isoClock(row.scheduledTimeOfDeparture);
    const withoutPlatform = { ...row }; delete withoutPlatform.platformName;
    if ((row.lineId !== undefined && row.lineId !== record.lineID) || (row.lineIds !== undefined && (!Array.isArray(row.lineIds) || row.lineIds.length !== 1 || row.lineIds[0] !== record.lineID))) return [];
    if (['check front of train', 'see front of train'].includes(key(row.destinationName))) return [];
    if (!text(row.destinationNaptanId) || !text(row.destinationName) || !destination || !['ontime', 'delayed'].includes(status) || alternatives.get(canonical(withoutPlatform)) > 1) return [];
    const incoming = destination.stationID === record.stationID;
    const time = incoming ? isoClock(row.estimatedTimeOfArrival) : Number.isFinite(estimated) ? estimated : status === 'ontime' ? scheduled : NaN;
    if (!Number.isFinite(time) || time < now) return [];
    return [event(record, 'rail-departures', { id: `rail:${hash(row)}`, kind: incoming ? 'incomingArrival' : 'outgoingDeparture', destination: destination.stationName, destinationStationID: destination.stationID, time,
      timeEvidence: incoming ? 'arrivalPrediction' : Number.isFinite(estimated) ? 'predictedDeparture' : 'scheduledDeparture', platform: usablePlatform(row.platformName), direction: publicDirection(row.platformName), providerDirection: null, via: null, ...(incoming ? { scheduledArrival: Number.isFinite(isoClock(row.scheduledTimeOfArrival)) ? isoClock(row.scheduledTimeOfArrival) : null } : {}) }, observation)];
  });
}
export function journeyURL(record, departAt, actualRequestAt = departAt) {
  const line = STATION_BOARD_LINES.get(record.lineID);
  if (!line || !validBoard(record.stationID, record.lineID)) return null;
  const rule = catalogue.narrowQueryRules?.find((rule) => rule.stationID === record.stationID && rule.lineID === record.lineID);
  const branch = rule?.targetID || line.branchTargetIDs.find((id) => id !== record.stationID && validBoard(id, record.lineID));
  const common = !rule && record.selectionMode === 'allPlatforms' && !record.platformID && departAt <= actualRequestAt
    ? regularOrigins[record.lineID]?.commonJourneyTargets?.[record.stationID] : null;
  const evidence = journeyTargetEvidence[record.lineID]?.[record.stationID];
  const target = common && common !== record.stationID && validBoard(common, record.lineID)
    && evidence?.targetID === common && evidence.previousTargetID === branch ? common : branch;
  if (!target) return null;
  const local = londonLocal(departAt), url = new URL(`https://api.tfl.gov.uk/Journey/JourneyResults/${record.stationID}/to/${target}`);
  for (const [name, value] of Object.entries({ date: local.slice(0, 10).replaceAll('-', ''), time: local.slice(11, 16).replace(':', ''), timeIs: 'Departing', mode: line.mode, useRealTimeLiveArrivals: 'false', calcOneDirection: 'true', includeAlternativeRoutes: rule ? 'false' : 'true' })) url.searchParams.set(name, value);
  if (rule) url.searchParams.set('journeyPreference', 'leastinterchange');
  if (rule?.via) { url.searchParams.set('via', rule.via); url.searchParams.set('maxWalkingMinutes', '0'); }
  return url;
}
function withdrawnJourneyLeg(leg) {
  return ['isCancelled', 'isCanceled', 'cancelled', 'canceled'].some(field => leg[field] === true)
    || ['status', 'serviceStatus'].some(field => ['cancelled', 'canceled', 'withdrawn'].includes(String(leg[field] || '').toLowerCase()));
}
export function parseJourney(root, record, headers, requestedAt, now, actualRequestAt = requestedAt) {
  const line = STATION_BOARD_LINES.get(record.lineID), local = `${londonLocal(requestedAt).slice(0, 16)}:00`;
  if (!line || !validBoard(record.stationID, record.lineID) || root?.searchCriteria?.dateTimeType !== 'Departing' || root.searchCriteria.dateTime !== local || !Number.isInteger(root.recommendedMaxAgeMinutes) || root.recommendedMaxAgeMinutes <= 0 || !Array.isArray(root.stopMessages) || root.stopMessages.some((message) => typeof message !== 'string') || !Array.isArray(root.journeys)) return [];
  const observation = httpObservation(headers, now, Math.min(root.recommendedMaxAgeMinutes, 2) * 60000, { futureSkew: 120000 });
  if (!observation) return [];
  observation.expiresAt = Math.min(observation.expiresAt, midnight(actualRequestAt));
  if (observation.expiresAt <= now) return [];
  const seen = new Map(), events = [];
  for (const journey of root.journeys) {
    const leg = Array.isArray(journey?.legs) ? journey.legs.find((leg) => objectRow(leg) && leg.mode?.id !== 'walking') : null, option = leg?.routeOptions?.[0];
    if (!leg || leg.mode?.id !== line.mode || leg.departurePoint?.naptanId !== record.stationID || leg.isDisrupted !== false || withdrawnJourneyLeg(leg) || !Array.isArray(leg.disruptions) || leg.disruptions.length || !Array.isArray(leg.plannedWorks) || leg.plannedWorks.length || leg.routeOptions?.length !== 1 || option.lineIdentifier?.id !== record.lineID || option.directions?.length !== 1 || typeof option.directions[0] !== 'string') continue;
    const departure = londonClock(leg.scheduledDepartureTime), parts = option.directions[0].split(/ via /i), destination = named(parts[0], record.lineID);
    if (!Number.isFinite(departure) || departure < now || departure < requestedAt - (requestedAt > actualRequestAt ? 0 : 60000) || !destination || destination.stationID === record.stationID || parts.length > 2 || !Array.isArray(leg.path?.stopPoints) || !leg.path.stopPoints.length) continue;
    const viaStation = parts.length === 2 ? named(parts[1], record.lineID) : null;
    if (parts.length === 2 && !viaStation) continue;
    const calls = leg.path.stopPoints.map((stop) => !objectRow(stop) ? null : stop.id ? validBoard(stop.id, record.lineID) ? stop.id : null : named(stop.name, record.lineID)?.stationID);
    if (calls.some((call) => !call) || calls.at(-1) !== leg.arrivalPoint?.naptanId) continue;
    const service = hash({ station: record.stationID, line: record.lineID, stop: leg.departurePoint.individualStopId || '', clock: leg.scheduledDepartureTime, direction: option.directions[0], providerDirection: option.direction || '', routeID: option.id || '', legID: leg.id || '' });
    const prior = seen.get(service) || [];
    if (prior.some((previous) => previous.slice(0, Math.min(previous.length, calls.length)).every((id, index) => id === calls[index]))) continue;
    seen.set(service, [...prior, calls]);
    events.push(event(record, 'journey-planner', { id: `journey:${hash([service, calls])}`, kind: 'outgoingDeparture', destination: destination.stationName, destinationStationID: destination.stationID, time: departure, timeEvidence: 'scheduledDeparture', platform: null, via: viaStation?.stationName || null, direction: null, providerDirection: text(option.direction), nextScheduledStopID: calls.find(call => call !== record.stationID) || null }, observation));
  }
  return events;
}
export function usable(event, record, now) {
  if (!objectRow(event)) return false;
  const knownSource = ['station-arrivals', 'unified-arrivals', 'rail-departures', 'at-station-destination', 'timetable', 'unified-timetable', 'journey-planner', 'regular-timetable'].includes(event.sourceID);
  const knownKind = ['outgoingDeparture', 'outgoingDestinationOnly', 'incomingArrival', 'throughArrival', 'unverifiedArrival'].includes(event.kind);
  if (typeof event.id !== 'string' || !knownSource || !knownKind || (event.kind === 'outgoingDeparture' && !['scheduledDeparture', 'predictedDeparture'].includes(event.timeEvidence)) || (['throughArrival', 'incomingArrival', 'unverifiedArrival'].includes(event.kind) && event.timeEvidence !== 'arrivalPrediction' && event.timeEvidence != null)) return false;
  return event.stationID === record.stationID && event.lineID === record.lineID && Number.isFinite(event.receivedAt) && event.receivedAt <= now && Number.isFinite(event.expiresAt) && event.expiresAt > now && typeof event.destination === 'string'
    && (event.kind === 'outgoingDestinationOnly' ? event.time == null && event.timeEvidence == null : ['incomingArrival', 'throughArrival'].includes(event.kind) && event.time == null ? event.timeEvidence == null : Number.isFinite(event.time) && event.time >= now && ['arrivalPrediction', 'scheduledDeparture', 'predictedDeparture'].includes(event.timeEvidence));
}
function retainedRejection(rejection, record, now) {
  if (!rejection || rejection.stationID !== record.stationID || rejection.lineID !== record.lineID
    || !Number.isFinite(rejection.observedAt) || rejection.observedAt > now) return false;
  if (rejection.reason === 'regularSourceWithdrawn' && rejection.regularWithdrawalUntil !== undefined) {
    const until = rejection.regularWithdrawalUntil;
    return Number.isFinite(until) && until > rejection.observedAt
      && until - rejection.observedAt <= 26 * 3600000 && now <= until;
  }
  return rejection.observedAt + 600000 > now;
}
function rejectionInvalidates(rejection, event, record, now) {
  if (!retainedRejection(rejection, record, now)) return false;
  if (rejection.reason === 'regularSourceWithdrawn') {
    return event.sourceID === 'regular-timetable'
      && (Number.isFinite(rejection.regularWithdrawalUntil) || event.receivedAt <= rejection.observedAt);
  }
  return event.receivedAt <= rejection.observedAt
    && (['serviceUnavailable', 'stationDisrupted'].includes(rejection.reason) ? planned(event) : sourceKey(event.sourceID) === 'timetable');
}
function mergeStationArrivalSchedule(previous, incoming, sources) {
  if (!Number.isFinite(incoming.arrivalsNotBefore ?? previous.arrivalsNotBefore)) return {};
  const priorFloor = previous.arrivalsNotBefore || 0, nextFloor = incoming.arrivalsNotBefore || 0;
  const arrivalsNotBefore = Math.max(priorFloor, nextFloor);
  const candidates = (nextFloor > priorFloor ? [incoming.arrivalsRefreshAt] : nextFloor < priorFloor ? [previous.arrivalsRefreshAt] : [previous.arrivalsRefreshAt, incoming.arrivalsRefreshAt]).filter(Number.isFinite);
  const source = sources['station-arrivals'];
  const expiries = (source?.events || []).map(e => e.expiresAt).filter(Number.isFinite);
  if (Number.isFinite(source?.expiresAt)) expiries.push(source.expiresAt);
  const sourceDeadline = expiries.length ? Math.min(...expiries) - 15000 : Infinity;
  const due = Math.min(sourceDeadline, ...candidates);
  return { arrivalsNotBefore, ...(Number.isFinite(due) ? { arrivalsRefreshAt: Math.max(arrivalsNotBefore, due) } : {}) };
}

function boardSourceAttempt(response, source, previousSource, previousAttempt, record, now) {
  if (!Number.isFinite(response.completedAt) || response.deferred) return undefined;
  const lastObservation = Math.max(previousSource?.observedAt ?? -Infinity, previousAttempt?.observedAt ?? -Infinity);
  const fresh = response.ok && Number.isFinite(source?.observedAt) && source.observedAt <= now
    && (source.events.length ? source.events.some(event => usable(event, record, now)) : source.expiresAt > now);
  // A successful transport cannot clear an outage without new, usable source
  // evidence. Keep the observation floor even after the source rows expire.
  const advanced = fresh && source.observedAt > lastObservation;
  const observedAt = advanced ? source.observedAt : lastObservation;
  const failed = !fresh || !advanced && previousAttempt?.failed === true;
  return { at: response.completedAt, failed, ...(Number.isFinite(observedAt) ? { observedAt } : {}) };
}

function retainBoardSourceAttempt(previous, incoming, now) {
  return [previous, incoming].filter(attempt => typeof attempt?.failed === 'boolean'
    && Number.isFinite(attempt.at) && attempt.at <= now)
    .reduce((latest, attempt) => !latest || attempt.at >= latest.at ? attempt : latest, undefined);
}

export function mergeContexts(previous = {}, incoming = {}, record, now) {
  const rejections = [...(previous.rejections || []), ...(incoming.rejections || [])].filter(r =>
    retainedRejection(r, record, now) && ['publicationChanged', 'timetableChanged', 'unsupportedCalendar',
      'serviceUnavailable', 'stationDisrupted', 'regularSourceWithdrawn'].includes(r.reason));
  const markerMap = new Map();
  for (const marker of rejections) {
    const scope = marker.reason === 'regularSourceWithdrawn' ? 'regular'
      : ['stationDisrupted', 'serviceUnavailable'].includes(marker.reason) ? 'planned-service' : 'publication';
    const rank = candidate => candidate?.regularWithdrawalUntil ?? candidate?.observedAt ?? -Infinity;
    if (rank(markerMap.get(scope)) < rank(marker)) markerMap.set(scope, marker);
  }
  const markers = [...markerMap.values()], sources = {};
  const availabilityProofs = retainAvailability(previous, incoming, record, now);
  const closureSources = legacyClosureSources(availabilityProofs);
  let publicationIdentity = null;
  for (const check of [previous.publicationIdentity, incoming.publicationIdentity]) {
    if (objectRow(check) && Number.isFinite(check.observedAt) && check.observedAt <= now && check.observedAt + 600000 > now && check.expiresAt <= check.observedAt + 600000 && /^[a-f0-9]{64}$/i.test(check.sha256 || '') && (!publicationIdentity || check.observedAt > publicationIdentity.observedAt)) publicationIdentity = check;
  }
  for (const contexts of [previous.sources || {}, incoming.sources || {}]) {
    for (const [source, context] of Object.entries(contexts)) {
      if (!objectRow(context)) continue;
      const normalized = sourceKey(source), old = sources[normalized];
      if (!Number.isFinite(context.observedAt) || context.observedAt > now) continue;
      if (normalized === 'timetable' && publicationIdentity?.expiresAt > now && publicationIdentity.observedAt >= context.observedAt && context.evidence?.publication?.sha256?.toLowerCase() !== publicationIdentity.sha256.toLowerCase()) continue;
      const events = (context.events || []).filter((e) => usable(e, record, now) && !(planned(e) && availabilityProofs.some((p) => p.plannedUnavailable === true && p.scheduledClockOnly !== true && blocksScheduled(p, e.time, now))) && !markers.some((r) => rejectionInvalidates(r, e, record, now)));
      // A complete station empty keeps its original ordering floor after HTTP
      // expiry; it is not current evidence and cannot resurrect older rows.
      // A qualified timetable can be re-read from another edge for up to 12 hours.
      // Keep its ordering evidence even while there are no countdowns to display.
      const keepTimetableProof = normalized === 'regular-timetable' && context.evidence?.ordinaryTimetable
        && context.observedAt + 43200000 > now;
      if (!events.length && !keepTimetableProof && !(Array.isArray(context.events) && context.events.length === 0 && (normalized === 'rail-departures' || normalized === 'station-arrivals' && Number.isFinite(context.expiresAt) && context.expiresAt > context.observedAt && context.expiresAt <= context.observedAt + 120000 || normalized === 'timetable' && context.qualificationOrigin === 'server' && context.expiresAt > now))) continue;
      const earlierProof = old?.evidence?.ordinaryTimetable;
      const renewedRegular = normalized === 'regular-timetable' && old && context.observedAt === old.observedAt
        && context.expiresAt > (old.expiresAt ?? Math.max(...old.events.map(e => e.expiresAt)))
        && (earlierProof ? earlierProof.signature === context.evidence?.ordinaryTimetable?.signature
          : context.evidence?.ordinaryOverlap === true && ordinaryWorkingKeys(old.events) === ordinaryWorkingKeys(events));
      if (!old || context.observedAt > old.observedAt || renewedRegular) sources[normalized] = { observedAt: context.observedAt, events, ...(context.expiresAt === undefined ? {} : { expiresAt: context.expiresAt }), ...(context.evidence ? { evidence: context.evidence, qualificationOrigin: context.qualificationOrigin } : {}) };
    }
  }
  const withdrawnRegular = new Map();
  for (const cache of [previous, incoming]) {
    for (const { id, time } of cache.withdrawnRegular || []) {
      if (time >= now && time <= now + 3600000) withdrawnRegular.set(id, time);
    }
  }
  const usual = sources['regular-timetable'], dated = sources['journey-planner'];
  if (usual && dated && supportsRegularOrigin(record)) {
    const rule = regularOriginRule(record);
    const starts = dated.events.filter(e => rule.physicalEnd || hasExclusiveStartingCall(e, rule));
    const superseded = supersededRegularDestinations([...usual.events, ...starts]);
    for (const row of superseded) withdrawnRegular.set(row.id, row.time);
  }
  // A fresh read of the ordinary timetable cannot undo a dated change to this train.
  if (usual && withdrawnRegular.size) usual.events = usual.events.filter(row => !withdrawnRegular.has(row.id));
  const ordinaryNotBefore = Math.max(previous.ordinaryNotBefore || 0, incoming.ordinaryNotBefore || 0);
  const arrivalsRateLimitedUntil = Math.max(previous.arrivalsRateLimitedUntil || 0, incoming.arrivalsRateLimitedUntil || 0);
  const railDeparturesNotBefore = Math.max(previous.railDeparturesNotBefore || 0, incoming.railDeparturesNotBefore || 0);
  const railDeparturesRateLimitedUntil = Math.max(previous.railDeparturesRateLimitedUntil || 0, incoming.railDeparturesRateLimitedUntil || 0);
  const stationArrivalAttempt = retainBoardSourceAttempt(previous.stationArrivalAttempt, incoming.stationArrivalAttempt, now);
  const railDepartureAttempt = retainBoardSourceAttempt(previous.railDepartureAttempt, incoming.railDepartureAttempt, now);
  return { sources, rejections: markers, closureSources, availabilityProofs, publicationIdentity, nextRefreshAt: Math.max(previous.nextRefreshAt || 0, incoming.nextRefreshAt || 0), ...mergeStationArrivalSchedule(previous, incoming, sources), status: incoming.status || previous.status || null,
    ...(withdrawnRegular.size ? { withdrawnRegular: Array.from(withdrawnRegular, ([id, time]) => ({ id, time })) } : {}),
    ...(stationArrivalAttempt ? { stationArrivalAttempt } : {}), ...(railDepartureAttempt ? { railDepartureAttempt } : {}),
    ...(ordinaryNotBefore > now ? { ordinaryNotBefore } : {}), ...(arrivalsRateLimitedUntil > now ? { arrivalsRateLimitedUntil } : {}),
    ...(railDeparturesNotBefore ? { railDeparturesNotBefore } : {}),
    ...(railDeparturesRateLimitedUntil > now ? { railDeparturesRateLimitedUntil } : {}) };
}
function selectionMatches(event, record) {
  if (record.selectionMode !== 'platform' && !record.platformID) return true;
  if (['incomingArrival', 'unverifiedArrival'].includes(event.kind)) return false;
  const label = text(record.platformLabel), heading = text(record.platformHeading), id = text(record.platformID), direction = text(record.platformDirection);
  const platformKey = (value) => { const v = text(value); if (!v || ['unknown', 'platform unknown', 'tbc', '-'].includes(key(v))) return null; return /\bplatform[\s-]+([\w/-]+)/i.exec(v)?.[1]?.toLowerCase() || (/^[a-z0-9][a-z0-9/-]{0,7}$/i.test(v) && !/^(northbound|southbound|eastbound|westbound|inbound|outbound)$/i.test(v) ? v.toLowerCase() : null); };
  const desiredPlatform = platformKey(label) || platformKey(heading) || platformKey(id);
  if (desiredPlatform && platformKey(event.platform) !== desiredPlatform) return false;
  const desiredDirection = direction || /\b(northbound|southbound|eastbound|westbound|inbound|outbound)\b/i.exec(heading || id || '')?.[1];
  if (desiredDirection && ![event.direction, event.providerDirection].some((value) => key(value) === key(desiredDirection))) return false;
  return Boolean(desiredPlatform || desiredDirection || (event.platform && key(event.platform) === key(label || heading || id)));
}
// Source choice for potentially overlapping fragments, never a train match
// or a declaration that a single rail record covers the whole board.
export function retainsThroughArrival(through, candidates) {
  if (through.kind !== 'throughArrival') return true;
  const knownDestination = (event) => {
    const id = text(event.destinationStationID), station = id && STATION_BOARD_STATIONS.get(id.toUpperCase());
    return station && station.lineIDs.includes(event.lineID) && (!text(event.destination) || ['check front of train', 'see front of train'].includes(key(event.destination)) || key(event.destination) === key(station.stationName)) ? station.stationID : null;
  };
  const physicalPlatform = (event) => {
    const value = text(event.platform)?.toLowerCase().replace(/^platform\s+/, '');
    return value && /^(?:[0-9]+[a-z]?|[a-z])$/.test(value) ? value : null;
  };
  return candidates.filter((event) => event.sourceID === 'rail-departures' && event.kind === 'outgoingDeparture' && event.timeEvidence === 'predictedDeparture' && event.stationID === through.stationID && event.lineID === through.lineID).every((departure) => {
    const leftDestination = knownDestination(through), rightDestination = knownDestination(departure);
    if (leftDestination && rightDestination && leftDestination !== rightDestination) return true;
    const leftVia = text(through.via) && named(through.via, through.lineID), rightVia = text(departure.via) && named(departure.via, departure.lineID);
    if (leftVia && rightVia && leftVia.stationID !== rightVia.stationID) return true;
    const leftPlatform = physicalPlatform(through), rightPlatform = physicalPlatform(departure);
    if (leftPlatform && rightPlatform && leftPlatform !== rightPlatform) return true;
    return through.timeEvidence === 'arrivalPrediction' && Number.isFinite(through.time) && Number.isFinite(departure.time) && through.time > departure.time;
  });
}
function atPlatformDestination(e) {
  return e.kind === 'outgoingDestinationOnly' && e.time == null && e.timeEvidence == null
    && /^(?:[0-9]+[a-z]?|[a-z])$/.test(text(e.platform)?.toLowerCase().replace(/^platform\s+/, '') || '');
}
function supersededRegularDestinations(events) {
  const regular = events.filter(e => plannedSource(e) === 'regular-timetable');
  const dated = events.filter(e => plannedSource(e) === 'journey-planner');
  const superseded = new Set();
  if (!regular.length || !dated.length) return superseded;
  // The record has already scoped the station and line. One usual departure
  // to this next stop can be replaced by a differently advertised dated one.
  const slots = new Map();
  for (const row of [...regular, ...dated]) {
    if (!text(row.nextScheduledStopID) || row.nextScheduledStopID === row.stationID) continue;
    const slot = row.time + '/' + row.nextScheduledStopID;
    if (!slots.has(slot)) slots.set(slot, { usual: [], dated: [] });
    const group = slots.get(slot);
    if (row.sourceID === 'regular-timetable') group.usual.push(row);
    else group.dated.push(row);
  }
  for (const { usual, dated } of slots.values()) {
    if (usual.length !== 1 || !dated.length) continue;
    const [row] = usual;
    // The recurring adapter supplies neither a platform nor a direction.
    // Leave any more specific boarding evidence to its own selection.
    if (row.platform || row.direction || row.providerDirection || !row.destinationStationID) continue;
    if (dated.every(other => other.destinationStationID && other.destinationStationID !== row.destinationStationID)) {
      superseded.add(row);
    }
  }
  return superseded;
}
export function selectEvents(cache, record, now, { retainingMaskedPlans = false, retainingPlannedAlternatives = false } = {}) {
  const proofs = retainAvailability(cache, {}, record, now);
  let events = Object.values(cache.sources || {}).flatMap((context) => context.events || []).filter((e) => usable(e, record, now) && !(planned(e) && proofs.some((p) => (!retainingMaskedPlans || p.plannedUnavailable === true && p.scheduledClockOnly !== true) && blocksScheduled(p, e.time, now))) && selectionMatches(e, record) && !(cache.rejections || []).some((r) => rejectionInvalidates(r, e, record, now)));
  if (!retainingPlannedAlternatives && events.some((e) => plannedSource(e) === 'timetable')) events = events.filter((e) => plannedSource(e) !== 'journey-planner');
  if (supportsRegularOrigin(record)) {
    const rule = regularOriginRule(record);
    if (!rule.physicalEnd) {
      // A dated itinerary can board a through train at a mixed station.
      // Keep that fact in its source context. Only a proved first call can
      // displace the independent starting path on an origin-aware board.
      events = events.filter(e => e.kind !== 'outgoingDeparture' || e.timeEvidence !== 'scheduledDeparture'
        || e.sourceID === 'regular-timetable' || hasExclusiveStartingCall(e, rule));
    }
  }
  const regularAnswers = events.filter(e => e.sourceID !== 'regular-timetable' && ['outgoingDeparture', 'throughArrival'].includes(e.kind)
    && Number.isFinite(e.time) && e.time <= now + 3600000);
  const superseded = supersededRegularDestinations(events);
  events = events.filter(e => e.sourceID !== 'regular-timetable' || (record.supportsRegularTimetable === true
    && !superseded.has(e)
    && !regularAnswers.some(other =>
      (!retainingPlannedAlternatives || !plannedSource(other) || other.expiresAt >= e.expiresAt)
      && (!other.destinationStationID || other.destinationStationID === e.destinationStationID)
      && (!e.via || !other.via || key(e.via) === key(other.via)))));
  const rail = events.filter((e) => e.sourceID === 'rail-departures' && e.kind === 'outgoingDeparture' && e.timeEvidence === 'predictedDeparture');
  events = events.filter((event) => retainsThroughArrival(event, rail));
  const seen = new Set(); events = events.filter((e) => { const signature = canonical(e); if (seen.has(signature)) return false; seen.add(signature); return true; });
  // Compact activities compare times across eligible outgoing platform groups.
  // Arrivals remain last; physical groups belong to the full app board.
  const category = (e) => ['incomingArrival', 'unverifiedArrival'].includes(e.kind) ? 1 : 0;
  return events.sort((a, b) => category(a) - category(b) || Number(atPlatformDestination(b)) - Number(atPlatformDestination(a)) || (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id));
}
export function countdown(event, now) {
  if (event.kind === 'outgoingDestinationOnly') return usable(event, event, now) ? 'TBC' : '--';
  if (!Number.isFinite(event.time) || event.time < now || event.expiresAt <= now) return '--';
  const seconds = Math.ceil((event.time - now) / 1000);
  if (seconds < 0) return '--';
  return seconds < 60 ? 'Due' : `${Math.floor(seconds / 60)} min`;
}
export function nextBoundary(cache, record, now) {
  const boundaries = availabilityBoundaries(retainAvailability(cache, {}, record, now), now);
  for (const marker of cache.rejections || []) {
    if (marker.reason === 'regularSourceWithdrawn' && retainedRejection(marker, record, now)
      && Number.isFinite(marker.regularWithdrawalUntil)) boundaries.push(marker.regularWithdrawalUntil + 1);
  }
  if (cache.status?.expiresAt > now) boundaries.push(cache.status.expiresAt);
  for (const event of Object.values(cache.sources || {}).flatMap((context) => context.events || []).filter((e) => usable(e, record, now))) {
    boundaries.push(event.expiresAt);
    if (Number.isFinite(event.time)) {
      boundaries.push(event.time + 1);
      // Capable clients render the original countdown clock directly.
      if (record.supportsRegularTimetable === true && planned(event)) continue;
      const seconds = Math.ceil((event.time - now) / 1000);
      if (seconds >= 60) boundaries.push(event.time - Math.floor(seconds / 60) * 60000 + 1000);
    }
  }
  const future = boundaries.filter((boundary) => boundary > now);
  return future.length ? Math.min(...future) : null;
}
export function compactPlanningSource(events) {
  const clocks = new Map();
  for (const e of events) { const source = plannedSource(e); if (source) clocks.set(source, Math.min(clocks.get(source) ?? Infinity, e.time)); }
  const primary = clocks.has('timetable') ? 'timetable' : clocks.has('journey-planner') ? 'journey-planner' : null;
  return [...clocks.keys()].filter((s) => (s !== 'regular-timetable' || clocks.size === 1)
    && (!['timetable', 'journey-planner'].includes(s) || s === primary)).sort((a,b) => clocks.get(a) - clocks.get(b) || Number(b === primary) - Number(a === primary) || a.localeCompare(b))[0] || null;
}
export function compactEvents(events) {
  const source = compactPlanningSource(events);
  return events.filter((e) => !plannedSource(e) || plannedSource(e) === source);
}
function prioritizePublicDirections(rows, record) {
  if (record.selectionMode === 'platform' || record.platformID || regularOriginRule(record).physicalEnd) return rows;
  const firstByDirection = new Map();
  for (const [index, row] of rows.entries()) {
    const direction = publicDirection(row.direction, row.platform, row.providerDirection);
    if (direction && Number.isFinite(row.time) && ['outgoingDeparture', 'throughArrival'].includes(row.kind)
        && !firstByDirection.has(direction)) firstByDirection.set(direction, index);
  }
  if (firstByDirection.size < 2) return rows;
  const first = new Set(firstByDirection.values());
  const atPlatformCount = rows.findIndex(row => !atPlatformDestination(row));
  const prefixLength = first.size === 2 ? Math.min(atPlatformCount, 1) : atPlatformCount;
  return [...rows.slice(0, prefixLength), ...[...first].map(index => rows[index]),
    ...rows.slice(prefixLength).filter((_, index) => !first.has(index + prefixLength))];
}
export function buildStationBoardState(record, cache, now, { preserveLegacyOrder = false, observeDepartures } = {}) {
  const capable = record.plannedPresentationVersion === 2;
  const orderRows = rows => preserveLegacyOrder ? rows : prioritizePublicDirections(rows, record);
  const proofs = retainAvailability(cache, {}, record, now).filter((p) => p.closed || p.plannedUnavailable === true || p.scheduledClockOnly === true);
  let rows = selectEvents(cache, record, now, { retainingMaskedPlans: capable, retainingPlannedAlternatives: capable });
  const originalRows = rows;
  const sources = [...new Set(rows.map(plannedSource).filter(Boolean))];
  const retainsContexts = capable && (proofs.length > 0 || sources.length > 1);
  const eligible = (e) => !planned(e) || !proofs.some((p) => blocksScheduled(p, e.time, now));
  const eligibleRows = rows.filter(eligible);
  const chosen = compactPlanningSource(eligibleRows);
  const timedBoardable = (e) => Number.isFinite(e.time) && e.time >= now && e.time <= now + 3600000
    && (e.kind === 'outgoingDeparture' || e.kind === 'throughArrival' && e.timeEvidence === 'arrivalPrediction');
  const preferredSource = (e) => !plannedSource(e) || plannedSource(e) === chosen;
  const offersDeparture = (e) => timedBoardable(e) && eligible(e) && preferredSource(e);
  const compactRows = (ordered) => {
    const leading = ordered.slice(0, 3);
    if (leading.some(offersDeparture)) return leading;
    const departure = ordered.find(offersDeparture);
    return departure ? [...leading.slice(0, 2), departure] : leading;
  };
  const displayedRows = () => orderRows(compactEvents(rows.filter(eligible))).slice(0, 3);
  const finish = () => {
    if (observeDepartures) {
      const displayed = displayedRows();
      const offered = displayed.some(offersDeparture);
      // Recovery must cite the offered source, not a candidate that packing
      // dropped. A miss instead cites the eligible source that lost its clock.
      const qualified = (offered ? displayed : eligibleRows).find(e => offersDeparture(e)
        && e.receivedAt === cache.sources?.[sourceKey(e.sourceID)]?.observedAt);
      observeDepartures(qualified && {
        source: sourceKey(qualified.sourceID), observedAt: qualified.receivedAt, offered,
      });
    }
    return state;
  };
  if (retainsContexts) {
    const orderedSources = sources.sort((a,b) => Number(b === chosen) - Number(a === chosen) || a.localeCompare(b));
    const groups = [...orderedSources, null].map((source) => {
      const group = rows.filter((e) => plannedSource(e) === source);
      const useful = compactRows(orderRows(group.filter(eligible)));
      return [...useful, ...group.filter((e) => !eligible(e)).slice(0, 3 - useful.length)];
    });
    let retained = groups.flat();
    if (retained.length > 9) {
      const active = groups[orderedSources.indexOf(chosen)] || [];
      const independent = groups.at(-1);
      const prioritized = [...active, ...independent, ...groups.flat()];
      retained = [...new Set(prioritized)].slice(0, 9);
    }
    const selected = new Set(retained);
    if (retained.some(offersDeparture)) {
      // The client sorts known platform facts ahead of clocks across source
      // groups. Reserve one of its three rows for a boardable countdown.
      for (const fact of retained.filter(atPlatformDestination).slice(2)) selected.delete(fact);
    }
    rows = rows.filter((e) => selected.has(e));
  } else rows = compactRows(orderRows(eligibleRows.filter(preferredSource)));
  const status = cache.status?.expiresAt > now ? cache.status : null;
  const evidence = { incomingArrival: 'reportedIncomingArrival', throughArrival: 'throughArrivalPrediction', unverifiedArrival: 'unverified', outgoingDestinationOnly: 'destinationOnly' };
  const origin = regularOriginRule(record);
  const wireRow = (e) => ({ ...(record.supportsRegularTimetable === true ? {
    boardingContext: { stationID: e.stationID, lineID: e.lineID, platform: e.platform || null,
      direction: e.direction || null, destinationStationID: e.destinationStationID || null, via: e.via || null },
    ...(e.sourceID === 'regular-timetable' || e.kind === 'outgoingDeparture'
      && e.timeEvidence === 'scheduledDeparture' && hasExclusiveStartingCall(e, origin)
      ? { originQualified: true } : {}),
  } : {}), id: e.id, destination: e.destination, expectedArrival: Number.isFinite(e.time) ? swift(e.time) : null, countdownText: countdown(e, now), timeEvidence: evidence[e.kind] || (e.timeEvidence === 'predictedDeparture' ? 'estimatedDeparture' : 'scheduledDeparture'), via: e.via || null, reportedPlatform: e.platform || null, expiresAt: swift(e.expiresAt), isCached: false, ...(plannedSource(e) && (capable || plannedSource(e) !== 'rail-departures') ? { plannedSourceID: plannedSource(e) } : {}) });
  const observedAt = () => {
    // Derive the visible board clock after selection and the compact limit.
    // Masked alternatives, status and a cache-only dispatch cannot renew it.
    const clocks = displayedRows()
      .filter((row) => row.kind !== 'unverifiedArrival')
      .map((row) => row.receivedAt).filter(Number.isFinite);
    const explicitEmpty = cache.sources?.['station-arrivals'];
    if (!clocks.length && explicitEmpty?.events?.length === 0 && explicitEmpty.expiresAt > now
      && Number.isFinite(explicitEmpty.observedAt) && explicitEmpty.observedAt <= now) clocks.push(explicitEmpty.observedAt);
    const prior = [record.lastBoardObservedAt, Date.parse(record.activityStartedAt || ''),
      Date.parse(record.createdAt || ''), Date.parse(record.tokenUpdatedAt || '')]
      .find(value => Number.isFinite(value) && value <= now);
    // A worker tick with no source observation must not create a new Updated time.
    return swift(clocks.length ? Math.max(...clocks) : (prior ?? now));
  };
  const state = { contentStateContract: STATION_BOARD_CONTRACT, stationName: STATION_BOARD_STATIONS.get(record.stationID)?.stationName || record.stationID, lineName: record.lineID === 'dlr' ? 'DLR' : record.lineID === 'elizabeth' ? 'Elizabeth' : record.lineID === 'hammersmith-city' ? 'Hammersmith & City' : record.lineID === 'waterloo-city' ? 'Waterloo & City' : record.lineID.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '), platform: record.selectionMode === 'platform' || record.platformID ? record.platformHeading || record.platformLabel || record.platformID : 'All platforms',
    arrivals: [], status: status?.label || 'Status unavailable', statusReason: status?.reason || null,
    isDisrupted: status?.isDisrupted || false, updatedAt: null,
    ...(capable && proofs.length ? { plannedAvailability: { stationID: record.stationID, lineID: record.lineID, proofs: wireAvailability(proofs, swift) } } : {}) };
  const staleAt = () => {
    const deadlines = rows.flatMap((e) => ['outgoingDeparture', 'incomingArrival', 'throughArrival'].includes(e.kind) && Number.isFinite(e.time) ? [e.expiresAt, e.time + 1] : [e.expiresAt]);
    if (rows.some(planned)) deadlines.push(...availabilityBoundaries(proofs, now));
    return deadlines.length ? swift(Math.min(...deadlines)) : state.updatedAt;
  };
  const updateRows = (selection) => {
    rows = selection;
    state.arrivals = rows.map(wireRow);
    state.updatedAt = observedAt();
    state.staleAt = staleAt();
  };
  updateRows(rows);
  state.nextBoardBoundaryAt = nextBoundary(cache, record, now);
  const fits = () => Buffer.byteLength(JSON.stringify(state)) <= 3500
    && Buffer.byteLength(JSON.stringify({ aps: { timestamp: Math.floor(now / 1000), event: 'update', 'content-state': Object.fromEntries(Object.entries(state).filter(([k]) => k !== 'nextBoardBoundaryAt')), 'stale-date': Math.floor((state.staleAt * 1000 + APPLE_EPOCH) / 1000) } })) <= 4096;
  if (fits()) return finish();
  state.statusReason = null;
  if (fits()) return finish();

  const selectedRows = rows;
  const outgoing = selectedRows.filter(e => planned(e) || ['outgoingDeparture', 'outgoingDestinationOnly'].includes(e.kind)
    || e.kind === 'throughArrival' && Number.isFinite(e.time));
  const pack = (required, ordered) => {
    const selected = new Set(required);
    for (const e of ordered) {
      if (selected.has(e)) continue;
      selected.add(e);
      updateRows(ordered.filter(row => selected.has(row)));
      if (!fits()) selected.delete(e);
    }
    updateRows(ordered.filter(row => selected.has(row)));
  };
  const availability = state.plannedAvailability;
  delete state.plannedAvailability;
  updateRows([]);
  if (!fits()) state.status = 'Status unavailable';
  if (!fits()) state.platform = 'Selected platform';
  if (availability) state.plannedAvailability = availability;
  // The renderer elects schedules from overlapping sources and live clocks.
  // Keep that evidence together so a missing row can't promote its alternate.
  updateRows(outgoing);
  if (fits()) {
    pack(outgoing, selectedRows);
    return finish();
  }
  // Untimed destination facts are optional when packing the complete timed
  // context. Keep every timed alternative and its availability proofs together.
  const timedContext = outgoing.filter(e => e.kind !== 'outgoingDestinationOnly');
  if (timedContext.length < outgoing.length && timedContext.some(offersDeparture)) {
    updateRows(timedContext);
    if (fits()) {
      pack(timedContext, selectedRows);
      return finish();
    }
  }
  delete state.plannedAvailability;
  pack([], compactRows(orderRows(originalRows.filter(e => !planned(e)))));
  return finish();
}

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function datedWithdrawal(response, record, departAt, actualRequestAt, now) {
  const body = response.value;
  const localRequestTime = londonLocal(departAt).slice(0, 16) + ':00';
  if (!response.ok || body?.searchCriteria?.dateTimeType !== 'Departing'
    || body.searchCriteria.dateTime !== localRequestTime || !Array.isArray(body.journeys)
    || !Number.isInteger(body.recommendedMaxAgeMinutes) || body.recommendedMaxAgeMinutes <= 0
    || typeof response.headers?.age !== 'string' || !/^\d+$/.test(response.headers.age.trim())) return null;
  const observation = httpObservation(response.headers, response.completedAt,
    Math.min(body.recommendedMaxAgeMinutes, 2) * 60000, { cacheRequired: true });
  if (!observation) return null;
  const cutoff = midnight(actualRequestAt);
  observation.expiresAt = Math.min(observation.expiresAt, cutoff);
  if (observation.expiresAt <= now) return null;
  const cancelled = body.journeys.flatMap(item => {
    const leg = Array.isArray(item?.legs) ? item.legs.find(leg => leg?.mode?.id !== 'walking') : null;
    if (leg?.departurePoint?.naptanId !== record.stationID || leg.routeOptions?.length !== 1
      || leg.routeOptions[0]?.lineIdentifier?.id !== record.lineID || !withdrawnJourneyLeg(leg)) return [];
    const clock = londonClock(leg.scheduledDepartureTime);
    if (!Number.isFinite(clock)) return [observation.expiresAt];
    return clock > now && clock < cutoff ? [clock] : [];
  });
  const regularWithdrawalUntil = Math.max(...cancelled);
  return regularWithdrawalUntil > now ? { ...observation, regularWithdrawalUntil } : null;
}

export function regularReplacementAuthorized(cache, record, now) {
  const proof = retainAvailability(cache, {}, record, now).some(p =>
    p.scheduledClockOnly !== true && (activeClosure(p, now) || p.plannedUnavailable === true && p.observedAt <= now && p.expiresAt > now));
  return proof || (cache.rejections || []).some(r => r.reason === 'regularSourceWithdrawn'
    && retainedRejection(r, record, now) && (r.regularWithdrawalUntil ?? r.expiresAt) >= now);
}

export async function refreshStationBoard(record, previous, config, fetchImpl, now, signal, clock = () => now, publicResponses = new Map(), publicationAuthorityStore = null, arrivalReader = null) {
  signal?.throwIfAborted();
  if (previous.nextRefreshAt > now) return mergeContexts(previous, {}, record, now);
  let renewalAsset = null, renewalHead = null;
  // Legacy per-record corroboration must inspect its original context even when
  // persistent HEAD authority removes that context before other source awaits.
  const legacyPublicationContext = record.timetablePublicationAuthorityVersion === 1 ? null : previous.sources?.timetable;
  const request = (inputURL, method = 'GET', boundedTT = false, lineStatusReadback = false, ordinary = null) => {
    const url = new URL(inputURL);
    if (config.tflAppKey && url.hostname === 'api.tfl.gov.uk') url.searchParams.set('app_key', config.tflAppKey);
    const requestKey = ordinary ? `${method}:${url.href}:ordinary:${ordinary}` : `${method}:${url.href}`;
    if (!publicResponses.has(requestKey)) {
      // Insert before awaiting. The missing-Age retry, whole-body deadline
      // and size limit belong to this one public request, including failures.
      publicResponses.set(requestKey, (async () => {
        try {
          // Match the APP's official publication/TT/Status readback: one UUID belongs
          // to this canonical shared request, not to each consumer or retry.
          if (boundedTT && !ordinary || lineStatusReadback || method === 'HEAD' && url.href === 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip') url.searchParams.set('tb085', crypto.randomUUID());
          const options = { signal, includeHeaders: true, method,
            ...(boundedTT ? { bodyLimitBytes: 2000000, decodeJSON: bytes => parseBoundedJSON(bytes) } : {}),
            ...(ordinary ? { redirect: 'error' } : {}),
            ...(ordinary === 'revalidate' ? { cacheControl: 'no-cache, max-age=0' } : {}) };
          let response = await fetchJsonResponse(url, fetchImpl, options);
          if (!ordinary && response.ok && response.headers.age === undefined) response = await fetchJsonResponse(url, fetchImpl, options);
          const completedAt = clock();
          if (response.ok && Buffer.byteLength(JSON.stringify(response.value)) > 2000000) return immutable({ ok: false, completedAt });
          return immutable(structuredClone({ ...response, completedAt }));
        } catch (error) { signal?.throwIfAborted(); return immutable({ ok: false, completedAt: clock() }); }
      })());
    }
    return publicResponses.get(requestKey);
  };
  // Independent original identity/revision authority is committed before all
  // feed awaits. Cache-only callers apply retained authority without HTTP.
  if (publicationAuthorityStore && (record.timetablePublicationAuthorityVersion === 1 || previous.sources?.timetable)) {
    const head = await request(new URL('https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip'), 'HEAD');
    const observed = head.ok ? timetableHTTPObservation(head.headers, head.completedAt, { official: true }) : null;
    const sha = head.headers?.['x-amz-meta-sha256'];
    if (observed && observed.expiresAt > head.completedAt && typeof sha === 'string' && sha.length === 64 && /^[0-9a-f]{64}$/.test(sha)) {
      await publicationAuthorityStore.observeOfficialPublication({ sha256: sha, observedAt: observed.observedAt });
      try {
        const asset = await publicationAuthorityStore.readPublicationAsset(sha);
        await publicationAuthorityStore.observePublicationRevision(asset.identity);
        if (record.plannedPresentationVersion === 2 && record.timetablePublicationAuthorityVersion === 1) {
          selectedTimetableEntry(asset, record); renewalAsset = asset; renewalHead = { ...observed, sha256: sha };
        }
      } catch { /* No asset/parse success: original HEAD negative remains. */ }
    }
    previous = applyPublicationAuthority(previous, publicationAuthorityStore.publicationAuthority());
  }
  // Official metadata identity is checked before other feeds. No client URL
  // is ever fetched, and matching HEAD never extends original seeded expiry.
  let publicationRejection = null, publicationIdentity = null;
  const publicationContext = legacyPublicationContext || previous.sources?.timetable;
  const publication = publicationContext?.evidence?.publication;
  if (publication) {
    const head = await request(new URL('https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip'), 'HEAD');
    const observed = head.ok ? httpObservation(head.headers, head.completedAt, 600000, { futureSkew: 120000 }) : null;
    const currentSHA = head.headers?.['x-amz-meta-sha256'];
    if (observed && observed.expiresAt > clock() && typeof currentSHA === 'string' && /^[a-f0-9]{64}$/i.test(currentSHA)) publicationIdentity = { ...observed, sha256: currentSHA.toLowerCase() };
    if (publicationIdentity && publicationIdentity.observedAt >= publicationContext.observedAt && currentSHA.toLowerCase() !== publication.sha256.toLowerCase()) publicationRejection = { stationID: record.stationID, lineID: record.lineID, observedAt: observed.observedAt, reason: 'publicationChanged' };
  }
  const timetableTask = renewalAsset ? (async () => {
    const { sets } = selectedTimetableEntry(renewalAsset, record), responses = [];
    for (const scope of sets) {
      const url = new URL(`https://api.tfl.gov.uk/Line/${record.lineID}/Timetable/${record.stationID}`);
      if (scope.direction !== null) url.searchParams.set('direction', scope.direction);
      responses.push({ ...(await request(url, 'GET', true)), direction: scope.direction });
    }
    return responses;
  })().catch(() => null) : Promise.resolve(null);
  const rail = STATION_BOARD_LINES.get(record.lineID)?.qualifiedRailDepartureSource;
  const arrivalsURL = new URL(`https://api.tfl.gov.uk/StopPoint/${record.stationID}/Arrivals`);
  if (config.tflAppKey) arrivalsURL.searchParams.set('app_key', config.tflAppKey);
  const arrivalTask = arrivalReader
    ? arrivalReader.read(arrivalsURL, { fetchImpl, signal, clock, publicResponses,
      notBefore: previous.arrivalsNotBefore, rateLimitedUntil: previous.arrivalsRateLimitedUntil })
    : request(arrivalsURL).catch(() => ({ ok: false }));
  const railURL = rail ? activityRailDeparturesURL(record.stationID, record.lineID, config.tflAppKey) : null;
  const railTask = railURL ? (arrivalReader
    ? readRailDepartures(railURL, previous, arrivalReader, { fetchImpl, signal, clock, publicResponses })
    : request(railURL)) : Promise.resolve({ ok: false });
  const [service, station] = await Promise.all([
    request(new URL(`https://api.tfl.gov.uk/Line/${record.lineID}/Status?detail=true`), 'GET', false, true),
    request(new URL(`https://api.tfl.gov.uk/StopPoint/${record.stationID}/Disruption?getFamily=true&includeRouteBlockedStops=true&flattenResponse=true`))
  ]);
  const authority = { mode: STATION_BOARD_LINES.get(record.lineID)?.mode, stationName: (id) => validBoard(id, record.lineID) ? STATION_BOARD_STATIONS.get(id)?.stationName : null, stationLines: id => STATION_BOARD_STATIONS.get(id)?.lineIDs || [], lineMode: line => STATION_BOARD_LINES.get(line)?.mode, isRailLine: line => STATION_BOARD_LINES.get(line)?.qualifiedRailDepartureSource === true };
  const is20 = service.ok && containsServiceClosed(service.value, record.lineID);
  const serviceObservation = service.ok && (!is20 || typeof service.headers?.age === 'string' && service.headers.age.trim().length > 0) ? httpObservation(service.headers, service.completedAt, 120000, { futureSkew: is20 ? 0 : 5000 }) : null;
  const serviceProofs = service.ok ? qualifyAvailability(service.value, record, 'lineStatus', serviceObservation, service.completedAt, londonClock, authority) : [];
  const stationProofs = station.ok ? qualifyAvailability(station.value, record, 'stationDisruptions', httpObservation(station.headers, station.completedAt, 120000), station.completedAt, londonClock) : [];
  const actualRequestAt = clock();
  const admissionProofs = retainAvailability(previous, { availabilityProofs: [...serviceProofs, ...stationProofs] }, record, actualRequestAt);
  const unknown20 = is20 && !serviceProofs.some((p) => p.scheduledClockOnly === true && (p.observedAt + 600000 > actualRequestAt || p.expiresAt + 600000 > actualRequestAt));
  const blocked = unknown20 || admissionProofs.some((p) => p.scheduledClockOnly !== true && (activeClosure(p, actualRequestAt) || expiredBarrier(p, actualRequestAt) || p.plannedUnavailable === true && p.expiresAt > actualRequestAt));
  const journeyDepartAt = blocked ? actualRequestAt : shiftedJourneyTime(service.value, serviceProofs, admissionProofs, actualRequestAt);
  const plannedURL = !blocked ? journeyURL(record, journeyDepartAt, actualRequestAt) : null;
  const journeyTask = plannedURL ? request(plannedURL) : Promise.resolve({ ok: false });
  const [arrivals, departures, journey, timetableResponses] = await Promise.all([arrivalTask, railTask, journeyTask, timetableTask]);
  const completedAt = clock(), sources = {};
  const add = (source, events, observation = null) => {
    // A fresh explicit empty rail read replaces only its exact source.
    if (events.length || observation && observation.expiresAt > completedAt) sources[source] = { ...(observation ? { expiresAt: observation.expiresAt } : {}), observedAt: events.length ? Math.max(...events.map((e) => e.receivedAt)) : observation.observedAt, events };
  };
  if (arrivals.ok && arrivals.status === 200) add('station-arrivals', parseStationArrivals(arrivals.value, record, arrivals.headers, arrivals.completedAt), Array.isArray(arrivals.value) && arrivals.value.length === 0 ? stationEmptyObservation(arrivals.headers, arrivals.completedAt) : null);
  const railSource = railDepartureSource(record, departures, completedAt);
  if (railSource) sources['rail-departures'] = railSource;
  if (journey.ok) add('journey-planner', parseJourney(journey.value, record, journey.headers, journeyDepartAt, journey.completedAt, actualRequestAt));
  const retainedRail = departures.deferred ? previous.sources?.['rail-departures'] : null;
  const selected = selectEvents({ sources: retainedRail ? { ...sources, 'rail-departures': retainedRail } : sources }, record, completedAt);
  const usefulRail = selected.some((e) => e.sourceID === 'rail-departures' && e.kind === 'outgoingDeparture');
  const through = selected.some((e) => e.kind === 'throughArrival');
  const rawRows = Array.isArray(arrivals.value) ? arrivals.value.filter((row) => objectRow(row) && row.naptanId === record.stationID && row.lineId === record.lineID) : [];
  const terminalEvidence = rawRows.some((row) => row.destinationNaptanId === record.stationID || ['check front of train', 'see front of train'].includes(key(row.destinationName)) || isoClock(row.expectedArrival) <= completedAt);
  const retainedFacts = Boolean(previous.sources?.['at-station-destination']);
  if (retainedFacts || (!usefulRail && (!through || terminalEvidence))) {
    const facts = await request(new URL(`https://api.tfl.gov.uk/Line/${record.lineID}/Arrivals`));
    if (facts.ok) add('at-station-destination', parseDestinationFacts(facts.value, record, facts.headers, facts.completedAt));
  }
  // Recheck exact local revision before the final consumer clock. No request
  // clock is moved by this local read. Expected tuple/generation guards in the
  // authority store continue to protect return/cache/save/dispatch after awaits.
  if (renewalAsset) {
    try {
      const latest = await publicationAuthorityStore.readPublicationAsset(renewalAsset.identity.publicationSHA256);
      await publicationAuthorityStore.observePublicationRevision(latest.identity);
      if (['publicationSHA256','proofRevision','proofBodySHA256'].some(k => latest.identity[k] !== renewalAsset.identity[k])) renewalAsset = null;
    } catch { renewalAsset = null; }
  }
  const applicabilityAt = clock();
  const rejections = publicationRejection ? [publicationRejection] : [], availabilityProofs = [...(is20 ? serviceProofs : service.ok ? qualifyAvailability(service.value, record, 'lineStatus', serviceObservation, applicabilityAt, londonClock, authority) : []), ...(station.ok ? qualifyAvailability(station.value, record, 'stationDisruptions', httpObservation(station.headers, station.completedAt, 120000), applicabilityAt, londonClock) : [])];
  if (renewalAsset && timetableResponses) {
    const ageIsValid = response => typeof response.headers?.age === 'string' && /^[0-9]+$/.test(response.headers.age.trim());
    const strictServiceObservation = service.ok && ageIsValid(service) ? serviceObservation : null;
    const stationObservation = station.ok && ageIsValid(station) ? httpObservation(station.headers, station.completedAt, 120000) : null;
    const finalProofs = retainAvailability(previous, { availabilityProofs }, record, applicabilityAt);
    if (completePlannedApplicability({ value: service.value, observation: strictServiceObservation }, { value: station.value, observation: stationObservation }, finalProofs, record, applicabilityAt, londonClock, authority)) {
      try {
        sources.timetable = qualifyTimetable(renewalAsset, timetableResponses, record, { head: renewalHead, serviceObservation: strictServiceObservation, stationObservation, at: applicabilityAt });
      } catch (error) {
        if (['timetableChanged', 'unsupportedCalendar'].includes(error.timetableReason)) {
          const observations = timetableResponses.map(r => timetableHTTPObservation(r.headers, r.completedAt)?.observedAt).filter(Number.isFinite);
          if (observations.length === timetableResponses.length) rejections.push({ stationID: record.stationID, lineID: record.lineID, observedAt: Math.min(renewalHead.observedAt, ...observations), reason: error.timetableReason });
        }
      }
    }
  }
  const originRule = regularOriginRule(record);
  const ordinaryBoard = supportsRegularOrigin(record);
  const dated = ordinaryBoard ? datedWithdrawal(journey, record, journeyDepartAt, actualRequestAt, applicabilityAt) : null;
  const amended = ordinaryBoard && service.ok
    ? replacementFrequencyWithdrawal(service.value, record, serviceObservation, applicabilityAt, londonClock, authority) : null;
  const withdrawal = dated && amended
    ? (dated.regularWithdrawalUntil >= amended.regularWithdrawalUntil ? dated : amended) : dated || amended;
  const currentProofs = retainAvailability(previous, { availabilityProofs }, record, applicabilityAt);
  // A station-family response can describe closures on other modes and name
  // this line as a diversion. Only qualified controls for the selected board
  // can block its ordinary timetable.
  const explicitlyClosed = unknown20 && serviceObservation?.expiresAt > applicabilityAt;
  const hasDatedWithdrawal = (previous.rejections || []).some(r => r.reason === 'regularSourceWithdrawn'
    && Number.isFinite(r.regularWithdrawalUntil) && retainedRejection(r, record, applicabilityAt));
  const blockedOrdinary = Boolean(withdrawal) || hasDatedWithdrawal || explicitlyClosed
    || currentProofs.some(p => blocksScheduled(p, applicabilityAt, applicabilityAt));
  const rateLimited = [service, station, journey, arrivals].filter(response => response.status === 429);
  let ordinaryNotBefore = Math.max(previous.ordinaryNotBefore || 0, previous.arrivalsRateLimitedUntil || 0,
    arrivals.rateLimitedUntil || 0, ordinaryBoard ? (publicationAuthorityStore?.ordinaryTimetableAdmissionFloor?.(record.stationID, record.lineID) || 0) : 0,
    ...rateLimited.map(response => response.completedAt + Math.max(300000, retryAfterDelay(response.retryAfter, response.completedAt))));
  if (withdrawal) rejections.push({
    stationID: record.stationID, lineID: record.lineID, ...withdrawal, reason: 'regularSourceWithdrawn'
  });
  let needsOrdinary = false;
  if (ordinaryBoard && !blockedOrdinary && ordinaryNotBefore <= applicabilityAt) {
    const board = mergeContexts(previous, { sources, rejections, availabilityProofs, publicationIdentity }, record, applicabilityAt);
    const eligible = selectEvents(board, record, applicabilityAt);
    const upcoming = eligible.filter(e => Number.isFinite(e.time) && e.time >= applicabilityAt && e.time <= applicabilityAt + 3600000);
    // Allow the ordinary cycle to requalify before expiry even if the next
    // full cycle is skipped. London midnight ends the current service day.
    const renewBy = applicabilityAt + 2 * config.workerIntervalMs;
    const dayEnd = midnight(applicabilityAt);
    const retainedRegular = board.sources['regular-timetable']?.events.some(e =>
      e.time <= applicabilityAt + 3600000 && (e.expiresAt > renewBy || e.expiresAt === dayEnd)
      && !currentProofs.some(p => blocksScheduled(p, e.time, applicabilityAt)));
    const hasIncoming = terminalEvidence || upcoming.some(e => e.kind === 'incomingArrival');
    needsOrdinary = !retainedRegular && !upcoming.some(e => {
      if (e.sourceID === 'regular-timetable') return false;
      if (e.kind === 'throughArrival') return originRule.physicalEnd && !hasIncoming;
      if (e.kind !== 'outgoingDeparture') return false;
      // A short-lived Journey can still benefit from retained regular
      // coverage through the next admitted full-source refresh.
      return e.sourceID !== 'journey-planner'
        || e.expiresAt >= applicabilityAt + config.workerIntervalMs
        || e.expiresAt === midnight(applicabilityAt);
    });
  }
  if (needsOrdinary) {
    const url = new URL(`https://api.tfl.gov.uk/Line/${record.lineID}/Timetable/${record.stationID}`);
    const readOrdinary = async (mode) => {
      const response = await request(url, 'GET', true, false, mode);
      ordinaryNotBefore = response.completedAt + (response.status === 429
        ? Math.max(300000, retryAfterDelay(response.retryAfter, response.completedAt)) : config.workerIntervalMs);
      return response;
    };
    let direct = await readOrdinary('standard');
    let rootCompletedAt = direct.completedAt;
    let root = ordinaryReceipt(direct);
    let receipt = root;
    // The one remaining read can revalidate an expired root or resolve a
    // qualified direction menu. Neither follow-up can spend another read.
    if (root.retryable) {
      direct = await readOrdinary('revalidate');
      rootCompletedAt = direct.completedAt;
      root = receipt = ordinaryReceipt(direct);
    } else if (root.observation && !direct.value?.timetable) {
      const direction = ordinaryDirection(direct.value, record, url.pathname);
      if (direction) {
        url.searchParams.set('direction', direction);
        direct = await readOrdinary('standard');
        receipt = direct.value?.direction === direction ? ordinaryReceipt(direct) : {};
      }
    }
    if (receipt.observation && root.observation && direct.value?.timetable) {
      try {
        const calendar = validatedPublicationProof(await readPublicationAsset('788955e868b7ae85219db15b4e05c2f187bdf3be1767f16b1c369b60dea08ad7'));
        const at = clock(), day = londonLocal(at).slice(0, 10);
        const source = { ...receipt.observation,
          expiresAt: Math.min(receipt.observation.expiresAt, root.observation.expiresAt, rootCompletedAt + 600000, midnight(at)) };
        if (day >= calendar.holidayCoverageStart && day <= calendar.holidayCoverageEnd && !calendar.bankHolidayDates.includes(day)) {
          const dayRows = regularTimetableWindow(direct.value, record, originRule, calendar, at, midnight(at));
          const events = dayRows.flatMap(row => {
            const destinationStationID = row.path.at(-1);
            const hhmm = [Math.floor(row.minute / 60), row.minute % 60].map(x => String(x).padStart(2, '0')).join(':');
            const time = londonClock(row.civilDay + 'T' + hhmm + ':00');
            if (!(time >= at && time <= at + 3600000 && source.expiresAt > at)) return [];
            const bank = record.lineID === 'northern' && row.path.includes('940GZZLUBNK');
            const cross = record.lineID === 'northern' && row.path.includes('940GZZLUCHX');
            if (bank && cross) return [];
            const firstCall = row.path.find(stop => stop !== record.stationID);
            const loopVia = record.lineID === 'circle' && destinationStationID === record.stationID
              ? STATION_BOARD_STATIONS.get(firstCall)?.stationName : null;
            return [event(record, 'regular-timetable', { id: 'regular:' + hash([row.civilDay, row.key]), destinationStationID,
              destination: STATION_BOARD_STATIONS.get(destinationStationID).stationName, kind: 'outgoingDeparture',
              time, timeEvidence: 'scheduledDeparture', platform: null, direction: null, nextScheduledStopID: firstCall,
              via: bank ? 'Bank' : cross ? 'Charing Cross' : loopVia }, source)];
          });
          // Compare the qualified source independently of the rolling hour and London date.
          const signature = hash([direct.value.direction ?? null, direct.value.timetable]);
          const completeOrigin = originRule.physicalEnd && !url.searchParams.has('direction') && dayRows.length > 0;
          if (events.length || completeOrigin) {
            const context = ordinaryContext(previous.sources?.['regular-timetable'], events, source, signature, record, at);
            if (context) sources['regular-timetable'] = context;
          }
        }
      } catch { /* The next normal worker cycle can recheck; the source does not become live. */ }
    }
  }
  // An ordinary receipt can be newer than the pre-request admission clock.
  const boardAt = needsOrdinary ? clock() : applicabilityAt;
  let status = null;
  if (service.ok) {
    const observed = httpObservation(service.headers, service.completedAt, 120000);

    const details = Array.isArray(service.value) && service.value.length === 1 && service.value[0].id === record.lineID ? service.value[0].lineStatuses : null;
    if (observed && observed.expiresAt > boardAt && Array.isArray(details) && details.length && details.every((d) => objectRow(d) && Number.isInteger(d.statusSeverity))) status = { label: details[0].statusSeverityDescription || 'Status unavailable', reason: details[0].reason || null, isDisrupted: details.some((d) => d.statusSeverity !== 10), expiresAt: observed.expiresAt };
  }

  // Availability masks presentation. It never destroys the original source
  // context or creates a permanent publication-style closure rejection.
  const railReceipt = railDepartureReceipt(record, previous, departures, railSource, boardAt);
  let merged = mergeContexts(previous, { sources, rejections, availabilityProofs, publicationIdentity, status, ...railReceipt,
    nextRefreshAt: now + config.workerIntervalMs }, record, boardAt);
  if (ordinaryBoard && ordinaryNotBefore > boardAt) merged.ordinaryNotBefore = ordinaryNotBefore;
  if (arrivalReader) merged = mergeStationArrivalRead(record, merged, arrivals, boardAt, config.workerIntervalMs);
  return publicationAuthorityStore ? applyPublicationAuthority(merged, publicationAuthorityStore.publicationAuthority()) : merged;
}

// One query may move only past the connected literal restriction covering its
// actual dispatch. Persisted/partial authority never authorizes a search shift.
export function shiftedJourneyTime(raw, proofs, allProofs, actual) {
  const p = proofs.length === 1 ? proofs[0] : null;
  if (!p || p.scheduledClockOnly !== true || p.closed || p.plannedUnavailable === true || p.observedAt > actual || p.expiresAt <= actual || allProofs.some((v) => v.closed || v.plannedUnavailable === true || activeClosure(v, actual) || expiredBarrier(v, actual))) return actual;
  const periods = [];
  for (const d of raw?.[0]?.lineStatuses || []) {
    if (knownNonClosure(d)) continue;
    if (!Array.isArray(d.validityPeriods)) return actual;
    for (const w of d.validityPeriods) { const start = londonClock(w?.fromDate), end = londonClock(w?.toDate); if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return actual; periods.push({ validFrom: start, validUntil: end }); }
  }
  if (!periods.length || periods.length > 32 || periods.filter((w) => w.validUntil > actual).some((w) => !p.closureWindows.some((v) => v.validFrom === w.validFrom && v.validUntil === w.validUntil))) return actual;
  let cursor = actual;
  for (let count = 0; count <= periods.length + 1; count++) {
    const connected = periods.filter((w) => w.validFrom <= cursor && cursor < w.validUntil);
    if (!connected.length) return cursor;
    const end = Math.max(...connected.map((w) => w.validUntil));
    const civil = londonLocal(end).slice(0,16) + ':00';
    const minute = londonClock(civil);
    if (!Number.isFinite(minute)) return actual;
    cursor = minute < end ? minute + 60000 : minute;
    if (londonClock(londonLocal(cursor).slice(0,16) + ':00') !== cursor) return actual;
  }
  return actual;
}
