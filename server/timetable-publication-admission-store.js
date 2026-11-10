// Protected, persistent staging and admission of a fully qualified new TfL
// edition. Admitted resources are immutable and become readable through the
// existing proof/source-body routes; this store never changes departure rules.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { TIMETABLE_PUBLICATION_URL } from './station-board-seed.js';
import { readPublicationAsset, canonicalResource, validatePublicationResource,
  MAX_RESOURCE_BYTES, PUBLICATION_ASSET_DIRECTORY } from './timetable-publication-resource.js';
import { validateSourceManifest, loadSourceBodyArchiveIndex, SOURCE_ARCHIVE_DIRECTORY,
  MAX_SOURCE_MANIFEST_BYTES, MAX_SOURCE_BODY_BYTES, MAX_SOURCE_ARCHIVE_BYTES,
  MAX_SOURCE_INDEX_ARCHIVES } from './timetable-source-body-resource.js';
import { evaluateNewEditionAdmission, hasCompleteComparisonArchive,
  publicationResourceSHA256 } from './timetable-publication-admission.js';

export const PUBLICATION_CANDIDATE_PREFIX = '/api/timetable-publication-candidates/v1/';
export const PUBLICATION_CANDIDATE_AUDIENCE = 'tubeboard-timetable-publication-candidate';
export const PUBLICATION_CANDIDATE_WORKFLOW_REF = 'olly-j/My-Train-Times/.github/workflows/timetable-publication.yml@refs/heads/main';
export const MAX_STAGED_PACKAGE_BYTES = MAX_RESOURCE_BYTES + MAX_SOURCE_MANIFEST_BYTES + MAX_SOURCE_ARCHIVE_BYTES + 1024;
export const MAX_STAGED_PACKAGE_COUNT = 1;
export const MAX_ADMITTED_BYTES = 128 * 1024 * 1024;
export const MAX_ADMITTED_PACKAGES = 2; // Keep the current and one verified rollback package.
export const MAX_STAGE_AGE_MS = 24 * 60 * 60_000;
export const MAX_ADMISSION_HISTORY = 10_000;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_AUTH_TOKEN_BYTES = 8192;
const MAX_REQUEST_MS = 30_000;
const SHA = /^[a-f0-9]{64}$/;
const ISSUER = 'https://token.actions.githubusercontent.com';
const REPOSITORY = 'olly-j/My-Train-Times';
const REPOSITORY_ID = '1267669215';
const REF = 'refs/heads/main';
const EVENTS = new Set(['schedule', 'workflow_dispatch']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validSHA = value => typeof value === 'string' && SHA.test(value);
const receiptCoreKeys = ['schemaVersion', 'status', 'admissionRevision', 'publicationSHA256', 'proofRevision',
  'proofBodySHA256', 'resourceSHA256', 'sourceManifestSHA256', 'sourceCount', 'uniqueBodyCount',
  'totalBodyBytes', 'previousPublicationSHA256', 'previousResourceSHA256', 'observedAt'];
const ledgerKeys = ['schemaVersion', 'revision', 'records'];
const baselineKeys = ['schemaVersion', 'publicationSHA256', 'proofBodySHA256', 'resourceSHA256'];
const OIDC_KEYS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));

export async function verifyPublicationCandidateOIDC(token, { now = Date.now, verify = jwtVerify } = {}) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 100 || Buffer.byteLength(token) > MAX_AUTH_TOKEN_BYTES) return false;
  try {
    const { payload } = await verify(token, OIDC_KEYS, { issuer: ISSUER, audience: PUBLICATION_CANDIDATE_AUDIENCE,
      algorithms: ['RS256'], maxTokenAge: '5 minutes', clockTolerance: 10, currentDate: new Date(now()) });
    return payload.iss === ISSUER && payload.aud === PUBLICATION_CANDIDATE_AUDIENCE
      && payload.repository === REPOSITORY && payload.repository_id === REPOSITORY_ID
      && payload.ref === REF && payload.workflow_ref === PUBLICATION_CANDIDATE_WORKFLOW_REF
      && EVENTS.has(payload.event_name) && payload.sub === `repo:${REPOSITORY}:ref:${REF}`;
  } catch { return false; }
}

function fail(status, reason) { return Object.assign(new Error(reason), { status, publicReason: reason }); }

function errorResponse(response, status, reason, allow) {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify({ ok: false, error: reason }) + '\n');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length, 'cache-control': 'no-store',
    ...(allow ? { allow } : {}) });
  response.end(bytes);
}

function sendBytes(response, status, bytes, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { ...(status === 204 ? {} : { 'content-length': String(bytes.length) }), 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers });
  response.end(bytes);
}

function bearer(request) {
  const value = request.headers.authorization;
  const match = typeof value === 'string' && /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
  return match ? match[1] : null;
}

async function readBoundedRequest(request, maximum) {
  const rawLength = request.headers['content-length'];
  if (rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > maximum)) {
    throw fail(413, 'request-too-large');
  }
  const chunks = [];
  let total = 0;
  const timer = setTimeout(() => request.destroy(), MAX_REQUEST_MS);
  timer.unref?.();
  try {
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maximum) throw fail(413, 'request-too-large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error?.status) throw error;
    throw fail(408, 'request-incomplete');
  } finally { clearTimeout(timer); }
  if (rawLength !== undefined && total !== Number(rawLength)) throw fail(400, 'request-length-mismatch');
  return Buffer.concat(chunks, total);
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(503, 'storage-unavailable');
}

async function readBoundedFile(directory, name, maximum) {
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw fail(503, 'stored-object-invalid');
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    if (total !== stat.size) throw fail(503, 'stored-object-invalid');
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}

async function treeBytes(directory) {
  let total = 0;
  const walk = async current => {
    let children;
    try { children = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const child of children) {
      const target = path.join(current, child.name);
      if (child.isSymbolicLink()) throw fail(503, 'stored-object-invalid');
      if (child.isDirectory()) await walk(target);
      else if (child.isFile()) {
        const stat = await fs.stat(target);
        total += stat.size;
      } else throw fail(503, 'stored-object-invalid');
    }
  };
  await walk(directory);
  return total;
}

async function writeImmutable(root, target, bytes) {
  await ensureDirectory(path.dirname(target));
  try {
    const prior = await readBoundedFile(path.dirname(target), path.basename(target), Math.max(bytes.length, 1));
    if (!prior.equals(bytes)) throw fail(409, 'immutable-object-conflict');
    return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = path.join(root, '.tmp', `object-${randomUUID()}`);
  await ensureDirectory(path.dirname(temp));
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.link(temp, target); // Atomic create-if-absent; never replace a staged object.
    await fsyncDirectory(path.dirname(target));
    await fs.rm(temp, { force: true });
    return true;
  } catch (error) {
    try { await fs.rm(temp, { force: true }); } catch {}
    if (error.code !== 'EEXIST') throw error;
    const prior = await readBoundedFile(path.dirname(target), path.basename(target), Math.max(bytes.length, 1));
    if (!prior.equals(bytes)) throw fail(409, 'immutable-object-conflict');
    return false;
  }
}

function receiptHash(core) { return digest(jsonBytes(core)); }
function makeReceipt(core) { return { ...core, receiptSHA256: receiptHash(core) }; }
function validReceipt(value, revision) {
  if (!exactKeys(value, [...receiptCoreKeys, 'receiptSHA256']) || value.schemaVersion !== 1
      || value.status !== 'admitted' || value.admissionRevision !== revision
      || !validSHA(value.publicationSHA256) || value.proofRevision !== 1
      || !validSHA(value.proofBodySHA256) || !validSHA(value.resourceSHA256)
      || !validSHA(value.sourceManifestSHA256) || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 1
      || !Number.isSafeInteger(value.uniqueBodyCount) || value.uniqueBodyCount < 1
      || !Number.isSafeInteger(value.totalBodyBytes) || value.totalBodyBytes < 1
      || !validSHA(value.previousPublicationSHA256) || !validSHA(value.previousResourceSHA256)
      || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) return false;
  const core = Object.fromEntries(receiptCoreKeys.map(key => [key, value[key]]));
  return value.receiptSHA256 === receiptHash(core);
}

function combineIndexes(prior, next) {
  return Object.freeze({
    get: key => next.get(key) ?? prior.get(key),
    isUnavailable: (publicationSHA256, proofBodySHA256) =>
      next.isUnavailable(publicationSHA256, proofBodySHA256) || prior.isUnavailable(publicationSHA256, proofBodySHA256),
    size: prior.size + next.size,
    bytes: prior.bytes + next.bytes,
    archiveCount: prior.archiveCount + next.archiveCount
  });
}

function sameFreshOfficialObservation(expected, current, publicationSHA256, now) {
  if (!expected || !current || current.schemaVersion !== 1
      || current.source !== TIMETABLE_PUBLICATION_URL || current.publicationSHA256 !== publicationSHA256
      || current.observedAt !== expected.observedAt || current.expiresAt !== expected.expiresAt) return false;
  const observedAt = Date.parse(current.observedAt);
  const expiresAt = Date.parse(current.expiresAt);
  return Number.isFinite(observedAt) && Number.isFinite(expiresAt)
    && observedAt <= now && now < expiresAt && expiresAt - observedAt <= 600_000;
}

function ledgerRecord(value) {
  return exactKeys(value, ['receipt', 'retained']) && typeof value.retained === 'boolean'
    && validReceipt(value.receipt, value.receipt?.admissionRevision);
}

export class TimetablePublicationAdmissionStore {
  #tail = Promise.resolve();
  #snapshot = null;

  constructor({ directory, baselineSHA256, observation, baseSourceIndex,
    publicationDirectory = PUBLICATION_ASSET_DIRECTORY, archiveDirectory = SOURCE_ARCHIVE_DIRECTORY,
    verifyOIDC = verifyPublicationCandidateOIDC, now = Date.now,
    maxAdmittedBytes = MAX_ADMITTED_BYTES, maxAdmittedPackages = MAX_ADMITTED_PACKAGES } = {}) {
    if (typeof directory !== 'string' || !directory || !validSHA(baselineSHA256)
        || !observation || !baseSourceIndex || !Number.isSafeInteger(maxAdmittedBytes) || maxAdmittedBytes < 1
        || !Number.isSafeInteger(maxAdmittedPackages) || maxAdmittedPackages < 1) throw new Error('Invalid admission store configuration');
    this.directory = path.resolve(directory);
    this.baselineSHA256 = baselineSHA256;
    this.observation = observation;
    this.baseSourceIndex = baseSourceIndex;
    this.publicationDirectory = publicationDirectory;
    this.archiveDirectory = archiveDirectory;
    this.verifyOIDC = verifyOIDC;
    this.now = now;
    this.maxAdmittedBytes = Math.min(maxAdmittedBytes, MAX_ADMITTED_BYTES);
    this.maxRetainedPackages = Math.min(maxAdmittedPackages, MAX_ADMITTED_PACKAGES);
    this.stagingDirectory = path.join(this.directory, 'staging');
    this.admittedDirectory = path.join(this.directory, 'admitted');
    this.baselineDirectory = path.join(this.directory, 'baseline');
    this.ledgerPath = path.join(this.directory, 'admissions.json');
  }

  async initialize() {
    await ensureDirectory(this.directory);
    await ensureDirectory(this.stagingDirectory);
    await ensureDirectory(this.admittedDirectory);
    await ensureDirectory(path.join(this.directory, '.tmp'));
    const { asset: baselineAsset, resourceSHA256: baseResourceSHA256, index: persistedBaselineIndex } =
      await this.#loadOrPersistBaseline();
    const baselineAlreadyInBaseIndex = hasCompleteComparisonArchive(baselineAsset, this.baseSourceIndex);
    const baseIndex = baselineAlreadyInBaseIndex ? this.baseSourceIndex
      : combineIndexes(this.baseSourceIndex, persistedBaselineIndex);
    const ledger = await this.#readLedger();
    let previousAsset = baselineAsset;
    let previousResourceSHA256 = baseResourceSHA256;
    let admittedBytes = 0;
    let index = baseIndex;
    const retainedIndexes = new Map();
    const retainedStart = Math.max(0, ledger.records.length - this.maxRetainedPackages);
    const seen = new Set();
    for (let i = 0; i < ledger.records.length; i++) {
      const record = ledger.records[i];
      const receipt = record?.receipt;
      const expectedRetained = i >= retainedStart;
      const expectedPreviousSHA = i === 0 ? baselineAsset.identity.publicationSHA256
        : ledger.records[i - 1].receipt.publicationSHA256;
      const expectedPreviousResource = i === 0 ? baseResourceSHA256 : ledger.records[i - 1].receipt.resourceSHA256;
      if (!ledgerRecord(record) || !validReceipt(receipt, i + 1)
          || record.retained !== expectedRetained || seen.has(receipt.publicationSHA256)
          || receipt.previousPublicationSHA256 !== expectedPreviousSHA
          || receipt.previousResourceSHA256 !== expectedPreviousResource) throw fail(503, 'admission-ledger-invalid');
      seen.add(receipt.publicationSHA256);
      if (!record.retained) { previousResourceSHA256 = receipt.resourceSHA256; continue; }
      const packageRoot = this.#admittedPackage(receipt.publicationSHA256);
      const proofDirectory = path.join(packageRoot, 'proofs');
      const archiveDirectory = path.join(packageRoot, 'archives');
      const asset = await readPublicationAsset(receipt.publicationSHA256, proofDirectory);
      const resource = await readBoundedFile(proofDirectory, `${receipt.publicationSHA256}.json`, MAX_RESOURCE_BYTES);
      if (digest(resource) !== receipt.resourceSHA256 || asset.identity.proofBodySHA256 !== receipt.proofBodySHA256) {
        throw fail(503, 'admitted-object-invalid');
      }
      const candidateIndex = await loadSourceBodyArchiveIndex({ publicationDirectory: proofDirectory, archiveDirectory });
      if (!hasCompleteComparisonArchive(asset, candidateIndex)) throw fail(503, 'admitted-archive-invalid');
      if (index.bytes + candidateIndex.bytes > MAX_SOURCE_ARCHIVE_BYTES) throw fail(503, 'source-index-storage-limit');
      if (index.archiveCount + candidateIndex.archiveCount > MAX_SOURCE_INDEX_ARCHIVES) throw fail(503, 'source-index-count-limit');
      index = combineIndexes(index, candidateIndex);
      retainedIndexes.set(receipt.publicationSHA256, candidateIndex);
      admittedBytes += await treeBytes(packageRoot);
      if (admittedBytes > this.maxAdmittedBytes) throw fail(503, 'admitted-storage-limit');
      previousAsset = asset;
      previousResourceSHA256 = receipt.resourceSHA256;
    }
    if (ledger.revision !== ledger.records.length || ledger.revision > MAX_ADMISSION_HISTORY) {
      throw fail(503, 'admission-ledger-invalid');
    }
    this.#snapshot = Object.freeze({ ledger, index, baseIndex, retainedIndexes,
      previousAsset, previousResourceSHA256, admittedBytes });
    await this.#cleanupSuperseded(ledger);
    return this;
  }

  get sourceBodyIndex() { return this.#snapshot?.index ?? this.baseSourceIndex; }

  async readPublicPublicationBytes(sha) {
    if (!validSHA(sha)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
    try { return await readBoundedFile(this.publicationDirectory, `${sha}.json`, MAX_RESOURCE_BYTES); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (sha === this.baselineSHA256) {
      const bytes = await readBoundedFile(path.join(this.baselineDirectory, sha, 'proofs'), `${sha}.json`, MAX_RESOURCE_BYTES);
      const pointer = JSON.parse((await readBoundedFile(this.directory, 'baseline.json', 4096)).toString('utf8'));
      if (digest(bytes) !== pointer.resourceSHA256) throw fail(503, 'baseline-invalid');
      return bytes;
    }
    const record = this.#snapshot?.ledger.records.find(value => value.receipt.publicationSHA256 === sha && value.retained);
    if (record) {
      const bytes = await readBoundedFile(path.join(this.#admittedPackage(sha), 'proofs'), `${sha}.json`, MAX_RESOURCE_BYTES);
      if (digest(bytes) !== record.receipt.resourceSHA256) throw fail(503, 'admitted-object-invalid');
      return bytes;
    }
    throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
  }

  async handle(request, response, url) {
    if (!url.pathname.startsWith(PUBLICATION_CANDIDATE_PREFIX)) return false;
    if (!this.#snapshot) { errorResponse(response, 503, 'admission-store-unavailable'); return true; }
    const token = bearer(request);
    if (!token || !await this.verifyOIDC(token)) { errorResponse(response, 401, 'protected-workflow-identity-required'); return true; }
    if (url.search !== '') { errorResponse(response, 404, 'candidate-not-found'); return true; }
    const parts = url.pathname.slice(PUBLICATION_CANDIDATE_PREFIX.length).split('/');
    const publicationSHA256 = parts[0];
    if (!validSHA(publicationSHA256)) { errorResponse(response, 404, 'candidate-not-found'); return true; }

    const method = request.method;
    const pathKey = parts.slice(1).join('/');
    if (method === 'GET') {
      try { return await this.#readback(response, publicationSHA256, pathKey); }
      catch (error) {
        errorResponse(response, Number.isInteger(error?.status) ? error.status : 503,
          typeof error?.publicReason === 'string' ? error.publicReason : 'admission-readback-unavailable');
        return true;
      }
    }
    if (method !== 'PUT' && method !== 'POST') {
      errorResponse(response, 405, 'method-not-allowed', 'GET, PUT, POST'); return true;
    }
    try {
      return await this.#serialize(async () => {
        if (method === 'POST' && pathKey === 'admit') {
          await this.#admit(request, response, publicationSHA256);
          return true;
        }
        if (method !== 'PUT') { errorResponse(response, 404, 'candidate-not-found'); return true; }
        await this.#stage(request, response, publicationSHA256, parts.slice(1));
        return true;
      });
    } catch (error) {
      errorResponse(response, Number.isInteger(error?.status) ? error.status : 503,
        typeof error?.publicReason === 'string' ? error.publicReason : 'admission-unavailable');
      return true;
    }
  }

  async #serialize(work) {
    const run = this.#tail.then(work, work);
    this.#tail = run.catch(() => {});
    return run;
  }

  #stagedPackage(sha) { return path.join(this.stagingDirectory, sha); }
  #admittedPackage(sha) { return path.join(this.admittedDirectory, sha); }

  async #cleanupSuperseded(ledger) {
    const bySHA = new Map(ledger.records.map(value => [value.receipt.publicationSHA256, value]));
    for (const item of await fs.readdir(this.admittedDirectory, { withFileTypes: true })) {
      if (!validSHA(item.name)) continue;
      const record = bySHA.get(item.name);
      if (!record || record.retained) continue;
      const target = path.join(this.admittedDirectory, item.name);
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(503, 'admitted-storage-invalid');
      await fs.rm(target, { recursive: true, force: true });
    }
    await fsyncDirectory(this.admittedDirectory);
  }

  async #loadOrPersistBaseline() {
    const pointerPath = path.join(this.directory, 'baseline.json');
    let pointer;
    try {
      const bytes = await readBoundedFile(this.directory, 'baseline.json', 4096);
      pointer = JSON.parse(bytes.toString('utf8'));
      if (!exactKeys(pointer, baselineKeys) || pointer.schemaVersion !== 1
          || pointer.publicationSHA256 !== this.baselineSHA256 || !validSHA(pointer.proofBodySHA256)
          || !validSHA(pointer.resourceSHA256) || !jsonBytes(pointer).equals(bytes)) throw fail(503, 'baseline-invalid');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const asset = await readPublicationAsset(this.baselineSHA256, this.publicationDirectory);
      const resource = await readBoundedFile(this.publicationDirectory, `${this.baselineSHA256}.json`, MAX_RESOURCE_BYTES);
      if (asset.identity.proofBodySHA256 !== validatePublicationResource(resource, this.baselineSHA256).proofBodySHA256) {
        throw fail(503, 'baseline-invalid');
      }
      const archiveRoot = path.join(this.archiveDirectory, this.baselineSHA256, asset.identity.proofBodySHA256);
      const packageRoot = path.join(this.baselineDirectory, this.baselineSHA256);
      const proofDirectory = path.join(packageRoot, 'proofs');
      const candidateArchiveRoot = path.join(packageRoot, 'archives', this.baselineSHA256, asset.identity.proofBodySHA256);
      await writeImmutable(this.directory, path.join(proofDirectory, `${this.baselineSHA256}.json`), resource);
      let manifestBytes = null;
      try { manifestBytes = await readBoundedFile(archiveRoot, 'manifest.json', MAX_SOURCE_MANIFEST_BYTES); }
      catch (archiveError) { if (archiveError.code !== 'ENOENT') throw archiveError; }
      if (manifestBytes) {
        const manifest = validateSourceManifest(manifestBytes, this.baselineSHA256, asset.identity.proofBodySHA256);
        await writeImmutable(this.directory, path.join(candidateArchiveRoot, 'manifest.json'), manifestBytes);
        for (const bodySHA256 of [...new Set(manifest.sources.map(value => value.bodySHA256))]) {
          const body = await readBoundedFile(archiveRoot, `bodies/${bodySHA256}.json`, MAX_SOURCE_BODY_BYTES);
          await writeImmutable(this.directory, path.join(candidateArchiveRoot, 'bodies', `${bodySHA256}.json`), body);
        }
      }
      pointer = { schemaVersion: 1, publicationSHA256: this.baselineSHA256,
        proofBodySHA256: asset.identity.proofBodySHA256, resourceSHA256: digest(resource) };
      const pointerTemp = path.join(this.directory, '.tmp', `baseline-${randomUUID()}`);
      const handle = await fs.open(pointerTemp, 'wx', 0o600);
      try { await handle.writeFile(jsonBytes(pointer)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(pointerTemp, pointerPath);
      await fsyncDirectory(this.directory);
    }
    try {
      const packaged = await readBoundedFile(this.publicationDirectory, `${this.baselineSHA256}.json`, MAX_RESOURCE_BYTES);
      if (digest(packaged) !== pointer.resourceSHA256) throw fail(503, 'baseline-package-diverged');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const packageRoot = path.join(this.baselineDirectory, pointer.publicationSHA256);
    const proofDirectory = path.join(packageRoot, 'proofs');
    const resource = await readBoundedFile(proofDirectory, `${pointer.publicationSHA256}.json`, MAX_RESOURCE_BYTES);
    const asset = await readPublicationAsset(pointer.publicationSHA256, proofDirectory);
    if (digest(resource) !== pointer.resourceSHA256 || asset.identity.proofBodySHA256 !== pointer.proofBodySHA256) {
      throw fail(503, 'baseline-invalid');
    }
    const index = await loadSourceBodyArchiveIndex({ publicationDirectory: proofDirectory,
      archiveDirectory: path.join(packageRoot, 'archives') });
    return { asset, resourceSHA256: pointer.resourceSHA256, index };
  }

  async #candidatePackageRoot(sha) {
    const admitted = this.#snapshot.ledger.records.some(value => value.receipt.publicationSHA256 === sha && value.retained);
    if (this.#snapshot.ledger.records.some(value => value.receipt.publicationSHA256 === sha && !value.retained)) {
      throw fail(409, 'candidate-already-admitted');
    }
    if (admitted) return this.#admittedPackage(sha);
    try { await fs.lstat(this.#admittedPackage(sha)); return this.#admittedPackage(sha); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.#stagedPackage(sha);
  }

  async #ensureStage(sha) {
    const packageRoot = this.#stagedPackage(sha);
    const priorRecord = this.#snapshot.ledger.records.find(value => value.receipt.publicationSHA256 === sha);
    if (priorRecord) {
      if (priorRecord.retained) return this.#admittedPackage(sha);
      throw fail(409, 'candidate-already-admitted');
    }
    try { await fs.lstat(this.#admittedPackage(sha)); return this.#admittedPackage(sha); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let names = await fs.readdir(this.stagingDirectory, { withFileTypes: true });
    names = names.filter(item => item.isDirectory());
    const other = names.find(item => item.name !== sha);
    if (other) {
      const metadata = await this.#readStageMetadata(other.name).catch(() => null);
      if (metadata && this.now() - Date.parse(metadata.createdAt) > MAX_STAGE_AGE_MS) {
        await fs.rm(this.#stagedPackage(other.name), { recursive: true, force: true });
      } else throw fail(409, 'another-candidate-is-staged');
    }
    await ensureDirectory(packageRoot);
    const metaPath = path.join(packageRoot, 'stage.json');
    try { await readBoundedFile(packageRoot, 'stage.json', 1024); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const metadata = jsonBytes({ schemaVersion: 1, publicationSHA256: sha, createdAt: new Date(this.now()).toISOString() });
      await writeImmutable(this.directory, metaPath, metadata);
    }
    return packageRoot;
  }

  async #readStageMetadata(sha) {
    const bytes = await readBoundedFile(this.#stagedPackage(sha), 'stage.json', 1024);
    const value = JSON.parse(bytes.toString('utf8'));
    if (!exactKeys(value, ['schemaVersion', 'publicationSHA256', 'createdAt']) || value.schemaVersion !== 1
        || value.publicationSHA256 !== sha || !Number.isFinite(Date.parse(value.createdAt))) throw fail(503, 'staged-metadata-invalid');
    return value;
  }

  async #proofAsset(packageRoot, sha) {
    const proofDirectory = path.join(packageRoot, 'proofs');
    return readPublicationAsset(sha, proofDirectory);
  }

  async #stage(request, response, sha, parts) {
    let kind;
    let proofBodySHA256;
    let bodySHA256;
    if (parts.length === 1 && parts[0] === 'proof') kind = 'proof';
    else if (parts.length === 3 && parts[0] === 'archives' && validSHA(parts[1])
        && parts[2] === 'manifest') { kind = 'manifest'; proofBodySHA256 = parts[1]; }
    else if (parts.length === 4 && parts[0] === 'archives' && validSHA(parts[1])
        && parts[2] === 'bodies' && validSHA(parts[3])) {
      kind = 'body'; proofBodySHA256 = parts[1]; bodySHA256 = parts[3];
    } else { errorResponse(response, 404, 'candidate-not-found'); return; }

    const maximum = kind === 'proof' ? MAX_RESOURCE_BYTES : kind === 'manifest' ? MAX_SOURCE_MANIFEST_BYTES : MAX_SOURCE_BODY_BYTES;
    const bytes = await readBoundedRequest(request, maximum);
    if (!bytes.length) throw fail(400, 'empty-object');
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) throw fail(415, 'unsupported-content-type');
    const packageRoot = await this.#ensureStage(sha);
    let relative;
    if (kind === 'proof') {
      validatePublicationResource(bytes, sha);
      relative = path.join('proofs', `${sha}.json`);
    } else {
      const asset = await this.#proofAsset(packageRoot, sha);
      if (asset.identity.proofBodySHA256 !== proofBodySHA256) throw fail(409, 'proof-identity-mismatch');
      const archiveRoot = path.join(packageRoot, 'archives', sha, proofBodySHA256);
      if (kind === 'manifest') {
        validateSourceManifest(bytes, sha, proofBodySHA256);
        relative = path.join('archives', sha, proofBodySHA256, 'manifest.json');
      } else {
        const manifest = JSON.parse(await readBoundedFile(archiveRoot, 'manifest.json', MAX_SOURCE_MANIFEST_BYTES).then(value => value.toString('utf8')));
        const source = manifest.sources.find(value => value.bodySHA256 === bodySHA256);
        if (!source || bytes.length !== source.bodyBytes || digest(bytes) !== bodySHA256) throw fail(422, 'body-not-bound-to-manifest');
        relative = path.join('archives', sha, proofBodySHA256, source.bodyPath);
      }
    }
    const target = path.join(packageRoot, relative);
    const created = await writeImmutable(this.directory, target, bytes);
    if (await treeBytes(packageRoot) > MAX_STAGED_PACKAGE_BYTES) {
      if (created) { try { await fs.unlink(target); } catch {} }
      throw fail(413, 'candidate-storage-limit');
    }
    sendBytes(response, 204, Buffer.alloc(0), { 'x-tubeboard-object-sha256': digest(bytes) });
  }

  async #admit(request, response, sha) {
    const bytes = await readBoundedRequest(request, 1);
    if (bytes.length !== 0) throw fail(400, 'admission-body-must-be-empty');
    const existingRecord = this.#snapshot.ledger.records.find(value => value.receipt.publicationSHA256 === sha);
    if (existingRecord) {
      const existing = existingRecord.receipt;
      const ifMatch = request.headers['if-match'];
      const resourceClaim = request.headers['x-tubeboard-resource-sha256'];
      if (resourceClaim !== existing.resourceSHA256
          || ifMatch !== `"${existing.previousResourceSHA256}"`) {
        throw fail(409, 'admitted-candidate-is-immutable');
      }
      if (existingRecord.retained) {
        const proofBytes = await readBoundedFile(path.join(this.#admittedPackage(sha), 'proofs'), `${sha}.json`, MAX_RESOURCE_BYTES);
        if (digest(proofBytes) !== existing.resourceSHA256) throw fail(503, 'admitted-object-invalid');
      }
      await this.#cleanupSuperseded(this.#snapshot.ledger);
      sendBytes(response, 200, jsonBytes(existing), { 'content-type': 'application/json; charset=utf-8' });
      return;
    }
    const packageRoot = await this.#candidatePackageRoot(sha);
    const proofDirectory = path.join(packageRoot, 'proofs');
    const proofBytes = await readBoundedFile(proofDirectory, `${sha}.json`, MAX_RESOURCE_BYTES);
    const metadata = validatePublicationResource(proofBytes, sha);
    const candidateAsset = await readPublicationAsset(sha, proofDirectory);
    const resourceSHA256 = digest(proofBytes);
    if (request.headers['x-tubeboard-resource-sha256'] !== resourceSHA256) {
      throw fail(409, 'candidate-resource-digest-mismatch');
    }
    if (this.#snapshot.ledger.revision >= MAX_ADMISSION_HISTORY) throw fail(507, 'admission-history-limit');
    const previousAsset = this.#snapshot.previousAsset;
    const previousResourceSHA256 = this.#snapshot.previousResourceSHA256;
    const ifMatch = request.headers['if-match'];
    const expectedPrevious = typeof ifMatch === 'string' && /^"([a-f0-9]{64})"$/.exec(ifMatch)?.[1];
    if (expectedPrevious !== previousResourceSHA256) throw fail(412, 'previous-publication-precondition-failed');

    const archiveDirectory = path.join(packageRoot, 'archives');
    const candidateIndex = await loadSourceBodyArchiveIndex({ publicationDirectory: proofDirectory, archiveDirectory });
    const priorRetainedSHA = this.#snapshot.ledger.records.at(-1)?.receipt.publicationSHA256;
    const priorRetainedIndex = priorRetainedSHA ? this.#snapshot.retainedIndexes.get(priorRetainedSHA) : null;
    let nextIndex = this.#snapshot.baseIndex;
    if (priorRetainedIndex && this.maxRetainedPackages > 1) nextIndex = combineIndexes(nextIndex, priorRetainedIndex);
    nextIndex = combineIndexes(nextIndex, candidateIndex);
    if (nextIndex.bytes > MAX_SOURCE_ARCHIVE_BYTES) throw fail(507, 'source-index-storage-limit');
    const manifestPath = path.join(archiveDirectory, sha, metadata.proofBodySHA256, 'manifest.json');
    const manifestBytes = await readBoundedFile(path.dirname(manifestPath), 'manifest.json', MAX_SOURCE_MANIFEST_BYTES);
    const manifest = validateSourceManifest(manifestBytes, sha, metadata.proofBodySHA256);
    const officialObservation = this.observation.current();
    const result = evaluateNewEditionAdmission({ previousAsset, candidateAsset, comparisonIndex: candidateIndex,
      officialObservation, admissionRevision: this.#snapshot.ledger.revision,
      ifMatchPreviousResourceSHA256: expectedPrevious, now: this.now() });
    if (!result.eligible) throw fail(422, result.reason);
    const packageBytes = await treeBytes(packageRoot);
    await this.#cleanupSuperseded(this.#snapshot.ledger);
    const storedAdmittedBytes = await treeBytes(this.admittedDirectory);
    if (storedAdmittedBytes + packageBytes > this.maxAdmittedBytes + MAX_STAGED_PACKAGE_BYTES) {
      throw fail(507, 'admitted-storage-limit');
    }
    const retainedPriorBytes = priorRetainedSHA && this.maxRetainedPackages > 1
      ? await treeBytes(this.#admittedPackage(priorRetainedSHA)) : 0;
    const nextAdmittedBytes = retainedPriorBytes + packageBytes;
    if (nextAdmittedBytes > this.maxAdmittedBytes) throw fail(507, 'admitted-storage-limit');
    const core = {
      schemaVersion: 1, status: 'admitted', admissionRevision: result.admissionRevision,
      publicationSHA256: sha, proofRevision: 1, proofBodySHA256: candidateAsset.identity.proofBodySHA256,
      resourceSHA256, sourceManifestSHA256: digest(manifestBytes), sourceCount: manifest.sourceCount,
      uniqueBodyCount: manifest.uniqueBodyCount, totalBodyBytes: manifest.totalBodyBytes,
      previousPublicationSHA256: previousAsset.identity.publicationSHA256,
      previousResourceSHA256, observedAt: officialObservation.observedAt
    };
    const receipt = makeReceipt(core);
    const committedPackage = this.#admittedPackage(sha);
    await ensureDirectory(this.admittedDirectory);
    try { await fs.rename(packageRoot, committedPackage); await fsyncDirectory(this.admittedDirectory); }
    catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      if (!await this.#sameTree(packageRoot, committedPackage)) throw fail(409, 'admitted-package-conflict');
      await fs.rm(packageRoot, { recursive: true, force: true });
    }
    await fsyncDirectory(this.stagingDirectory);
    const retainedStart = Math.max(0, this.#snapshot.ledger.records.length + 1 - this.maxRetainedPackages);
    const records = this.#snapshot.ledger.records.map((record, index) => ({
      receipt: record.receipt, retained: index >= retainedStart
    }));
    records.push({ receipt, retained: true });
    const ledger = { schemaVersion: 1, revision: result.admissionRevision, records };
    const committedProofDirectory = path.join(committedPackage, 'proofs');
    const committedArchiveDirectory = path.join(committedPackage, 'archives');
    const committedIndex = await loadSourceBodyArchiveIndex({ publicationDirectory: committedProofDirectory,
      archiveDirectory: committedArchiveDirectory });
    if (!hasCompleteComparisonArchive(candidateAsset, committedIndex)) throw fail(503, 'committed-package-readback-failed');
    let committedCombinedIndex = this.#snapshot.baseIndex;
    if (priorRetainedIndex && this.maxRetainedPackages > 1) {
      committedCombinedIndex = combineIndexes(committedCombinedIndex, priorRetainedIndex);
    }
    committedCombinedIndex = combineIndexes(committedCombinedIndex, committedIndex);
    if (committedCombinedIndex.bytes > MAX_SOURCE_ARCHIVE_BYTES) throw fail(507, 'source-index-storage-limit');
    if (committedCombinedIndex.archiveCount > MAX_SOURCE_INDEX_ARCHIVES) throw fail(507, 'source-index-count-limit');
    if (!sameFreshOfficialObservation(officialObservation, this.observation.current(), sha, this.now())) {
      if (packageRoot === this.#stagedPackage(sha)) {
        await fs.rename(committedPackage, packageRoot);
        await fsyncDirectory(this.admittedDirectory);
        await fsyncDirectory(this.stagingDirectory);
      }
      throw fail(409, 'official-edition-changed-during-admission');
    }
    await this.#writeLedger(ledger);
    const retainedIndexes = new Map();
    if (priorRetainedIndex && this.maxRetainedPackages > 1) retainedIndexes.set(priorRetainedSHA, priorRetainedIndex);
    retainedIndexes.set(sha, committedIndex);
    this.#snapshot = Object.freeze({ ledger, index: committedCombinedIndex,
      baseIndex: this.#snapshot.baseIndex, retainedIndexes,
      previousAsset: candidateAsset, previousResourceSHA256: resourceSHA256,
      admittedBytes: nextAdmittedBytes });
    await this.#cleanupSuperseded(ledger);
    sendBytes(response, 201, jsonBytes(receipt), { 'content-type': 'application/json; charset=utf-8' });
  }

  async #sameTree(left, right) {
    const collect = async root => {
      const values = new Map();
      const walk = async dir => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const relative = path.relative(root, full);
          if (entry.isSymbolicLink()) return false;
          if (entry.isDirectory()) { if (!await walk(full)) return false; }
          else if (entry.isFile()) values.set(relative, await fs.readFile(full));
          else return false;
        }
        return true;
      };
      if (!await walk(root)) return null;
      return values;
    };
    try {
      const [a, b] = await Promise.all([collect(left), collect(right)]);
      if (!a || !b || a.size !== b.size) return false;
      for (const [name, bytes] of a) if (!b.get(name)?.equals(bytes)) return false;
      return true;
    } catch { return false; }
  }

  async #readLedger() {
    let bytes;
    try { bytes = await readBoundedFile(this.directory, 'admissions.json', MAX_LEDGER_BYTES); }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, revision: 0, records: [] }; throw error; }
    const ledger = JSON.parse(bytes.toString('utf8'));
    if (!exactKeys(ledger, ledgerKeys) || ledger.schemaVersion !== 1 || !Number.isSafeInteger(ledger.revision)
        || ledger.revision < 0 || ledger.revision > MAX_ADMISSION_HISTORY
        || !Array.isArray(ledger.records) || ledger.records.length !== ledger.revision
        || !jsonBytes(ledger).equals(bytes)) throw fail(503, 'admission-ledger-invalid');
    return ledger;
  }

  async #writeLedger(ledger) {
    const bytes = jsonBytes(ledger);
    if (bytes.length > MAX_LEDGER_BYTES) throw fail(507, 'admission-ledger-limit');
    const temp = path.join(this.directory, '.tmp', `ledger-${randomUUID()}`);
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temp, this.ledgerPath); await fsyncDirectory(this.directory); }
    catch (error) { try { await fs.rm(temp, { force: true }); } catch {} throw error; }
  }

  async #readback(response, sha, pathKey) {
    const record = this.#snapshot.ledger.records.find(value => value.receipt.publicationSHA256 === sha);
    if (!record) { errorResponse(response, 404, 'candidate-not-found'); return true; }
    const receipt = record.receipt;
    if (pathKey !== '' && !record.retained) { errorResponse(response, 410, 'candidate-package-rotated'); return true; }
    const packageRoot = this.#admittedPackage(sha);
    const proofDirectory = path.join(packageRoot, 'proofs');
    const archiveRoot = path.join(packageRoot, 'archives', sha, receipt.proofBodySHA256);
    if (pathKey === '') {
      sendBytes(response, 200, jsonBytes(receipt), { 'content-type': 'application/json; charset=utf-8' });
      return true;
    }
    if (pathKey === 'proof') {
      const bytes = await readBoundedFile(proofDirectory, `${sha}.json`, MAX_RESOURCE_BYTES);
      if (digest(bytes) !== receipt.resourceSHA256) throw fail(503, 'admitted-object-invalid');
      sendBytes(response, 200, bytes, { 'content-type': 'application/json; charset=utf-8', 'x-tubeboard-resource-sha256': digest(bytes) });
      return true;
    }
    if (pathKey === `archives/${receipt.proofBodySHA256}/manifest`) {
      const bytes = await readBoundedFile(archiveRoot, 'manifest.json', MAX_SOURCE_MANIFEST_BYTES);
      if (digest(bytes) !== receipt.sourceManifestSHA256) throw fail(503, 'admitted-object-invalid');
      sendBytes(response, 200, bytes, { 'content-type': 'application/json; charset=utf-8', 'x-tubeboard-resource-sha256': digest(bytes) });
      return true;
    }
    const bodyMatch = new RegExp(`^archives/${receipt.proofBodySHA256}/bodies/([a-f0-9]{64})$`).exec(pathKey);
    if (bodyMatch) {
      const manifest = JSON.parse((await readBoundedFile(archiveRoot, 'manifest.json', MAX_SOURCE_MANIFEST_BYTES)).toString('utf8'));
      const source = manifest.sources.find(value => value.bodySHA256 === bodyMatch[1]);
      if (!source) { errorResponse(response, 404, 'candidate-not-found'); return true; }
      const bytes = await readBoundedFile(archiveRoot, source.bodyPath, MAX_SOURCE_BODY_BYTES);
      if (digest(bytes) !== source.bodySHA256 || bytes.length !== source.bodyBytes) throw fail(503, 'admitted-object-invalid');
      sendBytes(response, 200, bytes, { 'content-type': 'application/json; charset=utf-8', 'x-tubeboard-resource-sha256': digest(bytes) });
      return true;
    }
    errorResponse(response, 404, 'candidate-not-found');
    return true;
  }
}
