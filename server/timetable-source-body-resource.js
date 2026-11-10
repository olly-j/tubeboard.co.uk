// Read-only access to exact archived TfL timetable response bodies. These
// bytes are for source comparison only and are never current departure data.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { readPublicationAsset, validatePublicationResource, MAX_RESOURCE_BYTES } from './timetable-publication-resource.js';
import { selectedTimetableEntry } from './station-board-timetable.js';

export const SOURCE_BODY_PREFIX = '/api/timetable-source-bodies/v1/';
export const SOURCE_ARCHIVE_DIRECTORY = fileURLToPath(new URL('./timetable-source-archives/v1/', import.meta.url));
export const MAX_SOURCE_MANIFEST_BYTES = 256 * 1024;
export const MAX_SOURCE_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_INDEX_ARCHIVES = 16;

const SHA = /^[a-f0-9]{64}$/;
const LINE = /^[a-z0-9-]{2,32}$/;
const STATION = /^[A-Z0-9]{6,16}$/;
const DIRECTIONS = new Set(['default', 'inbound', 'outbound']);
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hasExactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validSHA = value => typeof value === 'string' && SHA.test(value);
const validTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));
const safeHeader = (value, maximum = 512) => typeof value === 'string' && value.length <= maximum
  && !/[\r\n\0]/.test(value);

const MANIFEST_FIELDS = ['schemaVersion', 'kind', 'publicationSHA256', 'proofBodySHA256', 'usePolicy',
  'canonicalBodyKey', 'sourceCount', 'uniqueBodyCount', 'totalBodyBytes', 'sources'];
const POLICY_FIELDS = ['role', 'mayServeDepartures', 'requiresFreshCurrentResponse',
  'requiresCurrentStatusAndDisruptionChecks', 'captureMetadataMayEstablishFreshness', 'capturedResponseWasFreshAtReadback'];
const SOURCE_FIELDS = ['lineID', 'stationID', 'direction', 'endpoint', 'bodySHA256', 'bodyPath', 'bodyBytes',
  'responseDirection', 'startedAt', 'receivedAt', 'httpDate', 'age', 'cacheControl'];

const scopeKey = value => `${value.lineID}\u0000${value.stationID}\u0000${value.direction ?? 'default'}`;
const requestKey = value => `${value.publicationSHA256}\u0000${value.proofBodySHA256}\u0000${value.lineID}\u0000${value.stationID}\u0000${value.direction}\u0000${value.bodySHA256}`;
const archiveIdentityKey = (publicationSHA256, proofBodySHA256) => `${publicationSHA256}\u0000${proofBodySHA256}`;

function expectedEndpoint(source) {
  const base = `https://api.tfl.gov.uk/Line/${source.lineID}/Timetable/${source.stationID}`;
  return source.direction === null ? base : `${base}?direction=${source.direction}`;
}

function expectedProofSources(proof) {
  const sources = [];
  for (const entry of proof.entries) {
    if (entry.status !== 'qualified') continue;
    if (entry.directionalDefinitions !== undefined) {
      const defined = entry.directionalDefinitions.map(value => value.direction);
      const evidence = entry.directionalSourceEvidence;
      if (!Array.isArray(evidence) || evidence.length !== defined.length || new Set(defined).size !== defined.length
          || evidence.some(value => !defined.includes(value.direction) || !validSHA(value.apiBodySHA256))) {
        throw new Error('Directional source bindings are incomplete');
      }
      for (const value of evidence) sources.push({ lineID: entry.lineID, stationID: entry.stationID,
        direction: value.direction, bodySHA256: value.apiBodySHA256 });
      continue;
    }
    if (entry.directionalSourceEvidence !== undefined || !validSHA(entry.apiBodySHA256)) {
      throw new Error('Legacy source body binding is missing');
    }
    sources.push({ lineID: entry.lineID, stationID: entry.stationID,
      direction: null, bodySHA256: entry.apiBodySHA256 });
  }
  return sources;
}

export function validateSourceManifest(bytes, publicationSHA256, proofBodySHA256) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_SOURCE_MANIFEST_BYTES
      || !validSHA(publicationSHA256) || !validSHA(proofBodySHA256)) throw new Error('Invalid source manifest bounds');
  const value = JSON.parse(utf8.decode(bytes));
  if (!hasExactKeys(value, MANIFEST_FIELDS) || value.schemaVersion !== 1
      || value.kind !== 'tubeboard-timetable-comparison-reference'
      || value.publicationSHA256 !== publicationSHA256 || value.proofBodySHA256 !== proofBodySHA256
      || value.canonicalBodyKey !== 'SHA-256 of exact UTF-8 Unified timetable response bytes'
      || !hasExactKeys(value.usePolicy, POLICY_FIELDS)
      || value.usePolicy.role !== 'comparison-reference-only' || value.usePolicy.mayServeDepartures !== false
      || value.usePolicy.requiresFreshCurrentResponse !== true
      || value.usePolicy.requiresCurrentStatusAndDisruptionChecks !== true
      || value.usePolicy.captureMetadataMayEstablishFreshness !== false
      || value.usePolicy.capturedResponseWasFreshAtReadback !== true
      || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 1 || value.sourceCount > 4096
      || !Number.isSafeInteger(value.uniqueBodyCount) || value.uniqueBodyCount < 1 || value.uniqueBodyCount > value.sourceCount
      || !Number.isSafeInteger(value.totalBodyBytes) || value.totalBodyBytes < 1 || value.totalBodyBytes > MAX_SOURCE_ARCHIVE_BYTES
      || !Array.isArray(value.sources) || value.sources.length !== value.sourceCount) {
    throw new Error('Invalid source manifest identity or policy');
  }

  const scopes = new Set();
  const bodies = new Map();
  for (const source of value.sources) {
    if (!hasExactKeys(source, SOURCE_FIELDS) || !LINE.test(source.lineID) || !STATION.test(source.stationID)
        || (source.direction !== null && !['inbound', 'outbound'].includes(source.direction))
        || !validSHA(source.bodySHA256) || source.endpoint !== expectedEndpoint(source)
        || source.bodyPath !== `bodies/${source.bodySHA256}.json`
        || !Number.isSafeInteger(source.bodyBytes) || source.bodyBytes < 1 || source.bodyBytes > MAX_SOURCE_BODY_BYTES
        || (source.responseDirection !== null && !['inbound', 'outbound'].includes(source.responseDirection))
        || !validTime(source.startedAt) || !validTime(source.receivedAt) || Date.parse(source.receivedAt) < Date.parse(source.startedAt)
        || typeof source.httpDate !== 'string' || !HTTP_DATE.test(source.httpDate) || !Number.isFinite(Date.parse(source.httpDate))
        || typeof source.age !== 'string' || !/^\d{1,4}$/.test(source.age)
        || !safeHeader(source.cacheControl)) throw new Error('Invalid source manifest record');
    const receivedMs = Date.parse(source.receivedAt);
    const startedMs = Date.parse(source.startedAt);
    const upstreamAge = Number(source.age);
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(source.cacheControl);
    const freshnessTTLSeconds = maxAge ? Math.min(60, Number(maxAge[1])) : 60;
    const elapsedSeconds = (receivedMs - Date.parse(source.httpDate)) / 1000;
    if (startedMs > receivedMs || receivedMs - startedMs > 30_000 || upstreamAge > 600
        || elapsedSeconds < 0 || Math.max(elapsedSeconds, upstreamAge) >= freshnessTTLSeconds) {
      throw new Error('Source capture was not fresh at receipt');
    }
    const key = scopeKey(source);
    if (scopes.has(key)) throw new Error('Duplicate source manifest scope');
    scopes.add(key);
    const priorBytes = bodies.get(source.bodySHA256);
    if (priorBytes !== undefined && priorBytes !== source.bodyBytes) throw new Error('Inconsistent body byte length');
    bodies.set(source.bodySHA256, source.bodyBytes);
  }
  const uniqueBodyBytes = [...bodies.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (bodies.size !== value.uniqueBodyCount || uniqueBodyBytes !== value.totalBodyBytes
      || !Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8').equals(bytes)) {
    throw new Error('Noncanonical source manifest or incorrect body totals');
  }
  return value;
}

export async function readBoundedFile(directory, relativePath, maximumBytes) {
  const handle = await fs.open(path.join(directory, relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) throw new Error('Invalid source asset bounds');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count !== stat.size) throw new Error('Changed source asset');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

// A bundled predecessor can reuse current body buffers only for identical
// qualified station entries under identical publication-wide service rules.
async function previousProofScopes(archivePath, asset, manifest) {
  if (asset.identity.proofRevision < 2) return null;
  let bytes;
  try { bytes = await readBoundedFile(archivePath, 'previous-resource.json', MAX_RESOURCE_BYTES); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const previous = validatePublicationResource(bytes, asset.identity.publicationSHA256);
  if (previous.revision !== asset.identity.proofRevision - 1) throw new Error('Wrong previous proof revision');
  const prior = JSON.parse(Buffer.from(JSON.parse(bytes).proofBodyBase64, 'base64'));
  const { entries: previousEntries, coverage: previousCoverage, ...previousRules } = prior;
  const { entries: currentEntries, coverage: currentCoverage, ...currentRules } = asset.proof;
  if (!isDeepStrictEqual(previousRules, currentRules)) return null;
  const stationKey = row => row.lineID + '/' + row.stationID;
  const current = new Map(currentEntries.map(row => [stationKey(row), row]));
  const identical = new Set(previousEntries.filter(row => row.status === 'qualified'
    && isDeepStrictEqual(row, current.get(stationKey(row)))).map(stationKey));
  const priorManifest = validateSourceManifest(
    await readBoundedFile(archivePath, 'previous-manifest.json', MAX_SOURCE_MANIFEST_BYTES),
    asset.identity.publicationSHA256, previous.proofBodySHA256);
  const priorSources = new Map(priorManifest.sources.map(source => [scopeKey(source), source]));
  const identicalScopes = new Set(manifest.sources.filter(source =>
    identical.has(stationKey(source)) && isDeepStrictEqual(source, priorSources.get(scopeKey(source)))).map(scopeKey));
  return { sha: previous.proofBodySHA256, identicalScopes };
}

function freezeIndex(entries, unavailable, indexedBytes = 0, archivesSeen = 0, previous = new Map()) {
  return Object.freeze({
    get: key => entries.get(key) ?? previous.get(key),
    isUnavailable: (publicationSHA256, proofBodySHA256) => unavailable.has(archiveIdentityKey(publicationSHA256, proofBodySHA256)),
    size: entries.size,
    bytes: indexedBytes,
    archiveCount: archivesSeen
  });
}

// Build the finite immutable request index once at process start (or in tests).
// Runtime requests do not reopen the proof, manifest or body files.
export async function loadSourceBodyArchiveIndex({
  publicationDirectory,
  archiveDirectory = SOURCE_ARCHIVE_DIRECTORY
}) {
  const entries = new Map();
  const previousEntries = new Map();
  const unavailable = new Set();
  let indexedBytes = 0;
  let archivesSeen = 0;
  let archiveNames;
  try { archiveNames = await fs.readdir(archiveDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return freezeIndex(entries, unavailable, indexedBytes, archivesSeen, previousEntries); throw error; }
  const publicationNames = archiveNames.filter(item => item.isDirectory() && validSHA(item.name))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const publication of publicationNames) {
    const publicationPath = path.join(archiveDirectory, publication.name);
    const proofNames = await fs.readdir(publicationPath, { withFileTypes: true });
    for (const proofDirectory of proofNames.filter(item => item.isDirectory() && validSHA(item.name))) {
      const identityKey = archiveIdentityKey(publication.name, proofDirectory.name);
      if (++archivesSeen > MAX_SOURCE_INDEX_ARCHIVES) { unavailable.add(identityKey); continue; }
      let asset;
      try { asset = await readPublicationAsset(publication.name, publicationDirectory); }
      catch (error) {
        if (error.code === 'ENOENT') continue; // Orphaned archive without an installed proof.
        unavailable.add(identityKey);
        continue;
      }
      if (asset.identity.proofBodySHA256 !== proofDirectory.name) continue; // Superseded proof archive.
      try {
        const archivePath = path.join(publicationPath, proofDirectory.name);
        const manifest = validateSourceManifest(await readBoundedFile(archivePath, 'manifest.json', MAX_SOURCE_MANIFEST_BYTES),
          publication.name, proofDirectory.name);
        const expected = expectedProofSources(asset.proof);
        const expectedByScope = new Map(expected.map(source => [scopeKey(source), source.bodySHA256]));
        if (expectedByScope.size !== expected.length || manifest.sources.length !== expected.length) {
          throw new Error('Manifest does not cover the complete qualified proof');
        }
        const pendingEntries = [];
        const pendingBodies = new Map();
        let pendingBytes = 0;
        for (const source of manifest.sources) {
          const requestDirection = source.direction ?? 'default';
          if (expectedByScope.get(scopeKey(source)) !== source.bodySHA256) {
            throw new Error('Manifest source is not authorized by the proof');
          }
          // Reuse the station-board qualifier so only a currently installed,
          // well-formed qualified proof scope can authorize its raw source.
          selectedTimetableEntry(asset, { lineID: source.lineID, stationID: source.stationID });
          let body = pendingBodies.get(source.bodySHA256);
          if (!body) {
            body = await readBoundedFile(archivePath, source.bodyPath, MAX_SOURCE_BODY_BYTES);
            if (body.length !== source.bodyBytes || digest(body) !== source.bodySHA256) {
              throw new Error('Archived source body hash mismatch');
            }
            pendingBodies.set(source.bodySHA256, body);
            pendingBytes += body.length;
          } else if (body.length !== source.bodyBytes) {
            throw new Error('Conflicting content-addressed source body');
          }
          const payload = JSON.parse(utf8.decode(body));
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
              || payload.lineId !== source.lineID || payload.timetable?.departureStopId !== source.stationID) {
            throw new Error('Archived source body has the wrong station or line');
          }
          const responseDirection = payload.direction ?? null;
          if (responseDirection !== source.responseDirection
              || (source.direction !== null && responseDirection !== source.direction)) {
            throw new Error('Archived source body has the wrong response direction');
          }
          if (indexedBytes + pendingBytes > MAX_SOURCE_ARCHIVE_BYTES) throw new Error('Source index exceeds byte limit');
          const key = requestKey({ publicationSHA256: publication.name, proofBodySHA256: proofDirectory.name,
            lineID: source.lineID, stationID: source.stationID, direction: requestDirection, bodySHA256: source.bodySHA256 });
          if (entries.has(key) || pendingEntries.some(([prior]) => prior === key)) throw new Error('Duplicate indexed source scope');
          pendingEntries.push([key, Object.freeze({
            publicationSHA256: publication.name,
            proofBodySHA256: proofDirectory.name,
            bodySHA256: source.bodySHA256,
            lineID: source.lineID,
            stationID: source.stationID,
            direction: requestDirection,
            responseDirection: source.responseDirection,
            endpoint: source.endpoint,
            httpDate: source.httpDate,
            age: source.age,
            cacheControl: source.cacheControl,
            startedAt: source.startedAt,
            receivedAt: source.receivedAt,
            body
          })]);
        }
        // Publish this package atomically only after every proof scope and body
        // has passed validation; a late failure cannot leave partial authority.
        // A damaged optional predecessor must not withdraw the independently
        // validated current package. No alias is published on that path.
        let previous;
        try { previous = await previousProofScopes(archivePath, asset, manifest); }
        catch { previous = null; }
        for (const [key, source] of pendingEntries) {
          entries.set(key, source);
          if (previous?.identicalScopes.has(scopeKey(source))) {
            previousEntries.set(requestKey({ ...source, proofBodySHA256: previous.sha }), source);
          }
        }
        indexedBytes += pendingBytes;
      } catch {
        // Keep only an identity-bounded failure marker. The HTTP route fails
        // closed for this optional archive while other service paths continue.
        unavailable.add(identityKey);
      }
    }
  }
  return freezeIndex(entries, unavailable, indexedBytes, archivesSeen, previousEntries);
}

function jsonError(response, status, message, headOnly) {
  const body = Buffer.from(JSON.stringify({ ok: false, error: message }) + '\n');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  response.end(headOnly ? undefined : body);
}

export async function handleSourceBodyResource(request, response, url, { index }) {
  if (!url.pathname.startsWith(SOURCE_BODY_PREFIX)) return false;
  const headOnly = request.method === 'HEAD';
  const parts = url.pathname.slice(SOURCE_BODY_PREFIX.length).split('/');
  if (url.search !== '' || parts.length !== 6 || !validSHA(parts[0]) || !validSHA(parts[1])
      || !LINE.test(parts[2]) || !STATION.test(parts[3]) || !DIRECTIONS.has(parts[4]) || !validSHA(parts[5])) {
    jsonError(response, 404, 'Source archive not available', headOnly);
    return true;
  }
  if (request.method !== 'GET' && !headOnly) {
    response.setHeader('allow', 'GET, HEAD');
    jsonError(response, 405, 'Method not allowed', false);
    return true;
  }
  const [publicationSHA256, proofBodySHA256, lineID, stationID, direction, bodySHA256] = parts;
  let ready;
  try { ready = await index; }
  catch {
    jsonError(response, 503, 'Source archive unavailable', headOnly);
    return true;
  }
  if (!ready) {
    jsonError(response, 503, 'Source archive unavailable', headOnly);
    return true;
  }
  const source = ready.get(requestKey({ publicationSHA256, proofBodySHA256, lineID, stationID, direction, bodySHA256 }));
  if (!source) {
    jsonError(response, ready.isUnavailable(publicationSHA256, proofBodySHA256) ? 503 : 404,
      ready.isUnavailable(publicationSHA256, proofBodySHA256) ? 'Source archive unavailable' : 'Source archive not available', headOnly);
    return true;
  }
  const etag = `"tbsource-v1-${publicationSHA256}-${proofBodySHA256}-${bodySHA256}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': source.body.length,
    'cache-control': 'no-store',
    etag,
    'x-content-type-options': 'nosniff',
    'x-tubeboard-source-use': 'archived-comparison-only',
    'x-tubeboard-publication-sha256': publicationSHA256,
    'x-tubeboard-proof-body-sha256': proofBodySHA256,
    'x-tubeboard-api-body-sha256': bodySHA256,
    'x-tubeboard-source-direction': direction,
    ...(source.responseDirection === null ? {} : { 'x-tubeboard-source-response-direction': source.responseDirection }),
    'x-tubeboard-source-endpoint': source.endpoint,
    'x-tubeboard-source-http-date': source.httpDate,
    'x-tubeboard-source-http-age': source.age,
    'x-tubeboard-source-http-cache-control': source.cacheControl,
    'x-tubeboard-source-started-at': source.startedAt,
    'x-tubeboard-source-received-at': source.receivedAt
  };
  const tags = String(request.headers['if-none-match'] ?? '').split(',').map(value => value.trim());
  if (tags.some(tag => tag === '*' || tag === etag || tag === `W/${etag}`)) {
    response.writeHead(304, headers);
    response.end();
  } else {
    response.writeHead(200, headers);
    response.end(headOnly ? undefined : source.body);
  }
  return true;
}
