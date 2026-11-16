// Local prototype for an immutable, new-edition admission gate. This module
// validates proof and comparison-package completeness; it never writes files,
// changes the active publication, or qualifies departures.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TIMETABLE_PUBLICATION_URL } from './station-board-seed.js';
import { selectedTimetableEntry, validatedPublicationProof } from './station-board-timetable.js';
import { assessCurrentPublicationCoverage } from './timetable-current-coverage.js';
import { canonicalResource } from './timetable-publication-resource.js';

const MAX_COVERAGE_DAYS = 3660;
const sourceKey = ({ publicationSHA256, proofBodySHA256, lineID, stationID, direction, bodySHA256 }) =>
  `${publicationSHA256}\u0000${proofBodySHA256}\u0000${lineID}\u0000${stationID}\u0000${direction ?? 'default'}\u0000${bodySHA256}`;
const validSHA = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = reason => Object.assign(new Error(reason), { admissionReason: reason });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function publicationResourceSHA256(asset) {
  const { publicationSHA256, proofRevision, proofBodySHA256 } = asset.identity;
  const bytes = canonicalResource({ schemaVersion: 1, publicationSHA256, proofRevision, proofBodySHA256,
    proofBodyBase64: asset.proofBytes.toString('base64') });
  return sha256(bytes);
}

function validAsset(asset) {
  if (!asset?.identity || !Buffer.isBuffer(asset.proofBytes)
      || sha256(asset.proofBytes) !== asset.identity.proofBodySHA256
      || !Number.isSafeInteger(asset.identity.proofRevision) || asset.identity.proofRevision < 1) return false;
  try {
    const proof = validatedPublicationProof(asset);
    return proof.publication.sha256 === asset.identity.publicationSHA256 && isDeepStrictEqual(asset.proof,JSON.parse(asset.proofBytes.toString('utf8')));
  } catch { return false; }
}

function sourceScopes(asset) {
  const scopes = [];
  for (const entry of asset.proof.entries) {
    if (entry.status !== 'qualified') continue;
    const selected = selectedTimetableEntry(asset, { lineID: entry.lineID, stationID: entry.stationID });
    for (const { direction, profiles } of selected.sets) {
      const evidence = direction === null ? null
        : entry.directionalSourceEvidence?.find(value => value.direction === direction);
      scopes.push({
        lineID: entry.lineID,
        stationID: entry.stationID,
        direction,
        profiles,
        operatingStartDate: evidence?.operatingStartDate ?? entry.operatingStartDate,
        operatingEndDate: evidence?.operatingEndDate ?? entry.operatingEndDate,
        originatingDateGaps: evidence?.originatingDateGaps ?? entry.originatingDateGaps ?? []
      });
    }
  }
  return scopes;
}

function serviceDateCoverage(asset, scope) {
  const startDate = scope.operatingStartDate > asset.proof.holidayCoverageStart
    ? scope.operatingStartDate : asset.proof.holidayCoverageStart;
  const endDate = scope.operatingEndDate < asset.proof.holidayCoverageEnd
    ? scope.operatingEndDate : asset.proof.holidayCoverageEnd;
  const start = Date.parse(`${startDate}T12:00:00Z`);
  const end = Date.parse(`${endDate}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end
      || Math.floor((end - start) / 86_400_000) + 1 > MAX_COVERAGE_DAYS) {
    throw fail('coverage-window-invalid');
  }
  const holidays = new Set(asset.proof.bankHolidayDates);
  const gaps = new Set(scope.originatingDateGaps.map(value => value.serviceDate));
  const covered = new Set();
  for (let timestamp = start; timestamp <= end; timestamp += 86_400_000) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (holidays.has(date) || gaps.has(date)) continue;
    const weekday = new Date(timestamp).getUTCDay() + 1;
    if (scope.profiles.some(profile => profile.weekdays.includes(weekday)
        && (profile.originatingServiceDateRanges === undefined
          || profile.originatingServiceDateRanges.some(range => range.startDate <= date && date <= range.endDate)))) {
      covered.add(date);
    }
  }
  return covered;
}

export function hasPreservedPublicationCoverage(previousAsset, candidateAsset, { fromDate = '0000-01-01' } = {}) {
  const candidates = new Map(candidateAsset.proof.entries.map(entry => [`${entry.lineID}\u0000${entry.stationID}`, entry]));
  for (const previous of sourceScopes(previousAsset)) {
    const candidateEntry = candidates.get(`${previous.lineID}\u0000${previous.stationID}`);
    if (!candidateEntry || candidateEntry.status !== 'qualified') return false;
    const candidate = sourceScopes({ ...candidateAsset, proof: { ...candidateAsset.proof,
      entries: [candidateEntry] } }).find(scope => scope.direction === previous.direction);
    // Direction changes are fail-closed. A null/default source and explicit
    // inbound/outbound sources are not treated as interchangeable.
    if (!candidate) return false;
    const oldDates = serviceDateCoverage(previousAsset, previous);
    const newDates = serviceDateCoverage(candidateAsset, candidate);
    for (const date of oldDates) if (date >= fromDate && !newDates.has(date)) return false;
  }
  return true;
}

// New editions preserve station/direction authority, not superseded future dates.
export function hasPreservedRequiredScopes(previousAsset,candidateAsset) {
  const candidates=sourceScopes(candidateAsset);
  return sourceScopes(previousAsset).every(previous=>candidates.some(candidate=>
    candidate.lineID===previous.lineID && candidate.stationID===previous.stationID && candidate.direction===previous.direction));
}

export function expectedComparisonSourceCount(asset) {
  return sourceScopes(asset).length;
}

export function hasCompleteComparisonArchive(asset, index) {
  const { publicationSHA256, proofBodySHA256 } = asset.identity;
  if (!index || index.isUnavailable(publicationSHA256, proofBodySHA256)) return false;
  const scopes = sourceScopes(asset);
  if (!scopes.length) return false;
  for (const scope of scopes) {
    const entry = asset.proof.entries.find(value => value.lineID === scope.lineID && value.stationID === scope.stationID);
    const directionalEvidence = scope.direction === null ? null
      : entry?.directionalSourceEvidence?.find(value => value.direction === scope.direction);
    const bodySHA256 = scope.direction === null ? entry?.apiBodySHA256 : directionalEvidence?.apiBodySHA256;
    if (!validSHA(bodySHA256) || !index.get(sourceKey({ ...asset.identity, ...scope, bodySHA256 }))) return false;
  }
  return true;
}

function admissionPreconditions({ previousAsset, candidateAsset,
  officialObservation, admissionRevision, ifMatchPreviousResourceSHA256, now }, additive = false) {
  const identity = candidateAsset?.identity;
  const previousIdentity = previousAsset?.identity;
  const reject = reason => ({ eligible: false, reason });
  if (!validAsset(previousAsset) || !validAsset(candidateAsset)
      || !identity || !previousIdentity || !validSHA(identity.publicationSHA256)
      || !validSHA(identity.proofBodySHA256) || !Number.isSafeInteger(identity.proofRevision)
      || !validSHA(previousIdentity.publicationSHA256)) return reject('proof-identity-invalid');
  if (additive) {
    if (identity.publicationSHA256 !== previousIdentity.publicationSHA256) return reject('additive-edition-mismatch');
    if (previousIdentity.proofRevision === Number.MAX_SAFE_INTEGER
        || identity.proofRevision !== previousIdentity.proofRevision + 1) return reject('additive-proof-revision-invalid');
  } else {
    if (identity.publicationSHA256 === previousIdentity.publicationSHA256) return reject('same-edition-not-admissible');
    if (identity.proofRevision !== 1) return reject('new-edition-must-start-at-revision-one');
  }
  const previousResourceSHA256 = publicationResourceSHA256(previousAsset);
  if (!validSHA(ifMatchPreviousResourceSHA256) || ifMatchPreviousResourceSHA256 !== previousResourceSHA256) {
    return reject('previous-publication-precondition-failed');
  }
  if (!Number.isSafeInteger(admissionRevision) || admissionRevision < 0
      || admissionRevision === Number.MAX_SAFE_INTEGER || !Number.isFinite(now)) return reject('admission-revision-invalid');
  const observedAt = Date.parse(officialObservation?.observedAt ?? '');
  const expiresAt = Date.parse(officialObservation?.expiresAt ?? '');
  if (officialObservation?.schemaVersion !== 1 || officialObservation.source !== TIMETABLE_PUBLICATION_URL
      || officialObservation.publicationSHA256 !== identity.publicationSHA256
      || !Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
      || observedAt > now || now >= expiresAt || expiresAt - observedAt > 600_000) {
    return reject('official-edition-observation-stale-or-mismatched');
  }
  return { identity, previousIdentity, previousResourceSHA256 };
}

function admissionResult(context, candidateAsset, admissionRevision, reason) {
  const { identity, previousIdentity, previousResourceSHA256 } = context;
  return {
    eligible: true, reason, admissionRevision: admissionRevision + 1,
    previousPublicationSHA256: previousIdentity.publicationSHA256, previousResourceSHA256,
    publicationSHA256: identity.publicationSHA256, proofRevision: identity.proofRevision,
    proofBodySHA256: identity.proofBodySHA256, resourceSHA256: publicationResourceSHA256(candidateAsset),
    comparisonSourceCount: expectedComparisonSourceCount(candidateAsset), activatesPublication: false
  };
}

export function evaluateNewEditionAdmission(input) {
  const { previousAsset, candidateAsset, comparisonIndex, admissionRevision, now = Date.now() } = input;
  const context = admissionPreconditions({ ...input, now });
  if (context.eligible === false) return context;
  const reject = reason => ({ eligible: false, reason });
  try {
    if (!hasPreservedRequiredScopes(previousAsset,candidateAsset)) return reject('previous-station-or-direction-coverage-reduced');
    if (!hasCompleteComparisonArchive(candidateAsset, comparisonIndex)) return reject('comparison-archive-incomplete');
    const assessment=assessCurrentPublicationCoverage({asset:candidateAsset,comparisonIndex,at:now});
    if(!assessment.valid || assessment.unresolvedScopes.length) return reject('current-service-day-coverage-incomplete');
  } catch (error) {
    return reject(typeof error?.admissionReason === 'string' ? error.admissionReason : 'candidate-proof-invalid');
  }
  return admissionResult(context, candidateAsset, admissionRevision, 'new-edition-package-complete');
}

// Same-edition recovery may add evidence, never reinterpret an already
// qualified station. This pure decision does not publish or activate anything.
export function evaluateAdditiveRevisionAdmission(input) {
  const { previousAsset, candidateAsset, comparisonIndex, admissionRevision, now = Date.now() } = input;
  const context = admissionPreconditions({ ...input, now }, true);
  if (context.eligible === false) return context;
  const reject = reason => ({ eligible: false, reason });
  try {
    const previous = previousAsset.proof, candidate = candidateAsset.proof;
    const semantics = proof => {
      const { entries, coverage, ...globals } = proof;
      const { capturedAt, ...publication } = globals.publication;
      return { ...globals, publication };
    };
    if (!isDeepStrictEqual(semantics(previous), semantics(candidate))) {
      return reject('previous-qualification-semantics-changed');
    }
    const key = entry => `${entry.lineID}\u0000${entry.stationID}`;
    const candidates = new Map(candidate.entries.map(entry => [key(entry), entry]));
    for (const entry of previous.entries) {
      const next = candidates.get(key(entry));
      if (!next) return reject('previous-entry-removed');
      if (!isDeepStrictEqual(entry, next) && (entry.status === 'qualified' || next.status !== 'qualified')) {
        return reject('previous-entry-overwritten');
      }
    }
    if (!hasPreservedPublicationCoverage(previousAsset, candidateAsset)) {
      return reject('previous-date-or-direction-coverage-reduced');
    }
    if (!hasCompleteComparisonArchive(candidateAsset, comparisonIndex)) return reject('comparison-archive-incomplete');
    const newlyQualified=candidate.entries.filter(entry=>entry.status==='qualified' &&
      previous.entries.find(old=>key(old)===key(entry))?.status!=='qualified').map(entry=>`${entry.lineID}/${entry.stationID}`);
    if(newlyQualified.length){
      const assessment=assessCurrentPublicationCoverage({asset:candidateAsset,comparisonIndex,at:now});
      if(!assessment.valid || newlyQualified.some(scope=>!assessment.coveredScopes.includes(scope)))return reject('new-scope-current-service-day-coverage-incomplete');
    }
  } catch (error) {
    return reject(typeof error?.admissionReason === 'string' ? error.admissionReason : 'candidate-proof-invalid');
  }
  return admissionResult(context, candidateAsset, admissionRevision, 'additive-revision-package-complete');
}
