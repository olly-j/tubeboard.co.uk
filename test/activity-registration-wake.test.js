import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveActivityStore, loadConfig, runLiveActivityWorkerCycle, registerLiveActivityToken } from '../server/live-activity.js';
import { STATION_BOARD_LINES, STATION_BOARD_STATIONS } from '../server/station-board-v2.js';
import { SerialWorker } from '../server/worker-lifecycle.js';

const register = registerLiveActivityToken;
const epoch = Date.parse('2026-11-16T12:00:00Z');
const payload = { activityID: 'synthetic-wake', installID: 'synthetic-wake-install', stationID: '940GZZLUWOF', lineID: 'central', selectionMode: 'platform', platformID: 'eastbound-platform-3', platformHeading: 'Eastbound - Platform 3', platformLabel: 'Platform 3', platformDirection: 'Eastbound', pushTokenHex: 'aa'.repeat(32), tokenUpdatedAt: new Date(epoch).toISOString(), appBundleID: 'OllyJ.My-Train-Times', appVersion: '1.2.6', buildNumber: 'synthetic', environment: 'sandbox', contentStateContract: 'station-board-v2', plannedPresentationVersion: 2 };

async function fixture(t, { status = 200, board = payload, kind = "through", blockFirstRead = false, latency = 0, deadline = null, providerTimestamp = null, registrationDeadline = null, otherStatus = 200 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-activity-wake-'));
  const store = new LiveActivityStore(path.join(directory, 'activities.json'));
  let at = epoch, running = 0, maximum = 0;
  const timers = new Set(), jobs = [], cycles = [], pushes = [], reads = [];
  let release, entered, firstBlocked = false, delayed = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const didEnter = new Promise(resolve => { entered = resolve; });
  const schedule = (callback, delay) => { const timer = { at: at + delay, callback, unref() {} }; timers.add(timer); return timer; };
  const cancel = timer => timers.delete(timer);
  const fetchImpl = async url => {
    const pathname = new URL(url).pathname;
    if (!delayed) { at += latency; delayed = true; }
    reads.push({ at, pathname });
    if (blockFirstRead && !firstBlocked && pathname === `/StopPoint/${board.stationID}/Arrivals`) {
      firstBlocked = true; entered(); await blocked;
    }
    const headers = { Date: new Date(at).toUTCString(), Age: '0', 'Cache-Control': 'public,max-age=30', ...(status === 429 ? { 'Retry-After': '300' } : {}) };
    let rows = [];
    if (kind === 'through' && pathname === `/StopPoint/${board.stationID}/Arrivals`) rows = [{ lineId: board.lineID, naptanId: board.stationID, stationName: 'Woodford Underground Station', destinationName: 'Epping Underground Station', destinationNaptanId: '940GZZLUEPG', expectedArrival: new Date(at + 300000).toISOString(), timestamp: new Date(providerTimestamp ?? at).toISOString(), direction: 'outbound', platformName: 'Eastbound - Platform 3' }];
    if (kind === 'rail' && pathname.endsWith('/ArrivalDepartures')) {
      const destinationID = STATION_BOARD_LINES.get(board.lineID).branchTargetIDs.find(id => id !== board.stationID && STATION_BOARD_STATIONS.get(id)?.lineIDs.includes(board.lineID));
      rows = [{ id: 'synthetic-rail', naptanId: board.stationID, destinationNaptanId: destinationID, destinationName: STATION_BOARD_STATIONS.get(destinationID).stationName, departureStatus: 'OnTime', platformName: 'Platform 1', estimatedTimeOfDeparture: new Date(at + 300000).toISOString(), scheduledTimeOfDeparture: new Date(at + 300000).toISOString() }];
    }
    if (kind === 'terminus' && pathname === `/Line/${board.lineID}/Arrivals`) rows = [{ lineId: board.lineID, naptanId: '940GZZLUCND', stationName: 'Colindale', destinationNaptanId: '940GZZLUMDN', destinationName: 'Morden', expectedArrival: new Date(at + 300000).toISOString(), timestamp: new Date(at).toISOString(), timing: { read: new Date(at).toISOString() }, direction: 'Outbound', currentLocation: 'At Edgware Platform 2' }];
    return new Response(JSON.stringify(rows), { status: pathname === `/StopPoint/${board.stationID}/Arrivals` ? status : otherStatus, headers });
  };
  const worker = new SerialWorker({ schedule, cancel, initialDelayMs: 2000, intervalMs: 90000, clock: () => at,
    onError: error => { throw error; }, run: (signal, mode) => {
      const job = (async () => {
        delayed = false; maximum = Math.max(maximum, ++running); cycles.push({ at, ...mode });
        try {
          await runLiveActivityWorkerCycle({ store, config: loadConfig({}), signal, ...mode, now: new Date(at), clock: () => at, fetchImpl, nextFullRefreshAt: deadline ? deadline(at, worker) : worker.nextIntervalAt,
            pushImpl: async (_, body) => { at += latency > 0 ? 1000 : 0; pushes.push({ at, body }); return { status: 200 }; }, logger: { info() {}, warn() {}, error() {} } });
        } finally { running--; }
      })();
      jobs.push(job); return job;
    } });
  const settle = async () => {
    for (let turn = 0; turn < 100; turn++) {
      const count = jobs.length;
      await Promise.all(jobs); await new Promise(resolve => setImmediate(resolve));
      if (running === 0 && jobs.length === count) return;
    }
    assert.fail('serialized worker did not settle within the bounded async steps');
  };
  const advance = async (offset, wait = true) => {
    const until = epoch + offset;
    while (true) {
      const next = [...timers].filter(x => x.at <= until).sort((a,b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next); at = next.at; next.callback(); if (wait) await settle();
    }
    at = until; if (wait) await settle();
  };
  const send = (overrides = {}) => register(store, { ...board, ...overrides }, { now: new Date(at), wakeWorker: () => { void worker.trigger(); }, nextRegularAt: () => registrationDeadline ? registrationDeadline(at, worker) : worker.nextIntervalAt, clock: () => at });
  t.after(async () => { release(); await worker.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  worker.start(); await advance(2000); await advance(3000);
  return { store, worker, cycles, pushes, reads, send, advance, settle, maximum: () => maximum, entered: didEnter, release };
}

test('first accepted Woodford registration refreshes before the initial original source expires', { timeout: 10000 }, async t => {
  const f = await fixture(t, { latency: 2000 });
  const accepted = await f.send(); assert.equal(accepted.registrationAccepted, true);
  await f.settle(); await f.advance(63000);
  assert.ok(f.pushes.some(p => p.at < epoch + 63000 && p.body.aps['content-state'].arrivals.some(r => r.timeEvidence === 'throughArrivalPrediction')), 'registration at3s must deliver before initial app source expires at63s, rather than waiting for90s phase');
  const initialReads = f.reads.length;
  await f.advance(90000);
  assert.ok(f.reads.length > initialReads, 'normal90s cycle actually reacquires full sources, not merely a skipped worker callback');
  assert.ok(f.cycles.some(c => c.at === epoch + 90000), 'registration wake preserves the existing full-worker phase');
  assert.equal(f.maximum(), 1);
});

test('duplicate bursts coalesce without extra HTTP or overlapping full cycles', { timeout: 10000 }, async t => {
  const f = await fixture(t, { blockFirstRead: true });
  await f.send(); await f.entered;
  await Promise.all(Array.from({ length: 20 }, () => f.send()));
  assert.equal(f.pushes.length, 0, 'registration ACK does not wait for the blocked source');
  f.release(); await f.settle();
  const count = f.reads.length, cycles = f.cycles.length;
  assert.equal(f.reads.filter(r => r.pathname === '/StopPoint/940GZZLUWOF/Arrivals').length, 1);
  assert.equal(f.maximum(), 1);
  await Promise.all(Array.from({ length: 20 }, () => f.send())); await f.settle();
  assert.equal(f.reads.length, count); assert.equal(f.cycles.length, cycles);
  const rejected = await f.send({ tokenUpdatedAt: new Date(epoch - 1).toISOString() });
  assert.equal(rejected.registrationAccepted, false); await f.settle();
  assert.equal(f.cycles.length, cycles);
});

for (const status of [429, 503]) test(`registration wakes preserve persisted ${status} request floors`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { status });
  await f.send(); await f.settle();
  await f.send({ activityID: 'synthetic-second', installID: 'synthetic-second' }); await f.settle();
  await f.advance(90000);
  assert.equal(f.reads.filter(r => r.pathname === '/StopPoint/940GZZLUWOF/Arrivals').length, 1);
  const floor = status === 429 ? 300000 : 120000;
  assert.ok(f.store.stationArrivalAdmissionFloors().every(r => r.notBefore >= epoch + 3000 + floor));
});

for (const kind of ['rail', 'terminus']) test(`initial ${kind} wake acquires actual sources and retains the90s full-source phase`, { timeout: 10000 }, async t => {
  const [lineID, line] = [...STATION_BOARD_LINES].find(([, entry]) => entry.qualifiedRailDepartureSource);
  const board = kind === 'rail' ? { ...payload, lineID, stationID: line.boundedOriginID, selectionMode: 'allPlatforms', platformID: null, platformHeading: null, platformLabel: null, platformDirection: null }
    : { ...payload, lineID: 'northern', stationID: '940GZZLUEGW', selectionMode: 'allPlatforms', platformID: null, platformHeading: null, platformLabel: null, platformDirection: null };
  const f = await fixture(t, { board, kind });
  await f.send(); await f.settle();
  const evidence = kind === 'rail' ? 'estimatedDeparture' : 'destinationOnly';
  assert.ok(f.pushes[0]?.body.aps['content-state'].arrivals.some(r => r.timeEvidence === evidence), 'full wake must not replace real rail/destination facts with a station-arrivals-only empty');
  const source = kind === 'rail' ? `/StopPoint/${board.stationID}/ArrivalDepartures` : `/Line/${board.lineID}/Arrivals`;
  assert.equal(f.reads.filter(r => r.pathname === source).length, 1);
  await f.advance(90000);
  assert.equal(f.reads.filter(r => r.pathname === source).length, 2, 'original90s full phase must really read the non-arrivals source');
});

test('unchanged original provider timestamps expire rather than borrowing registration or push clocks', { timeout: 10000 }, async t => {
  const f = await fixture(t, { providerTimestamp: epoch - 60000 });
  await f.send(); await f.settle();
  assert.ok(f.pushes[0].body.aps['content-state'].arrivals.every(r => r.expiresAt * 1000 + 978307200000 === epoch + 60000));
  await f.advance(90000);
  assert.equal(f.pushes.at(-1).body.aps['content-state'].arrivals.length, 0);
});

for (const invalid of [NaN, Infinity, epoch - 1, epoch + 200000]) test(`invalid phase deadline ${invalid} cannot change admission`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { deadline: () => invalid });
  await f.send(); await f.settle();
  const [record] = await f.store.listActive(new Date(epoch + 3000));
  assert.equal(record.stationBoardCache.nextRefreshAt, epoch + 93000);
});

test('stopping the worker withdraws its phase deadline; a new lifecycle starts a new phase', async () => {
  let at = epoch;
  const timers = new Set(), schedule = (callback, delay) => { const timer = { callback, at: at + delay, unref() {} }; timers.add(timer); return timer; };
  const options = { run: async () => {}, initialDelayMs: 2000, intervalMs: 90000, clock: () => at, schedule, cancel: timer => timers.delete(timer) };
  const first = new SerialWorker(options); assert.equal(first.nextIntervalAt, null);
  first.start(); assert.equal(first.nextIntervalAt, epoch + 90000);
  await first.stop(); assert.equal(first.nextIntervalAt, null); assert.equal(timers.size, 0);
  at += 5000; const second = new SerialWorker(options); second.start();
  assert.equal(second.nextIntervalAt, epoch + 95000); await second.stop();
});


test('a slow initial full cycle crossing the regular deadline retains one queued full acquisition', { timeout: 10000 }, async t => {
  const f = await fixture(t, { blockFirstRead: true });
  await f.send(); await f.entered;
  await f.advance(90000, false);
  f.release(); await f.settle();
  assert.equal(f.maximum(), 1);
  assert.equal(f.cycles.filter(c => c.at === epoch + 90000).length, 1);
  assert.equal(f.reads.filter(r => r.pathname === '/Line/central/Status').length, 2,
    'queued regular cycle remains full-source eligible even when the initial cycle completed at its deadline');
});


test('legacy registrations and a disabled wake retain the existing acknowledgment path', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const legacy = await register(f.store, { ...payload, contentStateContract: undefined, plannedPresentationVersion: undefined }, {
    now: new Date(epoch + 3000), wakeWorker: () => assert.fail('legacy path must not gain v2 work') });
  assert.equal(legacy.active, true);
  const disabled = await register(f.store, { ...payload, activityID: 'synthetic-disabled' }, { now: new Date(epoch + 3000) });
  assert.equal(disabled.registrationAccepted, true);
  await f.settle(); assert.equal(f.cycles.length, 1); assert.equal(f.reads.length, 0);
});


for (const registrationAt of [70000, 89000]) for (const kind of ['through', 'rail', 'terminus']) {
  test(`near-phase ${kind} registration at${registrationAt} waits for the armed full cycle`, { timeout: 10000 }, async t => {
    const [lineID, line] = [...STATION_BOARD_LINES].find(([, entry]) => entry.qualifiedRailDepartureSource);
    const board = kind === 'rail' ? { ...payload, lineID, stationID: line.boundedOriginID, selectionMode: 'allPlatforms', platformID: null, platformHeading: null, platformLabel: null, platformDirection: null }
      : kind === 'terminus' ? { ...payload, lineID: 'northern', stationID: '940GZZLUEGW', selectionMode: 'allPlatforms', platformID: null, platformHeading: null, platformLabel: null, platformDirection: null } : payload;
    const f = await fixture(t, { board, kind });
    await f.advance(registrationAt); await f.send(); await f.settle();
    assert.equal(f.reads.length, 0, 'no new source attempt immediately before the already-armed regular cycle');
    await f.advance(90000);
    assert.ok(f.pushes[0]?.at === epoch + 90000);
    assert.ok(f.reads.length > 1 && f.reads.every(r => r.at === epoch + 90000));
    const byURL = new Map();
    for (const read of f.reads) byURL.set(read.pathname, (byURL.get(read.pathname) || 0) + 1);
    assert.ok([...byURL.values()].every(count => count === 1), 'every actual source, not only primary arrivals, has one attempt');
  });
}


for (const invalid of [null, NaN, Infinity, epoch - 1]) test(`unknown registration phase ${invalid} does not silently withhold the initial wake`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { registrationDeadline: () => invalid });
  await f.send(); await f.settle();
  assert.ok(f.pushes.length === 1);
});

for (const otherStatus of [429, 503]) test(`near-phase wake does not repeat non-primary ${otherStatus} attempts`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { otherStatus });
  await f.advance(89000); await f.send(); await f.settle();
  assert.equal(f.reads.length, 0);
  await f.advance(90000);
  assert.ok(f.reads.some(r => r.pathname.endsWith('/Status')));
  const byURL = new Map();
  for (const read of f.reads) byURL.set(read.pathname, [...(byURL.get(read.pathname) || []), read.at]);
  assert.ok([...byURL.values()].every(attempts => attempts.length === 1 && attempts[0] === epoch + 90000));
  await f.advance(180000);
  for (const pathname of byURL.keys()) {
    const times = f.reads.filter(r => r.pathname === pathname).map(r => r.at);
    assert.ok(times.every((time, i) => i === 0 || time - times[i - 1] >= 90000));
  }
});

test('registration does not restart a stopped worker', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.worker.stop();
  await f.send(); await f.settle();
  assert.equal(f.worker.nextIntervalAt, null);
  assert.equal(f.cycles.length, 1); assert.equal(f.reads.length, 0);
});

test('registration consults the current armed phase after the durable upsert', async () => {
  let now = epoch + 3000, next = epoch + 90000, wakes = 0;
  const accepted = { active: true, registrationAccepted: true, contentStateContract: 'station-board-v2', lastPushAt: null };
  const store = { upsertToken: async () => { now = epoch + 89000; return accepted; } };
  await register(store, payload, { now: new Date(now), clock: () => now, nextRegularAt: () => next, wakeWorker: () => wakes++ });
  assert.equal(wakes, 0, 'late durable completion defers to the actual imminent phase');
  store.upsertToken = async () => { now = epoch + 91000; next = epoch + 180000; return accepted; };
  await register(store, payload, { now: new Date(now), clock: () => now, nextRegularAt: () => next, wakeWorker: () => wakes++ });
  assert.equal(wakes, 1, 'a phase that advanced during upsert must not leave the new activity waiting another89s');
});
