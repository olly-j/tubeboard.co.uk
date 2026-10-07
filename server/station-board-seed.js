import { validProofIdentity } from './station-board-publication.js';
import { validAvailability, qualifiedAvailability, retainedEligibility } from './station-board-availability.js';
import { STATION_BOARD_STATIONS, validBoard, londonClock, londonLocal } from './station-board-v2.js';
export const TIMETABLE_PUBLICATION_URL = 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip';
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const iso = (value) => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? londonClock(value) : NaN;
export const dateKey = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const nameKey = (value) => String(value || '').toLowerCase().replace(/ (underground|rail|dlr) station/g, '').replace(/\s*\([^)]*\)/g, '').trim();
const allowed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((field) => fields.includes(field));

export function validOriginatingRanges(ranges, publication, serviceDay) {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 32) return false;
  let previousEnd = null;
  for (const range of ranges) {
    if (!allowed(range, ['startDate', 'endDate']) || !dateKey(range.startDate) || !dateKey(range.endDate)
      || range.startDate > range.endDate || range.startDate < publication.operatingStartDate
      || range.endDate > publication.operatingEndDate || (previousEnd !== null && previousEnd >= range.startDate)) return false;
    previousEnd = range.endDate;
  }
  return ranges.some((range) => range.startDate <= serviceDay && serviceDay <= range.endDate);
}

export function profilesOverlap(left, right, publication) {
  const weekdays = left.weekdays.filter((day) => right.weekdays.includes(day));
  if (!weekdays.length) return false;
  const legacy = [{ startDate: publication.operatingStartDate, endDate: publication.operatingEndDate }];
  for (const a of left.originatingServiceDateRanges ?? legacy) {
    for (const b of right.originatingServiceDateRanges ?? legacy) {
      const start = a.startDate > b.startDate ? a.startDate : b.startDate, end = a.endDate < b.endDate ? a.endDate : b.endDate;
      if (start > end) continue;
      const first = Date.parse(`${start}T12:00:00Z`), last = Date.parse(`${end}T12:00:00Z`);
      for (let offset = 0; offset < 7 && first + offset * 86400000 <= last; offset += 1) {
        if (weekdays.includes(new Date(first + offset * 86400000).getUTCDay() + 1)) return true;
      }
    }
  }
  return false;
}

// This is carry-forward client qualification, not server proof of a profile.
// An admitted refresh attempts independent official publication identity checks.
// Unavailable checks never renew the original client-qualified context.
export function admitPlannedSeed(seed, record, now) {
  const errors = [], sources = {}, closureSources = {}, availabilityProofs = [];
  if (seed === undefined) return { errors, sources, closureSources, availabilityProofs };
  if (!allowed(seed, ['schemaVersion', 'stationID', 'lineID', 'contexts', 'closureEvidence']) || seed.schemaVersion !== 1 || seed.stationID !== record.stationID || seed.lineID !== record.lineID || !validBoard(seed.stationID, seed.lineID) || Buffer.byteLength(JSON.stringify(seed)) > 24576 || !Array.isArray(seed.contexts) || seed.contexts.length > 2) return { errors: ['plannedContextSeed is invalid'], sources };
  if (seed.closureEvidence !== undefined) {
    if (!Array.isArray(seed.closureEvidence) || seed.closureEvidence.length > 8) errors.push('planned seed closure evidence is invalid');
    else for (const check of seed.closureEvidence) {
      if (!allowed(check, ['stationID', 'lineID', 'sourceScope', 'closed', 'observedAt', 'expiresAt', 'validFrom', 'validUntil', 'closureWindows', 'plannedUnavailable', 'scheduledClockOnly'])) { errors.push('planned seed closure scope is invalid'); continue; }
      const proof = { ...check, observedAt: iso(check.observedAt), expiresAt: iso(check.expiresAt), qualificationOrigin: 'client' };
      if (check.validFrom !== undefined) proof.validFrom = iso(check.validFrom);
      if (check.validUntil !== undefined) proof.validUntil = iso(check.validUntil);
      if (check.closureWindows !== undefined) {
        if (!Array.isArray(check.closureWindows) || check.closureWindows.length > 32 || check.closureWindows.some((w) => !allowed(w, ['validFrom', 'validUntil']))) { errors.push('planned seed closure windows are invalid'); continue; }
        proof.closureWindows = check.closureWindows.map((w) => ({ validFrom: iso(w.validFrom), validUntil: iso(w.validUntil) }));
      }
      if (!validAvailability(proof, record) || proof.observedAt > now) { errors.push('planned seed closure clock or scope is invalid'); continue; }
      if (qualifiedAvailability(proof, now) || retainedEligibility(proof, now)) availabilityProofs.push(proof);
    }
  }

  const seenSources = new Set();
  for (const context of seed.contexts) {
    if (!allowed(context, ['sourceID', 'observedAt', 'expiresAt', 'sourceSHA256', 'publication', 'rows', 'publicationProofIdentity', 'independentPublicationObservedAt', 'publicationDirections']) || !['timetable', 'unified-timetable', 'journey-planner'].includes(context.sourceID)) { errors.push('planned seed source is invalid'); continue; }
    if (context.sourceSHA256 != null && !digest(context.sourceSHA256)) { errors.push('planned seed response fingerprint is invalid'); continue; }
    const normalized = context.sourceID === 'unified-timetable' ? 'timetable' : context.sourceID;
    if (seenSources.has(normalized)) { errors.push('planned seed source is duplicated'); continue; } seenSources.add(normalized);
    const observedAt = iso(context.observedAt), expiresAt = iso(context.expiresAt), lifetime = normalized === 'timetable' ? 600000 : 120000;
    if (!Number.isFinite(observedAt) || observedAt > now || !Number.isFinite(expiresAt) || expiresAt <= observedAt || expiresAt > observedAt + lifetime || !Array.isArray(context.rows) || context.rows.length > 32) { errors.push('planned seed clock or rows are invalid'); continue; }
    const publication = context.publication;
    if (normalized === 'timetable') {
      if (!allowed(publication, ['url', 'sha256', 'timezone', 'operatingStartDate', 'operatingEndDate', 'holidayCoverageStart', 'holidayCoverageEnd', 'nonOperationBankHolidays']) || publication.url !== TIMETABLE_PUBLICATION_URL || !digest(publication.sha256) || publication.timezone !== 'Europe/London' || publication.nonOperationBankHolidays !== true || !['operatingStartDate', 'operatingEndDate', 'holidayCoverageStart', 'holidayCoverageEnd'].every((field) => dateKey(publication[field])) || publication.operatingStartDate > publication.operatingEndDate || publication.holidayCoverageStart > publication.holidayCoverageEnd) { errors.push('planned seed publication/calendar is invalid'); continue; }
    } else if (publication !== undefined || !digest(context.sourceSHA256)) { errors.push('planner seed response evidence is invalid'); continue; }
    const hasReference = context.publicationProofIdentity !== undefined, hasIndependent = context.independentPublicationObservedAt !== undefined;
    const independentPublicationObservedAt = hasIndependent ? iso(context.independentPublicationObservedAt) : null;
    if (hasReference !== hasIndependent || (hasReference && (normalized !== 'timetable' || record.timetablePublicationAuthorityVersion !== 1
      || !validProofIdentity(context.publicationProofIdentity) || context.publicationProofIdentity.publicationSHA256 !== publication.sha256
      || !Number.isFinite(independentPublicationObservedAt) || independentPublicationObservedAt < observedAt || independentPublicationObservedAt > now))) {
      errors.push('planned seed publication reference is invalid'); continue;
    }
    const scopes = context.publicationDirections;
    if (scopes !== undefined && (normalized !== 'timetable' || !hasReference || !Array.isArray(scopes) || !scopes.length || scopes.length > 2
      || new Set(scopes).size !== scopes.length || scopes.some(v => !['inbound','outbound'].includes(v)))) { errors.push('planned seed direction scope is invalid'); continue; }
    if (context.rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
      errors.push('planned seed row is invalid'); continue;
    }
    if (context.rows.some(row => row.publicationDirection !== undefined && (!scopes?.includes(row.publicationDirection)
      || String(row.providerDirection || '').toLowerCase() !== row.publicationDirection) || scopes !== undefined && row.publicationDirection === undefined)) {
      errors.push('planned seed direction row is invalid'); continue;
    }
    // Expired transport is a no-op, never a token-registration failure/renewal.
    if (expiresAt <= now) continue;
    const today = londonLocal(now).slice(0, 10), nextDay = new Date(`${today}T12:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (expiresAt > londonClock(`${nextDay.toISOString().slice(0, 10)}T00:00:00`)) { errors.push('planned seed crosses current calendar expiry'); continue; }
    const events = [], rowEvidence = [], seenRows = new Set(), profiles = new Map(), profileDefinitions = new Map();
    for (const row of context.rows) {
      const permitted = ['id', 'destinationID', 'destination', 'departure', 'via', 'providerDirection', 'routeStationIDs', 'serviceDay', 'profileName', 'profileSHA256', 'weekdays', 'serviceMinute', 'isBankHoliday', 'originatingServiceDateRanges', 'publicationDirection'];
      if (!allowed(row, permitted) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 256 || seenRows.has(row.id) || !validBoard(row.destinationID, record.lineID) || (row.destinationID === record.stationID && (normalized !== 'timetable' || !Array.isArray(row.routeStationIDs) || !row.routeStationIDs.slice(0,-1).some(id => id !== record.stationID && validBoard(id, record.lineID)))) || nameKey(row.destination) !== nameKey(STATION_BOARD_STATIONS.get(row.destinationID)?.stationName) || !Array.isArray(row.routeStationIDs) || !row.routeStationIDs.length || row.routeStationIDs.length > 200 || (normalized === 'timetable' && row.routeStationIDs.at(-1) !== row.destinationID) || row.routeStationIDs.some((id) => !validBoard(id, record.lineID)) || (row.via != null && (typeof row.via !== 'string' || row.via.length > 120)) || (row.providerDirection != null && (typeof row.providerDirection !== 'string' || !row.providerDirection.trim() || row.providerDirection.length > 64))) { errors.push('planned seed row is invalid'); continue; }
      if (row.via != null) {
        const viaKey = nameKey(row.via) === 'cx' ? 'charing cross' : nameKey(row.via);
        const stations = [...STATION_BOARD_STATIONS.values()].filter((station) => station.lineIDs.includes(record.lineID) && nameKey(station.stationName) === viaKey);
        if (stations.length !== 1 || (normalized === 'timetable' && !row.routeStationIDs.includes(stations[0].stationID))) { errors.push('planned seed via is unsupported by its ordered calls'); continue; }
      }
      if (normalized === 'timetable') {
        const bank = row.routeStationIDs.includes('940GZZLUBNK'), cross = row.routeStationIDs.includes('940GZZLUCHX');
        const circleReturn = record.lineID === 'circle' && row.destinationID === record.stationID;
        const onwardID = circleReturn ? row.routeStationIDs.slice(0,-1).find(id => id !== record.stationID) : null;
        const circleVia = circleReturn ? STATION_BOARD_STATIONS.get(onwardID)?.stationName : null;
        // Older Circle seeds may omit via; any present value must be the exact
        // first distinct known onward call, never a route identity or terminus.
        if ((record.lineID === 'northern' && ((bank && cross) || nameKey(row.via) !== (bank ? 'bank' : cross ? 'charing cross' : '')))
          || (record.lineID !== 'northern' && row.via != null && (!circleReturn || row.via !== circleVia))) { errors.push('planned seed full-timetable route/via conflicts'); continue; }
      }
      if (normalized !== 'timetable' && row.originatingServiceDateRanges !== undefined) { errors.push('planner seed cannot carry timetable date ranges'); continue; }
      seenRows.add(row.id); const departure = iso(row.departure);
      if (!Number.isFinite(departure)) { errors.push('planned seed departure is invalid'); continue; }
      if (normalized === 'timetable') {
        if (!dateKey(row.serviceDay) || !row.id.startsWith(`schedule:${record.lineID}:${record.stationID}:${row.serviceDay}:`) || typeof row.profileName !== 'string' || !row.profileName.trim() || row.profileName.length > 240 || !digest(row.profileSHA256) || !Array.isArray(row.weekdays) || !row.weekdays.length || new Set(row.weekdays).size !== row.weekdays.length || row.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) || row.isBankHoliday !== false || !Number.isInteger(row.serviceMinute) || row.serviceMinute < 0 || row.serviceMinute >= 2880 || row.serviceDay < publication.operatingStartDate || row.serviceDay > publication.operatingEndDate || row.serviceDay < publication.holidayCoverageStart || row.serviceDay > publication.holidayCoverageEnd) { errors.push('planned seed originating calendar/profile is invalid'); continue; }
        if (row.originatingServiceDateRanges !== undefined && !validOriginatingRanges(row.originatingServiceDateRanges, publication, row.serviceDay)) { errors.push('planned seed originating date ranges are invalid'); continue; }
        const definition = { publicationDirection: row.publicationDirection ?? null, profileName: row.profileName, profileSHA256: row.profileSHA256, weekdays: [...row.weekdays].sort(), originatingServiceDateRanges: row.originatingServiceDateRanges?.map((range) => ({ startDate: range.startDate, endDate: range.endDate })) };
        const profile = JSON.stringify(definition);
        if ([...profileDefinitions.entries()].some(([identity, other]) => identity !== profile && definition.publicationDirection === other.publicationDirection && profilesOverlap(definition, other, publication))) { errors.push('planned seed profile/date ranges are ambiguous'); continue; }
        profileDefinitions.set(profile, definition);
        const scopedDay = `${row.publicationDirection ?? ''}:${row.serviceDay}`;
        if ((profiles.has(scopedDay) && profiles.get(scopedDay) !== profile) || londonLocal(departure).slice(0, 10) !== today) { errors.push('planned seed profile/day is ambiguous'); continue; }
        profiles.set(scopedDay, profile);
        const service = new Date(`${row.serviceDay}T12:00:00Z`), weekday = service.getUTCDay() + 1;
        service.setUTCDate(service.getUTCDate() + Math.floor(row.serviceMinute / 1440));
        const minute = row.serviceMinute % 1440, expected = londonClock(`${service.toISOString().slice(0, 10)}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`);
        if (!row.weekdays.includes(weekday) || !Number.isFinite(expected) || expected !== departure || ![today, new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)].includes(row.serviceDay)) { errors.push('planned seed service-day clock is invalid'); continue; }
        rowEvidence.push({ ...(row.publicationDirection === undefined ? {} : { publicationDirection: row.publicationDirection }), id: row.id, serviceDay: row.serviceDay, profileName: row.profileName, profileSHA256: row.profileSHA256, weekdays: row.weekdays, serviceMinute: row.serviceMinute, isBankHoliday: false, ...(row.originatingServiceDateRanges === undefined ? {} : { originatingServiceDateRanges: row.originatingServiceDateRanges }) });
      }
      if (departure < now) continue;
      events.push({ id: row.id, stationID: record.stationID, lineID: record.lineID, sourceID: context.sourceID, kind: 'outgoingDeparture', timeEvidence: 'scheduledDeparture', destination: row.destination, destinationStationID: row.destinationID, via: row.via || null, routeStationIDs: row.routeStationIDs, time: departure, platform: null, direction: null, providerDirection: row.providerDirection || null, receivedAt: observedAt, expiresAt });
    }
    if (events.length) sources[normalized] = { observedAt, events, qualificationOrigin: 'client', evidence: { publication: publication || null, sourceSHA256: context.sourceSHA256 || null, rows: rowEvidence,
      ...(hasReference ? { publicationProofIdentity: structuredClone(context.publicationProofIdentity), independentPublicationObservedAt, ...(scopes === undefined ? {} : { publicationDirections: [...scopes] }) } : {}) } };
  }
  return { errors, sources, closureSources, availabilityProofs };
}
