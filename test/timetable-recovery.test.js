import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TimetableRecovery } from '../server/timetable-recovery.js';

const EDITION = 'a'.repeat(64), NEXT = 'b'.repeat(64);
const identity = publicationSHA256 => ({ publicationSHA256, proofRevision: 1, proofBodySHA256: 'c'.repeat(64), resourceSHA256: 'd'.repeat(64) });
const dayAt = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timetable-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { now: 1000000, edition: EDITION, admitted: null, coveredScopes: new Set(), calls: [], alerts: [], timers: new Map() };
  const options = {
    filePath: path.join(directory, 'recovery.json'),
    observation: { current: () => ({ publicationSHA256: state.edition,
      observedAt: new Date(state.now - 1).toISOString(), expiresAt: new Date(state.now + 600000).toISOString() }) },
    latestIdentity: async () => identity(state.admitted),
    assessCoverage: async ({ identity: current, requestedScopes, at }) => ({ valid: true, ...current, serviceDay: dayAt(at), assessedAt: at, requiredScopes: [], assessedScopes: requestedScopes, coveredScopes: requestedScopes.filter(s => state.coveredScopes.has(s)), unresolvedScopes: requestedScopes.filter(s => !state.coveredScopes.has(s)) }),
    validScope: scope => /^central\/station\d+$/.test(scope),
    recover: async request => { state.calls.push(request); state.admitted = request.publicationSHA256; request.scopes.forEach(s => state.coveredScopes.add(s)); return { unresolvedScopes: [] }; },
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

test('partial progress advances once; remaining failed scope backs off and recovery clears incident', async t => {
  const { worker, state } = await fixture(t);
  await worker.request('central/station0'); await worker.request('central/station1');
  worker.recover = async request => { state.admitted = EDITION; state.coveredScopes.add('central/station0'); return { unresolvedScopes: ['central/station1'] }; };
  // New coverage makes one immediate pass available before no-progress backoff.
  for (const delay of [0, 0, 60000, 300000]) { state.now += delay; await worker.tick(); }
  assert.equal((await worker.status()).pendingScopes, 1);
  assert.equal(state.alerts.length, 1);
  worker.recover = async () => { state.coveredScopes.add('central/station1'); return { unresolvedScopes: [] }; };
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

test('verified healthy assessment resolves incident after admission succeeded before lost response', async t => {
  const { worker, state } = await fixture(t);
  let attempts = 0;
  worker.recover = async () => { if (++attempts === 3) state.admitted = EDITION; throw new Error('lost response'); };
  worker.alert = async alert => { state.alerts.push(alert); if (state.alerts.length === 1) throw new Error('offline'); };
  for (const delay of [0, 60000, 300000]) { state.now += delay; await worker.tick(); }
  assert.equal((await worker.status()).alertPending, true);
  state.now += 21600000; await worker.tick();
  assert.equal(state.alerts.length, 1);
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
  persisted.phase = 'unresolved'; persisted.pending = ['central/station0']; persisted.completed = [];
  persisted.demandScopes = ['central/station0']; persisted.requiredScopes = []; persisted.resolutionHandoff = null; persisted.assessment = null; persisted.serviceDay = null;
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

test('same edition reassesses London day without rebuilding still-covered immutable proof', async t => {
  const f = await fixture(t); await f.worker.request('central/station0'); await f.worker.tick();
  const before = await f.worker.status(); f.state.now += 86400000; await f.worker.tick();
  const after = await f.worker.status(); assert.notEqual(after.serviceDay, before.serviceDay);
  assert.equal(after.coverageCurrent, true); assert.equal(f.state.calls.length, 1); assert.equal(f.state.timers.size, 0);
});

test('new-day gap cannot be resolved by producer status alone and continuous gap keeps one incident', async t => {
  const f = await fixture(t); await f.worker.request('central/station0'); await f.worker.tick();
  f.state.now += 86400000; f.state.coveredScopes.clear();
  f.worker.recover = async request => { f.state.calls.push(request); return { unresolvedScopes: [] }; };
  for (const delay of [0, 60000, 300000]) { f.state.now += delay; await f.worker.tick(); }
  assert.equal((await f.worker.status()).pendingScopes, 1); assert.equal((await f.worker.status()).coverageCurrent, false);
  assert.equal(f.state.alerts.length, 1); const key = f.state.alerts[0].key;
  f.state.now += 86400000; await f.worker.tick(); assert.equal(f.state.alerts.length, 1);
  assert.equal(f.worker.store.state.incident.key, key); assert.equal(f.worker.store.state.episode, 1);
});

test('legacy completed state is reassessed after restart instead of trusting edition match', async t => {
  const f = await fixture(t); await f.worker.stop(); f.state.admitted = EDITION;
  await fs.writeFile(f.options.filePath, JSON.stringify({ version: 1, edition: EDITION, pending: [],
    completed: ['central/station0'], failures: 0, nextAttemptAt: 0, incident: null }));
  let assessed;
  const resumed = new TimetableRecovery({ ...f.options,
    assessCoverage: async input => { assessed = input.requestedScopes; return f.options.assessCoverage(input); },
    recover: async () => ({ unresolvedScopes: [] }) }); t.after(() => resumed.stop());
  await resumed.tick(); assert.deepEqual(assessed, ['central/station0']);
  assert.equal((await resumed.status()).pendingScopes, 1); assert.equal((await resumed.status()).coverageCurrent, false);
});

test('same edition proof revision change invalidates completion and wrong assessor identity is rejected', async t => {
  const f = await fixture(t); await f.worker.request('central/station0'); await f.worker.tick();
  f.worker.latestIdentity = async () => ({ ...identity(EDITION), proofRevision: 2, proofBodySHA256: 'e'.repeat(64) });
  f.worker.assessCoverage = async input => ({ ...await f.options.assessCoverage(input), proofRevision: 1 });
  await f.worker.tick(); assert.equal((await f.worker.status()).coverageCurrent, false);
  assert.equal(f.worker.store.state.completed.includes('central/station0'), true);
  assert.equal(f.state.calls.length, 1); // no expensive recovery from an invalid assessment
});

test('clock rollback and assessment crossing midnight retain tracked scopes and cannot claim healthy', async t => {
  const f = await fixture(t); await f.worker.request('central/station0'); await f.worker.tick();
  f.state.now -= 1000; await f.worker.tick(); assert.equal((await f.worker.status()).coverageCurrent, false);
  assert.deepEqual(f.worker.store.state.completed, ['central/station0']);
  f.state.now += 2000;
  f.worker.assessCoverage = async input => { const result = await f.options.assessCoverage(input); f.state.now += 86400000; return result; };
  await f.worker.tick(); assert.equal((await f.worker.status()).coverageCurrent, false);
  assert.equal(f.state.calls.length, 1); assert.deepEqual(f.worker.store.state.completed, ['central/station0']);
});

test('midnight during recovery requires current-clock post-admission assessment', async t => {
  const f = await fixture(t); await f.worker.request('central/station0');
  f.worker.recover = async () => { f.state.admitted = EDITION; f.state.now += 86400000; return { unresolvedScopes: [] }; };
  await f.worker.tick(); assert.equal((await f.worker.status()).coverageCurrent, false);
  assert.equal((await f.worker.status()).pendingScopes, 1); assert.equal(f.worker.store.state.serviceDay, dayAt(f.state.now));
});

test('invalid, omitted, overlapping, oversized or stale assessment partitions never discard demand', async t => {
  for (const mutate of [r => ({ ...r, valid: false }), r => ({ ...r, assessedAt: r.assessedAt - 1 }),
    r => ({ ...r, assessedScopes: [], coveredScopes: [], unresolvedScopes: [] }),
    r => ({ ...r, coveredScopes: r.assessedScopes }),
    r => ({ ...r, assessedScopes: Array.from({ length: 257 }, (_, n) => `central/station${n}`) })]) {
    const f = await fixture(t); f.state.admitted = EDITION; await f.worker.request('central/station0');
    f.worker.assessCoverage = async input => mutate(await f.options.assessCoverage(input));
    await f.worker.tick(); assert.equal((await f.worker.status()).coverageCurrent, false);
    assert.deepEqual(f.worker.store.state.pending, ['central/station0']); assert.equal(f.state.calls.length, 0);
  }
});

for (const lostAt of ['before', 'after']) test(`real transport repairs healthy-resolution ${lostAt}-commit crash before a later same-edition gap`, async t => {
  const f = await alertIntegration(t); await f.worker.request('central/station0'); await f.failThree(f.worker);
  assert.equal(f.posts.length, 1); const oldKey = f.worker.store.state.incident.key;
  f.state.admitted = EDITION; f.state.coveredScopes.add('central/station0');
  f.worker.authorizeAlertEdition = async request => {
    if (!request.resolved) return f.transport.authorizeEdition(request);
    if (lostAt === 'after') await f.transport.authorizeEdition(request);
    throw Error('synthetic resolution acknowledgement loss');
  };
  await f.worker.tick(); assert.equal(f.worker.store.state.phase, 'healthy'); await f.worker.stop();
  f.state.now += 86400000; f.state.coveredScopes.clear();
  const transport = new GitHubTimetableRecoveryAlert(f.transportOptions);
  const resumed = new TimetableRecovery({ ...f.options, recover: async () => { throw Error('gap remains'); },
    alert: request => transport.deliver(request), authorizeAlertEdition: request => transport.authorizeEdition(request) }); t.after(() => resumed.stop());
  await f.failThree(resumed); assert.equal(f.posts.length, 2);
  assert.notEqual(resumed.store.state.incident.key, oldKey); assert.equal(resumed.store.state.episode, 1);
  await assert.rejects(transport.deliver({ key: oldKey, publicationSHA256: EDITION, episode: 0, reason: 'qualification-recovery-failed' }));
  const receipt = JSON.parse(await fs.readFile(f.transportOptions.filePath)); assert.equal(receipt.authorizedEpisode, 1);
  assert.equal(receipt.incident.delivered, true); assert.equal(receipt.authorizedResolved, false);
  f.state.now += 86400000; await resumed.tick(); assert.equal(f.posts.length, 2); // continuous gap, no daily incident storm
});

import { assessCurrentPublicationCoverage } from '../server/timetable-current-coverage.js';
import { assetFor, response as coverageResponse, record as coverageRecord, now as coverageNow } from './timetable-renewal-helpers.js';
import { createHash } from 'node:crypto';
test('actual pure current-coverage assessor discovers baseline scopes and rejects a future gap when it becomes today', async t => {
  const raw = coverageResponse(), body = Buffer.from(JSON.stringify(raw)), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const asset = assetFor([raw]); asset.proof.entries[0].apiBodySHA256 = hash(body);
  asset.proof.entries[0].originatingDateGaps = [{ serviceDate: '2026-10-04', reason: 'synthetic future conflict' }];
  asset.proofBytes = Buffer.from(JSON.stringify(asset.proof)); asset.identity.proofBodySHA256 = hash(asset.proofBytes);
  const scope = `${coverageRecord.lineID}/${coverageRecord.stationID}`;
  const key = `${asset.identity.publicationSHA256}\0${asset.identity.proofBodySHA256}\0${scope.replace('/', '\0')}\0default\0${hash(body)}`;
  const comparisonIndex = { isUnavailable: () => false, get: requested => requested === key ? { ...asset.identity, ...coverageRecord, direction: 'default', bodySHA256: hash(body), body } : undefined };
  const f = await fixture(t, { validScope: value => value === scope });
  f.state.now = coverageNow; f.state.edition = asset.identity.publicationSHA256; f.state.admitted = f.state.edition;
  f.worker.latestIdentity = async () => ({ ...asset.identity, resourceSHA256: hash(asset.proofBytes) });
  f.worker.assessCoverage = async ({ requestedScopes, at }) => assessCurrentPublicationCoverage({ asset, comparisonIndex, requestedScopes, at });
  f.worker.recover = async request => { f.state.calls.push(request); return { unresolvedScopes: [] }; };
  await f.worker.tick(); assert.equal((await f.worker.status()).coverageCurrent, true);
  assert.deepEqual(f.worker.store.state.completed, [scope]); assert.equal(f.state.calls.length, 0);
  f.state.now += 86400000; await f.worker.tick();
  assert.equal((await f.worker.status()).coverageCurrent, false); assert.deepEqual(f.worker.store.state.pending, [scope]);
  assert.equal(f.state.calls.length, 1); assert.equal(f.worker.store.state.phase, 'unresolved');
});

test('sorted assessment results do not undo unresolved batch rotation', async t => {
  const f = await fixture(t); f.state.admitted = EDITION;
  for (let n = 0; n < 40; n++) await f.worker.request(`central/station${n}`);
  f.worker.assessCoverage = async input => {
    const r = await f.options.assessCoverage(input); return { ...r, assessedScopes: [...r.assessedScopes].sort(), unresolvedScopes: [...r.unresolvedScopes].sort() };
  };
  f.worker.recover = async request => { f.state.calls.push(request); return { unresolvedScopes: request.scopes }; };
  await f.worker.tick(); f.state.now += 60000; await f.worker.tick();
  assert.equal(f.state.calls[0].scopes.includes('central/station39'), false);
  assert.equal(f.state.calls[1].scopes.includes('central/station39'), true);
});

for (const heldWrite of [1, 2]) test(`proof change during queued ${heldWrite === 1 ? 'assessment' : 'healthy-phase'} write cannot resolve transport custody`, async t => {
  const f = await fixture(t); f.state.admitted = EDITION; f.state.coveredScopes.add('central/station0');
  await f.worker.request('central/station0'); const authorities = []; let revision = 1;
  f.worker.latestIdentity = async () => ({ ...identity(EDITION), proofRevision: revision,
    proofBodySHA256: (revision === 1 ? 'c' : 'e').repeat(64) });
  f.worker.authorizeAlertEdition = async command => authorities.push(command);
  let release, enter; const entered = new Promise(resolve => { enter = resolve; }); const held = new Promise(resolve => { release = resolve; });
  const transaction = f.worker.store.transaction.bind(f.worker.store); let assessmentWrites = 0, armed = false;
  f.worker.assessCoverage = async input => { armed = true; return f.options.assessCoverage(input); };
  f.worker.store.transaction = mutate => {
    const operation = transaction(mutate);
    if (armed && ++assessmentWrites === heldWrite) return operation.then(async value => { enter(); await held; return value; });
    return operation;
  };
  const run = f.worker.tick(); await entered; revision = 2; release(); await run;
  assert.equal(authorities.some(command => command.resolved), false);
  assert.equal(f.worker.store.state.phase, 'unresolved'); assert.equal((await f.worker.status()).coverageCurrent, false);
  assert.equal(f.worker.store.state.resolutionHandoff, null);
});

test('legacy 256 accepted demands coexist with reserved mandatory scopes and no request is lost', async t => {
  const f = await fixture(t); f.state.admitted = EDITION;
  const demand = Array.from({ length: 256 }, (_, n) => `central/station${n}`), required = ['central/station900'];
  for (const scope of demand) assert.equal(await f.worker.request(scope), true);
  f.worker.assessCoverage = async ({ identity: current, requestedScopes, at }) => {
    const all = [...new Set([...required, ...requestedScopes])];
    return { valid: true, ...current, serviceDay: dayAt(at), assessedAt: at, requiredScopes: required,
      assessedScopes: all, coveredScopes: required, unresolvedScopes: demand };
  };
  f.worker.recover = async request => { f.state.calls.push(request); return { unresolvedScopes: request.scopes }; };
  await f.worker.tick(); assert.equal(f.worker.store.state.pending.length, 256);
  assert.equal(f.worker.store.state.completed.length, 1); assert.equal(f.worker.store.state.demandScopes.length, 256);
  assert.deepEqual(f.worker.store.state.requiredScopes, required); assert.equal(f.state.calls[0].scopes.length, 32);
  assert.equal(await f.worker.request(required[0]), true); assert.equal(await f.worker.request('central/station901'), false);
  await f.worker.stop(); const resumed = new TimetableRecovery({ ...f.options, assessCoverage: f.worker.assessCoverage,
    recover: f.worker.recover }); t.after(() => resumed.stop());
  await resumed.tick(); assert.equal(resumed.store.state.pending.length + resumed.store.state.completed.length, 257);
});

test('failed resolved handoff survives restart and new gap until transport returns, without blocking recovery', async t => {
  const f = await alertIntegration(t); await f.worker.request('central/station0'); await f.failThree(f.worker);
  f.state.admitted = EDITION; f.state.coveredScopes.add('central/station0');
  f.worker.authorizeAlertEdition = async command => { if (command.resolved) throw Error('transport unavailable'); return f.transport.authorizeEdition(command); };
  await f.worker.tick(); assert.equal(f.worker.store.state.phase, 'healthy');
  assert.ok(f.worker.store.state.resolutionHandoff); await f.worker.stop();
  f.state.now += 86400000; f.state.coveredScopes.clear(); let offline = true, attempts = 0;
  const transport = new GitHubTimetableRecoveryAlert(f.transportOptions);
  const resumed = new TimetableRecovery({ ...f.options,
    recover: async () => { attempts++; throw Error('current gap'); }, alert: command => transport.deliver(command),
    authorizeAlertEdition: command => { if (offline) throw Error('transport still unavailable'); return transport.authorizeEdition(command); } }); t.after(() => resumed.stop());
  await f.failThree(resumed); assert.equal(attempts, 3); assert.equal(f.posts.length, 1);
  assert.ok(resumed.store.state.resolutionHandoff); assert.equal(resumed.store.state.episode, 1);
  offline = false; f.state.now += 21600000; await resumed.tick();
  assert.equal(f.posts.length, 2); assert.equal(resumed.store.state.resolutionHandoff, null);
  assert.equal(JSON.parse(await fs.readFile(f.transportOptions.filePath)).authorizedEpisode, 1);
});

test('malformed persisted reservation cannot create an extra unbounded demand reserve', async t => {
  const f = await fixture(t); await f.worker.stop(); f.state.admitted = EDITION;
  await fs.writeFile(f.options.filePath, JSON.stringify({ version: 1, edition: EDITION,
    pending: ['central/station0'], completed: [], requiredScopes: [], demandScopes: [],
    failures: 0, nextAttemptAt: 0, incident: null }));
  const errors = []; const resumed = new TimetableRecovery({ ...f.options, onError: error => errors.push(error) }); t.after(() => resumed.stop());
  await resumed.tick(); assert.equal(errors.length, 1); assert.equal(f.state.calls.length, 0);
});

for (const initialPhase of ['unresolved', 'healthy']) test(`new demand queued before healthy write retains ${initialPhase} episode custody until assessed`, async t => {
  const f = await fixture(t); f.state.admitted = EDITION; f.state.coveredScopes.add('central/station0');
  await f.worker.request('central/station0');
  if (initialPhase === 'healthy') await f.worker.tick();
  const authorities = []; f.worker.authorizeAlertEdition = async command => authorities.push(command);
  const transaction = f.worker.store.transaction.bind(f.worker.store);
  let armed = false, writes = 0, release, entered;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  f.worker.assessCoverage = async input => { const r = await f.options.assessCoverage(input); armed = true; return r; };
  f.worker.store.transaction = mutate => {
    if (armed && ++writes === 2) {
      // Hold BEFORE the healthy transaction enters the durable queue. A real
      // accepted request therefore commits ahead of its mutation callback.
      entered(); return gate.then(() => transaction(mutate));
    }
    return transaction(mutate);
  };
  f.worker.recover = async () => ({ unresolvedScopes: [] });
  const run = f.worker.tick(); await waiting;
  await f.worker.request('central/station1'); const authorityCount = authorities.length; release(); await run;
  assert.ok(f.worker.store.state.pending.includes('central/station1'));
  assert.equal(f.worker.store.state.phase, 'unresolved'); assert.equal((await f.worker.status()).coverageCurrent, false);
  assert.equal(authorities.slice(authorityCount).some(command => command.resolved), false);
});
