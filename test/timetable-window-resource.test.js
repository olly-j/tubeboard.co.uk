import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWindowPackage, handleWindowResource, WINDOW_PREFIX } from '../server/timetable-window-resource.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { publicationSHA256: 'a'.repeat(64), proofBodySHA256: 'b'.repeat(64), proofRevision: 2 };
const scope = { lineID: 'waterloo-city', stationID: '940GZZLUWLO', requestDirection: 'default' };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-window-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'resources'));
  const fields = { ...identity, schemaVersion: 1, canonicalizerVersion: 'tb085-counted-minute-ordered-path-multiset-v1' };
  const body = Buffer.from(JSON.stringify({ ...fields, ...scope, responseDirection: 'outbound',
    sourceEndpoint: 'https://api.tfl.gov.uk/Line/' + scope.lineID + '/Timetable/' + scope.stationID,
    sourceCapturedAt: '2026-11-09T12:00:00Z', sourceAgeSeconds: 0, sourceBodySHA256: 'c'.repeat(64),
    profiles: [{ name: 'Monday', weekdays: [2], count: 3, sha256: 'd'.repeat(64) }],
    serviceRanges: [{ startDate: '2026-11-09', endDate: '2026-11-09', profileName: 'Monday', disputedMinutes: [399] }] }));
  const sha = digest(body);
  const ref = { ...scope, sha256: sha, bytes: body.length, path: 'resources/' + sha + '.json' };
  await fs.writeFile(path.join(dir, ref.path), body);
  const index = { ...fields, resources: [ref] };
  const write = async value => {
    const encoded = Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(dir, 'index.json'), encoded);
    return digest(encoded);
  };
  return { dir, body, ref, index, write, indexSHA: await write(index) };
}

test('only reviewed index bytes and resources with matching publication and scope are returned', async t => {
  const { dir, ref, body, indexSHA } = await fixture(t);
  const bundle = await loadWindowPackage(dir, identity, indexSHA);
  const key = identity.publicationSHA256 + '/' + identity.proofBodySHA256;
  const packages = new Map([[key, bundle]]);
  const server = http.createServer((req, res) => handleWindowResource(req, res, new URL(req.url, 'http://localhost'), packages));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port + WINDOW_PREFIX;
  const root = origin + key + '/';
  const indexResponse = await fetch(root + 'index.json');
  assert.equal(indexResponse.status, 200);
  assert.equal(indexResponse.headers.get('x-tubeboard-window-sha256'), indexSHA);
  assert.equal(digest(Buffer.from(await indexResponse.arrayBuffer())), indexSHA);
  const resource = await fetch(root + ref.path);
  assert.equal(resource.status, 200);
  assert.equal(resource.headers.get('x-tubeboard-proof-body-sha256'), identity.proofBodySHA256);
  assert.equal(resource.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await resource.arrayBuffer()), body);
  const head = await fetch(root + ref.path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const url of [root + 'index.json?bad=1', root + 'resources/' + '0'.repeat(64) + '.json',
    origin + identity.publicationSHA256 + '/' + 'c'.repeat(64) + '/index.json']) {
    assert.equal((await fetch(url)).status, 404);
  }
  assert.equal((await fetch(root + 'index.json', { method: 'PUT' })).status, 405);
});

test('changed index, digest, revision, paths, duplicate scopes and truncated resources fail closed', async t => {
  const { dir, ref, index, write, indexSHA } = await fixture(t);
  await assert.rejects(loadWindowPackage(dir, identity, '0'.repeat(64)));
  await assert.rejects(loadWindowPackage(dir, { ...identity, proofRevision: 1 }, indexSHA));
  for (const resources of [[ref, ref], [{ ...ref, stationID: '940GZZLUXXX' }],
    [{ ...ref, path: '../index.json' }], [{ ...ref, bytes: ref.bytes + 1 }]]) {
    await assert.rejects(loadWindowPackage(dir, identity, await write({ ...index, resources })));
  }
  await write(index);
  await fs.writeFile(path.join(dir, ref.path), '{}');
  await assert.rejects(loadWindowPackage(dir, identity, indexSHA));
});

test('hashed bytes must still satisfy the source, calendar and disputed-minute schema', async t => {
  const { dir, body, ref, index, write } = await fixture(t);
  for (const mutate of [
    item => { item.sourceBodySHA256 = [item.sourceBodySHA256]; },
    item => { item.sourceCapturedAt = 0; },
    item => { item.sourceEndpoint += '?other-origin=1'; },
    item => { item.profiles[0].sha256 = [item.profiles[0].sha256]; },
    item => { item.serviceRanges[0].startDate = '2026-02-31'; },
    item => { item.serviceRanges[0].disputedMinutes = [100, 99]; },
    item => { item.departures = [{ minutes: 2 }]; }
  ]) {
    const changed = JSON.parse(body);
    mutate(changed);
    const bytes = Buffer.from(JSON.stringify(changed));
    const sha = digest(bytes);
    const resource = { ...ref, sha256: sha, bytes: bytes.length, path: 'resources/' + sha + '.json' };
    await fs.writeFile(path.join(dir, resource.path), bytes);
    const pin = await write({ ...index, resources: [resource] });
    await assert.rejects(loadWindowPackage(dir, identity, pin));
  }
});
