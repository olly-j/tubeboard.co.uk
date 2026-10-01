import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STATION_BOARD_LINES, STATION_BOARD_STATIONS, validBoard, httpObservation, londonClock, londonLocal, journeyURL, parseJourney, parseRailDepartures, parseStationArrivals, parseDestinationFacts, mergeContexts, selectEvents, countdown, nextBoundary, buildStationBoardState, refreshStationBoard } from '../server/station-board-v2.js';
import { validateTokenPayload, LiveActivityStore, loadConfig, runLiveActivityWorkerCycle, buildApnsPayload, getRolloverDelayMs, LIVE_ACTIVITY_LINES } from '../server/live-activity.js';
import { SerialWorker } from '../server/worker-lifecycle.js';
const now = Date.parse('2026-10-01T13:00:00Z');
const record = { activityID: 'synthetic-v2', installID: 'synthetic-install', stationID: '940GZZLUEGW', lineID: 'northern', selectionMode: 'allPlatforms', pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(now).toISOString(), appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.0', buildNumber: '1', environment: 'sandbox', contentStateContract: 'station-board-v2' };
const headers = (time = now, age = 0, maxAge = 150) => ({ date: new Date(time).toUTCString(), age: String(age), 'cache-control': `public,max-age=${maxAge}` });
const row = (overrides = {}) => ({ stationID: record.stationID, lineID: record.lineID, sourceID: 'journey-planner', kind: 'outgoingDeparture', id: 'planned-A', destination: 'Morden', destinationStationID: '940GZZLUMDN', time: now + 90000, timeEvidence: 'scheduledDeparture', platform: null, direction: null, providerDirection: 'Outbound', receivedAt: now, expiresAt: now + 120000, ...overrides });
const cacheOf = (...events) => ({ sources: Object.fromEntries([...new Set(events.map((e) => e.sourceID))].map((source) => [source, { observedAt: Math.max(...events.filter((e) => e.sourceID === source).map((e) => e.receivedAt)), events: events.filter((e) => e.sourceID === source) }])), rejections: [] });
const arrival = (overrides = {}) => ({ lineId: 'northern', naptanId: record.stationID, stationName: 'Edgware Underground Station', destinationName: 'Morden Underground Station', destinationNaptanId: '940GZZLUMDN', expectedArrival: new Date(now + 60000).toISOString(), timestamp: new Date(now).toISOString(), timing: { read: new Date(now).toISOString() }, direction: 'Outbound', platformName: 'Southbound - Platform 2', ...overrides });
function journey(overrides = {}, stationID = record.stationID, lineID = record.lineID) {
  return { searchCriteria: { dateTimeType: 'Departing', dateTime: '2026-10-01T14:00:00' }, recommendedMaxAgeMinutes: 5, stopMessages: [], journeys: [{ legs: [{ id: 'legA', mode: { id: STATION_BOARD_LINES.get(lineID).mode }, departurePoint: { naptanId: stationID, individualStopId: `${stationID}1` }, arrivalPoint: { naptanId: '940GZZLUMDN' }, scheduledDepartureTime: '2026-10-01T14:02:00', isDisrupted: false, disruptions: [], plannedWorks: [], routeOptions: [{ id: 'routeA', lineIdentifier: { id: lineID }, direction: 'Outbound', directions: ['Morden'] }], path: { stopPoints: [{ id: stationID }, { id: '940GZZLUMDN' }] }, ...overrides }] }] };
}
async function temporaryStore(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-v2-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const store = new LiveActivityStore(path.join(dir, 'records.json')); await store.upsertToken(record, new Date(now)); return store; }
const logger = { info() {}, warn() {}, error() {} };

test('all19 exact catalogue boards negotiate v2 while v1 allowlist remains17', () => {
  assert.equal(STATION_BOARD_LINES.size, 19); assert.equal(LIVE_ACTIVITY_LINES.size, 17);
  for (const [lineID, line] of STATION_BOARD_LINES) {
    const stationID = line.boundedOriginID;
    assert.equal(validBoard(stationID, lineID), true, lineID);
    assert.equal(validateTokenPayload({ ...record, stationID, lineID }).ok, true, lineID);
    assert.equal(validateTokenPayload({ ...record, stationID, lineID, contentStateContract: undefined }).ok, !['elizabeth', 'dlr'].includes(lineID), lineID);
    const url = journeyURL({ stationID, lineID }, now);
    assert.equal(url.searchParams.get('mode'), line.mode); assert.equal(url.searchParams.get('date'), '20261001'); assert.equal(url.searchParams.get('time'), '1400');
    const destinationID = line.branchTargetIDs.find((id) => id !== stationID && validBoard(id, lineID));
    const service = row({ stationID, lineID, destination: STATION_BOARD_STATIONS.get(destinationID).stationName, destinationStationID: destinationID });
    assert.equal(selectEvents(cacheOf(service), { stationID, lineID }, now).length, 1); assert.equal(countdown(service, now), '1 min');
    assert.equal(selectEvents(cacheOf(service), { stationID, lineID }, service.expiresAt).length, 0);
  }
  assert.equal(validateTokenPayload({ ...record, lineID: 'mildmay' }).ok, false);
  assert.equal(validateTokenPayload({ ...record, lineID: 'district,circle' }).ok, false);
  assert.equal(validateTokenPayload({ ...record, contentStateContract: 'station-board-v3' }).ok, false);
});

test('London clocks reject DST ambiguity/nonexistence and preserve calendar/midnight', () => {
  assert.equal(londonClock('2026-10-01T14:00:00'), now);
  assert.equal(Number.isNaN(londonClock('2026-10-25T01:30:00')), true);
  assert.equal(Number.isNaN(londonClock('2026-03-29T01:30:00')), true);
  assert.equal(londonClock('2026-10-25T01:30:00Z'), Date.parse('2026-10-25T01:30:00Z'));
  const changed = journey(); changed.searchCriteria.dateTime = '2026-10-02T14:00:00'; assert.deepEqual(parseJourney(changed, record, headers(), now, now), []);
  const midnightNow = londonClock('2026-10-01T23:59:30'), result = journey({ scheduledDepartureTime: '2026-10-02T00:01:00' }); result.searchCriteria.dateTime = '2026-10-01T23:59:00';
  assert.equal(parseJourney(result, record, headers(midnightNow), midnightNow, midnightNow)[0].expiresAt, londonClock('2026-10-02T00:00:00'));
});

test('HTTP Date apparent age defeats Age0 and original expiry survives delayed reads', () => {
  const obs = httpObservation(headers(now - 60000, 0), now, 120000); assert.equal(obs.observedAt, now - 60000); assert.equal(obs.expiresAt, now + 60000);
  assert.equal(httpObservation(headers(now - 180000, 0), now, 120000), null);
  assert.equal(httpObservation({ date: new Date(now).toUTCString() }, now, 120000), null);
  assert.equal(httpObservation(headers(now + 6000), now, 120000), null);
  assert.equal(httpObservation(headers(now, 120), now, 120000), null);
});

test('scheduled minute Due/zero/strict expiry never claims Here and boundaries precede limits', () => {
  const service = row({ time: now + 120000, expiresAt: now + 180000 });
  assert.equal(countdown(service, now), '2 min'); assert.equal(nextBoundary(cacheOf(service), record, now), now + 1000);
  assert.equal(countdown(service, service.time - 59000), 'Due'); assert.equal(countdown(service, service.time), 'Due'); assert.equal(countdown(service, service.time + 1), '--');
  assert.equal(selectEvents(cacheOf(service), record, service.time + 1).length, 0);
  const services = [row({ id: 'incoming', kind: 'incomingArrival', timeEvidence: 'arrivalPrediction', platform: 'Platform 1', time: now + 1000 }), row({ id: 'same-A', platform: 'Platform 2' }), row({ id: 'same-B', platform: 'Platform 2', time: now + 95000 }), row({ id: 'via', via: 'Bank', time: now + 100000 })];
  assert.deepEqual(buildStationBoardState(record, cacheOf(...services), now).arrivals.map((r) => r.id), ['same-A', 'same-B', 'via']);
  assert.equal(selectEvents(cacheOf(...services), record, now).at(-1).id, 'incoming');
});

test('selection precedes publication/planner preference and physical platforms never guess schedules', () => {
  const tt = ['Bank', 'Charing Cross', 'Morden'].map((destination, i) => row({ id: `tt-${i}`, sourceID: 'timetable', destination, providerDirection: null }));
  const planner = row({ id: 'planner' }), cache = cacheOf(...tt, planner);
  assert.equal(Object.values(cache.sources).flatMap((s) => s.events).length, 4); assert.equal(selectEvents(cache, record, now).length, 3);
  assert.deepEqual(selectEvents(cache, { ...record, selectionMode: 'platform', platformID: 'outbound', platformDirection: 'Outbound' }, now).map((e) => e.id), ['planner']);
  assert.equal(selectEvents(cache, { ...record, selectionMode: 'platform', platformID: 'platform-1', platformLabel: 'Platform 1' }, now).length, 0);
  const incoming = row({ sourceID: 'station-arrivals', id: 'qualified-east', kind: 'throughArrival', timeEvidence: 'arrivalPrediction', direction: 'Eastbound', platform: 'Platform 1' });
  const rail = row({ sourceID: 'rail-departures', id: 'rail', timeEvidence: 'predictedDeparture', platform: 'Platform 2', direction: null });
  const bare = row({ kind: 'outgoingDestinationOnly', time: null, timeEvidence: null, platform: 'Platform 2', providerDirection: 'Outbound' });
  assert.equal(selectEvents(cacheOf(bare), { ...record, selectionMode: 'platform', platformLabel: '2', platformID: '2', platformDirection: 'Outbound' }, now).length, 1);
  assert.equal(selectEvents(cacheOf(bare), { ...record, selectionMode: 'platform', platformLabel: 'Unknown', platformID: 'unknown' }, now).length, 0);
  assert.equal(selectEvents(cacheOf(bare), { ...record, selectionMode: 'platform', platformLabel: '2', platformID: '2', platformDirection: 'Inbound' }, now).length, 0);
  assert.deepEqual(selectEvents(cacheOf(incoming, rail), { ...record, selectionMode: 'platform', platformLabel: 'Platform 1', platformID: 'platform-1' }, now).map((e) => e.id), ['qualified-east']);
  assert.deepEqual(selectEvents(cacheOf(incoming, rail), { ...record, selectionMode: 'platform', platformDirection: 'Eastbound', platformID: 'eastbound' }, now).map((e) => e.id), ['qualified-east']);
});

test('individual endpoint IDs/conflicts/loops and actual selected lines preserve mixed rows', () => {
  const rows = [arrival(), arrival({ destinationNaptanId: record.stationID, destinationName: 'Edgware', platformName: 'Platform 3' }), arrival({ destinationNaptanId: record.stationID, destinationName: 'Morden' })];
  const events = parseStationArrivals(rows, record, headers(), now); assert.equal(events.length, 2); assert.deepEqual(events.map((e) => e.kind), ['throughArrival', 'incomingArrival']);
  const loop = arrival({ destinationNaptanId: record.stationID, destinationName: 'Edgware', routeStationIDs: [record.stationID, '940GZZLUMDN', record.stationID], selectedStopIndex: 0 }); assert.equal(parseStationArrivals([loop], record, headers(), now)[0].kind, 'throughArrival');
  assert.deepEqual(parseStationArrivals([arrival({ lineId: 'victoria' })], record, headers(), now), []);
  assert.equal(events[0].receivedAt, now); assert.equal(parseStationArrivals([arrival({ timestamp: new Date(now - 100000).toISOString() })], record, headers(), now)[0].expiresAt, now + 20000);
});

test('destination/platform facts use their own provider clocks and never legacy/downstream clocks', () => {
  const fact = arrival({ naptanId: '940GZZLUCND', stationName: 'Colindale', currentLocation: 'At Edgware Platform 2' });
  const parsed = parseDestinationFacts([fact], record, headers(), now); assert.equal(parsed.length, 1); assert.equal(parsed[0].platform, 'Platform 2'); assert.equal(parsed[0].time, null); assert.equal(countdown(parsed[0], now), '--');
  assert.equal(buildStationBoardState(record, cacheOf(...parsed), now).arrivals[0].timeEvidence, 'destinationOnly');
  assert.equal(parseDestinationFacts([{ ...fact, timing: undefined, timeToLive: new Date(now).toISOString() }], record, headers(), now).length, 0);
  assert.equal(parseDestinationFacts([{ ...fact, timestamp: new Date(now - 55000).toISOString() }], record, headers(), now)[0].expiresAt, now + 5000);
  assert.equal(parseDestinationFacts([fact, { ...fact, destinationNaptanId: '940GZZLUCXC', destinationName: 'Charing Cross' }], record, headers(), now).length, 0);
  assert.equal(parseDestinationFacts([fact, { ...fact, currentLocation: 'At Edgware Platform 3' }], record, headers(), now).length, 2);
});

test('planner requires explicit own origin/line/clock/clear own leg and retains routes/distinct slots', () => {
  const root = journey(), good = parseJourney(root, record, headers(), now, now); assert.equal(good.length, 1); assert.equal(good[0].platform, null); assert.equal(good[0].time, now + 120000);
  for (const change of [{ scheduledDepartureTime: undefined }, { departurePoint: { naptanId: '940GZZLUMDN' } }, { isDisrupted: true }, { plannedWorks: [{}] }, { disruptions: [{}] }, { routeOptions: [{ lineIdentifier: { id: 'central' }, directions: ['Morden'] }] }]) assert.deepEqual(parseJourney(journey(change), record, headers(), now, now), []);
  root.stopMessages = ['Unrelated interchange notice']; assert.equal(parseJourney(root, record, headers(), now, now).length, 1);
  root.journeys.push(structuredClone(root.journeys[0])); assert.equal(parseJourney(root, record, headers(), now, now).length, 1);
  root.journeys[1].legs[0].scheduledDepartureTime = '2026-10-01T14:03:00'; assert.equal(parseJourney(root, record, headers(), now, now).length, 2);
  root.journeys.push(structuredClone(root.journeys[0])); root.journeys[2].legs[0].routeOptions[0].directions = ['Morden via Bank']; assert.equal(parseJourney(root, record, headers(), now, now).length, 3);
});

test('qualified rail seven adapters preserve distinct clocks and reject ambiguous alternatives/reused IDs', () => {
  for (const [lineID, line] of STATION_BOARD_LINES) {
    if (!line.qualifiedRailDepartureSource) continue;
    const stationID = line.boundedOriginID, destinationID = line.branchTargetIDs.find((id) => id !== stationID && validBoard(id, lineID));
    const rail = { id: 'reused-id', naptanId: stationID, destinationName: STATION_BOARD_STATIONS.get(destinationID).stationName, destinationNaptanId: destinationID, departureStatus: 'OnTime', platformName: 'Platform 1', estimatedTimeOfDeparture: new Date(now + 60000).toISOString(), scheduledTimeOfDeparture: new Date(now + 30000).toISOString() };
    const board = { stationID, lineID };
    assert.equal(parseRailDepartures([rail, rail, { ...rail, estimatedTimeOfDeparture: new Date(now + 90000).toISOString() }], board, headers(), now).length, 2, lineID);
    assert.equal(parseRailDepartures([rail, { ...rail, platformName: 'Platform 2' }], board, headers(), now).length, 0, lineID);
    assert.equal(parseRailDepartures([{ ...rail, departureStatus: 'Delayed', estimatedTimeOfDeparture: undefined }], board, headers(), now).length, 0, lineID);
    assert.equal(parseRailDepartures([{ ...rail, estimatedTimeOfDeparture: undefined }], board, headers(), now)[0].timeEvidence, 'scheduledDeparture', lineID);
    assert.equal(parseRailDepartures([{ ...rail, departureStatus: 'Cancelled' }], board, headers(), now).length, 0);
    assert.equal(parseRailDepartures([{ ...rail, lineId: 'northern' }], board, headers(), now).length, 0);
    assert.equal(parseRailDepartures([{ ...rail, destinationName: 'Check front of train' }], board, headers(), now).length, 0);
    assert.equal(parseRailDepartures([{ ...rail, estimatedTimeOfDeparture: '2026-10-01T14:01:00', scheduledTimeOfDeparture: undefined }], board, headers(), now).length, 0);
  }
});

test('source merges preserve own TTL, partial context, scoped markers and newer recovery against old writers', () => {
  const tt = row({ sourceID: 'timetable' }), planner = row({ id: 'planner', receivedAt: now + 1000 }), rail = row({ sourceID: 'rail-departures', id: 'rail', timeEvidence: 'predictedDeparture' });
  let cache = mergeContexts(cacheOf(tt, rail), cacheOf(planner), record, now + 1000); assert.equal(Object.keys(cache.sources).length, 3); assert.equal(selectEvents(cache, record, now + 1000).some((e) => e.id === 'planner'), false);
  const pub = { stationID: record.stationID, lineID: record.lineID, observedAt: now + 2000, reason: 'publicationChanged' };
  cache = mergeContexts(cache, { rejections: [pub] }, record, now + 2000); assert.equal(cache.sources.timetable, undefined); assert.ok(cache.sources['journey-planner']); assert.ok(cache.sources['rail-departures']);
  cache = mergeContexts(cache, cacheOf(tt), record, now + 3000); assert.equal(cache.sources.timetable, undefined);
  const closure = { ...pub, reason: 'stationDisrupted', observedAt: now + 3000 }; cache = mergeContexts(cache, { rejections: [closure] }, record, now + 3000); assert.equal(cache.sources['journey-planner'], undefined); assert.ok(cache.sources['rail-departures']);
  cache = mergeContexts(cache, cacheOf(row({ receivedAt: now + 4000 })), record, now + 4000); assert.ok(cache.sources['journey-planner']);
  assert.equal(mergeContexts(cacheOf(tt), {}, record, now + 60000).sources.timetable.events[0].expiresAt, tt.expiresAt);
  assert.equal(mergeContexts(cacheOf(tt), {}, record, tt.expiresAt).sources.timetable, undefined);
  assert.equal(mergeContexts(cacheOf(tt), { rejections: [{ ...pub, observedAt: now + 100000 }] }, record, now).rejections.length, 0);
  assert.equal(mergeContexts(cacheOf(row({ sourceID: 'unified-timetable', receivedAt: now + 5000 })), cacheOf(tt), record, now + 5000).sources.timetable.events[0].receivedAt, now + 5000);
});

test('transactional cache and negotiated version survive restart/token renewal and older registrations', async (t) => {
  const store = await temporaryStore(t); await store.retainStationBoard(record.activityID, record.environment, cacheOf(row()), new Date(now));
  const restarted = new LiveActivityStore(store.filePath); await restarted.load(); assert.equal(restarted.state.records[0].stationBoardCache.sources['journey-planner'].events.length, 1);
  await restarted.upsertToken({ ...record, contentStateContract: undefined, tokenUpdatedAt: new Date(now + 1000).toISOString() }, new Date(now + 1000)); assert.equal(restarted.state.records[0].contentStateContract, 'station-board-v2');
  await restarted.upsertToken({ ...record, contentStateContract: undefined }, new Date(now + 2000)); assert.equal(restarted.state.records[0].tokenUpdatedAt, new Date(now + 1000).toISOString());
  const newer = row({ receivedAt: now + 3000, id: 'newer' }); await restarted.retainStationBoard(record.activityID, record.environment, cacheOf(newer), new Date(now + 3000)); await restarted.retainStationBoard(record.activityID, record.environment, cacheOf(row()), new Date(now + 4000)); assert.equal(restarted.state.records[0].stationBoardCache.sources['journey-planner'].events[0].id, 'newer');
});

test('worker cache-only minute/Due/elapsed/source-expiry updates make zero reads and restore after restart', async (t) => {
  let tick = now; const store = await temporaryStore(t), services = [row({ time: now + 90000 }), row({ id: 'B', time: now + 150000 }), row({ id: 'C', time: now + 300000 })];
  await store.retainStationBoard(record.activityID, record.environment, { ...cacheOf(...services), nextRefreshAt: now + 90000 }, new Date(now));
  let fetches = 0; const pushes = [], scheduled = [], config = loadConfig({});
  const cycle = async (activeStore = store) => runLiveActivityWorkerCycle({ store: activeStore, config, cacheOnly: true, now: new Date(tick), clock: () => tick, fetchImpl: async () => { fetches++; throw new Error('must not read'); }, pushImpl: async (_, payload) => { pushes.push(payload); return { status: 200 }; }, scheduleRolloverPush: (_, state, date, interval) => scheduled.push(getRolloverDelayMs(state, date, interval)), logger });
  await cycle(); assert.equal(pushes.at(-1).aps['content-state'].arrivals[0].countdownText, '1 min'); assert.equal(pushes.at(-1).aps['stale-date'], (now + 90000) / 1000);
  tick = now + 31000; await cycle(); assert.equal(pushes.at(-1).aps['content-state'].arrivals[0].countdownText, 'Due');
  tick = now + 90001; await cycle(); assert.equal(pushes.at(-1).aps['content-state'].arrivals[0].id, 'B');
  const restarted = new LiveActivityStore(store.filePath); tick = now + 120000; await cycle(restarted); assert.deepEqual(pushes.at(-1).aps['content-state'].arrivals, []); assert.equal(fetches, 0); assert.ok(scheduled.some((delay) => delay > 0));
  const count = pushes.length; await cycle(restarted); assert.equal(pushes.length, count);
});

test('APNs failure does not acknowledge cached transition; retry retains original source expiry', async (t) => {
  const store = await temporaryStore(t); await store.retainStationBoard(record.activityID, record.environment, cacheOf(row()), new Date(now));
  await runLiveActivityWorkerCycle({ store, config: loadConfig({}), cacheOnly: true, now: new Date(now), clock: () => now, pushImpl: async () => { throw new Error('synthetic transport failure'); }, logger });
  assert.equal(store.state.records[0].lastBoardContentDigest, undefined); assert.equal(store.state.records[0].lastSuccessAt, null); assert.equal(store.state.records[0].stationBoardCache.sources['journey-planner'].events[0].expiresAt, now + 120000);
});

test('independent source refresh survives status offline, records scoped closure, and preserves90s admission', async () => {
  let reads = 0; const fetchImpl = async (url) => { reads++; const path = new URL(url).pathname; const value = path.includes('JourneyResults') ? journey() : path.endsWith('/Disruption') ? [] : path.includes('/Line/') ? [] : [arrival()]; return new Response(JSON.stringify(value), { status: path.endsWith('/Status') ? 503 : 200, headers: headers() }); };
  const config = loadConfig({}), cache = await refreshStationBoard(record, {}, config, fetchImpl, now, null);
  assert.ok(cache.sources['journey-planner']); assert.ok(cache.sources['station-arrivals']); assert.equal(reads, 4);
  await refreshStationBoard(record, cache, config, fetchImpl, now + 60000, null); assert.equal(reads, 4);
  const closureFetch = async (url) => new Response(JSON.stringify(new URL(url).pathname.endsWith('/Disruption') ? [{ stationAtcoCode: record.stationID, type: 'StationClosure', fromDate: '2026-10-01T13:00:00Z', toDate: '2026-10-01T15:00:00Z' }] : []), { headers: headers(now + 90000) });
  const closed = await refreshStationBoard(record, cache, config, closureFetch, now + 90000, null); assert.ok(closed.sources['journey-planner']); assert.equal(closed.rejections.length, 0); assert.equal(selectEvents(closed, record, now + 90000).some((e) => e.timeEvidence === 'scheduledDeparture'), false);
});

test('SerialWorker coalesces cache-only triggers without converting them into new network admission', async () => {
  const contexts = []; let release; const worker = new SerialWorker({ run: async (_, context) => { contexts.push(context.cacheOnly); if (contexts.length === 1) await new Promise((resolve) => { release = resolve; }); } });
  const active = worker.trigger({ cacheOnly: true }); await new Promise((resolve) => setImmediate(resolve)); worker.trigger({ cacheOnly: true }); release(); await active; assert.deepEqual(contexts, [true, true]);
  const later = worker.trigger({ cacheOnly: true }); worker.trigger(); await later; assert.equal(contexts.at(-1), false); await worker.stop();
});

test('arrival platform alternatives collapse locally; same provider ID distinct clock stays separate', () => {
  const original = arrival({ id: 'reused-provider' });
  const alternatives = parseStationArrivals([original, { ...original, platformName: 'Platform 3' }], record, headers(), now);
  assert.equal(alternatives.length, 1); assert.equal(alternatives[0].platform, null); assert.equal(alternatives[0].time, now + 60000);
  assert.equal(parseStationArrivals([original, { ...original, expectedArrival: new Date(now + 120000).toISOString() }], record, headers(), now).length, 2);
  const strong = { ...original, vehicleId: '123', currentLocation: 'At Edgware Platform 2' };
  const uncertain = parseStationArrivals([strong, { ...strong, platformName: 'Platform 3', expectedArrival: new Date(now + 90000).toISOString() }], record, headers(), now);
  assert.equal(uncertain.length, 1); assert.equal(uncertain[0].time, null); assert.equal(countdown(uncertain[0], now), '--');
  assert.equal(buildStationBoardState(record, cacheOf(...uncertain), now).arrivals[0].expectedArrival, null);
});

test('compact next departure compares eligible clocks before platform groups and keeps untimed facts', () => {
  const early = row({ id: 'early-unassigned', time: now + 20000 }), late = row({ id: 'later-platform', platform: 'Platform 1', time: now + 80000 }), fact = row({ id: 'untimed', sourceID: 'at-station-destination', kind: 'outgoingDestinationOnly', time: null, timeEvidence: null, platform: 'Platform 2' });
  assert.deepEqual(buildStationBoardState(record, cacheOf(early, late, fact), now).arrivals.map((e) => e.id), ['early-unassigned', 'later-platform', 'untimed']);
  assert.equal(buildStationBoardState(record, cacheOf(early, late, fact), now).platform, 'All platforms');
});

test('malformed typed evidence fails closed; source clock never comes from legacy zero/DepartTime', () => {
  for (const invalid of [row({ sourceID: 'unknown' }), row({ kind: 'unknown' }), row({ kind: 'outgoingDeparture', timeEvidence: 'arrivalPrediction' }), row({ kind: 'outgoingDestinationOnly', timeEvidence: 'scheduledDeparture' })]) assert.equal(selectEvents(cacheOf(invalid), record, now).length, 0);
  const missing = arrival({ expectedArrival: undefined, DepartTime: new Date(now + 60000).toISOString(), SecondsTo: 0 }); assert.deepEqual(parseStationArrivals([missing], record, headers(), now), []);
  assert.equal(Number.isNaN(londonClock('2026-02-30T14:00:00Z')), true);
});

test('new destination/platform/timing replaces its original source context without train matching', () => {
  const first = row({ sourceID: 'rail-departures', id: 'same', platform: 'Platform 1' }), changed = row({ sourceID: 'rail-departures', id: 'same', destination: 'Charing Cross', platform: 'Platform 2', time: now + 180000, receivedAt: now + 1000, expiresAt: now + 91000 });
  const cache = mergeContexts(cacheOf(first), cacheOf(changed), record, now + 1000); assert.equal(cache.sources['rail-departures'].events.length, 1); assert.equal(cache.sources['rail-departures'].events[0].destination, 'Charing Cross');
  assert.equal(mergeContexts(cache, cacheOf(first), record, now + 2000).sources['rail-departures'].events[0].platform, 'Platform 2');
});

test('restarted closure watermark blocks older planned writers but not independent rail/arrival', async (t) => {
  const store = await temporaryStore(t), marker = { stationID: record.stationID, lineID: record.lineID, reason: 'stationDisrupted', observedAt: now + 1000 };
  await store.retainStationBoard(record.activityID, record.environment, { ...cacheOf(row()), rejections: [marker] }, new Date(now + 1000));
  const restarted = new LiveActivityStore(store.filePath); await restarted.retainStationBoard(record.activityID, record.environment, cacheOf(row(), row({ sourceID: 'rail-departures', id: 'rail', timeEvidence: 'predictedDeparture' })), new Date(now + 2000));
  assert.equal(restarted.state.records[0].stationBoardCache.sources['journey-planner'], undefined); assert.ok(restarted.state.records[0].stationBoardCache.sources['rail-departures']); assert.equal(restarted.state.records[0].stationBoardCache.rejections[0].reason, 'stationDisrupted');
});

test('current scoped closure prevents new planner qualification even with older original HTTP observation', async () => {
  const fetchImpl = async (url) => { const p = new URL(url).pathname, closure = p.endsWith('/Disruption'); return new Response(JSON.stringify(closure ? [{ stationAtcoCode: record.stationID, type: 'StationClosure', fromDate: '2026-10-01T12:00:00Z', toDate: '2026-10-01T15:00:00Z' }] : p.includes('JourneyResults') ? journey() : []), { headers: headers(closure ? now - 20000 : now, 0) }); };
  const cache = await refreshStationBoard(record, {}, loadConfig({}), fetchImpl, now, null);
  assert.ok(cache.sources['journey-planner']); assert.equal(cache.rejections.length, 0); assert.deepEqual(selectEvents(cache, record, now), []); assert.equal(cache.closureSources.station.observedAt, now - 20000);
});

test('wire fixture uses exact Swift typed row enum and Apple epoch without internal timer metadata', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('../contracts/fixtures/station-board-content-state-v2.json', import.meta.url)));
  const enums = { scheduled: 'scheduledDeparture', estimated: 'estimatedDeparture', untimed: 'destinationOnly', incoming: 'reportedIncomingArrival', through: 'throughArrivalPrediction' };
  for (const [name, expected] of Object.entries(enums)) { const payload = fixture[name], content = payload.aps['content-state']; assert.equal(content.contentStateContract, 'station-board-v2'); assert.equal(content.arrivals[0].timeEvidence, expected); assert.equal(content.updatedAt, (now - 978307200000) / 1000); assert.equal(content.nextBoardBoundaryAt, undefined); assert.equal(payload.aps['stale-date'], (now + 120000) / 1000); }
  assert.equal(fixture.untimed.aps['content-state'].arrivals[0].expectedArrival, null);
});

test('fractional whole-minute clocks schedule their exact ceil-based transition', () => {
  const two = row({ time: now + 119500 }); assert.equal(countdown(two, now), '2 min'); assert.equal(nextBoundary(cacheOf(two), record, now), now + 500); assert.equal(countdown(two, now + 500), '1 min');
  const one = row({ time: now + 59500 }); assert.equal(countdown(one, now), '1 min'); assert.equal(nextBoundary(cacheOf(one), record, now), now + 500); assert.equal(countdown(one, now + 500), 'Due');
});

test('planner via requires a unique actual-line station and preserves explicit case-insensitive route', () => {
  const unknown = journey(); unknown.journeys[0].legs[0].routeOptions[0].directions = ['Morden via Imaginary']; assert.deepEqual(parseJourney(unknown, record, headers(), now, now), []);
  const actual = journey(); actual.journeys[0].legs[0].routeOptions[0].directions = ['Morden VIA Bank']; assert.equal(parseJourney(actual, record, headers(), now, now)[0].via, 'Bank');
});

test('current closure with old HTTP observation withholds prior newer planner/publication; original source checks survive restart order', async () => {
  const prior = cacheOf(row({ receivedAt: now - 10000 }), row({ sourceID: 'timetable', id: 'tt', receivedAt: now - 10000 }), row({ sourceID: 'rail-departures', id: 'rail', timeEvidence: 'predictedDeparture', receivedAt: now - 10000 }));
  const fetchImpl = async (url) => { const p = new URL(url).pathname, closure = p.endsWith('/Disruption'); return new Response(JSON.stringify(closure ? [{ stationAtcoCode: record.stationID, type: 'StationClosure', fromDate: '2026-10-01T12:00:00Z', toDate: '2026-10-01T15:00:00Z' }] : p.includes('JourneyResults') ? journey() : []), { headers: headers(closure ? now - 20000 : now) }); };
  const closed = await refreshStationBoard(record, prior, loadConfig({}), fetchImpl, now, null); assert.ok(closed.sources.timetable); assert.ok(closed.sources['journey-planner']); assert.ok(closed.sources['rail-departures']); assert.deepEqual(selectEvents(closed, record, now).map((e) => e.id), ['rail']); assert.equal(closed.closureSources.station.observedAt, now - 20000);
  const oldWriter = mergeContexts(closed, prior, record, now + 1000); assert.ok(oldWriter.sources.timetable); assert.equal(selectEvents(oldWriter, record, now + 1000).some((e) => e.timeEvidence === 'scheduledDeparture'), false);
  const clear = { stationID: record.stationID, lineID: record.lineID, observedAt: now + 2000, expiresAt: now + 122000, closed: false };
  const recovered = mergeContexts(oldWriter, { ...cacheOf(row({ receivedAt: now + 2000 })), closureSources: { station: clear } }, record, now + 2000); assert.ok(recovered.sources['journey-planner']);
  const delayedClosure = mergeContexts(recovered, { closureSources: closed.closureSources }, record, now + 3000); assert.equal(delayedClosure.closureSources.station.closed, false); assert.ok(delayedClosure.sources['journey-planner']);
});

test('equal-observation closure wins over open evidence; only a newer same-scope open restores newly admitted plans', () => {
  const observedAt = now - 20000;
  const open = { stationID: record.stationID, lineID: record.lineID, observedAt, expiresAt: observedAt + 120000, closed: false };
  const closed = { ...open, closed: true, expiresAt: now + 20000 };
  const plans = cacheOf(row({ receivedAt: now - 10000 }), row({ sourceID: 'timetable', id: 'tt', receivedAt: now - 10000 }));
  const initiallyOpen = mergeContexts(plans, { closureSources: { station: open } }, record, now);
  assert.equal(selectEvents(initiallyOpen, record, now).length, 1);
  const closedAfterOpen = mergeContexts(initiallyOpen, { closureSources: { station: closed } }, record, now);
  assert.equal(closedAfterOpen.closureSources.station.closed, true);
  assert.equal(closedAfterOpen.closureSources.station.expiresAt, closed.expiresAt);
  assert.deepEqual(selectEvents(closedAfterOpen, record, now), []);
  const openAfterClosed = mergeContexts(closedAfterOpen, { ...plans, closureSources: { station: open } }, record, now);
  assert.equal(openAfterClosed.closureSources.station.closed, true);
  assert.deepEqual(selectEvents(openAfterClosed, record, now), []);
  const newerOpen = { ...open, observedAt: now + 1000, expiresAt: now + 121000 };
  const recovered = mergeContexts(openAfterClosed, { ...cacheOf(row({ receivedAt: now + 1000 })), closureSources: { station: newerOpen } }, record, now + 1000);
  assert.equal(recovered.closureSources.station.closed, false);
  assert.equal(selectEvents(recovered, record, now + 1000).length, 1);
});

test('APNs backoff retains prior original stale deadline without extra retries at cache boundaries', async (t) => {
  const store = await temporaryStore(t); await store.retainStationBoard(record.activityID, record.environment, cacheOf(row()), new Date(now)); const pushes = [];
  await runLiveActivityWorkerCycle({ store, config: loadConfig({}), cacheOnly: true, now: new Date(now), clock: () => now, pushImpl: async (_, payload) => { pushes.push(payload); return { status: 200 }; }, logger });
  await store.markBackoff(record.activityID, record.environment, 120000, 'syntheticAPNsBackoff', new Date(now + 1000));
  let reads = 0; await runLiveActivityWorkerCycle({ store, config: loadConfig({}), cacheOnly: true, now: new Date(now + 31000), clock: () => now + 31000, fetchImpl: async () => { reads++; }, pushImpl: async (_, payload) => { pushes.push(payload); }, logger });
  assert.equal(pushes.length, 1); assert.equal(reads, 0); assert.equal(pushes[0].aps['stale-date'], (now + 90000) / 1000); assert.equal(store.state.records[0].lastSuccessAt, new Date(now).toISOString());
});

function plannedSeed(at = now, serviceDay = '2026-10-01', minute = 842) {
  const publication = { url: 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip', sha256: 'a'.repeat(64), timezone: 'Europe/London', operatingStartDate: '2026-09-26', operatingEndDate: '2026-12-23', holidayCoverageStart: '2026-01-01', holidayCoverageEnd: '2026-12-31', nonOperationBankHolidays: true };
  const day = new Date(`${serviceDay}T12:00:00Z`); const weekday = day.getUTCDay() + 1; day.setUTCDate(day.getUTCDate() + Math.floor(minute / 1440));
  const within = minute % 1440, clock = londonClock(`${day.toISOString().slice(0, 10)}T${String(Math.floor(within / 60)).padStart(2, '0')}:${String(within % 60).padStart(2, '0')}:00`);
  return { schemaVersion: 1, stationID: record.stationID, lineID: record.lineID, contexts: [{ sourceID: 'timetable', observedAt: new Date(at).toISOString(), expiresAt: new Date(at + 600000).toISOString(), publication, rows: [0, 1, 2].map((i) => ({ id: `schedule:northern:${record.stationID}:${serviceDay}:0:0:${i}`, destinationID: '940GZZLUMDN', destination: 'Morden', departure: new Date(clock).toISOString(), via: i === 1 ? 'Bank' : null, routeStationIDs: i === 1 ? ['940GZZLUBNK', '940GZZLUMDN'] : ['940GZZLUMDN'], serviceDay, profileName: 'Monday - Thursday', profileSHA256: 'b'.repeat(64), weekdays: [weekday], serviceMinute: minute, isBankHoliday: false })) }] };
}

test('seed carries client-qualified TT3 original evidence; narrower independent planner cannot overwrite it', async (t) => {
  const store = await temporaryStore(t), seed = plannedSeed();
  const payload = validateTokenPayload({ ...record, plannedContextSeed: seed }, new Date(now)); assert.equal(payload.ok, true, payload.errors.join(','));
  await store.upsertToken(payload.value, new Date(now));
  const original = store.state.records[0].stationBoardCache; assert.equal(original.sources.timetable.qualificationOrigin, 'client'); assert.equal(original.sources.timetable.events.length, 3);
  const merged = mergeContexts(original, cacheOf(row({ receivedAt: now + 1000 })), record, now + 1000); assert.equal(selectEvents(merged, record, now + 1000).length, 3); assert.equal(merged.sources.timetable.events[0].receivedAt, now); assert.equal(merged.sources.timetable.events[0].expiresAt, now + 600000);
});

test('seed originating service day handles yesterday24+ hours; rejects borrowed calendar/platform/clocks', async () => {
  const midnight = londonClock('2026-10-02T00:00:30'), seed = plannedSeed(midnight, '2026-10-01', 1442);
  const valid = validateTokenPayload({ ...record, plannedContextSeed: seed }, new Date(midnight)); assert.equal(valid.ok, true, valid.errors.join(','));
  assert.equal(valid.value.plannedContextSeed.contexts[0].rows[0].serviceDay, '2026-10-01');
  for (const change of [{ serviceDay: '2026-10-02' }, { weekdays: [6] }, { serviceMinute: 2 }, { platform: 'Platform 1' }, { isBankHoliday: true }, { profileSHA256: 'unknown' }]) { const wrong = structuredClone(seed); Object.assign(wrong.contexts[0].rows[0], change); assert.equal(validateTokenPayload({ ...record, plannedContextSeed: wrong }, new Date(midnight)).ok, false); }
  const wrongVia = structuredClone(seed); wrongVia.contexts[0].rows[0].via = 'Bank'; assert.equal(validateTokenPayload({ ...record, plannedContextSeed: wrongVia }, new Date(midnight)).ok, false);
  const wrongURL = structuredClone(seed); wrongURL.contexts[0].publication.url = 'https://example.org/private'; assert.equal(validateTokenPayload({ ...record, plannedContextSeed: wrongURL }, new Date(midnight)).ok, false);
  const ambiguous = structuredClone(seed); ambiguous.contexts[0].rows[1].profileName = 'Friday'; assert.equal(validateTokenPayload({ ...record, plannedContextSeed: ambiguous }, new Date(midnight)).ok, false);
});

test('changed publication HEAD rejects carried TT before unrelated offline feeds; no original clock is renewed', async (t) => {
  const store = await temporaryStore(t); await store.upsertToken({ ...record, plannedContextSeed: plannedSeed() }, new Date(now)); const prior = store.state.records[0].stationBoardCache, requests = [];
  const fetchImpl = async (url, options) => { requests.push([url.toString(), options.method || 'GET']); if (options.method === 'HEAD') return new Response(null, { headers: { ...headers(now + 1000), 'x-amz-meta-sha256': 'c'.repeat(64) } }); throw new Error('synthetic offline'); };
  const changed = await refreshStationBoard(record, prior, loadConfig({}), fetchImpl, now + 1000, null); assert.equal(requests[0][1], 'HEAD'); assert.equal(changed.sources.timetable, undefined); assert.equal(changed.rejections[0].reason, 'publicationChanged');
  assert.equal(mergeContexts(changed, prior, record, now + 2000).sources.timetable, undefined);
  const matchingFetch = async (_, options) => options.method === 'HEAD' ? new Response(null, { headers: { ...headers(), 'x-amz-meta-sha256': 'a'.repeat(64) } }) : new Response('[]', { headers: headers() });
  const matched = await refreshStationBoard(record, prior, loadConfig({}), matchingFetch, now, null); assert.equal(matched.sources.timetable.events[0].expiresAt, now + 600000);
});

test('cached older HEAD cannot invalidate newer original client qualification; newer changed HEAD invalidates without retiming', async (t) => {
  const store = await temporaryStore(t);
  const seed = plannedSeed(); seed.contexts[0].publication.sha256 = 'd'.repeat(64);
  await store.upsertToken({ ...record, plannedContextSeed: seed }, new Date(now));
  const prior = store.state.records[0].stationBoardCache;
  const fetchHead = (observation) => async (_, options) => {
    if (options.method === 'HEAD') return new Response(null, { headers: { ...headers(observation), 'x-amz-meta-sha256': 'a'.repeat(64) } });
    throw new Error('synthetic offline');
  };
  const older = await refreshStationBoard(record, prior, loadConfig({}), fetchHead(now - 20000), now + 1000, null);
  assert.equal(older.rejections.length, 0);
  assert.equal(older.sources.timetable.observedAt, now);
  assert.equal(older.sources.timetable.events[0].expiresAt, prior.sources.timetable.events[0].expiresAt);
  const delayedWriter = mergeContexts(prior, { publicationIdentity: older.publicationIdentity }, record, now + 1000);
  assert.ok(delayedWriter.sources.timetable);
  const newer = await refreshStationBoard(record, older, loadConfig({}), fetchHead(now + 91000), now + 91000, null);
  assert.equal(newer.sources.timetable, undefined);
  assert.equal(newer.rejections[0].observedAt, now + 91000);
  assert.equal(mergeContexts(newer, prior, record, now + 92000).sources.timetable, undefined);
});

test('client seed closure evidence cannot clear newer independent server closure and never renews its source', async (t) => {
  const store = await temporaryStore(t), closed = { stationID: record.stationID, lineID: record.lineID, observedAt: now + 1000, expiresAt: now + 21000, closed: true, validFrom: now - 60000, validUntil: now + 21000, qualificationOrigin: 'server' };
  await store.retainStationBoard(record.activityID, record.environment, { closureSources: { station: closed } }, new Date(now + 1000));
  const seed = plannedSeed(); seed.closureEvidence = [{ stationID: record.stationID, lineID: record.lineID, sourceScope: 'stationDisruptions', closed: false, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString() }];
  await store.upsertToken({ ...record, tokenUpdatedAt: new Date(now + 2000).toISOString(), plannedContextSeed: seed }, new Date(now + 2000)); assert.ok(store.state.records[0].stationBoardCache.sources.timetable); assert.deepEqual(selectEvents(store.state.records[0].stationBoardCache, record, now + 2000), []); assert.equal(store.state.records[0].stationBoardCache.closureSources.station.closed, true); assert.equal(store.state.records[0].stationBoardCache.closureSources.station.expiresAt, now + 21000);
});

test('current closure expiry is capped at its actual applicable end', async () => {
  const fetchImpl = async (url) => new Response(JSON.stringify(new URL(url).pathname.endsWith('/Disruption') ? [{ stationAtcoCode: record.stationID, type: 'StationClosure', fromDate: '2026-10-01T12:00:00Z', toDate: '2026-10-01T13:00:20Z' }] : []), { headers: headers() });
  const cache = await refreshStationBoard(record, {}, loadConfig({}), fetchImpl, now, null); assert.equal(cache.closureSources.station.expiresAt, now + 20000); assert.equal(cache.closureSources.station.validUntil, now + 20000);
});

test('active scoped closure blocks all scheduled outgoing clocks including rail, preserving qualified predicted and untimed evidence', () => {
  const scheduled = row({ sourceID: 'rail-departures', id: 'scheduled-rail' }), predicted = row({ sourceID: 'rail-departures', id: 'predicted-rail', timeEvidence: 'predictedDeparture' }), facts = row({ sourceID: 'at-station-destination', kind: 'outgoingDestinationOnly', id: 'untimed', time: null, timeEvidence: null });
  const closed = { stationID: record.stationID, lineID: record.lineID, observedAt: now, expiresAt: now + 20000, closed: true, validFrom: now - 20000, validUntil: now + 20000 };
  const cache = mergeContexts(cacheOf(scheduled, predicted, facts), { closureSources: { station: closed } }, record, now); assert.deepEqual(selectEvents(cache, record, now).map((e) => e.id), ['predicted-rail', 'untimed']);
  const fresh = row({ sourceID: 'rail-departures', id: 'recovered-schedule', receivedAt: now + 21000 }); const recovered = mergeContexts(cache, cacheOf(fresh), record, now + 21000); assert.equal(recovered.sources['rail-departures'].events[0].expiresAt, now + 120000);
});

test('conditional fact admission reads terminals and renews retained facts, avoiding redundant through/rail reads', async () => {
  const config = loadConfig({}), paths = [];
  const fetchImpl = async (url) => { const path = new URL(url).pathname; paths.push(path); const value = path.includes('JourneyResults') ? journey() : path.startsWith('/StopPoint/') && path.endsWith('/Arrivals') ? [arrival({ destinationNaptanId: record.stationID, destinationName: 'Edgware' })] : []; return new Response(JSON.stringify(value), { headers: headers() }); };
  await refreshStationBoard(record, {}, config, fetchImpl, now, null); assert.ok(paths.includes('/Line/northern/Arrivals'));
  const elizabeth = { ...record, stationID: '910GSHENFLD', lineID: 'elizabeth' }, railPaths = [];
  const railFetch = async (url) => { const path = new URL(url).pathname; railPaths.push(path); const value = path.endsWith('/ArrivalDepartures') ? [
    { naptanId: elizabeth.stationID, destinationName: 'Liverpool Street', destinationNaptanId: '910GLIVSTLL', departureStatus: 'OnTime', estimatedTimeOfDeparture: new Date(now + 60000).toISOString(), platformName: '2' },
    { naptanId: elizabeth.stationID, destinationName: 'Liverpool Street', destinationNaptanId: '910GLIVSTLL', departureStatus: 'OnTime', scheduledTimeOfDeparture: new Date(now + 120000).toISOString(), platformName: '2' }
  ] : []; return new Response(JSON.stringify(value), { headers: headers() }); };
  const rail = await refreshStationBoard(elizabeth, {}, config, railFetch, now, null); assert.equal(rail.sources['rail-departures'].events.length, 2); assert.equal(railPaths.includes('/Line/elizabeth/Arrivals'), false);
  railPaths.length = 0; await refreshStationBoard(elizabeth, { sources: { 'at-station-destination': { observedAt: now - 30000, events: [] } } }, config, railFetch, now, null); assert.equal(railPaths.includes('/Line/elizabeth/Arrivals'), true);
});

test('bounded planner seed retains exact alighting prefix while publication route/via must agree fully', () => {
  const seed = { schemaVersion: 1, stationID: record.stationID, lineID: record.lineID, contexts: [{ sourceID: 'journey-planner', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString(), sourceSHA256: 'c'.repeat(64), rows: [{ id: 'journey:bounded-prefix', destinationID: '940GZZLUMDN', destination: 'Morden', via: 'Bank', departure: new Date(now + 90000).toISOString(), routeStationIDs: [record.stationID, '940GZZLUEUS'] }] }] };
  assert.equal(validateTokenPayload({ ...record, plannedContextSeed: seed }, new Date(now)).ok, true);
  const wrong = plannedSeed(); wrong.contexts[0].rows[0].routeStationIDs = ['940GZZLUBNK', '940GZZLUMDN']; assert.equal(validateTokenPayload({ ...record, plannedContextSeed: wrong }, new Date(now)).ok, false);
});
