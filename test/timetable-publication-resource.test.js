// Draft tests: not executed by the source-validation specialist.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  canonicalResource, handlePublicationResource, validatePublicationResource,
  MAX_PROOF_BYTES, MAX_RESOURCE_BYTES, readPublicationAsset, PUBLICATION_ASSET_DIRECTORY
} from '../server/timetable-publication-resource.js';

const sha = 'a'.repeat(64);
const other = 'b'.repeat(64);
const hash = (data) => createHash('sha256').update(data).digest('hex');
function proof(extra = '') {
  return Buffer.from(JSON.stringify({ schemaVersion:1, timezone:'Europe/London',
    publication:{ sha256:sha, url:'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip' },
    entries:[], qualificationScope:extra }) + '\n');
}
function wrapper(data = proof(), revision = 1) {
  return { schemaVersion:1, publicationSHA256:sha, proofRevision:revision,
    proofBodySHA256:hash(data), proofBodyBase64:data.toString('base64') };
}
async function scope(t, files = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tbproof-test-'));
  for (const [name, data] of files) await fs.writeFile(path.join(directory, name), data);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!await handlePublicationResource(request, response, url, { directory })) {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive:true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { directory, url:origin + '/api/timetable-publications/v1/' + sha };
}

test('exact reviewed bytes have content hash/revision ETag without decoding/reencoding proof', () => {
  const data = Buffer.from(proof().toString().replace('"entries":[]', '"entries" : [ ]'));
  const value = wrapper(data);
  const result = validatePublicationResource(canonicalResource(value), sha);
  assert.equal(result.etag, `"tbproof-v1-${sha}-r1-${hash(data)}"`);
  assert.deepEqual(Buffer.from(value.proofBodyBase64, 'base64'), data);
});

test('unknown/null/unsafe wrapper fields, invalid encoding, body/embedded SHA, bounds and duplicate keys reject', () => {
  for (const change of [
    { schemaVersion:2 }, { proofRevision:0 }, { proofRevision:-1 }, { proofRevision:1.5 },
    { proofRevision:9007199254740992 }, { proofRevision:null }, { publicationSHA256:other },
    { proofBodySHA256:other }, { proofBodyBase64:'%%%' }, { proofBodyBase64:'' },
    { proofBodySHA256:hash(proof()) + '\n' }
  ]) assert.throws(() => validatePublicationResource(canonicalResource({ ...wrapper(), ...change }), sha));
  const unknown = Buffer.from(JSON.stringify({ ...wrapper(), futureField:true }) + '\n');
  assert.throws(() => validatePublicationResource(unknown, sha));
  const duplicate = Buffer.from(canonicalResource(wrapper()).toString().replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'));
  assert.throws(() => validatePublicationResource(duplicate, sha));
  const wrongEmbedded = Buffer.from(proof().toString().replace(sha, other));
  assert.throws(() => validatePublicationResource(canonicalResource(wrapper(wrongEmbedded)), sha));
  assert.throws(() => validatePublicationResource(canonicalResource(wrapper(Buffer.alloc(MAX_PROOF_BYTES + 1))), sha));
  assert.throws(() => validatePublicationResource(Buffer.alloc(MAX_RESOURCE_BYTES + 1), sha));
  assert.throws(() => validatePublicationResource(canonicalResource(wrapper()), sha + '\n'));
});

test('GET/HEAD serve only exact public reviewed asset;304 uses revision+body identity', async (t) => {
  const bytes = canonicalResource(wrapper());
  const { url } = await scope(t, [[sha + '.json', bytes]]);
  const get = await fetch(url);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(get.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
  assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  const head = await fetch(url, { method:'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(await head.text(), '');
  const unchanged = await fetch(url, { headers:{ 'if-none-match':get.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  assert.equal(unchanged.headers.get('etag'), get.headers.get('etag'));
});

test('same ZIP revised proof returns200/new ETag instead of304 or modified-since fallback', async (t) => {
  const { url, directory } = await scope(t, [[sha + '.json', canonicalResource(wrapper())]]);
  const original = await fetch(url);
  await original.arrayBuffer();
  const next = canonicalResource(wrapper(proof('reviewed correction'), 2));
  const temporary = path.join(directory, 'reviewed-next.json');
  await fs.writeFile(temporary, next);
  await fs.rename(temporary, path.join(directory, sha + '.json'));
  const corrected = await fetch(url, { headers:{ 'if-none-match':original.headers.get('etag'), 'if-modified-since':'Wed, 31 Dec 2099 23:59:59 GMT' } });
  assert.equal(corrected.status, 200);
  assert.notEqual(corrected.headers.get('etag'), original.headers.get('etag'));
  assert.deepEqual(Buffer.from(await corrected.arrayBuffer()), next);
});

test('unknown/malformed scope/query uses JSON404/no-store and method405 cannot reach static/private files', async (t) => {
  const { url } = await scope(t);
  for (const target of [url, url.replace(sha, other), url.replace(sha, sha.toUpperCase()), url + '?revision=1', url + '/extra', url.replace(sha, '%2e%2e%2fdata')]) {
    const result = await fetch(target);
    assert.equal(result.status, 404);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.match(result.headers.get('content-type'), /application\/json/);
  }
  const post = await fetch(url, { method:'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('malformed/oversized/symlink asset fails503 without body/path leakage', async (t) => {
  const { url, directory } = await scope(t, [[sha + '.json', Buffer.from('not-json')]]);
  const result = await fetch(url);
  assert.equal(result.status, 503); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await result.json()).error, 'Publication proof unavailable');
  await fs.writeFile(path.join(directory, sha + '.json'), Buffer.alloc(MAX_RESOURCE_BYTES + 1));
  assert.equal((await fetch(url)).status, 503);
  await fs.unlink(path.join(directory, sha + '.json'));
  await fs.writeFile(path.join(directory, 'private-review.json'), canonicalResource(wrapper()));
  await fs.symlink(path.join(directory, 'private-review.json'), path.join(directory, sha + '.json'));
  assert.equal((await fetch(url)).status, 503);
});

// Synthetic transport fixture only: not a reviewed/current publisher proof or
// a maintainer-selected production revision. Own exactly one exclusive file.
test('default authority reader and configured HTTP resource share module-relative bytes outside project cwd', async (t) => {
  const expectedDirectory = fileURLToPath(new URL('../server/timetable-publications/v1/', import.meta.url));
  assert.equal(PUBLICATION_ASSET_DIRECTORY, expectedDirectory);
  const originalCwd = process.cwd();
  const changedCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'tbproof-cwd-'));
  const ownedSHA = hash(Buffer.from('tb085-default-directory-' + randomUUID()));
  const absentSHA = hash(Buffer.from('tb085-absent-default-directory-' + randomUUID()));
  const assetPath = path.join(PUBLICATION_ASSET_DIRECTORY, ownedSHA + '.json');
  let ownsAsset = false;
  const createdDirectories = []; // Bottom-up list of this test mkdir-created paths only.
  let server;
  t.after(async () => {
    process.chdir(originalCwd);
    const failures = [];
    async function cleanup(action) { try { await action(); } catch (error) { failures.push(error); } }
    if (server?.listening) await cleanup(() => new Promise((resolve, reject) => {
      server.closeIdleConnections?.();
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        reject(new Error('Owned loopback server close exceeded 10 seconds'));
      }, 10_000);
      server.close((error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
    }));
    if (ownsAsset) await cleanup(() => fs.unlink(assetPath)); // Never remove/replace an existing asset.
    for (const directory of createdDirectories) {
      // Non-empty means unrelated data appeared: preserve it and fail teardown.
      // Never recursively delete any server directory, including an existing one.
      await cleanup(() => fs.rmdir(directory));
    }
    await cleanup(() => fs.rm(changedCwd, { recursive:true })); // Exclusively owned mkdtemp only.
    assert.equal(failures.length, 0, failures.map((error) => error.message).join('; '));
  });
  const firstCreated = await fs.mkdir(PUBLICATION_ASSET_DIRECTORY, { recursive:true });
  if (firstCreated !== undefined) {
    const first = path.resolve(firstCreated);
    let directory = path.resolve(PUBLICATION_ASSET_DIRECTORY);
    const relative = path.relative(first, directory);
    assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)));
    while (true) {
      createdDirectories.push(directory);
      if (directory === first) break;
      directory = path.dirname(directory);
    }
  }
  const data = Buffer.from(proof().toString().replaceAll(sha, ownedSHA));
  const bytes = canonicalResource({ ...wrapper(data), publicationSHA256:ownedSHA });
  const file = await fs.open(assetPath, 'wx');
  ownsAsset = true;
  try { await file.writeFile(bytes); } finally { await file.close(); }
  process.chdir(changedCwd);
  const local = await readPublicationAsset(ownedSHA); // Actual default, not injected temp directory.
  assert.equal(local.identity.publicationSHA256, ownedSHA);
  assert.equal(local.identity.proofBodySHA256, hash(data));
  assert.deepEqual(local.proofBytes, data);
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    // Exactly the directory exported to the ordinary server/index.js route.
    if (!await handlePublicationResource(request, response, url, { directory:PUBLICATION_ASSET_DIRECTORY })) {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/timetable-publications/v1/${ownedSHA}`;
  const get = await fetch(url, { redirect:'error', signal:AbortSignal.timeout(10_000) });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('etag'), local.etag);
  assert.equal(get.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
  const head = await fetch(url, { method:'HEAD', redirect:'error', signal:AbortSignal.timeout(10_000) });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), local.etag);
  assert.equal(await head.text(), '');
  const notModified = await fetch(url, { headers:{ 'if-none-match':local.etag }, redirect:'error', signal:AbortSignal.timeout(10_000) });
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), '');
  await assert.rejects(readPublicationAsset(absentSHA), (error) => error.code === 'ENOENT');
  const absent = await fetch(url.replace(ownedSHA, absentSHA), { redirect:'error', signal:AbortSignal.timeout(10_000) });
  assert.equal(absent.status, 404);
  assert.equal(absent.headers.get('cache-control'), 'no-store');
});
