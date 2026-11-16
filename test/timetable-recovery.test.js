import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TimetableRecovery } from '../server/timetable-recovery.js';

const EDITION = 'a'.repeat(64), NEXT = 'b'.repeat(64);
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timetable-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { now: 1000000, edition: EDITION, admitted: null, calls: [], alerts: [], timers: new Map() };
  const options = {
    filePath: path.join(directory, 'recovery.json'),
    observation: { current: () => ({ publicationSHA256: state.edition,
      observedAt: new Date(state.now - 1).toISOString(), expiresAt: new Date(state.now + 600000).toISOString() }) },
    latestIdentity: async () => ({ publicationSHA256: state.admitted }),
    validScope: scope => /^central\/station\d+$/.test(scope),
    recover: async request => { state.calls.push(request); state.admitted = request.publicationSHA256; return { unresolvedScopes: [] }; },
    alert: async alert => { state.alerts.push(alert); }, now: () => state.now,
    schedule: (callback, delay) => { const key = {}; state.timers.set(key, { callback, delay }); return key; },
    cancel: key => state.timers.delete(key),
    ...overrides
  };
  const worker = new TimetableRecovery(options);
  t.after(() => worker.stop());
  return { worker, state, options };
}

test('healthy observed edition does no preparation or timer work', async t => {
  const { worker, state } = await fixture(t);
  state.admitted = EDITION;
  await worker.tick(); await worker.tick();
  assert.equal(state.calls.length, 0);
  assert.equal(state.timers.size, 0);
});

test('rollover prepares once then unchanged observations do no work', async t => {
  const { worker, state } = await fixture(t);
  await worker.tick(); await worker.tick();
  assert.equal(state.calls.length, 1);
  state.edition = NEXT;
  await worker.tick(); await worker.tick();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].publicationSHA256, NEXT);
});

test('valid demand is deduplicated and at most 32 scopes enter each batch', async t => {
  const { worker, state } = await fixture(t);
  state.admitted = EDITION;
  assert.equal(await worker.request('unknown/secret'), false);
  for (let index = 0; index < 35; index++) assert.equal(await worker.request(`central/station${index}`), true);
  await worker.request('central/station0');
  await worker.tick();
  assert.equal(state.calls[0].scopes.length, 32);
  assert.equal((await worker.status()).pendingScopes, 3);
  await worker.tick();
  assert.equal(state.calls[1].scopes.length, 3);
  await worker.request('central/station0'); await worker.tick();
  assert.equal(state.calls.length, 2);
});

test('simultaneous triggers never prepare concurrently and preserve new demand', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { worker, state } = await fixture(t);
  const original = worker.recover;
  worker.recover = async request => { entered(); await gate; return original(request); };
  await worker.request('central/station0');
  const first = worker.tick(); await began;
  await worker.request('central/station1'); const second = worker.tick();
  release(); await Promise.all([first, second]);
  assert.deepEqual(state.calls.map(call => call.scopes), [['central/station0'], ['central/station1']]);
});

test('failure backoff survives process restart; alert is deduplicated across repeated failure', async t => {
  const { worker, state, options } = await fixture(t);
  let attempts = 0;
  const fail = async () => { attempts++; throw new Error('private diagnostic'); };
  worker.recover = fail;
  await worker.tick(); await worker.tick();
  assert.equal(attempts, 1);
  await worker.stop();
  const resumed = new TimetableRecovery({ ...options, recover: fail });
  t.after(() => resumed.stop());
  await resumed.tick(); assert.equal(attempts, 1);
  for (const delay of [60000, 300000, 1800000]) { state.now += delay; await resumed.tick(); }
  assert.equal(attempts, 4);
  assert.equal(state.alerts.length, 1);
  assert.equal((await resumed.status()).alertPending, false);
  const persisted = await fs.readFile(options.filePath, 'utf8');
  assert.equal(persisted.includes('private diagnostic'), false);
});

test('undelivered alert retries with the same idempotency key', async t => {
  const { worker, state } = await fixture(t);
  worker.recover = async () => { throw new Error('unavailable'); };
  worker.alert = async alert => { state.alerts.push(alert); throw new Error('transport offline'); };
  for (const delay of [0, 60000, 300000, 21600000]) { state.now += delay; await worker.tick(); }
  assert.equal(state.alerts.length, 2);
  assert.equal(state.alerts[0].key, state.alerts[1].key);
  assert.equal((await worker.status()).alertPending, true);
});

test('producer success without matching committed identity remains a failure', async t => {
  const { worker } = await fixture(t, { recover: async () => ({ unresolvedScopes: [] }) });
  await worker.request('central/station0'); await worker.tick();
  assert.equal((await worker.status()).failures, 1);
  assert.equal((await worker.status()).pendingScopes, 1);
});

test('partial qualification retains failed scopes with backoff; recovery clears incident', async t => {
  const { worker, state } = await fixture(t);
  await worker.request('central/station0'); await worker.request('central/station1');
  worker.recover = async request => { state.admitted = EDITION; return { unresolvedScopes: ['central/station1'] }; };
  for (const delay of [0, 60000, 300000]) { state.now += delay; await worker.tick(); }
  assert.equal((await worker.status()).pendingScopes, 1);
  assert.equal(state.alerts.length, 1);
  worker.recover = async () => ({ unresolvedScopes: [] });
  state.now += 1800000; await worker.tick();
  assert.equal((await worker.status()).pendingScopes, 0);
  assert.equal((await worker.status()).failures, 0);
  assert.equal((await worker.status()).alertPending, false);
});

test('new edition bypasses old edition backoff but not coverage checks', async t => {
  const { worker, state } = await fixture(t);
  const recover = worker.recover;
  worker.recover = async () => { throw new Error('failed'); };
  await worker.tick();
  state.edition = NEXT; worker.recover = recover;
  await worker.tick();
  assert.equal(state.calls.length, 1);
  assert.equal(state.admitted, NEXT);
});

test('expired or missing observations do not start recovery', async t => {
  const { worker, state } = await fixture(t);
  worker.observation.current = () => null;
  await worker.tick();
  worker.observation.current = () => ({ publicationSHA256: EDITION,
    observedAt: new Date(state.now - 100).toISOString(), expiresAt: new Date(state.now).toISOString() });
  await worker.tick(); assert.equal(state.calls.length, 0);
});

test('queue capacity is bounded and persistent completed scopes count toward the bound', async t => {
  const { worker } = await fixture(t);
  for (let index = 0; index < 256; index++) assert.equal(await worker.request(`central/station${index}`), true);
  assert.equal(await worker.request('central/station256'), false);
  await worker.tick();
  assert.equal(await worker.request('central/station256'), false);
});

test('stop cancels active work without converting cancellation into an incident', async t => {
  const { worker, state } = await fixture(t);
  let started;
  const began = new Promise(resolve => { started = resolve; });
  worker.recover = async ({ signal }) => { started(); await new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }); };
  const running = worker.tick(); await began; await worker.stop(); await running;
  assert.equal((await worker.status()).failures, 0);
  assert.equal(state.alerts.length, 0);
  assert.equal(state.timers.size, 0);
});

test('expired or changed official authority during preparation cannot complete demand', async t => {
  for (const changed of [false, true]) {
    const { worker, state } = await fixture(t);
    await worker.request('central/station0');
    const original = worker.recover;
    worker.recover = async request => {
      const result = await original(request);
      worker.observation.current = () => ({ publicationSHA256: changed ? NEXT : EDITION,
        observedAt: new Date(state.now - 10).toISOString(), expiresAt: new Date(state.now + (changed ? 1000 : 0)).toISOString() });
      return result;
    };
    await worker.tick();
    assert.equal((await worker.status()).pendingScopes, 1);
    assert.equal((await worker.status()).failures, 1);
  }
});

test('pending alert retries even after admission succeeded before a lost producer response', async t => {
  const { worker, state } = await fixture(t);
  let attempts = 0;
  worker.recover = async () => { if (++attempts === 3) state.admitted = EDITION; throw new Error('lost response'); };
  worker.alert = async alert => { state.alerts.push(alert); if (state.alerts.length === 1) throw new Error('offline'); };
  for (const delay of [0, 60000, 300000]) { state.now += delay; await worker.tick(); }
  assert.equal((await worker.status()).alertPending, true);
  state.now += 21600000; await worker.tick();
  assert.equal(state.alerts.length, 2);
  assert.equal(state.alerts[0].key, state.alerts[1].key);
  assert.equal(attempts, 3);
  assert.equal((await worker.status()).alertPending, false);
});

test('unresolved batch rotates so a later station is not starved', async t => {
  const { worker, state } = await fixture(t);
  for (let index = 0; index < 33; index++) await worker.request(`central/station${index}`);
  worker.recover = async request => { state.calls.push(request); state.admitted = EDITION; return { unresolvedScopes: request.scopes }; };
  await worker.tick(); state.now += 60000; await worker.tick();
  assert.equal(state.calls[1].scopes[0], 'central/station32');
});

test('abrupt termination preserves attempt budget and pending incident for restart', async t => {
  const { worker, state, options } = await fixture(t);
  await worker.tick(); await worker.stop();
  // Persisted reservation is the exact durable state left if a process dies
  // after reserving its third attempt but before its producer returns.
  const persisted = JSON.parse(await fs.readFile(options.filePath));
  persisted.edition = NEXT; persisted.failures = 3; persisted.nextAttemptAt = state.now + 1800000;
  persisted.incident = { key: 'c'.repeat(64), delivered: false };
  await fs.writeFile(options.filePath, JSON.stringify(persisted));
  state.edition = NEXT; state.admitted = NEXT;
  const resumed = new TimetableRecovery(options); t.after(() => resumed.stop());
  await resumed.tick(); assert.equal(state.alerts.length, 0);
  state.now += 1800000; await resumed.tick();
  assert.equal(state.alerts.length, 1);
  assert.equal((await resumed.status()).alertPending, false);
});

// Integration uses the real durable transport with offline HTTP only.
import { GitHubTimetableRecoveryAlert } from '../server/timetable-recovery-github-alert.js';
const issueURL = 'https://api.github.com/repos/olly-j/My-Train-Times/issues/298';
async function alertIntegration(t) {
  const f = await fixture(t); const comments = []; const posts = [];
  const transportOptions = { filePath: `${f.options.filePath}.alerts`, token: 'injected-test-token', actorID: 42, now: () => f.state.now,
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return new Response(JSON.stringify(comments));
      const comment = { id: posts.length + 1, issue_url: issueURL, user: { id: 42 }, body: JSON.parse(options.body).body };
      comments.push(comment); posts.push(comment); return new Response(JSON.stringify(comment), { status: 201 });
    } };
  const transport = new GitHubTimetableRecoveryAlert(transportOptions);
  f.worker.alert = request => transport.deliver(request);
  f.worker.authorizeAlertEdition = request => transport.authorizeEdition(request);
  f.worker.recover = async () => { throw Error('fixed synthetic failure'); };
  const failThree = async worker => { await worker.tick(); f.state.now += 60000; await worker.tick(); f.state.now += 300000; await worker.tick(); };
  return { ...f, transportOptions, transport, posts, failThree };
}

test('real alert transport authorizes empty state then rollover alerts without manual supersession', async t => {
  const f = await alertIntegration(t); await f.failThree(f.worker); assert.equal(f.posts.length, 1);
  f.state.edition = NEXT; await f.failThree(f.worker); assert.equal(f.posts.length, 2);
  assert.match(f.posts[0].body, new RegExp(EDITION)); assert.match(f.posts[1].body, new RegExp(NEXT));
  await assert.rejects(f.transport.deliver({ publicationSHA256: EDITION, key: (await import('node:crypto')).createHash('sha256').update(`timetable-recovery:${EDITION}`).digest('hex'), reason: 'qualification-recovery-failed' }));
  await assert.rejects(f.transport.authorizeEdition({ publicationSHA256: EDITION, generation: 1 }));
});

test('restart repairs crash after coordinator commit before alert store synchronization', async t => {
  const f = await alertIntegration(t); await f.failThree(f.worker); f.state.edition = NEXT;
  f.worker.authorizeAlertEdition = async () => { throw Error('process interrupted before alert store commit'); };
  await f.worker.tick(); await f.worker.stop();
  const coordinator = JSON.parse(await fs.readFile(f.options.filePath)); assert.equal(coordinator.edition, NEXT); assert.equal(coordinator.editionGeneration, 2);
  const transport = new GitHubTimetableRecoveryAlert(f.transportOptions);
  const resumed = new TimetableRecovery({ ...f.options, recover: async () => { throw Error('failed'); }, alert: r => transport.deliver(r), authorizeAlertEdition: r => transport.authorizeEdition(r) }); t.after(() => resumed.stop());
  f.state.now += 21600000; await f.failThree(resumed); assert.equal(f.posts.length, 2);
  assert.equal(JSON.parse(await fs.readFile(f.transportOptions.filePath)).authorityGeneration, 2);
});

test('restart repairs synchronization whose acknowledgement was lost after alert store commit', async t => {
  const f = await alertIntegration(t); let lost = true;
  f.worker.authorizeAlertEdition = async request => { await f.transport.authorizeEdition(request); if (lost) { lost = false; throw Error('ack lost'); } };
  await f.worker.tick(); assert.equal(f.posts.length, 0); await f.worker.stop();
  const transport = new GitHubTimetableRecoveryAlert(f.transportOptions);
  const resumed = new TimetableRecovery({ ...f.options, recover: async () => { throw Error('failed'); }, alert: r => transport.deliver(r), authorizeAlertEdition: r => transport.authorizeEdition(r) }); t.after(() => resumed.stop());
  f.state.now += 21600000; await f.failThree(resumed); assert.equal(f.posts.length, 1);
  await assert.rejects(transport.authorizeEdition({ publicationSHA256: NEXT, generation: 1 }));
});

test('alert authorization storage failure does not block successful timetable recovery', async t => {
  const f = await fixture(t, { authorizeAlertEdition: async () => { throw Error('alert storage unavailable'); } });
  await f.worker.tick();
  assert.equal(f.state.calls.length, 1); assert.equal(f.state.admitted, EDITION);
  const status = await f.worker.status(); assert.equal(status.failures, 0); assert.equal(status.nextAttemptAt, 0);
  assert.equal(status.alertPending, false); assert.equal(f.state.alerts.length, 0); assert.equal(f.state.timers.size, 0);
});

test('failed recovery retains pending incident while failed authorization prevents alert delivery', async t => {
  const f = await fixture(t, { authorizeAlertEdition: async () => { throw Error('alert storage unavailable'); }, recover: async () => { throw Error('provider failure'); } });
  await f.worker.tick(); f.state.now += 60000; await f.worker.tick(); f.state.now += 300000; await f.worker.tick();
  assert.equal((await f.worker.status()).failures, 3); assert.equal((await f.worker.status()).alertPending, true);
  assert.equal(f.state.alerts.length, 0); assert.equal(f.state.timers.size, 1);
  f.worker.authorizeAlertEdition = async () => {};
  f.state.now += 21600000; await f.worker.tick();
  assert.equal(f.state.alerts.length, 1); assert.equal((await f.worker.status()).alertPending, false);
});
