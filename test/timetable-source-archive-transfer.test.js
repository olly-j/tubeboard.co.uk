import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import {
  SOURCE_ARCHIVE_TRANSFER_AUDIENCE, SOURCE_ARCHIVE_TRANSFER_COOLDOWN_MS,
  SOURCE_ARCHIVE_TRANSFER_WORKFLOW_REF, TimetableSourceArchiveTransfer,
  handleTimetableSourceArchiveTransfer, verifySourceArchiveOIDC
} from '../server/timetable-source-archive-transfer.js';
import { TIMETABLE_PUBLICATION_URL } from '../server/station-board-seed.js';

const publicationSHA256 = 'a'.repeat(64);
const token = 'eyJhbGciOiJSUzI1NiJ9.' + 'x'.repeat(120) + '.signature';
const fixedNow = Date.parse('2026-11-10T17:00:00Z');

function observation(sha = publicationSHA256, observedAt = fixedNow - 60_000, expiresAt = fixedNow + 9 * 60_000) {
  return { current: () => ({ schemaVersion: 1, source: TIMETABLE_PUBLICATION_URL,
    publicationSHA256: sha, observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString() }) };
}

function responseFor(bytes, { status = 200, sha = publicationSHA256,
  date = new Date(fixedNow).toUTCString(), age = '0', contentType = 'application/zip',
  contentLength = String(bytes.length), lastModified = 'Mon, 09 Nov 2026 00:38:16 GMT' } = {}) {
  const headers = {
    'x-amz-meta-sha256': sha, 'content-type': contentType,
    date, age,
    ...(lastModified ? { 'last-modified': lastModified } : {})
  };
  if (contentLength !== null) headers['content-length'] = contentLength;
  return new Response(bytes, { status, headers });
}

async function withServer(t, transfer) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!await handleTimetableSourceArchiveTransfer(request, response, url, transfer)) {
      response.writeHead(404); response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const archiveURL = sha => `/api/timetable-source-archives/v1/${sha}`;
const auth = { authorization: `Bearer ${token}` };

async function waitForEmpty(directory) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await fs.readdir(directory)).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await fs.readdir(directory), []);
}

test('OIDC verifier pins GitHub issuer, audience, repository, protected ref, workflow and event', async () => {
  const claims = {
    iss: 'https://token.actions.githubusercontent.com', aud: SOURCE_ARCHIVE_TRANSFER_AUDIENCE,
    sub: 'repo:olly-j/My-Train-Times:ref:refs/heads/main',
    repository: 'olly-j/My-Train-Times', repository_id: '1267669215',
    ref: 'refs/heads/main', workflow_ref: SOURCE_ARCHIVE_TRANSFER_WORKFLOW_REF,
    event_name: 'schedule'
  };
  let options;
  const verifier = async (jwt, keyset, input) => {
    assert.equal(jwt, token); assert.ok(keyset); options = input;
    return { payload: claims };
  };
  assert.equal(await verifySourceArchiveOIDC(token, { now: () => fixedNow, verify: verifier }), true);
  assert.equal(options.issuer, 'https://token.actions.githubusercontent.com');
  assert.equal(options.audience, SOURCE_ARCHIVE_TRANSFER_AUDIENCE);
  assert.equal(options.maxTokenAge, '5 minutes');
  assert.deepEqual(options.algorithms, ['RS256']);
  for (const altered of [
    { event_name: 'pull_request' }, { repository_id: 'other' },
    { ref: 'refs/heads/feature' }, { workflow_ref: 'olly-j/My-Train-Times/.github/workflows/other.yml@refs/heads/main' },
    { sub: 'repo:olly-j/My-Train-Times:pull_request' }
  ]) {
    assert.equal(await verifySourceArchiveOIDC(token, { now: () => fixedNow,
      verify: async () => ({ payload: { ...claims, ...altered } }) }), false);
  }
  assert.equal(await verifySourceArchiveOIDC('short', { verify: verifier }), false);
  assert.equal(await verifySourceArchiveOIDC(token, { verify: async () => { throw new Error('bad signature'); } }), false);
});

test('authorized current edition returns only bytes whose official metadata and digest match', async t => {
  const bytes = Buffer.from('verified official ZIP bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-source-transfer-'));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  let calls = 0;
  const transfer = new TimetableSourceArchiveTransfer({ observation: observation(sha), now: () => fixedNow,
    tempDirectory, verifyOIDC: async value => value === token,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url.origin + url.pathname, TIMETABLE_PUBLICATION_URL);
      assert.ok(url.searchParams.has('tb085'));
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return responseFor(bytes, { sha });
    }
  });
  const origin = await withServer(t, transfer);
  const response = await fetch(origin + archiveURL(sha), { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="timetable-${sha}.zip"`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), `"tfl-timetable-${sha}"`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-tubeboard-source-use'), 'verified-qualification-input-only');
  assert.equal(response.headers.get('x-tubeboard-publication-sha256'), sha);
  assert.equal(response.headers.get('x-tubeboard-source-url'), TIMETABLE_PUBLICATION_URL);
  assert.equal(response.headers.get('x-tubeboard-source-http-age'), '0');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(calls, 1);
  await waitForEmpty(tempDirectory);
  const limited = await fetch(origin + archiveURL(sha), { headers: auth });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(calls, 1);
});

test('missing or invalid OIDC identity is indistinguishable from an unknown archive and never contacts TfL', async t => {
  let calls = 0;
  const transfer = new TimetableSourceArchiveTransfer({ observation: observation(), now: () => fixedNow,
    verifyOIDC: async value => value === token,
    fetchImpl: async () => { calls += 1; throw new Error('must not call upstream'); }
  });
  const origin = await withServer(t, transfer);
  for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer invalid' }]) {
    const response = await fetch(origin + archiveURL(publicationSHA256), { headers });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(origin + archiveURL(publicationSHA256) + '?redirect=x', { headers: auth })).status, 404);
  assert.equal((await fetch(origin + '/api/timetable-source-archives/v1/not-a-sha', { headers: auth })).status, 404);
  assert.equal(calls, 0);
});

test('stale or different official edition observations are rejected before any source request', async t => {
  let calls = 0;
  for (const current of [
    observation('b'.repeat(64)), observation(publicationSHA256, fixedNow - 11 * 60_000, fixedNow - 60_000),
    { current: () => ({ schemaVersion: 1, source: 'https://example.com/x', publicationSHA256,
      observedAt: new Date(fixedNow - 1000).toISOString(), expiresAt: new Date(fixedNow + 60_000).toISOString() }) }
  ]) {
    const transfer = new TimetableSourceArchiveTransfer({ observation: current, now: () => fixedNow,
      verifyOIDC: async () => true, fetchImpl: async () => { calls += 1; throw new Error('unexpected upstream'); }
    });
    const origin = await withServer(t, transfer);
    const response = await fetch(origin + archiveURL(publicationSHA256), { headers: auth });
    assert.equal(response.status, 409);
  }
  assert.equal(calls, 0);
});

test('upstream status, identity, freshness, MIME, length, cap and digest failures never return bytes', async t => {
  const bytes = Buffer.from('untrusted bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const now = fixedNow;
  const badResponses = [
    responseFor(bytes, { status: 403, sha }), responseFor(bytes, { sha: 'b'.repeat(64) }),
    responseFor(bytes, { sha, contentType: 'text/html' }),
    responseFor(bytes, { sha, date: new Date(now - 11 * 60_000).toUTCString() }),
    responseFor(bytes, { sha, age: '600' }), responseFor(bytes, { sha, age: 'not-a-number' }),
    responseFor(bytes, { sha, contentLength: '999' }), responseFor(bytes, { sha, contentLength: '4' }),
    responseFor(Buffer.from('too-large'), { sha: crypto.createHash('sha256').update('too-large').digest('hex'),
      contentLength: null, lastModified: null }),
    new Response(bytes, { status: 200, headers: { 'x-amz-meta-sha256': sha,
      'content-type': 'application/zip', 'content-encoding': 'gzip', date: new Date(now).toUTCString(), age: '0' } })
  ];
  for (const upstream of badResponses) {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-source-transfer-reject-'));
    const transfer = new TimetableSourceArchiveTransfer({ observation: observation(sha), now: () => now,
      tempDirectory, maxBytes: 8, verifyOIDC: async () => true, fetchImpl: async () => upstream
    });
    const origin = await withServer(t, transfer);
    const response = await fetch(origin + archiveURL(sha), { headers: auth });
    assert.equal(response.status, 503);
    assert.equal((await response.arrayBuffer()).byteLength > 0, true);
    await waitForEmpty(tempDirectory);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('only GET is allowed and verified transfer is globally single-flight', async t => {
  const bytes = Buffer.from('one transfer');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  let release;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-source-transfer-flight-'));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  const transfer = new TimetableSourceArchiveTransfer({ observation: observation(sha), now: () => fixedNow,
    tempDirectory, verifyOIDC: async () => true,
    fetchImpl: async () => { started(); await new Promise(resolve => { release = resolve; }); return responseFor(bytes, { sha }); }
  });
  const origin = await withServer(t, transfer);
  assert.equal((await fetch(origin + archiveURL(sha), { method: 'POST', headers: auth })).status, 405);
  const first = fetch(origin + archiveURL(sha), { headers: auth });
  await began;
  const second = await fetch(origin + archiveURL(sha), { headers: auth });
  assert.equal(second.status, 429);
  release();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.deepEqual(Buffer.from(await completed.arrayBuffer()), bytes);
  assert.equal(SOURCE_ARCHIVE_TRANSFER_COOLDOWN_MS, 600_000);
  await waitForEmpty(tempDirectory);
});

test('absolute upstream timeout aborts the source request and clears transfer ownership', async t => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-source-transfer-timeout-'));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  let aborted = false;
  const transfer = new TimetableSourceArchiveTransfer({ observation: observation(), now: () => fixedNow,
    tempDirectory, timeoutMs: 20, verifyOIDC: async () => true,
    fetchImpl: async (_url, { signal }) => await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    })
  });
  const origin = await withServer(t, transfer);
  const response = await fetch(origin + archiveURL(publicationSHA256), { headers: auth });
  assert.equal(response.status, 503);
  assert.equal(aborted, true);
  await waitForEmpty(tempDirectory);
  assert.equal(transfer.active, false);
});

test('downstream backpressure is covered by the same deadline and releases the temporary archive', async t => {
  const bytes = Buffer.alloc(256 * 1024, 7);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-source-transfer-downstream-'));
  t.after(() => fs.rm(tempDirectory, { recursive: true, force: true }));
  const transfer = new TimetableSourceArchiveTransfer({ observation: observation(sha), now: () => fixedNow,
    tempDirectory, timeoutMs: 20, verifyOIDC: async () => true,
    fetchImpl: async () => responseFor(bytes, { sha })
  });
  const response = new Writable({ write() {} });
  response.writeHead = (status, headers) => {
    response.statusCode = status; response.headers = headers; response.headersSent = true;
    return response;
  };
  await transfer.transfer(sha, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.destroyed, true);
  assert.equal(transfer.active, false);
  await waitForEmpty(tempDirectory);
});
