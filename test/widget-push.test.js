import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SerialWorker } from '../server/worker-lifecycle.js';
import { TransactionalJsonStore } from '../server/transactional-json-store.js';
import { WIDGET_LIMITS, WIDGET_KINDS, WidgetPushStore, WidgetPushAdmission,
  validateWidgetPushPayload, widgetStoreEnvironment, runWidgetPushWorkerCycle, pushWidgetHint } from '../server/widget-push.js';

const now = Date.parse('2026-10-19T12:00:00Z');
const key = Buffer.alloc(32, 7);
const proof = { productID: 'uk.net.jeffers.tubeboard.premium.lifetime', expiresAt: null };
const payload = (overrides = {}) => ({ schemaVersion: 1, token: 'ab'.repeat(32), environment: 'production',
  kinds: [WIDGET_KINDS[0]], revision: 1, transactionJWS: 'e30.eyJlbnZpcm9ubWVudCI6IlNhbmRib3gifQ.signature', ...overrides });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, limits = WIDGET_LIMITS) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-widget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new WidgetPushStore(path.join(dir, 'widget-push.json'), key, limits);
}
async function put(store, p = payload(), at = now, entitlement = proof) {
  return store.put(p, entitlement, await store.prepare(p, at), at);
}

test('strict widget contract rejects extra/private fields and malformed primitives', async t => {
  assert.equal(validateWidgetPushPayload('PUT', payload()).environment, 'production');
  const negatives = [{ token: 12 }, { token: 'a' }, { token: 'AA' }, { revision: true }, { revision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { environment: 'Sandbox' }, { kinds: [] }, { kinds: [WIDGET_KINDS[0], WIDGET_KINDS[0]] },
    { kinds: [...WIDGET_KINDS].reverse() }, { station: 'private' }, { transactionJWS: 'x'.repeat(24577) }];
  for (const bad of negatives) await t.test(JSON.stringify(Object.keys(bad)), () => assert.throws(() => validateWidgetPushPayload('PUT', payload(bad)), { status: 400 }));
  const deletion = { schemaVersion: 1, token: 'aa', environment: 'production', revision: 1 };
  assert.deepEqual(validateWidgetPushPayload('DELETE', deletion), deletion);
  assert.throws(() => validateWidgetPushPayload('DELETE', { ...deletion, kinds: [] }));
  assert.equal(widgetStoreEnvironment(payload().transactionJWS), 'sandbox');
  assert.throws(() => widgetStoreEnvironment('a.e30.b'), { status: 403 });
  assert.throws(() => widgetStoreEnvironment('a.bnVsbA.b'), { status: 403 });
});

test('same revision renewal needs fresh proof, is capped, and stores neither token nor proof', async t => {
  const store = await fixture(t); const first = await put(store);
  const later = now + 84000000;
  const renewed = await put(store, payload(), later, { ...proof, expiresAt: new Date(later + 120000).toISOString() });
  assert.equal(renewed.revision, first.revision); assert.equal(Date.parse(renewed.expiresAt), later + 120000);
  const raw = await fs.readFile(store.filePath, 'utf8');
  for (const text of [payload().token, payload().transactionJWS, proof.productID, 'transactionJWS', 'station', 'installID']) assert.equal(raw.includes(text), false);
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
  await assert.rejects(put(store, payload({ kinds: [WIDGET_KINDS[1]] }), later), { status: 409 });
  await assert.rejects(put(store, payload(), later, { productID: 'uk.net.jeffers.tubeboard.premium.monthly', expiresAt: null }), { status: 403 });
  await assert.rejects(put(store, payload(), later, { ...proof, expiresAt: new Date(later).toISOString() }), { status: 403 });
});

test('ordinary lease expiry can renew but deletion and stale verification cannot revive', async t => {
  const store = await fixture(t); await put(store);
  const oldGeneration = await store.prepare(payload(), now + 1);
  await store.remove(payload({ revision: 2 }), now + 2);
  await assert.rejects(store.put(payload(), proof, oldGeneration, now + 3), { status: 409 });
  await assert.rejects(put(store, payload({ revision: 2 }), now + 3), { status: 409 });
  await put(store, payload({ revision: 3 }), now + 4);
  const afterExpiry = now + WIDGET_LIMITS.leaseMs + 10;
  await store.takeDue(afterExpiry);
  const expired = store.state.records[0]; assert.equal(expired.state, 'expired'); assert.equal(expired.encryptedToken, undefined);
  await put(store, payload({ revision: 3 }), afterExpiry);
  const before = await store.prepare(payload({ revision: 3 }), afterExpiry + 1);
  await put(store, payload({ revision: 3 }), afterExpiry + 2);
  await assert.rejects(store.put(payload({ revision: 3 }), proof, before, afterExpiry + 3), { status: 409 });
});

test('capacity reserves in-place deletion; finite cleanup removes only expired fences', async t => {
  const store = await fixture(t, { ...WIDGET_LIMITS, active: 1, routes: 2 });
  await put(store); await assert.rejects(put(store, payload({ token: 'bb' })), { status: 503 });
  await store.remove(payload({ token: 'cc' }), now);
  await store.remove(payload(), now); // Full total pool still admits known deletion.
  assert.equal(store.state.records.length, 2); assert.ok(store.state.records.every(r => r.state === 'deleted' && !r.encryptedToken));
  await assert.rejects(store.remove(payload({ token: 'dd' }), now), { status: 503 });
  await assert.rejects(put(store, payload({ token: 'dd' })), { status: 503 });
  await store.takeDue(now + WIDGET_LIMITS.retentionMs + 1);
  assert.equal(store.state.records.length, 0);
});

test('unknown-delete quota cannot exhaust verified capacity and preserves pending-proof fences across reload and cleanup', async t => {
  const limits = { ...WIDGET_LIMITS, active: 2, routes: 5, unknownDeletes: 2 };
  const store = await fixture(t, limits);
  for (const token of ['01', '02']) await store.remove(payload({ token }), now);
  await assert.rejects(store.remove(payload({ token: '03' }), now), { status: 503 });
  await put(store, payload({ token: 'aa' })); await put(store, payload({ token: 'bb' }));
  await store.remove(payload({ token: 'aa', revision: 2 }), now + 1);
  await put(store, payload({ token: '01', revision: 2 }), now + 1);
  assert.equal(store.state.records.filter(r => r.unknownDelete).length, 1, 'only verified PUT releases an unknown-delete slot');
  await store.remove(payload({ token: '03' }), now + 1);
  assert.equal(store.state.records.length, 5);
  await store.remove(payload({ token: 'bb', revision: 2 }), now + 1); // Known deletion remains possible at full capacity.
  const reloaded = new WidgetPushStore(store.filePath, key, limits); await reloaded.load();
  await reloaded.remove(payload({ token: '02', revision: 2 }), now + 2);
  assert.equal(reloaded.state.records.filter(r => r.unknownDelete).length, 2, 'proofless revision updates preserve origin');
  await assert.rejects(reloaded.remove(payload({ token: '04' }), now + 2), { status: 503 });
  await reloaded.takeDue(now + WIDGET_LIMITS.leaseMs + WIDGET_LIMITS.retentionMs + 10);
  assert.equal(reloaded.state.records.length, 0);
  await reloaded.remove(payload({ token: '04' }), now + WIDGET_LIMITS.leaseMs + WIDGET_LIMITS.retentionMs + 11);
  assert.equal(reloaded.state.records[0].unknownDelete, true);

  const pending = await fixture(t, limits); const p = payload({ token: 'cc' });
  const generation = await pending.prepare(p, now); assert.equal(generation, null);
  await pending.remove({ ...p, revision: 2 }, now + 1);
  await assert.rejects(pending.put(p, proof, generation, now + 2), { status: 409 });
  await assert.rejects(put(pending, { ...p, revision: 2 }, now + 2), { status: 409 });
  await put(pending, { ...p, revision: 3 }, now + 3);
  assert.equal(pending.state.records[0].unknownDelete, false);
});

test('admission has bounded keys/counts and does not release noncooperative proof ownership at timeout', async t => {
  let clock = now;
  const limits = { ...WIDGET_LIMITS, buckets: 2, handlers: 2, proofOwners: 1, proofMs: 5 };
  const admission = new WidgetPushAdmission({ limits, now: () => clock });
  const leaveA = admission.enter('a'), leaveB = admission.enter('b');
  assert.throws(() => admission.enter('c'), { status: 429 }); leaveA(); leaveB();
  assert.throws(() => admission.enter('c'), { status: 429 }); assert.equal(admission.ip.size, 2);
  for (let i = 0; i < 6; i++) admission.route('route');
  for (let i = 0; i < 100; i++) assert.throws(() => admission.route('route'), { status: 429 });
  assert.equal(admission.token.get('route').count, 6);
  const gate = deferred(); const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(admission.verify(() => gate.promise), { status: 504 });
  assert.equal(admission.proofs, 1); await assert.rejects(admission.verify(async () => proof), { status: 503 });
  gate.resolve(proof); await new Promise(resolve => setImmediate(resolve)); assert.equal(admission.proofs, 0);
  clock += 60001; const leaveC = admission.enter('c'); leaveC(); assert.equal(admission.ip.size, 1);
});

test('serial fair cycles bound count and send frequency across renewal and restart without source fetches', async t => {
  const store = await fixture(t); let clock = now; const sent = []; let fetching = 0;
  const savedFetch = globalThis.fetch; globalThis.fetch = async () => { fetching++; throw Error('No source requests'); };
  t.after(() => { globalThis.fetch = savedFetch; });
  for (let i = 1; i <= 5; i++) await put(store, payload({ token: i.toString(16).padStart(2, '0') }));
  const cycle = () => runWidgetPushWorkerCycle({ store, config: {}, clock: () => clock, limits: { ...WIDGET_LIMITS, cycleCount: 2 },
    pushImpl: async r => { sent.push([r.key, clock]); clock += 2000; return 'accepted'; } });
  await cycle(); await put(store, payload({ token: 'ff' }), clock); await cycle(); await cycle();
  assert.equal(sent.length, 6); assert.equal(new Set(sent.map(v => v[0])).size, 6);
  await put(store, payload({ token: '01' }), clock); await cycle(); assert.equal(sent.length, 6);
  const restarted = new WidgetPushStore(store.filePath, key); await restarted.load();
  assert.equal(await restarted.takeDue(clock), null);
  clock = now + 60000; await cycle(); assert.equal(sent.length, 8); assert.equal(fetching, 0);
  assert.ok(sent.slice(6).every(([k, at]) => at - sent.find(v => v[0] === k)[1] >= 60000));
  const firstRoutes = new Set(sent.slice(0, 6).map(v => v[0]));
  for (let i = 128; i < 132; i++) { await put(store, payload({ token: i.toString(16) }), clock); await cycle(); }
  assert.ok(sent.slice(6, 12).every(v => firstRoutes.has(v[0])), 'continuously arriving new routes cannot preempt older due routes');
});

test('bounded widget loader rejects oversized, symlinked, duplicate and malformed persisted authority', async t => {
  for (const shape of ['oversize', 'symlink', 'duplicate', 'bad-record', 'extra-private-field',
    'origin-string', 'active-unknown-origin', 'missing-origin', 'unknown-over-quota', 'known-over-reserve']) await t.test(shape, async t => {
    const store = await fixture(t);
    if (shape === 'oversize') { await fs.writeFile(store.filePath, 'x'); await fs.truncate(store.filePath, 8 * 1024 * 1024 + 1); }
    if (shape === 'symlink') { await fs.writeFile(store.filePath + '.owned', '{}'); await fs.symlink(store.filePath + '.owned', store.filePath); }
    if (shape === 'duplicate') await fs.writeFile(store.filePath, '{"schemaVersion":1,"schemaVersion":1,"records":[]}');
    if (shape === 'bad-record') await fs.writeFile(store.filePath, '{"schemaVersion":1,"records":[{}]}');
    if (shape === 'extra-private-field') await fs.writeFile(store.filePath, '{"schemaVersion":1,"records":[],"transactionJWS":"synthetic"}');
    if (['origin-string', 'active-unknown-origin', 'missing-origin'].includes(shape)) {
      await put(store); const data = store.state;
      if (shape === 'origin-string') data.records[0].unknownDelete = 'false';
      if (shape === 'active-unknown-origin') data.records[0].unknownDelete = true;
      if (shape === 'missing-origin') delete data.records[0].unknownDelete;
      await fs.writeFile(store.filePath, JSON.stringify(data));
    }
    if (['unknown-over-quota', 'known-over-reserve'].includes(shape)) {
      const unknownDelete = shape === 'unknown-over-quota';
      const count = unknownDelete ? WIDGET_LIMITS.unknownDeletes + 1 : WIDGET_LIMITS.routes - WIDGET_LIMITS.unknownDeletes + 1;
      const records = Array.from({ length: count }, (_, i) => ({ key: i.toString(16).padStart(64, '0'), environment: 'production',
        revision: 1, generation: '00000000-0000-0000-0000-000000000000', state: 'deleted', kinds: [], unknownDelete,
        createdAt: now, retainUntil: now + WIDGET_LIMITS.retentionMs, lastAttemptAt: 0, nextAttemptAt: 0, failures: 0, claim: null }));
      await fs.writeFile(store.filePath, JSON.stringify({ schemaVersion: 1, records }));
    }
    await assert.rejects(new WidgetPushStore(store.filePath, key).load(), { status: 503 });
  });
});

test('fixed-buffer loader detects growth and optional shared loader preserves original default consumers', async t => {
  const store = await fixture(t); await fs.writeFile(store.filePath, '{"schemaVersion":1,"records":[]}');
  const original = fs.open;
  fs.open = async (...args) => {
    const descriptor = await original(...args); let changed = false;
    return { stat: () => descriptor.stat(), close: () => descriptor.close(), read: async (...readArgs) => {
      if (!changed) { changed = true; await fs.appendFile(store.filePath, ' '); }
      return descriptor.read(...readArgs);
    } };
  };
  try { await assert.rejects(store.load(), { status: 503 }); } finally { fs.open = original; }
  let loads = 0;
  const custom = new TransactionalJsonStore(store.filePath, {}, x => x, async () => { loads++; return { synthetic: true }; });
  await custom.load(); await custom.load(); assert.equal(loads, 1); assert.deepEqual(custom.state, { synthetic: true });
  await fs.writeFile(store.filePath, '{"original":true}');
  const unchanged = new TransactionalJsonStore(store.filePath, {}, x => x); await unchanged.load();
  assert.deepEqual(unchanged.state, { original: true });
});

test('idle cycles perform no writes while real expiry cleanup commits once', async t => {
  const store = await fixture(t); await put(store); await store.takeDue(now);
  const before = await fs.stat(store.filePath); let writes = 0;
  const original = fs.writeFile;
  fs.writeFile = async (file, ...args) => { if (String(file).startsWith(store.filePath + '.')) writes++; return original(file, ...args); };
  try {
    for (let i = 0; i < 5; i++) assert.equal(await store.takeDue(now + 1000), null);
    assert.equal(writes, 0); assert.equal((await fs.stat(store.filePath)).mtimeMs, before.mtimeMs);
    const expiredAt = now + WIDGET_LIMITS.leaseMs + 1;
    assert.equal(await store.takeDue(expiredAt), null); assert.equal(writes, 1);
    const persisted = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
    assert.equal(persisted.records[0].state, 'expired'); assert.equal(persisted.records[0].encryptedToken, undefined);
    await store.takeDue(expiredAt + 1); assert.equal(writes, 1);
  } finally { fs.writeFile = original; }
});

test('cycle deadline and backoff preserve floors; invalid token removes ciphertext', async t => {
  const store = await fixture(t); await put(store); await put(store, payload({ token: 'bb' }));
  let clock = now, elapsed = 0, calls = 0;
  await runWidgetPushWorkerCycle({ store, config: {}, clock: () => clock, monotonic: () => elapsed,
    pushImpl: async () => { calls++; elapsed += 15001; return 'rate-limited'; } });
  assert.equal(calls, 1);
  const rateLimited = store.state.records.find(r => r.failures === 1); assert.equal(rateLimited.nextAttemptAt, now + 300000);
  await runWidgetPushWorkerCycle({ store, config: {}, clock: () => clock, pushImpl: async () => 'invalid-token' });
  const invalid = store.state.records.find(r => r.state === 'deleted'); assert.equal(invalid.encryptedToken, undefined);
  clock += 300001; await runWidgetPushWorkerCycle({ store, config: {}, clock: () => clock, pushImpl: async () => 'transient' });
  assert.equal(store.state.records.find(r => r.state === 'active').nextAttemptAt, clock + 240000);
  const late = await fixture(t); await put(late); let elapsedLate = 0, afterDeadline = 0;
  const take = late.takeDue.bind(late);
  late.takeDue = async at => { const claim = await take(at); elapsedLate = 15001; return claim; };
  await runWidgetPushWorkerCycle({ store: late, config: {}, clock: () => now, monotonic: () => elapsedLate,
    pushImpl: async () => { afterDeadline++; return 'accepted'; } });
  assert.equal(afterDeadline, 0, 'slow persistence cannot admit APNs after the cycle deadline');
});

test('stale send completions after deletion, renewal, expiry and stop cannot acknowledge or back off a newer route', async t => {
  for (const change of ['delete', 'renew', 'expire', 'stop']) await t.test(change, async t => {
    const store = await fixture(t); await put(store); const gate = deferred(), entered = deferred(); let clock = now;
    const controller = new AbortController();
    const cycle = runWidgetPushWorkerCycle({ store, config: {}, signal: controller.signal, clock: () => clock,
      pushImpl: async () => { entered.resolve(); await gate.promise; return 'accepted'; } });
    await entered.promise;
    if (change === 'delete') await store.remove(payload({ revision: 2 }), clock);
    if (change === 'renew') await put(store, payload(), clock + 1);
    if (change === 'expire') clock += WIDGET_LIMITS.leaseMs;
    if (change === 'stop') controller.abort();
    gate.resolve(); if (change === 'stop') await assert.rejects(cycle); else await cycle;
    assert.equal(store.state.records.some(r => r.lastSuccessAt !== undefined), false);
  });
});

test('actual SerialWorker coalesces widget cycles and aborts its only in-flight transport at stop', async t => {
  const store = await fixture(t); await put(store); let active = 0, maximum = 0; const entered = deferred();
  const worker = new SerialWorker({ intervalMs: 60000, initialDelayMs: 60000,
    run: signal => runWidgetPushWorkerCycle({ store, config: {}, signal, clock: () => now,
      pushImpl: async (r, token, config, { signal }) => { maximum = Math.max(maximum, ++active); entered.resolve();
        try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
        finally { active--; } } }) });
  worker.start(); const first = worker.trigger(); await entered.promise; void worker.trigger(); await worker.stop(); await first;
  assert.equal(active, 0); assert.equal(maximum, 1); assert.equal(store.state.records[0].lastSuccessAt, undefined);
});

test('widget APNs uses the independent environment and fixed topic, hint, collapse and finite expiration', async t => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { apns: { teamId: 'SYNTHETIC', keyId: 'SYNTHETIC', authKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) } };
  for (const environment of ['production', 'sandbox']) {
    let observed;
    const result = await pushWidgetHint({ environment, leaseExpiresAt: Date.now() + 30000 }, 'aa', config,
      { send: async (...args) => { observed = args; return { status: 200 }; } });
    assert.equal(result, 'accepted'); assert.equal(observed[0], environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com');
    assert.equal(observed[1]['apns-topic'], 'OllyJ.My-Train-Times.push-type.widgets');
    assert.equal(observed[1]['apns-push-type'], 'widgets'); assert.equal(observed[1]['apns-priority'], undefined);
    assert.equal(observed[1]['apns-collapse-id'], 'tubeboard-widgets');
    assert.ok(Number(observed[1]['apns-expiration']) <= Math.floor((Date.now() + 30000) / 1000));
    assert.deepEqual(observed[2], { aps: { 'content-changed': true } });
  }
  for (const [status, reason, expected] of [[410, 'Unregistered', 'invalid-token'], [400, 'BadDeviceToken', 'invalid-token'],
    [429, 'TooManyRequests', 'rate-limited'], [403, 'ExpiredProviderToken', 'configuration'], [500, 'InternalServerError', 'transient']]) {
    assert.equal(await pushWidgetHint({ environment: 'production', leaseExpiresAt: Date.now() + 60000 }, 'aa', config,
      { send: async () => ({ status, body: JSON.stringify({ reason }) }) }), expected);
  }
  let sent = false;
  assert.equal(await pushWidgetHint({ environment: 'production' }, 'aa', config,
    { isCurrent: () => false, send: async () => { sent = true; } }), 'cancelled'); assert.equal(sent, false);
});
