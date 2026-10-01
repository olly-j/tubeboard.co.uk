import { STATION_BOARD_STATIONS, validBoard, londonClock, londonLocal } from './station-board-v2.js';
export const TIMETABLE_PUBLICATION_URL = 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip';
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const iso = (value) => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? londonClock(value) : NaN;
const dateKey = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const nameKey = (value) => String(value || '').toLowerCase().replace(/ (underground|rail|dlr) station/g, '').replace(/\s*\([^)]*\)/g, '').trim();
const allowed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((field) => fields.includes(field));

// This is carry-forward client qualification, not server proof of a profile.
// An admitted refresh attempts independent official publication identity checks.
// Unavailable checks never renew the original client-qualified context.
export function admitPlannedSeed(seed, record, now) {
  const errors = [], sources = {}, closureSources = {};
  if (seed === undefined) return { errors, sources, closureSources };
  if (!allowed(seed, ['schemaVersion', 'stationID', 'lineID', 'contexts', 'closureEvidence']) || seed.schemaVersion !== 1 || seed.stationID !== record.stationID || seed.lineID !== record.lineID || !validBoard(seed.stationID, seed.lineID) || Buffer.byteLength(JSON.stringify(seed)) > 24576 || !Array.isArray(seed.contexts) || seed.contexts.length > 2) return { errors: ['plannedContextSeed is invalid'], sources };
  if (seed.closureEvidence !== undefined) {
    if (!Array.isArray(seed.closureEvidence) || seed.closureEvidence.length > 2) errors.push('planned seed closure evidence is invalid');
    else for (const check of seed.closureEvidence) {
      if (!allowed(check, ['stationID', 'lineID', 'sourceScope', 'closed', 'observedAt', 'expiresAt', 'validFrom', 'validUntil']) || check.stationID !== record.stationID || check.lineID !== record.lineID || !['lineStatus', 'stationDisruptions'].includes(check.sourceScope) || typeof check.closed !== 'boolean') { errors.push('planned seed closure scope is invalid'); continue; }
      const observedAt = iso(check.observedAt), expiresAt = iso(check.expiresAt), source = check.sourceScope === 'lineStatus' ? 'service' : 'station';
      if (!Number.isFinite(observedAt) || observedAt > now || !Number.isFinite(expiresAt) || expiresAt <= observedAt || expiresAt > observedAt + 120000 || closureSources[source]) { errors.push('planned seed closure clock is invalid'); continue; }
      const validFrom = check.validFrom === undefined ? null : iso(check.validFrom), validUntil = check.validUntil === undefined ? null : iso(check.validUntil);
      if ((check.closed || validFrom != null || validUntil != null) && (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validFrom >= validUntil || expiresAt > validUntil)) { errors.push('planned seed closure period is invalid'); continue; }
      if (expiresAt > now && (!check.closed || validFrom <= now && now < validUntil)) closureSources[source] = { stationID: record.stationID, lineID: record.lineID, observedAt, expiresAt, closed: check.closed, validFrom, validUntil, qualificationOrigin: 'client' };
    }
  }
  const seenSources = new Set();
  for (const context of seed.contexts) {
    if (!allowed(context, ['sourceID', 'observedAt', 'expiresAt', 'sourceSHA256', 'publication', 'rows']) || !['timetable', 'unified-timetable', 'journey-planner'].includes(context.sourceID)) { errors.push('planned seed source is invalid'); continue; }
    if (context.sourceSHA256 != null && !digest(context.sourceSHA256)) { errors.push('planned seed response fingerprint is invalid'); continue; }
    const normalized = context.sourceID === 'unified-timetable' ? 'timetable' : context.sourceID;
    if (seenSources.has(normalized)) { errors.push('planned seed source is duplicated'); continue; } seenSources.add(normalized);
    const observedAt = iso(context.observedAt), expiresAt = iso(context.expiresAt), lifetime = normalized === 'timetable' ? 600000 : 120000;
    if (!Number.isFinite(observedAt) || observedAt > now || !Number.isFinite(expiresAt) || expiresAt <= observedAt || expiresAt > observedAt + lifetime || !Array.isArray(context.rows) || context.rows.length > 32) { errors.push('planned seed clock or rows are invalid'); continue; }
    const publication = context.publication;
    if (normalized === 'timetable') {
      if (!allowed(publication, ['url', 'sha256', 'timezone', 'operatingStartDate', 'operatingEndDate', 'holidayCoverageStart', 'holidayCoverageEnd', 'nonOperationBankHolidays']) || publication.url !== TIMETABLE_PUBLICATION_URL || !digest(publication.sha256) || publication.timezone !== 'Europe/London' || publication.nonOperationBankHolidays !== true || !['operatingStartDate', 'operatingEndDate', 'holidayCoverageStart', 'holidayCoverageEnd'].every((field) => dateKey(publication[field])) || publication.operatingStartDate > publication.operatingEndDate || publication.holidayCoverageStart > publication.holidayCoverageEnd) { errors.push('planned seed publication/calendar is invalid'); continue; }
    } else if (publication !== undefined || !digest(context.sourceSHA256)) { errors.push('planner seed response evidence is invalid'); continue; }
    // Expired transport is a no-op, never a token-registration failure/renewal.
    if (expiresAt <= now) continue;
    const today = londonLocal(now).slice(0, 10), nextDay = new Date(`${today}T12:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (expiresAt > londonClock(`${nextDay.toISOString().slice(0, 10)}T00:00:00`)) { errors.push('planned seed crosses current calendar expiry'); continue; }
    const events = [], rowEvidence = [], seenRows = new Set(), profiles = new Map();
    for (const row of context.rows) {
      const permitted = ['id', 'destinationID', 'destination', 'departure', 'via', 'providerDirection', 'routeStationIDs', 'serviceDay', 'profileName', 'profileSHA256', 'weekdays', 'serviceMinute', 'isBankHoliday'];
      if (!allowed(row, permitted) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 256 || seenRows.has(row.id) || !validBoard(row.destinationID, record.lineID) || row.destinationID === record.stationID || nameKey(row.destination) !== nameKey(STATION_BOARD_STATIONS.get(row.destinationID)?.stationName) || !Array.isArray(row.routeStationIDs) || !row.routeStationIDs.length || row.routeStationIDs.length > 200 || (normalized === 'timetable' && row.routeStationIDs.at(-1) !== row.destinationID) || row.routeStationIDs.some((id) => !validBoard(id, record.lineID)) || (row.via != null && (typeof row.via !== 'string' || row.via.length > 120)) || (row.providerDirection != null && (typeof row.providerDirection !== 'string' || !row.providerDirection.trim() || row.providerDirection.length > 64))) { errors.push('planned seed row is invalid'); continue; }
      if (row.via != null) {
        const viaKey = nameKey(row.via) === 'cx' ? 'charing cross' : nameKey(row.via);
        const stations = [...STATION_BOARD_STATIONS.values()].filter((station) => station.lineIDs.includes(record.lineID) && nameKey(station.stationName) === viaKey);
        if (stations.length !== 1 || (normalized === 'timetable' && !row.routeStationIDs.includes(stations[0].stationID))) { errors.push('planned seed via is unsupported by its ordered calls'); continue; }
      }
      if (normalized === 'timetable') {
        const bank = row.routeStationIDs.includes('940GZZLUBNK'), cross = row.routeStationIDs.includes('940GZZLUCHX');
        if ((record.lineID === 'northern' && ((bank && cross) || nameKey(row.via) !== (bank ? 'bank' : cross ? 'charing cross' : ''))) || (record.lineID !== 'northern' && row.via != null)) { errors.push('planned seed full-timetable route/via conflicts'); continue; }
      }
      seenRows.add(row.id); const departure = iso(row.departure);
      if (!Number.isFinite(departure)) { errors.push('planned seed departure is invalid'); continue; }
      if (normalized === 'timetable') {
        if (!dateKey(row.serviceDay) || !row.id.startsWith(`schedule:${record.lineID}:${record.stationID}:${row.serviceDay}:`) || typeof row.profileName !== 'string' || !row.profileName.trim() || row.profileName.length > 240 || !digest(row.profileSHA256) || !Array.isArray(row.weekdays) || !row.weekdays.length || new Set(row.weekdays).size !== row.weekdays.length || row.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) || row.isBankHoliday !== false || !Number.isInteger(row.serviceMinute) || row.serviceMinute < 0 || row.serviceMinute >= 2880 || row.serviceDay < publication.operatingStartDate || row.serviceDay > publication.operatingEndDate || row.serviceDay < publication.holidayCoverageStart || row.serviceDay > publication.holidayCoverageEnd) { errors.push('planned seed originating calendar/profile is invalid'); continue; }
        const profile = JSON.stringify([row.profileName, row.profileSHA256, row.weekdays]);
        if ((profiles.has(row.serviceDay) && profiles.get(row.serviceDay) !== profile) || londonLocal(departure).slice(0, 10) !== today) { errors.push('planned seed profile/day is ambiguous'); continue; }
        profiles.set(row.serviceDay, profile);
        const service = new Date(`${row.serviceDay}T12:00:00Z`), weekday = service.getUTCDay() + 1;
        service.setUTCDate(service.getUTCDate() + Math.floor(row.serviceMinute / 1440));
        const minute = row.serviceMinute % 1440, expected = londonClock(`${service.toISOString().slice(0, 10)}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`);
        if (!row.weekdays.includes(weekday) || !Number.isFinite(expected) || expected !== departure || ![today, new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10)].includes(row.serviceDay)) { errors.push('planned seed service-day clock is invalid'); continue; }
        rowEvidence.push({ id: row.id, serviceDay: row.serviceDay, profileName: row.profileName, profileSHA256: row.profileSHA256, weekdays: row.weekdays, serviceMinute: row.serviceMinute, isBankHoliday: false });
      }
      if (departure < now) continue;
      events.push({ id: row.id, stationID: record.stationID, lineID: record.lineID, sourceID: context.sourceID, kind: 'outgoingDeparture', timeEvidence: 'scheduledDeparture', destination: row.destination, destinationStationID: row.destinationID, via: row.via || null, routeStationIDs: row.routeStationIDs, time: departure, platform: null, direction: null, providerDirection: row.providerDirection || null, receivedAt: observedAt, expiresAt });
    }
    if (events.length) sources[normalized] = { observedAt, events, qualificationOrigin: 'client', evidence: { publication: publication || null, sourceSHA256: context.sourceSHA256 || null, rows: rowEvidence } };
  }
  return { errors, sources, closureSources };
}
