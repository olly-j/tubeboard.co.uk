import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { WIDGET_LIMITS, WidgetPushAdmission, WidgetPushStore, handleWidgetPushRegistration } from '../server/widget-push.js';
import { verifyPremiumTransaction } from '../server/disruption-alerts.js';

const now = Date.parse('2026-10-19T12:00:00Z');
const payload = overrides => ({ schemaVersion: 1, token: 'aa'.repeat(32), environment: 'production', revision: 1,
  kinds: ['TubeBoardFavouriteWidget'], transactionJWS: 'e30.eyJlbnZpcm9ubWVudCI6IlNhbmRib3gifQ.signature', ...overrides });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function start(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-widget-http-'));
  const limits = { ...WIDGET_LIMITS, ...options.limits };
  const store = new WidgetPushStore(path.join(dir, 'widget-push.json'), Buffer.alloc(32, 7));
  const admission = new WidgetPushAdmission({ limits, now: () => now });
  const verification = { bundleId: 'OllyJ.My-Train-Times' };
  const config = { enabled: true, encryptionKey: Buffer.alloc(32, 7), verification };
  const observed = [];
  const verify = options.verify || (async (jws, environment, config, at) => {
    observed.push({ environment, bundleId: config.bundleId });
    return verifyPremiumTransaction(jws, environment, config, at, async () => ({
      verifyAndDecodeTransaction: async () => ({ bundleId: 'OllyJ.My-Train-Times',
        productId: 'uk.net.jeffers.tubeboard.premium.yearly', expiresDate: now + 86400000, ...options.transaction })
    }));
  });
  const server = http.createServer((request, response) => {
    void handleWidgetPushRegistration(request, response, { store, admission, config, verify, limits, clock: () => now, ip: 'owned-test' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (value, method = 'PUT', suffix = '/api/widgets/token') => fetch(origin + suffix,
    { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(3000) });
  return { store, admission, observed, send, origin };
}

test('real HTTP handler verifies sandbox purchase for production APNs, renews same revision and acknowledges exact schema', async t => {
  const f = await start(t);
  const first = await f.send(payload()); assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { schemaVersion: 1, revision: 1, expiresAt: new Date(now + 86400000).toISOString() });
  const renewed = await f.send(payload()); assert.equal(renewed.status, 200);
  assert.equal(f.observed.length, 2); assert.deepEqual(f.observed[0], { environment: 'sandbox', bundleId: 'OllyJ.My-Train-Times' });
  assert.equal(f.store.state.records[0].environment, 'production');
  assert.equal((await f.send(payload({ kinds: ['TubeBoardLineStatusWidget'] }))).status, 409);
  const deletion = { schemaVersion: 1, token: payload().token, environment: 'production', revision: 2 };
  const removed = await f.send(deletion, 'DELETE'); assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { schemaVersion: 1, revision: 2, deleted: true });
  assert.equal((await f.send(payload({ revision: 2 }))).status, 409);
  assert.equal(f.observed.length, 2, 'rejected equal state/tombstone is checked before costly proof');
});

test('actual existing verifier rejects foreign, revoked, expired and missing-expiry subscription proofs', async t => {
  for (const transaction of [{ bundleId: 'other' }, { productId: 'other' }, { revocationDate: now - 1 },
    { expiresDate: now }, { expiresDate: undefined }]) await t.test(Object.keys(transaction)[0], async t => {
    const f = await start(t, { transaction }); const response = await f.send(payload());
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'invalid-proof' });
    assert.equal(f.store.state.records.length, 0);
  });
});

test('handler body/shape/admission bounds reject before proof and never echo private input', async t => {
  const f = await start(t);
  assert.equal((await f.send(payload(), 'POST')).status, 405);
  assert.equal((await f.send(payload(), 'PUT', '/api/widgets/token?token=private')).status, 400);
  const extra = await f.send(payload({ installID: 'private-identity' })); assert.equal(extra.status, 400);
  assert.equal((await extra.text()).includes('private-identity'), false);
  assert.equal((await f.send(payload({ transactionJWS: 'x'.repeat(32768) }))).status, 413);
  assert.equal(f.observed.length, 0);
  for (let i = 0; i < 6; i++) assert.equal((await f.send(payload())).status, 200);
  const rate = await f.send(payload()); assert.equal(rate.status, 429);
  assert.equal(rate.headers.get('retry-after'), '60'); assert.equal(f.observed.length, 6);
});

test('logical handler timeout retains proof owner, then late verification cannot create a registration', async t => {
  const gate = deferred(); const entered = deferred();
  const f = await start(t, { limits: { handlerMs: 30, proofMs: 1000 }, verify: async () => { entered.resolve(); return gate.promise; } });
  const work = f.send(payload()); await entered.promise; const response = await work;
  assert.equal(response.status, 504); assert.equal(f.admission.proofs, 1);
  assert.equal(f.store.state.records.length, 0);
  gate.resolve({ productID: 'uk.net.jeffers.tubeboard.premium.lifetime', expiresAt: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.admission.proofs, 0); assert.equal(f.store.state.records.length, 0);
});

test('slow unfinished body is terminated and releases the bounded handler admission', async t => {
  const f = await start(t, { limits: { bodyMs: 20, handlerMs: 100 } });
  await new Promise((resolve, reject) => {
    const request = http.request(f.origin + '/api/widgets/token', { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    const timer = setTimeout(() => { request.destroy(); reject(Error('Owned slow-body deadline missed')); }, 1500);
    request.on('error', () => { clearTimeout(timer); resolve(); });
    request.on('response', response => { response.resume(); response.on('end', () => { clearTimeout(timer); resolve(); }); });
    request.write('{');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.admission.handlers, 0); assert.equal(f.observed.length, 0);
});

test('actual index route stays optional and disabled without touching any store or old public endpoint', { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-widget-index-'));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, PORT: '0', LIVE_ACTIVITY_WORKER_ENABLED: 'false', DISRUPTION_ALERT_WORKER_ENABLED: 'false',
      TUBEBOARD_STATUS_MONITOR_ENABLED: 'false', LIVE_ACTIVITY_DATA_FILE: path.join(dir, 'live.json'),
      DISRUPTION_ALERT_DATA_FILE: path.join(dir, 'alerts.json'), WIDGET_PUSH_DATA_FILE: path.join(dir, 'widget.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    await fs.rm(dir, { recursive: true, force: true }); });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Local listen timeout')), 5000); let output = '';
    child.once('error', reject); child.stdout.on('data', bytes => { output = (output + bytes).slice(-4096);
      const match = /http:\/\/localhost:\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  const response = await fetch(origin + '/api/widgets/token', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'unavailable' });
  for (const p of ['/healthz', '/privacy', '/support', '/contracts/widget-push-registration-v1.schema.json']) assert.equal((await fetch(origin + p)).status, 200, p);
  assert.equal((await fetch(origin + '/contracts/fixtures/widget-push-registration-v1.json')).status, 404);
  assert.equal((await fetch(origin + '/server/widget-push.js')).status, 404);
  const badHost = await new Promise((resolve, reject) => { const request = http.get(origin + '/api/widgets/token', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.once('error', reject); });
  assert.equal(badHost, 400); assert.deepEqual(await fs.readdir(dir), []);
});
