import { applyPublicationAuthority } from './station-board-publication.js';
import { readPublicationAsset } from './timetable-publication-resource.js';
import crypto from 'node:crypto';
import { parseBoundedJSON } from './bounded-json.js';
import { selectedTimetableEntry, qualifyTimetable, timetableHTTPObservation } from './station-board-timetable.js';
import fs from 'node:fs';
import { retainAvailability, legacyClosureSources, blocksScheduled, availabilityBoundaries, qualifyAvailability, wireAvailability, containsServiceClosed, knownNonClosure, activeClosure, expiredBarrier, completePlannedApplicability } from './station-board-availability.js';
import { fetchJsonResponse } from './notification-transport.js';

export const STATION_BOARD_CONTRACT = 'station-board-v2';
const catalogue = JSON.parse(fs.readFileSync(new URL('../contracts/station-board-catalogue-v2.json', import.meta.url)));
export const STATION_BOARD_LINES = new Map(catalogue.lines.map((line) => [line.lineID, line]));
export const STATION_BOARD_STATIONS = new Map(catalogue.stations.map((station) => [station.stationID, station]));
const APPLE_EPOCH = 978307200000;
const key = (value) => String(value || '').toLowerCase().replace(/ (underground|rail|dlr) station/g, '').replace(/\s*\([^)]*\)/g, '').replace(/\s+(station|terminus)$/, '').trim().replace(/\s+/g, ' ');
const hash = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const objectRow = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isoClock = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return NaN;
  return Date.parse(value);
};
const swift = (ms) => (ms - APPLE_EPOCH) / 1000;
const sourceKey = (source) => ['timetable', 'unified-timetable'].includes(source) ? 'timetable' : source;
const plannedSource = (event) => event.kind === 'outgoingDeparture' && event.timeEvidence === 'scheduledDeparture' && ['timetable', 'journey-planner', 'rail-departures'].includes(sourceKey(event.sourceID)) ? sourceKey(event.sourceID) : null;
const planned = (event) => ['timetable', 'journey-planner'].includes(sourceKey(event.sourceID)) || (event.kind === 'outgoingDeparture' && event.timeEvidence === 'scheduledDeparture');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function validBoard(stationID, lineID) { return STATION_BOARD_STATIONS.get(stationID)?.lineIDs.includes(lineID) === true; }
function lineStations(lineID) { return [...STATION_BOARD_STATIONS.values()].filter((station) => station.lineIDs.includes(lineID)); }
function named(name, lineID) {
  const stations = lineStations(lineID), exact = stations.filter((station) => key(station.stationName) === key(name));
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const aliases = stations.filter((station) => key(station.stationName).replace(/^london /, '') === key(name).replace(/^london /, ''));
  return aliases.length === 1 ? aliases[0] : null;
}
function endpoint(row, record, nameField = 'destinationName', idField = 'destinationNaptanId') {
  const id = text(row[idField]), name = text(row[nameField]);
  const station = id ? STATION_BOARD_STATIONS.get(id.toUpperCase()) : named(name, record.lineID);
  if (!station || !station.lineIDs.includes(record.lineID)) return null;
  if (name && !['check front of train', 'see front of train'].includes(key(name)) && key(name) !== key(station.stationName)) return null;
  return station;
}
export function httpObservation(headers, now, lifetime, { cacheRequired = false, futureSkew = 5_000 } = {}) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const date = Date.parse(h.date || ''), age = Number(h.age);
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(h['cache-control'] || '');
  if (!Number.isFinite(date) || h.age === undefined || !Number.isFinite(age) || age < 0 || date > now + futureSkew || (cacheRequired && !maxAge)) return null;
  const effectiveAge = Math.max(age * 1000, Math.max(0, now - date));
  const observedAt = now - effectiveAge;
  const expiresAt = observedAt + Math.min(lifetime, maxAge ? Number(maxAge[1]) * 1000 : lifetime);
  return now < expiresAt ? { observedAt, expiresAt } : null;
}
const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function londonLocal(ms) {
  const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function londonClock(value) {
  if (typeof value !== 'string') return NaN;
  if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return isoClock(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)) return NaN;
  const utc = Date.parse(`${value}Z`);
  const matches = [utc - 3_600_000, utc].filter((candidate) => londonLocal(candidate) === value);
  return matches.length === 1 ? matches[0] : NaN;
}
function midnight(now) {
  const day = londonLocal(now).slice(0, 10), next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return londonClock(`${next}T00:00:00`);
}
function event(record, sourceID, facts, observation) {
  return { stationID: record.stationID, lineID: record.lineID, sourceID, receivedAt: observation.observedAt, expiresAt: observation.expiresAt, ...facts };
}
function arrivalAlternatives(rows) {
  const unique = [...new Map(rows.map((row) => [canonical(row), row])).values()];
  const broad = new Map();
  for (const row of unique) {
    if (!text(row.id) || !text(row.vehicleId) || ['0', '000', 'unknown'].includes(key(row.vehicleId)) || !text(row.currentLocation) || !Number.isFinite(isoClock(row.timestamp)) || !Number.isFinite(isoClock(row.timing?.read))) continue;
    const stable = { ...row }; delete stable.platformName; delete stable.expectedArrival; delete stable.timeToStation; delete stable.timeToLive;
    if (stable.timing) { stable.timing = { ...stable.timing }; delete stable.timing.timeToLive; }
    const signature = canonical(stable), group = broad.get(signature) || []; group.push(row); broad.set(signature, group);
  }
  const broadByRow = new Map();
  for (const [signature, group] of broad) {
    const platforms = group.map((row) => text(row.platformName)?.toLowerCase()), clocks = group.map((row) => isoClock(row.expectedArrival));
    if (group.length > 1 && platforms.every(Boolean) && new Set(platforms).size === group.length && clocks.every(Number.isFinite) && Math.max(...clocks) - Math.min(...clocks) <= 90000) for (const row of group) broadByRow.set(canonical(row), signature);
  }
  const groups = new Map();
  for (const row of unique) {
    const facts = { ...row }; delete facts.platformName;
    const signature = broadByRow.get(canonical(row)) || (text(row.id) ? canonical(facts) : canonical(row)), group = groups.get(signature) || []; group.push(row); groups.set(signature, group);
  }
  return [...groups.values()].map((group) => ({ ...group[0], __unknownPlatform: new Set(group.map((row) => row.platformName)).size > 1, __unknownClock: new Set(group.map((row) => row.expectedArrival)).size > 1 }));
}
export function parseStationArrivals(rows, record, headers, now) {
  const observation = httpObservation(headers, now, 120_000);
  if (!observation || !Array.isArray(rows) || rows.length > 2000 || rows.some((row) => !objectRow(row))) return [];
  const seen = new Set();
  return arrivalAlternatives(rows).flatMap((row) => {
    if (row.naptanId !== record.stationID || row.lineId !== record.lineID || seen.has(canonical(row))) return [];
    seen.add(canonical(row));
    const destination = endpoint(row, record), time = isoClock(row.expectedArrival), timestamp = isoClock(row.timestamp);
    if (!destination || !Number.isFinite(time) || time < now || !Number.isFinite(timestamp) || timestamp > now + 5000 || timestamp + 120000 <= now) return [];
    const receivedAt = Math.min(observation.observedAt, timestamp);
    // Repeated calls can only change self-endpoint classification when the
    // source actually provides an ordered route and current call position.
    const stops = row.routeStationIDs, index = row.selectedStopIndex;
    const loop = Array.isArray(stops) && Number.isInteger(index) && index >= 0 && index < stops.length && stops[index] === record.stationID && stops.at(-1) === destination.stationID && index < stops.length - 1;
    const incoming = destination.stationID === record.stationID && !loop;
    return [event(record, 'station-arrivals', { id: `arrival:${hash(row)}`, kind: incoming ? 'incomingArrival' : 'throughArrival', destination: destination.stationName, destinationStationID: destination.stationID,
      time: row.__unknownClock ? null : time, timeEvidence: row.__unknownClock ? null : 'arrivalPrediction', platform: row.__unknownPlatform ? null : usablePlatform(row.platformName), direction: row.__unknownPlatform ? null : publicDirection(row.platformName), providerDirection: text(row.direction), via: routeVia(row.towards, destination, record.lineID), receivedAt,
      expiresAt: Math.min(observation.expiresAt, receivedAt + 120000) }, observation)];
  });
}
function usablePlatform(value) { const v = text(value); return v && !['unknown', 'platform unknown', 'tbc', '-'].includes(v.toLowerCase()) ? v : null; }
function publicDirection(platform) { return /\b(northbound|southbound|eastbound|westbound)\b/i.exec(platform || '')?.[1] || null; }
function routeVia(towards, destination, lineID) {
  if (!text(towards)) return null;
  const parts = towards.split(/ via /i);
  if (parts.length > 2 || (key(parts[0]) !== key(destination.stationName) && !(key(parts[0]).length >= 4 && key(destination.stationName).startsWith(`${key(parts[0])} `)))) return undefined;
  if (parts.length === 1) return null;
  if (['cx', 'charing cross'].includes(key(parts[1]))) return 'Charing Cross';
  if (key(parts[1]) === 'bank') return 'Bank';
  return named(parts[1], lineID)?.stationName;
}
export function parseDestinationFacts(rows, record, headers, now) {
  const observation = httpObservation(headers, now, 60_000, { cacheRequired: true });
  if (!observation || !Array.isArray(rows) || rows.length > 5000 || rows.some((row) => !objectRow(row))) return [];
  const selected = STATION_BOARD_STATIONS.get(record.stationID), names = [key(selected?.stationName)];
  if (record.stationID === '940GZZLUERC' && ['circle', 'district', 'hammersmith-city'].includes(record.lineID)) names.push('edgware road');
  const locations = new Map();
  for (const row of rows) {
    if (row.lineId !== record.lineID) continue;
    const timestamp = isoClock(row.timestamp), read = isoClock(row.timing?.read);
    // Unified predictions expose source-read as timing.read. It must be a
    // validated source clock, never a countdown or downstream departure.
    if (![timestamp, read].every(Number.isFinite) || timestamp > now + 5000 || read > now + 5000 || timestamp + 60000 <= now || read + 90000 <= now) continue;
    const location = text(row.currentLocation)?.replace(/\s+/g, ' '), normalized = key(location);
    let platform = null, matched = false;
    for (const name of names) {
      if (normalized === `at ${name}`) matched = true;
      const prefix = `at ${name} platform `;
      if (normalized.startsWith(prefix) && /^[a-z0-9][a-z0-9/-]{0,7}$/i.test(normalized.slice(prefix.length))) { matched = true; platform = `Platform ${normalized.slice(prefix.length).toUpperCase()}`; }
    }
    if (!matched) continue;
    const downstream = STATION_BOARD_STATIONS.get(row.naptanId), destination = endpoint(row, record), via = destination ? routeVia(row.towards, destination, record.lineID) : undefined;
    const valid = downstream && downstream.stationID !== record.stationID && key(downstream.stationName) === key(row.stationName) && isoClock(row.expectedArrival) > now && destination && destination.stationID !== record.stationID && via !== undefined;
    const group = locations.get(platform || 'station') || [];
    group.push({ valid, destination, via, platform, vehicle: text(row.vehicleId), direction: text(row.direction), read, expiresAt: Math.min(observation.expiresAt, timestamp + 60000, read + 90000) });
    locations.set(platform || 'station', group);
  }
  return [...locations.values()].flatMap((group) => {
    if (group.some((item) => !item.valid) || new Set(group.map((item) => item.vehicle).filter(Boolean)).size > 1 || new Set(group.map((item) => item.direction).filter(Boolean)).size > 1 || new Set(group.map((item) => canonical([item.destination?.stationID, item.via]))).size !== 1) return [];
    const first = group[0];
    return [event(record, 'at-station-destination', { id: `destination:${hash([record.lineID, first.destination.stationID, first.via, first.platform])}`, kind: 'outgoingDestinationOnly', destination: first.destination.stationName,
      destinationStationID: first.destination.stationID, via: first.via, platform: first.platform, time: null, timeEvidence: null, providerDirection: first.direction,
      receivedAt: Math.max(...group.map((item) => item.read)), expiresAt: Math.min(...group.map((item) => item.expiresAt)) }, observation)];
  });
}
export function parseRailDepartures(rows, record, headers, now) {
  if (!STATION_BOARD_LINES.get(record.lineID)?.qualifiedRailDepartureSource || !Array.isArray(rows) || rows.length > 500 || rows.some((row) => !objectRow(row) || row.naptanId !== record.stationID)) return [];
  const observation = httpObservation(headers, now, 90_000, { cacheRequired: true });
  if (!observation) return [];
  const unique = [...new Map(rows.map((row) => [canonical(row), row])).values()];
  const alternatives = new Map();
  for (const row of unique) { const facts = { ...row }; delete facts.platformName; const signature = canonical(facts); alternatives.set(signature, (alternatives.get(signature) || 0) + 1); }
  return unique.flatMap((row) => {
    const destination = endpoint(row, record), status = text(row.departureStatus)?.toLowerCase(), estimated = isoClock(row.estimatedTimeOfDeparture), scheduled = isoClock(row.scheduledTimeOfDeparture);
    const withoutPlatform = { ...row }; delete withoutPlatform.platformName;
    if ((row.lineId !== undefined && row.lineId !== record.lineID) || (row.lineIds !== undefined && (!Array.isArray(row.lineIds) || row.lineIds.length !== 1 || row.lineIds[0] !== record.lineID))) return [];
    if (['check front of train', 'see front of train'].includes(key(row.destinationName))) return [];
    if (!text(row.destinationNaptanId) || !text(row.destinationName) || !destination || !['ontime', 'delayed'].includes(status) || alternatives.get(canonical(withoutPlatform)) > 1) return [];
    const incoming = destination.stationID === record.stationID;
    const time = incoming ? isoClock(row.estimatedTimeOfArrival) : Number.isFinite(estimated) ? estimated : status === 'ontime' ? scheduled : NaN;
    if (!Number.isFinite(time) || time < now) return [];
    return [event(record, 'rail-departures', { id: `rail:${hash(row)}`, kind: incoming ? 'incomingArrival' : 'outgoingDeparture', destination: destination.stationName, destinationStationID: destination.stationID, time,
      timeEvidence: incoming ? 'arrivalPrediction' : Number.isFinite(estimated) ? 'predictedDeparture' : 'scheduledDeparture', platform: usablePlatform(row.platformName), direction: publicDirection(row.platformName), providerDirection: null, via: null, ...(incoming ? { scheduledArrival: Number.isFinite(isoClock(row.scheduledTimeOfArrival)) ? isoClock(row.scheduledTimeOfArrival) : null } : {}) }, observation)];
  });
}
export function journeyURL(record, now) {
  const line = STATION_BOARD_LINES.get(record.lineID);
  const rule = catalogue.narrowQueryRules?.find((rule) => rule.stationID === record.stationID && rule.lineID === record.lineID);
  const target = rule?.targetID || line.branchTargetIDs.find((id) => id !== record.stationID && validBoard(id, record.lineID));
  if (!target || !validBoard(record.stationID, record.lineID)) return null;
  const local = londonLocal(now), url = new URL(`https://api.tfl.gov.uk/Journey/JourneyResults/${record.stationID}/to/${target}`);
  for (const [name, value] of Object.entries({ date: local.slice(0, 10).replaceAll('-', ''), time: local.slice(11, 16).replace(':', ''), timeIs: 'Departing', mode: line.mode, useRealTimeLiveArrivals: 'false', calcOneDirection: 'true', includeAlternativeRoutes: rule ? 'false' : 'true' })) url.searchParams.set(name, value);
  if (rule) url.searchParams.set('journeyPreference', 'leastinterchange');
  if (rule?.via) { url.searchParams.set('via', rule.via); url.searchParams.set('maxWalkingMinutes', '0'); }
  return url;
}
export function parseJourney(root, record, headers, requestedAt, now, actualRequestAt = requestedAt) {
  const line = STATION_BOARD_LINES.get(record.lineID), local = `${londonLocal(requestedAt).slice(0, 16)}:00`;
  if (!line || !validBoard(record.stationID, record.lineID) || root?.searchCriteria?.dateTimeType !== 'Departing' || root.searchCriteria.dateTime !== local || !Number.isInteger(root.recommendedMaxAgeMinutes) || root.recommendedMaxAgeMinutes <= 0 || !Array.isArray(root.stopMessages) || root.stopMessages.some((message) => typeof message !== 'string') || !Array.isArray(root.journeys)) return [];
  const observation = httpObservation(headers, now, Math.min(root.recommendedMaxAgeMinutes, 2) * 60000, { futureSkew: 120000 });
  if (!observation) return [];
  observation.expiresAt = Math.min(observation.expiresAt, midnight(now));
  const seen = new Map(), events = [];
  for (const journey of root.journeys) {
    const leg = Array.isArray(journey?.legs) ? journey.legs.find((leg) => objectRow(leg) && leg.mode?.id !== 'walking') : null, option = leg?.routeOptions?.[0];
    if (!leg || leg.mode?.id !== line.mode || leg.departurePoint?.naptanId !== record.stationID || leg.isDisrupted !== false || !Array.isArray(leg.disruptions) || leg.disruptions.length || !Array.isArray(leg.plannedWorks) || leg.plannedWorks.length || leg.routeOptions?.length !== 1 || option.lineIdentifier?.id !== record.lineID || option.directions?.length !== 1 || typeof option.directions[0] !== 'string') continue;
    const departure = londonClock(leg.scheduledDepartureTime), parts = option.directions[0].split(/ via /i), destination = named(parts[0], record.lineID);
    if (!Number.isFinite(departure) || departure < now || departure < requestedAt - (requestedAt > actualRequestAt ? 0 : 60000) || !destination || destination.stationID === record.stationID || parts.length > 2 || !Array.isArray(leg.path?.stopPoints) || !leg.path.stopPoints.length) continue;
    const viaStation = parts.length === 2 ? named(parts[1], record.lineID) : null;
    if (parts.length === 2 && !viaStation) continue;
    const calls = leg.path.stopPoints.map((stop) => !objectRow(stop) ? null : stop.id ? validBoard(stop.id, record.lineID) ? stop.id : null : named(stop.name, record.lineID)?.stationID);
    if (calls.some((call) => !call) || calls.at(-1) !== leg.arrivalPoint?.naptanId) continue;
    const service = hash({ station: record.stationID, line: record.lineID, stop: leg.departurePoint.individualStopId || '', clock: leg.scheduledDepartureTime, direction: option.directions[0], providerDirection: option.direction || '', routeID: option.id || '', legID: leg.id || '' });
    const prior = seen.get(service) || [];
    if (prior.some((previous) => previous.slice(0, Math.min(previous.length, calls.length)).every((id, index) => id === calls[index]))) continue;
    seen.set(service, [...prior, calls]);
    events.push(event(record, 'journey-planner', { id: `journey:${hash([service, calls])}`, kind: 'outgoingDeparture', destination: destination.stationName, destinationStationID: destination.stationID, time: departure, timeEvidence: 'scheduledDeparture', platform: null, via: viaStation?.stationName || null, direction: null, providerDirection: text(option.direction) }, observation));
  }
  return events;
}
export function usable(event, record, now) {
  if (!objectRow(event)) return false;
  const knownSource = ['station-arrivals', 'unified-arrivals', 'rail-departures', 'at-station-destination', 'timetable', 'unified-timetable', 'journey-planner'].includes(event.sourceID);
  const knownKind = ['outgoingDeparture', 'outgoingDestinationOnly', 'incomingArrival', 'throughArrival', 'unverifiedArrival'].includes(event.kind);
  if (typeof event.id !== 'string' || !knownSource || !knownKind || (event.kind === 'outgoingDeparture' && !['scheduledDeparture', 'predictedDeparture'].includes(event.timeEvidence)) || (['throughArrival', 'incomingArrival', 'unverifiedArrival'].includes(event.kind) && event.timeEvidence !== 'arrivalPrediction' && event.timeEvidence != null)) return false;
  return event.stationID === record.stationID && event.lineID === record.lineID && Number.isFinite(event.receivedAt) && event.receivedAt <= now && Number.isFinite(event.expiresAt) && event.expiresAt > now && typeof event.destination === 'string'
    && (event.kind === 'outgoingDestinationOnly' ? event.time == null && event.timeEvidence == null : ['incomingArrival', 'throughArrival'].includes(event.kind) && event.time == null ? event.timeEvidence == null : Number.isFinite(event.time) && event.time >= now && ['arrivalPrediction', 'scheduledDeparture', 'predictedDeparture'].includes(event.timeEvidence));
}
function rejectionInvalidates(rejection, event, record, now) {
  return rejection.stationID === record.stationID && rejection.lineID === record.lineID && rejection.observedAt <= now && rejection.observedAt + 600000 > now && event.receivedAt <= rejection.observedAt
    && (['serviceUnavailable', 'stationDisrupted'].includes(rejection.reason) ? planned(event) : sourceKey(event.sourceID) === 'timetable');
}
export function mergeContexts(previous = {}, incoming = {}, record, now) {
  const rejections = [...(previous.rejections || []), ...(incoming.rejections || [])].filter((r) => r && ['publicationChanged', 'timetableChanged', 'unsupportedCalendar', 'serviceUnavailable', 'stationDisrupted'].includes(r.reason) && r.stationID === record.stationID && r.lineID === record.lineID && Number.isFinite(r.observedAt) && r.observedAt <= now && r.observedAt + 600000 > now);
  const markerMap = new Map();
  for (const marker of rejections) { const scope = ['stationDisrupted', 'serviceUnavailable'].includes(marker.reason) ? 'planned-service' : 'publication'; if ((markerMap.get(scope)?.observedAt ?? -Infinity) < marker.observedAt) markerMap.set(scope, marker); }
  const markers = [...markerMap.values()], sources = {};
  const availabilityProofs = retainAvailability(previous, incoming, record, now);
  const closureSources = legacyClosureSources(availabilityProofs);
  let publicationIdentity = null;
  for (const check of [previous.publicationIdentity, incoming.publicationIdentity]) {
    if (objectRow(check) && Number.isFinite(check.observedAt) && check.observedAt <= now && check.observedAt + 600000 > now && check.expiresAt <= check.observedAt + 600000 && /^[a-f0-9]{64}$/i.test(check.sha256 || '') && (!publicationIdentity || check.observedAt > publicationIdentity.observedAt)) publicationIdentity = check;
  }
  for (const contexts of [previous.sources || {}, incoming.sources || {}]) {
    for (const [source, context] of Object.entries(contexts)) {
      if (!objectRow(context)) continue;
      const normalized = sourceKey(source), old = sources[normalized];
      if (!Number.isFinite(context.observedAt) || context.observedAt > now) continue;
      if (normalized === 'timetable' && publicationIdentity?.expiresAt > now && publicationIdentity.observedAt >= context.observedAt && context.evidence?.publication?.sha256?.toLowerCase() !== publicationIdentity.sha256.toLowerCase()) continue;
      const events = (context.events || []).filter((e) => usable(e, record, now) && !(planned(e) && availabilityProofs.some((p) => p.plannedUnavailable === true && p.scheduledClockOnly !== true && blocksScheduled(p, e.time, now))) && !markers.some((r) => rejectionInvalidates(r, e, record, now)));
      if (!events.length && !(Array.isArray(context.events) && context.events.length === 0 && (normalized === 'rail-departures' || normalized === 'timetable' && context.qualificationOrigin === 'server' && context.expiresAt > now))) continue;
      if (!old || context.observedAt > old.observedAt) sources[normalized] = { observedAt: context.observedAt, events, ...(context.expiresAt === undefined ? {} : { expiresAt: context.expiresAt }), ...(context.evidence ? { evidence: context.evidence, qualificationOrigin: context.qualificationOrigin } : {}) };
    }
  }
  return { sources, rejections: markers, closureSources, availabilityProofs, publicationIdentity, nextRefreshAt: Math.max(previous.nextRefreshAt || 0, incoming.nextRefreshAt || 0), status: incoming.status || previous.status || null };
}
function selectionMatches(event, record) {
  if (record.selectionMode !== 'platform' && !record.platformID) return true;
  if (['incomingArrival', 'unverifiedArrival'].includes(event.kind)) return false;
  const label = text(record.platformLabel), heading = text(record.platformHeading), id = text(record.platformID), direction = text(record.platformDirection);
  const platformKey = (value) => { const v = text(value); if (!v || ['unknown', 'platform unknown', 'tbc', '-'].includes(key(v))) return null; return /\bplatform[\s-]+([\w/-]+)/i.exec(v)?.[1]?.toLowerCase() || (/^[a-z0-9][a-z0-9/-]{0,7}$/i.test(v) && !/^(northbound|southbound|eastbound|westbound|inbound|outbound)$/i.test(v) ? v.toLowerCase() : null); };
  const desiredPlatform = platformKey(label) || platformKey(heading) || platformKey(id);
  if (desiredPlatform && platformKey(event.platform) !== desiredPlatform) return false;
  const desiredDirection = direction || /\b(northbound|southbound|eastbound|westbound|inbound|outbound)\b/i.exec(heading || id || '')?.[1];
  if (desiredDirection && ![event.direction, event.providerDirection].some((value) => key(value) === key(desiredDirection))) return false;
  return Boolean(desiredPlatform || desiredDirection || (event.platform && key(event.platform) === key(label || heading || id)));
}
// Source choice for potentially overlapping fragments, never a train match
// or a declaration that a single rail record covers the whole board.
export function retainsThroughArrival(through, candidates) {
  if (through.kind !== 'throughArrival') return true;
  const knownDestination = (event) => {
    const id = text(event.destinationStationID), station = id && STATION_BOARD_STATIONS.get(id.toUpperCase());
    return station && station.lineIDs.includes(event.lineID) && (!text(event.destination) || ['check front of train', 'see front of train'].includes(key(event.destination)) || key(event.destination) === key(station.stationName)) ? station.stationID : null;
  };
  const physicalPlatform = (event) => {
    const value = text(event.platform)?.toLowerCase().replace(/^platform\s+/, '');
    return value && /^(?:[0-9]+[a-z]?|[a-z])$/.test(value) ? value : null;
  };
  return candidates.filter((event) => event.sourceID === 'rail-departures' && event.kind === 'outgoingDeparture' && event.timeEvidence === 'predictedDeparture' && event.stationID === through.stationID && event.lineID === through.lineID).every((departure) => {
    const leftDestination = knownDestination(through), rightDestination = knownDestination(departure);
    if (leftDestination && rightDestination && leftDestination !== rightDestination) return true;
    const leftVia = text(through.via) && named(through.via, through.lineID), rightVia = text(departure.via) && named(departure.via, departure.lineID);
    if (leftVia && rightVia && leftVia.stationID !== rightVia.stationID) return true;
    const leftPlatform = physicalPlatform(through), rightPlatform = physicalPlatform(departure);
    if (leftPlatform && rightPlatform && leftPlatform !== rightPlatform) return true;
    return through.timeEvidence === 'arrivalPrediction' && Number.isFinite(through.time) && Number.isFinite(departure.time) && through.time > departure.time;
  });
}
export function selectEvents(cache, record, now, { retainingMaskedPlans = false, retainingPlannedAlternatives = false } = {}) {
  const proofs = retainAvailability(cache, {}, record, now);
  let events = Object.values(cache.sources || {}).flatMap((context) => context.events || []).filter((e) => usable(e, record, now) && !(planned(e) && proofs.some((p) => (!retainingMaskedPlans || p.plannedUnavailable === true && p.scheduledClockOnly !== true) && blocksScheduled(p, e.time, now))) && selectionMatches(e, record) && !(cache.rejections || []).some((r) => rejectionInvalidates(r, e, record, now)));
  if (!retainingPlannedAlternatives && events.some((e) => plannedSource(e) === 'timetable')) events = events.filter((e) => plannedSource(e) !== 'journey-planner');
  const rail = events.filter((e) => e.sourceID === 'rail-departures' && e.kind === 'outgoingDeparture' && e.timeEvidence === 'predictedDeparture');
  events = events.filter((event) => retainsThroughArrival(event, rail));
  const seen = new Set(); events = events.filter((e) => { const signature = canonical(e); if (seen.has(signature)) return false; seen.add(signature); return true; });
  // Compact activities compare times across eligible outgoing platform groups.
  // Arrivals remain last; physical groups belong to the full app board.
  const category = (e) => ['incomingArrival', 'unverifiedArrival'].includes(e.kind) ? 1 : 0;
  const atPlatformDestination = (e) => e.kind === 'outgoingDestinationOnly' && e.time == null && e.timeEvidence == null
    && /^(?:[0-9]+[a-z]?|[a-z])$/.test(text(e.platform)?.toLowerCase().replace(/^platform\s+/, '') || '');
  return events.sort((a, b) => category(a) - category(b) || Number(atPlatformDestination(b)) - Number(atPlatformDestination(a)) || (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id));
}
export function countdown(event, now) {
  if (event.kind === 'outgoingDestinationOnly') return usable(event, event, now) ? 'TBC' : '--';
  if (!Number.isFinite(event.time) || event.time < now || event.expiresAt <= now) return '--';
  const seconds = Math.ceil((event.time - now) / 1000);
  if (seconds < 0) return '--';
  return seconds < 60 ? 'Due' : `${Math.floor(seconds / 60)} min`;
}
export function nextBoundary(cache, record, now) {
  const boundaries = availabilityBoundaries(retainAvailability(cache, {}, record, now), now);
  if (cache.status?.expiresAt > now) boundaries.push(cache.status.expiresAt);
  for (const event of Object.values(cache.sources || {}).flatMap((context) => context.events || []).filter((e) => usable(e, record, now))) {
    boundaries.push(event.expiresAt);
    if (Number.isFinite(event.time)) {
      boundaries.push(event.time + 1);
      const seconds = Math.ceil((event.time - now) / 1000);
      if (seconds >= 60) boundaries.push(event.time - Math.floor(seconds / 60) * 60000 + 1000);
    }
  }
  const future = boundaries.filter((boundary) => boundary > now);
  return future.length ? Math.min(...future) : null;
}
export function compactPlanningSource(events) {
  const clocks = new Map();
  for (const e of events) { const source = plannedSource(e); if (source) clocks.set(source, Math.min(clocks.get(source) ?? Infinity, e.time)); }
  const primary = clocks.has('timetable') ? 'timetable' : clocks.has('journey-planner') ? 'journey-planner' : null;
  return [...clocks.keys()].filter((s) => !['timetable', 'journey-planner'].includes(s) || s === primary).sort((a,b) => clocks.get(a) - clocks.get(b) || Number(b === primary) - Number(a === primary) || a.localeCompare(b))[0] || null;
}
export function compactEvents(events) {
  const source = compactPlanningSource(events);
  return events.filter((e) => !plannedSource(e) || plannedSource(e) === source);
}
export function buildStationBoardState(record, cache, now) {
  const capable = record.plannedPresentationVersion === 2;
  const proofs = retainAvailability(cache, {}, record, now).filter((p) => p.closed || p.plannedUnavailable === true || p.scheduledClockOnly === true);
  let rows = selectEvents(cache, record, now, { retainingMaskedPlans: capable, retainingPlannedAlternatives: capable });
  const originalRows = rows;
  const sources = [...new Set(rows.map(plannedSource).filter(Boolean))];
  const retainsContexts = capable && (proofs.length > 0 || sources.length > 1);
  const eligible = (e) => !planned(e) || !proofs.some((p) => blocksScheduled(p, e.time, now));
  if (retainsContexts) {
    const chosen = compactPlanningSource(rows.filter(eligible));
    const orderedSources = sources.sort((a,b) => Number(b === chosen) - Number(a === chosen) || a.localeCompare(b));
    const groups = [...orderedSources, null].map((source) => {
      const group = rows.filter((e) => plannedSource(e) === source);
      const useful = group.filter(eligible).slice(0, 3);
      return [...useful, ...group.filter((e) => !eligible(e)).slice(0, 3 - useful.length)];
    });
    let retained = groups.flat();
    if (retained.length > 9) {
      const active = groups[orderedSources.indexOf(chosen)] || [];
      const independent = groups.at(-1);
      const prioritized = [...active, ...independent, ...groups.flat()];
      retained = [...new Set(prioritized)].slice(0, 9);
    }
    const selected = new Set(retained); rows = rows.filter((e) => selected.has(e));
  } else rows = compactEvents(rows.filter(eligible)).slice(0, 3);
  const status = cache.status?.expiresAt > now ? cache.status : null;
  const evidence = { incomingArrival: 'reportedIncomingArrival', throughArrival: 'throughArrivalPrediction', unverifiedArrival: 'unverified', outgoingDestinationOnly: 'destinationOnly' };
  const wireRow = (e) => ({ id: e.id, destination: e.destination, expectedArrival: Number.isFinite(e.time) ? swift(e.time) : null, countdownText: countdown(e, now), timeEvidence: evidence[e.kind] || (e.timeEvidence === 'predictedDeparture' ? 'estimatedDeparture' : 'scheduledDeparture'), via: e.via || null, reportedPlatform: e.platform || null, expiresAt: swift(e.expiresAt), isCached: false, ...(plannedSource(e) && (capable || plannedSource(e) !== 'rail-departures') ? { plannedSourceID: plannedSource(e) } : {}) });
  let state = { contentStateContract: STATION_BOARD_CONTRACT, stationName: STATION_BOARD_STATIONS.get(record.stationID)?.stationName || record.stationID, lineName: record.lineID === 'dlr' ? 'DLR' : record.lineID === 'elizabeth' ? 'Elizabeth' : record.lineID === 'hammersmith-city' ? 'Hammersmith & City' : record.lineID === 'waterloo-city' ? 'Waterloo & City' : record.lineID.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '), platform: record.selectionMode === 'platform' || record.platformID ? record.platformHeading || record.platformLabel || record.platformID : 'All platforms',
    arrivals: rows.map(wireRow),
    status: status?.label || 'Status unavailable', statusReason: status?.reason || null, isDisrupted: status?.isDisrupted || false, updatedAt: swift(now),
    ...(capable && proofs.length ? { plannedAvailability: { stationID: record.stationID, lineID: record.lineID, proofs: wireAvailability(proofs, swift) } } : {}) };
  const staleAt = () => {
    const deadlines = rows.flatMap((e) => ['outgoingDeparture', 'incomingArrival', 'throughArrival'].includes(e.kind) && Number.isFinite(e.time) ? [e.expiresAt, e.time + 1] : [e.expiresAt]);
    if (rows.some(planned)) deadlines.push(...availabilityBoundaries(proofs, now));
    return swift(deadlines.length ? Math.min(...deadlines) : now);
  };
  state.staleAt = staleAt();
  state.nextBoardBoundaryAt = nextBoundary(cache, record, now);
  if (Buffer.byteLength(JSON.stringify(state)) > 3500) {
    rows = originalRows.filter((e) => !planned(e)).slice(0, 3);
    state.arrivals = rows.map(wireRow); delete state.plannedAvailability;
    state.staleAt = staleAt();
  }
  // APNs must never receive an oversized typed update, including provider text.
  const encoded = () => Buffer.byteLength(JSON.stringify({ aps: { timestamp: Math.floor(now / 1000), event: 'update', 'content-state': Object.fromEntries(Object.entries(state).filter(([k]) => k !== 'nextBoardBoundaryAt')), 'stale-date': Math.floor((state.staleAt * 1000 + APPLE_EPOCH) / 1000) } }));
  if (Buffer.byteLength(JSON.stringify(state)) > 3500 || encoded() > 4096) { state.statusReason = null; state.status = 'Status unavailable'; }
  if (Buffer.byteLength(JSON.stringify(state)) > 3500 || encoded() > 4096) { state.arrivals = []; delete state.plannedAvailability; state.status = 'Status unavailable'; state.statusReason = null; state.staleAt = swift(now); }
  return state;
}

function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export async function refreshStationBoard(record, previous, config, fetchImpl, now, signal, clock = () => now, publicResponses = new Map(), publicationAuthorityStore = null) {
  signal?.throwIfAborted();
  if (previous.nextRefreshAt > now) return mergeContexts(previous, {}, record, now);
  let renewalAsset = null, renewalHead = null;
  // Legacy per-record corroboration must inspect its original context even when
  // persistent HEAD authority removes that context before other source awaits.
  const legacyPublicationContext = record.timetablePublicationAuthorityVersion === 1 ? null : previous.sources?.timetable;
  const request = (inputURL, method = 'GET', boundedTT = false) => {
    const url = new URL(inputURL);
    if (config.tflAppKey && url.hostname === 'api.tfl.gov.uk') url.searchParams.set('app_key', config.tflAppKey);
    const requestKey = `${method}:${url.href}`;
    if (!publicResponses.has(requestKey)) {
      // Insert before awaiting. The missing-Age retry, whole-body deadline
      // and size limit belong to this one public request, including failures.
      publicResponses.set(requestKey, (async () => {
        try {
          const options = { signal, includeHeaders: true, method, ...(boundedTT ? { bodyLimitBytes: 2000000, decodeJSON: bytes => parseBoundedJSON(bytes) } : {}) };
          let response = await fetchJsonResponse(url, fetchImpl, options);
          if (response.ok && response.headers.age === undefined) response = await fetchJsonResponse(url, fetchImpl, options);
          const completedAt = clock();
          if (response.ok && Buffer.byteLength(JSON.stringify(response.value)) > 2000000) return immutable({ ok: false, completedAt });
          return immutable(structuredClone({ ...response, completedAt }));
        } catch (error) { signal?.throwIfAborted(); return immutable({ ok: false, completedAt: clock() }); }
      })());
    }
    return publicResponses.get(requestKey);
  };
  // Independent original identity/revision authority is committed before all
  // feed awaits. Cache-only callers apply retained authority without HTTP.
  if (publicationAuthorityStore && (record.timetablePublicationAuthorityVersion === 1 || previous.sources?.timetable)) {
    const head = await request(new URL('https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip'), 'HEAD');
    const observed = head.ok ? timetableHTTPObservation(head.headers, head.completedAt, { official: true }) : null;
    const sha = head.headers?.['x-amz-meta-sha256'];
    if (observed && observed.expiresAt > head.completedAt && typeof sha === 'string' && sha.length === 64 && /^[0-9a-f]{64}$/.test(sha)) {
      await publicationAuthorityStore.observeOfficialPublication({ sha256: sha, observedAt: observed.observedAt });
      try {
        const asset = await publicationAuthorityStore.readPublicationAsset(sha);
        await publicationAuthorityStore.observePublicationRevision(asset.identity);
        if (record.plannedPresentationVersion === 2 && record.timetablePublicationAuthorityVersion === 1) {
          selectedTimetableEntry(asset, record); renewalAsset = asset; renewalHead = { ...observed, sha256: sha };
        }
      } catch { /* No asset/parse success: original HEAD negative remains. */ }
    }
    previous = applyPublicationAuthority(previous, publicationAuthorityStore.publicationAuthority());
  }
  // Official metadata identity is checked before other feeds. No client URL
  // is ever fetched, and matching HEAD never extends original seeded expiry.
  let publicationRejection = null, publicationIdentity = null;
  const publicationContext = legacyPublicationContext || previous.sources?.timetable;
  const publication = publicationContext?.evidence?.publication;
  if (publication) {
    const head = await request(new URL('https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip'), 'HEAD');
    const observed = head.ok ? httpObservation(head.headers, head.completedAt, 600000, { futureSkew: 120000 }) : null;
    const currentSHA = head.headers?.['x-amz-meta-sha256'];
    if (observed && observed.expiresAt > clock() && typeof currentSHA === 'string' && /^[a-f0-9]{64}$/i.test(currentSHA)) publicationIdentity = { ...observed, sha256: currentSHA.toLowerCase() };
    if (publicationIdentity && publicationIdentity.observedAt >= publicationContext.observedAt && currentSHA.toLowerCase() !== publication.sha256.toLowerCase()) publicationRejection = { stationID: record.stationID, lineID: record.lineID, observedAt: observed.observedAt, reason: 'publicationChanged' };
  }
  const timetableTask = renewalAsset ? (async () => {
    const { sets } = selectedTimetableEntry(renewalAsset, record), responses = [];
    for (const scope of sets) {
      const url = new URL(`https://api.tfl.gov.uk/Line/${record.lineID}/Timetable/${record.stationID}`);
      if (scope.direction !== null) url.searchParams.set('direction', scope.direction);
      responses.push({ ...(await request(url, 'GET', true)), direction: scope.direction });
    }
    return responses;
  })().catch(() => null) : Promise.resolve(null);
  const rail = STATION_BOARD_LINES.get(record.lineID)?.qualifiedRailDepartureSource;
  const arrivalTask = request(new URL(`https://api.tfl.gov.uk/StopPoint/${record.stationID}/Arrivals`)).catch(() => ({ ok: false }));
  const railTask = rail ? request(new URL(`https://api.tfl.gov.uk/StopPoint/${record.stationID}/ArrivalDepartures?lineIds=${record.lineID}`)).catch(() => ({ ok: false })) : Promise.resolve({ ok: false });
  const [service, station] = await Promise.all([
    request(new URL(`https://api.tfl.gov.uk/Line/${record.lineID}/Status?detail=true`)),
    request(new URL(`https://api.tfl.gov.uk/StopPoint/${record.stationID}/Disruption?getFamily=true&includeRouteBlockedStops=true&flattenResponse=true`))
  ]);
  const authority = { mode: STATION_BOARD_LINES.get(record.lineID)?.mode, stationName: (id) => validBoard(id, record.lineID) ? STATION_BOARD_STATIONS.get(id)?.stationName : null, stationLines: id => STATION_BOARD_STATIONS.get(id)?.lineIDs || [], lineMode: line => STATION_BOARD_LINES.get(line)?.mode, isRailLine: line => STATION_BOARD_LINES.get(line)?.qualifiedRailDepartureSource === true };
  const is20 = service.ok && containsServiceClosed(service.value);
  const serviceObservation = service.ok && (!is20 || typeof service.headers?.age === 'string' && service.headers.age.trim().length > 0) ? httpObservation(service.headers, service.completedAt, 120000, { futureSkew: is20 ? 0 : 5000 }) : null;
  const serviceProofs = service.ok ? qualifyAvailability(service.value, record, 'lineStatus', serviceObservation, service.completedAt, londonClock, authority) : [];
  const stationProofs = station.ok ? qualifyAvailability(station.value, record, 'stationDisruptions', httpObservation(station.headers, station.completedAt, 120000), station.completedAt, londonClock) : [];
  const actualRequestAt = clock();
  const admissionProofs = retainAvailability(previous, { availabilityProofs: [...serviceProofs, ...stationProofs] }, record, actualRequestAt);
  const unknown20 = is20 && !serviceProofs.some((p) => p.scheduledClockOnly === true && (p.observedAt + 600000 > actualRequestAt || p.expiresAt + 600000 > actualRequestAt));
  const blocked = unknown20 || admissionProofs.some((p) => p.scheduledClockOnly !== true && (activeClosure(p, actualRequestAt) || expiredBarrier(p, actualRequestAt) || p.plannedUnavailable === true && p.expiresAt > actualRequestAt));
  const journeyDepartAt = blocked ? actualRequestAt : shiftedJourneyTime(service.value, serviceProofs, admissionProofs, actualRequestAt);
  const plannedURL = !blocked ? journeyURL(record, journeyDepartAt) : null;
  const journeyTask = plannedURL ? request(plannedURL) : Promise.resolve({ ok: false });
  const [arrivals, departures, journey, timetableResponses] = await Promise.all([arrivalTask, railTask, journeyTask, timetableTask]);
  const completedAt = clock(), sources = {};
  const add = (source, events, observation = null) => {
    // A fresh explicit empty rail read replaces only its exact source.
    if (events.length || observation && observation.expiresAt > completedAt) sources[source] = { ...(observation ? { expiresAt: observation.expiresAt } : {}), observedAt: events.length ? Math.max(...events.map((e) => e.receivedAt)) : observation.observedAt, events };
  };
  if (arrivals.ok) add('station-arrivals', parseStationArrivals(arrivals.value, record, arrivals.headers, arrivals.completedAt));
  if (departures.ok) add('rail-departures', parseRailDepartures(departures.value, record, departures.headers, departures.completedAt), Array.isArray(departures.value) && departures.value.length === 0 ? httpObservation(departures.headers, departures.completedAt, 90000, { cacheRequired: true }) : null);
  if (journey.ok) add('journey-planner', parseJourney(journey.value, record, journey.headers, journeyDepartAt, journey.completedAt, actualRequestAt));
  const selected = selectEvents({ sources }, record, completedAt);
  const usefulRail = selected.some((e) => e.sourceID === 'rail-departures' && e.kind === 'outgoingDeparture');
  const through = selected.some((e) => e.kind === 'throughArrival');
  const rawRows = Array.isArray(arrivals.value) ? arrivals.value.filter((row) => objectRow(row) && row.naptanId === record.stationID && row.lineId === record.lineID) : [];
  const terminalEvidence = rawRows.some((row) => row.destinationNaptanId === record.stationID || ['check front of train', 'see front of train'].includes(key(row.destinationName)) || isoClock(row.expectedArrival) <= completedAt);
  const retainedFacts = Boolean(previous.sources?.['at-station-destination']);
  if (retainedFacts || (!usefulRail && (!through || terminalEvidence))) {
    const facts = await request(new URL(`https://api.tfl.gov.uk/Line/${record.lineID}/Arrivals`));
    if (facts.ok) add('at-station-destination', parseDestinationFacts(facts.value, record, facts.headers, facts.completedAt));
  }
  // Recheck exact local revision before the final consumer clock. No request
  // clock is moved by this local read. Expected tuple/generation guards in the
  // authority store continue to protect return/cache/save/dispatch after awaits.
  if (renewalAsset) {
    try {
      const latest = await publicationAuthorityStore.readPublicationAsset(renewalAsset.identity.publicationSHA256);
      await publicationAuthorityStore.observePublicationRevision(latest.identity);
      if (['publicationSHA256','proofRevision','proofBodySHA256'].some(k => latest.identity[k] !== renewalAsset.identity[k])) renewalAsset = null;
    } catch { renewalAsset = null; }
  }
  const applicabilityAt = clock();
  const rejections = publicationRejection ? [publicationRejection] : [], availabilityProofs = [...(is20 ? serviceProofs : service.ok ? qualifyAvailability(service.value, record, 'lineStatus', serviceObservation, applicabilityAt, londonClock, authority) : []), ...(station.ok ? qualifyAvailability(station.value, record, 'stationDisruptions', httpObservation(station.headers, station.completedAt, 120000), applicabilityAt, londonClock) : [])];
  if (renewalAsset && timetableResponses) {
    const ageIsValid = response => typeof response.headers?.age === 'string' && /^[0-9]+$/.test(response.headers.age.trim());
    const strictServiceObservation = service.ok && ageIsValid(service) ? serviceObservation : null;
    const stationObservation = station.ok && ageIsValid(station) ? httpObservation(station.headers, station.completedAt, 120000) : null;
    const finalProofs = retainAvailability(previous, { availabilityProofs }, record, applicabilityAt);
    if (completePlannedApplicability({ value: service.value, observation: strictServiceObservation }, { value: station.value, observation: stationObservation }, finalProofs, record, applicabilityAt, londonClock, authority)) {
      try {
        sources.timetable = qualifyTimetable(renewalAsset, timetableResponses, record, { head: renewalHead, serviceObservation: strictServiceObservation, stationObservation, at: applicabilityAt });
      } catch (error) {
        if (['timetableChanged', 'unsupportedCalendar'].includes(error.timetableReason)) {
          const observations = timetableResponses.map(r => timetableHTTPObservation(r.headers, r.completedAt)?.observedAt).filter(Number.isFinite);
          if (observations.length === timetableResponses.length) rejections.push({ stationID: record.stationID, lineID: record.lineID, observedAt: Math.min(renewalHead.observedAt, ...observations), reason: error.timetableReason });
        }
      }
    }
  }
  let status = null;
  if (service.ok) {
    const observed = httpObservation(service.headers, service.completedAt, 120000);

    const details = Array.isArray(service.value) && service.value.length === 1 && service.value[0].id === record.lineID ? service.value[0].lineStatuses : null;
    if (observed && observed.expiresAt > applicabilityAt && Array.isArray(details) && details.length && details.every((d) => objectRow(d) && Number.isInteger(d.statusSeverity))) status = { label: details[0].statusSeverityDescription || 'Status unavailable', reason: details[0].reason || null, isDisrupted: details.some((d) => d.statusSeverity !== 10), expiresAt: observed.expiresAt };
  }

  // Availability masks presentation. It never destroys the original source
  // context or creates a permanent publication-style closure rejection.
  const merged = mergeContexts(previous, { sources, rejections, availabilityProofs, publicationIdentity, status, nextRefreshAt: now + config.workerIntervalMs }, record, applicabilityAt);
  return publicationAuthorityStore ? applyPublicationAuthority(merged, publicationAuthorityStore.publicationAuthority()) : merged;
}

// One query may move only past the connected literal restriction covering its
// actual dispatch. Persisted/partial authority never authorizes a search shift.
export function shiftedJourneyTime(raw, proofs, allProofs, actual) {
  const p = proofs.length === 1 ? proofs[0] : null;
  if (!p || p.scheduledClockOnly !== true || p.closed || p.plannedUnavailable === true || p.observedAt > actual || p.expiresAt <= actual || allProofs.some((v) => v.closed || v.plannedUnavailable === true || activeClosure(v, actual) || expiredBarrier(v, actual))) return actual;
  const periods = [];
  for (const d of raw?.[0]?.lineStatuses || []) {
    if (knownNonClosure(d)) continue;
    if (!Array.isArray(d.validityPeriods)) return actual;
    for (const w of d.validityPeriods) { const start = londonClock(w?.fromDate), end = londonClock(w?.toDate); if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return actual; periods.push({ validFrom: start, validUntil: end }); }
  }
  if (!periods.length || periods.length > 32 || periods.filter((w) => w.validUntil > actual).some((w) => !p.closureWindows.some((v) => v.validFrom === w.validFrom && v.validUntil === w.validUntil))) return actual;
  let cursor = actual;
  for (let count = 0; count <= periods.length + 1; count++) {
    const connected = periods.filter((w) => w.validFrom <= cursor && cursor < w.validUntil);
    if (!connected.length) return cursor;
    const end = Math.max(...connected.map((w) => w.validUntil));
    const civil = londonLocal(end).slice(0,16) + ':00';
    const minute = londonClock(civil);
    if (!Number.isFinite(minute)) return actual;
    cursor = minute < end ? minute + 60000 : minute;
    if (londonClock(londonLocal(cursor).slice(0,16) + ':00') !== cursor) return actual;
  }
  return actual;
}
