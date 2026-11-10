import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { canonicalResource, handlePublicationResource, PUBLICATION_ASSET_DIRECTORY } from '../server/timetable-publication-resource.js';
import { handleSourceBodyResource, loadSourceBodyArchiveIndex, SOURCE_ARCHIVE_DIRECTORY, SOURCE_BODY_PREFIX } from '../server/timetable-source-body-resource.js';
import { TimetablePublicationAdmissionStore, PUBLICATION_CANDIDATE_PREFIX } from '../server/timetable-publication-admission-store.js';

const priorSHA = '0169fa960dee3ad1ca47ae70c639143375287a99ce18018a05703927593bc017';
const candidateSHA = '788955e868b7ae85219db15b4e05c2f187bdf3be1767f16b1c369b60dea08ad7';
const proofBodySHA = 'c51723fae3c55df89b0fa875c3a8630384c76ce83748a886f9cb2c7e806b4930';
const archivePath = path.join(SOURCE_ARCHIVE_DIRECTORY, candidateSHA, '0c5fba0afe99c032a4477fc9126158f26aeafc3ad9fdd173c3d6c489f2fb191c');
const candidatePath = path.join(archivePath, 'previous-resource.json');
const observedAt = Date.parse('2026-11-10T19:55:00Z');
const now = Date.parse('2026-11-10T20:00:00Z');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function setup(t, { maxAdmittedPackages = 2 } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-publication-admission-http-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const publicationDirectory = path.join(temp, 'prior-proof-only');
  const sourceArchiveDirectory = path.join(temp, 'prior-archives-empty');
  const storeDirectory = path.join(temp, 'store');
  await fs.mkdir(publicationDirectory, { recursive: true });
  await fs.mkdir(sourceArchiveDirectory, { recursive: true });
  await fs.copyFile(path.join(PUBLICATION_ASSET_DIRECTORY, `${priorSHA}.json`),
    path.join(publicationDirectory, `${priorSHA}.json`));
  const baseSourceIndex = await loadSourceBodyArchiveIndex({ publicationDirectory, archiveDirectory: sourceArchiveDirectory });
  let observedSHA = candidateSHA;
  let observationSequence = null;
  const observation = { current: () => ({ schemaVersion: 1, source: 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip',
    ...(observationSequence?.length ? observationSequence.shift() : {
      publicationSHA256: observedSHA, observedAt: new Date(observedAt).toISOString(),
      expiresAt: new Date(observedAt + 10 * 60_000).toISOString()
    }) }) };
  const openStore = async () => new TimetablePublicationAdmissionStore({ directory: storeDirectory,
    baselineSHA256: priorSHA, observation, baseSourceIndex, publicationDirectory,
    archiveDirectory: sourceArchiveDirectory, verifyOIDC: async token => token === 'offline-test-token',
    now: () => now, maxAdmittedPackages }).initialize();
  let store = await openStore();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (await store.handle(request, response, url)) return;
      if (await handlePublicationResource(request, response, url, {
        directory: publicationDirectory,
        readBytes: sha => store.readPublicPublicationBytes(sha)
      })) return;
      if (await handleSourceBodyResource(request, response, url, { index: store.sourceBodyIndex })) return;
      response.writeHead(404); response.end();
    } catch {
      if (!response.headersSent) { response.writeHead(500); response.end(); }
      else response.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokenHeaders = { authorization: 'Bearer offline-test-token' };
  const put = async (url, bytes) => fetch(url, { method: 'PUT', headers: { ...tokenHeaders,
    'content-type': 'application/json' }, body: bytes });
  const candidateFor = async sha => {
    const currentResource = await fs.readFile(candidatePath);
    const parsed = JSON.parse(currentResource);
    const proofBytes = Buffer.from(parsed.proofBodyBase64, 'base64');
    const proof = JSON.parse(proofBytes);
    proof.publication.sha256 = sha;
    proof.publication.capturedAt = new Date(observedAt).toISOString();
    const newProofBytes = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
    const newProofBodySHA = digest(newProofBytes);
    const resource = canonicalResource({ schemaVersion: 1, publicationSHA256: sha, proofRevision: 1,
      proofBodySHA256: newProofBodySHA, proofBodyBase64: newProofBytes.toString('base64') });
    const sourceManifest = JSON.parse(await fs.readFile(path.join(archivePath, 'previous-manifest.json'), 'utf8'));
    sourceManifest.publicationSHA256 = sha;
    sourceManifest.proofBodySHA256 = newProofBodySHA;
    const manifestBytes = Buffer.from(JSON.stringify(sourceManifest, null, 2) + '\n');
    return { sha, proofBodySHA: newProofBodySHA, resource, manifestBytes, manifest: sourceManifest };
  };
  const stage = async (candidate, { omitLastBody = false } = {}) => {
    observedSHA = candidate.sha;
    const candidateBase = `${origin}${PUBLICATION_CANDIDATE_PREFIX}${candidate.sha}`;
    const proof = await put(`${candidateBase}/proof`, candidate.resource);
    assert.equal(proof.status, 204);
    const manifestResponse = await put(`${candidateBase}/archives/${candidate.proofBodySHA}/manifest`, candidate.manifestBytes);
    assert.equal(manifestResponse.status, 204);
    const bodies = [...new Set(candidate.manifest.sources.map(source => source.bodySHA256))];
    for (const [index, bodySHA] of bodies.entries()) {
      if (omitLastBody && index === bodies.length - 1) continue;
      const bytes = await fs.readFile(path.join(archivePath, 'bodies', `${bodySHA}.json`));
      const result = await put(`${candidateBase}/archives/${candidate.proofBodySHA}/bodies/${bodySHA}`, bytes);
      assert.equal(result.status, 204, bodySHA);
    }
  };
  const restart = async () => { store = await openStore(); };
  return { origin, storeDirectory, stage, restart, candidateFor,
    publicationDirectory,
    setObservationSequence: value => { observationSequence = value; },
    tokenHeaders, store: () => store };
}

test('staging stays private; complete admission exposes the same proof and bodies on public routes', async t => {
  const fixture = await setup(t);
  const candidate = await fixture.candidateFor(candidateSHA);
  const candidateBase = `${fixture.origin}${PUBLICATION_CANDIDATE_PREFIX}${candidate.sha}`;
  await fixture.stage(candidate);
  const privateBefore = await fetch(candidateBase, { headers: fixture.tokenHeaders });
  assert.equal(privateBefore.status, 404);
  const proofBefore = await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidateSHA}`);
  assert.equal(proofBefore.status, 404); // Temp proof directory contains only the prior edition.
  const sourceBefore = await fetch(`${fixture.origin}${SOURCE_BODY_PREFIX}${candidateSHA}/${proofBodySHA}/central/940GZZLUEPG/default/8f2b4892ad9eede0e097a2dbb5eefea961fc41777e154cd420f718750388c86a`);
  assert.equal(sourceBefore.status, 404);

  const priorBytes = await fs.readFile(path.join(PUBLICATION_ASSET_DIRECTORY, `${priorSHA}.json`));
  const admission = await fetch(`${candidateBase}/admit`, { method: 'POST', headers: {
    ...fixture.tokenHeaders, 'if-match': `"${digest(priorBytes)}"`, 'x-tubeboard-resource-sha256': digest(candidate.resource)
  } });
  if (admission.status !== 201) throw new Error(`Admission failed HTTP ${admission.status}: ${await admission.text()}`);
  const receiptBytes = Buffer.from(await admission.arrayBuffer());
  const receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.status, 'admitted');
  assert.equal(receipt.previousPublicationSHA256, priorSHA);
  assert.equal(receipt.publicationSHA256, candidateSHA);
  assert.equal(receipt.resourceSHA256, digest(candidate.resource));
  assert.equal(receipt.sourceManifestSHA256, digest(candidate.manifestBytes));
  assert.equal(receipt.sourceCount, 15);
  assert.equal(receipt.totalBodyBytes, 3_554_771);
  assert.equal(receipt.admissionRevision, 1);

  const proofAfter = await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidateSHA}`);
  assert.equal(proofAfter.status, 200);
  const proofBytes = Buffer.from(await proofAfter.arrayBuffer());
  assert.deepEqual(proofBytes, candidate.resource);
  const proofHead = await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidateSHA}`, { method: 'HEAD' });
  assert.equal(proofHead.status, 200);
  assert.equal(proofHead.headers.get('content-length'), String(candidate.resource.length));
  assert.equal(await proofHead.text(), '');
  const bodyAfter = await fetch(`${fixture.origin}${SOURCE_BODY_PREFIX}${candidateSHA}/${candidate.proofBodySHA}/central/940GZZLUEPG/default/8f2b4892ad9eede0e097a2dbb5eefea961fc41777e154cd420f718750388c86a`);
  assert.equal(bodyAfter.status, 200);
  const bodyBytes = Buffer.from(await bodyAfter.arrayBuffer());
  assert.equal(digest(bodyBytes), '8f2b4892ad9eede0e097a2dbb5eefea961fc41777e154cd420f718750388c86a');
  const bodyHead = await fetch(`${fixture.origin}${SOURCE_BODY_PREFIX}${candidateSHA}/${candidate.proofBodySHA}/central/940GZZLUEPG/default/8f2b4892ad9eede0e097a2dbb5eefea961fc41777e154cd420f718750388c86a`, { method: 'HEAD' });
  assert.equal(bodyHead.status, 200);
  assert.equal(bodyHead.headers.get('content-length'), String(bodyBytes.length));
  assert.equal(await bodyHead.text(), '');

  const privateReceipt = await fetch(candidateBase, { headers: fixture.tokenHeaders });
  assert.equal(privateReceipt.status, 200);
  assert.equal(JSON.stringify(await privateReceipt.json()), JSON.stringify(receipt));
  const privateProof = await fetch(`${candidateBase}/proof`, { headers: fixture.tokenHeaders });
  assert.equal(privateProof.status, 200);
  assert.deepEqual(Buffer.from(await privateProof.arrayBuffer()), candidate.resource);
  const privateManifest = await fetch(`${candidateBase}/archives/${candidate.proofBodySHA}/manifest`, { headers: fixture.tokenHeaders });
  assert.equal(privateManifest.status, 200);
  assert.deepEqual(Buffer.from(await privateManifest.arrayBuffer()), candidate.manifestBytes);
});

test('admission is atomic, concurrency-safe and exactly idempotent across restart', async t => {
  const fixture = await setup(t);
  const candidate = await fixture.candidateFor(candidateSHA);
  const candidateBase = `${fixture.origin}${PUBLICATION_CANDIDATE_PREFIX}${candidate.sha}`;
  await fixture.stage(candidate);
  const priorBytes = await fs.readFile(path.join(PUBLICATION_ASSET_DIRECTORY, `${priorSHA}.json`));
  const options = { method: 'POST', headers: { ...fixture.tokenHeaders, 'if-match': `"${digest(priorBytes)}"`,
    'x-tubeboard-resource-sha256': digest(candidate.resource) } };
  const [first, concurrent] = await Promise.all([
    fetch(`${candidateBase}/admit`, options), fetch(`${candidateBase}/admit`, options)
  ]);
  assert.equal(first.status, 201);
  assert.equal(concurrent.status, 200);
  const original = Buffer.from(await first.arrayBuffer());
  assert.deepEqual(Buffer.from(await concurrent.arrayBuffer()), original);
  await fixture.restart();
  const retry = await fetch(`${candidateBase}/admit`, options);
  assert.equal(retry.status, 200);
  assert.deepEqual(Buffer.from(await retry.arrayBuffer()), original);
  const readback = await fetch(candidateBase, { headers: fixture.tokenHeaders });
  assert.deepEqual(Buffer.from(await readback.arrayBuffer()), original);
});

test('admission rejects wrong preconditions and incomplete candidate archives without public exposure', async t => {
  const fixture = await setup(t);
  const candidate = await fixture.candidateFor(candidateSHA);
  const candidateBase = `${fixture.origin}${PUBLICATION_CANDIDATE_PREFIX}${candidate.sha}`;
  await fixture.stage(candidate, { omitLastBody: true });
  const priorBytes = await fs.readFile(path.join(PUBLICATION_ASSET_DIRECTORY, `${priorSHA}.json`));
  const bad = await fetch(`${candidateBase}/admit`, { method: 'POST', headers: {
    ...fixture.tokenHeaders, 'if-match': `"${'f'.repeat(64)}"`, 'x-tubeboard-resource-sha256': digest(candidate.resource)
  } });
  assert.equal(bad.status, 412);
  const incomplete = await fetch(`${candidateBase}/admit`, { method: 'POST', headers: {
    ...fixture.tokenHeaders, 'if-match': `"${digest(priorBytes)}"`, 'x-tubeboard-resource-sha256': digest(candidate.resource)
  } });
  assert.equal(incomplete.status, 422);
  assert.deepEqual(await incomplete.json(), { ok: false, error: 'comparison-archive-incomplete' });
  const proof = await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidateSHA}`);
  assert.equal(proof.status, 404);
  assert.equal(digest(priorBytes).length, 64);
});

test('official edition drift during preparation leaves old public assets intact and candidate retryable', async t => {
  const fixture = await setup(t);
  const candidate = await fixture.candidateFor(candidateSHA);
  await fixture.stage(candidate);
  const candidateBase = `${fixture.origin}${PUBLICATION_CANDIDATE_PREFIX}${candidate.sha}`;
  const priorBytes = await fs.readFile(path.join(PUBLICATION_ASSET_DIRECTORY, `${priorSHA}.json`));
  const options = { method: 'POST', headers: { ...fixture.tokenHeaders, 'if-match': `"${digest(priorBytes)}"`,
    'x-tubeboard-resource-sha256': digest(candidate.resource) } };
  const changed = { schemaVersion: 1, source: 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip',
    publicationSHA256: '9'.repeat(64), observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(observedAt + 10 * 60_000).toISOString() };
  fixture.setObservationSequence([{
    schemaVersion: 1, source: 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip',
    publicationSHA256: candidate.sha, observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(observedAt + 10 * 60_000).toISOString()
  }, changed]);
  const rejected = await fetch(`${candidateBase}/admit`, options);
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { ok: false, error: 'official-edition-changed-during-admission' });
  const priorPublic = await fetch(`${fixture.origin}/api/timetable-publications/v1/${priorSHA}`);
  assert.equal(priorPublic.status, 200);
  assert.deepEqual(Buffer.from(await priorPublic.arrayBuffer()), priorBytes);
  assert.equal((await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidate.sha}`)).status, 404);
  assert.equal((await fetch(candidateBase, { headers: fixture.tokenHeaders })).status, 404);
  await fs.access(path.join(fixture.storeDirectory, 'staging', candidate.sha, 'proofs', `${candidate.sha}.json`));

  fixture.setObservationSequence(null);
  const retried = await fetch(`${candidateBase}/admit`, options);
  assert.equal(retried.status, 201);
  assert.equal(JSON.parse(await retried.text()).publicationSHA256, candidate.sha);
});

test('admission history rotates payloads safely without exhausting future editions', async t => {
  const fixture = await setup(t, { maxAdmittedPackages: 2 });
  const baselineBytes = await fs.readFile(path.join(PUBLICATION_ASSET_DIRECTORY, `${priorSHA}.json`));
  let previousResourceSHA = digest(baselineBytes);
  const receipts = [];
  const candidates = [];
  for (const digit of ['c', 'd', 'e', 'f']) {
    const candidate = await fixture.candidateFor(digit.repeat(64));
    candidates.push(candidate);
    await fixture.stage(candidate);
    const candidateBase = `${fixture.origin}${PUBLICATION_CANDIDATE_PREFIX}${candidate.sha}`;
    const response = await fetch(`${candidateBase}/admit`, { method: 'POST', headers: {
      ...fixture.tokenHeaders, 'if-match': `"${previousResourceSHA}"`,
      'x-tubeboard-resource-sha256': digest(candidate.resource)
    } });
    if (response.status !== 201) throw new Error(`Admission failed HTTP ${response.status}: ${await response.text()}`);
    const receiptBytes = Buffer.from(await response.arrayBuffer());
    const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.admissionRevision, receipts.length + 1);
    receipts.push({ bytes: receiptBytes, receipt, candidate });
    if (receipts.length === 2) {
      assert.equal(fixture.store().sourceBodyIndex.size, 30);
      assert.equal(fixture.store().sourceBodyIndex.archiveCount, 2);
    }
    previousResourceSHA = digest(candidate.resource);
  }

  const admittedEntries = await fs.readdir(path.join(fixture.storeDirectory, 'admitted'));
  assert.deepEqual(admittedEntries.sort(), [candidates[2].sha, candidates[3].sha].sort());
  await fixture.restart();
  const newest = await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidates[3].sha}`);
  assert.equal(newest.status, 200);
  assert.deepEqual(Buffer.from(await newest.arrayBuffer()), candidates[3].resource);
  const rotated = await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidates[0].sha}`);
  assert.equal(rotated.status, 404);

  const oldBase = `${fixture.origin}${PUBLICATION_CANDIDATE_PREFIX}${candidates[0].sha}`;
  const oldReceiptReadback = await fetch(oldBase, { headers: fixture.tokenHeaders });
  assert.equal(oldReceiptReadback.status, 200);
  assert.deepEqual(Buffer.from(await oldReceiptReadback.arrayBuffer()), receipts[0].bytes);
  const oldProofReadback = await fetch(`${oldBase}/proof`, { headers: fixture.tokenHeaders });
  assert.equal(oldProofReadback.status, 410);
  const oldRetry = await fetch(`${oldBase}/admit`, { method: 'POST', headers: { ...fixture.tokenHeaders,
    'if-match': `"${receipts[0].receipt.previousResourceSHA256}"`,
    'x-tubeboard-resource-sha256': receipts[0].receipt.resourceSHA256
  } });
  assert.equal(oldRetry.status, 200);
  assert.deepEqual(Buffer.from(await oldRetry.arrayBuffer()), receipts[0].bytes);
});

test('configured admission initialization failure is visible while health and existing service stay available',
  { timeout: 15000 }, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-admission-health-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: new URL('..', import.meta.url),
      env: { PATH: process.env.PATH, PORT: '0',
        TUBEBOARD_TIMETABLE_PUBLICATION_ADMISSION_DIRECTORY: path.join(temp, 'admission-store'),
        LIVE_ACTIVITY_WORKER_ENABLED: 'false', DISRUPTION_ALERT_WORKER_ENABLED: 'false',
        WIDGET_PUSH_WORKER_ENABLED: 'false', TUBEBOARD_STATUS_MONITOR_ENABLED: 'false',
        LIVE_ACTIVITY_DATA_FILE: path.join(temp, 'activities.json'),
        DISRUPTION_ALERT_DATA_FILE: path.join(temp, 'alerts.json'), WIDGET_PUSH_DATA_FILE: path.join(temp, 'widgets.json') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.kill('SIGTERM');
        try { await exited; } finally { clearTimeout(timer); }
      }
    });
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Local service listen timeout')), 5000);
      let output = '';
      child.once('error', reject);
      child.once('exit', () => { clearTimeout(timer); reject(Error('Local service ended before listen')); });
      child.stdout.on('data', bytes => {
        output = (output + bytes.toString()).slice(-4096);
        const match = /http:\/\/localhost:(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    const snapshot = await health.json();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.timetablePublicationAdmissionConfigured, true);
    assert.equal(snapshot.timetablePublicationAdmissionReady, false);
    assert.equal((await fetch(`${origin}/api/timetable-publications/v1/${candidateSHA}`)).status, 200);
    assert.doesNotMatch(JSON.stringify(snapshot), /admission-store|\/data|Temporary|\.json/);
  });

test('persisted and packaged baseline divergence blocks writer initialization', async t => {
  const fixture = await setup(t);
  const baselinePath = path.join(fixture.publicationDirectory, `${priorSHA}.json`);
  await fs.appendFile(baselinePath, ' ');
  await assert.rejects(fixture.restart(), /baseline-package-diverged/);
  const baselineResponse = await fetch(`${fixture.origin}/api/timetable-publications/v1/${priorSHA}`);
  assert.equal(baselineResponse.status, 503);
  assert.equal((await fetch(`${fixture.origin}/api/timetable-publications/v1/${candidateSHA}`)).status, 404);
});
