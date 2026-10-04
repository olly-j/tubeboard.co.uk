// Private UNRUN synthetic proof helpers. These proof digests are API-derived
// test inputs, NEVER publisher qualification, resource assets or source passes.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { qualifyTimetable, profileJourneys, profileFingerprint } from '../server/station-board-timetable.js';
import { STATION_BOARD_STATIONS, STATION_BOARD_LINES, httpObservation } from '../server/station-board-v2.js';
export const now=Date.parse('2026-10-03T10:00:00Z');
export const sha='a'.repeat(64), record={stationID:'940GZZLUEGW',lineID:'northern',plannedPresentationVersion:2,timetablePublicationAuthorityVersion:1,selectionMode:'allPlatforms'};
export const headers=at=>({date:new Date(at).toUTCString(),age:'0','cache-control':'public,max-age=30'});
export const observation=at=>({observedAt:at,expiresAt:at+120000});
export function response(time=720,path=['940GZZLUBNK'],direction=null){
  return {lineId:record.lineID,...(direction===null?{}:{direction}),stations:[{id:path.at(-1),name:STATION_BOARD_STATIONS.get(path.at(-1)).stationName}],timetable:{departureStopId:record.stationID,routes:[{stationIntervals:[{id:'7',intervals:path.map(stopId=>({stopId}))}],schedules:[{name:'synthetic-all-days',knownJourneys:[{hour:String(Math.floor(time/60)),minute:String(time%60),intervalId:7}]}]}]}};
}
export function assetFor(responses=[response()]){
  const directional=responses[0].direction!==undefined;
  const profiles=r=>[{name:'synthetic-all-days',count:profileJourneys(r,'synthetic-all-days').length,sha256:profileFingerprint(profileJourneys(r,'synthetic-all-days')),weekdays:[1,2,3,4,5,6,7]}];
  const proof={schemaVersion:1,publication:{url:'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip',sha256:sha,capturedAt:'synthetic'},timezone:'Europe/London',bankHolidayDates:[],holidayCoverageStart:'2026-09-01',holidayCoverageEnd:'2026-12-31',entries:[{lineID:record.lineID,stationID:record.stationID,status:'qualified',operatingStartDate:'2026-09-01',operatingEndDate:'2026-12-31',nonOperationBankHolidays:true,profiles:directional?[]:profiles(responses[0]),...(directional?{directionalDefinitions:responses.map(r=>({direction:r.direction,profiles:profiles(r)}))}:{})}]};
  const proofBytes=Buffer.from(JSON.stringify(proof));return {proof,proofBytes,identity:{publicationSHA256:sha,proofRevision:1,proofBodySHA256:crypto.createHash('sha256').update(proofBytes).digest('hex')}};
}
export function wrap(value,at=now){return {ok:true,value,headers:headers(at),completedAt:at,bodySHA256:crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),direction:value.direction??null};}
export function qualify(asset,responses,at=now,controls={serviceObservation:observation(now),stationObservation:observation(now)}){return qualifyTimetable(asset,responses.map(r=>r.ok===undefined?wrap(r):r),record,{head:{sha256:sha,...observation(now)},...controls,at});}
export function reply(value,at=now,extra={}){return new Response(value===null?null:JSON.stringify(value),{status:200,headers:{...headers(at),...extra}});}
export function fakeAuthority(asset){
  let state={};return {state,publicationAuthority:()=>state,observeOfficialPublication:async head=>{state.officialIdentity=head;},observePublicationRevision:async identity=>{state.revisions=[{identity}];},readPublicationAsset:async()=>asset};
}
export function refreshFetch(asset,responses={legacy:response()},requests=[]){return async url=>{
  const u=new URL(url);requests.push(u.pathname+u.search);
  if(u.hostname==='tfl.gov.uk')return reply(null,now,{'x-amz-meta-sha256':sha});
  if(u.pathname.endsWith('/Timetable/'+record.stationID))return reply(responses[u.searchParams.get('direction')||'legacy']);
  if(u.pathname.endsWith('/Status'))return reply([{id:record.lineID,modeName:'tube',lineStatuses:[{statusSeverity:10,statusSeverityDescription:'Good Service'}]}]);
  if(u.pathname.endsWith('/Disruption')||u.pathname.endsWith('/Arrivals'))return reply([]);
  if(u.pathname.includes('/Journey/'))return reply({journeys:[]});
  throw Error('Unexpected mock URL '+u.pathname);
};}
export const authority={mode:'tube',stationName:id=>STATION_BOARD_STATIONS.get(id)?.stationName,stationLines:id=>STATION_BOARD_STATIONS.get(id)?.lineIDs||[],lineMode:id=>STATION_BOARD_LINES.get(id)?.mode,isRailLine:id=>STATION_BOARD_LINES.get(id)?.qualifiedRailDepartureSource===true};
export async function requiredActualParity(){const p=new URL('./fixtures/timetable-renewal/actual-swift-parity.json',import.meta.url);return JSON.parse(await fs.readFile(p,'utf8'));}
