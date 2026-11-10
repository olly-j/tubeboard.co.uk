import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  handleSourceBodyResource, loadSourceBodyArchiveIndex, SOURCE_ARCHIVE_DIRECTORY, SOURCE_BODY_PREFIX,
  validateSourceManifest
} from '../server/timetable-source-body-resource.js';
import { PUBLICATION_ASSET_DIRECTORY } from '../server/timetable-publication-resource.js';

const publicationSHA256 = '788955e868b7ae85219db15b4e05c2f187bdf3be1767f16b1c369b60dea08ad7';
const proofBodySHA256 = 'c51723fae3c55df89b0fa875c3a8630384c76ce83748a886f9cb2c7e806b4930';
const eppingSHA256 = '8f2b4892ad9eede0e097a2dbb5eefea961fc41777e154cd420f718750388c86a';
const inboundSHA256 = 'a32504f8e875465a798d449c7442b71a6a5f7e374192b3ebec0298df23ba9b7f';
const outboundSHA256 = 'fc65b4850ebf1c5a0e90a52a1f4bcba6230242a95f7201403ed38264c1337b68';
const archivePath = path.join(SOURCE_ARCHIVE_DIRECTORY, publicationSHA256, proofBodySHA256);
const route = (line, station, direction, body) => `${SOURCE_BODY_PREFIX}${publicationSHA256}/${proofBodySHA256}/${line}/${station}/${direction}/${body}`;

async function scope(t, { publicationDirectory = PUBLICATION_ASSET_DIRECTORY,
  archiveDirectory = SOURCE_ARCHIVE_DIRECTORY, index = null } = {}) {
  const sourceIndex = index ?? await loadSourceBodyArchiveIndex({ publicationDirectory, archiveDirectory });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!await handleSourceBodyResource(request, response, url, { index: sourceIndex })) {
      response.writeHead(404); response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('verified publication archive returns exact body bytes as comparison-only, with source clocks retained', async t => {
  const origin = await scope(t);
  const url = origin + route('central', '940GZZLUEPG', 'default', eppingSHA256);
  const sourceFile = path.join(archivePath, 'bodies', `${eppingSHA256}.json`);
  const expected = await fs.readFile(sourceFile);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-tubeboard-source-use'), 'archived-comparison-only');
  assert.equal(response.headers.get('x-tubeboard-publication-sha256'), publicationSHA256);
  assert.equal(response.headers.get('x-tubeboard-proof-body-sha256'), proofBodySHA256);
  assert.equal(response.headers.get('x-tubeboard-api-body-sha256'), eppingSHA256);
  assert.equal(response.headers.get('x-tubeboard-source-direction'), 'default');
  assert.equal(response.headers.get('x-tubeboard-source-response-direction'), 'inbound');
  assert.equal(response.headers.get('x-tubeboard-source-http-date'), 'Mon, 09 Nov 2026 17:58:35 GMT');
  assert.equal(response.headers.get('x-tubeboard-source-http-age'), '0');
  assert.equal(response.headers.get('age'), null);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, expected);
  assert.equal(response.headers.get('etag'), `"tbsource-v1-${publicationSHA256}-${proofBodySHA256}-${eppingSHA256}"`);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(expected.length));
  assert.equal(await head.text(), '');
  const unchanged = await fetch(url, { headers: { 'if-none-match': response.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get('cache-control'), 'no-store');
  assert.equal(await unchanged.text(), '');
});

test('directional sources are separately authorized and identify their own raw responses', async t => {
  const origin = await scope(t);
  for (const [direction, sha] of [['inbound', inboundSHA256], ['outbound', outboundSHA256]]) {
    const response = await fetch(origin + route('northern', '940GZZLUGDG', direction, sha));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-tubeboard-source-direction'), direction);
    assert.equal(response.headers.get('x-tubeboard-api-body-sha256'), sha);
    assert.equal(response.headers.get('etag'), `"tbsource-v1-${publicationSHA256}-${proofBodySHA256}-${sha}"`);
  }
});

test('unknown, stale, unqualified, wrong-direction, wrong-digest and query paths fail closed', async t => {
  const origin = await scope(t);
  const targets = [
    route('central', '940GZZLUWOF', 'default', eppingSHA256), // no qualified proof scope
    route('circle', '940GZZLUERC', 'default', 'eec4aeab2ae2e73b85bb64117244d2d19defff6c3951e762dbf407127c7626c4'), // parity gap
    route('northern', '940GZZLUGDG', 'default', inboundSHA256),
    route('central', '940GZZLUEPG', 'default', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    route('central', '940GZZLUEPG', 'default', eppingSHA256).replace(proofBodySHA256, 'b'.repeat(64)),
    route('central', '940GZZLUEPG', 'default', eppingSHA256) + '?line=northern',
    route('central', '940GZZLUEPG', 'default', eppingSHA256).replace('/default/', '/%2e%2e/')
  ];
  for (const target of targets) {
    const response = await fetch(origin + target);
    assert.equal(response.status, 404, target);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /Worktrees|timetable-source-archives/);
  }
  const post = await fetch(origin + route('central', '940GZZLUEPG', 'default', eppingSHA256), { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('producer manifest is consumed byte-for-byte and ties all qualified proof scopes to body hashes', async () => {
  const bytes = await fs.readFile(path.join(archivePath, 'manifest.json'));
  const manifest = validateSourceManifest(bytes, publicationSHA256, proofBodySHA256);
  assert.equal(manifest.sources.length, 15); // Fourteen scopes, with Goodge Street split by direction.
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'c67adb7466260e041a151661893a58d3e37f8915a76735569c73ed6273c82d11');
  const withExtra = JSON.parse(bytes);
  withExtra.extra = true;
  assert.throws(() => validateSourceManifest(Buffer.from(JSON.stringify(withExtra, null, 2) + '\n'),
    publicationSHA256, proofBodySHA256));
  assert.throws(() => validateSourceManifest(bytes, publicationSHA256, 'd'.repeat(64)));
  const staleCapture = JSON.parse(bytes);
  staleCapture.sources[0].age = '600';
  assert.throws(() => validateSourceManifest(Buffer.from(JSON.stringify(staleCapture, null, 2) + '\n'),
    publicationSHA256, proofBodySHA256));
});

test('a proof-bound manifest with a changed body fails503 without returning its bytes', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tbsource-body-test-'));
  const publicationDirectory = path.join(temp, 'proofs');
  const archiveDirectory = path.join(temp, 'archives');
  const proofFile = path.join(PUBLICATION_ASSET_DIRECTORY, `${publicationSHA256}.json`);
  await fs.mkdir(publicationDirectory);
  await fs.copyFile(proofFile, path.join(publicationDirectory, `${publicationSHA256}.json`));
  const targetArchive = path.join(archiveDirectory, publicationSHA256, proofBodySHA256);
  await fs.mkdir(path.join(targetArchive, 'bodies'), { recursive: true });
  const manifestBytes = await fs.readFile(path.join(archivePath, 'manifest.json'));
  await fs.writeFile(path.join(targetArchive, 'manifest.json'), manifestBytes);
  const manifest = JSON.parse(manifestBytes);
  for (const source of manifest.sources) {
    const body = await fs.readFile(path.join(archivePath, source.bodyPath));
    await fs.writeFile(path.join(targetArchive, source.bodyPath), body);
  }
  const lastBodySHA = manifest.sources.at(-1).bodySHA256;
  const finalBodyPath = path.join(targetArchive, 'bodies', `${lastBodySHA}.json`);
  const corrupted = Buffer.concat([await fs.readFile(finalBodyPath), Buffer.from(' ')]);
  await fs.writeFile(finalBodyPath, corrupted); // A late package failure must not publish its earlier valid scopes.
  t.after(() => fs.rm(temp, { recursive: true }));
  const origin = await scope(t, { publicationDirectory, archiveDirectory });
  const response = await fetch(origin + route('central', '940GZZLUEPG', 'default', eppingSHA256));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: false, error: 'Source archive unavailable' });
});

test('one immutable startup index serves concurrent, HEAD, 304 and unknown requests without file reads', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tbsource-index-test-'));
  const publicationDirectory = path.join(temp, 'proofs');
  const archiveDirectory = path.join(temp, 'archives');
  const archiveCopy = path.join(archiveDirectory, publicationSHA256, proofBodySHA256);
  await fs.mkdir(publicationDirectory, { recursive: true });
  await fs.mkdir(path.join(archiveCopy, 'bodies'), { recursive: true });
  await fs.copyFile(path.join(PUBLICATION_ASSET_DIRECTORY, `${publicationSHA256}.json`),
    path.join(publicationDirectory, `${publicationSHA256}.json`));
  await fs.copyFile(path.join(archivePath, 'manifest.json'), path.join(archiveCopy, 'manifest.json'));
  for (const name of await fs.readdir(path.join(archivePath, 'bodies'))) {
    await fs.copyFile(path.join(archivePath, 'bodies', name), path.join(archiveCopy, 'bodies', name));
  }
  const index = await loadSourceBodyArchiveIndex({ publicationDirectory, archiveDirectory });
  assert.equal(index.size, 15);
  await fs.rm(temp, { recursive: true }); // All later requests must use the validated in-memory package.
  const origin = await scope(t, { index });
  const target = route('central', '940GZZLUEPG', 'default', eppingSHA256);
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(origin + target)));
  assert.ok(responses.every(response => response.status === 200));
  const first = responses[0];
  const etag = first.headers.get('etag');
  const body = Buffer.from(await first.arrayBuffer());
  assert.equal(createHash('sha256').update(body).digest('hex'), eppingSHA256);
  for (const response of responses.slice(1)) {
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  }
  const head = await fetch(origin + target, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const unchanged = await fetch(origin + target, { headers: { 'if-none-match': etag } });
  assert.equal(unchanged.status, 304);
  const unknown = await fetch(origin + route('central', '940GZZLUEPG', 'default', 'a'.repeat(64)));
  assert.equal(unknown.status, 404);
});

test('the actual service route serves the reviewed body without enabling a TfL proxy', { timeout: 15000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tbsource-http-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, PORT: '0', LIVE_ACTIVITY_WORKER_ENABLED: 'false',
      DISRUPTION_ALERT_WORKER_ENABLED: 'false', TUBEBOARD_STATUS_MONITOR_ENABLED: 'false',
      LIVE_ACTIVITY_DATA_FILE: path.join(directory, 'activities.json'),
      DISRUPTION_ALERT_DATA_FILE: path.join(directory, 'alerts.json') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(timer); }
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Local service listen timeout')), 5000);
    let output = '';
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(Error('Local service ended before listen')); });
    child.stdout.on('data', bytes => {
      output = (output + bytes.toString()).slice(-4096);
      const match = /http:\/\/localhost:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const response = await fetch(origin + route('central', '940GZZLUEPG', 'default', eppingSHA256),
    { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-tubeboard-source-use'), 'archived-comparison-only');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 231686);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), eppingSHA256);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await fetch(origin + '/server/timetable-source-body-resource.js')).status, 404);
});
