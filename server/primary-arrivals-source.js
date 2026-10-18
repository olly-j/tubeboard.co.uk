import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const PRIMARY_ARRIVALS_PATH = '/api/primary-arrivals/v1/central/940GZZLUWOF';
export const PRIMARY_ARRIVALS_UPSTREAM = 'https://api.tfl.gov.uk/TrackerNet/predictiondetailed/C/WFD';
const IDENTITY = Object.freeze({ schemaVersion: 1, sourceID: 'trackernet-arrivals-v1', stationID: '940GZZLUWOF', lineID: 'central' });
const LIMIT = 65_536, HEADER_LIMIT = 1024, ENVELOPE_LIMIT = 524_288;
const unavailable = reason => Object.freeze({ ...IDENTITY, status: 'unavailable', reason });
export function loadPrimaryArrivalsConfig(env = process.env) {
  return { enabled: env.TUBEBOARD_PRIMARY_ARRIVALS_ENABLED === 'true', appKey: env.TFL_TRACKERNET_APP_KEY || '' };
}
function publicationSafe(value, secret) {
  // Scan decoded representations without modifying the original published XML.
  const variants = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
  let text = value;
  for (let depth = 0; depth < 5; depth++) {
    if (variants.some(key => text.includes(key))) return false;
    const decoded = text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)))
      .replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&apos;':"'" })[entity])
      .replace(/%([0-9a-f]{2})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
    if (decoded === text) return true;
    text = decoded;
  }
  return false; // Nested representation beyond the bounded scan is withheld.
}
function header(response, name) {
  const value = response.headers.get(name);
  if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > HEADER_LIMIT || /[\r\n\0]/.test(value))) throw Error('metadata');
  return value;
}
function observationBufferLifetime(upstream) {
  // This is an original transport observation, not a newly current HTTP cache.
  // Client qualification always uses the unchanged upstream clocks/metadata.
  return /(?:^|,)\s*(?:no-store|private)(?:\s*(?:=|,|$))/i.test(upstream.cacheControl || '') ? 0 : 30_000;
}
export class PrimaryArrivalsSource {
  constructor({ enabled = false, appKey = '', fetchImpl = fetch, clock = Date.now, timeoutMs = 8000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw Error('deadline');
    this.enabled = enabled; this.appKey = appKey; this.fetchImpl = fetchImpl; this.clock = clock; this.timeoutMs = timeoutMs;
    this.inflight = null; this.cached = null; this.cacheUntil = -Infinity; this.nextRequestAt = -Infinity;
  }
  getSource() {
    if (this.enabled !== true) return Promise.resolve(unavailable('disabled'));
    if (typeof this.appKey !== 'string' || !this.appKey || this.appKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(this.appKey)) return Promise.resolve(unavailable('missingKey'));
    if (this.inflight) return this.inflight;
    const now = this.clock();
    if (!Number.isFinite(now)) return Promise.resolve(unavailable('invalidResponse'));
    if (this.cached && now < this.cacheUntil) return Promise.resolve(this.cached);
    if (now < this.nextRequestAt) return Promise.resolve(unavailable('rateLimited'));
    this.nextRequestAt = now + 30_000;
    const work = this.capture(now);
    this.inflight = work;
    void work.finally(() => { if (this.inflight === work) this.inflight = null; });
    return work;
  }
  async capture(started) {
    const controller = new AbortController(); let timer, reader, responseBody, expired = false;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); if (reader) void reader.cancel().catch(() => {}); reject(Error('deadline')); }, this.timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetchImpl(PRIMARY_ARRIVALS_UPSTREAM, { method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/xml', 'User-Agent': 'TubeBoard/1.0 (iOS)', 'Cache-Control': 'no-cache', app_key: this.appKey } });
        controller.signal.throwIfAborted(); responseBody = response.body;
        if (!response.ok || response.status !== 200) { if (response.body) void response.body.cancel().catch(() => {}); return unavailable(response.status === 429 ? 'rateLimited' : 'upstreamFailed'); }
        if (response.redirected || response.url && response.url !== PRIMARY_ARRIVALS_UPSTREAM || !response.body) throw Error('response');
        const upstream = Object.freeze({ date: header(response, 'date'), age: header(response, 'age'), cacheControl: header(response, 'cache-control'), contentType: header(response, 'content-type') });
        if (!/^(?:application|text)\/xml(?:\s*;\s*charset\s*=\s*["']?utf-8["']?)?\s*$/i.test(upstream.contentType || '')) throw Error('content type');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) throw Error('length');
        const chunks = []; let size = 0; reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read(); controller.signal.throwIfAborted(); if (done) break;
          const bytes = Buffer.from(value); size += bytes.length; if (size > LIMIT) throw Error('body bound'); chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks, size); if (!size) throw Error('empty body');
        const bodyUTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!Buffer.from(bodyUTF8).equals(bytes) || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(bodyUTF8) || /\x00/.test(bodyUTF8)) throw Error('XML transport');
        if (!publicationSafe(bodyUTF8, this.appKey) || Object.values(upstream).some(value => value !== null && !publicationSafe(value, this.appKey))) throw Error('reflection');
        const received = this.clock(); if (!Number.isFinite(received) || received < started) throw Error('clock');
        const source = Object.freeze({ ...IDENTITY, status: 'source', bodyUTF8, bodySHA256: createHash('sha256').update(bytes).digest('hex'), upstream,
          requestStartedAt: new Date(started).toISOString(), receivedAt: new Date(received).toISOString() });
        if (Buffer.byteLength(JSON.stringify(source)) > ENVELOPE_LIMIT) throw Error('envelope bound');
        const lifetime = observationBufferLifetime(upstream); this.cached = lifetime ? source : null; this.cacheUntil = received + lifetime;
        return source; // Complete bytes only. No claim of semantic XML validity or empty trains.
      })()]);
    } catch { return unavailable(expired ? 'timeout' : 'invalidResponse'); }
    finally { clearTimeout(timer); try { const cancelled = reader ? reader.cancel() : responseBody?.cancel(); if (cancelled) void cancelled.catch(() => {}); } catch {} if (reader) { try { reader.releaseLock(); } catch {} } }
  }
}
export async function handlePrimaryArrivalsSource(request, response, url, source) {
  if (!url.pathname.startsWith('/api/primary-arrivals/')) return false;
  let status, value;
  if (url.pathname !== PRIMARY_ARRIVALS_PATH) { status = 404; value = unavailable('unsupportedSelection'); }
  else if (request.method !== 'GET') { status = 405; value = unavailable('unsupportedMethod'); }
  else if (url.search) { status = 400; value = unavailable('unsupportedQuery'); }
  else { value = await source.getSource(); status = value.status === 'source' ? 200 : value.reason === 'rateLimited' ? 429 : 503; }
  if (response.destroyed || response.writableEnded) return true;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(status === 405 ? { allow: 'GET' } : {}), ...(status === 429 ? { 'retry-after': '30' } : {}) });
  response.end(JSON.stringify(value)); return true;
}
