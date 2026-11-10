// A narrowly scoped fallback for hosted qualification workers that cannot
// download TfL's public timetable ZIP directly. It never stores an archive in
// the project or persistent /data volume and never qualifies timetable rows.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { TIMETABLE_PUBLICATION_URL } from './station-board-seed.js';
import { timetableHTTPObservation } from './station-board-timetable.js';

export const SOURCE_ARCHIVE_TRANSFER_PREFIX = '/api/timetable-source-archives/v1/';
export const SOURCE_ARCHIVE_TRANSFER_AUDIENCE = 'tubeboard-timetable-source-archive';
export const MAX_SOURCE_ZIP_BYTES = 160 * 1024 * 1024;
export const SOURCE_ARCHIVE_TRANSFER_COOLDOWN_MS = 10 * 60_000;
export const SOURCE_ARCHIVE_TRANSFER_WORKFLOW_REF = 'olly-j/My-Train-Times/.github/workflows/timetable-publication.yml@refs/heads/main';
const SHA = /^[a-f0-9]{64}$/;
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_KEYS = createRemoteJWKSet(new URL(`${OIDC_ISSUER}/.well-known/jwks`));
const OIDC_REPOSITORY = 'olly-j/My-Train-Times';
const OIDC_REPOSITORY_ID = '1267669215';
const OIDC_REF = 'refs/heads/main';
const OIDC_EVENTS = new Set(['schedule', 'workflow_dispatch']);
const DEFAULT_TIMEOUT_MS = 30_000;
const SOURCE_URL = new URL(TIMETABLE_PUBLICATION_URL);

export async function verifySourceArchiveOIDC(token, { now = Date.now, verify = jwtVerify } = {}) {
  if (typeof token !== 'string' || token.length < 100 || token.length > 8192) return false;
  try {
    const { payload } = await verify(token, OIDC_KEYS, {
      issuer: OIDC_ISSUER,
      audience: SOURCE_ARCHIVE_TRANSFER_AUDIENCE,
      algorithms: ['RS256'],
      maxTokenAge: '5 minutes',
      clockTolerance: 10,
      currentDate: new Date(now())
    });
    return payload.iss === OIDC_ISSUER
      && payload.aud === SOURCE_ARCHIVE_TRANSFER_AUDIENCE
      && payload.repository === OIDC_REPOSITORY
      && payload.repository_id === OIDC_REPOSITORY_ID
      && payload.ref === OIDC_REF
      && payload.workflow_ref === SOURCE_ARCHIVE_TRANSFER_WORKFLOW_REF
      && OIDC_EVENTS.has(payload.event_name)
      && payload.sub === `repo:${OIDC_REPOSITORY}:ref:${OIDC_REF}`;
  } catch {
    return false;
  }
}

function errorResponse(response, status, message, { retryAfter, allow } = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ ok: false, error: message }) + '\n');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...(retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }),
    ...(allow ? { allow } : {})
  });
  response.end(body);
}

function freshPublicationObservation(observation, publicationSHA256, now) {
  let current;
  try { current = observation?.current?.(); } catch { return false; }
  if (!current || current.schemaVersion !== 1 || current.source !== TIMETABLE_PUBLICATION_URL
      || current.publicationSHA256 !== publicationSHA256 || !SHA.test(current.publicationSHA256)) return false;
  const observedAt = Date.parse(current.observedAt);
  const expiresAt = Date.parse(current.expiresAt);
  return Number.isFinite(observedAt) && Number.isFinite(expiresAt)
    && observedAt <= now && now < expiresAt && expiresAt - observedAt <= 10 * 60_000;
}

export class TimetableSourceArchiveTransfer {
  constructor({ observation, fetchImpl = fetch, verifyOIDC = verifySourceArchiveOIDC, now = Date.now,
    tempDirectory = os.tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_SOURCE_ZIP_BYTES, cooldownMs = SOURCE_ARCHIVE_TRANSFER_COOLDOWN_MS } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOURCE_ZIP_BYTES
        || !Number.isSafeInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > SOURCE_ARCHIVE_TRANSFER_COOLDOWN_MS) {
      throw new Error('Invalid source archive transfer bounds');
    }
    this.observation = observation;
    this.fetchImpl = fetchImpl;
    this.verifyOIDC = verifyOIDC;
    this.now = now;
    this.tempDirectory = tempDirectory;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.cooldownMs = cooldownMs;
    this.active = false;
    this.nextTransferAt = -Infinity;
  }

  async transfer(publicationSHA256, response) {
    const now = this.now();
    if (!Number.isFinite(now) || !freshPublicationObservation(this.observation, publicationSHA256, now)) {
      errorResponse(response, 409, 'Current timetable edition unavailable');
      return;
    }
    if (this.active || now < this.nextTransferAt) {
      const retryAfter = this.active ? 30 : Math.max(1, Math.ceil((this.nextTransferAt - now) / 1000));
      errorResponse(response, 429, 'Timetable archive transfer is rate limited', { retryAfter });
      return;
    }
    // Set the floor before contacting TfL so failures cannot amplify requests.
    this.active = true;
    this.nextTransferAt = now + this.cooldownMs;

    let temporaryDirectory;
    let temporaryFile;
    let reader;
    let handle;
    let upstreamBody;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(SOURCE_URL);
      url.searchParams.set('tb085', randomUUID());
      const upstream = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/octet-stream', 'Cache-Control': 'no-cache',
          'User-Agent': 'TubeBoard official timetable source transfer/1' }
      });
      upstreamBody = upstream.body;
      if (upstream.status !== 200 || upstream.redirected || !upstream.body
          || (upstream.url && upstream.url !== url.href)) throw new Error('upstream');
      const upstreamSHA = upstream.headers.get('x-amz-meta-sha256');
      const contentType = upstream.headers.get('content-type') || '';
      if (upstreamSHA !== publicationSHA256
          || !/^(?:application\/octet-stream|application\/zip)(?:\s*;|$)/i.test(contentType)
          || ![null, 'identity'].includes(upstream.headers.get('content-encoding')?.toLowerCase() ?? null)) {
        throw new Error('identity');
      }
      const startedAt = this.now();
      const sourceClock = timetableHTTPObservation({ date: upstream.headers.get('date'), age: upstream.headers.get('age') },
        startedAt, { official: true });
      if (!sourceClock) throw new Error('source clock');
      const lengthHeader = upstream.headers.get('content-length');
      if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) < 1
          || Number(lengthHeader) > this.maxBytes)) throw new Error('source size');

      temporaryDirectory = await fs.mkdtemp(path.join(this.tempDirectory, 'tubeboard-timetable-archive-'));
      temporaryFile = path.join(temporaryDirectory, 'source.zip');
      handle = await fs.open(temporaryFile, 'wx', 0o600);
      reader = upstream.body.getReader();
      const hasher = createHash('sha256');
      let total = 0;
      while (true) {
        if (response.destroyed || controller.signal.aborted) throw new Error('cancelled');
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > this.maxBytes || (lengthHeader !== null && total > Number(lengthHeader))) throw new Error('source size');
        hasher.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (result.bytesWritten < 1) throw new Error('temporary write');
          offset += result.bytesWritten;
        }
      }
      if (total < 1 || (lengthHeader !== null && total !== Number(lengthHeader))
          || hasher.digest('hex') !== publicationSHA256) throw new Error('archive digest');
      await handle.close();
      handle = null;
      const receivedAt = this.now();
      if (!Number.isFinite(receivedAt) || receivedAt < startedAt || receivedAt >= sourceClock.expiresAt) throw new Error('source expired');
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(total),
        'content-disposition': `attachment; filename="timetable-${publicationSHA256}.zip"`,
        'cache-control': 'no-store',
        etag: `"tfl-timetable-${publicationSHA256}"`,
        'x-content-type-options': 'nosniff',
        'x-tubeboard-source-use': 'verified-qualification-input-only',
        'x-tubeboard-publication-sha256': publicationSHA256,
        'x-tubeboard-source-url': TIMETABLE_PUBLICATION_URL,
        'x-tubeboard-source-http-date': upstream.headers.get('date'),
        'x-tubeboard-source-http-age': upstream.headers.get('age'),
        ...(upstream.headers.get('last-modified')
          ? { 'x-tubeboard-source-last-modified': upstream.headers.get('last-modified') } : {})
      });
      await pipeline(createReadStream(temporaryFile), response);
    } catch {
      if (!response.headersSent) errorResponse(response, 503, 'Official timetable archive unavailable');
      else if (!response.writableEnded && !response.destroyed) response.destroy();
    } finally {
      clearTimeout(timer);
      controller.abort();
      try { if (reader) await reader.cancel(); else if (upstreamBody) await upstreamBody.cancel(); } catch {}
      try { if (handle) await handle.close(); } catch {}
      if (temporaryDirectory) { try { await fs.rm(temporaryDirectory, { recursive: true, force: true }); } catch {} }
      this.active = false;
    }
  }
}

export async function handleTimetableSourceArchiveTransfer(request, response, url, transfer) {
  if (!url.pathname.startsWith(SOURCE_ARCHIVE_TRANSFER_PREFIX)) return false;
  const rawSHA = url.pathname.slice(SOURCE_ARCHIVE_TRANSFER_PREFIX.length);
  if (url.search || !SHA.test(rawSHA)) {
    errorResponse(response, 404, 'Official timetable archive unavailable');
    return true;
  }
  const authorization = request.headers?.authorization;
  const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7) : '';
  if (!transfer?.verifyOIDC || !(await transfer.verifyOIDC(token))) {
    errorResponse(response, 404, 'Official timetable archive unavailable');
    return true;
  }
  if (request.method !== 'GET') {
    errorResponse(response, 405, 'Method not allowed', { allow: 'GET' });
    return true;
  }
  await transfer.transfer(rawSHA, response);
  return true;
}
