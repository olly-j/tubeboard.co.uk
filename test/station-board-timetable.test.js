// PRIVATE UNRUN tests. Missing actual generated/Swift parity artifact fails;
// synthetic digests below are never interpreted as publisher/current evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { selectedTimetableEntry,qualifyTimetable,profileFingerprint,profileJourneys,timetableHTTPObservation } from '../server/station-board-timetable.js';
import { completePlannedApplicability,qualifyAvailability } from '../server/station-board-availability.js';
import { mergeContexts,selectEvents,buildStationBoardState,londonClock,londonLocal,STATION_BOARD_LINES,STATION_BOARD_STATIONS } from '../server/station-board-v2.js';
import { admitPlannedSeed } from '../server/station-board-seed.js';
import { now,record,sha,headers,observation,response,assetFor,wrap,qualify,authority,requiredActualParity } from './timetable-renewal-helpers.js';
// Compare JSON wire values exactly; null-prototype parsing remains a production safeguard.
const jsonWire=value=>JSON.parse(JSON.stringify(value));
function changedAsset(asset,fn){const p=structuredClone(asset.proof);fn(p);const proofBytes=Buffer.from(JSON.stringify(p));return {proof:p,proofBytes,identity:{...asset.identity,proofBodySHA256:crypto.createHash('sha256').update(proofBytes).digest('hex')}};}
test('legacyPublisherParityAtOriginalClocks',async()=>{
  const parity=await requiredActualParity();assert.equal(parity.provenance.executedSwift,true);assert.equal(parity.provenance.generatedPublisherProofExecuted,true);
  const legacy=parity.cases.filter(c=>c.publicationDirections===undefined);assert.equal(legacy.length,13);
  for(const c of legacy){const asset={...c.asset,proofBytes:Buffer.from(c.asset.proofBytesBase64,'base64')};const context=qualifyTimetable(asset,c.responses,c.record,c.arguments);assert.deepEqual(context.events,c.expectedSwift.events);assert.deepEqual(jsonWire(context.evidence.rows),c.expectedSwift.rowEvidence);assert.deepEqual(context.evidence.qualification,c.expectedSwift.qualification);assert.equal(context.observedAt,c.expectedSwift.observedAt);assert.equal(context.expiresAt,c.expectedSwift.expiresAt);}
});
test('declaredDirectionalGoodgeSameSourceParity',async()=>{
  const parity=await requiredActualParity(),c=parity.cases.find(c=>c.record.stationID==='940GZZLUGDG');assert.ok(c);assert.deepEqual(c.publicationDirections,['inbound','outbound']);
  const context=qualifyTimetable({...c.asset,proofBytes:Buffer.from(c.asset.proofBytesBase64,'base64')},c.responses,c.record,c.arguments);
  assert.deepEqual(context.events,c.expectedSwift.events);assert.deepEqual(jsonWire(context.evidence.rows),c.expectedSwift.rowEvidence);assert.deepEqual(context.evidence.qualification,c.expectedSwift.qualification);assert.deepEqual(context.evidence.publicationDirections,c.publicationDirections);assert.equal(context.observedAt,c.expectedSwift.observedAt);assert.equal(context.expiresAt,c.expectedSwift.expiresAt);
});
test('directionalIncompleteForeignAndCrossScopeOverlap',()=>{
  const inbound=response(720,['940GZZLUBNK'],'inbound'),outbound=response(780,['940GZZLUCHX'],'outbound'),asset=assetFor([inbound,outbound]);
  assert.equal(qualify(asset,[inbound,outbound]).events.length,2);
  assert.throws(()=>qualify(asset,[inbound]));const wrong=structuredClone(outbound);wrong.direction='northbound';assert.throws(()=>qualify(asset,[inbound,wrong]));wrong.direction='outbound';wrong.lineId='central';assert.throws(()=>qualify(asset,[inbound,wrong]));
  const overlap=response(720,['940GZZLUBNK'],'outbound');assert.throws(()=>qualify(assetFor([inbound,overlap]),[inbound,overlap]));
  const invalid=changedAsset(asset,p=>p.entries[0].directionalDefinitions=null);assert.throws(()=>qualify(invalid,[inbound,outbound]));
  const unknown=changedAsset(asset,p=>p.entries[0].profiles.push({name:'unknown',count:1,sha256:'a'.repeat(64),weekdays:[1],foreign:1}));assert.throws(()=>qualify(unknown,[inbound,outbound]));const rawUnknown=structuredClone(inbound);rawUnknown.timetable.routes[0].schedules[0].knownJourneys[0].foreignClock='12:00';assert.throws(()=>qualify(asset,[rawUnknown,outbound]));
});
test('profileMultiplicityLogicalIDsAndWholePaths',()=>{
  const raw=response();raw.timetable.routes[0].schedules[0].knownJourneys.push({...raw.timetable.routes[0].schedules[0].knownJourneys[0]});const asset=assetFor([raw]);assert.equal(qualify(asset,[raw]).events.length,2);assert.notEqual(qualify(asset,[raw]).events[0].id,qualify(asset,[raw]).events[1].id);
  const missing=structuredClone(raw);missing.timetable.routes[0].schedules[0].knownJourneys.pop();assert.throws(()=>qualify(asset,[missing]));
  const loop=response(720,['940GZZLUBNK','940GZZLUCHX','940GZZLUBNK']);assert.equal(profileJourneys(loop,'synthetic-all-days')[0].path.length,3);assert.throws(()=>qualify(assetFor([loop]),[loop])); // both Northern vias are deliberately unsupported
  const subset=changedAsset(asset,p=>{const prof=p.entries[0].profiles[0],rows=profileJourneys(raw,prof.name);prof.excludedJourneyKeys=[{key:rows[0].key,count:1}];prof.publishedCount=1;prof.publishedSHA256=profileFingerprint(rows.slice(1));});
  assert.equal(qualify(subset,[raw]).events.length,1);const unknown=structuredClone(raw);unknown.timetable.routes[0].schedules[0].knownJourneys.push({hour:'13',minute:'1',intervalId:7});assert.throws(()=>qualify(subset,[unknown]));
});
test('calendarNeededDayRangesHolidaysMidnightAndDST',()=>{
  const raw=response(),asset=assetFor([raw]);const hole=changedAsset(asset,p=>{p.entries[0].profiles[0].originatingServiceDateRanges=[{startDate:'2026-10-03',endDate:'2026-12-31'}];});assert.throws(()=>qualify(hole,[raw]),/unsupportedCalendar/);
  const holiday=changedAsset(hole,p=>p.bankHolidayDates=['2026-10-03']);assert.throws(()=>qualify(holiday,[raw]));
  const invalid=changedAsset(asset,p=>p.entries[0].operatingStartDate='2026-02-30');assert.throws(()=>qualify(invalid,[raw]));
  assert.ok(Number.isNaN(londonClock('2026-10-25T01:30:00')));assert.ok(Number.isNaN(londonClock('2026-03-29T01:30:00')));
  const midnight=Date.parse('2026-10-03T22:59:00Z'),r=response(1439);const context=qualifyTimetable(assetFor([r]),[wrap(r,midnight)],record,{head:{sha256:sha,...observation(midnight)},serviceObservation:observation(midnight),stationObservation:observation(midnight),at:midnight});
  assert.ok(context.expiresAt<=londonClock('2026-10-04T00:00:00'));
});
test('commonTTExpiryShortHeadersAndFinalControls',()=>{
  for(const directional of [false,true]){
    const raws=directional?[response(720,['940GZZLUBNK'],'inbound'),response(780,['940GZZLUCHX'],'outbound')]:[response()];
    const asset=assetFor(raws),resources=raws.map(raw=>({...wrap(raw),headers:{...headers(now),'cache-control':'max-age=1'}}));
    const controls={serviceObservation:{observedAt:now,expiresAt:now+10000},stationObservation:{observedAt:now,expiresAt:now+10000}};
    const context=qualify(asset,resources,now+2000,controls);
    assert.equal(context.observedAt,now);assert.equal(context.expiresAt,now+600000);
    assert.throws(()=>qualify(asset,resources,now+10000,controls),/unavailable/);
    assert.ok(timetableHTTPObservation(resources[0].headers,now+2000));
  }
  const details=[{id:record.lineID,lineStatuses:[{statusSeverity:10,statusSeverityDescription:'Good Service'}]}];const at=now+30000,control={observedAt:now,expiresAt:at};assert.equal(completePlannedApplicability({value:details,observation:control},{value:[],observation:control},[],record,at,londonClock,authority),false);
});
test('completeAvailabilityMatchesAPP',()=>{
  for(const line of STATION_BOARD_LINES.keys()){
    const chosen=[...STATION_BOARD_STATIONS.values()].find(s=>s.lineIDs.includes(line)),r={...record,lineID:line,stationID:chosen.stationID},obs=observation(now);
    const values=[{id:line,lineStatuses:[{statusSeverity:10,statusSeverityDescription:'Good Service'}]}];const proofs=[...qualifyAvailability(values,r,'lineStatus',obs,now,londonClock,authority),...qualifyAvailability([],r,'stationDisruptions',obs,now,londonClock,authority)];assert.equal(completePlannedApplicability({value:values,observation:obs},{value:[],observation:obs},proofs,r,now,londonClock,authority),true);
    assert.equal(completePlannedApplicability({value:values,observation:obs},{value:[],observation:obs},proofs,r,obs.expiresAt,londonClock,authority),false);
  }
  const service=[{id:record.lineID,lineStatuses:[{statusSeverity:9,statusSeverityDescription:'Minor Delays'}]}],obs=observation(now),station=[];
  const proofs=[...qualifyAvailability(service,record,'lineStatus',obs,now,londonClock,authority),...qualifyAvailability(station,record,'stationDisruptions',obs,now,londonClock,authority)];assert.equal(completePlannedApplicability({value:service,observation:obs},{value:station,observation:obs},proofs,record,now,londonClock,authority),true);
  const info=[{stationAtcoCode:record.stationID,atcoCode:record.stationID,mode:'tube',type:'Information',fromDate:'2026-10-03T09:00:00Z',toDate:'2026-10-03T15:00:00Z'}];assert.equal(completePlannedApplicability({value:service,observation:obs},{value:info,observation:obs},proofs.filter(p=>p.sourceScope==='lineStatus'),record,now,londonClock,authority),true);
  info[0].direction='inbound';assert.equal(completePlannedApplicability({value:service,observation:obs},{value:info,observation:obs},proofs,record,now,londonClock,authority),false);
});
test('completeEmptyVsUnavailableAndExplicitRejection',()=>{
  const raw=response(),context=qualify(assetFor([raw]),[raw]),old={sources:{timetable:context}};
  assert.equal(timetableHTTPObservation(headers(now+1),now+1).observedAt,now); // HTTP Date has whole-second precision.
  const later=now+1000;
  const past=response(600),empty=qualifyTimetable(assetFor([past]),[wrap(past,later)],record,{head:{sha256:sha,...observation(later)},serviceObservation:observation(later),stationObservation:observation(later),at:later});
  assert.deepEqual(empty.events,[]);assert.equal(empty.observedAt,later);assert.equal(empty.expiresAt,later+600000);
  const merged=mergeContexts(old,{sources:{timetable:empty}},record,later);assert.deepEqual(merged.sources.timetable.events,[]);assert.ok(mergeContexts(old,{},record,later).sources.timetable.events.length);
  const rejected=mergeContexts(old,{rejections:[{stationID:record.stationID,lineID:record.lineID,observedAt:now,reason:'timetableChanged'}]},record,later);assert.equal(rejected.sources.timetable,undefined);
});
test('actualSwiftSeedRoundtripAndLegacyClients',async()=>{
  const parity=await requiredActualParity();assert.ok(parity.actualSwiftSeedBytesBase64);const bytes=Buffer.from(parity.actualSwiftSeedBytesBase64,'base64');assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),parity.actualSwiftSeedSHA256);const seed=JSON.parse(bytes);
  assert.deepEqual(admitPlannedSeed(seed,parity.registration,parity.seedAdmissionAt).errors,[]);const malformed=structuredClone(seed);malformed.contexts[0].publicationDirections=['northbound'];assert.ok(admitPlannedSeed(malformed,parity.registration,parity.seedAdmissionAt).errors.length);
});
test('compactAndAPNsAuthorityStillBounded',()=>{
  const context=qualify(assetFor(),[response()]);const state=buildStationBoardState(record,{sources:{timetable:context}},now);assert.ok(Buffer.byteLength(JSON.stringify(state))<=3500);assert.equal(selectEvents({sources:{timetable:context}},record,now).length,1);assert.equal(selectEvents({sources:{timetable:context}},record,now+600001).length,0);
  const makePlans=source=>[0,1,2].map(index=>({...context.events[0],id:`${source}-synthetic-${index}`,sourceID:source,time:context.events[0].time+index*60000}));
  const facts=[2,4,6].map(platform=>({...context.events[0],id:`fact-${platform}`,sourceID:'at-station-destination',kind:'outgoingDestinationOnly',timeEvidence:null,time:null,platform:'Platform '+platform,expiresAt:now+90000}));
  const cache={sources:{timetable:{...context,events:makePlans('timetable')},'journey-planner':{observedAt:now,events:makePlans('journey-planner')},'at-station-destination':{observedAt:now,events:facts}}};
  const nine=buildStationBoardState(record,cache,now);assert.ok(nine.arrivals.length<=9);assert.ok(nine.arrivals.some(r=>r.timeEvidence==='destinationOnly'));assert.ok(Buffer.byteLength(JSON.stringify(nine))<=3500);
  const long=structuredClone(cache);for(const c of Object.values(long.sources))for(const e of c.events)if(e.kind==='outgoingDeparture')e.destination+=' '+('unrepresentable '.repeat(100));const fallback=buildStationBoardState(record,long,now);assert.ok(Buffer.byteLength(JSON.stringify(fallback))<=3500);assert.ok(fallback.arrivals.every(r=>r.timeEvidence!=='scheduledDeparture'));assert.ok(fallback.arrivals.some(r=>r.timeEvidence==='destinationOnly'));const wire={aps:{timestamp:Math.floor(now/1000),event:'update','content-state':fallback}};assert.ok(Buffer.byteLength(JSON.stringify(wire))<=4096);
});
