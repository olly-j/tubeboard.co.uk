import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import os from "node:os";
import path from "node:path";
import { buildStationBoardState, compactEvents, mergeContexts, refreshStationBoard, selectEvents } from '../server/station-board-v2.js';
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

test('current and retained useful Stratford live evidence prevent an ordinary request', async () => {
  const feed = async (url, at, kind) => {
    const endpoint = new URL(url).pathname;
    if (endpoint === direct) return reply(timetable);
    if (endpoint !== '/StopPoint/940GZZLUSTD/Arrivals' || !kind) return allOutage();
    return reply([{ id: 'synthetic-actual-shape', naptanId: record.stationID, lineId: record.lineID,
      destinationNaptanId: kind === 'through' ? '940GZZLUSTM' : record.stationID,
      expectedArrival: new Date(at + 110000).toISOString(), timestamp: new Date(at).toISOString(),
      platformName: 'Platform 2' }],
    { Date: new Date(at).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=30' });
  };
  const read = async (at, previous, kind, expectedDirectReads) => {
    const requests = [];
    const result = await refreshStationBoard(record, previous, config, url => {
      requests.push(new URL(url).pathname);
      return feed(url, at, kind);
    }, at, null);
    assert.equal(requests.filter(request => request === direct).length, expectedDirectReads);
    return result;
  };
  const live = await read(now, {}, 'through', 0);
  const retained = await read(now + 90000, live, null, 0);
  assert.deepEqual(retained.sources['station-arrivals'], live.sources['station-arrivals']);
  const terminal = await read(now, {}, 'incoming', 1);
  assert.ok(terminal.sources['regular-timetable'], 'An incoming train does not answer the departure board');
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

test('the regular push board carries the next countdowns across London midnight with fresh authority', async () => {
  const before = Date.parse('2026-11-27T23:53:00Z');
  const midnight = Date.parse('2026-11-28T00:00:00Z');
  const body = structuredClone(timetable);
  const route = body.timetable.routes[0];
  const sample = route.schedules[0].knownJourneys[0];
  const journey = (hour, minute) => ({ ...sample, hour, minute });
  route.schedules = [
    { ...route.schedules[0], name: 'Friday', knownJourneys: [journey('24', '01'), journey('24', '11'), journey('24', '54')] },
    { ...route.schedules[0], name: 'Saturday', knownJourneys: [journey('00', '15')] },
  ];
  let timetableReads = 0;
  async function board(at) {
    const fetch = async url => {
      if (new URL(url).pathname !== direct) return new Response(null, { status: 503 });
      timetableReads++;
      return reply(body, { ...headers, Date: new Date(at).toUTCString(), Age: '0' });
    };
    return refreshStationBoard(record, {}, config, fetch, at, null);
  }
  const initial = await board(before);
  const rows = selectEvents(initial, record, before);
  assert.deepEqual(rows.map(row => (row.time - before) / 60000), [8, 18, 22]);
  assert.ok(rows.every(row => row.timeEvidence === 'scheduledDeparture' && row.expiresAt === midnight));
  assert.equal(selectEvents(initial, record, midnight).length, 0);
  const fresh = selectEvents(await board(midnight), record, midnight);
  assert.deepEqual(fresh.slice(0, 3).map(row => row.id), rows.map(row => row.id));
  assert.equal(timetableReads, 2);
  const pathKey = route.stationIntervals.find(interval => Number(interval.id) === sample.intervalId).intervals.map(stop => stop.stopId).join('>');
  const legacyID = 'regular:' + createHash('sha256').update(JSON.stringify(['2026-11-28', '1441|' + pathKey])).digest('hex');
  assert.equal(fresh[0].id, legacyID, 'a stored 24:01 working from the deployed service still matches');

  route.schedules[1].knownJourneys.unshift(journey('00', '01'));
  const overlap = selectEvents(await board(before), record, before);
  assert.deepEqual(overlap.map(row => row.id), rows.map(row => row.id), '24:01 and 00:01 on the same route are one countdown');
  route.schedules.pop();
  assert.deepEqual(selectEvents(await board(before), record, before).map(row => (row.time - before) / 60000), [8, 18]);
  route.schedules[0].name = 'Thursday';
  route.schedules[0].knownJourneys.unshift(journey('23', '57'));
  const christmasEve = Date.parse('2026-12-24T23:53:00Z');
  assert.deepEqual(selectEvents(await board(christmasEve), record, christmasEve).map(row => (row.time - christmasEve) / 60000), [4]);
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
  const cycle = (at, fetchImpl = fixture().fetch, cacheOnly = false, sourceOnly = false) => runLiveActivityWorkerCycle({
    store, config, now: new Date(at), clock: () => at, fetchImpl, cacheOnly, sourceOnly, logger: { info() {}, warn() {} },
    pushImpl: async (_, body) => { push.push(body.aps['content-state']); },
    scheduleRolloverPush: (_, body) => { deadlines.push(body.nextBoardBoundaryAt); },
  });
  const current = async at => (await store.listActive(new Date(at)))[0]?.stationBoardCache;
  return { payload, register, cycle, push, deadlines, current, filename, restart() { store = new LiveActivityStore(filename); } };
}

const allOutage = async () => new Response(null, { status: 503 });

// The original weekday intervals and clocks spanning the release 44 Edgware
// witness. The SHA and headers identify the full public response.
const edgware = JSON.parse(fs.readFileSync(new URL('./fixtures/edgware-regular-renewal-20261126.json', import.meta.url)));
const edgwarePath = '/Line/northern/Timetable/940GZZLUEGW';
const capturedAt = Date.parse(edgware.headers.Date);
const swifts = milliseconds => (milliseconds - Date.UTC(2001, 0, 1)) / 1000;
const clockLabel = row => new Date(row.expectedArrival * 1000 + Date.UTC(2001, 0, 1)).toISOString().slice(11, 16);
const regular = board => board?.sources?.['regular-timetable'];

function edgwareRead(at, observed, body = edgware.body) {
  return restore({ body, headers: { ...edgware.headers, Date: new Date(at).toUTCString(), Age: String((at - observed) / 1000) } });
}

async function activeEdgware(t) {
  const f = await initialDisplayFixture(t);
  await f.register({ ...f.payload, lineID: 'northern', stationID: '940GZZLUEGW',
    initialRegularDisplayUntil: undefined, tokenUpdatedAt: new Date(capturedAt).toISOString() }, capturedAt);
  const reads = [];
  const cycle = (offset, observed, body = edgware.body, cacheOnly = false, sourceOnly = false) => {
    const at = capturedAt + offset;
    return f.cycle(at, async url => {
      if (new URL(url).pathname !== edgwarePath) return allOutage();
      reads.push(at);
      return edgwareRead(at, observed, body);
    }, cacheOnly, sourceOnly);
  };
  return { ...f, reads, cycle };
}

test('an active Edgware timetable renews its on-wire validity before expiry after a skipped full cycle', async t => {
  for (const cdnAge of [0, 60000]) {
    const f = await activeEdgware(t);
    await f.cycle(0, capturedAt);
    const initial = f.push.at(-1);
    assert.equal(initial.updatedAt, swifts(capturedAt));
    const originalExpiry = capturedAt + 600000;
    assert.ok(initial.arrivals.every(row => row.expiresAt === swifts(originalExpiry)));

    await f.cycle(360000, capturedAt);
    await f.cycle(500000, capturedAt, edgware.body, true);
    await f.cycle(520000, capturedAt, edgware.body, false, true);
    assert.deepEqual(f.reads, [capturedAt], 'no early, cache-only or source-only ordinary read');
    const previousPushes = f.push.length;
    await f.cycle(540000, capturedAt - cdnAge);
    assert.deepEqual(f.reads, [capturedAt, capturedAt + 540000], 'renew before the original cutoff');
    assert.ok(f.push.length > previousPushes);
    const renewed = f.push.at(-1);
    assert.equal(renewed.updatedAt, initial.updatedAt, 'the cached source clock does not advance');
    const renewedExpiry = capturedAt + 1140000;
    assert.ok(renewed.arrivals.length > 0 && renewed.arrivals.every(row => row.expiresAt === swifts(renewedExpiry)));
    await f.cycle(601000, capturedAt, edgware.body, true);
    assert.equal(f.reads.length, 2);
    assert.ok(f.push.at(-1).arrivals.some(row => row.plannedSourceID === 'regular-timetable'));

    // A changed clock in an older receipt has no authority over the current
    // working. The same change is admissible in a strictly newer observation.
    const changed = structuredClone(edgware.body);
    const affected = changed.timetable.routes.flatMap(route => route.schedules)
      .flatMap(schedule => schedule.knownJourneys).find(row => row.hour === '16' && row.minute === '54');
    assert.ok(affected);
    affected.minute = '55';
    await f.cycle(990000, capturedAt - 60000, changed);
    const unchanged = regular(await f.current(capturedAt + 990000));
    assert.ok(unchanged?.events.length && unchanged.events.every(row => row.expiresAt === renewedExpiry));
    assert.ok(unchanged.events.some(row => new Date(row.time).toISOString().slice(11,16) === '16:54'));
    await f.cycle(1080000, capturedAt + 1080000, changed);
    const replaced = f.push.at(-1);
    assert.equal(replaced.updatedAt, swifts(capturedAt + 1080000));
    assert.equal(clockLabel(replaced.arrivals[0]), '16:55');
    assert.ok(!replaced.arrivals.some(row => clockLabel(row) === '16:54'));
  }
});

test('a previously rejected older timetable stays rejected through expiry and a store restart', async t => {
  const f = await activeEdgware(t);
  const older = structuredClone(edgware.body);
  const shifted = older.timetable.routes.flatMap(route => route.schedules)
    .flatMap(schedule => schedule.knownJourneys).find(row => row.hour === '16' && row.minute === '54');
  shifted.minute = '55';
  await f.cycle(0, capturedAt);
  await f.cycle(450000, capturedAt - 60000, older);
  await f.cycle(600000, capturedAt, edgware.body, true);
  f.restart();
  for (const [offset, observation] of [[601000, capturedAt - 60000], [700000, capturedAt]]) {
    await f.cycle(offset, observation, older);
    const cache = await f.current(capturedAt + offset);
    assert.deepEqual(selectEvents(cache, { ...record, lineID: 'northern', stationID: '940GZZLUEGW' }, capturedAt + offset), []);
  }
  await f.cycle(800000, capturedAt - 60000);
  assert.ok(f.push.at(-1).arrivals.some(row => clockLabel(row) === '16:54'));
  await f.cycle(1250000, capturedAt + 1250000, older);
  assert.ok(regular(await f.current(capturedAt + 1250000)).events.length > 0);
});

for (const emptyProfile of [false, true]) {
  test(`a newer ${emptyProfile ? 'empty profile' : 'timetable with later bookings'} withdraws the last countdown through restart`, async t => {
    const f = await activeEdgware(t);
    const changed = structuredClone(edgware.body);
    for (const route of changed.timetable.routes) {
      for (const schedule of route.schedules) schedule.knownJourneys = emptyProfile ? [] : schedule.knownJourneys.map(row => ({ ...row, hour: '20' }));
    }
    await f.cycle(0, capturedAt);
    assert.ok(f.push.at(-1).arrivals.length);
    await f.cycle(450000, capturedAt + 450000, changed);
    assert.deepEqual(f.push.at(-1).arrivals, []);
    f.restart();
    await f.cycle(600000, capturedAt);
    assert.deepEqual(f.push.at(-1).arrivals, []);
    await f.cycle(710000, capturedAt + 710000);
    assert.ok(f.push.at(-1).arrivals.some(row => row.plannedSourceID === 'regular-timetable'));
  });
}

for (const conflictingVia of [false, true]) {
  test(`${conflictingVia ? 'contradictory via stops' : 'unrecognised paths'} cannot withdraw a verified board or block its recovery`, async t => {
    const f = await activeEdgware(t);
    const unrecognised = structuredClone(edgware.body);
    for (const route of unrecognised.timetable.routes) {
      for (const interval of route.stationIntervals) {
        if (conflictingVia) interval.intervals.unshift({ stopId: '940GZZLUBNK' }, { stopId: '940GZZLUCHX' });
        else interval.intervals.at(-1).stopId = 'unknown';
      }
    }
    await f.cycle(0, capturedAt);
    const first = regular(await f.current(capturedAt));
    await f.cycle(450000, capturedAt + 450000, unrecognised);
    const kept = regular(await f.current(capturedAt + 450000));
    assert.equal(kept.observedAt, first.observedAt);
    assert.equal(kept.expiresAt, first.expiresAt);
    assert.ok(kept.events.length);
    await f.cycle(600000, capturedAt);
    assert.ok(regular(await f.current(capturedAt + 600000)).events.length);
  });
}

test('a worker crossing 23:00 renews the same body and keeps its first train past the original expiry', async t => {
  const firstRead = Date.parse('2026-11-27T22:55:00Z');
  const f = await initialDisplayFixture(t);
  const body = structuredClone(timetable);
  const route = body.timetable.routes[0];
  const schedule = route.schedules[0];
  const booked = (hour, minute) => ({ ...schedule.knownJourneys[0], hour, minute });
  route.schedules = [
    { ...schedule, name: 'Friday', knownJourneys: [booked('23','10'), booked('23','35'), booked('24','01')] },
    { ...schedule, name: 'Saturday', knownJourneys: [booked('00','01')] },
  ];
  await f.register({ ...f.payload, initialRegularDisplayUntil: undefined, tokenUpdatedAt: new Date(firstRead).toISOString() }, firstRead);
  for (const offset of [0, 420000, 600000]) {
    const at = firstRead + offset;
    await f.cycle(at, async url => new URL(url).pathname === direct
      ? reply(body, { ...headers, Date: new Date(at).toUTCString(), Age: String(offset / 1000) }) : allOutage(), offset === 600000);
  }
  const rows = f.push.at(-1).arrivals;
  assert.deepEqual(rows.map(clockLabel), ['23:10', '23:35', '00:01']);
  assert.ok(rows.every(row => row.expiresAt === swifts(firstRead + 1020000)));
});

test('an unchanged observed timetable keeps supplying its rolling tail past the initial hour', async t => {
  const f = await activeEdgware(t);
  for (let offset = 0; offset <= 3600000; offset += 450000) await f.cycle(offset, capturedAt);
  assert.equal(f.reads.length, 9);
  const rows = regular(await f.current(capturedAt + 3600000))?.events || [];
  assert.ok(rows.length > 0 && rows.every(row => row.time >= capturedAt + 3600000 && row.receivedAt === capturedAt));
  assert.ok(rows.some(row => row.expiresAt === capturedAt + 4200000));
  assert.ok(f.push.at(-1).arrivals.some(row => row.plannedSourceID === 'regular-timetable'));
});

async function legacyEdgware(t) {
  const f = await activeEdgware(t);
  await f.cycle(0, capturedAt);
  const persisted = JSON.parse(fs.readFileSync(f.filename, 'utf8'));
  const original = regular(persisted.records[0].stationBoardCache);
  delete original.evidence;
  delete original.expiresAt;
  fs.writeFileSync(f.filename, JSON.stringify(persisted));
  f.restart();
  return { ...f, originalEvents: original.events };
}

test('legacy Edgware overlap cannot authorize a changed tail until a newer provider observation', async t => {
  const f = await legacyEdgware(t);
  const initialIDs = new Set(f.originalEvents.map(row => row.id));
  const at = label => Date.parse('2026-11-26T' + label + ':00Z');
  assert.ok(!f.originalEvents.some(row => row.time === at('17:37')), 'the old horizon did not establish this working');

  const changed = structuredClone(edgware.body);
  const shifted = changed.timetable.routes.flatMap(route => route.schedules)
    .flatMap(schedule => schedule.knownJourneys).find(row => row.hour === '17' && row.minute === '37');
  assert.ok(shifted);
  shifted.minute = '38';
  const olderObservation = capturedAt - 60000;
  await f.cycle(450000, olderObservation, changed);
  const first = regular(await f.current(capturedAt + 450000));
  assert.ok(first.events.length && first.events.every(row => initialIDs.has(row.id)
    && row.receivedAt === capturedAt && row.expiresAt === capturedAt + 1050000));

  await f.cycle(900000, capturedAt, changed);
  const next = regular(await f.current(capturedAt + 900000));
  assert.ok(!next.events.some(row => row.time === at('17:38')), 'matching legacy overlap must not authorize the shifted unknown working');
  assert.ok(next.events.length && next.events.every(row => initialIDs.has(row.id)
    && row.receivedAt === capturedAt && row.expiresAt === capturedAt + 1500000));
  assert.equal(next.evidence?.ordinaryTimetable, undefined);

  const newerObservation = capturedAt + 1350000;
  await f.cycle(1350000, newerObservation);
  const confirmed = regular(await f.current(newerObservation));
  assert.equal(confirmed.evidence.ordinaryTimetable.observedAt, newerObservation);
  assert.ok(confirmed.events.some(row => row.time === at('17:37') && row.receivedAt === newerObservation));
  assert.ok(!confirmed.events.some(row => row.time === at('17:38')));

  await f.cycle(1800000, newerObservation);
  const renewed = regular(await f.current(capturedAt + 1800000));
  const lastConfirmed = Math.max(...confirmed.events.map(row => row.time));
  assert.ok(renewed.events.some(row => row.time > lastConfirmed && row.receivedAt === newerObservation));
});

test('a current HTTP receipt can start a new whole-day context after legacy workings expire', async t => {
  const f = await legacyEdgware(t);
  const olderObservation = capturedAt - 60000;
  await f.cycle(450000, olderObservation);
  const cutoff = capturedAt + 1050000;
  assert.equal(regular(await f.current(capturedAt + 450000)).expiresAt, cutoff);
  await f.cycle(1050000, olderObservation, edgware.body, true);
  assert.equal(regular(await f.current(cutoff)), undefined);
  f.restart();
  const readAt = cutoff + 1000;
  await f.cycle(1051000, olderObservation);
  const confirmed = regular(await f.current(readAt));
  assert.equal(confirmed.observedAt, olderObservation);
  assert.equal(confirmed.evidence.ordinaryTimetable.observedAt, olderObservation);
  assert.ok(confirmed.events.length && confirmed.events.every(row => row.time >= readAt
    && row.receivedAt === olderObservation && row.expiresAt === readAt + 600000));
  assert.ok(confirmed.events.some(row => !f.originalEvents.some(prior => prior.id === row.id)));
  assert.ok(f.push.at(-1).arrivals.some(row => row.plannedSourceID === 'regular-timetable'));
});

// Original 26 November TfL headers and SHA-256s. The station timetables
// retain their route intervals and weekday clocks for the replay window.
const recovery = JSON.parse(fs.readFileSync(new URL('./fixtures/regular-timetable-recovery-20261126.json', import.meta.url)));
const restore = ({ body, headers }) => reply(body, headers);
const stratfordDLR = { ...record, lineID: 'dlr', stationID: '940GZZDLSTD' };
const wimbledonDistrict = { ...record, lineID: 'district', stationID: '940GZZLUWIM' };

test('active Activities carry the real Stratford DLR direction and Wimbledon revalidation recoveries', async t => {
  for (const [capture, board, query, cacheControl, first] of [
    [recovery.stratford, stratfordDLR, '?direction=outbound', 'no-cache', ['Canary Wharf', '15:31']],
    [recovery.wimbledon, wimbledonDistrict, '', 'no-cache, max-age=0', ['Edgware Road (Circle Line)', '15:34']],
  ]) {
    const f = await initialDisplayFixture(t);
    const at = Date.parse(capture.follow.receivedAt);
    await f.register({ ...f.payload, ...board, initialRegularDisplayUntil: undefined,
      tokenUpdatedAt: new Date(at).toISOString() }, at);
    const requests = [];
    await f.cycle(at, async (input, { headers, redirect }) => {
      const url = new URL(input);
      if (!url.pathname.includes('/Timetable/')) return allOutage();
      assert.equal(url.pathname, `/Line/${board.lineID}/Timetable/${board.stationID}`);
      assert.equal(redirect, 'error');
      requests.push([url.search, headers['Cache-Control']]);
      return restore(requests.length === 1 ? capture.initial : capture.follow);
    });
    assert.deepEqual(requests, [['', 'no-cache'], [query, cacheControl]]);
    assert.equal(f.push.length, 1);
    const [row] = f.push[0].arrivals;
    assert.ok(f.push[0].arrivals.every(item => item.plannedSourceID === 'regular-timetable'
      && item.timeEvidence === 'scheduledDeparture' && item.originQualified && item.reportedPlatform === null));
    assert.deepEqual([row.destination, new Date(row.expectedArrival * 1000 + Date.UTC(2001, 0, 1)).toISOString().slice(11, 16)], first);
    if (board.lineID === 'dlr') assert.ok(f.push[0].arrivals.every(row => row.destination === 'Canary Wharf'));
  }
});

test('ordinary timetable recovery never chains a third read or follows a foreign or ambiguous direction', async () => {
  const { initial, follow } = recovery.stratford;
  const at = Date.parse(follow.receivedAt);
  const options = initial.body.disambiguation.disambiguationOptions;
  const menu = (extra, headers = initial.headers) => reply({
    ...initial.body, disambiguation: { disambiguationOptions: [...options, ...extra] },
  }, headers);
  for (const [root, scoped, count] of [
    [() => menu([{ ...options[0], uri: 'https://example.com' }]), () => restore(follow), 1],
    [() => menu([{ ...options[0], uri: options[0].uri.replace('outbound', 'inbound') }]), () => restore(follow), 1],
    [() => menu([], { ...initial.headers, Age: '43200' }), () => restore(initial), 2],
    [() => restore(initial), () => reply(follow.body, { ...follow.headers, Age: '43200' }), 2],
    [() => restore(initial), () => reply({ ...follow.body, direction: 'inbound' }, follow.headers), 2],
  ]) {
    let requests = 0;
    const cache = await refreshStationBoard(stratfordDLR, {}, config, async (url) => {
      if (!new URL(url).pathname.includes('/Timetable/')) return allOutage();
      return ++requests === 1 ? root() : scoped();
    }, at, null);
    assert.equal(requests, count);
    assert.deepEqual(selectEvents(cache, stratfordDLR, at), []);
  }
});

test('a stale scoped timetable can recover next cycle within the root receipt lifetime', async () => {
  const { initial, follow } = recovery.stratford;
  const at = Date.parse(follow.receivedAt);
  let clock = at;
  const requests = [];
  const fetch = async (input, { headers }) => {
    const url = new URL(input);
    if (!url.pathname.includes('/Timetable/')) return allOutage();
    requests.push([url.search, headers['Cache-Control']]);
    if (!url.search) return reply(initial.body, { ...initial.headers, Date: new Date(clock).toUTCString() });
    clock += 1000;
    const age = requests.length === 2 ? '43200' : '0';
    return reply(follow.body, { ...follow.headers, Date: new Date(clock).toUTCString(), Age: age });
  };
  const first = await refreshStationBoard(stratfordDLR, {}, config, fetch, at, null, () => clock);
  assert.deepEqual(selectEvents(first, stratfordDLR, clock), []);
  const retryAt = first.ordinaryNotBefore;
  clock = retryAt;
  const next = await refreshStationBoard(stratfordDLR, first, config, fetch, retryAt, null, () => clock);
  assert.deepEqual(requests, [
    ['', 'no-cache'], ['?direction=outbound', 'no-cache'],
    ['', 'no-cache'], ['?direction=outbound', 'no-cache'],
  ]);
  const rows = selectEvents(next, stratfordDLR, clock);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.expiresAt === retryAt + 600000));
});

test('ordinary direction and revalidation both honor Retry-After and current closure', async () => {
  for (const [capture, board] of [[recovery.stratford, stratfordDLR], [recovery.wimbledon, wimbledonDistrict]]) {
    const at = Date.parse(capture.follow.receivedAt);
    const rateLimited = () => new Response(null, { status: 429, headers: { 'Retry-After': '480' } });
    for (const limitOn of [1, 2]) {
      let reads = 0;
      const fetch = async url => new URL(url).pathname.includes('/Timetable/')
        ? ++reads === limitOn ? rateLimited() : restore(capture.initial)
        : allOutage();
      const cache = await refreshStationBoard(board, {}, config, fetch, at, null);
      assert.equal(cache.ordinaryNotBefore, at + 480000);
      assert.deepEqual(selectEvents(cache, board, at), []);
      await refreshStationBoard(board, cache, config, fetch, at + config.workerIntervalMs, null);
      assert.equal(reads, limitOn);
    }
    let closedReads = 0;
    const closedCache = await refreshStationBoard(board, {}, config, async url => {
      const pathname = new URL(url).pathname;
      if (pathname.includes('/Timetable/')) closedReads++;
      if (pathname.endsWith('/Status')) return reply([{ id: board.lineID, modeName: board.lineID === 'dlr' ? 'dlr' : 'tube',
        lineStatuses: [{ lineId: board.lineID, statusSeverity: 16, statusSeverityDescription: 'Suspended',
          validityPeriods: [{ fromDate: '2026-11-26T15:20:00Z', toDate: '2026-11-26T16:00:00Z' }] }],
      }], { Date: new Date(at).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=120' });
      return allOutage();
    }, at, null);
    assert.equal(closedReads, 0);
    assert.deepEqual(selectEvents(closedCache, board, at), []);
  }
});

test('station arrivals 429 defers ordinary reads across restart and replacement registration', async t => {
  for (const sourceOnly of [false, true]) {
    const f = await initialDisplayFixture(t);
    await f.register();
    const arrivalPath = '/StopPoint/940GZZLUSTD/Arrivals';
    const limitedRequests = [];
    const limited = async url => {
      const pathname = new URL(url).pathname;
      limitedRequests.push(pathname);
      if (pathname === arrivalPath) return new Response(null, { status: 429, headers: { 'Retry-After': '480' } });
      return allOutage();
    };
    await f.cycle(now, limited, false, sourceOnly);
    assert.equal(limitedRequests.includes(direct), false, 'A primary 429 cannot cause an extra timetable request');
    f.restart();
    await f.register({ ...f.payload, activityID: `synthetic-sibling-${sourceOnly}` }, now + 90000);
    const requests = [];
    const recovering = async url => {
      const pathname = new URL(url).pathname;
      requests.push(pathname);
      return pathname === direct ? reply(timetable) : allOutage();
    };
    await f.cycle(now + 90000, recovering);
    assert.equal(requests.includes(arrivalPath), false);
    assert.equal(requests.includes(direct), false);
    assert.ok(requests.some(request => request.endsWith('/Status')), 'Independent controls retain their cadence');
    requests.length = 0;
    await f.cycle(now + 480000, recovering);
    assert.equal(requests.filter(request => request === arrivalPath).length, 1);
    assert.equal(requests.filter(request => request === direct).length, 1);
    assert.ok(f.push.some(state => state.arrivals.some(row => row.plannedSourceID === 'regular-timetable')));
  }
});

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

test('a proved dated Circle starter sends exact origin proof and retains necessary coverage for capable clients', async () => {
  const dated = JSON.parse(fs.readFileSync(new URL('./fixtures/circle-edgware-road-journey-2032.json', import.meta.url)));
  const directSource = JSON.parse(fs.readFileSync(new URL('./fixtures/circle-edgware-road-direct-2032.json', import.meta.url)));
  const actualThroughLeg = dated.journeys.find(item => item.legs[0].routeOptions[0].lineIdentifier.id === 'circle').legs[0];
  const at = Date.parse('2026-11-21T20:32:54Z');
  const responseHeaders = { Date: new Date(at).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=150' };
  const circle = { ...record, lineID: 'circle', stationID: '940GZZLUERC' };
  const firstCall = '940GZZLUPAC';
  // Synthesize one dated starting leg from the independently proved first call
  // and leave the captured PAH through leg unchanged.
  const starter = structuredClone(actualThroughLeg);
  starter.path.stopPoints = [{ id: firstCall }];
  starter.arrivalPoint.naptanId = firstCall;
  starter.scheduledDepartureTime = '2026-11-21T20:43:00';
  for (const age of [2, 1]) {
    const response = { ...dated, recommendedMaxAgeMinutes: age, journeys: [...dated.journeys, { legs: [starter] }] };
    const replays = [];
    const fetch = async url => {
      const pathname = new URL(url).pathname;
      replays.push(pathname);
      if (pathname.includes('/Journey/')) return reply(response, responseHeaders);
      if (pathname.includes('/Timetable/')) return reply(directSource, {
        ...responseHeaders, Date: 'Sat, 21 Nov 2026 19:44:42 GMT', 'Cache-Control': 'public,max-age=43200',
      });
      return allOutage();
    };
    const cache = await refreshStationBoard(circle, {}, config, fetch, at, null);
    assert.deepEqual(cache.sources['journey-planner'].events.map(event => event.nextScheduledStopID), ['940GZZLUPAH', firstCall]);
    assert.equal(replays.some(path => path.includes('/Timetable/')), age === 1,
      'A dated answer needs supplemental coverage only if it expires before the next full read');
    const [chosen] = compactEvents(selectEvents(cache, circle, at));
    assert.equal(chosen.sourceID, 'journey-planner');
    const wire = buildStationBoardState(circle, cache, at).arrivals;
    const qualified = wire.find(row => row.id === chosen.id);
    assert.equal(qualified.originQualified, true);
    assert.equal(qualified.plannedSourceID, 'journey-planner');
    assert.equal(qualified.boardingContext.stationID, circle.stationID);
    assert.equal(qualified.boardingContext.lineID, circle.lineID);
    if (age === 1) {
      assert.ok(wire.some(row => row.plannedSourceID === 'regular-timetable'));
      const [fallback] = compactEvents(selectEvents(cache, circle, at + 60000));
      assert.equal(fallback.sourceID, 'regular-timetable');
    }
    const legacy = buildStationBoardState({ ...circle, supportsRegularTimetable: undefined }, cache, at).arrivals;
    assert.equal(legacy.length, 2);
    assert.ok(legacy.every(row => row.originQualified === undefined && row.boardingContext === undefined));
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
