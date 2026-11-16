// The authenticated producer qualifies service dates. This read-only endpoint
// binds its small per-station resources to the installed publication and index.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPublicationAsset } from './timetable-publication-resource.js';
import { readBoundedFile } from './timetable-source-body-resource.js';

export const WINDOW_PREFIX = '/api/timetable-windows/v1/';
export const WINDOW_DIRECTORY = fileURLToPath(new URL('./timetable-windows/v1/', import.meta.url));
const validSHA = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const version = 'tb085-counted-minute-ordered-path-multiset-v1';
const check = (condition, message) => { if (!condition) throw new Error(message); };

const keysAre = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(' ').sort().join(',');
const identityFields = 'schemaVersion canonicalizerVersion publicationSHA256 proofBodySHA256 proofRevision';
const sequence = (items, low, high) => Array.isArray(items) && items.length <= high - low + 1
  && items.every((v, i) => Number.isSafeInteger(v) && low <= v && v <= high && (i === 0 || items[i - 1] < v));
const day = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const millis = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value ? millis : NaN;
};

function validateStationData(item) {
  check(keysAre(item, identityFields + ' lineID stationID requestDirection responseDirection sourceEndpoint sourceCapturedAt sourceAgeSeconds sourceBodySHA256 profiles serviceRanges')
    && item.requestDirection === 'default' && [null, 'inbound', 'outbound'].includes(item.responseDirection)
    && item.sourceEndpoint === 'https://api.tfl.gov.uk/Line/' + item.lineID + '/Timetable/' + item.stationID
    && validSHA(item.sourceBodySHA256) && typeof item.sourceCapturedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(item.sourceCapturedAt)
    && Number.isFinite(Date.parse(item.sourceCapturedAt))
    && Number.isSafeInteger(item.sourceAgeSeconds) && item.sourceAgeSeconds >= 0 && item.sourceAgeSeconds < 600,
    'Invalid timetable window source');
  check(Array.isArray(item.profiles) && item.profiles.length > 0 && item.profiles.length <= 64, 'Invalid window profiles');
  const names = new Set();
  const weekdays = new Set();
  for (const profile of item.profiles) {
    check(keysAre(profile, 'name weekdays count sha256') && typeof profile.name === 'string'
      && /^[A-Za-z ()-]{1,64}$/.test(profile.name) && !names.has(profile.name)
      && sequence(profile.weekdays, 1, 7) && profile.weekdays.length > 0 && profile.weekdays.every(d => !weekdays.has(d))
      && Number.isSafeInteger(profile.count) && profile.count > 0 && validSHA(profile.sha256), 'Invalid window profile');
    names.add(profile.name);
    for (const d of profile.weekdays) weekdays.add(d);
  }
  check(Array.isArray(item.serviceRanges) && item.serviceRanges.length > 0 && item.serviceRanges.length <= 2048, 'Invalid window ranges');
  let previous = -Infinity;
  for (const range of item.serviceRanges) {
    const start = day(range.startDate), end = day(range.endDate);
    check(keysAre(range, 'startDate endDate profileName disputedMinutes') && start > previous && end >= start
      && end - start < 730 * 86_400_000 && names.has(range.profileName) && sequence(range.disputedMinutes, 0, 2879),
      'Invalid timetable window range');
    previous = end;
  }
}

export const MAX_WINDOW_TRANSPORT_BYTES = 3 * 1024 * 1024;

export function loadWindowPackage(directory, identity, indexSHA256) {
  return validateWindowPackage(identity, indexSHA256, (name, limit) => readBoundedFile(directory, name, limit));
}

export async function decodeWindowTransport(bytes, identity, expectedIndexSHA) {
  check(bytes.length > 0 && bytes.length <= MAX_WINDOW_TRANSPORT_BYTES, 'Invalid timetable window transport size');
  const wire = JSON.parse(bytes);
  check(wire && Object.keys(wire).sort().join(',') === 'indexBase64,resources'
    && wire.resources && typeof wire.resources === 'object' && !Array.isArray(wire.resources)
    && Object.keys(wire.resources).length <= 256, 'Invalid timetable window transport');
  const decode = (str, max) => {
    check(typeof str === 'string' && str.length > 0 && str.length <= 4 * Math.ceil(max / 3), 'Invalid window encoding size');
    const decoded = Buffer.from(str, 'base64');
    check(decoded.length <= max && decoded.toString('base64') === str, 'Invalid window encoding');
    return decoded;
  };
  const index = decode(wire.indexBase64, 64 * 1024);
  const indexSHA = hash(index);
  check(expectedIndexSHA === undefined || expectedIndexSHA === indexSHA, 'Unexpected timetable window index digest');
  const seen = new Set();
  const bundle = await validateWindowPackage(identity, indexSHA, (name, limit) => {
    if (name === 'index.json') return index;
    const sha = name.slice('resources/'.length, -'.json'.length);
    seen.add(sha);
    return decode(wire.resources[sha], limit);
  });
  check(seen.size === Object.keys(wire.resources).length, 'Unreferenced timetable window resources');
  return bundle;
}

async function validateWindowPackage(identity, indexSHA256, read) {
  const { publicationSHA256, proofBodySHA256, proofRevision } = identity;
  check(validSHA(indexSHA256) && validSHA(publicationSHA256) && validSHA(proofBodySHA256)
    && Number.isSafeInteger(proofRevision) && proofRevision > 0, 'Invalid timetable window identity');
  const indexBytes = await read('index.json', 64 * 1024);
  check(hash(indexBytes) === indexSHA256, 'Timetable window index digest mismatch');
  const index = JSON.parse(indexBytes);
  const matchesIdentity = item => item.schemaVersion === 1 && item.canonicalizerVersion === version
    && item.publicationSHA256 === publicationSHA256 && item.proofBodySHA256 === proofBodySHA256
    && item.proofRevision === proofRevision;
  check(keysAre(index, identityFields + ' resources') && matchesIdentity(index) && Array.isArray(index.resources)
    && index.resources.length > 0 && index.resources.length <= 256, 'Invalid timetable window index');
  const resources = new Map();
  const scopes = new Set();
  let total = indexBytes.length;
  for (const ref of index.resources) {
    check(keysAre(ref, 'lineID stationID requestDirection sha256 bytes path') && validSHA(ref.sha256) && ref.path === 'resources/' + ref.sha256 + '.json'
      && !resources.has(ref.path) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= 64 * 1024
      && /^[a-z0-9-]{2,32}$/.test(ref.lineID) && /^[A-Z0-9]{6,16}$/.test(ref.stationID)
      && ['default', 'inbound', 'outbound'].includes(ref.requestDirection), 'Invalid timetable window reference');
    const key = [ref.lineID, ref.stationID, ref.requestDirection].join('/');
    total += ref.bytes;
    check(!scopes.has(key) && total <= 2 * 1024 * 1024, 'Duplicate or excessive timetable window data');
    scopes.add(key);
    const body = await read(ref.path, ref.bytes);
    check(body.length === ref.bytes && hash(body) === ref.sha256, 'Timetable window resource digest mismatch');
    const item = JSON.parse(body);
    check(matchesIdentity(item) && item.lineID === ref.lineID && item.stationID === ref.stationID
      && item.requestDirection === ref.requestDirection, 'Timetable window scope mismatch');
    validateStationData(item);
    resources.set(ref.path, { bytes: body, sha: ref.sha256 });
  }
  resources.set('index.json', { bytes: indexBytes, sha: indexSHA256 });
  return { get: name => resources.get(name), indexSHA256 };
}

export async function loadBundledWindows(directory, publicationDirectory) {
  let pins;
  try { pins = JSON.parse(await readBoundedFile(directory, 'reviewed.json', 4096)); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  check(Array.isArray(pins) && pins.length <= 4, 'Invalid timetable window pins');
  const packages = new Map();
  for (const pin of pins) {
    const { identity } = await readPublicationAsset(pin.publicationSHA256, publicationDirectory);
    const key = identity.publicationSHA256 + '/' + identity.proofBodySHA256;
    check(!packages.has(key) && pin.proofBodySHA256 === identity.proofBodySHA256, 'Timetable window pin mismatch');
    packages.set(key, await loadWindowPackage(path.join(directory, key), identity, pin.indexSHA256));
  }
  return packages;
}

export async function handleWindowResource(request, response, url, packages, admittedPackage = () => null) {
  if (!url.pathname.startsWith(WINDOW_PREFIX)) return false;
  const parts = url.pathname.slice(WINDOW_PREFIX.length).split('/');
  const [edition, proof, type, file] = parts;
  const isIndex = type === 'index.json' && parts.length === 3;
  const isResource = type === 'resources' && parts.length === 4 && /^[a-f0-9]{64}\.json$/.test(file);
  response.setHeader('cache-control', 'no-store');
  if (!validSHA(edition) || !validSHA(proof) || (!isIndex && !isResource) || url.search) {
    response.writeHead(404); response.end(); return true;
  }
  if (!['HEAD', 'GET'].includes(request.method)) {
    response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return true;
  }
  const installed = await packages;
  const key = edition + '/' + proof;
  const bundle = admittedPackage(key) ?? installed?.get(key);
  if (bundle === false) { response.writeHead(503); response.end(); return true; }
  const entry = bundle?.get(isIndex ? type : type + '/' + file);
  if (!entry) { response.writeHead(installed ? 404 : 503); response.end(); return true; }
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8', 'content-length': entry.bytes.length,
    'x-content-type-options': 'nosniff', 'x-tubeboard-window-sha256': entry.sha,
    'x-tubeboard-publication-sha256': edition, 'x-tubeboard-proof-body-sha256': proof
  });
  response.end(request.method === 'HEAD' ? undefined : entry.bytes);
  return true;
}
