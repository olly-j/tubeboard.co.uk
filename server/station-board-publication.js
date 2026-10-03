// Negative metadata authority only. This module never creates/renews train rows.
import crypto from 'node:crypto';
export const BUNDLED_PUBLICATION_REFERENCE = Object.freeze({ publicationSHA256: 'd787080486dfd535a814afcc6abbd10fb8deaea6aa39c869b02b7efb3499380c', proofRevision: 0, proofBodySHA256: '1ffffbe1390032650d071c8f56bcba73a2edd8eda15b92c3bbc18060c0ffcdb4' });
export const validPublicationSHA = (s) => typeof s === 'string' && s.length === 64 && /^[0-9a-f]{64}$/.test(s);
export function validProofIdentity(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === 'proofBodySHA256,proofRevision,publicationSHA256'
    && validPublicationSHA(v.publicationSHA256) && validPublicationSHA(v.proofBodySHA256) && Number.isSafeInteger(v.proofRevision) && v.proofRevision >= 0;
}
// Persisted malformed authority is unavailable, never an implicit empty/open
// state. Only original validated negative metadata can survive store reload.
export function normalizedPublicationAuthority(value) {
  if (value === undefined) return {};
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, allowed) => Object.keys(v).every(k => allowed.includes(k));
  if (!object(value) || !keys(value, ['officialIdentity','rejectedThrough','revisions','overflow'])
    || (value.overflow !== undefined && typeof value.overflow !== 'boolean')
    || (value.rejectedThrough !== undefined && !Number.isFinite(value.rejectedThrough))) return { overflow: true };
  const head = value.officialIdentity;
  if (head !== undefined && (!object(head) || !keys(head,['sha256','observedAt','conflict'])
    || !validPublicationSHA(head.sha256) || !Number.isFinite(head.observedAt)
    || (head.conflict !== undefined && typeof head.conflict !== 'boolean'))) return { overflow: true };
  const revisions = value.revisions;
  if (revisions !== undefined && (!Array.isArray(revisions) || revisions.length > 32
    || revisions.some(r => !object(r) || !keys(r,['identity','conflict']) || !validProofIdentity(r.identity)
      || r.identity.proofRevision < 1 || (r.conflict !== undefined && typeof r.conflict !== 'boolean'))
    || new Set(revisions.map(r => r.identity.publicationSHA256)).size !== revisions.length)) return { overflow: true };
  return structuredClone(value);
}
function canonical(v) { return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v); }
export const publicationGeneration = (state) => crypto.createHash('sha256').update(canonical(state || {})).digest('hex');
export function observePublication(previous = {}, input) {
  const state = structuredClone(previous), old = state.officialIdentity;
  if (!input || !validPublicationSHA(input.sha256) || !Number.isFinite(input.observedAt)) return state;
  if (old && input.observedAt < old.observedAt) return state;
  if (old && input.observedAt === old.observedAt) {
    if (input.sha256 !== old.sha256 || input.conflict) {
      state.officialIdentity.conflict = true;
      state.rejectedThrough = Math.max(state.rejectedThrough ?? -Infinity, input.observedAt);
    }
    return state;
  }
  if (old && (old.sha256 !== input.sha256 || old.conflict)) state.rejectedThrough = Math.max(state.rejectedThrough ?? -Infinity, input.observedAt);
  state.officialIdentity = { sha256: input.sha256, observedAt: input.observedAt, ...(input.conflict ? { conflict: true } : {}) };
  return state;
}
export function observeRevision(previous = {}, identity) {
  const state = structuredClone(previous);
  if (!validProofIdentity(identity) || identity.proofRevision < 1) return state;
  const revisions = state.revisions || [], index = revisions.findIndex(v => v.identity.publicationSHA256 === identity.publicationSHA256), old = revisions[index];
  if (old && identity.proofRevision < old.identity.proofRevision) return state;
  if (old && identity.proofRevision === old.identity.proofRevision) {
    if (old.identity.proofBodySHA256 !== identity.proofBodySHA256) revisions[index].conflict = true;
  } else if (index >= 0) revisions[index] = { identity: structuredClone(identity) };
  else if (revisions.length < 32) revisions.push({ identity: structuredClone(identity) });
  else state.overflow = true; // Never discard a negative authority to claim acceptance.
  state.revisions = revisions;
  return state;
}
export function allowsPublicationContext(context, authority = {}) {
  if (!context?.evidence?.publication) return false;
  const publication = context.evidence.publication, reference = context.evidence.publicationProofIdentity;
  const independent = context.evidence.independentPublicationObservedAt ?? context.observedAt;
  if (!Number.isFinite(independent) || authority.overflow) return false;
  const head = authority.officialIdentity;
  // An older original server HEAD cannot invalidate a newer original client
  // qualification; completion/row-min times never replace the original HEAD.
  if (head && head.observedAt >= independent && (head.conflict || head.sha256 !== publication.sha256)) return false;
  if (Number.isFinite(authority.rejectedThrough) && independent < authority.rejectedThrough) return false;
  const revision = authority.revisions?.find(v => v.identity.publicationSHA256 === publication.sha256);
  if (!reference) {
    if (!revision) return true; // Unchanged original legacy carry-forward only.
    return !revision.conflict && publication.sha256 === BUNDLED_PUBLICATION_REFERENCE.publicationSHA256
      && revision.identity.proofBodySHA256 === BUNDLED_PUBLICATION_REFERENCE.proofBodySHA256;
  }
  return validProofIdentity(reference) && reference.publicationSHA256 === publication.sha256
    && !!revision && !revision.conflict && reference.proofRevision <= revision.identity.proofRevision
    && reference.proofBodySHA256 === revision.identity.proofBodySHA256;
}
export function applyPublicationAuthority(cache = {}, authority = {}) {
  const value = structuredClone(cache), context = value.sources?.timetable;
  if (context && !allowsPublicationContext(context, authority)) delete value.sources.timetable;
  return value;
}

// Scoped seeds are still original client qualification, not independently
// server-qualified timetable. Match the exact reviewed body/declared complete
// directions and the original row's profile/date; never infer directional scope.
export function scopedSeedMatchesAsset(context, asset, record) {
  try { return matchesScopedSeed(context, asset, record); } catch { return false; }
}
function matchesScopedSeed(context, asset, record) {
  const scopes = context.publicationDirections;
  if (scopes === undefined) {
    if (context.rows.some(r => r.publicationDirection !== undefined)) return false;
    if (!asset) return context.publicationProofIdentity === undefined;
    const entries = asset.proof?.entries?.filter(e => e.lineID === record.lineID && e.stationID === record.stationID);
    if (entries?.length !== 1 || entries[0].status !== 'qualified' || entries[0].directionalDefinitions !== undefined
        || !Array.isArray(entries[0].profiles) || !entries[0].profiles.length) return false;
    return context.rows.every(row => {
      const profiles = entries[0].profiles.filter(p => p.name === row.profileName
        && Array.isArray(p.weekdays) && p.weekdays.includes(new Date(`${row.serviceDay}T12:00:00Z`).getUTCDay()+1)
        && (p.originatingServiceDateRanges === undefined || p.originatingServiceDateRanges.some(r => r.startDate <= row.serviceDay && row.serviceDay <= r.endDate)));
      return profiles.length === 1 && (profiles[0].publishedSHA256 ?? profiles[0].sha256) === row.profileSHA256;
    });
  }
  if (!asset || !validProofIdentity(context.publicationProofIdentity)
      || asset.identity.publicationSHA256 !== context.publicationProofIdentity.publicationSHA256
      || asset.identity.proofBodySHA256 !== context.publicationProofIdentity.proofBodySHA256
      || asset.identity.proofRevision < context.publicationProofIdentity.proofRevision) return false;
  const entries = asset.proof?.entries?.filter(e => e.lineID === record.lineID && e.stationID === record.stationID);
  if (entries?.length !== 1 || entries[0].status !== 'qualified' || entries[0].profiles?.length !== 0) return false;
  const definitions = entries[0].directionalDefinitions;
  if (!Array.isArray(definitions) || definitions.length !== scopes.length || definitions.length < 1 || definitions.length > 2
      || new Set(definitions.map(v => v.direction)).size !== definitions.length
      || definitions.some(v => Object.keys(v).sort().join(',') !== 'direction,profiles' || !scopes.includes(v.direction) || !Array.isArray(v.profiles))) return false;
  return context.rows.every(row => {
    const profiles = definitions.find(d => d.direction === row.publicationDirection)?.profiles.filter(p => p.name === row.profileName
      && Array.isArray(p.weekdays) && p.weekdays.includes(new Date(`${row.serviceDay}T12:00:00Z`).getUTCDay()+1)
      && (p.originatingServiceDateRanges === undefined || p.originatingServiceDateRanges.some(r => r.startDate <= row.serviceDay && row.serviceDay <= r.endDate)));
    return profiles?.length === 1 && (profiles[0].publishedSHA256 ?? profiles[0].sha256) === row.profileSHA256;
  });
}
