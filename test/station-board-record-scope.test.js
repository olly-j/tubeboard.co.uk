import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveActivityStore, loadConfig, runLiveActivityWorkerCycle } from '../server/live-activity.js';
import { refreshStationBoard, selectEvents, STATION_BOARD_STATIONS } from '../server/station-board-v2.js';
const now = Date.parse('2026-10-01T13:00:00Z');
const config = loadConfig({});
const headers = (at = now, age = 0, maxAge = 120) => ({ date: new Date(at).toUTCString(), age: String(age), 'cache-control': `public,max-age=${maxAge}` });
const record = { activityID: 'synthetic-A', installID: 'synthetic-install', stationID: '940GZZLUEGW', lineID: 'northern', selectionMode: 'allPlatforms', pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(now).toISOString(), appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.0', buildNumber: '1', environment: 'sandbox', contentStateContract: 'station-board-v2', plannedPresentationVersion: 2 };
const event = (id, overrides = {}) => ({ id, stationID: record.stationID, lineID: record.lineID, sourceID: 'journey-planner', kind: 'outgoingDeparture', timeEvidence: 'scheduledDeparture', time: now + 90000, destination: 'Morden', destinationStationID: '940GZZLUMDN', receivedAt: now, expiresAt: now + 120000, ...overrides });
const context = (...events) => ({ sources: Object.fromEntries([...new Set(events.map((e) => e.sourceID))].map((source) => [source, { observedAt: Math.max(...events.filter((e) => e.sourceID === source).map((e) => e.receivedAt)), events: events.filter((e) => e.sourceID === source) }])) });
function journey() { return { searchCriteria: { dateTimeType: 'Departing', dateTime: '2026-10-01T14:00:00' }, recommendedMaxAgeMinutes: 2, stopMessages: [], journeys: [{ legs: [{ mode: { id: 'tube' }, departurePoint: { naptanId: record.stationID }, arrivalPoint: { naptanId: '940GZZLUMDN' }, scheduledDepartureTime: '2026-10-01T14:02:00', isDisrupted: false, disruptions: [], plannedWorks: [], routeOptions: [{ lineIdentifier: { id: 'northern' }, direction: 'Outbound', directions: ['Morden'] }], path: { stopPoints: [{ id: record.stationID }, { id: '940GZZLUMDN' }] } }] }] }; }
function seed(prefix = 0) { return { schemaVersion: 1, stationID: record.stationID, lineID: record.lineID, contexts: [{ sourceID: 'timetable', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(), publication: { url: 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip', sha256: 'a'.repeat(64), timezone: 'Europe/London', operatingStartDate: '2026-09-26', operatingEndDate: '2026-12-23', holidayCoverageStart: '2026-01-01', holidayCoverageEnd: '2026-12-31', nonOperationBankHolidays: true }, rows: [0, 1, 2].map((i) => ({ id: `schedule:northern:${record.stationID}:2026-10-01:0:0:${prefix + i}`, destinationID: '940GZZLUMDN', destination: 'Morden', departure: new Date(now + (prefix ? 180000 : 120000)).toISOString(), via: null, routeStationIDs: ['940GZZLUMDN'], serviceDay: '2026-10-01', profileName: 'Monday - Thursday', profileSHA256: 'b'.repeat(64), weekdays: [5], serviceMinute: prefix ? 843 : 842, isBankHoliday: false })) }] }; }
async function storeFor(t, records) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-record-scope-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); const store = new LiveActivityStore(path.join(directory, 'records.json')); for (const row of records) await store.upsertToken(row, new Date(now)); return store; }
const logger = { info() {}, warn() {}, error() {} };

for (const reverse of [false, true]) {
  test(`record-scoped worker retains independently seeded and unseeded contexts, reverse=${reverse}`, async (t) => {
    const seeded = { ...record, plannedContextSeed: seed() }, plain = { ...record, activityID: 'synthetic-B', installID: 'synthetic-install-B' };
    const store = await storeFor(t, reverse ? [plain, seeded] : [seeded, plain]);
    const requests = [], pushes = [];
    const fetchImpl = async (url, options) => { const u = new URL(url); requests.push(`${options.method || 'GET'}:${u.pathname}`); const value = u.pathname.includes('JourneyResults') ? journey() : []; return new Response(JSON.stringify(value), { headers: { ...headers(), 'x-amz-meta-sha256': 'a'.repeat(64) } }); };
    await runLiveActivityWorkerCycle({ store, config, now: new Date(now), clock: () => now, fetchImpl, pushImpl: async (r, payload) => { pushes.push([r.activityID, payload.aps['content-state']]); }, logger });
    const a = store.state.records.find((r) => r.activityID === seeded.activityID), b = store.state.records.find((r) => r.activityID === plain.activityID);
    assert.equal(a.stationBoardCache.sources.timetable.events.length, 3);
    assert.equal(b.stationBoardCache.sources.timetable, undefined);
    assert.equal(b.stationBoardCache.sources['journey-planner'].events.length, 1);
    const seededRows = pushes.find(([id]) => id === seeded.activityID)[1].arrivals;
    assert.equal(seededRows.length, 4);
    assert.equal(seededRows.filter((r) => r.plannedSourceID === 'timetable').length, 3);
    assert.equal(seededRows.filter((r) => r.plannedSourceID === 'journey-planner').length, 1);
    assert.deepEqual(selectEvents(a.stationBoardCache, seeded, now).map((e) => e.id), a.stationBoardCache.sources.timetable.events.map((e) => e.id));
    assert.equal(pushes.find(([id]) => id === plain.activityID)[1].arrivals.length, 1);
    assert.equal(new Set(requests).size, requests.length);
    assert.equal(requests.length, 6);
    let reads = 0;
    await runLiveActivityWorkerCycle({ store, config, cacheOnly: true, now: new Date(now + 121000), clock: () => now + 121000, fetchImpl: async () => { reads++; }, pushImpl: async () => {}, logger });
    assert.equal(reads, 0);
  });
  test(`record-scoped worker retains different client qualification and own closure, reverse=${reverse}`, async (t) => {
    const a = { ...record, plannedContextSeed: seed() }, b = { ...record, activityID: 'synthetic-B', installID: 'synthetic-install-B', plannedContextSeed: seed(10) };
    const store = await storeFor(t, reverse ? [b, a] : [a, b]);
    await store.retainStationBoard(a.activityID, a.environment, { closureSources: { station: { stationID: a.stationID, lineID: a.lineID, observedAt: now - 10000, expiresAt: now + 60000, closed: true } } }, new Date(now));
    const requests = [];
    const fetchImpl = async (url) => { const u = new URL(url); requests.push(u.pathname); const value = u.pathname.includes('JourneyResults') ? journey() : []; return new Response(JSON.stringify(value), { headers: { ...headers(now - 20000), 'x-amz-meta-sha256': 'a'.repeat(64) } }); };
    await runLiveActivityWorkerCycle({ store, config, now: new Date(now), clock: () => now, fetchImpl, pushImpl: async () => {}, logger });
    const ca = store.state.records.find((r) => r.activityID === a.activityID).stationBoardCache, cb = store.state.records.find((r) => r.activityID === b.activityID).stationBoardCache;
    assert.equal(ca.closureSources.station.closed, true);
    assert.equal(selectEvents(ca, a, now).length, 0);
    assert.equal(cb.closureSources.station.closed, false);
    assert.deepEqual(cb.sources.timetable.events.map((e) => e.id), seed(10).contexts[0].rows.map((e) => e.id));
    assert.equal(cb.sources.timetable.events[0].time, now + 180000);
    assert.equal(new Set(requests).size, requests.length);
  });
  test(`record-scoped Shenfield selections admit Platform2 facts independently of Platform5 clock, reverse=${reverse}`, async (t) => {
    const five = { ...record, stationID: '910GSHENFLD', lineID: 'elizabeth', selectionMode: 'platform', platformID: 'Platform5', platformLabel: '5', platformDirection: 'Westbound' }, two = { ...five, activityID: 'synthetic-B', installID: 'synthetic-install-B', platformID: 'Platform2', platformLabel: '2' };
    const store = await storeFor(t, reverse ? [two, five] : [five, two]), requests = [];
    const fetchImpl = async (url) => { const u = new URL(url); requests.push(u.pathname); const value = u.pathname.endsWith('ArrivalDepartures') ? [{ naptanId: five.stationID, destinationNaptanId: '910GLIVSTLL', destinationName: 'Liverpool Street', estimatedTimeOfDeparture: new Date(now + 90000).toISOString(), departureStatus: 'OnTime', platformName: 'Westbound - Platform 5' }] : u.pathname === '/Line/elizabeth/Arrivals' ? [{ id: 'fact', vehicleId: '123', lineId: 'elizabeth', naptanId: '910GBRTWOOD', stationName: 'Brentwood', destinationNaptanId: '910GLIVSTLL', destinationName: 'Liverpool Street', towards: 'Liverpool Street', currentLocation: 'At Shenfield Platform 2', timestamp: new Date(now).toISOString(), timing: { read: new Date(now).toISOString() }, expectedArrival: new Date(now + 180000).toISOString(), direction: 'Westbound' }] : []; return new Response(JSON.stringify(value), { headers: headers() }); };
    await runLiveActivityWorkerCycle({ store, config, now: new Date(now), clock: () => now, fetchImpl, pushImpl: async () => {}, logger });
    const rows = (r) => selectEvents(store.state.records.find((x) => x.activityID === r.activityID).stationBoardCache, r, now);
    assert.equal(rows(five)[0].timeEvidence, 'predictedDeparture');
    assert.equal(rows(two)[0].kind, 'outgoingDestinationOnly');
    assert.equal(rows(two)[0].platform, 'Platform 2');
    assert.equal(rows(two)[0].time, null);
    assert.equal(new Set(requests).size, requests.length);
    assert.equal(requests.length, 6);
  });
}

test('public receipt freezes Date/Age freshness across late consumers and source expiry', async () => {
  const r = { ...record, stationID: '910GSHENFLD', lineID: 'elizabeth' }, shared = new Map(); let at = now, reads = 0;
  const fetchImpl = async (url) => { reads++; const value = new URL(url).pathname.endsWith('ArrivalDepartures') ? [{ naptanId: r.stationID, destinationNaptanId: '910GLIVSTLL', destinationName: 'Liverpool Street', estimatedTimeOfDeparture: new Date(now + 180000).toISOString(), departureStatus: 'OnTime', platformName: '5' }] : []; return new Response(JSON.stringify(value), { headers: headers(now, 30, 90) }); };
  const first = await refreshStationBoard(r, {}, config, fetchImpl, now, null, () => at, shared);
  at = now + 20000; const second = await refreshStationBoard(r, {}, config, fetchImpl, now, null, () => at, shared);
  for (const cache of [first, second]) { assert.equal(cache.sources['rail-departures'].events[0].receivedAt, now - 30000); assert.equal(cache.sources['rail-departures'].events[0].expiresAt, now + 60000); }
  assert.equal(reads, 5);
  const receipt = await [...shared.values()][1]; assert.equal(receipt.completedAt, now); assert.equal(Object.isFrozen(receipt.value), true); assert.equal(Object.isFrozen(receipt.headers), true);
  assert.throws(() => { receipt.headers.age = '0'; }, TypeError);
  at = now + 61000; const expired = await refreshStationBoard(r, {}, config, fetchImpl, now, null, () => at, shared); assert.equal(expired.sources['rail-departures'], undefined); assert.equal(reads, 7); // New civil query minute and newly needed destination facts each have their own final URL.
});

test('public response promise coalesces concurrent parsing, missing-Age retry, failures and abort', async () => {
  let reads = 0, jsonReads = 0; const shared = new Map();
  const fetchImpl = async (url) => { reads++; const age = reads <= 4 ? undefined : '0'; return { ok: true, status: 200, headers: new Headers({ date: new Date(now).toUTCString(), ...(age ? { age } : {}), 'cache-control': 'max-age=120' }), async json() { jsonReads++; return []; } }; };
  await Promise.all([refreshStationBoard(record, {}, config, fetchImpl, now, null, () => now, shared), refreshStationBoard(record, {}, config, fetchImpl, now, null, () => now, shared)]);
  assert.equal(reads, 8); assert.equal(jsonReads, reads); assert.equal(shared.size, 5);
  const failures = new Map(); let attempts = 0; const offline = async () => { attempts++; throw new Error('offline'); };
  await Promise.all([refreshStationBoard(record, {}, config, offline, now, null, () => now, failures), refreshStationBoard(record, {}, config, offline, now, null, () => now, failures)]); assert.equal(attempts, 5);
  const controller = new AbortController(); controller.abort(new Error('root-cycle-aborted')); await assert.rejects(refreshStationBoard(record, {}, config, offline, now, controller.signal), /root-cycle-aborted/);
});

test('predicted-only rail preserves proven separate fragments and scheduled context before compact limit', () => {
  const r = { ...record, stationID: '910GWCHAPXR', lineID: 'elizabeth' };
  const base = { stationID: r.stationID, lineID: r.lineID, destination: 'Paddington', destinationStationID: '910GPADTLL' };
  const rail = event('rail-a', { ...base, sourceID: 'rail-departures', timeEvidence: 'predictedDeparture', platform: 'Platform 5', time: now + 120000 }), railB = { ...rail, id: 'rail-b', time: now + 121000 };
  const through = (id, extra = {}) => event(id, { ...base, sourceID: 'station-arrivals', kind: 'throughArrival', timeEvidence: 'arrivalPrediction', time: now + 60000, ...extra });
  const scheduled = { ...rail, id: 'scheduled', timeEvidence: 'scheduledDeparture' };
  assert.deepEqual(selectEvents(context(through('through'), scheduled), r, now).map((e) => e.id), ['through', 'scheduled']);
  const separate = [through('platform2', { platform: '2' }), through('stratford', { destination: 'Stratford', destinationStationID: '910GSTFD' }), through('later', { time: now + 122000 })];
  assert.equal(selectEvents(context(...separate, rail, railB), r, now).length, 5);
  for (const platform of [null, 'Platform unknown', 'Platform 2 or 5', 'Platform 2/5', 'Platform 2 or Platform 5']) assert.equal(selectEvents(context(through('overlap', { platform }), rail, railB), r, now).length, 2);
  assert.equal(selectEvents(context(...separate, rail), { ...r, selectionMode: 'platform', platformID: '2', platformLabel: '2' }, now)[0].id, 'platform2');
  const expired = { ...rail, expiresAt: now + 10000 }; assert.equal(selectEvents(context(through('restored'), expired), r, now + 10000)[0].id, 'restored');
  const bank = event('bank', { sourceID: 'rail-departures', timeEvidence: 'predictedDeparture', via: 'Bank', time: now + 120000 }), cross = through('cross', { stationID: record.stationID, lineID: record.lineID, destination: 'Morden', destinationStationID: '940GZZLUMDN', via: 'Charing Cross' });
  assert.equal(selectEvents(context(bank, cross), record, now).length, 2);
  assert.equal(STATION_BOARD_STATIONS.has('940GZZLUCHX'), true);
});

test('current exact Closure alias blocks scheduled sources; foreign/future/Part Closure does not', async () => {
  for (const variant of ['Closure', 'Part Closure', 'foreign', 'future']) {
    const fetchImpl = async (url) => { const p = new URL(url).pathname; const value = p.endsWith('/Disruption') ? [{ stationAtcoCode: variant === 'foreign' ? '940GZZLUMDN' : record.stationID, type: variant === 'Part Closure' ? variant : 'Closure', fromDate: new Date(now + (variant === 'future' ? 10000 : -10000)).toISOString(), toDate: new Date(now + 20000).toISOString() }] : p.includes('JourneyResults') ? journey() : []; return new Response(JSON.stringify(value), { headers: headers() }); };
    const cache = await refreshStationBoard(record, context(event('existing-plan')), config, fetchImpl, now, null);
    assert.equal(selectEvents(cache, record, now).length === 0, variant === 'Closure');
    if (variant === 'Closure') { assert.equal(cache.closureSources.station.expiresAt, now + 20000); assert.equal(cache.rejections.length, 0); assert.ok(cache.sources['journey-planner']); assert.equal(selectEvents(cache, record, now).length, 0); }
  }
});

test('independent direction eligibility uses shared raw receipts without leaking first selection', async (t) => {
  const outbound = { ...record, selectionMode: 'platform', platformID: 'Outbound', platformHeading: 'Outbound', platformDirection: 'Outbound' }, inbound = { ...outbound, activityID: 'synthetic-B', installID: 'synthetic-install-B', platformID: 'Inbound', platformHeading: 'Inbound', platformDirection: 'Inbound' };
  for (const order of [[outbound, inbound], [inbound, outbound]]) {
    const store = await storeFor(t, order), requests = [];
    const fetchImpl = async (url) => { const p = new URL(url).pathname; requests.push(p); const value = p === `/StopPoint/${record.stationID}/Arrivals` ? ['Outbound', 'Inbound'].map((direction) => ({ id: direction, lineId: record.lineID, naptanId: record.stationID, destinationName: 'Morden', destinationNaptanId: '940GZZLUMDN', expectedArrival: new Date(now + 60000).toISOString(), timestamp: new Date(now).toISOString(), direction })) : []; return new Response(JSON.stringify(value), { headers: headers() }); };
    await runLiveActivityWorkerCycle({ store, config, now: new Date(now), clock: () => now, fetchImpl, pushImpl: async () => {}, logger });
    for (const r of order) { const events = selectEvents(store.state.records.find((x) => x.activityID === r.activityID).stationBoardCache, r, now); assert.equal(events.length, 1); assert.equal(events[0].providerDirection, r.platformDirection); }
    assert.equal(requests.length, 4); assert.equal(new Set(requests).size, requests.length);
  }
});

test('slow parallel source cannot retime an earlier Age-dominant rail receipt', async () => {
  const r = { ...record, stationID: '910GSHENFLD', lineID: 'elizabeth' }; let at = now;
  const fetchImpl = async (url) => {
    const p = new URL(url).pathname;
    if (p.endsWith('/Status')) { await new Promise((resolve) => setTimeout(resolve, 10)); at = now + 70000; }
    const value = p.endsWith('ArrivalDepartures') ? [{ naptanId: r.stationID, destinationNaptanId: '910GLIVSTLL', destinationName: 'Liverpool Street', estimatedTimeOfDeparture: new Date(now + 180000).toISOString(), departureStatus: 'OnTime', platformName: '5' }] : [];
    return new Response(JSON.stringify(value), { headers: headers(now, 30, 90) });
  };
  const shared = new Map(), cache = await refreshStationBoard(r, {}, config, fetchImpl, now, null, () => at, shared);
  const receipt = await [...shared.entries()].find(([key]) => key.includes('ArrivalDepartures'))[1];
  assert.equal(receipt.completedAt, now); assert.equal(cache.sources['rail-departures'], undefined);
});

test('shared closure receipt retains original authority and applicable end at later consumers', async () => {
  const shared = new Map(); let at = now;
  const fetchImpl = async (url) => { const p = new URL(url).pathname; const value = p.endsWith('/Disruption') ? [{ stationAtcoCode: record.stationID, type: 'Closure', fromDate: new Date(now - 10000).toISOString(), toDate: new Date(now + 40000).toISOString() }] : p.includes('JourneyResults') ? journey() : []; return new Response(JSON.stringify(value), { headers: headers(now, 30, 120) }); };
  const first = await refreshStationBoard(record, {}, config, fetchImpl, now, null, () => at, shared);
  at = now + 20000; const second = await refreshStationBoard(record, {}, config, fetchImpl, now, null, () => at, shared);
  for (const cache of [first, second]) { assert.equal(cache.closureSources.station.observedAt, now - 30000); assert.equal(cache.closureSources.station.expiresAt, now + 40000); assert.equal(selectEvents(cache, record, at).length, 0); }
  at = now + 41000; const ended = await refreshStationBoard(record, {}, config, fetchImpl, now, null, () => at, shared); assert.equal(ended.closureSources.station, undefined); assert.equal(selectEvents(ended, record, at).length, 1);
});

for (const reverse of [false, true]) {
  test(`record-specific publication corroboration cannot transfer another seed SHA or rejection, reverse=${reverse}`, async (t) => {
    const secondSeed = seed(10); secondSeed.contexts[0].publication.sha256 = 'd'.repeat(64);
    const a = { ...record, plannedContextSeed: seed() }, b = { ...record, activityID: 'synthetic-B', installID: 'synthetic-install-B', plannedContextSeed: secondSeed };
    const store = await storeFor(t, reverse ? [b, a] : [a, b]), requests = [];
    const fetchImpl = async (url, options) => { const p = new URL(url).pathname; requests.push(`${options.method || 'GET'}:${p}`); return new Response(JSON.stringify(p.includes('JourneyResults') ? journey() : []), { headers: { ...headers(), 'x-amz-meta-sha256': 'a'.repeat(64) } }); };
    await runLiveActivityWorkerCycle({ store, config, now: new Date(now), clock: () => now, fetchImpl, pushImpl: async () => {}, logger });
    const ca = store.state.records.find((r) => r.activityID === a.activityID).stationBoardCache, cb = store.state.records.find((r) => r.activityID === b.activityID).stationBoardCache;
    assert.equal(ca.sources.timetable.evidence.publication.sha256, 'a'.repeat(64)); assert.equal(ca.sources.timetable.events.length, 3); assert.equal(ca.rejections.length, 0);
    assert.equal(cb.sources.timetable, undefined); assert.equal(cb.rejections[0].reason, 'publicationChanged'); assert.equal(cb.sources['journey-planner'].events.length, 1);
    assert.equal(requests.filter((p) => p.startsWith('HEAD:')).length, 1); assert.equal(new Set(requests).size, requests.length);
  });
}

test('one public body cap is shared across concurrent consumers without fanout or adopted payload', async () => {
  const shared = new Map(); let reads = 0, jsonReads = 0;
  const fetchImpl = async () => { reads++; return { ok: true, status: 200, headers: new Headers(headers()), async json() { jsonReads++; return [{ oversized: 'x'.repeat(2000001) }]; } }; };
  const caches = await Promise.all([refreshStationBoard(record, {}, config, fetchImpl, now, null, () => now, shared), refreshStationBoard(record, {}, config, fetchImpl, now, null, () => now, shared)]);
  assert.equal(reads, 5); assert.equal(jsonReads, 5); assert.equal(shared.size, 5);
  for (const cache of caches) assert.deepEqual(cache.sources, {});
});

test('conditional facts latency uses final closure applicability without renewing any source clock', async () => {
  for (const variant of ['ended', 'still-active', 'newly-active', 'availability-expired']) {
    let at = now;
    const fetchImpl = async (url) => {
      const p = new URL(url).pathname;
      if (p === '/Line/northern/Arrivals') { await Promise.resolve(); at = now + 20000; }
      const value = p.endsWith('/Disruption') ? [{ stationAtcoCode: record.stationID, type: 'Closure', fromDate: new Date(now + (variant === 'newly-active' ? 10000 : -10000)).toISOString(), toDate: new Date(now + (variant === 'ended' ? 10000 : 30000)).toISOString() }] : p.includes('JourneyResults') ? journey() : [];
      return new Response(JSON.stringify(value), { headers: headers(now, 0, variant === 'availability-expired' && p.endsWith('/Disruption') ? 10 : 120) });
    };
    const retained = context(event('original-plan', { time: now + 120000 }));
    const cache = await refreshStationBoard(record, retained, config, fetchImpl, now, null, () => at);
    assert.equal(at, now + 20000);
    if (variant === 'ended' || variant === 'availability-expired') {
      assert.equal(cache.closureSources.station, undefined);
      assert.equal(cache.rejections.length, 0);
      assert.equal(cache.sources['journey-planner'].events.length, 1);
      assert.equal(cache.sources['journey-planner'].events[0].receivedAt, now);
      assert.equal(cache.sources['journey-planner'].events[0].expiresAt, now + 120000);
      assert.equal(cache.sources['journey-planner'].events[0].time, now + 120000);
    } else {
      assert.equal(cache.closureSources.station.closed, true);
      assert.equal(cache.closureSources.station.observedAt, now);
      assert.equal(cache.closureSources.station.expiresAt, now + 30000);
      assert.equal(cache.rejections.length, 0);
      assert.ok(cache.sources['journey-planner']); assert.deepEqual(selectEvents(cache, record, at), []);
    }
  }
});
