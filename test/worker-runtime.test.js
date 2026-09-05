import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SerialWorker } from '../server/worker-lifecycle.js';
import { fetchJsonResponse, sendApnsRequest, NOTIFICATION_REQUEST_TIMEOUT_MS } from '../server/notification-transport.js';
import { LiveActivityStore, runLiveActivityWorkerCycle, loadConfig } from '../server/live-activity.js';
import { runDisruptionAlertWorkerCycle } from '../server/disruption-alerts.js';

test('overlapping triggers coalesce into one follow-up without concurrent cycles', async () => {
  const first = deferred();
  let runs = 0;
  let active = 0;
  let maximum = 0;
  const worker = new SerialWorker({ run: async () => {
    runs += 1;
    maximum = Math.max(maximum, ++active);
    if (runs === 1) await first.promise;
    active -= 1;
  } });
  const work = worker.trigger();
  await turn();
  for (let index = 0; index < 30; index += 1) assert.equal(worker.trigger(), work);
  assert.equal(runs, 1);
  first.resolve();
  await work;
  assert.equal(runs, 2);
  assert.equal(maximum, 1);
  await worker.stop();
});

test('a failed cycle permits its pending rerun and later independent cycles', async () => {
  const first = deferred();
  let runs = 0;
  const failures = [];
  const worker = new SerialWorker({ onError: (error) => failures.push(error.message), run: async () => {
    if (++runs === 1) { await first.promise; throw new Error('synthetic failure'); }
  } });
  const work = worker.trigger();
  await turn();
  worker.trigger();
  first.resolve();
  await work;
  await worker.trigger();
  assert.equal(runs, 3);
  assert.deepEqual(failures, ['synthetic failure']);
  await worker.stop();
});

test('startup, interval and replacement rollover timers share one owner and stop cleanly', async () => {
  const clock = manualClock();
  let runs = 0;
  let activeSignal;
  const errors = [];
  const worker = new SerialWorker({
    ...clock.options, initialDelayMs: 2, intervalMs: 10,
    onError: (error) => errors.push(error),
    run: (signal) => {
      runs += 1;
      activeSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  });
  worker.start();
  worker.start();
  assert.equal(clock.size(), 2);
  await clock.advance(2);
  worker.scheduleRerun('same-activity', 3);
  worker.scheduleRerun('same-activity', 6);
  worker.scheduleRerun('removed-activity', 1);
  worker.scheduleRerun('removed-activity', null);
  assert.equal(clock.size(), 2);
  await clock.advance(50);
  assert.equal(runs, 1);
  await worker.stop();
  assert.equal(activeSignal.aborted, true);
  assert.equal(clock.size(), 0);
  worker.start();
  worker.scheduleRerun('late', 1);
  await worker.trigger();
  await clock.advance(100);
  assert.equal(runs, 1);
  assert.deepEqual(errors, []);
});

test('work arriving during a duration transition is handled without duplicate transition dispatch', async () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  const record = (activityID) => ({ activityID, environment: 'sandbox', activityEndsAt: '2026-09-04T11:59:00.000Z' });
  const records = [record('synthetic-first')];
  const store = {
    expireOld: async () => {},
    listActive: async () => structuredClone(records),
    markPaused: async (activityID) => { records.find((candidate) => candidate.activityID === activityID).pausedAt = now.toISOString(); }
  };
  const firstPush = deferred();
  const sends = [];
  const worker = new SerialWorker({ run: (signal) => runLiveActivityWorkerCycle({
    store, config: loadConfig({}), now, signal, logger: { info() {} },
    pushImpl: async (item) => {
      sends.push(item.activityID);
      if (sends.length === 1) await firstPush.promise;
      return { status: 200 };
    }
  }) });
  const work = worker.trigger();
  await turn();
  records.push(record('synthetic-second'));
  worker.trigger();
  firstPush.resolve();
  await work;
  assert.deepEqual(sends, ['synthetic-first', 'synthetic-second']);
  await worker.stop();
});

test('serialized cycles commit duration transitions through the durable store before rerunning', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubeboard-worker-persistence-'));
  const filePath = path.join(directory, 'records.json');
  const store = new LiveActivityStore(filePath);
  const fixture = JSON.parse(await fs.readFile(new URL('../contracts/fixtures/live-activity-registration-v1.json', import.meta.url), 'utf8'));
  const now = new Date('2026-09-05T12:00:00.000Z');
  const firstPush = deferred();
  const pushStarted = deferred();
  const sends = [];
  const failures = [];
  const worker = new SerialWorker({
    onError: (error) => failures.push(error),
    run: (signal) => runLiveActivityWorkerCycle({
      store, config: loadConfig({}), now, signal, logger: { info() {} },
      fetchImpl: () => assert.fail('elapsed duration transitions do not fetch upstream data'),
      pushImpl: async (record) => {
        sends.push(record.activityID);
        if (sends.length === 1) {
          pushStarted.resolve();
          await firstPush.promise;
        }
        return { status: 200 };
      }
    })
  });
  t.after(async () => {
    firstPush.resolve();
    await worker.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const register = async (index) => {
    const identity = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await store.upsertToken({
      ...fixture, installID: identity, activityID: identity,
      activityStartedAt: new Date(now.getTime() - 120_000).toISOString(),
      activityEndsAt: new Date(now.getTime() - 60_000).toISOString(),
      tokenUpdatedAt: now.toISOString()
    }, now);
    return identity;
  };
  const firstID = await register(1);
  const work = worker.trigger();
  await pushStarted.promise;
  const secondID = await register(2);
  for (let index = 0; index < 30; index += 1) worker.trigger();
  firstPush.resolve();
  await work;
  assert.deepEqual(failures, []);
  assert.deepEqual(sends, [firstID, secondID]);
  const restarted = new LiveActivityStore(filePath);
  await restarted.load();
  assert.deepEqual(restarted.state.records.map((record) => [record.activityID, record.pausedAt]), [
    [firstID, now.toISOString()], [secondID, now.toISOString()]
  ]);
});

test('TfL connection/header deadline aborts the request and a later request succeeds', async () => {
  const clock = manualClock();
  let requestSignal;
  const result = fetchJsonResponse('https://example.invalid', async (url, { signal }) => {
    requestSignal = signal;
    return new Promise(() => {});
  }, clock.options);
  const rejection = assert.rejects(result, (error) => error.retryable && /deadline/.test(error.message));
  await turn();
  await clock.advance(NOTIFICATION_REQUEST_TIMEOUT_MS);
  await rejection;
  assert.equal(requestSignal.aborted, true);
  assert.equal(clock.size(), 0);
  const response = await fetchJsonResponse('https://example.invalid', async () => ({ ok: true, status: 200, json: async () => [] }), clock.options);
  assert.deepEqual(response.value, []);
  assert.equal(clock.size(), 0);
});

test('TfL deadline continues through a stalled JSON response body', async () => {
  const clock = manualClock();
  let readingBody = false;
  let requestSignal;
  const result = fetchJsonResponse('https://example.invalid', async (url, { signal }) => {
    requestSignal = signal;
    return { ok: true, status: 200, json: () => { readingBody = true; return new Promise(() => {}); } };
  }, clock.options);
  const rejection = assert.rejects(result, /deadline/);
  await turn();
  assert.equal(readingBody, true);
  await clock.advance(NOTIFICATION_REQUEST_TIMEOUT_MS);
  await rejection;
  assert.equal(requestSignal.aborted, true);
  assert.equal(clock.size(), 0);
});

test('unused non-success TfL bodies are cancelled and their status is preserved', async () => {
  const clock = manualClock();
  let cancelled = 0;
  const response = await fetchJsonResponse('https://example.invalid', async () => ({
    ok: false, status: 429, body: { cancel: async () => { cancelled += 1; } },
    json: () => assert.fail('error body must not be parsed')
  }), clock.options);
  assert.equal(response.status, 429);
  assert.equal(cancelled, 1);
  assert.equal(clock.size(), 0);
});

test('parent cancellation prevents dispatch and removes deadline/listener ownership', async () => {
  const clock = manualClock();
  const controller = new AbortController();
  const reason = new DOMException('Worker stopped', 'AbortError');
  controller.abort(reason);
  await assert.rejects(fetchJsonResponse('https://example.invalid', () => assert.fail('must not dispatch'), {
    ...clock.options, signal: controller.signal
  }), (error) => error === reason);
  assert.equal(clock.size(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const event of ['connection-error', 'connection-close', 'request-error', 'request-close', 'request-aborted']) {
  test(`APNs ${event} rejects and disposes its session and request`, async () => {
    const clock = manualClock();
    const connection = fakeConnection();
    const result = sendApnsRequest('api.sandbox.push.apple.com', {}, {}, { ...clock.options, connect: connection.connect });
    const rejection = assert.rejects(result, (error) => error.retryable);
    await turn();
    const [source, name] = event.split('-');
    (source === 'connection' ? connection.client : connection.request).emit(name, new Error('synthetic failure'));
    await rejection;
    assert.equal(connection.client.destroyed, true);
    assert.equal(connection.request.destroyed, true);
    assert.equal(clock.size(), 0);
  });
}

test('APNs deadline covers connection setup and permits a later successful request', async () => {
  const clock = manualClock();
  const stalled = fakeConnection();
  const result = sendApnsRequest('api.sandbox.push.apple.com', {}, {}, { ...clock.options, connect: stalled.connect });
  const rejection = assert.rejects(result, /deadline/);
  await turn();
  await clock.advance(NOTIFICATION_REQUEST_TIMEOUT_MS);
  await rejection;
  assert.equal(stalled.client.destroyed, true);
  assert.equal(stalled.request.destroyed, true);
  const good = fakeConnection();
  const next = sendApnsRequest('api.sandbox.push.apple.com', { ':method': 'POST' }, { synthetic: true }, { ...clock.options, connect: good.connect });
  await turn();
  good.request.emit('response', { ':status': 200 });
  good.request.emit('end');
  assert.deepEqual(await next, { status: 200, body: '' });
  assert.equal(good.client.destroyed, true);
  assert.equal(good.request.destroyed, true);
  assert.equal(clock.size(), 0);
});

test('APNs body progress cannot extend the absolute response deadline', async () => {
  const clock = manualClock();
  const connection = fakeConnection();
  const result = sendApnsRequest('api.sandbox.push.apple.com', {}, {}, { ...clock.options, connect: connection.connect });
  const rejection = assert.rejects(result, /deadline/);
  await turn();
  connection.request.emit('response', { ':status': 503 });
  await clock.advance(10_000);
  connection.request.emit('data', '{"reason":');
  await clock.advance(5_000);
  await rejection;
  assert.equal(connection.client.destroyed, true);
  assert.equal(connection.request.destroyed, true);
});

test('stopping a worker aborts in-flight APNs and drops its pending rerun', async () => {
  const clock = manualClock();
  const connection = fakeConnection();
  let runs = 0;
  let cycleSignal;
  const worker = new SerialWorker({ run: (signal) => {
    runs += 1;
    cycleSignal = signal;
    return sendApnsRequest('api.sandbox.push.apple.com', {}, {}, { ...clock.options, signal, connect: connection.connect });
  } });
  const work = worker.trigger();
  await turn();
  worker.trigger();
  await worker.stop();
  await work;
  assert.equal(runs, 1);
  assert.equal(connection.client.destroyed, true);
  assert.equal(connection.request.destroyed, true);
  assert.equal(clock.size(), 0);
  assert.equal(getEventListeners(cycleSignal, 'abort').length, 0);
});

test('shutdown cancellation does not convert an unfinished duration push into backoff or success', async () => {
  const controller = new AbortController();
  const record = { activityID: 'synthetic', activityEndsAt: '2026-09-04T11:59:00.000Z' };
  const store = {
    expireOld: async () => {}, listActive: async () => [record],
    markPaused: () => assert.fail('unfinished push cannot be acknowledged'),
    markBackoff: () => assert.fail('shutdown is not a delivery failure')
  };
  const result = runLiveActivityWorkerCycle({
    store, config: loadConfig({}), now: new Date('2026-09-04T12:00:00.000Z'), signal: controller.signal,
    pushImpl: async (item, payload, config, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await turn();
  controller.abort(new DOMException('Worker stopped', 'AbortError'));
  await rejection;
});

test('alert timeout retains the queue for one retry and a later cycle acknowledges success', async () => {
  const clock = manualClock();
  const item = { id: 'synthetic-item' };
  let due = true;
  let retries = 0;
  let successes = 0;
  const store = {
    dueQueue: async () => due ? [item] : [],
    recordForQueueItem: () => ({}), decryptedToken: () => 'synthetic-token',
    markQueueRetry: async () => { retries += 1; due = false; },
    markQueueSuccess: async () => { successes += 1; due = false; },
    activeRecords: async () => []
  };
  const run = (connection) => runDisruptionAlertWorkerCycle({
    store, config: {}, logger: { warn() {} },
    pushImpl: (record, token, queued, config, { signal }) => sendApnsRequest('api.sandbox.push.apple.com', {}, {}, {
      ...clock.options, signal, connect: connection.connect
    })
  });
  const stalled = fakeConnection();
  const first = run(stalled);
  await turn();
  await clock.advance(NOTIFICATION_REQUEST_TIMEOUT_MS);
  await first;
  assert.equal(retries, 1);
  assert.equal(successes, 0);
  due = true;
  const good = fakeConnection();
  const second = run(good);
  await turn();
  good.request.emit('response', { ':status': 200 });
  good.request.emit('end');
  await second;
  assert.equal(retries, 1);
  assert.equal(successes, 1);
  assert.equal(clock.size(), 0);
});

test('shutdown leaves an unfinished alert queued without consuming a retry', async () => {
  const controller = new AbortController();
  const store = {
    dueQueue: async () => [{ id: 'synthetic-item' }],
    recordForQueueItem: () => ({}), decryptedToken: () => 'synthetic-token',
    markQueueRetry: () => assert.fail('shutdown cannot consume a retry'),
    markQueueSuccess: () => assert.fail('unfinished alert cannot be acknowledged')
  };
  const result = runDisruptionAlertWorkerCycle({
    store, config: {}, signal: controller.signal,
    pushImpl: (record, token, item, config, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await turn();
  controller.abort(new DOMException('Worker stopped', 'AbortError'));
  await rejection;
});

test('real local HTTP2 completes a response and disposes a stalled stream on deadline', { timeout: 5_000 }, async (t) => {
  const clock = manualClock();
  const server = http2.createServer();
  const sessions = new Set();
  const clients = [];
  const bodyStarted = deferred();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    stream.respond({ ':status': 200 });
    if (headers[':path'] === '/complete') stream.end('synthetic-body');
    else { stream.write('partial'); bodyStarted.resolve(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of clients) client.destroy();
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const connect = () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    clients.push(client);
    return client;
  };
  const completed = await sendApnsRequest('unused.invalid', { ':method': 'POST', ':path': '/complete' }, {}, { ...clock.options, connect });
  assert.deepEqual(completed, { status: 200, body: 'synthetic-body' });
  assert.equal(clients[0].destroyed, true);
  const stalled = sendApnsRequest('unused.invalid', { ':method': 'POST', ':path': '/stalled' }, {}, { ...clock.options, connect });
  const rejection = assert.rejects(stalled, /deadline/);
  await bodyStarted.promise;
  await clock.advance(NOTIFICATION_REQUEST_TIMEOUT_MS);
  await rejection;
  assert.equal(clients[1].destroyed, true);
  assert.equal(clock.size(), 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function turn() { return new Promise((resolve) => setImmediate(resolve)); }

function manualClock() {
  let now = 0;
  const timers = new Map();
  const schedule = (callback, delay) => {
    const timer = { at: now + delay, callback, unref() {} };
    timers.set(timer, timer);
    return timer;
  };
  const cancel = (timer) => timers.delete(timer);
  return {
    options: { schedule, cancel }, size: () => timers.size,
    advance: async (milliseconds) => {
      const until = now + milliseconds;
      while (true) {
        const next = [...timers.values()].filter((timer) => timer.at <= until).sort((left, right) => left.at - right.at)[0];
        if (!next) break;
        now = next.at;
        timers.delete(next);
        next.callback();
        await turn();
      }
      now = until;
      await turn();
    }
  };
}

function fakeConnection() {
  const client = new EventEmitter();
  const request = new EventEmitter();
  client.destroyed = request.destroyed = false;
  client.destroy = () => { client.destroyed = true; };
  request.destroy = () => { request.destroyed = true; };
  client.request = (headers) => { request.headers = headers; return request; };
  request.setEncoding = () => {};
  request.end = (body) => { request.body = body; };
  return { client, request, connect: () => client };
}
