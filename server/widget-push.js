import crypto from 'node:crypto';
import path from 'node:path';
import { TransactionalJsonStore } from './transactional-json-store.js';
import { encryptToken, decryptToken, verifyPremiumTransaction } from './disruption-alerts.js';
import { createApnsJwt } from './live-activity.js';
import { sendApnsRequest } from './notification-transport.js';

export const WIDGET_PUSH_PATH = '/api/widgets/token';
export const WIDGET_KINDS = ['TubeBoardFavouriteWidget', 'TubeBoardLineStatusWidget', 'TubeBoardPlatformWidget'];
export const WIDGET_LIMITS = Object.freeze({ leaseMs: 86_400_000, floorMs: 60_000,
  retentionMs: 604_800_000, active: 1024, routes: 4096, buckets: 4096,
  handlers: 32, proofOwners: 4, bodyBytes: 32768, proofBytes: 24576,
  bodyMs: 5000, handlerMs: 20000, proofMs: 15000, cycleMs: 15000, cycleCount: 16 });
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const sameKinds = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validKinds = a => Array.isArray(a) && a.length > 0 && a.length <= 3
  && a.every((v, i) => WIDGET_KINDS.includes(v) && (i === 0 || a[i - 1] < v));
const current = (r, now) => r?.state === 'active' && r.leaseExpiresAt > now;

export function loadWidgetPushConfig(env = process.env, alertConfig) {
  const interval = Number(env.WIDGET_PUSH_WORKER_INTERVAL_MS || 5000);
  return { enabled: env.WIDGET_PUSH_WORKER_ENABLED === 'true',
    intervalMs: Number.isInteger(interval) && interval >= 1000 && interval <= 60000 ? interval : 5000,
    dataFile: env.WIDGET_PUSH_DATA_FILE || path.join('data', 'widget-push.json'),
    encryptionKey: alertConfig.encryptionKey, verification: alertConfig, apns: alertConfig.apns };
}

export function validateWidgetPushPayload(method, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'invalid-body');
  const fields = method === 'PUT' ? ['schemaVersion', 'token', 'environment', 'revision', 'kinds', 'transactionJWS']
    : ['schemaVersion', 'token', 'environment', 'revision'];
  if (Object.keys(value).sort().join() !== fields.sort().join()
      || value.schemaVersion !== 1 || typeof value.token !== 'string' || !/^(?:[0-9a-f]{2}){1,256}$/.test(value.token)
      || !['sandbox', 'production'].includes(value.environment)
      || !Number.isSafeInteger(value.revision) || value.revision < 1) throw fail(400, 'invalid-body');
  if (method === 'PUT' && (!validKinds(value.kinds) || typeof value.transactionJWS !== 'string'
      || !value.transactionJWS.length || Buffer.byteLength(value.transactionJWS) > WIDGET_LIMITS.proofBytes)) throw fail(400, 'invalid-body');
  return value;
}

// This untrusted hint selects a verifier only. It is never entitlement authority.
export function widgetStoreEnvironment(jws) {
  const segments = jws.split('.');
  if (segments.length !== 3 || !segments[1] || !/^[A-Za-z0-9_-]+$/.test(segments[1])) throw fail(403, 'invalid-proof');
  let value;
  try { value = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')); } catch { throw fail(403, 'invalid-proof'); }
  if (value.environment === 'Sandbox') return 'sandbox';
  if (value.environment === 'Production') return 'production';
  throw fail(403, 'invalid-proof');
}

// Fixed-size counters, not an append-only list of denied requests. Expiry is
// swept on admission; there is no per-client timer or unbounded key eviction.
export class WidgetPushAdmission {
  constructor({ now = Date.now, limits = WIDGET_LIMITS } = {}) {
    this.now = now; this.limits = limits; this.handlers = 0; this.proofs = 0;
    this.ip = new Map(); this.token = new Map(); this.global = new Map(); this.secret = crypto.randomBytes(32);
  }
  bucket(map, key, limit, now) {
    for (const [k, b] of map) if (b.until <= now) map.delete(k);
    let b = map.get(key);
    if (!b) { if (map.size >= this.limits.buckets) return false; b = { until: now + 60000, count: 0 }; map.set(key, b); }
    if (b.count >= limit) return false;
    b.count++; return true;
  }
  enter(ip) {
    const now = this.now();
    const key = crypto.createHmac('sha256', this.secret).update(String(ip).slice(0, 256)).digest('hex');
    if (this.handlers >= this.limits.handlers || !this.bucket(this.global, 'request', 120, now)
        || !this.bucket(this.ip, key, 12, now)) throw fail(429, 'admission-limited');
    this.handlers++;
    let done = false; return () => { if (!done) { done = true; this.handlers--; } };
  }
  route(key) { if (!this.bucket(this.token, key, 6, this.now())) throw fail(429, 'admission-limited'); }
  async verify(operation, signal) {
    if (this.proofs >= this.limits.proofOwners || !this.bucket(this.global, 'proof', 60, this.now())) throw fail(503, 'verification-busy');
    this.proofs++;
    // Ownership survives logical timeout until Apple's operation actually ends.
    const work = Promise.resolve().then(operation).finally(() => { this.proofs--; });
    return await bounded(work, signal, this.limits.proofMs, 'proof-timeout');
  }
}

function clean(state, now) {
  for (const r of state.records) if (r.state === 'active' && r.leaseExpiresAt <= now) {
    r.state = 'expired'; delete r.encryptedToken; r.claim = null;
    r.retainUntil = r.leaseExpiresAt + WIDGET_LIMITS.retentionMs;
  }
  state.records = state.records.filter(r => r.state === 'active' || r.retainUntil > now);
}
function normalize(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.records) || value.records.length > WIDGET_LIMITS.routes) throw fail(503, 'invalid-store');
  const keys = new Set(); let active = 0;
  for (const r of value.records) {
    if (!r || !/^[0-9a-f]{64}$/.test(r.key) || keys.has(r.key) || !['sandbox', 'production'].includes(r.environment)
        || !Number.isSafeInteger(r.revision) || r.revision < 1 || typeof r.generation !== 'string'
        || r.generation.length > 64 || !['active', 'expired', 'deleted'].includes(r.state)
        || !Number.isFinite(r.nextAttemptAt) || !Number.isFinite(r.lastAttemptAt)
        || !Number.isSafeInteger(r.failures) || r.failures < 0 || r.failures > 12
        || (r.state === 'active' && (!validKinds(r.kinds) || !Number.isFinite(r.leaseExpiresAt)
          || r.encryptedToken?.algorithm !== 'aes-256-gcm'))
        || (r.state !== 'active' && (r.encryptedToken || !Number.isFinite(r.retainUntil)))) throw fail(503, 'invalid-store');
    keys.add(r.key); if (r.state === 'active') active++;
  }
  if (active > WIDGET_LIMITS.active) throw fail(503, 'invalid-store');
  return value;
}

export class WidgetPushStore extends TransactionalJsonStore {
  constructor(filePath, encryptionKey, limits = WIDGET_LIMITS) {
    super(filePath, { schemaVersion: 1, records: [] }, normalize);
    this.encryptionKey = encryptionKey; this.limits = limits;
  }
  key(payload) { return crypto.createHmac('sha256', this.encryptionKey).update(`${payload.environment}:${payload.token}`).digest('hex'); }
  async prepare(payload, now) {
    return this.transaction(state => {
      clean(state, now);
      const r = state.records.find(r => r.key === this.key(payload));
      this.checkPut(state, r, payload);
      return { value: r?.generation || null };
    });
  }
  checkPut(state, r, payload) {
    if (r && (payload.revision < r.revision || (payload.revision === r.revision
        && (r.state === 'deleted' || !sameKinds(r.kinds, payload.kinds))))) throw fail(409, 'stale-registration');
    if (!r && state.records.length >= this.limits.routes) throw fail(503, 'capacity');
    if (r?.state !== 'active' && state.records.filter(r => r.state === 'active').length >= this.limits.active) throw fail(503, 'capacity');
  }
  async put(payload, entitlement, expectedGeneration, now, signal) {
    return this.transaction(state => {
      signal?.throwIfAborted(); clean(state, now);
      const key = this.key(payload), previous = state.records.find(r => r.key === key);
      if ((previous?.generation || null) !== expectedGeneration) throw fail(409, 'stale-registration');
      this.checkPut(state, previous, payload);
      const expiry = entitlement.expiresAt === null ? now + WIDGET_LIMITS.leaseMs : Date.parse(entitlement.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now || (!entitlement.productID.endsWith('.lifetime') && entitlement.expiresAt === null)) throw fail(403, 'invalid-proof');
      const leaseExpiresAt = Math.min(now + WIDGET_LIMITS.leaseMs, expiry);
      const record = { key, environment: payload.environment, revision: payload.revision, kinds: [...payload.kinds],
        generation: crypto.randomUUID(), state: 'active', encryptedToken: encryptToken(payload.token, this.encryptionKey), leaseExpiresAt,
        lastAttemptAt: previous?.lastAttemptAt || 0, nextAttemptAt: previous?.nextAttemptAt || 0, failures: previous?.failures || 0, claim: null };
      state.records = state.records.filter(r => r.key !== key); state.records.push(record);
      return { value: { schemaVersion: 1, revision: record.revision, expiresAt: new Date(leaseExpiresAt).toISOString() } };
    });
  }
  async remove(payload, now, signal) {
    return this.transaction(state => {
      signal?.throwIfAborted(); clean(state, now);
      const key = this.key(payload), r = state.records.find(r => r.key === key);
      if (r && payload.revision < r.revision) throw fail(409, 'stale-registration');
      if (r?.state === 'deleted' && payload.revision === r.revision) return { changed: false, value: { schemaVersion: 1, revision: r.revision, deleted: true } };
      if (!r && state.records.length >= this.limits.routes) throw fail(503, 'capacity');
      state.records = state.records.filter(r => r.key !== key);
      state.records.push({ key, environment: payload.environment, revision: payload.revision, kinds: [],
        generation: crypto.randomUUID(), state: 'deleted', retainUntil: now + WIDGET_LIMITS.retentionMs,
        lastAttemptAt: r?.lastAttemptAt || 0, nextAttemptAt: r?.nextAttemptAt || 0, failures: 0, claim: null });
      return { value: { schemaVersion: 1, revision: payload.revision, deleted: true } };
    });
  }
  async takeDue(now) {
    return this.transaction(state => {
      clean(state, now);
      const r = state.records.filter(r => current(r, now) && r.nextAttemptAt <= now)
        .sort((a, b) => a.lastAttemptAt - b.lastAttemptAt || a.key.localeCompare(b.key))[0];
      if (!r) return { value: null };
      r.lastAttemptAt = now; r.nextAttemptAt = now + WIDGET_LIMITS.floorMs;
      r.claim = crypto.randomUUID(); return { value: r };
    });
  }
  owns(claim, now) {
    return this.snapshot(s => s.records.some(r => r.key === claim.key && r.generation === claim.generation && r.claim === claim.claim && current(r, now)));
  }
  async finish(claim, result, now) {
    return this.transaction(state => {
      clean(state, now);
      const r = state.records.find(r => r.key === claim.key);
      if (!r || r.generation !== claim.generation || r.claim !== claim.claim || !current(r, now)) return { changed: false };
      r.claim = null;
      if (result === 'accepted') { r.failures = 0; r.lastSuccessAt = now; }
      else if (result === 'invalid-token') {
        r.state = 'deleted'; delete r.encryptedToken; r.retainUntil = now + WIDGET_LIMITS.retentionMs;
      } else if (result !== 'cancelled') {
        r.failures = Math.min(12, r.failures + 1);
        const delay = result === 'rate-limited' ? 300000 : result === 'configuration' ? 600000 : Math.min(3600000, 120000 * 2 ** (r.failures - 1));
        r.nextAttemptAt = Math.max(r.nextAttemptAt, now + delay);
      }
    });
  }
}

export async function pushWidgetHint(record, token, config, { signal, timeoutMs, isCurrent = () => true, send = sendApnsRequest } = {}) {
  if (!config.apns.teamId || !config.apns.keyId || (!config.apns.authKey && !config.apns.authKeyPath)) return 'configuration';
  const jwt = await createApnsJwt(config.apns);
  signal?.throwIfAborted(); if (!isCurrent()) return 'cancelled';
  const host = record.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const response = await send(host, { ':method': 'POST', ':path': `/3/device/${token}`,
    authorization: `bearer ${jwt}`, 'apns-topic': 'OllyJ.My-Train-Times.push-type.widgets',
    'apns-push-type': 'widgets', 'apns-collapse-id': 'tubeboard-widgets',
    'apns-expiration': String(Math.floor(Math.min(record.leaseExpiresAt, Date.now() + 60000) / 1000)),
    'content-type': 'application/json' }, { aps: { 'content-changed': true } }, { signal, timeoutMs });
  signal?.throwIfAborted();
  if (response.status === 200) return 'accepted';
  let reason; try { reason = JSON.parse(response.body).reason; } catch { /* Never log a response body. */ }
  if (response.status === 410 || (response.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason))) return 'invalid-token';
  if (response.status === 429) return 'rate-limited';
  if ([400, 401, 403].includes(response.status)) return 'configuration';
  return 'transient';
}

export async function runWidgetPushWorkerCycle({ store, config, signal, pushImpl = pushWidgetHint, clock = Date.now,
  monotonic = () => performance.now(), limits = WIDGET_LIMITS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(fail(503, 'cycle-timeout')), limits.cycleMs); timer.unref?.();
  const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const end = monotonic() + limits.cycleMs;
  try {
    for (let i = 0; i < limits.cycleCount; i++) {
      ownedSignal.throwIfAborted(); if (monotonic() >= end) break;
      const claim = await store.takeDue(clock()); if (!claim) break;
      let result = 'cancelled';
      try {
        ownedSignal.throwIfAborted();
        if (store.owns(claim, clock())) result = await pushImpl(claim, decryptToken(claim.encryptedToken, store.encryptionKey), config,
          { signal: ownedSignal, timeoutMs: Math.max(1, Math.min(5000, end - monotonic())), isCurrent: () => store.owns(claim, clock()) });
        ownedSignal.throwIfAborted();
      } catch { result = ownedSignal.aborted ? 'cancelled' : 'transient'; }
      await store.finish(claim, result, clock());
      ownedSignal.throwIfAborted();
    }
  } finally { clearTimeout(timer); }
}

function bounded(work, signal, ms, code) {
  let timer, aborted;
  const limit = new Promise((resolve, reject) => {
    aborted = () => reject(signal.reason || fail(408, 'request-aborted'));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    timer = setTimeout(() => reject(fail(504, code)), ms); timer.unref?.();
  });
  return Promise.race([work, limit]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); });
}
async function readBody(request, signal, limits) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fail(400, 'invalid-content-type');
  const read = (async () => {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      signal.throwIfAborted(); bytes += chunk.length;
      if (bytes > limits.bodyBytes) throw fail(413, 'body-too-large'); chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'invalid-json'); }
  })();
  try { return await bounded(read, signal, limits.bodyMs, 'body-timeout'); }
  catch (error) { if (!request.complete) request.destroy(); throw error; }
}

export async function handleWidgetPushRegistration(request, response, { config, store, admission, ip = '',
  verify = verifyPremiumTransaction, clock = Date.now, limits = WIDGET_LIMITS }) {
  const send = (status, body) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
      ...(status === 429 || status === 503 ? { 'retry-after': '60' } : {}) }); response.end(JSON.stringify(body));
  };
  if (!['PUT', 'DELETE'].includes(request.method)) { response.setHeader('allow', 'PUT, DELETE'); send(405, { error: 'unsupported-method' }); return; }
  if (request.url !== WIDGET_PUSH_PATH) { send(400, { error: 'unsupported-query' }); return; }
  if (!config.enabled || config.encryptionKey?.length !== 32) { send(503, { error: 'unavailable' }); return; }
  let leave;
  try { leave = admission.enter(ip); } catch (e) { send(e.status, { error: e.code }); return; }
  const controller = new AbortController();
  const abort = () => { if (!response.writableFinished) controller.abort(fail(408, 'request-aborted')); };
  request.once('aborted', abort); response.once('close', abort);
  const work = (async () => {
    const payload = validateWidgetPushPayload(request.method, await readBody(request, controller.signal, limits));
    admission.route(store.key(payload)); controller.signal.throwIfAborted();
    if (request.method === 'DELETE') return store.remove(payload, clock(), controller.signal);
    const generation = await store.prepare(payload, clock());
    const environment = widgetStoreEnvironment(payload.transactionJWS);
    let entitlement;
    try { entitlement = await admission.verify(() => verify(payload.transactionJWS, environment, config.verification, new Date(clock())), controller.signal); }
    catch (e) { if (e.status === 503 || e.status === 504 || controller.signal.aborted) throw e; throw fail(403, 'invalid-proof'); }
    controller.signal.throwIfAborted();
    return store.put(payload, entitlement, generation, clock(), controller.signal);
  })().finally(() => { leave(); request.removeListener('aborted', abort); response.removeListener('close', abort); });
  try { send(200, await bounded(work, controller.signal, limits.handlerMs, 'handler-timeout')); }
  catch (e) { controller.abort(fail(408, 'request-aborted')); send([400, 403, 409, 413, 429, 503, 504].includes(e.status) ? e.status : 503,
    { error: ['invalid-body', 'invalid-proof', 'stale-registration', 'capacity', 'admission-limited', 'verification-busy', 'body-too-large', 'invalid-json', 'invalid-content-type', 'handler-timeout', 'proof-timeout', 'body-timeout'].includes(e.code) ? e.code : 'unavailable' }); }
}
