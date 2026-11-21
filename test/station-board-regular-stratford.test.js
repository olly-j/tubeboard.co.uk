import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import os from "node:os";
import path from "node:path";
import { buildStationBoardState, mergeContexts, refreshStationBoard, selectEvents } from '../server/station-board-v2.js';
import { LiveActivityStore, loadConfig, runLiveActivityWorkerCycle, validateTokenPayload } from '../server/live-activity.js';

// Window of the exact TfL Saturday response from 2026-11-21 18:31:58 UTC.
// Full response SHA256 c023fd0c18abdea7b26b7e2742667aba532050c90687aa6425d6614ab35bc514.
const timetable = JSON.parse(fs.readFileSync(new URL('./fixtures/stratford-jubilee-20261121-window.json', import.meta.url)));
const now = Date.parse('2026-11-21T18:31:58Z');
const record = { stationID: '940GZZLUSTD', lineID: 'jubilee', selectionMode: 'allPlatforms', plannedPresentationVersion: 2, supportsRegularTimetable: true };
const config = loadConfig({});
const direct = '/Line/jubilee/Timetable/940GZZLUSTD';
const headers = { Date: new Date(now).toUTCString(), Age: '10625', 'Cache-Control': 'public, max-age=43200' };
const reply = (body, h = headers) => new Response(JSON.stringify(body), { headers: h });
function fixture({ limited = false, closed = false } = {}) {
  const requests = [];
  const fetch = async url => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === direct) return limited ? new Response(null, { status: 429, headers: { 'Retry-After': '480' } }) : reply(timetable);
    if (closed && path.includes('/Status')) return reply([{ id: 'jubilee', lineStatuses: [{
      statusSeverity: 16, statusSeverityDescription: 'Suspended',
      validityPeriods: [{ fromDate: '2026-11-21T18:30:00Z', toDate: '2026-11-21T18:40:00Z' }],
    }] }], { ...headers, Date: new Date(now + 90000).toUTCString(), Age: '0' });
    return new Response(null, { status: 503 });
  };
  return { requests, fetch };
}

test('a real ordinary Stratford Saturday provides only exact-origin scheduled rows through dated and control outages', async () => {
  const { fetch, requests } = fixture();
  const cache = await refreshStationBoard(record, {}, config, fetch, now, null);
  const rows = selectEvents(cache, record, now);
  assert.deepEqual(rows.map(row => row.destinationStationID), ['940GZZLUWYP', '940GZZLUSTM', '940GZZLUSTM', '940GZZLUSTM']);
  assert.equal(rows[0].time, Date.parse('2026-11-21T18:33:00Z'));
  assert.equal(rows[0].receivedAt, now - 10625000);
  assert.equal(rows[0].expiresAt, now + 600000);
  assert.equal(requests.filter(path => path === direct).length, 1);
  assert.equal(buildStationBoardState(record, cache, now).arrivals[0].plannedSourceID, 'regular-timetable');
  assert.deepEqual(selectEvents(cache, { ...record, supportsRegularTimetable: undefined }, now), []);
  assert.deepEqual(selectEvents(cache, { ...record, selectionMode: 'platform', platformID: '2' }, now), []);
  assert.deepEqual(selectEvents(cache, record, now + 600000), []);
  const live = { ...rows[1], id: 'live', sourceID: 'station-arrivals', timeEvidence: 'predictedDeparture', receivedAt: now };
  const mixed = mergeContexts(cache, { sources: { 'station-arrivals': { observedAt: now, events: [live] } } }, record, now);
  assert.deepEqual(selectEvents(mixed, record, now).map(row => row.destinationStationID), ['940GZZLUWYP', '940GZZLUSTM']);
});

test('Stratford ordinary timetable withholds on closure and honors a shared 429 floor', async () => {
  const first = fixture();
  const cache = await refreshStationBoard(record, {}, config, first.fetch, now, null);
  const closed = fixture({ closed: true });
  const afterClosure = await refreshStationBoard(record, cache, config, closed.fetch, now + 90000, null);
  assert.deepEqual(selectEvents(afterClosure, record, now + 90000), []);
  assert.equal(afterClosure.rejections.some(marker => marker.reason === 'regularSourceWithdrawn'), false);
  assert.equal(closed.requests.includes(direct), false);
  const limited = fixture({ limited: true });
  const afterLimit = await refreshStationBoard(record, {}, config, limited.fetch, now, null);
  assert.equal(afterLimit.ordinaryNotBefore, now + 480000);
  await refreshStationBoard(record, afterLimit, config, limited.fetch, now + 90000, null);
  assert.equal(limited.requests.filter(path => path === direct).length, 1);
});

test('an equal or older cached observation cannot replace a still-valid ordinary source', async () => {
  const { fetch } = fixture();
  const cache = await refreshStationBoard(record, {}, config, fetch, now, null);
  const source = cache.sources['regular-timetable'];
  for (const delta of [0, -1000]) {
    const earlier = { ...source, observedAt: source.observedAt + delta, events: [source.events[1]] };
    const merged = mergeContexts(cache, { sources: { 'regular-timetable': earlier } }, record, now);
    assert.deepEqual(merged.sources['regular-timetable'], source);
  }
});

test('the regular capability is true-only on a qualified typed registration', () => {
  const registration = { ...record, activityID: 'synthetic-stratford', installID: 'synthetic-device',
    pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(now).toISOString(),
    appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.2.6', buildNumber: '1',
    environment: 'sandbox', contentStateContract: 'station-board-v2' };
  assert.equal(validateTokenPayload(registration, new Date(now)).value.supportsRegularTimetable, true);
  for (const rejected of [false, 'true', 1, null]) {
    assert.equal(validateTokenPayload({ ...registration, supportsRegularTimetable: rejected }, new Date(now)).ok, false);
  }
  assert.equal(validateTokenPayload({ ...registration, plannedPresentationVersion: undefined }, new Date(now)).ok, false);
  assert.equal(validateTokenPayload({ ...registration, supportsRegularTimetable: undefined }, new Date(now)).value.supportsRegularTimetable, undefined);
});

test('the generated origin map replays Epping, Edgware and the proved Edgware Road starting path', async () => {
  const captures = JSON.parse(fs.readFileSync(new URL('./fixtures/regular-timetable-additional-origins.json', import.meta.url)));
  const at = Date.parse('2026-11-21T19:47:00Z');
  const expected = new Map([
    ['central', { station: '940GZZLUEPG', count: 3, first: '940GZZLUWRP', minutes: 8 }],
    ['circle', { station: '940GZZLUERC', count: 2, first: '940GZZLUHSC', minutes: 8 }],
    ['northern', { station: '940GZZLUEGW', count: 8, first: '940GZZLUMDN', minutes: 1 }],
  ]);
  for (const { body } of captures) {
    const answer = expected.get(body.lineId);
    const selected = { ...record, lineID: body.lineId, stationID: answer.station };
    const feed = async url => new URL(url).pathname === '/Line/' + selected.lineID + '/Timetable/' + selected.stationID
      ? reply(body, { ...headers, Date: new Date(at).toUTCString(), Age: '60' }) : new Response(null, { status: 503 });
    const cache = await refreshStationBoard(selected, {}, config, feed, at, null);
    const rows = selectEvents(cache, selected, at);
    assert.equal(rows.length, answer.count, body.lineId);
    assert.equal(rows[0]?.destinationStationID, answer.first);
    assert.equal(rows[0]?.time, at + answer.minutes * 60000);
    if (body.lineId === 'northern') assert.deepEqual([...new Set(rows.map(row => row.via))].sort(), ['Bank', 'Charing Cross']);
  }
});

test('unrelated, future and stale control text cannot revoke an already qualified regular board', async () => {
  const cache = await refreshStationBoard(record, {}, config, fixture().fetch, now, null);
  const at = now + 90000;
  for (const [line, validFrom, age] of [
    ['central', '2026-11-21T18:30:00Z', '0'],
    ['jubilee', '2026-11-21T18:45:00Z', '0'],
    ['jubilee', '2026-11-21T18:30:00Z', '150'],
  ]) {
    const fetch = async url => new URL(url).pathname.includes('/Status') ? reply([{ id: line, lineStatuses: [{
      statusSeverity: 16, statusSeverityDescription: 'Suspended', reason: 'No service',
      validityPeriods: [{ fromDate: validFrom, toDate: '2026-11-21T19:00:00Z' }],
    }] }], { Date: new Date(at).toUTCString(), Age: age, 'Cache-Control': 'public,max-age=120' })
      : new Response(null, { status: 503 });
    const after = await refreshStationBoard(record, cache, config, fetch, at, null);
    assert.ok(selectEvents(after, record, at).length, line + ' ' + validFrom + ' ' + age);
    assert.equal(after.rejections.some(marker => marker.reason === 'regularSourceWithdrawn'), false);
  }
});

test('a fresh explicit exact-board dated cancellation retains its original clock', async () => {
  const cache = await refreshStationBoard(record, {}, config, fixture().fetch, now, null);
  const at = now + 90000;
  for (const caseName of ['wrong-line', 'old', 'fresh']) {
    const cancelled = {
      recommendedMaxAgeMinutes: 2, searchCriteria: { dateTimeType: 'Departing', dateTime: '2026-11-21T18:33:00' },
      journeys: [{ legs: [{ departurePoint: { naptanId: record.stationID }, isCancelled: true,
        routeOptions: [{ lineIdentifier: { id: caseName === 'wrong-line' ? 'central' : 'jubilee' } }] }] }],
    };
    const fetch = async url => new URL(url).pathname.includes('/Journey/') ? reply(cancelled, {
      Date: new Date(at).toUTCString(), Age: caseName === 'old' ? '150' : '12', 'Cache-Control': 'public,max-age=120',
    }) : new Response(null, { status: 503 });
    const after = await refreshStationBoard(record, cache, config, fetch, at, null);
    const marker = after.rejections.find(item => item.reason === 'regularSourceWithdrawn');
    if (caseName === 'fresh') {
      assert.equal(marker.observedAt, at - 12000);
      assert.deepEqual(selectEvents(after, record, at), []);
    } else assert.equal(marker, undefined);
  }
});

async function initialDisplayFixture(t, { hold = 45000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-regular-handoff-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const filename = path.join(dir, 'activities.json');
  const payload = { ...record, activityID: 'synthetic-stratford-handoff', installID: 'synthetic-lease-device',
    pushTokenHex: 'abcd'.repeat(16), tokenUpdatedAt: new Date(now).toISOString(),
    appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.2.6', buildNumber: '1', environment: 'sandbox',
    contentStateContract: 'station-board-v2', initialRegularDisplayUntil: new Date(now + hold).toISOString() };
  let store = new LiveActivityStore(filename);
  const push = [], deadlines = [];
  const register = async (value = payload, at = now) => {
    const parsed = validateTokenPayload(value, new Date(at));
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    return store.upsertToken(parsed.value, new Date(at));
  };
  const cycle = (at, fetchImpl = fixture().fetch, cacheOnly = false) => runLiveActivityWorkerCycle({
    store, config, now: new Date(at), clock: () => at, fetchImpl, cacheOnly, logger: { info() {}, warn() {} },
    pushImpl: async (_, body) => { push.push(body.aps['content-state']); },
    scheduleRolloverPush: (_, body) => { deadlines.push(body.nextBoardBoundaryAt); },
  });
  return { payload, register, cycle, push, deadlines, restart() { store = new LiveActivityStore(filename); } };
}

const allOutage = async () => new Response(null, { status: 503 });

test('initial outage holds only to the first immutable local deadline, across replay and restart', async t => {
  const f = await initialDisplayFixture(t);
  const first = await f.register();
  assert.equal(first.initialRegularDisplayUntil, new Date(now + 45000).toISOString());
  await f.cycle(now + 1000, allOutage);
  assert.equal(f.push.length, 0);
  assert.equal(f.deadlines.at(-1), now + 45000);
  const replay = { ...f.payload, initialRegularDisplayUntil: new Date(now + 240000).toISOString() };
  assert.equal((await f.register(replay, now + 2000)).initialRegularDisplayUntil, first.initialRegularDisplayUntil);
  f.restart();
  const rotated = { ...replay, tokenUpdatedAt: new Date(now + 3000).toISOString(), pushTokenHex: 'dcba'.repeat(16) };
  assert.equal((await f.register(rotated, now + 3000)).initialRegularDisplayUntil, first.initialRegularDisplayUntil);
  await f.cycle(now + 44999, allOutage, true);
  assert.equal(f.push.length, 0);
  await f.cycle(now + 45000, allOutage, true);
  assert.equal(f.push.length, 1);
  assert.equal(f.push[0].arrivals.length, 0);
});

test('qualified same-board content and active controls bypass the initial hold', async t => {
  for (const mode of ['regular', 'closure', 'cancelled']) {
    const f = await initialDisplayFixture(t);
    await f.register();
    const fetch = async url => {
      const p = new URL(url).pathname;
      const h = { Date: new Date(now + 1000).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=120' };
      if (mode === 'regular' && p === direct) return reply(timetable, h);
      if (mode === 'closure' && p.includes('/Status')) return reply([{ id: 'jubilee', lineStatuses: [{
        statusSeverity: 16, statusSeverityDescription: 'Suspended',
        validityPeriods: [{ fromDate: '2026-11-21T18:30:00Z', toDate: '2026-11-21T18:40:00Z' }],
      }] }], h);
      if (mode === 'cancelled' && p.includes('/Journey/')) return reply({
        recommendedMaxAgeMinutes: 2, searchCriteria: { dateTimeType: 'Departing', dateTime: '2026-11-21T18:31:00' },
        journeys: [{ legs: [{ departurePoint: { naptanId: record.stationID }, isCancelled: true,
          routeOptions: [{ lineIdentifier: { id: 'jubilee' } }] }] }],
      }, h);
      return allOutage();
    };
    await f.cycle(now + 1000, fetch);
    assert.equal(f.push.length, 1, mode);
    assert.equal(f.push[0].arrivals.length > 0, mode === 'regular', mode);
    await f.cycle(now + 1000, allOutage, true);
    assert.equal(f.push.length, 1, mode + ' exact cache duplicate');
  }
});

test('legacy registrations still send outage and eligible requests are capped by server and Activity expiry', async t => {
  const f = await initialDisplayFixture(t, { hold: 3600000 });
  const old = { ...f.payload, supportsRegularTimetable: undefined, initialRegularDisplayUntil: undefined };
  assert.equal(validateTokenPayload({ ...old, initialRegularDisplayUntil: f.payload.initialRegularDisplayUntil }, new Date(now)).ok, false);
  await f.register(old);
  await f.cycle(now + 1000, allOutage);
  assert.equal(f.push.length, 1);
  const capped = await f.register({ ...f.payload, activityID: 'synthetic-capped' });
  assert.equal(capped.initialRegularDisplayUntil, new Date(now + 600000).toISOString());
  const endsAt = new Date(now + 180000).toISOString();
  const ended = await f.register({ ...f.payload, activityID: 'synthetic-short', activityEndsAt: endsAt });
  assert.equal(ended.initialRegularDisplayUntil, endsAt);
});

test('a fresh through prediction can take over while a terminal arrival cannot', async t => {
  for (const destination of ['940GZZLUSTD', '940GZZLUSTM']) {
    const f = await initialDisplayFixture(t);
    await f.register();
    const at = now + 1000;
    const fetch = async url => new URL(url).pathname === '/StopPoint/940GZZLUSTD/Arrivals'
      ? reply([{ id: 'actual-shape', naptanId: record.stationID, lineId: record.lineID,
        destinationNaptanId: destination, expectedArrival: new Date(at + 60000).toISOString(),
        timestamp: new Date(at).toISOString(), platformName: 'Platform 2' }],
      { Date: new Date(at).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=30' })
      : allOutage();
    await f.cycle(at, fetch);
    if (destination === record.stationID) assert.equal(f.push.length, 0);
    else assert.equal(f.push[0]?.arrivals[0]?.timeEvidence, 'throughArrivalPrediction');
  }
});

test('the real Saturday 24:05 Circle loop shows Edgware Road via Paddington as a departure', async () => {
  const captures = JSON.parse(fs.readFileSync(new URL('./fixtures/regular-timetable-additional-origins.json', import.meta.url)));
  const circle = captures.find(({ body }) => body.lineId === 'circle').body;
  const selected = { ...record, lineID: 'circle', stationID: '940GZZLUERC' };
  const at = Date.parse('2026-11-22T00:04:00Z');
  const fetch = async url => new URL(url).pathname === '/Line/circle/Timetable/940GZZLUERC'
    ? reply(circle, { ...headers, Date: 'Sat, 21 Nov 2026 19:44:42 GMT', Age: '15558' }) : allOutage();
  const cache = await refreshStationBoard(selected, {}, config, fetch, at, null);
  const [loop] = selectEvents(cache, selected, at);
  assert.equal(loop.kind, 'outgoingDeparture');
  assert.equal(loop.destination, 'Edgware Road (Circle Line)');
  assert.equal(loop.via, 'Paddington');
  assert.equal(loop.time, at + 60000);
  assert.equal(buildStationBoardState(selected, cache, at).arrivals[0].via, 'Paddington');
});

test('a new regular HTTP observation cannot resurrect a dated cancellation before its departure', async () => {
  const scheduled = now + 28 * 60000;
  const cancelled = {
    recommendedMaxAgeMinutes: 2, searchCriteria: { dateTimeType: 'Departing', dateTime: '2026-11-21T18:31:00' },
    journeys: [{ legs: [{ departurePoint: { naptanId: record.stationID }, isCancelled: true,
      scheduledDepartureTime: new Date(scheduled).toISOString(), routeOptions: [{ lineIdentifier: { id: 'jubilee' } }] }] }],
  };
  const fetch = async url => new URL(url).pathname.includes('/Journey/')
    ? reply(cancelled, { ...headers, Age: '0', 'Cache-Control': 'public,max-age=120' }) : allOutage();
  const negative = await refreshStationBoard(record, {}, config, fetch, now, null);
  const marker = negative.rejections.find(item => item.reason === 'regularSourceWithdrawn');
  assert.equal(marker.regularWithdrawalUntil, scheduled);
  const at = now + 15 * 60000;
  const source = { observedAt: at, events: [{
    id: 'new-http-observation', stationID: record.stationID, lineID: record.lineID,
    sourceID: 'regular-timetable', kind: 'outgoingDeparture', timeEvidence: 'scheduledDeparture',
    destination: 'Stanmore', destinationStationID: '940GZZLUSTM', time: scheduled + 30000,
    receivedAt: at, expiresAt: scheduled + 120000,
  }] };
  const updated = { sources: { 'regular-timetable': source } };
  assert.deepEqual(selectEvents(mergeContexts(negative, updated, record, at), record, at), []);
  assert.deepEqual(selectEvents(mergeContexts(negative, updated, record, scheduled), record, scheduled), []);
  assert.deepEqual(selectEvents(mergeContexts(negative, updated, record, scheduled + 1), record, scheduled + 1), source.events);
});

test('the real DLR family disruption does not suppress Stratford Jubilee regular departures', async () => {
  const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/stratford-20261121-station-family-disruptions.json', import.meta.url)));
  const at = Date.parse('2026-11-21T20:18:27Z');
  const originalHeaders = { Date: new Date(at).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=120' };
  const timetableHeaders = { ...headers, Age: '17014' };
  for (const wholeStationClosed of [false, true]) {
    let directReads = 0;
    const disruptions = [...evidence.stationDisruption];
    if (wholeStationClosed) disruptions.push({
      stationAtcoCode: record.stationID, type: 'StationClosure',
      fromDate: '2026-11-21T20:00:00Z', toDate: '2026-11-21T21:00:00Z',
    });
    const fetch = async url => {
      const name = new URL(url).pathname;
      if (name === direct) { directReads++; return reply(timetable, timetableHeaders); }
      if (name.includes('/Status')) return reply(evidence.status, originalHeaders);
      if (name.includes('/Disruption')) return reply(disruptions, originalHeaders);
      return allOutage();
    };
    const cache = await refreshStationBoard(record, {}, config, fetch, at, null);
    const departures = selectEvents(cache, record, at);
    if (wholeStationClosed) {
      assert.equal(directReads, 0);
      assert.deepEqual(departures, []);
    } else {
      assert.equal(directReads, 1);
      assert.deepEqual(departures.slice(0, 2).map(row => [row.destination, new Date(row.time).toISOString()]), [
        ['Stanmore', '2026-11-21T20:20:00.000Z'], ['Wembley Park', '2026-11-21T20:23:00.000Z']
      ]);
      assert.ok(departures.every(row => row.sourceID === 'regular-timetable' && row.time > at));
    }
  }
});

test('the real Circle PAH journey cannot hide the independent PAC starter', async () => {
  // Same trimmed originals used by the handset integration replay at 1d6f957c.
  const journey = JSON.parse(fs.readFileSync(new URL('./fixtures/circle-edgware-road-journey-2032.json', import.meta.url)));
  const directSource = JSON.parse(fs.readFileSync(new URL('./fixtures/circle-edgware-road-direct-2032.json', import.meta.url)));
  const at = Date.parse('2026-11-21T20:32:54Z');
  const selected = { ...record, lineID: 'circle', stationID: '940GZZLUERC' };
  const original = { Date: new Date(at).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=150' };
  const timetableHeaders = { ...original, Date: 'Sat, 21 Nov 2026 19:44:42 GMT', 'Cache-Control': 'public,max-age=43200' };
  for (const directAvailable of [true, false]) {
    const fetch = async url => {
      const path = new URL(url).pathname;
      if (path.includes('/Journey/')) return reply(journey, original);
      if (path === '/Line/circle/Timetable/940GZZLUERC' && directAvailable) return reply(directSource, timetableHeaders);
      return allOutage();
    };
    const cache = await refreshStationBoard(selected, {}, config, fetch, at, null);
    const [through] = cache.sources['journey-planner'].events;
    assert.equal(through.time, Date.parse('2026-11-21T20:38:00Z'));
    assert.equal(through.nextScheduledStopID, '940GZZLUPAH');
    assert.equal(through.expiresAt, at + 60000);
    const visible = selectEvents(cache, selected, at);
    assert.deepEqual(visible.map(row => row.time), directAvailable
      ? ['2026-11-21T20:35:00Z', '2026-11-21T20:45:00Z'].map(Date.parse) : []);
    assert.ok(visible.every(row => row.sourceID === 'regular-timetable' && row.platform === null));
    const state = buildStationBoardState(selected, cache, at);
    assert.ok(state.arrivals.every(row => row.plannedSourceID === 'regular-timetable' && row.originQualified));
    const legacy = selectEvents(cache, { ...selected, supportsRegularTimetable: undefined }, at);
    assert.deepEqual(legacy.map(row => row.id), [through.id]);
  }
});

test('unqualified selected Service Closed blocks ordinary requests without affecting foreign or expired controls', async () => {
  for (const [lineID, statusLine, age, blocked] of [
    ['jubilee', 'jubilee', '10', true],
    ['jubilee', 'jubilee', '130', false],
    ['dlr', 'dlr', '10', false],
    ['jubilee', 'dlr', '10', false],
  ]) {
    let directReads = 0;
    const fetch = async url => {
      const pathname = new URL(url).pathname;
      if (pathname === direct) { directReads++; return reply(timetable); }
      if (pathname.includes('/Status')) return reply([{ id: lineID, modeName: lineID === 'dlr' ? 'dlr' : 'tube',
        lineStatuses: [{ lineId: statusLine, statusSeverity: 20, statusSeverityDescription: 'Service Closed' }]
      }], { Date: new Date(now).toUTCString(), Age: age, 'Cache-Control': 'public,max-age=120' });
      return allOutage();
    };
    const result = await refreshStationBoard(record, {}, config, fetch, now, null);
    assert.equal(directReads, blocked ? 0 : 1, [lineID, statusLine, age].join('/'));
    assert.equal(selectEvents(result, record, now).length > 0, !blocked);
    assert.equal(result.rejections.some(item => item.reason === 'regularSourceWithdrawn'), false);
    if (blocked) assert.equal(result.availabilityProofs[0].observedAt, now - 10000);
  }
});
