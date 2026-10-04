import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATION_BOARD_LINES, STATION_BOARD_STATIONS, validBoard, httpObservation, londonClock, londonLocal, parseRailDepartures, parseJourney, refreshStationBoard, buildStationBoardState, mergeContexts, compactEvents, shiftedJourneyTime, selectEvents, nextBoundary } from '../server/station-board-v2.js';
import { qualifyAvailability, validAvailability, retainAvailability, blocksScheduled, activeClosure } from '../server/station-board-availability.js';
import { LiveActivityStore, validateTokenPayload, loadConfig, runLiveActivityWorkerCycle, registrationTuple, buildApnsPayload } from '../server/live-activity.js';
import { admitPlannedSeed } from '../server/station-board-seed.js';
const base = new URL('./fixtures/final-app-contract/', import.meta.url);
const fixture = async (name) => JSON.parse(await fs.readFile(new URL(name, base)));
const now = Date.parse('2026-10-02T02:46:43Z');
const header = (at = now, age = 0, ttl = 30) => ({ date: new Date(at).toUTCString(), age: String(age), 'cache-control': `max-age=${ttl}` });
const record = { activityID:'synthetic-final', installID:'synthetic-final-install', stationID:'910GROMFORD',lineID:'liberty',selectionMode:'allPlatforms',pushTokenHex:'abcd'.repeat(16),tokenUpdatedAt:new Date(now).toISOString(),appBundleID:'OllyJ.My-Train-Times',appVersion:'1',buildNumber:'1',environment:'sandbox',contentStateContract:'station-board-v2',plannedPresentationVersion:2 };
const authority = (r) => ({ mode:STATION_BOARD_LINES.get(r.lineID).mode, stationName:(id) => validBoard(id,r.lineID) ? STATION_BOARD_STATIONS.get(id)?.stationName : null });
const e = (id, source='journey-planner', time=now+100000, extra={}) => ({id,stationID:record.stationID,lineID:record.lineID,sourceID:source,kind:'outgoingDeparture',timeEvidence:'scheduledDeparture',time,destination:'Upminster',destinationStationID:'910GUPMNSTR',receivedAt:now,expiresAt:now+120000,platform:null,...extra});
const context = (...events) => ({sources:Object.fromEntries([...new Set(events.map(e=>e.sourceID))].map(s=>[s,{observedAt:Math.max(...events.filter(e=>e.sourceID===s).map(e=>e.receivedAt)),events:events.filter(e=>e.sourceID===s)}]))});
const proofs = (raw,r=record,at=now,headers=header(at)) => qualifyAvailability(raw,r,'lineStatus',httpObservation(headers,at,120000,{futureSkew:0}),at,londonClock,authority(r));
const wireVisible = (state,at) => {
 const apple=978307200000, p=state.plannedAvailability?.proofs.map(p=>({...p,observedAt:p.observedAt*1000+apple,expiresAt:p.expiresAt*1000+apple,closureWindows:p.closureWindows?.map(w=>({validFrom:w.validFrom*1000+apple,validUntil:w.validUntil*1000+apple}))}))||[];
 return compactEvents(state.arrivals.map(row=>({...row,stationID:record.stationID,lineID:record.lineID,sourceID:row.plannedSourceID,kind:'outgoingDeparture',time:row.expectedArrival*1000+apple,timeEvidence:row.timeEvidence})).filter(row=>row.expiresAt*1000+apple>at && row.time>=at && (row.timeEvidence!=='scheduledDeparture'||!retainAvailability({availabilityProofs:p},{},record,at).some(p=>blocksScheduled(p,row.time,at))))).slice(0,3).map(r=>r.id);
};

test('all seven retained incoming rail sources use estimated arrival only, original headers, own expiry and source-local rows',async()=>{
 const counts={elizabeth:14,liberty:0,lioness:8,mildmay:9,suffragette:4,weaver:4,windrush:11};
 for(const m of await fixture('rail-provenance.json')) {
  const bytes=await fs.readFile(new URL(m.filename,base));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),m.sha256);
  const at=Date.parse(m.receivedAt),r={...record,stationID:m.stationID,lineID:m.lineID},raw=JSON.parse(bytes),rows=parseRailDepartures(raw,r,m.headers,at);
  assert.equal(rows.filter(e=>e.kind==='incomingArrival').length,counts[m.lineID]);
  for(const incoming of rows.filter(e=>e.kind==='incomingArrival')) {assert.equal(incoming.timeEvidence,'arrivalPrediction');assert.ok(raw.some(r=>Date.parse(r.estimatedTimeOfArrival)===incoming.time));assert.equal(incoming.receivedAt,Date.parse(m.headers.date));assert.equal(incoming.expiresAt,Date.parse(m.headers.date)+30000);assert.equal(selectEvents(context(incoming),r,incoming.time+1).length,0);assert.equal(selectEvents(context(incoming),{...r,selectionMode:'platform',platformID:incoming.platform||'6',platformLabel:incoming.platform||'6'},at).length,0);}
  assert.equal(selectEvents(context(...rows),r,Date.parse(m.headers.date)+30000).length,0);
 }
});

test('incoming schedule-only/elapsed/cancelled/conflicting platforms cannot invent arrival prediction; modern empty replaces source monotonically',()=>{
 const raw={naptanId:record.stationID,destinationNaptanId:record.stationID,destinationName:'Romford',departureStatus:'OnTime',estimatedTimeOfArrival:new Date(now+70000).toISOString(),scheduledTimeOfArrival:new Date(now+90000).toISOString(),platformName:'6'};
 const rows=parseRailDepartures([raw],record,header(now,0,90),now);assert.equal(rows.length,1);assert.equal(rows[0].scheduledArrival,now+90000);assert.equal(nextBoundary(context(...rows),record,now+69000),now+70001);
 for(const change of [{estimatedTimeOfArrival:undefined},{estimatedTimeOfArrival:new Date(now-1).toISOString()},{estimatedTimeOfArrival:'2026-10-02T02:47:53'},{departureStatus:'Cancelled'},{destinationName:'Upminster'},{lineId:'elizabeth'}]) assert.equal(parseRailDepartures([{...raw,...change}],record,header(now,0,90),now).length,0);
 assert.equal(parseRailDepartures([raw,{...raw,platformName:'5'}],record,header(now,0,90),now).length,0);
 const previous=context(...rows),fresh={sources:{'rail-departures':{observedAt:now+1000,events:[]}}};
 assert.deepEqual(mergeContexts(previous,fresh,record,now+1000).sources['rail-departures'].events,[]);assert.equal(mergeContexts(previous,{sources:{'rail-departures':{observedAt:now,events:[]}}},record,now+1000).sources['rail-departures'].events.length,1);
 const state=buildStationBoardState(record,previous,now);assert.equal(state.arrivals[0].timeEvidence,'reportedIncomingArrival');assert.equal(state.staleAt*1000+978307200000,now+70001);
});

test('actual three ServiceClosed captures preserve original authority and literal scheduled disagreement, not physical closure',async()=>{
 for(const [line,station,receipt,age] of [['northern','940GZZLUEGW','2026-10-02T02:46:33Z',27],['jubilee','940GZZLUSTM','2026-10-02T02:46:40Z',0],['liberty','910GROMFORD','2026-10-02T02:46:43Z',0]]) {
  const r={...record,lineID:line,stationID:station},at=Date.parse(receipt),raw=await fixture(`tb085-${line}-service-closed-status.json`),p=proofs(raw,r,at,header(at,age))[0];
  assert.equal(p.scheduledClockOnly,true);assert.equal(p.closed,false);assert.equal(p.plannedUnavailable,undefined);assert.equal(p.observedAt,at-age*1000);assert.equal(p.expiresAt,at+(30-age)*1000);
  for(const offset of [0,31000]) {assert.equal(activeClosure(p,at+offset),false);assert.equal(blocksScheduled(p,Date.parse('2026-10-02T05:12:00Z'),at+offset),true);assert.equal(blocksScheduled(p,Date.parse('2026-10-02T06:11:00Z'),at+offset),false);}
  assert.equal(shiftedJourneyTime(raw,[p],[p],at),line==='northern'?Date.parse('2026-10-02T05:45:00Z'):londonClock(raw[0].lineStatuses[0].validityPeriods[0].toDate));assert.equal(shiftedJourneyTime(raw,[p],[p],p.expiresAt),p.expiresAt);
 }
});

test('strict source primitives/concerns/mode/route scopes preserve conservative clock-only windows but never qualify a shift',async()=>{
 const original=await fixture('tb085-liberty-service-closed-status.json');
 for(const mutate of [r=>r[0].modeName='tube',r=>r[0].lineStatuses[0].concernedLines=null,r=>r[0].lineStatuses[0].concernedLines=[],r=>r[0].lineStatuses[0].concernedLines=[{id:'elizabeth'}],r=>r[0].lineStatuses[0].concernedLines=[{id:'liberty',direction:'inbound'}],r=>r[0].lineStatuses[0].disruption.affectedRoutes[0].isEntireRouteSection=1,r=>r[0].lineStatuses[0].disruption.affectedRoutes[0].routeSectionNaptanEntrySequence[0].ordinal=true]) {
  const raw=structuredClone(original);mutate(raw);const p=proofs(raw)[0];assert.equal(p.plannedUnavailable,true);assert.equal(shiftedJourneyTime(raw,[p],[p],now),now);if(p.scheduledClockOnly) {assert.equal(blocksScheduled(p,Date.parse('2026-10-02T06:11:00Z'),now+31000),false);}
 }
 const positive=structuredClone(original);positive[0].lineStatuses[0].concernedLines=[{id:'liberty'}];assert.equal(proofs(positive)[0].plannedUnavailable,undefined);
 const p=proofs(original)[0];for(const flag of [null,'true',1,{}])assert.equal(validAvailability({...p,scheduledClockOnly:flag},record),false);
 assert.equal(validAvailability({...p,scheduledClockOnly:true,closureWindows:[]},record),false);assert.equal(validAvailability({...p,scheduledClockOnly:true,closed:true},record),false);
 const closed={...p,closed:true,scheduledClockOnly:undefined,expiresAt:now+30000,closureWindows:[{validFrom:now-1000,validUntil:now+60000}]};const newer={...p,observedAt:now+1000,expiresAt:now+31000};
 for(const ordered of [[closed,newer],[newer,closed]]) {const retained=retainAvailability({availabilityProofs:ordered},{},record,now+1001);assert.ok(retained.some(p=>p.closed));assert.equal(retained.some(p=>blocksScheduled(p,Date.parse('2026-10-02T06:11:00Z'),now+1001)),true);}
});

function synthetic20(r,windows) {const target=STATION_BOARD_LINES.get(r.lineID).branchTargetIDs.find(id=>validBoard(id,r.lineID)&&id!==r.stationID);return [{id:r.lineID,modeName:STATION_BOARD_LINES.get(r.lineID).mode,lineStatuses:[{statusSeverity:20,statusSeverityDescription:'Service Closed',validityPeriods:windows.map(([from,to])=>({fromDate:new Date(from).toISOString(),toDate:new Date(to).toISOString()})),disruption:{affectedRoutes:[{direction:'outbound',isEntireRouteSection:true,routeSectionNaptanEntrySequence:[r.stationID,target].map((id,ordinal)=>({ordinal,stopPoint:{id,naptanId:id,commonName:STATION_BOARD_STATIONS.get(id).stationName}}))}]}}]}];}
test('all19 synthetic original clock restrictions preserve outside clocks/live and every known scope before compact selection',()=>{
 for(const [lineID,line] of STATION_BOARD_LINES) {const r={...record,lineID,stationID:line.boundedOriginID},p=proofs(synthetic20(r,[[now,now+70000]]),r)[0];assert.equal(p.plannedUnavailable,undefined,lineID);for(const at of [now,now+30000,now+70000]) {assert.equal(blocksScheduled(p,now+69000,at),true);assert.equal(blocksScheduled(p,now+70000,at),false);assert.equal(activeClosure(p,at),false);} }
});

test('connected query windows ceil seconds, preserve disjoint gaps, exclude incomplete horizon and DST ambiguous transports',()=>{
 for(const [windows,expected] of [[[[now-1000,now+17000],[now+17000,now+77000]],Date.parse('2026-10-02T02:48:00Z')],[[[now-1000,now+17000],[now+90000,now+180000]],Date.parse('2026-10-02T02:47:00Z')]]) {const raw=synthetic20(record,windows),p=proofs(raw)[0];assert.equal(shiftedJourneyTime(raw,[p],[p],now),expected);}
 const raw=synthetic20(record,[[now-1000,now+17000],[now+700000,now+800000]]),p=proofs(raw)[0];assert.equal(shiftedJourneyTime(raw,[p],[p],now),now);
 const dst=Date.parse('2026-10-25T00:00:00Z'),rawDST=synthetic20(record,[[dst-1000,dst+1800000]]),pd=proofs(rawDST,record,dst,header(dst))[0];assert.equal(shiftedJourneyTime(rawDST,[pd],[pd],dst),dst);
});

function journey(r,query,departure) {const line=STATION_BOARD_LINES.get(r.lineID),target=line.branchTargetIDs.find(id=>id!==r.stationID&&validBoard(id,r.lineID));return {searchCriteria:{dateTimeType:'Departing',dateTime:londonLocal(query).slice(0,16)+':00'},recommendedMaxAgeMinutes:2,stopMessages:[],journeys:[{legs:[{mode:{id:line.mode},departurePoint:{naptanId:r.stationID},arrivalPoint:{naptanId:target},scheduledDepartureTime:londonLocal(departure),isDisrupted:false,disruptions:[],plannedWorks:[],routeOptions:[{lineIdentifier:{id:r.lineID},direction:'Outbound',directions:[STATION_BOARD_STATIONS.get(target).stationName]}],path:{stopPoints:[{id:r.stationID},{id:target}]}}]}]};}
for(const delay of [0,31000])test(`all7 rail admitted renewal retains own rail plus one planned query with original control clocks, delay=${delay}`,async()=>{
 for(const [lineID,line] of STATION_BOARD_LINES) {if(!line.qualifiedRailDepartureSource)continue;const r={...record,lineID,stationID:line.boundedOriginID};let at=now,queries=[];const raw=synthetic20(r,[[now-1000,now+17000]]);
 const fetchImpl=async(url)=>{const u=new URL(url);let value=[];if(u.pathname.endsWith('/Status'))value=raw;if(u.pathname.endsWith('/Disruption')){await new Promise(resolve=>setTimeout(resolve,1));at=now+delay;}if(u.pathname.includes('JourneyResults')){queries.push(u);const query=londonClock(`${u.searchParams.get('date').slice(0,4)}-${u.searchParams.get('date').slice(4,6)}-${u.searchParams.get('date').slice(6)}T${u.searchParams.get('time').slice(0,2)}:${u.searchParams.get('time').slice(2)}:00`);value=journey(r,query,now+240000);}return new Response(JSON.stringify(value),{headers:header(now,0,30)});};
 const cache=await refreshStationBoard(r,{},loadConfig({}),fetchImpl,now,null,()=>at);assert.equal(queries.length,1,lineID);assert.equal(queries[0].searchParams.get('time'),'0347'); // Both times are this original query's first useful minute; expired authority cannot move actual dispatch.
 if(delay===0)assert.equal(cache.sources['rail-departures'].events.length,0);else assert.equal(cache.sources['rail-departures'],undefined);if(delay===0){assert.equal(cache.sources['journey-planner'].events.length,1);assert.equal(cache.sources['journey-planner'].events[0].receivedAt,now);assert.equal(cache.sources['journey-planner'].events[0].expiresAt,now+30000);}else assert.equal(cache.sources['journey-planner'],undefined);
 }
});

test('unverifiable20 headers cannot authorize a query or fresh open proof',async()=>{
 const raw=await fixture('tb085-liberty-service-closed-status.json');
 for(const changes of [{date:undefined},{date:'invalid'},{date:new Date(now-601000).toUTCString()},{date:new Date(now+1000).toUTCString()},{age:'invalid'},{age:'-1'}]) {let queries=0;const fetchImpl=async(url)=>{const u=new URL(url);if(u.pathname.includes('JourneyResults'))queries++;return new Response(JSON.stringify(u.pathname.endsWith('/Status')?raw:[]),{headers:Object.fromEntries(Object.entries({...header(),...changes}).filter(([,v])=>v!==undefined))});};const c=await refreshStationBoard(record,{},loadConfig({}),fetchImpl,now,null,()=>now);assert.equal(queries,0);assert.equal(c.availabilityProofs.some(p=>p.scheduledClockOnly),false);}
});

test('cap2 raw alternatives restore per-date source choice while older-v2 only gets eligible compact rows and no new proof/tag',()=>{
 const p=proofs(synthetic20(record,[[now+60000,now+180000]]))[0],tt=[100,110,120].map((v,i)=>e(`tt${i}`,'timetable',now+v*1000,{expiresAt:now+600000})),jp=e('JP','journey-planner',now+250000),rail=e('rail','rail-departures',now+260000,{platform:'5',expiresAt:now+90000}),live=e('live','rail-departures',now+400000,{timeEvidence:'predictedDeparture'});
 const cache={...context(...tt,jp,rail,live),availabilityProofs:[p]},state=buildStationBoardState(record,cache,now);
 assert.deepEqual(wireVisible(state,now),['JP','live']);assert.ok(state.arrivals.some(r=>r.plannedSourceID==='rail-departures'));
 const old=buildStationBoardState({...record,plannedPresentationVersion:undefined},cache,now);assert.deepEqual(old.arrivals.map(r=>r.id),['JP','live']);assert.equal(old.plannedAvailability,undefined);assert.ok(old.arrivals.every(r=>r.plannedSourceID!=='rail-departures'));assert.ok(Buffer.byteLength(JSON.stringify(buildApnsPayload(state,new Date(now))))<=4096);
 const twelve=context(...[0,1,2].flatMap(i=>[e(`tt${i}`,'timetable',now+200000+i*1000),e(`jp${i}`,'journey-planner',now+250000+i*1000),e(`rail${i}`,'rail-departures',now+100000+i*1000),e(`live${i}`,'rail-departures',now+300000+i*1000,{timeEvidence:'predictedDeparture'})]));
 const bounded=buildStationBoardState(record,twelve,now);assert.ok(bounded.arrivals.length<=9);assert.equal(bounded.arrivals.filter(r=>r.plannedSourceID==='rail-departures').length,3);assert.equal(bounded.arrivals.filter(r=>r.timeEvidence==='estimatedDeparture').length,3);
});

test('actual Swift cap2/legacy registrations, original Liberty seed and strict malformed capabilities use production validator',async()=>{
 const current=await fixture('actual-swift-capability2-registration.json'),legacy=await fixture('actual-swift-legacy-registration.json');assert.equal(validateTokenPayload(current).ok,true);assert.equal(validateTokenPayload(current).value.plannedPresentationVersion,2);assert.equal(validateTokenPayload(legacy).ok,true);
 for(const flag of [null,true,'2',1,3,[],{}])assert.equal(validateTokenPayload({...current,plannedPresentationVersion:flag}).ok,false);
 assert.equal(validateTokenPayload({...legacy,plannedPresentationVersion:2}).ok,false);
 const seed=await fixture('actual-swift-liberty-original-seed.json');const at=Date.parse(seed.contexts[0].observedAt);assert.deepEqual(admitPlannedSeed(seed,{stationID:seed.stationID,lineID:seed.lineID},at).errors,[]);
});

async function storeFor(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tb-final-contract-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return new LiveActivityStore(path.join(dir,'records.json'));}
test('monotonic equal/older cap selection tuples persist safely, and async stale source/APNs acknowledgements cannot alter new tuple',async(t)=>{
 const store=await storeFor(t);await store.upsertToken(record,new Date(now));
 const original=e('original');await store.retainStationBoard(record.activityID,record.environment,context(original),new Date(now));const tuple=registrationTuple(store.state.records[0]);
 await store.upsertToken({...record,plannedPresentationVersion:undefined,tokenUpdatedAt:new Date(now-1000).toISOString()},new Date(now));assert.equal(store.state.records[0].plannedPresentationVersion,2);
 await store.upsertToken({...record,plannedPresentationVersion:undefined},new Date(now));assert.equal(store.state.records[0].plannedPresentationVersion,undefined);await store.upsertToken(record,new Date(now));assert.equal(store.state.records[0].plannedPresentationVersion,undefined);
 await store.upsertToken({...record,stationID:'910GUPMNSTR'},new Date(now));assert.equal(store.state.records[0].stationID,record.stationID);
 assert.equal(await store.retainStationBoard(record.activityID,record.environment,context(e('late')),new Date(now),tuple),null);await store.markPushed(record.activityID,record.environment,{contentDigest:'obsolete',expectedTuple:tuple,emptyArrivals:false},new Date(now));assert.equal(store.state.records[0].lastBoardContentDigest,undefined);assert.equal(store.state.records[0].stationBoardCache.sources['journey-planner'].events[0].expiresAt,original.expiresAt);
 await store.upsertToken({...record,tokenUpdatedAt:new Date(now+1000).toISOString()},new Date(now+1000));assert.equal(store.state.records[0].plannedPresentationVersion,2);
 let pushes=0;await runLiveActivityWorkerCycle({store,config:loadConfig({}),now:new Date(now+1000),clock:()=>now+1000,fetchImpl:async()=>{await store.upsertToken({...record,plannedPresentationVersion:undefined,tokenUpdatedAt:new Date(now+2000).toISOString()},new Date(now+2000));return new Response('[]',{headers:header()});},pushImpl:async()=>{pushes++;},logger:{info(){},warn(){}}});assert.equal(pushes,0);assert.equal(store.state.records[0].lastBoardContentDigest,undefined);
});

test('shifted Journey criteria and own-leg bounds never borrow actual dispatch as schedule or renew original midnight expiry',()=>{
 const shifted=now+17000, future=journey(record,shifted,shifted+60000);
 const rows=parseJourney(future,record,header(),shifted,now,now);assert.equal(rows.length,1);assert.equal(rows[0].receivedAt,now);assert.equal(rows[0].expiresAt,now+30000);
 assert.equal(parseJourney(journey(record,now,shifted+60000),record,header(),shifted,now,now).length,0);
 assert.equal(parseJourney(journey(record,shifted,shifted-1000),record,header(),shifted,now,now).length,0);
 const instant=londonClock('2026-10-02T23:59:30'),query=londonClock('2026-10-03T00:01:00');const midnightRows=parseJourney(journey(record,query,query+60000),record,header(instant,0,120),query,instant,instant);
 assert.equal(midnightRows.length,1);assert.equal(midnightRows[0].expiresAt,londonClock('2026-10-03T00:00:00'));
});

test('late successful or failed APNs callback cannot acknowledge/backoff a newer registration tuple; cache-only retries add zero HTTP',async(t)=>{
 for(const failure of [false,true]){
  const store=await storeFor(t);await store.upsertToken(record,new Date(now));await store.retainStationBoard(record.activityID,record.environment,{...context(e('current')),nextRefreshAt:now+90000},new Date(now));let reads=0, pushes=0;
  await runLiveActivityWorkerCycle({store,config:loadConfig({}),cacheOnly:true,now:new Date(now),clock:()=>now,fetchImpl:async()=>{reads++;throw Error('unexpected public read');},pushImpl:async()=>{pushes++;await store.upsertToken({...record,plannedPresentationVersion:undefined,tokenUpdatedAt:new Date(now+1000).toISOString()},new Date(now+1000));if(failure)throw Error('APNs unavailable');},logger:{info(){},warn(){}}});
  const current=store.state.records[0];assert.equal(pushes,1);assert.equal(reads,0);assert.equal(current.plannedPresentationVersion,undefined);assert.equal(current.lastBoardContentDigest,undefined);assert.equal(current.lastSuccessAt,null);assert.equal(current.backoffUntil,null);assert.equal(current.stationBoardCache.sources['journey-planner'].events[0].expiresAt,now+120000);
 }
});

test('older-v2 own closure start stales current eligible compact rows without carrying incompatible raw clock-only authority',()=>{
 const p={stationID:record.stationID,lineID:record.lineID,sourceScope:'stationDisruptions',closed:true,observedAt:now,expiresAt:now+70000,closureWindows:[{validFrom:now+60000,validUntil:now+70000}]};
 const row=e('after-gap','journey-planner',now+100000);const state=buildStationBoardState({...record,plannedPresentationVersion:undefined},{...context(row),availabilityProofs:[p]},now);
 assert.equal(state.arrivals.length,1);assert.equal(state.plannedAvailability,undefined);assert.equal(state.staleAt*1000+978307200000,now+60000);
});

for (const phase of ['pause', 'end']) test(`typed duration ${phase} callbacks cannot mutate a newer extended or capability-changed registration`, async (t) => {
 const at = new Date(now), config = { ...loadConfig({}), pauseGraceMs: 60000 };
 for (const change of ['extend', 'capability']) for (const result of ['success', 'temporary', 'permanent']) {
  const store = await storeFor(t);
  const original = { ...record, activityStartedAt: new Date(now - 1800000).toISOString(), activityEndsAt: new Date(now - 60000).toISOString() };
  await store.upsertToken(original, new Date(now - 60000));
  if (phase === 'end') await store.markPaused(record.activityID, record.environment, new Date(now - 60000));
  let pushes = 0, accepted;
  await runLiveActivityWorkerCycle({ store, config, now: at, clock: () => now, cacheOnly: true,
   fetchImpl: async () => { throw Error('duration transition must not read public sources'); },
   pushImpl: async (_record, payload) => {
    pushes++;
    assert.equal(payload.aps.event, phase === 'end' ? 'end' : 'update');
    const replacement = { ...original, tokenUpdatedAt: new Date(now + 1000).toISOString(), ...(change === 'extend' ? { activityEndsAt: new Date(now + 1800000).toISOString() } : { plannedPresentationVersion: undefined }) };
    await store.upsertToken(replacement, new Date(now + 1000));
    accepted = structuredClone(store.state.records[0]);
    if (result !== 'success') {
     const error = Error('synthetic duration push failure');
     if (result === 'permanent') { error.permanent = true; error.reason = 'syntheticPermanent'; }
     else error.backoffMs = 120000;
     throw error;
    }
    return { status: 200 };
   }, logger: { info() {}, warn() {} }
  });
  assert.equal(pushes, 1);
  assert.deepEqual(store.state.records[0], accepted, `${phase}/${change}/${result}: obsolete callback changed accepted registration`);
  assert.equal(accepted.active, true);
  if (change === 'extend') assert.equal(accepted.pausedAt, null);
  else assert.equal(accepted.plannedPresentationVersion, undefined);
 }
});

test('typed duration dispatch rechecks exact registration tuple including equal-time capability downgrade', async (t) => {
 for (const change of ['extend', 'capability']) {
  const store = await storeFor(t), original = { ...record, activityStartedAt: new Date(now - 1800000).toISOString(), activityEndsAt: new Date(now - 60000).toISOString() };
  await store.upsertToken(original, new Date(now - 60000));
  const listActive = store.listActive.bind(store); let lists = 0, accepted, pushes = 0;
  store.listActive = async (...args) => {
   const rows = await listActive(...args);
   if (++lists === 1) {
    const replacement = change === 'extend' ? { ...original, tokenUpdatedAt: new Date(now + 1000).toISOString(), activityEndsAt: new Date(now + 1800000).toISOString() } : { ...original, plannedPresentationVersion: undefined };
    await store.upsertToken(replacement, new Date(now + 1000));
    accepted = structuredClone(store.state.records[0]);
   }
   return rows;
  };
  await runLiveActivityWorkerCycle({ store, config: loadConfig({}), now: new Date(now), cacheOnly: true, pushImpl: async () => { pushes++; }, fetchImpl: async () => { throw Error('unexpected public read'); }, logger: { info() {}, warn() {} } });
  assert.equal(lists, 2); assert.equal(pushes, 0); assert.deepEqual(store.state.records[0], accepted);
 }
});
