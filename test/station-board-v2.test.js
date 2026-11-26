import crypto from "node:crypto";
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STATION_BOARD_LINES, STATION_BOARD_STATIONS, validBoard, httpObservation, stationArrivalObservation, StationArrivalReader, refreshStationArrivals, londonClock, londonLocal, journeyURL, parseJourney, parseRailDepartures, parseStationArrivals, parseDestinationFacts, mergeContexts, selectEvents, countdown, nextBoundary, buildStationBoardState, refreshStationBoard } from '../server/station-board-v2.js';
import { pushLiveActivityUpdate, stationBoardContentDigest, validateTokenPayload, LiveActivityStore, loadConfig, runLiveActivityWorkerCycle, buildApnsPayload, getRolloverDelayMs, getLiveSourceRefreshDelayMs, LIVE_ACTIVITY_LINES } from '../server/live-activity.js';
import { SerialWorker } from '../server/worker-lifecycle.js';
const now = Date.parse('2026-10-01T13:00:00Z');
const record = { activityID: 'synthetic-v2', installID: 'synthetic-install', stationID: '940GZZLUEGW', lineID: 'northern', selectionMode: 'allPlatforms', pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(now).toISOString(), appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.0', buildNumber: '1', environment: 'sandbox', contentStateContract: 'station-board-v2', plannedPresentationVersion: 2 };
const headers = (time = now, age = 0, maxAge = 150) => ({ date: new Date(time).toUTCString(), age: String(age), 'cache-control': `public,max-age=${maxAge}` });
const row = (overrides = {}) => ({ stationID: record.stationID, lineID: record.lineID, sourceID: 'journey-planner', kind: 'outgoingDeparture', id: 'planned-A', destination: 'Morden', destinationStationID: '940GZZLUMDN', time: now + 90000, timeEvidence: 'scheduledDeparture', platform: null, direction: null, providerDirection: 'Outbound', receivedAt: now, expiresAt: now + 120000, ...overrides });
const cacheOf = (...events) => ({ sources: Object.fromEntries([...new Set(events.map((e) => e.sourceID))].map((source) => [source, { observedAt: Math.max(...events.filter((e) => e.sourceID === source).map((e) => e.receivedAt)), events: events.filter((e) => e.sourceID === source) }])), rejections: [] });
const arrival = (overrides = {}) => ({ lineId: 'northern', naptanId: record.stationID, stationName: 'Edgware Underground Station', destinationName: 'Morden Underground Station', destinationNaptanId: '940GZZLUMDN', expectedArrival: new Date(now + 60000).toISOString(), timestamp: new Date(now).toISOString(), timing: { read: new Date(now).toISOString() }, direction: 'Outbound', platformName: 'Southbound - Platform 2', ...overrides });
function journey(overrides = {}, stationID = record.stationID, lineID = record.lineID) {
  return { searchCriteria: { dateTimeType: 'Departing', dateTime: '2026-10-01T14:00:00' }, recommendedMaxAgeMinutes: 5, stopMessages: [], journeys: [{ legs: [{ id: 'legA', mode: { id: STATION_BOARD_LINES.get(lineID).mode }, departurePoint: { naptanId: stationID, individualStopId: `${stationID}1` }, arrivalPoint: { naptanId: '940GZZLUMDN' }, scheduledDepartureTime: '2026-10-01T14:02:00', isDisrupted: false, disruptions: [], plannedWorks: [], routeOptions: [{ id: 'routeA', lineIdentifier: { id: lineID }, direction: 'Outbound', directions: ['Morden'] }], path: { stopPoints: [{ id: stationID }, { id: '940GZZLUMDN' }] }, ...overrides }] }] };
}
async function temporaryStore(t, registration = record, registeredAt = now) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-v2-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const store = new LiveActivityStore(path.join(dir, 'records.json')); await store.upsertToken(registration, new Date(registeredAt)); return store; }
const logger = { info() {}, warn() {}, error() {} };

test('all19 exact catalogue boards negotiate v2 while v1 allowlist remains17', () => {
  assert.equal(STATION_BOARD_LINES.size, 19); assert.equal(LIVE_ACTIVITY_LINES.size, 17);
  for (const [lineID, line] of STATION_BOARD_LINES) {
    const stationID = line.boundedOriginID;
    assert.equal(validBoard(stationID, lineID), true, lineID);
    assert.equal(validateTokenPayload({ ...record, stationID, lineID }).ok, true, lineID);
    assert.equal(validateTokenPayload({ ...record, stationID, lineID, contentStateContract: undefined, plannedPresentationVersion: undefined }).ok, !['elizabeth', 'dlr'].includes(lineID), lineID);
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

test('an Edgware update keeps booked departures and complete availability ahead of clockless incoming rows', async (t) => {
  const at = Date.parse('2026-11-21T23:30:00Z');
  const scoped = { ...record, supportsRegularTimetable: true, tokenUpdatedAt: new Date(at).toISOString() };
  const fixtureID = (source, i) => `${source}:${crypto.createHash('sha256').update(String(i)).digest('hex')}`;
  const regular = [2, 7, 11, 16, 21, 27].map((minutes, i) => row({
    id: fixtureID('regular', i), sourceID: 'regular-timetable', time: at + minutes * 60000,
    via: i % 2 ? 'Bank' : 'Charing Cross', direction: 'southbound', receivedAt: at - 45000, expiresAt: at + 540000,
  }));
  const dated = row({ id: fixtureID('journey', 0), destination: 'Kennington', destinationStationID: '940GZZLUKNG',
    time: at + 660000, via: 'Charing Cross', receivedAt: at - 20000, expiresAt: at + 100000 });
  const incoming = parseStationArrivals([0, 1, 2].flatMap(i => [2, 3].map(platform => arrival({
    id: `service-${i}`, vehicleId: String(i + 1), destinationNaptanId: scoped.stationID, destinationName: 'Edgware',
    currentLocation: 'Approaching Edgware', platformName: `Northbound - Platform ${platform}`,
    expectedArrival: new Date(at + (i + platform) * 1000).toISOString(), timestamp: new Date(at).toISOString(),
    timing: { read: new Date(at).toISOString() },
  }))), scoped, headers(at), at);
  assert.equal(incoming.length, 3);
  assert.ok(incoming.every(event => event.kind === 'incomingArrival' && event.time === null));
  const availabilityProofs = [0, 1].map(i => ({
    stationID: scoped.stationID, lineID: scoped.lineID, sourceScope: 'lineStatus', closed: false,
    observedAt: at - 10000, expiresAt: at + 90000, scheduledClockOnly: true,
    closureWindows: [{ validFrom: at + (450 + i * 10) * 1000, validUntil: at + (455 + i * 10) * 1000 }],
  }));
  const cache = { ...cacheOf(...regular, dated, ...incoming), availabilityProofs };
  const plansOnly = buildStationBoardState(scoped, { ...cacheOf(...regular, dated), availabilityProofs }, at);
  const state = buildStationBoardState(scoped, cache, at);
  assert.deepEqual(state.arrivals.filter(r => r.plannedSourceID), plansOnly.arrivals);
  assert.equal(plansOnly.arrivals.length, 4);
  assert.ok(state.arrivals.length < 7, 'this fixture must exercise overflow with ordinary production-sized rows');
  assert.deepEqual(state.plannedAvailability, plansOnly.plannedAvailability);
  assert.ok(state.arrivals.some(r => r.originQualified === true && r.boardingContext.via === 'Bank'));
  assert.ok(state.arrivals.some(r => r.originQualified === true && r.boardingContext.via === 'Charing Cross'));
  assert.equal(state.staleAt, plansOnly.staleAt);
  assert.equal(state.nextBoardBoundaryAt, nextBoundary(cache, scoped, at));
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 3500);
  assert.ok(Buffer.byteLength(JSON.stringify(buildApnsPayload(state, new Date(at)))) <= 4096);
  const recovered = buildStationBoardState(scoped, cache, regular[0].time + 1);
  assert.ok(!recovered.arrivals.some(r => r.id === regular[0].id || r.id === dated.id));
  assert.ok(recovered.arrivals.some(r => r.id === regular[1].id));

  const store = await temporaryStore(t, scoped, at);
  await store.retainStationBoard(scoped.activityID, scoped.environment, cache, new Date(at));
  let reads = 0;
  const pushes = [];
  const cycle = (tick) => runLiveActivityWorkerCycle({ store, config: loadConfig({}), cacheOnly: true,
    now: new Date(tick), clock: () => tick, logger,
    fetchImpl: async () => { reads++; throw Error('Cache-only rollover used the provider'); },
    pushImpl: async (_, payload) => { pushes.push(payload); return { status: 200 }; },
  });
  await cycle(at);
  await cycle(regular[0].time + 1);
  assert.deepEqual(pushes[0], buildApnsPayload(state, new Date(at)));
  assert.deepEqual(pushes[1], buildApnsPayload(recovered, new Date(regular[0].time + 1)));
  assert.equal(reads, 0);
});

test('the payload budget keeps complete outgoing contexts and never promotes a suppressed schedule', () => {
  const at = Date.parse('2026-11-21T23:30:00Z');
  const scoped = { ...record, supportsRegularTimetable: true };
  const bank = { via: 'Bank', receivedAt: at - 30000, expiresAt: at + 180000 };
  const timetable = row({ ...bank, sourceID: 'timetable', id: 'published', time: at + 90000, expiresAt: at + 60000 });
  const journey = row({ ...bank, id: 'alternate', time: at + 110000 });
  const prediction = row({ ...bank, sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction',
    id: 'live', time: at + 95000 });
  const incoming = row({ ...bank, sourceID: 'station-arrivals', kind: 'incomingArrival', timeEvidence: 'arrivalPrediction',
    id: 'incoming', time: at + 30000, destination: 'Edgware', destinationStationID: scoped.stationID });

  for (const higherEvidence of [timetable, prediction]) {
    const oversized = { ...higherEvidence, id: `${higherEvidence.id}-${'x'.repeat(4000)}` };
    const state = buildStationBoardState(scoped, cacheOf(oversized, journey, incoming), at);
    assert.deepEqual(state.arrivals.map(r => r.id), [incoming.id]);
    assert.ok(Buffer.byteLength(JSON.stringify(buildApnsPayload(state, new Date(at)))) <= 4096);
  }

  const cached = cacheOf(timetable, journey, { ...incoming, id: 'x'.repeat(4000) });
  const packed = buildStationBoardState(scoped, cached, at);
  assert.deepEqual(packed.arrivals.map(r => r.id), [timetable.id, journey.id]);
  const afterExpiry = buildStationBoardState(scoped, cached, timetable.expiresAt);
  assert.deepEqual(afterExpiry.arrivals.map(r => r.id), [journey.id]);
  assert.equal(afterExpiry.arrivals[0].expiresAt, packed.arrivals[1].expiresAt);
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
  const parsed = parseDestinationFacts([fact], record, headers(), now); assert.equal(parsed.length, 1); assert.equal(parsed[0].platform, 'Platform 2'); assert.equal(parsed[0].time, null); assert.equal(countdown(parsed[0], now), 'TBC');
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
  assert.equal(pushes.at(-1).aps['content-state'].updatedAt, (now - 978307200000) / 1000);
  assert.equal(pushes.at(-1).aps.timestamp, Math.floor(tick / 1000));
  const restarted = new LiveActivityStore(store.filePath); tick = now + 120000; await cycle(restarted); assert.deepEqual(pushes.at(-1).aps['content-state'].arrivals, []); assert.equal(fetches, 0); assert.ok(scheduled.some((delay) => delay > 0));
  const count = pushes.length; await cycle(restarted); assert.equal(pushes.length, count);
});

test('a send crossing an incoming train boundary schedules immediate cache-only turnover', async (t) => {
  const store = await temporaryStore(t);
  const incoming = row({ id: 'incoming', sourceID: 'station-arrivals', kind: 'incomingArrival',
    timeEvidence: 'arrivalPrediction', time: now + 5_000 });
  const departure = row({ id: 'departure', time: now + 75_000 });
  await store.retainStationBoard(record.activityID, record.environment, cacheOf(departure, incoming), new Date(now));
  let tick = now;
  let reads = 0;
  const pushes = [];
  const schedules = [];
  const cycle = () => runLiveActivityWorkerCycle({
    store, config: loadConfig({}), cacheOnly: true, now: new Date(tick), clock: () => tick, logger,
    fetchImpl: async () => { reads++; throw new Error('boundary ran a source read'); },
    pushImpl: async (_, payload, _config, { priority }) => {
      pushes.push({ payload, priority });
      if (pushes.length === 1) tick = incoming.time + 5;
    },
    scheduleRolloverPush: (_, state, current, interval) => schedules.push(getRolloverDelayMs(state, current, interval)),
  });
  const rowsOf = push => push.payload.aps['content-state'].arrivals;

  await cycle();
  assert.deepEqual(rowsOf(pushes[0]).map(row => row.id), ['departure', 'incoming']);
  assert.equal(schedules[0], 1, 'The rollover remains armed when the APNs send crosses its deadline');
  tick += schedules[0];
  await cycle();
  assert.deepEqual(rowsOf(pushes[1]), [rowsOf(pushes[0])[0]], 'The useful scheduled train keeps its source and original clock');
  assert.equal(pushes[1].priority, '10', 'The incoming row has elapsed even though the primary train stays upcoming');
  assert.equal(pushes[1].payload.aps['content-state'].updatedAt, pushes[0].payload.aps['content-state'].updatedAt);
  assert.ok(schedules[1] > 1, 'After catching up, the worker waits for the next real boundary');
  assert.equal(reads, 0);
});

test('selected board observation survives rollover and advances only with new selected evidence', () => {
  const scoped = { ...record, selectionMode: 'platform', platformLabel: 'Platform 2' };
  const first = row({ id: 'first', platform: 'Platform 2', time: now + 90_000 });
  const later = row({ id: 'later', platform: 'Platform 2', time: now + 150_000 });
  const offBoard = row({ id: 'off-board', platform: 'Platform 1', receivedAt: now + 60_000 });
  const at = now + 90_001;
  const build = (events) => buildApnsPayload(buildStationBoardState(scoped, cacheOf(...events), at), new Date(at));
  const rollover = build([first, later, offBoard]).aps;
  const swift = (msec) => (msec - 978307200000) / 1000;
  assert.equal(rollover.timestamp, Math.floor(at / 1000));
  assert.deepEqual(rollover['content-state'].arrivals.map((row) => row.id), ['later']);
  assert.equal(rollover['content-state'].updatedAt, swift(now));
  assert.equal(rollover['content-state'].arrivals[0].expiresAt, swift(later.expiresAt));
  const replacement = build([{ ...later, receivedAt: now + 70_000 }, offBoard]).aps;
  assert.equal(replacement['content-state'].updatedAt, swift(now + 70_000));
  assert.equal(replacement['content-state'].arrivals[0].expiresAt, swift(later.expiresAt));
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
  assert.deepEqual(buildStationBoardState(record, cacheOf(early, late, fact), now).arrivals.map((e) => e.id), ['untimed', 'early-unassigned', 'later-platform']);
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
  assert.equal(cache.sources['journey-planner'], undefined); assert.equal(cache.rejections.length, 0); assert.deepEqual(selectEvents(cache, record, now), []); assert.equal(cache.closureSources.station.observedAt, now - 20000);
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

test('UF276 timestamped arrivals retain original 41.52 seconds beyond HTTP cache max-age', () => {
  // Reconstructed sanitized clock counterexample, not replay of the private nine-row body.
  const receipt = Date.parse('2026-10-19T11:02:23.285Z');
  const timestamp = Date.parse('2026-10-19T11:01:04.805Z');
  const http = { date: 'Mon, 19 Oct 2026 11:02:23 GMT', age: '51', 'cache-control': 'public,max-age=30' };
  const events = parseStationArrivals([arrival({ timestamp: new Date(timestamp).toISOString(), expectedArrival: new Date(receipt + 60000).toISOString() })], record, http, receipt);
  assert.equal(httpObservation(http, receipt, 120000), null, 'generic HTTP cache authority remains strict');
  assert.equal(events.length, 1);
  assert.equal(events[0].receivedAt, timestamp);
  assert.equal(events[0].expiresAt - receipt, 41520);
});

test('UF276 timestamped source rejects old or invalid clocks while other HTTP authority stays strict', () => {
  const at = Date.parse('2026-10-19T11:02:23.285Z');
  const fresh = { date: new Date(at).toUTCString(), age: '51', 'cache-control': 'public,max-age=30' };
  for (const h of [{ ...fresh, age: undefined }, { ...fresh, age: '' }, { ...fresh, age: '-1' }, { ...fresh, age: '61' }, { ...fresh, age: 'NaN' }, { ...fresh, date: '' }, { ...fresh, date: new Date(at + 6000).toUTCString() }]) {
    assert.equal(stationArrivalObservation(h, at), null);
  }
  const qualified = { ...fresh, age: '0' };
  for (const offset of [-120000, 6000]) assert.deepEqual(parseStationArrivals([arrival({ timestamp: new Date(at + offset).toISOString(), expectedArrival: new Date(at + 60000).toISOString() })], record, qualified, at), []);
  assert.deepEqual(parseStationArrivals([arrival({ timestamp: null, expectedArrival: new Date(at + 60000).toISOString() })], record, qualified, at), []);
  for (const control of ['public,max-age=0', 'no-cache,max-age=30', 'must-revalidate,max-age=30', 'no-store,max-age=30']) {
    assert.ok(stationArrivalObservation({ ...fresh, 'cache-control': control }, at));
    assert.equal(httpObservation({ ...fresh, 'cache-control': control }, at, 120000), null);
  }
});

test('UF276 timestamped station qualification preserves roles and exact selection on all19 lines', () => {
  assert.equal(STATION_BOARD_LINES.size, 19);
  for (const [lineID, line] of STATION_BOARD_LINES) {
    const origin = STATION_BOARD_STATIONS.get(line.boundedOriginID);
    const destination = [...STATION_BOARD_STATIONS.values()].find(s => s.stationID !== origin.stationID && s.lineIDs.includes(lineID));
    assert.ok(destination, lineID);
    const board = { ...record, stationID: origin.stationID, lineID, selectionMode: 'platform', platformID: 'eastbound-platform-2', platformHeading: 'Eastbound - Platform 2' };
    const original = now - 78000;
    const raw = { ...arrival(), naptanId: origin.stationID, lineId: lineID, destinationNaptanId: destination.stationID, destinationName: destination.stationName, platformName: 'Eastbound - Platform 2', timestamp: new Date(original).toISOString(), expectedArrival: new Date(now + 60000).toISOString() };
    const events = parseStationArrivals([raw], board, headers(now, 51, 30), now);
    assert.equal(events.length, 1, lineID); assert.equal(events[0].kind, 'throughArrival', lineID);
    assert.equal(events[0].receivedAt, original); assert.equal(events[0].expiresAt, original + 120000);
    const cache = { sources: { 'station-arrivals': { observedAt: original, events } } };
    assert.equal(selectEvents(cache, board, now).length, 1, lineID);
    assert.equal(selectEvents(cache, { ...board, platformID: 'westbound-platform-1', platformHeading: 'Westbound - Platform 1' }, now).length, 0, lineID);
    assert.equal(parseStationArrivals([{ ...raw, naptanId: destination.stationID }], board, headers(), now).length, 0, lineID);
  }
});

test('UF276 durable retention shortens a source deadline without undoing its admission floor', async (t) => {
  const store = await temporaryStore(t);
  const old = { ...cacheOf(row({ sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction', expiresAt: now + 120000 })), arrivalsNotBefore: now + 30000, arrivalsRefreshAt: now + 90000 };
  await store.retainStationBoard(record.activityID, record.environment, old, new Date(now));
  const shorter = { ...cacheOf(row({ sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction', receivedAt: now + 1000, expiresAt: now + 60000 })), arrivalsNotBefore: now + 30000, arrivalsRefreshAt: now + 45000 };
  const retained = await store.retainStationBoard(record.activityID, record.environment, shorter, new Date(now + 1000));
  assert.equal(retained.arrivalsRefreshAt, now + 45000);
  assert.equal(retained.arrivalsNotBefore, now + 30000);
  const loaded = new LiveActivityStore(store.filePath); await loaded.load();
  assert.equal(loaded.state.records[0].stationBoardCache.arrivalsRefreshAt, now + 45000);
  assert.equal(getLiveSourceRefreshDelayMs(retained, new Date(now + 1000)), 44000);
});

test('UF276 station complete-empty uses strict HTTP authority and failure cannot clear a live source', async (t) => {
  const store = await temporaryStore(t); const reader = new StationArrivalReader(); let at = now;
  let value = [arrival({ timestamp: new Date(now).toISOString(), expectedArrival: new Date(now + 300000).toISOString() })];
  let age = 0, status = 200;
  const fetchImpl = async () => new Response(JSON.stringify(value), { status, headers: headers(at, age, 30) });
  let cache = await refreshStationArrivals(record, {}, loadConfig({}), fetchImpl, at, null, () => at, new Map(), reader);
  assert.equal(cache.sources['station-arrivals'].events.length, 1);
  const originalExpiry = cache.sources['station-arrivals'].events[0].expiresAt;
  at += 30000; value = []; age = 51;
  cache = await refreshStationArrivals(record, { ...cache, arrivalsRefreshAt: at }, loadConfig({}), fetchImpl, at, null, () => at, new Map(), reader);
  assert.equal(cache.sources['station-arrivals'].events.length, 1, 'HTTP-stale clockless empty is not a tombstone');
  assert.equal(cache.sources['station-arrivals'].events[0].expiresAt, originalExpiry);
  at += 30000; age = 0;
  cache = await refreshStationArrivals(record, { ...cache, arrivalsRefreshAt: at }, loadConfig({}), fetchImpl, at, null, () => at, new Map(), reader);
  await store.retainStationBoard(record.activityID, record.environment, cache, new Date(at));
  assert.deepEqual(store.state.records[0].stationBoardCache.sources['station-arrivals'].events, []);
  assert.equal(cache.sources['station-arrivals'].expiresAt, at + 30000, 'empty retains generic30s deadline');
  const emptyObservedAt = cache.sources['station-arrivals'].observedAt;
  at += 15000; status = 503;
  // A distinct reader models a restarted process; persisted admission still blocks early HTTP.
  let calls = 0;
  const blocked = await refreshStationArrivals(record, { ...cache, arrivalsRefreshAt: at }, loadConfig({}), async (...args) => { calls++; return fetchImpl(...args); }, at, null, () => at, new Map(), new StationArrivalReader());
  assert.equal(calls, 0); assert.equal(blocked.sources['station-arrivals'].observedAt, emptyObservedAt);
});

test('active typed boards share minute reads and publish newer qualified observations of the same train', async (t) => {
  const store = await temporaryStore(t);
  const second = { ...record, activityID: 'minute-second', installID: 'minute-second-install' };
  await store.upsertToken(second, new Date(now));
  const config = loadConfig({});
  const reads = [], supplemental = [], pushes = [];
  let at = now, observedAt = now;
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path.startsWith('/StopPoint/') && path.endsWith('/Arrivals')) {
      reads.push(at);
      return new Response(JSON.stringify([arrival({
        id: 'same-train', timestamp: new Date(observedAt).toISOString(),
        expectedArrival: new Date(now + 300000).toISOString(),
      })]), { headers: headers(at) });
    }
    supplemental.push(path);
    return new Response(JSON.stringify([]), { headers: headers(at) });
  };
  const cycle = (options = {}) => runLiveActivityWorkerCycle({ store, config, now: new Date(at),
    clock: () => at, fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload); }, logger, ...options });

  await cycle();
  const initial = pushes[0].aps['content-state'];
  assert.ok(initial.arrivals.length);
  assert.equal(pushes.length, 2);
  const supplementalCount = supplemental.length;
  for (const registration of store.state.records) {
    assert.equal(getLiveSourceRefreshDelayMs(registration.stationBoardCache, new Date(now)), 60000);
  }

  at = now + 59999;
  await cycle({ sourceOnly: true });
  assert.deepEqual(reads, [now]);

  at = observedAt = now + 60000;
  await cycle(); // A coalesced full trigger must still read when supplemental sources are not due.
  assert.deepEqual(reads, [now, at]);
  assert.equal(supplemental.length, supplementalCount);
  assert.equal(pushes.length, 4);
  const renewed = pushes[2].aps['content-state'];
  assert.equal(renewed.arrivals[0].expectedArrival, initial.arrivals[0].expectedArrival);
  assert.equal(renewed.updatedAt - initial.updatedAt, 60);
  assert.equal(renewed.arrivals[0].expiresAt - initial.arrivals[0].expiresAt, 60);

  at = now + 120000;
  await cycle({ sourceOnly: true });
  assert.deepEqual(reads, [now, now + 60000, at]);
  assert.equal(pushes.length, 4, 'a repeated provider timestamp cannot renew the board');

  for (const registration of [record, second]) {
    await store.deactivate(registration.activityID, registration.environment, 'synthetic-stop', new Date(at));
  }
  at = now + 180000;
  await cycle({ sourceOnly: true });
  assert.equal(reads.length, 3, 'inactive registrations admit no source work');
});

test('a rider joining just before a station refresh shares the new observation with an earlier rider', async t => {
  const store = await temporaryStore(t);
  let at = now;
  const reads = [], recipients = [];
  const fetchImpl = async url => {
    let rows = [];
    if (new URL(url).pathname.endsWith('/Arrivals') && new URL(url).pathname.startsWith('/StopPoint/')) {
      reads.push(at);
      rows = [arrival({ timestamp: new Date(at).toISOString(), expectedArrival: new Date(now + 300000).toISOString() })];
    }
    return new Response(JSON.stringify(rows), { headers: headers(at) });
  };
  const cycle = () => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at),
    clock: () => at, fetchImpl, pushImpl: async r => { recipients.push(r.activityID); }, logger });
  await cycle();
  at += 59000;
  await store.upsertToken({ ...record, activityID: 'late-rider', installID: 'new-install' }, new Date(at));
  await cycle();
  assert.deepEqual(reads, [now, at]);
  assert.deepEqual(recipients, [record.activityID, record.activityID, 'late-rider']);
  assert.ok(store.state.records.every(r => r.stationBoardCache.sources['station-arrivals'].observedAt === at));
});

test('a newer retained observation can renew the clock with an unchanged content digest', async (t) => {
  const store = await temporaryStore(t);
  const event = row({ sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction',
    time: now + 240000, expiresAt: now + 150000 });
  const pushes = [];
  const cycle = at => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at,
    cacheOnly: true, fetchImpl: async () => assert.fail('cache boundary must not read the network'),
    pushImpl: async (_, payload) => { pushes.push(payload.aps['content-state']); }, logger });

  await store.retainStationBoard(record.activityID, record.environment, cacheOf(event), new Date(now));
  await cycle(now);
  const digest = store.state.records[0].lastBoardContentDigest;
  assert.equal(pushes.length, 1);

  const later = now + 60000;
  await store.retainStationBoard(record.activityID, record.environment, cacheOf({ ...event, receivedAt: later }), new Date(later));
  await cycle(later);
  assert.equal(store.state.records[0].lastBoardContentDigest, digest);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].updatedAt - pushes[0].updatedAt, 60);
  await cycle(later + 1000);
  assert.equal(pushes.length, 2);
});

test('provider-wide failures prevent an early empty push while the last live ETA is future', async (t) => {
  for (const failure of [429, 503, 'timeout']) {
    const store = await temporaryStore(t);
    let at = now, outcome = 'live';
    const pushes = [], boundaries = [];
    const fetchImpl = async url => {
      if (outcome === 'timeout') throw new DOMException('Synthetic source deadline', 'TimeoutError');
      if (Number.isInteger(outcome)) return new Response(null, { status: outcome });
      const path = new URL(url).pathname;
      const arrivals = outcome === 'live' && path.startsWith('/StopPoint/') && path.endsWith('/Arrivals')
        ? [arrival({ expectedArrival: new Date(now + (failure === 429 ? 600000 : 300000)).toISOString() })] : [];
      return new Response(JSON.stringify(arrivals), { headers: headers(at) });
    };
    const cycle = options => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at,
      fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload.aps); }, logger,
      scheduleRolloverPush: (_, state) => boundaries.push(state.nextBoardBoundaryAt), ...options });

    await cycle();
    const initial = pushes[0]['content-state'];
    assert.ok(initial.arrivals.length, String(failure));
    at = now + 90000;
    outcome = failure;
    await cycle();
    assert.equal(pushes.length, 1, String(failure));
    assert.equal(store.state.records[0].stationBoardCache.sources['station-arrivals'].observedAt, now);

    at = now + 120000;
    await cycle({ cacheOnly: true });
    assert.equal(pushes.length, 1, 'expired source evidence is never republished or replaced by a waiting payload');
    assert.equal(pushes[0]['stale-date'], (now + 120000) / 1000);
    assert.equal(store.state.records[0].stationBoardCache.sources['station-arrivals'], undefined);
    assert.equal(boundaries.at(-1), now + (failure === 429 ? 300000 : 300001));

    if (failure !== 429) {
      at = now + 300001;
      await cycle({ cacheOnly: true });
      assert.equal(pushes.length, 2);
      assert.deepEqual(pushes[1]['content-state'].arrivals, []);
      assert.equal(pushes[1]['content-state'].updatedAt, initial.updatedAt, 'elapsed ETA can signal waiting with the original clock');
    }

    at = now + 390000;
    outcome = 'empty';
    await cycle({ sourceOnly: true });
    assert.equal(pushes.length, failure === 429 ? 2 : 3, String(failure));
    const empty = pushes.at(-1)['content-state'];
    assert.deepEqual(empty.arrivals, []);
    assert.equal(empty.updatedAt - initial.updatedAt, 390, 'a qualified complete empty reaches the board before any remaining ETA');
  }
});

test('upgrade preserves only the future ETAs proved by the last payload accepted from the old service', async t => {
  const registration = { ...record, stationID: '940GZZLUCTN' };
  const trains = [180000, 210000, 240000, 300000].map((offset, index) => row({
    stationID: registration.stationID, id: `train-${index}`, sourceID: 'station-arrivals',
    kind: 'throughArrival', timeEvidence: 'arrivalPrediction', time: now + offset,
    direction: index === 3 ? 'Northbound' : 'Southbound',
  }));
  const cache = cacheOf(...trains);
  const sent = buildStationBoardState(registration, cache, now, { preserveLegacyOrder: true });
  assert.deepEqual(sent.arrivals.map(row => row.id), ['train-0', 'train-1', 'train-2']);
  assert.deepEqual(buildStationBoardState(registration, cache, now).arrivals.map(row => row.id),
    ['train-0', 'train-3', 'train-1']);
  const { aps } = buildApnsPayload(sent, new Date(now));

  for (const hasExactEvidence of [true, false]) {
    let store = await temporaryStore(t, registration);
    await store.retainStationBoard(registration.activityID, registration.environment, cache, new Date(now));
    await store.markPushed(registration.activityID, registration.environment, {
      emptyArrivals: false, contentState: sent,
      contentDigest: hasExactEvidence ? stationBoardContentDigest(sent) : 'a'.repeat(64),
      boardDelivery: { nextAt: trains[0].time, staleAt: aps['stale-date'] * 1000, context: 'prior', closed: false },
    }, new Date(now));
    const pushes = [];
    const cycle = (at, options = {}) => runLiveActivityWorkerCycle({
      store, config: loadConfig({}), now: new Date(at), clock: () => at,
      fetchImpl: async () => new Response(null, { status: 503 }),
      pushImpl: async (_, payload) => { pushes.push(payload.aps); }, logger, ...options,
    });

    // Upgrade with the original rows already expired, but still present in the
    // previous service's durable cache. Failed transport never advances their clocks.
    await cycle(now + 120000, { sourceOnly: true });
    assert.equal(store.state.records[0].stationBoardCache.sources['station-arrivals'], undefined);
    if (!hasExactEvidence) {
      assert.deepEqual(pushes.map(push => push['content-state'].arrivals), [[]]);
      continue;
    }
    assert.equal(pushes.length, 0);
    assert.deepEqual(store.state.records[0].lastBoardDelivery.liveRows, sent.arrivals);
    assert.equal(store.state.records[0].lastBoardDelivery.staleAt, aps['stale-date'] * 1000);

    store = new LiveActivityStore(store.filePath);
    await cycle(trains[2].time, { cacheOnly: true });
    assert.deepEqual(pushes.map(push => push['content-state'].arrivals), [[sent.arrivals[2]]]);
    assert.equal(pushes[0]['stale-date'], aps['stale-date']);
    await cycle(trains[2].time + 1, { cacheOnly: true });
    assert.deepEqual(pushes.map(push => push['content-state'].arrivals), [[sent.arrivals[2]], []]);
    assert.ok(pushes.every(push => push['content-state'].updatedAt === sent.updatedAt));
  }
});

test('an outage retires each delivered ETA on cache-only boundaries without renewing its source', async t => {
  const stationID = '940GZZLUWOF';
  const store = await temporaryStore(t, { ...record, stationID, lineID: 'central' });
  const pushes = [], boundaries = [];
  const etaOffsets = [180000, 210000, 240000];
  let at = now, requests = 0;
  const fetchImpl = async url => {
    requests++;
    const path = new URL(url).pathname;
    if (at > now) return new Response(null, { status: 503 });
    const rows = path === `/StopPoint/${stationID}/Arrivals` ? etaOffsets.map((offset, index) => ({
      id: `woodford-outage-${index}`, lineId: 'central', naptanId: stationID,
      destinationName: 'Epping', destinationNaptanId: '940GZZLUEPG',
      platformName: 'Eastbound - Platform 3', expectedArrival: new Date(now + offset).toISOString(),
      timestamp: new Date(now).toISOString(),
    })) : [];
    return new Response(JSON.stringify(rows), { headers: headers(at) });
  };
  const cycle = options => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at,
    fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload.aps); }, logger,
    scheduleRolloverPush: (_, state) => boundaries.push(state.nextBoardBoundaryAt), ...options });

  await cycle();
  assert.equal(pushes.length, 1);
  const initial = pushes[0]['content-state'];
  assert.equal(initial.arrivals.length, 3);
  at += 60000;
  await cycle({ sourceOnly: true });
  assert.equal(pushes.length, 1);
  const afterFailure = requests;

  at = now + 120000;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 1);
  assert.equal(boundaries.at(-1), now + etaOffsets[0] + 1);
  for (const [index, offset] of etaOffsets.entries()) {
    at = now + offset + 1;
    await cycle({ cacheOnly: true });
    assert.equal(pushes.length, index + 2);
    const rollover = pushes.at(-1);
    assert.deepEqual(rollover['content-state'].arrivals, initial.arrivals.slice(index + 1));
    assert.equal(rollover['content-state'].updatedAt, initial.updatedAt);
    if (index < etaOffsets.length - 1) {
      assert.equal(rollover['stale-date'], pushes[0]['stale-date']);
      assert.equal(boundaries.at(-1), now + etaOffsets[index + 1] + 1);
    }
    at += 1000;
    await cycle({ cacheOnly: true });
    assert.equal(pushes.length, index + 2);
  }
  assert.equal(requests, afterFailure);
});

test('a sleeping Activity gets one cache-only warning at five minutes while unavailable ETAs remain future', async t => {
  let store = await temporaryStore(t);
  let at = now, requests = 0;
  const pushes = [], boundaries = [];
  const fetchImpl = async url => {
    requests++;
    if (at > now) return new Response(null, { status: 503 });
    const rows = new URL(url).pathname === `/StopPoint/${record.stationID}/Arrivals`
      ? [arrival({ expectedArrival: new Date(now + 420000).toISOString() })] : [];
    return new Response(JSON.stringify(rows), { headers: headers(at) });
  };
  const cycle = options => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at,
    fetchImpl, pushImpl: async (_, payload, _config, { priority }) => { pushes.push({ ...payload.aps, priority }); }, logger,
    scheduleRolloverPush: (_, state) => boundaries.push(state.nextBoardBoundaryAt), ...options });

  await cycle();
  at = now + 60000;
  await cycle({ sourceOnly: true });
  const afterFailure = requests;

  at = now + 120000;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 1);
  assert.equal(boundaries.at(-1), now + 300000);

  at = now + 299999;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 1);
  store = new LiveActivityStore(store.filePath);
  await store.load();
  at = now + 300000;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].timestamp, now / 1000 + 300);
  assert.equal(pushes[1].priority, '10');
  assert.equal(pushes[1]['stale-date'], pushes[0]['stale-date']);
  assert.equal(pushes[1]['content-state'].updatedAt, pushes[0]['content-state'].updatedAt);
  assert.deepEqual(pushes[1]['content-state'].arrivals, pushes[0]['content-state'].arrivals);
  assert.equal(store.state.records[0].lastBoardDelivery.delayedWarningSent, true);
  assert.equal(boundaries.at(-1), now + 420001);

  store = new LiveActivityStore(store.filePath);
  await store.load();
  at = now + 360000;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 2);
  at = now + 420001;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 3);
  assert.deepEqual(pushes[2]['content-state'].arrivals, []);
  assert.equal(requests, afterFailure);
});

test('stale and malformed HTTP 200 reads cannot erase a delivered future ETA at source expiry', async t => {
  for (const invalid of ['stale', 'malformed']) {
    const store = await temporaryStore(t);
    const pushes = [];
    let at = now;
    const fetchImpl = async url => {
      if (!new URL(url).pathname.endsWith('/Arrivals')) return new Response('[]', { headers: headers(at) });
      if (at === now) return new Response(JSON.stringify([arrival({
        expectedArrival: new Date(now + 300000).toISOString()
      })]), { headers: headers(at) });
      return invalid === 'stale'
        ? new Response('[]', { headers: headers(at, 151) })
        : new Response('{"invalid":"arrivals shape"}', { headers: headers(at) });
    };
    const cycle = options => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at),
      clock: () => at, fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload.aps); }, logger, ...options });

    await cycle();
    assert.equal(pushes[0]['content-state'].arrivals.length, 1);
    at += 60000;
    await cycle({ sourceOnly: true });
    assert.deepEqual(store.state.records[0].stationBoardCache.stationArrivalAttempt,
      { at, failed: true, observedAt: now }, invalid);

    at = now + 120000;
    await cycle({ cacheOnly: true });
    assert.equal(pushes.length, 1, invalid);
    assert.equal(store.state.records[0].stationBoardCache.sources['station-arrivals'], undefined);
    assert.equal(pushes[0]['stale-date'], (now + 120000) / 1000);
  }
});

test('a qualified older cached response cannot clear a station arrival failure', async t => {
  const store = await temporaryStore(t);
  const pushes = [];
  let at = now;
  const estimatedArrival = new Date(now + 300000).toISOString();
  const fetchImpl = async url => {
    if (!new URL(url).pathname.endsWith('/Arrivals')) return new Response('[]', { headers: headers(at) });
    if (at === now + 60000) return new Response(null, { status: 404 });
    if (at > now + 120000) return new Response('[]', { headers: headers(at) });
    const observed = at === now ? now : now - 5000;
    return new Response(JSON.stringify([arrival({
      timestamp: new Date(observed).toISOString(), timing: { read: new Date(observed).toISOString() },
      expectedArrival: estimatedArrival,
    })]), { headers: headers(observed) });
  };
  const cycle = options => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at),
    clock: () => at, fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload.aps); }, logger, ...options });

  await cycle();
  at = now + 60000;
  await cycle({ sourceOnly: true });
  assert.equal(store.state.records[0].stationBoardCache.stationArrivalAttempt.failed, true);

  at = now + 105000;
  await cycle({ sourceOnly: true });
  const cache = store.state.records[0].stationBoardCache;
  assert.equal(cache.sources['station-arrivals'].observedAt, now);
  assert.deepEqual(cache.stationArrivalAttempt, { at, failed: true, observedAt: now });

  at = now + 120000;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 1);
  at = now + 135000;
  await cycle({ sourceOnly: true });
  assert.deepEqual(store.state.records[0].stationBoardCache.stationArrivalAttempt,
    { at, failed: false, observedAt: at });
  assert.deepEqual(pushes.at(-1)['content-state'].arrivals, []);
  assert.equal(pushes.at(-1)['content-state'].updatedAt - pushes[0]['content-state'].updatedAt, 135);
});

test('a qualified station closure supersedes a future ETA during a source outage', async (t) => {
  const store = await temporaryStore(t);
  const pushes = [];
  let at = now;
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (at > now && path.endsWith('/Arrivals')) return new Response(null, { status: 503 });
    const rows = path.startsWith('/StopPoint/') && path.endsWith('/Arrivals')
      ? [arrival({ expectedArrival: new Date(now + 300000).toISOString() })]
      : at === now + 180000 && path.endsWith('/Disruption') ? [{
        stationAtcoCode: record.stationID, type: 'StationClosure',
        fromDate: new Date(now + 150000).toISOString(), toDate: new Date(now + 600000).toISOString(),
      }] : [];
    return new Response(JSON.stringify(rows), { headers: headers(at) });
  };
  const cycle = options => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at,
    fetchImpl, pushImpl: async (_, payload, _config, { priority }) => { pushes.push({ payload, priority }); }, logger, ...options });

  await cycle();
  assert.ok(pushes[0].payload.aps['content-state'].arrivals.length);
  at = now + 90000;
  await cycle();
  at = now + 120000;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 1);
  at = now + 180000;
  await cycle();
  assert.equal(pushes.length, 2);
  assert.deepEqual(pushes[1].payload.aps['content-state'].arrivals, []);
  assert.equal(pushes[1].priority, '10');
});

test('a failed rail departure read keeps the delivered ETA hold across a service restart', async (t) => {
  const stationID = '910GSHENFLD';
  let store = await temporaryStore(t, { ...record, stationID, lineID: 'elizabeth' });
  const pushes = [];
  let at = now, railFailure = false;
  const fetchImpl = async url => {
    const isRail = new URL(url).pathname.endsWith('/ArrivalDepartures');
    if (isRail && railFailure) return new Response(null, { status: 503 });
    const rows = isRail ? [{
      naptanId: stationID, destinationName: 'Liverpool Street', destinationNaptanId: '910GLIVSTLL',
      departureStatus: 'OnTime', estimatedTimeOfDeparture: new Date(now + 240000).toISOString(), platformName: '2',
    }] : [];
    return new Response(JSON.stringify(rows), { headers: headers(at) });
  };
  const cycle = options => runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at,
    fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload.aps); }, logger, ...options });

  await cycle();
  assert.equal(pushes[0]['content-state'].arrivals[0].timeEvidence, 'estimatedDeparture');
  assert.equal(pushes[0]['stale-date'], (now + 90000) / 1000);
  at = now + 90000;
  railFailure = true;
  await cycle();
  assert.equal(pushes.length, 1);
  assert.equal(store.state.records[0].stationBoardCache.sources['rail-departures'], undefined);

  store = new LiveActivityStore(store.filePath);
  await store.load();
  at = now + 239999;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 1);
  at = now + 240001;
  await cycle({ cacheOnly: true });
  assert.equal(pushes.length, 2);
  assert.deepEqual(pushes[1]['content-state'].arrivals, []);
});

test('partial rail responses and invalid Age headers cannot clear a future ETA in either worker path', async t => {
  const stationID = '910GSHENFLD';
  for (const sourceOnly of [false, true]) {
    for (const invalid of [{ status: 206, age: '0' }, { status: 200, age: '' }, { status: 200, age: '0.5' }]) {
      const store = await temporaryStore(t, { ...record, stationID, lineID: 'elizabeth' });
      const pushes = [];
      let at = now;
      const fetchImpl = async url => {
        if (!new URL(url).pathname.endsWith('/ArrivalDepartures')) {
          return new Response('[]', { headers: headers(at) });
        }
        if (at === now + 90000) {
          return new Response('[]', { status: invalid.status, headers: { ...headers(at), age: invalid.age } });
        }
        const departures = at === now ? [{
          naptanId: stationID, destinationName: 'Liverpool Street', destinationNaptanId: '910GLIVSTLL',
          departureStatus: 'OnTime', estimatedTimeOfDeparture: new Date(now + 240000).toISOString(), platformName: '2',
        }] : [];
        return new Response(JSON.stringify(departures), { headers: headers(at) });
      };
      const cycle = options => runLiveActivityWorkerCycle({
        store, config: loadConfig({}), now: new Date(at), clock: () => at, fetchImpl, logger,
        pushImpl: async (_, payload) => { pushes.push(payload.aps); }, ...options,
      });

      await cycle();
      const original = pushes[0];
      assert.equal(original['content-state'].arrivals[0].timeEvidence, 'estimatedDeparture');
      at = now + 90000;
      await cycle({ sourceOnly });
      assert.deepEqual(store.state.records[0].stationBoardCache.railDepartureAttempt,
        { at, failed: true, observedAt: now });
      assert.equal(pushes.length, 1);
      assert.equal(original['stale-date'], at / 1000);

      at = now + 150000;
      await cycle({ sourceOnly: true });
      assert.deepEqual(store.state.records[0].stationBoardCache.railDepartureAttempt,
        { at, failed: false, observedAt: at });
      assert.deepEqual(pushes.map(push => push['content-state'].arrivals.length), [1, 0]);
    }
  }
});

test('active rail boards share minute reads independently of the supplemental cycle and survive durable backoff', async (t) => {
  for (const failure of [429, 503]) {
    const stationID = '910GSHENFLD';
    const railBoard = { ...record, stationID, lineID: 'elizabeth' };
    let store = await temporaryStore(t, railBoard);
    await store.upsertToken({ ...railBoard, activityID: 'second-rail', installID: 'second-rail' }, new Date(now));
    await store.upsertToken({ ...record, activityID: 'unrelated-tube', installID: 'unrelated-tube' }, new Date(now));

    let at = now, railFailure = null;
    const railReads = [], supplemental = [], pushes = [];
    const fetchImpl = async url => {
      const { pathname, searchParams } = new URL(url);
      if (pathname.endsWith('/ArrivalDepartures')) {
        railReads.push(at);
        assert.equal(pathname, `/StopPoint/${stationID}/ArrivalDepartures`);
        assert.equal(searchParams.get('lineIds'), 'elizabeth');
        if (railFailure) return new Response(null, { status: railFailure, headers: { 'Retry-After': '420' } });
        return new Response(JSON.stringify([{
          id: 'stable-estimate', naptanId: stationID, destinationName: 'Liverpool Street', destinationNaptanId: '910GLIVSTLL',
          departureStatus: 'OnTime', estimatedTimeOfDeparture: new Date(now + 900000).toISOString(), platformName: '2',
        }]), { headers: headers(at) });
      }
      if (!pathname.startsWith('/StopPoint/') || !pathname.endsWith('/Arrivals')) supplemental.push(at);
      return new Response(JSON.stringify([]), { headers: headers(at, 0, 120) });
    };
    const cycle = (offset, options) => {
      at = now + offset;
      return runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at,
        fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload.aps['content-state']); }, logger, ...options });
    };
    await cycle(0);
    assert.deepEqual(railReads, [now]);
    const railState = pushes.find(state => state.arrivals.some(row => row.timeEvidence === 'estimatedDeparture'));
    assert.ok(railState);
    const stored = store.state.records.find(r => r.activityID === railBoard.activityID);
    assert.equal(getLiveSourceRefreshDelayMs({ railDeparturesNotBefore: stored.stationBoardCache.railDeparturesNotBefore }, new Date(now)), 60000);
    const firstSupplementCount = supplemental.length;
    await cycle(60000, { sourceOnly: true });
    assert.deepEqual(railReads, [now, now + 60000]);
    assert.equal(supplemental.length, firstSupplementCount);
    assert.ok(pushes.some(state => state.updatedAt === railState.updatedAt + 60
      && state.arrivals.some(row => row.timeEvidence === 'estimatedDeparture')));
    await cycle(90000);
    assert.equal(railReads.length, 2, 'the earlier minute read also fences the full refresh');
    assert.ok(supplemental.length > firstSupplementCount);
    railFailure = failure;
    await cycle(120000, { sourceOnly: true });
    assert.equal(railReads.length, 3);
    const retryOffset = 120000 + (failure === 429 ? 420000 : 120000);
    await store.deactivate(railBoard.activityID, railBoard.environment, 'synthetic-stop', new Date(at));
    await store.deactivate('second-rail', railBoard.environment, 'synthetic-stop', new Date(at));
    store = new LiveActivityStore(store.filePath);
    await store.load();
    assert.equal(store.railDepartureAdmissionFloors(at)[0].notBefore, now + retryOffset);
    await store.upsertToken({ ...railBoard, activityID: 'new-rail', installID: 'new-rail' }, new Date(at + 1));
    await cycle(retryOffset - 1);
    assert.equal(railReads.length, 3, 'a restart plus new registration cannot bypass the shared URL floor');
    railFailure = null;
    await cycle(retryOffset, { sourceOnly: true });
    assert.equal(railReads.length, 4);
    for (const registration of store.state.records) {
      await store.deactivate(registration.activityID, registration.environment, 'synthetic-stop', new Date(at));
    }
    await cycle(retryOffset + 60000);
    assert.equal(railReads.length, 4);
  }
});

test('UF276 thirty-minute source renewals share requests across registrations without extra supplemental reads', async (t) => {
  const store = await temporaryStore(t); let at = now;
  const second = { ...record, activityID: 'synthetic-v2-second', installID: 'synthetic-install-second', selectionMode: 'platform', platformID: 'southbound-platform-2', platformHeading: 'Southbound - Platform 2' };
  await store.upsertToken(second, new Date(now));
  const reads = [], supplemental = [], pushes = [];
  const config = loadConfig({});
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/StopPoint/') && path.endsWith('/Arrivals')) {
      reads.push(at);
      return new Response(JSON.stringify([arrival({ timestamp: new Date(at - 78480).toISOString(), expectedArrival: new Date(at + 300000).toISOString() })]), { headers: headers(at, 51, 30) });
    }
    supplemental.push({ path, at });
    return new Response(JSON.stringify(path.endsWith('/Status') ? [{ id: record.lineID, lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }] : []), { headers: headers(at, 0, 30) });
  };
  for (let step = 0; step <= 60; step++) {
    at = now + step * 30000;
    if (step) for (const r of store.state.records) assert.ok(r.stationBoardCache.sources['station-arrivals'].events[0].expiresAt > at, 'previous source survives until the next admitted opportunity');
    const full = step % 3 === 0;
    const beforeSupplemental = supplemental.length;
    await runLiveActivityWorkerCycle({ store, config, now: new Date(at), clock: () => at, sourceOnly: !full, fetchImpl, pushImpl: async (_, payload) => { pushes.push(payload); return { status: 200 }; }, logger });
    if (!full) assert.equal(supplemental.length, beforeSupplemental, 'source-only cycle makes no status/planning/closure request');
    for (const r of store.state.records) {
      const live = r.stationBoardCache.sources['station-arrivals'];
      assert.equal(live.events.length, 1); assert.equal(live.events[0].expiresAt - at, 41520);
      assert.ok(r.stationBoardCache.arrivalsRefreshAt <= at + 30000);
      assert.equal(r.stationBoardCache.nextRefreshAt, now + (Math.floor(step / 3) + 1) * 90000);
    }
  }
  assert.equal(reads.length, 61, 'one logical request per30s shared by both configurations');
  assert.ok(reads.slice(1).every((value, i) => value - reads[i] >= 30000));
  assert.equal(new Set(supplemental.map(r => r.at)).size, 21, 'supplemental sources stay on full90s cycles');
  assert.ok(pushes.every(p => p.aps['content-state'].arrivals.some(r => r.timeEvidence === 'throughArrivalPrediction')));
});

test('UF276 source timer uses the current post-push registration fence', async (t) => {
  const store = await temporaryStore(t); const schedules = [];
  const fetchImpl = async url => new Response(JSON.stringify(new URL(url).pathname.endsWith('/Arrivals') ? [arrival()] : []), { headers: headers() });
  await runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(now), clock: () => now, fetchImpl,
    pushImpl: async () => { await store.upsertToken({ ...record, tokenUpdatedAt: new Date(now + 1000).toISOString(), platformID: 'other-platform', selectionMode: 'platform' }, new Date(now + 1000)); return { status: 200 }; },
    scheduleSourceRefresh: (...args) => schedules.push(args), scheduleRolloverPush: (...args) => schedules.push(args), logger });
  assert.equal(schedules.length, 0, 'obsolete callback cannot install either timer');
  assert.equal(store.state.records[0].lastSuccessAt, null);
});

test('UF276 URL reader preserves persisted cooldown across a deferred record and a new registration', async () => {
  const reader = new StationArrivalReader(), url = new URL('https://api.tfl.gov.uk/StopPoint/synthetic/Arrivals');
  let at = now, calls = 0;
  const fetchImpl = async () => { calls++; return new Response('[]', { headers: headers(at) }); };
  const oldRecord = await reader.read(url, { fetchImpl, clock: () => at, notBefore: now + 300000 });
  const newRecord = await reader.read(url, { fetchImpl, clock: () => at });
  assert.equal(oldRecord.deferred, true); assert.equal(newRecord.deferred, true); assert.equal(calls, 0);
  assert.equal(newRecord.nextAttemptAt, now + 300000);
  at = now + 300000;
  assert.equal((await reader.read(url, { fetchImpl, clock: () => at })).ok, true); assert.equal(calls, 1);
});

test('UF276 URL reader shares in-flight reads and strongest waiter floor without caching completed bodies', async () => {
  const reader = new StationArrivalReader(), url = new URL('https://api.tfl.gov.uk/StopPoint/synthetic/Arrivals');
  let at = now, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { calls++; await gate; return new Response('[]', { headers: headers(at) }); };
  const first = reader.read(url, { fetchImpl, clock: () => at });
  const joined = reader.read(url, { fetchImpl, clock: () => at, notBefore: now + 300000 });
  release(); const [a, b] = await Promise.all([first, joined]);
  assert.equal(calls, 1); assert.equal(a.nextAttemptAt, now + 300000); assert.equal(b.nextAttemptAt, now + 300000);
  at += 30000;
  const deferred = await reader.read(url, { fetchImpl, clock: () => at });
  assert.equal(deferred.deferred, true); assert.equal(deferred.value, undefined); assert.equal(calls, 1);
});

test('UF276 reader honors429 Retry-After and bounded missing-Age retry without spinning', async () => {
  for (const retry of ['400', new Date(now + 400000).toUTCString()]) {
    let at = now, calls = 0; const reader = new StationArrivalReader(), url = new URL('https://api.tfl.gov.uk/StopPoint/synthetic/Arrivals');
    const fetchImpl = async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': retry } }); };
    const result = await reader.read(url, { fetchImpl, clock: () => at });
    assert.equal(result.nextAttemptAt, now + 400000);
    for (at = now + 30000; at < now + 400000; at += 30000) assert.equal((await reader.read(url, { fetchImpl, clock: () => at })).deferred, true);
    assert.equal(calls, 1);
  }
  let at = now, calls = 0; const reader = new StationArrivalReader(), url = new URL('https://api.tfl.gov.uk/StopPoint/synthetic/Arrivals');
  const fetchImpl = async () => { calls++; return new Response('[]', { headers: { date: new Date(at).toUTCString() } }); };
  for (let attempt = 0; attempt < 4; attempt++) { at = now + attempt * 30000; await reader.read(url, { fetchImpl, clock: () => at }); }
  assert.equal(calls, 8, 'two logical attempts/min, at mosttwo HTTP reads per missing-Age attempt');
});

test('UF276 reader cancellation consumes no retry and retains only the admitted30s floor', async () => {
  const controller = new AbortController(), reader = new StationArrivalReader(), url = new URL('https://api.tfl.gov.uk/StopPoint/synthetic/Arrivals');
  let calls = 0, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const work = reader.read(url, { signal: controller.signal, clock: () => now, fetchImpl: async (_, { signal }) => {
    calls++; entered(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await gate; controller.abort(new DOMException('Synthetic cancellation', 'AbortError'));
  await assert.rejects(work, { name: 'AbortError' });
  const result = await reader.read(url, { clock: () => now + 1000, fetchImpl: async () => { calls++; throw new Error('must not run'); } });
  assert.equal(result.deferred, true); assert.equal(result.nextAttemptAt, now + 30000); assert.equal(calls, 1);
});

test('UF276 durable complete-empty ordering survives HTTP expiry and only a newer source recovers', async (t) => {
  const store = await temporaryStore(t);
  const live = observedAt => cacheOf(row({ sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction', receivedAt: observedAt, expiresAt: observedAt + 120000, time: now + 300000 }));
  await store.retainStationBoard(record.activityID, record.environment, live(now), new Date(now));
  const empty = { sources: { 'station-arrivals': { observedAt: now + 30000, expiresAt: now + 60000, events: [] } } };
  await store.retainStationBoard(record.activityID, record.environment, empty, new Date(now + 30000));
  // Original observation t20, delivered after the newer complete-empty HTTP expires at t60.
  await store.retainStationBoard(record.activityID, record.environment, live(now + 20000), new Date(now + 61000));
  const reloaded = new LiveActivityStore(store.filePath); await reloaded.load();
  let retained = reloaded.state.records[0].stationBoardCache;
  assert.equal(retained.sources['station-arrivals'].observedAt, now + 30000);
  assert.equal(retained.sources['station-arrivals'].expiresAt, now + 60000);
  assert.deepEqual(selectEvents(retained, record, now + 61000), [], 'expired negative history is not current and older live rows cannot revive');
  await reloaded.retainStationBoard(record.activityID, record.environment, live(now + 62000), new Date(now + 62000));
  retained = reloaded.state.records[0].stationBoardCache;
  assert.equal(retained.sources['station-arrivals'].observedAt, now + 62000);
  assert.equal(selectEvents(retained, record, now + 62000).length, 1);
});

test('UF276 worker primes persisted URL cooldowns before new registrations even when their owner is in APNs backoff', async (t) => {
  const store = await temporaryStore(t), later = { ...record, activityID: 'later-source-cooldown', installID: 'another-owned-synthetic-install' };
  await store.upsertToken(later, new Date(now));
  await store.retainStationBoard(later.activityID, later.environment, { arrivalsNotBefore: now + 300000, arrivalsRefreshAt: now + 300000 }, new Date(now));
  await store.markBackoff(later.activityID, later.environment, 120000, 'syntheticAPNsBackoff', new Date(now));
  let arrivals = 0;
  await runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(now), clock: () => now,
    fetchImpl: async url => { if (new URL(url).pathname.startsWith('/StopPoint/') && new URL(url).pathname.endsWith('/Arrivals')) arrivals++; return new Response('[]', { headers: headers() }); }, pushImpl: async () => ({ status: 200 }), logger });
  assert.equal(arrivals, 0, 'first/new record must observe the later/backed-off record cooldown');
  assert.equal(store.state.records[0].stationBoardCache.arrivalsNotBefore, now + 300000);
});

test('UF276 actual worker timers renew before expiry with transport latency and let unchanged bodies expire', async (t) => {
  for (const advancing of [true, false]) {
    const store = await temporaryStore(t);
    await store.upsertToken({ ...record, activityID: 'timer-second', installID: 'timer-second-install', selectionMode: 'platform', platformID: 'southbound-platform-2', platformHeading: 'Southbound - Platform 2' }, new Date(now));
    let at = now, sleeping = 0, active = 0, maximum = 0, initialTimestamp = null, currentCycle;
    const timers = new Map(), reads = [], supplements = [], delivered = [], cycles = [];
    const schedule = (callback, delay) => { const key = { at: at + delay, callback, unref() {} }; timers.set(key, key); return key; };
    const cancel = timer => timers.delete(timer);
    const latency = (delay, signal) => new Promise((resolve, reject) => {
      sleeping++;
      const timer = schedule(() => { sleeping--; signal?.removeEventListener('abort', abort); resolve(); }, delay);
      const abort = () => { cancel(timer); sleeping--; reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
    });
    const fetchImpl = async (url, { signal }) => {
      const path = new URL(url).pathname, dispatch = at, cycle = currentCycle;
      await latency(2000, signal);
      if (path.startsWith('/StopPoint/') && path.endsWith('/Arrivals')) {
        const timestamp = advancing || initialTimestamp === null ? at - 78480 : initialTimestamp;
        initialTimestamp ??= timestamp;
        reads.push({ dispatch, received: at, expiry: timestamp + 120000 });
        return new Response(JSON.stringify([arrival({ timestamp: new Date(timestamp).toISOString(), expectedArrival: new Date(at + 300000).toISOString() })]), { headers: headers(at, 51, 30) });
      }
      supplements.push({ path, cycle });
      return new Response(JSON.stringify(path.endsWith('/Status') ? [{ id: record.lineID, lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }] : []), { headers: headers(at, 0, 30) });
    };
    const worker = new SerialWorker({ schedule, cancel, initialDelayMs: 2000, intervalMs: 90000,
      onError: error => { throw error; },
      run: async (signal, mode) => {
        maximum = Math.max(maximum, ++active); currentCycle = { at, ...mode }; cycles.push(currentCycle);
        try {
          await runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(at), clock: () => at, signal, ...mode, fetchImpl,
            pushImpl: async (_, payload) => { await latency(1000, signal); delivered.push({ at, payload }); return { status: 200 }; },
            scheduleSourceRefresh: (r, cache, current, interval) => worker.scheduleRerun(`${r.activityID}:source`, getLiveSourceRefreshDelayMs(cache, current, interval), { sourceOnly: true }),
            scheduleRolloverPush: (r, state, current, interval) => worker.scheduleRerun(`${r.activityID}:cache`, getRolloverDelayMs(state, current, interval), { cacheOnly: true }), logger });
        } finally { active--; currentCycle = undefined; }
      }
    });
    t.after(() => worker.stop());
    worker.start();
    const until = now + (advancing ? 370000 : 160000); let waits = 0;
    while (true) {
      // Real persistence awaits do not advance virtual provider/network time.
      if (active && !sleeping) { assert.ok(++waits < 10000, 'business work must settle or schedule transport'); await new Promise(resolve => setImmediate(resolve)); continue; }
      waits = 0;
      const next = [...timers.values()].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > until) { at = until; await worker.stop(); break; }
      at = next.at; timers.delete(next); next.callback(); await new Promise(resolve => setImmediate(resolve));
    }
    at = Math.max(at, until); await worker.stop();
    assert.equal(maximum, 1); assert.equal(timers.size, 0);
    assert.ok(cycles.some(c => c.sourceOnly === true)); assert.ok(cycles.some(c => c.cacheOnly === true));
    assert.ok(reads.length >= (advancing ? 9 : 2));
    assert.ok(reads.slice(1).every((r, i) => r.dispatch - reads[i].dispatch >= 30000), 'actual timer-driven source admission is bounded');
    const full = cycles.filter(c => !c.cacheOnly && !c.sourceOnly);
    assert.equal(full[0].at, now + 2000);
    assert.ok(full.slice(1).every((c, i) => c.at >= now + (i + 1) * 90000 && c.at <= now + (i + 1) * 90000 + 8000), 'full90s triggers retain phase; only active serialized work may delay dispatch');
    assert.ok(supplements.every(read => full.includes(read.cycle)), 'only full cycles make supplemental requests');
    for (const cycle of full) {
      const journeys = supplements.filter(read => read.cycle === cycle && read.path.startsWith('/Journey/')).map(read => read.path);
      assert.ok(journeys.length <= 2 && new Set(journeys).size === journeys.length, 'each full cycle shares one Journey per route scope');
    }
    if (advancing) {
      assert.ok(reads.slice(1).every((r, i) => r.received < reads[i].expiry), 'new original source arrives before previous expiry');
      assert.ok(delivered.every(({ at: receipt, payload }) => payload.aps['content-state'].arrivals.some(r => r.timeEvidence === 'throughArrivalPrediction' && r.expiresAt * 1000 + 978307200000 > receipt)), 'every delivered healthy payload still has an original current live row');
      assert.ok(delivered.some(d => d.at > now + 240000), 'actual timer path crosses two original120s windows');
    } else {
      const expiry = initialTimestamp + 120000;
      assert.ok(delivered.some(d => d.at > expiry && d.payload.aps['content-state'].arrivals.length === 0));
      assert.ok(delivered.filter(d => d.at > expiry).every(d => d.payload.aps['content-state'].arrivals.every(r => r.expiresAt * 1000 + 978307200000 <= d.at)), 'old unchanged provider timestamp is never renewed');
    }
  }
});

test('UF276 transport failure retains only unexpired original live facts and never becomes an empty read', async () => {
  let at = now; const reader = new StationArrivalReader(), config = loadConfig({});
  const good = async () => new Response(JSON.stringify([arrival({ expectedArrival: new Date(now + 300000).toISOString() })]), { headers: headers(now, 0, 30) });
  let cache = await refreshStationArrivals(record, {}, config, good, at, null, () => at, new Map(), reader);
  const original = cache.sources['station-arrivals'];
  at += 30000;
  cache = await refreshStationArrivals(record, { ...cache, arrivalsRefreshAt: at }, config, async () => { throw new Error('synthetic transport failure'); }, at, null, () => at, new Map(), reader);
  assert.deepEqual(cache.sources['station-arrivals'], original);
  assert.equal(cache.arrivalsNotBefore, at + 120000);
  assert.equal(selectEvents(cache, record, now + 31000).length, 1);
  assert.equal(selectEvents(cache, record, now + 120000).length, 0);
  assert.equal(cache.sources['station-arrivals'].events[0].expiresAt, now + 120000);
});

test('UF276 blank Age cannot make a clockless empty authoritative in full or source-only refresh', async (t) => {
  for (const sourceOnly of [false, true]) for (const age of ['', ' ', '0']) {
    const store = await temporaryStore(t);
    const original = cacheOf(row({ sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction', receivedAt: now, expiresAt: now + 120000, time: now + 300000 }));
    await store.retainStationBoard(record.activityID, record.environment, original, new Date(now));
    const at = now + 30000;
    await runLiveActivityWorkerCycle({ store, config: loadConfig({}), sourceOnly, now: new Date(at), clock: () => at,
      fetchImpl: async () => new Response('[]', { headers: { date: new Date(at).toUTCString(), age, 'cache-control': 'public,max-age=30' } }),
      pushImpl: async () => ({ status: 200 }), logger });
    const source = store.state.records[0].stationBoardCache.sources['station-arrivals'];
    if (age === '0') { assert.deepEqual(source.events, []); assert.equal(source.expiresAt, at + 30000); }
    else { assert.equal(source.events.length, 1); assert.equal(source.observedAt, now); assert.equal(source.events[0].expiresAt, now + 120000); }
  }
});

test('repeated cache-only outage ticks preserve the last board observation and deliver one empty transition', async t => {
  const store = await temporaryStore(t);
  const calls = [];
  const clock = (activeStore, tick) => runLiveActivityWorkerCycle({
    store: activeStore, config: loadConfig({}), cacheOnly: true, now: new Date(tick), clock: () => tick,
    fetchImpl: async () => assert.fail('cache-only rollover must never read the provider'),
    pushImpl: async (_record, payload) => { calls.push(payload.aps); }, logger,
  });

  // A newly registered board with no provider observation also has one
  // stable unavailable payload across identical scans.
  await clock(store, now + 1000);
  await clock(store, now + 2000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]['content-state'].updatedAt, (now - 978307200000) / 1000);

  const fresh = row({ receivedAt: now + 10000, time: now + 55000, expiresAt: now + 60000 });
  await store.retainStationBoard(record.activityID, record.environment, cacheOf(fresh), new Date(now + 10000));
  await clock(store, now + 10000);
  assert.deepEqual(calls.at(-1)['content-state'].arrivals.map(item => item.id), [fresh.id]);

  const restarted = new LiveActivityStore(store.filePath);
  await clock(restarted, now + 55001);
  const empty = calls.at(-1);
  assert.deepEqual(empty['content-state'].arrivals, []);
  assert.equal(empty['content-state'].updatedAt, (fresh.receivedAt - 978307200000) / 1000);
  assert.equal(empty['stale-date'], fresh.receivedAt / 1000);
  const count = calls.length;
  await clock(restarted, now + 56000);
  await clock(restarted, now + 119000);
  assert.equal(calls.length, count);
});

test('capable scheduled rows keep the original clock without minute-only wakes or payloads', () => {
  const capable = { ...record, supportsRegularTimetable: true };
  const published = row({ time: now + 90000 });
  const cache = cacheOf(published);
  const first = buildStationBoardState(capable, cache, now);
  const changedMinute = buildStationBoardState(capable, cache, now + 31000);
  assert.equal(first.nextBoardBoundaryAt, now + 90001);
  assert.equal(first.arrivals[0].countdownText, '1 min');
  assert.equal(changedMinute.arrivals[0].countdownText, 'Due');
  assert.notEqual(stationBoardContentDigest(first), stationBoardContentDigest(changedMinute));
  const dynamic = { dynamicScheduledCountdown: true };
  assert.equal(stationBoardContentDigest(first, dynamic), stationBoardContentDigest(changedMinute, dynamic));
  const departed = buildStationBoardState(capable, cache, now + 90001);
  assert.deepEqual(departed.arrivals, []);
  assert.notEqual(stationBoardContentDigest(first, dynamic), stationBoardContentDigest(departed, dynamic));
});

test('typed Activity delivery uses routine priority for renewal and prompt priority for boarding changes', async t => {
  const store = await temporaryStore(t);
  const priorities = [];
  async function cycle(offset, { destination = 'Morden', id = 'train', time = 90000, expiry = 120000 } = {}) {
    const at = now + offset;
    const train = row({ id, destination, time: now + time, receivedAt: at, expiresAt: now + expiry });
    await store.retainStationBoard(record.activityID, record.environment, cacheOf(train), new Date(at));
    await runLiveActivityWorkerCycle({
      store, config: loadConfig({}), cacheOnly: true, now: new Date(at), clock: () => at, logger,
      pushImpl: async (_, payload, _config, options) => {
        priorities.push(options.priority);
        assert.equal(payload.aps.alert, undefined);
      },
    });
  }
  await cycle(0);
  await cycle(10000, { id: 'reobserved-with-new-provider-id', expiry: 140000 });
  await cycle(15000, { id: 'slightly-shifted', time: 100000, expiry: 140000 });
  await cycle(20000, { id: 'towards-a-different-destination', destination: 'Kennington', time: 100000, expiry: 140000 });
  await cycle(100001, { id: 'next-service', destination: 'Kennington', time: 130000, expiry: 150000 });
  await cycle(150000, { id: 'expired-source', time: 130000, expiry: 150000 });
  assert.deepEqual(priorities, ['10', '5', '5', '10', '10', '10']);
});

test('APNs transport uses the selected precedence header and keeps the payload', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { apns: { teamId: 'synthetic-team', keyId: 'synthetic-test-key',
    authKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) } };
  const payload = buildApnsPayload(buildStationBoardState(record, cacheOf(row()), now), new Date(now));
  const actual = [];
  const send = async (host, headers, body) => {
    assert.equal(host, 'api.sandbox.push.apple.com');
    assert.equal(headers['apns-push-type'], 'liveactivity');
    assert.equal(headers['apns-topic'], 'OllyJ.My-Train-Times.push-type.liveactivity');
    assert.deepEqual(body, payload);
    actual.push(headers['apns-priority']);
    return { status: 200 };
  };
  await pushLiveActivityUpdate(record, payload, config, { priority: '5', send });
  await pushLiveActivityUpdate(record, payload, config, { send });
  assert.deepEqual(actual, ['5', '10']);
});

test('queued typed Activity snapshots expire at their original cutoff and can be replaced by current rows', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { apns: { teamId: 'synthetic-team', keyId: 'synthetic-test-key',
    authKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) } };
  const early = row({ id: 'early', time: now + 30_000 });
  const next = row({ id: 'next', time: now + 90_000, expiresAt: now + 75_000 });
  const queue = [];
  const send = async (_, headers, payload) => {
    queue.push({ expiration: headers['apns-expiration'], payload });
    return { status: 200 };
  };
  const sendBoard = async (tick, ...rows) => {
    const state = buildStationBoardState(record, cacheOf(...rows), tick);
    await pushLiveActivityUpdate(record, buildApnsPayload(state, new Date(tick)), config, { send });
  };

  await sendBoard(now, early, next);
  await sendBoard(early.time + 1, early, next);
  const [initial, replacement] = queue;
  assert.equal(initial.expiration, String(early.time / 1000));
  assert.equal(replacement.expiration, String(next.expiresAt / 1000));

  // Model APNs's documented storage policy, without asserting device delivery.
  const reconnectedAt = early.time + 2_000;
  const stillEligible = queue.filter(update => Number(update.expiration) * 1000 > reconnectedAt);
  assert.deepEqual(stillEligible.flatMap(update => update.payload.aps['content-state'].arrivals.map(row => row.id)), ['next']);

  const sameWireSecond = { ...next, expiresAt: next.expiresAt + 500 };
  await sendBoard(sameWireSecond.expiresAt - 1, sameWireSecond);
  assert.equal(queue.at(-1).expiration, '0', 'A cutoff in the dispatch second makes the update immediate-only');
  await sendBoard(next.expiresAt, next);
  assert.deepEqual(queue.at(-1).payload.aps['content-state'].arrivals, []);
  assert.equal(queue.at(-1).expiration, undefined, 'Allow the waiting state to reach a reconnecting phone');
});

test('a fresh scoped closure prompts a priority-10 update even with the same boarding clock', async t => {
  const store = await temporaryStore(t);
  const live = row({ sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction' });
  await store.retainStationBoard(record.activityID, record.environment, cacheOf(live), new Date(now));
  const pushes = [];
  const cycle = at => runLiveActivityWorkerCycle({
    store, config: loadConfig({}), cacheOnly: true, now: new Date(at), clock: () => at, logger,
    pushImpl: async (_, payload, _config, options) => pushes.push({ payload, priority: options.priority }),
  });
  await cycle(now);
  const closedAt = now + 10000;
  const proof = { stationID: record.stationID, lineID: record.lineID, sourceScope: 'stationDisruptions', closed: true,
    observedAt: closedAt, expiresAt: closedAt + 30000, validFrom: closedAt, validUntil: closedAt + 30000 };
  await store.retainStationBoard(record.activityID, record.environment, { availabilityProofs: [proof] }, new Date(closedAt));
  await cycle(closedAt);
  assert.deepEqual(pushes.map(push => push.priority), ['10', '10']);
  assert.deepEqual(pushes.map(push => push.payload.aps['content-state'].arrivals[0].id), [live.id, live.id]);
});
