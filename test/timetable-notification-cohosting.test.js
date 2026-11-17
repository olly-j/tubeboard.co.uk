import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLiveActivityWorkerCycle, getStationArrivalsRefreshDelayMs, getRolloverDelayMs } from '../server/live-activity.js';
import { notificationWorkload, verifyCancellation, verifyOverlap } from '../scripts/smoke-timetable-notification-cohosting.mjs';

async function directory(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-cohosting-'));
  t.after(() => fs.rm(value, { recursive: true, force: true })); return value;
}

test('actual worker cycles commit synthetic sends through their durable stores without clock acceleration', async t => {
  const dir = await directory(t), workload = await notificationWorkload(dir);
  t.after(() => workload.stop());
  // Direct triggers test the real cycle/transport/store boundary. They are not
  // used by image cadence acceptance, which uses unchanged production timers.
  await Promise.all(workload.workers.map(({ worker }) => worker.trigger()));
  assert.deepEqual(workload.errors, []);
  assert.deepEqual(workload.sends.map(e => e.name).sort(), ['activities', 'alerts', 'widgets']);
  const board = workload.activity.state.records[0];
  assert.ok(board.lastPushAt && board.lastBoardContentDigest);
  assert.ok(board.stationBoardCache.sources['station-arrivals'].events.length > 0);
  assert.ok(workload.sourceReads.some(read => read.pathname.endsWith('/Arrivals')));
  assert.ok(workload.sourceReads.some(read => read.pathname.endsWith('/Status')));
  assert.ok(workload.sourceReads.some(read => read.pathname.endsWith('/Disruption')));
  const source = board.stationBoardCache.sources['station-arrivals'];
  assert.ok(source.events.every(event => event.expiresAt > event.receivedAt && event.expiresAt <= event.receivedAt + 120000),
    'Fresh source is qualified with its original bounded TTL');
  assert.equal(workload.alerts.state.queue.length, 0);
  assert.ok(workload.alerts.state.records[0].lastNotificationAt);
  const route = workload.widgets.state.records[0];
  assert.ok(route.lastSuccessAt); assert.equal(route.failures, 0);
  assert.ok(route.nextAttemptAt >= route.lastSuccessAt + 59000, 'Real widget floor is preserved');
  await workload.workers.find(w => w.name === 'widgets').worker.trigger();
  assert.equal(workload.sends.filter(e => e.name === 'widgets').length, 1, 'Immediate rerun cannot bypass real 60s floor');
  for (const name of ['activities', 'alerts', 'widgets']) {
    const bytes = await fs.readFile(path.join(dir, name + '.json'), 'utf8'); assert.ok(bytes.length > 20);
  }
  assert.ok(workload.transport.sessions.every(({ session, request }) => session.destroyed && request.destroyed));
});

test('real worker cancellation drops coalesced reruns without pause acknowledgement or backoff', async t => {
  const result = await verifyCancellation(await directory(t));
  assert.equal(result.unfinishedAcknowledged, false); assert.equal(result.retryConsumed, false);
  assert.equal(result.coalescedPendingDropped, true); assert.ok(result.milliseconds < 5000);
});

test('missing cancellation entry is bounded and still stops and disposes every entered worker', async t => {
  const dir = await directory(t);
  await assert.rejects(verifyCancellation(dir, { entryTimeoutMs: 50, omitTrigger: 'widgets' }), /entry deadline/);
  const result = JSON.parse(await fs.readFile(path.join(dir, 'cancellation-result.json')));
  assert.equal(result.status, 'failed'); assert.equal(result.requests, 2); assert.equal(result.disposed, true);
  assert.equal(result.states.alerts.queue[0].attempts, 0); assert.equal(result.states.activity.records[0].lastPushAt, null);
});

const worker = { name: 'activities', intervalMs: 90000, initialDelayMs: 2000 };
const event = (event, at) => ({ name: 'activities', event, at, state: { running: event === 'cycle-start' ? 1 : 0, maximum: 1 } });
const fixture = () => ({ start: 0, end: 100000, workers: [worker], errors: [],
  events: [event('cycle-start', 2001), event('cycle-complete', 2010), event('cycle-start', 90001), event('cycle-complete', 90010)],
  sends: [{ name: 'activities', at: 2005 }] });

test('capacity verdict rejects serialized work, empty cycles, missed cadence and concurrency', () => {
  assert.doesNotThrow(() => verifyOverlap(fixture()));
  assert.throws(() => verifyOverlap({ ...fixture(), start: 100001, end: 200000 }), /overlapping producer/);
  assert.throws(() => verifyOverlap({ ...fixture(), sends: [] }), /no real synthetic send/);
  assert.throws(() => verifyOverlap({ ...fixture(), events: fixture().events.slice(0, 2) }), /missed production cadence/);
  const concurrent = fixture(); concurrent.events[0].state.running = 2;
  assert.throws(() => verifyOverlap(concurrent), /concurrent cycles/);
  const widgets = { start: 0, end: 15001, workers: [{ name: 'activities', intervalMs: 5000, initialDelayMs: 6000 }], errors: [],
    events: [event('cycle-start', 10000), event('cycle-complete', 10001)], sends: [{ name: 'activities', at: 10000.5 }] };
  assert.throws(() => verifyOverlap(widgets), /distinct cycle required/, 'One10s cycle cannot satisfy initial6s and periodic5s/10s');
  // Initial and interval triggers that land inside one already-active cycle
  // share exactly one follow-up under SerialWorker's real pending-bit contract.
  const coalesced = { start: 0, end: 15001, workers: [{ name: 'activities', intervalMs: 5000, initialDelayMs: 6000 }], errors: [],
    events: [event('cycle-start', 4999), event('cycle-complete', 7000), event('cycle-start', 7001),
      event('cycle-complete', 7002), event('cycle-start', 10001), event('cycle-complete', 10002)],
    sends: [{ name: 'activities', at: 6000 }] };
  assert.doesNotThrow(() => verifyOverlap(coalesced));
});


test('actual activity cycle arms production source and rollover timers and receives their modes', async t => {
  const calls = [], callbacks = [], scheduled = [];
  const workload = await notificationWorkload(await directory(t), undefined, {
    runActivityCycle: options => {
      calls.push({ cacheOnly: options.cacheOnly, sourceOnly: options.sourceOnly });
      // Observe arguments emitted by the real cycle, then call the unchanged
      // harness callbacks. No fake result, clock or accelerated timer is used.
      for (const kind of ['scheduleSourceRefresh', 'scheduleRolloverPush']) {
        const callback = options[kind];
        options[kind] = (...args) => { callbacks.push({ kind, args }); return callback(...args); };
      }
      return runLiveActivityWorkerCycle(options);
    }
  });
  t.after(() => workload.stop());
  const worker = workload.workers.find(w => w.name === 'activities').worker;
  const schedule = worker.scheduleRerun.bind(worker);
  worker.scheduleRerun = (key, delay, options) => {
    scheduled.push({ key, delay, options });
    return schedule(key, delay, options);
  };
  await worker.trigger();
  assert.deepEqual(workload.errors, []);
  assert.equal(callbacks.length, 2, 'The real successful cycle must emit both callbacks');
  const [source, rollover] = callbacks;
  assert.equal(source.kind, 'scheduleSourceRefresh');
  assert.equal(rollover.kind, 'scheduleRolloverPush');
  const [record, cache, now, interval] = source.args;
  const [rolloverRecord, content, rolloverNow, rolloverInterval] = rollover.args;
  assert.equal(interval, 90000); assert.equal(rolloverInterval, 90000);
  assert.deepEqual(scheduled, [
    { key: `${record.environment}:${record.activityID}:station-arrivals`,
      delay: getStationArrivalsRefreshDelayMs(cache, now, interval), options: { sourceOnly: true } },
    { key: `${rolloverRecord.environment}:${rolloverRecord.activityID}`,
      delay: getRolloverDelayMs(content, rolloverNow, rolloverInterval), options: { cacheOnly: true } }
  ]);
  assert.ok(scheduled.every(item => item.delay > 0 && item.delay < interval),
    'Both genuine sub-interval timer obligations must exist for this fresh board');
  const reads = workload.sourceReads.length;
  await worker.trigger({ cacheOnly: true });
  assert.equal(workload.sourceReads.length, reads, 'Actual cache-only cycle cannot read sources');
  await worker.trigger({ sourceOnly: true });
  assert.deepEqual(calls.slice(0, 3), [
    { cacheOnly: false, sourceOnly: undefined },
    { cacheOnly: true, sourceOnly: undefined },
    { cacheOnly: false, sourceOnly: true }
  ], 'SerialWorker modes must reach the real cycle, rather than being dropped by the wrapper');
  assert.deepEqual(workload.activityRuns.slice(0, 3).map(({ cacheOnly, sourceOnly }) => ({ cacheOnly, sourceOnly })), [
    { cacheOnly: false, sourceOnly: false }, { cacheOnly: true, sourceOnly: false }, { cacheOnly: false, sourceOnly: true }
  ], 'Image evidence retains actual mode entries separately from scheduled obligations');
  assert.equal(workload.activityReruns.length, callbacks.length);
  assert.deepEqual(workload.errors, []);
  await workload.stop();
  assert.ok(workload.events.at(-1).state.stopped);
  assert.equal(workload.events.at(-1).state.timers, 0, 'Stop removes newly armed production reruns');
});
