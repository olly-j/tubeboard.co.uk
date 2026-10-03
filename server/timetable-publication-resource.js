// Proposed TB-085 publication metadata transport. This does not qualify rows,
// run the XML generator, query TfL, or read registration/credential stores.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const MAX_RESOURCE_BYTES = 2_000_000;
export const MAX_PROOF_BYTES = 128 * 1024;
export const MAX_PROOF_REVISION = Number.MAX_SAFE_INTEGER;
export const PUBLICATION_RESOURCE_PREFIX = '/api/timetable-publications/v1/';
export const PUBLICATION_ASSET_DIRECTORY = fileURLToPath(new URL('./timetable-publications/v1/', import.meta.url));
const SHA = /^[a-f0-9]{64}$/;
const validSHA = (value) => typeof value === 'string' && value.length === 64 && SHA.test(value);
const SOURCE = 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function canonicalResource(value) {
  return Buffer.from(JSON.stringify({
    schemaVersion: value.schemaVersion,
    publicationSHA256: value.publicationSHA256,
    proofRevision: value.proofRevision,
    proofBodySHA256: value.proofBodySHA256,
    proofBodyBase64: value.proofBodyBase64
  }) + '\n', 'utf8');
}

export function validatePublicationResource(bytes, expectedSHA) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RESOURCE_BYTES
      || !validSHA(expectedSHA)) throw new Error('Invalid publication resource');
  const value = JSON.parse(utf8.decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'proofBodyBase64,proofBodySHA256,proofRevision,publicationSHA256,schemaVersion'
      || value.schemaVersion !== 1 || value.publicationSHA256 !== expectedSHA
      || !Number.isSafeInteger(value.proofRevision) || value.proofRevision < 1
      || !validSHA(value.proofBodySHA256) || typeof value.proofBodyBase64 !== 'string'
      || value.proofBodyBase64.length === 0
      || value.proofBodyBase64.length > 4 * Math.ceil(MAX_PROOF_BYTES / 3)
      || !BASE64.test(value.proofBodyBase64)) throw new Error('Invalid publication wrapper');
  // Exact producer serialization rejects duplicate wrapper keys, alternate
  // unknown fields and unsafe JSON numeric spellings instead of last-key wins.
  if (!canonicalResource(value).equals(bytes)) throw new Error('Noncanonical publication wrapper');
  const proofBytes = Buffer.from(value.proofBodyBase64, 'base64');
  if (proofBytes.length === 0 || proofBytes.length > MAX_PROOF_BYTES
      || proofBytes.toString('base64') !== value.proofBodyBase64
      || hash(proofBytes) !== value.proofBodySHA256) throw new Error('Invalid publication proof bytes');
  const proof = JSON.parse(utf8.decode(proofBytes));
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
      || proof.schemaVersion !== 1 || proof.timezone !== 'Europe/London'
      || !proof.publication || proof.publication.sha256 !== expectedSHA
      || proof.publication.url !== SOURCE || !Array.isArray(proof.entries)) {
    throw new Error('Wrong embedded publication');
  }
  // The reviewed producer and APP's strict model/calendar/parity qualifier
  // own proof semantics. Serving metadata does not prove current operation.
  return {
    revision: value.proofRevision,
    proofBodySHA256: value.proofBodySHA256,
    etag: `"tbproof-v1-${expectedSHA}-r${value.proofRevision}-${value.proofBodySHA256}"`
  };
}

export async function readReviewedAsset(directory, sha) {
  const file = path.join(directory, sha + '.json');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RESOURCE_BYTES) {
      throw new Error('Invalid asset bounds');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > MAX_RESOURCE_BYTES || count !== stat.size) throw new Error('Changed or oversized asset');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
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

export async function handlePublicationResource(request, response, url, { directory }) {
  if (!url.pathname.startsWith(PUBLICATION_RESOURCE_PREFIX)) return false;
  const headOnly = request.method === 'HEAD';
  const sha = url.pathname.slice(PUBLICATION_RESOURCE_PREFIX.length);
  if (!validSHA(sha) || url.search !== '') {
    jsonError(response, 404, 'Publication proof not available', headOnly);
    return true;
  }
  if (request.method !== 'GET' && !headOnly) {
    response.setHeader('allow', 'GET, HEAD');
    jsonError(response, 405, 'Method not allowed', false);
    return true;
  }
  let bytes;
  let proof;
  try {
    bytes = await readReviewedAsset(directory, sha);
    proof = validatePublicationResource(bytes, sha);
  } catch (error) {
    // Invalid reviewed assets are deployment/readiness failures, not unknown
    // TfL publication authority. Never fall through to HTML/static assets.
    jsonError(response, error.code === 'ENOENT' ? 404 : 503,
      error.code === 'ENOENT' ? 'Publication proof not available' : 'Publication proof unavailable', headOnly);
    return true;
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=60, must-revalidate',
    etag: proof.etag,
    'x-content-type-options': 'nosniff'
  };
  const tags = String(request.headers['if-none-match'] ?? '').split(',').map((v) => v.trim());
  if (tags.some((tag) => tag === '*' || tag === proof.etag || tag === 'W/' + proof.etag)) {
    response.writeHead(304, headers);
    response.end();
  } else {
    response.writeHead(200, { ...headers, 'content-length': bytes.length });
    response.end(headOnly ? undefined : bytes);
  }
  return true;
}

// Reuse exact reviewed local bytes; never call this server's public HTTP route.
export async function readPublicationAsset(sha, directory = PUBLICATION_ASSET_DIRECTORY) {
  if (!validSHA(sha)) throw new Error('Invalid publication identity');
  const bytes = await readReviewedAsset(directory, sha);
  const tuple = validatePublicationResource(bytes, sha);
  return { identity: { publicationSHA256: sha, proofRevision: tuple.revision, proofBodySHA256: tuple.proofBodySHA256 }, etag: tuple.etag, proofBytes: Buffer.from(JSON.parse(bytes).proofBodyBase64, 'base64'), proof: JSON.parse(Buffer.from(JSON.parse(bytes).proofBodyBase64, 'base64').toString('utf8')) };
}
