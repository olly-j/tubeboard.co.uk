// Private unrun draft: reviewed proof + complete raw profile qualification.
// No HEAD/metadata/304 alone can create or extend a timetable context.
import crypto from 'node:crypto';
import { parseBoundedJSON } from './bounded-json.js';
import { londonClock, londonLocal, validBoard, STATION_BOARD_STATIONS } from './station-board-v2.js';
import { dateKey, profilesOverlap, validOriginatingRanges } from './station-board-seed.js';
const URL = 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip';
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string';
const integer = Number.isSafeInteger;
const sha = v => str(v) && v.length === 64 && /^[0-9a-f]{64}$/.test(v);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (reason = 'timetableChanged') => { throw Object.assign(Error(reason), { timetableReason: reason }); };
const exact = (v, required, optional = []) => obj(v) && required.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const names = v => str(v) ? v.toLowerCase().replace(/ (underground|rail|dlr) station/g,'').replace(/\s*\([^)]*\)/g,'').trim() : '';
const civilNext = (day, delta) => { const d = new Date(day+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0,10); };
const weekday = day => new Date(day+'T12:00:00Z').getUTCDay()+1;
const list = (v, predicate) => Array.isArray(v) && v.every(predicate);
const strings = v => list(v,str);
function profileShape(p) {
  if (!exact(p,['name','count','sha256','weekdays'],['excludedJourneyKeys','publishedCount','publishedSHA256','originatingServiceDateRanges']) || !str(p.name) || !p.name.trim() || !integer(p.count) || p.count < 0 || !sha(p.sha256) || !list(p.weekdays,integer)) return false;
  if (Object.hasOwn(p,'publishedCount') && (!integer(p.publishedCount) || p.publishedCount < 0)) return false;
  if (Object.hasOwn(p,'publishedSHA256') && !sha(p.publishedSHA256)) return false;
  if (Object.hasOwn(p,'excludedJourneyKeys') && (!Array.isArray(p.excludedJourneyKeys) || p.excludedJourneyKeys.length>4096 || !p.excludedJourneyKeys.every(e => exact(e,['key','count']) && str(e.key) && integer(e.count) && e.count>0 && e.count<=4096))) return false;
  if (Object.hasOwn(p,'originatingServiceDateRanges') && !list(p.originatingServiceDateRanges,r => exact(r,['startDate','endDate']) && str(r.startDate) && str(r.endDate))) return false;
  return true;
}
function entryShape(e) {
  if (!exact(e,['lineID','stationID','status','profiles'],['gapReason','operatingStartDate','operatingEndDate','nonOperationBankHolidays','originatingDateGaps','xmlMembers','apiBodySHA256','directionalDefinitions','directionalSourceEvidence']) || ![e.lineID,e.stationID,e.status].every(str) || !list(e.profiles,profileShape)) return false;
  for (const k of ['operatingStartDate','operatingEndDate','apiBodySHA256']) if (Object.hasOwn(e,k) && !str(e[k])) return false;
  if (Object.hasOwn(e,'gapReason') && e.gapReason !== null && !str(e.gapReason)) return false;
  if (Object.hasOwn(e,'nonOperationBankHolidays') && typeof e.nonOperationBankHolidays !== 'boolean') return false;
  const gaps = v => list(v,g => exact(g,['serviceDate','reason']) && [g.serviceDate,g.reason].every(str));
  if (Object.hasOwn(e,'originatingDateGaps') && !gaps(e.originatingDateGaps) || Object.hasOwn(e,'xmlMembers') && !strings(e.xmlMembers)) return false;
  if (Object.hasOwn(e,'directionalDefinitions') && !list(e.directionalDefinitions,d => exact(d,['direction','profiles']) && str(d.direction) && list(d.profiles,profileShape))) return false;
  if (Object.hasOwn(e,'directionalSourceEvidence') && !list(e.directionalSourceEvidence,d => exact(d,['direction','apiBodySHA256','operatingStartDate','operatingEndDate','xmlMembers','originatingDateGaps']) && [d.direction,d.apiBodySHA256,d.operatingStartDate,d.operatingEndDate].every(str) && strings(d.xmlMembers) && gaps(d.originatingDateGaps))) return false;
  return true;
}
export function validatedPublicationProof(asset) {
  if (!asset?.identity || !sha(asset.identity.publicationSHA256) || !sha(asset.identity.proofBodySHA256) || !integer(asset.identity.proofRevision) || asset.identity.proofRevision < 1 || !asset.proofBytes) fail('unavailable');
  const bytes = Buffer.from(asset.proofBytes);
  if (digest(bytes)!==asset.identity.proofBodySHA256) fail('unavailable');
  const p = parseBoundedJSON(bytes,131072,64,true);
  if (!exact(p,['schemaVersion','publication','timezone','bankHolidayDates','holidayCoverageStart','holidayCoverageEnd','entries'],['holidaySource','canonicalKey','sourceParityEquivalence','qualificationScope','xmlPublications','coverage']) || p.schemaVersion!==1 || p.timezone!=='Europe/London' || !exact(p.publication,['url','sha256','capturedAt'],['publishedAt']) || p.publication.url!==URL || p.publication.sha256!==asset.identity.publicationSHA256 || !str(p.publication.capturedAt) || Object.hasOwn(p.publication,'publishedAt') && p.publication.publishedAt!==null && !str(p.publication.publishedAt) || !strings(p.bankHolidayDates) || p.bankHolidayDates.some(d=>!dateKey(d)) || new Set(p.bankHolidayDates).size!==p.bankHolidayDates.length || !dateKey(p.holidayCoverageStart) || !dateKey(p.holidayCoverageEnd) || p.holidayCoverageStart>p.holidayCoverageEnd || !list(p.entries,entryShape)) fail('unsupportedCalendar');
  for (const k of ['holidaySource','canonicalKey','sourceParityEquivalence','qualificationScope']) if (Object.hasOwn(p,k) && !str(p[k])) fail('unsupportedCalendar');
  if (Object.hasOwn(p,'xmlPublications') && !list(p.xmlPublications,m=>exact(m,['member','lineID','sha256','operatingStartDate','operatingEndDate'],['publishedAt','qualificationGap']) && Object.entries(m).every(([k,v])=>k==='publishedAt' && v===null || str(v)))) fail('unsupportedCalendar');
  if (Object.hasOwn(p,'coverage') && (!exact(p.coverage,['catalogueLineIDs','capturedLineIDs','uncapturedStationLinePairs']) || !strings(p.coverage.catalogueLineIDs) || !strings(p.coverage.capturedLineIDs) || !integer(p.coverage.uncapturedStationLinePairs))) fail('unsupportedCalendar');
  return p;
}
function definitions(entry) {
  if (entry.directionalDefinitions === undefined) { if (!entry.profiles.length) fail('unsupportedCalendar'); return [{ direction:null,profiles:entry.profiles }]; }
  const scopes=entry.directionalDefinitions;
  if (entry.profiles.length || !scopes.length || scopes.length>2 || new Set(scopes.map(s=>s.direction)).size!==scopes.length || scopes.some(s=>!['inbound','outbound'].includes(s.direction) || !s.profiles.length)) fail('unsupportedCalendar');
  return [...scopes].sort((a,b)=>a.direction.localeCompare(b.direction));
}
function validateCalendar(entry,sets) {
  const bounds={operatingStartDate:entry.operatingStartDate,operatingEndDate:entry.operatingEndDate};
  if (!dateKey(bounds.operatingStartDate) || !dateKey(bounds.operatingEndDate) || bounds.operatingStartDate>bounds.operatingEndDate || entry.nonOperationBankHolidays!==true) fail('unsupportedCalendar');
  for (const {profiles} of sets) {
    if (!profiles.length || profiles.length>64 || new Set(profiles.flatMap(p=>p.weekdays)).size!==7) fail('unsupportedCalendar');
    for (const p of profiles) {
      if (!p.weekdays.length || new Set(p.weekdays).size!==p.weekdays.length || p.weekdays.some(d=>d<1 || d>7)) fail('unsupportedCalendar');
      if (p.originatingServiceDateRanges!==undefined && !validOriginatingRanges(p.originatingServiceDateRanges,bounds,p.originatingServiceDateRanges?.[0]?.startDate)) fail('unsupportedCalendar');
    }
    for (let i=0;i<profiles.length;i++) for (let j=i+1;j<profiles.length;j++) if (profilesOverlap(profiles[i],profiles[j],bounds)) fail('unsupportedCalendar');
  }
}
export function selectedTimetableEntry(asset,record) {
  const proof=validatedPublicationProof(asset), entries=proof.entries.filter(e=>e.stationID===record.stationID && e.lineID===record.lineID);
  if (!validBoard(record.stationID,record.lineID) || entries.length!==1 || entries[0].status!=='qualified') fail('unsupportedCalendar');
  const entry=entries[0], sets=definitions(entry); validateCalendar(entry,sets); return {proof,entry,sets};
}
// Required authority DTO keys plus exact captured official metadata keys.
// Unknown root/clock/path/schedule fields withhold this TT source; metadata is
// never interpreted into additional clocks, rows, platforms or coverage.
// Exact retained official DTO object-key inventory; unrecognized metadata
// objects fail closed and never become clock/path authority. See fixture manifest.
const rawObjectKeys = {
  "$": [
    "$type",
    "direction",
    "lineId",
    "lineName",
    "stations",
    "stops",
    "timetable"
  ],
  "$.stations[]": [
    "$type",
    "icsId",
    "id",
    "lat",
    "lines",
    "lon",
    "modes",
    "name",
    "stationId",
    "status",
    "stopType",
    "topMostParentId",
    "zone"
  ],
  "$.stations[].lines[]": [
    "$type",
    "crowding",
    "id",
    "name",
    "routeType",
    "status",
    "type",
    "uri"
  ],
  "$.stations[].lines[].crowding": [
    "$type"
  ],
  "$.stops[]": [
    "$type",
    "hasDisruption",
    "icsId",
    "id",
    "lat",
    "lines",
    "lon",
    "modes",
    "name",
    "parentId",
    "stationId",
    "status",
    "stopType",
    "topMostParentId",
    "zone"
  ],
  "$.stops[].lines[]": [
    "$type",
    "crowding",
    "id",
    "name",
    "routeType",
    "status",
    "type",
    "uri"
  ],
  "$.stops[].lines[].crowding": [
    "$type"
  ],
  "$.timetable": [
    "$type",
    "departureStopId",
    "routes"
  ],
  "$.timetable.routes[]": [
    "$type",
    "schedules",
    "stationIntervals"
  ],
  "$.timetable.routes[].schedules[]": [
    "$type",
    "firstJourney",
    "knownJourneys",
    "lastJourney",
    "name",
    "periods"
  ],
  "$.timetable.routes[].schedules[].firstJourney": [
    "$type",
    "hour",
    "intervalId",
    "minute"
  ],
  "$.timetable.routes[].schedules[].knownJourneys[]": [
    "$type",
    "hour",
    "intervalId",
    "minute"
  ],
  "$.timetable.routes[].schedules[].lastJourney": [
    "$type",
    "hour",
    "intervalId",
    "minute"
  ],
  "$.timetable.routes[].schedules[].periods[]": [
    "$type",
    "frequency",
    "fromTime",
    "toTime",
    "type"
  ],
  "$.timetable.routes[].schedules[].periods[].frequency": [
    "$type",
    "highestFrequency",
    "lowestFrequency"
  ],
  "$.timetable.routes[].schedules[].periods[].fromTime": [
    "$type",
    "hour",
    "minute"
  ],
  "$.timetable.routes[].schedules[].periods[].toTime": [
    "$type",
    "hour",
    "minute"
  ],
  "$.timetable.routes[].stationIntervals[]": [
    "$type",
    "id",
    "intervals"
  ],
  "$.timetable.routes[].stationIntervals[].intervals[]": [
    "$type",
    "stopId",
    "timeToArrival"
  ]
};
function rawObjectShape(value,path='$') {
  if(Array.isArray(value)){for(const child of value)rawObjectShape(child,path+'[]');return;}
  if(obj(value)){const keys=rawObjectKeys[path];if(!keys || Object.keys(value).some(k=>!keys.includes(k)))fail();for(const [key,child]of Object.entries(value))rawObjectShape(child,path+'.'+key);}
}
function responseShape(v) {
  rawObjectShape(v);
  if (!exact(v,['lineId','stations','timetable'],['$type','lineName','direction','stops']) || !str(v.lineId) || Object.hasOwn(v,'direction') && !str(v.direction) || !Array.isArray(v.stations) || !exact(v.timetable,['departureStopId','routes'],['$type']) || !str(v.timetable.departureStopId) || !Array.isArray(v.timetable.routes)) fail();
  for (const stop of v.stations) if (!exact(stop,['id','name'],['$type','stationId','icsId','topMostParentId','modes','stopType','zone','lines','status','lat','lon']) || !str(stop.id) || !str(stop.name) || !stop.name.trim()) fail();
  for (const r of v.timetable.routes) {
    if (!exact(r,['stationIntervals','schedules'],['$type']) || !Array.isArray(r.stationIntervals) || !Array.isArray(r.schedules)) fail();
    for (const interval of r.stationIntervals) if (!exact(interval,['id','intervals'],['$type']) || !str(interval.id) || !/^[+-]?[0-9]+$/.test(interval.id) || !integer(Number(interval.id)) || !Array.isArray(interval.intervals) || !interval.intervals.length || !interval.intervals.every(c=>exact(c,['stopId'],['$type','timeToArrival']) && str(c.stopId) && c.stopId.length)) fail();
    for (const s of r.schedules) if (!exact(s,['name','knownJourneys'],['$type','firstJourney','lastJourney','periods']) || !str(s.name) || !Array.isArray(s.knownJourneys) || !s.knownJourneys.every(j=>exact(j,['hour','minute','intervalId'],['$type']) && str(j.hour) && str(j.minute) && /^[+-]?[0-9]+$/.test(j.hour) && /^[+-]?[0-9]+$/.test(j.minute) && integer(j.intervalId) && integer(Number(j.hour)) && integer(Number(j.minute)) )) fail();
  }
}
export function profileJourneys(response,name) {
  const rows=[]; let found=false;
  response.timetable.routes.forEach((route,routeIndex)=>{
    const paths=new Map();
    for (const interval of route.stationIntervals) { const id=Number(interval.id); if (paths.has(id)) fail(); paths.set(id,interval.intervals.map(c=>c.stopId)); }
    route.schedules.forEach((schedule,scheduleIndex)=>{
      if(schedule.name!==name)return; found=true;
      schedule.knownJourneys.forEach((j,journeyIndex)=>{ const path=paths.get(j.intervalId), hour=Number(j.hour), minute=Number(j.minute); if (!path || hour<0 || hour>=48 || minute<0 || minute>=60) fail(); rows.push({minute:hour*60+minute,path,routeIndex,scheduleIndex,journeyIndex,key:String(hour*60+minute).padStart(4,'0')+'|'+path.join('>')}); });
    });
  });
  if(!found)fail('unsupportedCalendar');return rows;
}
export const profileFingerprint = rows => digest(Buffer.from(rows.map(r=>r.key).sort().join('\n'),'utf8'));
function completeRows(response,profile) {
  const rows=profileJourneys(response,profile.name), exclusions=profile.excludedJourneyKeys;
  if(exclusions===undefined){if(profile.publishedCount!==undefined || profile.publishedSHA256!==undefined || rows.length!==profile.count || profileFingerprint(rows)!==profile.sha256)fail();return rows;}
  if(profile.publishedCount===undefined || profile.publishedSHA256===undefined || new Set(exclusions.map(e=>e.key)).size!==exclusions.length || profile.count!==profile.publishedCount+exclusions.reduce((n,e)=>n+e.count,0))fail();
  const counts=new Map(exclusions.map(e=>[e.key,e.count]));const retained=rows.filter(r=>{const count=counts.get(r.key)||0;if(count){counts.set(r.key,count-1);return false;}return true;});
  if(retained.length!==profile.publishedCount || profileFingerprint(retained)!==profile.publishedSHA256)fail();return retained;
}
export function timetableHTTPObservation(headers,completedAt,{official=false}={}) {
  const date=Date.parse(headers?.date||''), raw=headers?.age, age=typeof raw==='string' && /^[0-9]+$/.test(raw.trim()) ? Number(raw) : NaN;
  if(!Number.isFinite(date) || !Number.isFinite(age) || age<0 || age>600 || date>completedAt+(official?0:120000) || completedAt-date>600000)return null;
  const observedAt=completedAt-Math.max(age*1000,Math.max(0,completedAt-date));return completedAt<observedAt+600000 ? {observedAt,expiresAt:observedAt+600000} : null;
}
export function qualifyTimetable(asset,responses,record,{head,serviceObservation,stationObservation,at}) {
  const {proof,entry,sets}=selectedTimetableEntry(asset,record);
  if(!head || head.sha256!==asset.identity.publicationSHA256 || !serviceObservation || serviceObservation.expiresAt<=at || !stationObservation || stationObservation.expiresAt<=at || head.expiresAt<=at || !Array.isArray(responses) || responses.length!==sets.length)fail('unavailable');
  const observations=[head.observedAt,serviceObservation.observedAt,stationObservation.observedAt]; const rawHashes=[], events=[], rowEvidence=[], qualification=[]; const scopedKeys=new Map();
  const today=londonLocal(at).slice(0,10),tomorrow=londonClock(civilNext(today,1)+'T00:00:00');
  for(const scope of sets){
    const matched=responses.filter(r=>r.direction===scope.direction);if(matched.length!==1)fail('unavailable');
    const resource=matched[0],response=resource.value,observation=timetableHTTPObservation(resource.headers,resource.completedAt);
    if(!resource.ok || !sha(resource.bodySHA256) || !observation || observation.expiresAt<=at)fail('unavailable');observations.push(observation.observedAt);responseShape(response);
    if(response.lineId!==record.lineID || response.timetable.departureStopId!==record.stationID || scope.direction!==null && response.direction!==scope.direction)fail();
    const stationNames=new Map();for(const station of response.stations){if(stationNames.has(station.id))fail();stationNames.set(station.id,station.name);}
    const offered=new Set(response.timetable.routes.flatMap(r=>r.schedules.map(s=>s.name))), declared=new Set(scope.profiles.map(p=>p.name));if(offered.size!==declared.size || [...offered].some(n=>!declared.has(n)))fail();
    const keys=new Set([...declared].flatMap(name=>profileJourneys(response,name).map(r=>r.key)));
    for(const old of scopedKeys.values())if([...keys].some(k=>old.has(k)))fail();scopedKeys.set(scope.direction,keys);
    rawHashes.push({direction:scope.direction,sha256:resource.bodySHA256});
    for(const day of [civilNext(today,-1),today]){
      if(day<entry.operatingStartDate || day>entry.operatingEndDate || day<proof.holidayCoverageStart || day>proof.holidayCoverageEnd)fail('unsupportedCalendar');
      if(proof.bankHolidayDates.includes(day)){if(scope.profiles.some(p=>p.originatingServiceDateRanges!==undefined))fail('unsupportedCalendar');continue;}
      const eligible=scope.profiles.filter(p=>p.weekdays.includes(weekday(day)) && (p.originatingServiceDateRanges===undefined || p.originatingServiceDateRanges.some(r=>r.startDate<=day && day<=r.endDate)));
      if(eligible.length!==1)fail('unsupportedCalendar');const profile=eligible[0], rows=completeRows(response,profile);
      qualification.push({publicationDirection:scope.direction,serviceDay:day,profileName:profile.name,retainedCount:rows.length,retainedSHA256:profileFingerprint(rows)});
      for(const r of rows){
        const serviceDay=civilNext(day,Math.floor(r.minute/1440)), minute=r.minute%1440;
        const departure=londonClock(serviceDay+'T'+String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0')+':00');if(!Number.isFinite(departure))fail('unsupportedCalendar');
        if(departure<at || departure<londonClock(today+'T00:00:00') || departure>=tomorrow)continue;
        const destinationID=r.path.at(-1), destination=STATION_BOARD_STATIONS.get(destinationID);
        if(destinationID===record.stationID && !r.path.slice(0,-1).some(id=>id!==record.stationID && validBoard(id,record.lineID)) || !validBoard(destinationID,record.lineID) || r.path.some(id=>!validBoard(id,record.lineID)) || stationNames.has(destinationID) && names(stationNames.get(destinationID))!==names(destination.stationName))fail();
        const bank=r.path.includes('940GZZLUBNK'),cross=r.path.includes('940GZZLUCHX');if(record.lineID==='northern' && bank && cross)fail();const via=record.lineID==='northern' ? bank?'Bank':cross?'Charing Cross':null : null;
        const id=`schedule:${record.lineID}:${record.stationID}:${day}:${r.routeIndex}:${r.scheduleIndex}:${scope.direction===null?'':scope.direction+'.'}${r.journeyIndex}`;
        const directionFields=scope.direction===null?{}:{publicationDirection:scope.direction};
        events.push({id,stationID:record.stationID,lineID:record.lineID,sourceID:'timetable',kind:'outgoingDeparture',timeEvidence:'scheduledDeparture',destination:stationNames.get(destinationID)||destination.stationName,destinationStationID:destinationID,routeStationIDs:r.path,via,time:departure,platform:null,direction:null,providerDirection:scope.direction,...directionFields});
        rowEvidence.push({id,serviceDay:day,profileName:profile.name,profileSHA256:profile.publishedSHA256??profile.sha256,weekdays:profile.weekdays,serviceMinute:r.minute,isBankHoliday:false,...directionFields,...(profile.originatingServiceDateRanges===undefined?{}:{originatingServiceDateRanges:profile.originatingServiceDateRanges})});
      }
    }
  }
  const observedAt=Math.min(...observations), expiresAt=Math.min(observedAt+600000,tomorrow);
  if(!Number.isFinite(observedAt) || observedAt>at || at>=expiresAt || new Set(events.map(e=>e.id)).size!==events.length)fail('unavailable');
  for(const e of events){e.receivedAt=observedAt;e.expiresAt=expiresAt;}
  return {observedAt,expiresAt,events,qualificationOrigin:'server',evidence:{publication:{url:URL,sha256:proof.publication.sha256,timezone:'Europe/London',operatingStartDate:entry.operatingStartDate,operatingEndDate:entry.operatingEndDate,holidayCoverageStart:proof.holidayCoverageStart,holidayCoverageEnd:proof.holidayCoverageEnd,nonOperationBankHolidays:true},publicationProofIdentity:{...asset.identity},independentPublicationObservedAt:head.observedAt,...(entry.directionalDefinitions===undefined?{sourceSHA256:rawHashes[0].sha256}:{publicationDirections:sets.map(s=>s.direction)}),rawTimetableResponses:rawHashes,rows:rowEvidence,qualification}};
}
