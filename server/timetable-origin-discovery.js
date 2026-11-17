// Validate the Python producer's bounded inventory. XML/calendar discovery stays
// in the reviewed parser; this module never qualifies a departure.
import { londonLocal, validBoard } from './station-board-v2.js';

export const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const codes = new Set(['uncatalogued-passenger-origin', 'unqualified-xml-member',
  'unqualified-xml-row', 'missing-xml-line', 'required-scope-overflow',
  'inventory-overflow', 'holiday-authority-unavailable']);
const invalid = () => new Error('Invalid timetable origin discovery');
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...names].sort().join('\0');
const clock = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));
const scope = value => typeof value === 'string' && /^[a-z0-9-]{1,64}\/[A-Z0-9]{1,32}$/.test(value)
  && validBoard(value.split('/')[1], value.split('/')[0]);
const sorted = values => Array.isArray(values) && values.length <= 8192
  && values.every((value, index) => scope(value) && (!index || values[index - 1] < value));
export const DISCOVERY_BINDINGS = ['archiveSHA256', 'sourceMetadataSHA256', 'sourceReceiptSHA256',
  'producerSHA256', 'parserSHA256', 'catalogueSHA256'];

export function validateOriginDiscovery(value, { publicationSHA256, at, bindings } = {}) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_DISCOVERY_BYTES
      || !exact(value, ['schemaVersion', 'kind', 'publicationSHA256', 'assessedAt', 'serviceDay', 'validUntil',
        'discoveryStatus', 'eligibleScopesComplete', 'requiredScopesComplete', 'eligibleScopes', 'requiredScopes',
        'unresolvedPublicSourceGaps', 'inputs', 'reuseRequirements', 'counts'])
      || value.schemaVersion !== 1 || value.kind !== 'tubeboard-runtime-origin-discovery-v1'
      || !SHA.test(value.publicationSHA256) || publicationSHA256 && value.publicationSHA256 !== publicationSHA256
      || !clock(value.assessedAt) || !clock(value.validUntil)
      || Date.parse(value.validUntil) <= Date.parse(value.assessedAt)
      || value.serviceDay !== londonLocal(Date.parse(value.assessedAt)).slice(0, 10)
      || londonLocal(Date.parse(value.validUntil) - 1).slice(0, 10) !== value.serviceDay
      || !['complete', 'incomplete'].includes(value.discoveryStatus)
      || typeof value.eligibleScopesComplete !== 'boolean' || typeof value.requiredScopesComplete !== 'boolean'
      || !sorted(value.eligibleScopes) || !sorted(value.requiredScopes) || value.requiredScopes.length > 256
      || value.requiredScopes.some(item => !value.eligibleScopes.includes(item))) throw invalid();
  const gaps = value.unresolvedPublicSourceGaps;
  if (!Array.isArray(gaps) || gaps.length > 8192 || gaps.some(gap =>
    !exact(gap, ['code', 'lineID', 'stationID', 'affectsCurrentCoverage']) || !codes.has(gap.code)
    || !(gap.lineID === null || typeof gap.lineID === 'string' && /^[^\u0000-\u001f\u007f]{1,128}$/.test(gap.lineID))
    || !(gap.stationID === null || typeof gap.stationID === 'string' && /^[^\u0000-\u001f\u007f]{1,128}$/.test(gap.stationID))
    || typeof gap.affectsCurrentCoverage !== 'boolean')) throw invalid();
  const incomplete = !value.eligibleScopesComplete || !value.requiredScopesComplete
    || gaps.some(gap => gap.affectsCurrentCoverage);
  const unavailable = gaps.some(gap => gap.code === 'unqualified-xml-member'
    && gap.lineID === null && gap.stationID === null && gap.affectsCurrentCoverage);
  const inventoryOverflow = gaps.some(gap => gap.code === 'inventory-overflow' && gap.affectsCurrentCoverage);
  const requiredOverflow = gaps.some(gap => gap.code === 'required-scope-overflow' && gap.affectsCurrentCoverage);
  if ((value.discoveryStatus === 'incomplete') !== incomplete
      || !value.eligibleScopesComplete && (value.eligibleScopes.length || !(unavailable || inventoryOverflow))
      || !value.requiredScopesComplete && (value.requiredScopes.length || !(unavailable || inventoryOverflow || requiredOverflow))
      || !value.eligibleScopesComplete && value.requiredScopesComplete
      || !exact(value.counts, ['eligible', 'required', 'uncatalogued'])
      || Object.values(value.counts).some(count => !Number.isSafeInteger(count) || count < 0)
      || value.counts.required > value.counts.eligible
      || value.counts.required > 256 && (value.requiredScopesComplete || value.requiredScopes.length
        || !(requiredOverflow || inventoryOverflow))
      || value.counts.eligible < value.eligibleScopes.length || value.counts.required < value.requiredScopes.length
      || value.eligibleScopesComplete && value.counts.eligible !== value.eligibleScopes.length
      || value.requiredScopesComplete && value.counts.required !== value.requiredScopes.length
      || value.counts.eligible !== value.eligibleScopes.length && !gaps.some(gap => gap.code === 'inventory-overflow')
      || value.counts.required !== value.requiredScopes.length
        && !gaps.some(gap => ['required-scope-overflow', 'inventory-overflow'].includes(gap.code))) throw invalid();
  const inputs = value.inputs;
  if (!exact(inputs, [...DISCOVERY_BINDINGS, 'holidayBodySHA256', 'holidayReceivedAt', 'holidayExpiresAt',
    'originalAcquisition', 'officialObservation'])
      || [...DISCOVERY_BINDINGS, 'holidayBodySHA256'].some(name => !SHA.test(inputs[name]))
      || inputs.archiveSHA256 !== value.publicationSHA256
      || !clock(inputs.holidayReceivedAt) || !clock(inputs.holidayExpiresAt)
      || Date.parse(inputs.holidayReceivedAt) > Date.parse(value.assessedAt)
      || Date.parse(inputs.holidayExpiresAt) < Date.parse(value.validUntil)
      || !exact(inputs.originalAcquisition, ['startedAt', 'receivedAt'])
      || !clock(inputs.originalAcquisition.startedAt) || !clock(inputs.originalAcquisition.receivedAt)
      || Date.parse(inputs.originalAcquisition.startedAt) > Date.parse(inputs.originalAcquisition.receivedAt)
      || Date.parse(inputs.originalAcquisition.receivedAt) > Date.parse(value.assessedAt)
      || !exact(inputs.officialObservation, ['publicationSHA256', 'observedAt', 'expiresAt'])
      || inputs.officialObservation.publicationSHA256 !== value.publicationSHA256
      || !clock(inputs.officialObservation.observedAt) || !clock(inputs.officialObservation.expiresAt)
      || Date.parse(inputs.officialObservation.observedAt) > Date.parse(value.assessedAt)
      || Date.parse(inputs.officialObservation.expiresAt) <= Date.parse(value.assessedAt)
      || !exact(value.reuseRequirements, ['freshSameEditionObservation', 'unchangedParserCatalogueHoliday', 'monotonicAssessment'])
      || Object.values(value.reuseRequirements).some(item => item !== true)
      || bindings && DISCOVERY_BINDINGS.some(name => inputs[name] !== bindings[name])) throw invalid();
  if (at !== undefined && (!Number.isSafeInteger(at) || at < Date.parse(value.assessedAt)
      || at >= Date.parse(value.validUntil) || londonLocal(at).slice(0, 10) !== value.serviceDay)) throw invalid();
  return value;
}
