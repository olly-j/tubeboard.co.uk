// Synthetic comparisons exercise pure validation only, never publisher authority.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {assetFor,response,now,record,qualify} from './timetable-renewal-helpers.js';
import {profileJourneys,profileFingerprint,qualifyTimetable} from '../server/station-board-timetable.js';
import {STATION_BOARD_STATIONS} from '../server/station-board-v2.js';
import {assessCurrentPublicationCoverage} from '../server/timetable-current-coverage.js';
const hash=b=>createHash('sha256').update(b).digest('hex'),scope=record.lineID+'/'+record.stationID;
function fixture(raws=[response()],mutate=()=>{}){
 const asset=assetFor(raws),entry=asset.proof.entries[0];
 entry.originatingDateGaps=[];
 if(entry.directionalDefinitions)entry.directionalSourceEvidence=raws.map(raw=>({direction:raw.direction,apiBodySHA256:hash(Buffer.from(JSON.stringify(raw))),operatingStartDate:entry.operatingStartDate,operatingEndDate:entry.operatingEndDate,xmlMembers:[],originatingDateGaps:[]}));
 else entry.apiBodySHA256=hash(Buffer.from(JSON.stringify(raws[0])));
 for(const profiles of entry.directionalDefinitions?.map(d=>d.profiles)??[entry.profiles])for(const p of profiles)p.originatingServiceDateRanges=[{startDate:entry.operatingStartDate,endDate:entry.operatingEndDate}];
 mutate(asset.proof,entry);
 asset.proofBytes=Buffer.from(JSON.stringify(asset.proof));asset.identity.proofBodySHA256=hash(asset.proofBytes);
 const sources=new Map();for(const raw of raws){const direction=raw.direction??null,body=Buffer.from(JSON.stringify(raw)),bodySHA256=hash(body);sources.set(`${asset.identity.publicationSHA256}\0${asset.identity.proofBodySHA256}\0${record.lineID}\0${record.stationID}\0${direction??'default'}\0${bodySHA256}`,{...asset.identity,...record,direction:direction??'default',bodySHA256,body});}
 const comparisonIndex={isUnavailable:()=>false,get:key=>sources.get(key)};
 return {asset,comparisonIndex,sources,assess:(at=now,requestedScopes=[])=>assessCurrentPublicationCoverage({asset,comparisonIndex,at,requestedScopes})};
}
test('today requires complete actual archive bytes; future gaps remain independent and clocks are not fabricated',()=>{
 const x=fixture([response()],(_p,e)=>e.originatingDateGaps.push({serviceDate:'2026-10-04',reason:'future conflict'}));
 const result=x.assess();assert.equal(result.valid,true);assert.deepEqual(result.coveredScopes,[scope]);assert.equal(result.serviceDay,'2026-10-03');assert.equal(result.assessedAt,now);
 assert.equal('observedAt' in result,false);assert.equal('events' in result,false);
 x.comparisonIndex.get=()=>Buffer.from('not an actual indexed body');assert.deepEqual(x.assess().unresolvedScopes,[scope]);
});
test('current conflict and missing calendar fail closed; all raw profiles are validated before previous-day pruning',()=>{
 const x=fixture([response()],(_p,e)=>e.originatingDateGaps.push({serviceDate:'2026-10-03',reason:'today conflict'}));assert.deepEqual(x.assess().unresolvedScopes,[scope]);
 const raw=response();raw.timetable.routes[0].schedules.push({name:'unknown',knownJourneys:[{hour:'25',minute:'00',intervalId:7}]});assert.deepEqual(fixture([raw]).assess().unresolvedScopes,[scope]);
 raw.timetable.routes[0].schedules[1].knownJourneys[0].hour='malformed';assert.deepEqual(fixture([raw]).assess().unresolvedScopes,[scope]);
});
test('raw carryover exact-now remains required, expired raw rows prune yesterday, today always stays required',()=>{
 const x=fixture([response(1440)],(_p,e)=>e.originatingDateGaps.push({serviceDate:'2026-10-02',reason:'yesterday conflict'}));
 assert.deepEqual(x.assess(Date.parse('2026-10-02T23:00:00Z')).unresolvedScopes,[scope]);
 assert.deepEqual(x.assess(Date.parse('2026-10-02T23:00:01Z')).coveredScopes,[scope]);
 const today=fixture([response(1440)],(_p,e)=>e.originatingDateGaps.push({serviceDate:'2026-10-03',reason:'today conflict'}));assert.deepEqual(today.assess(Date.parse('2026-10-02T23:00:01Z')).unresolvedScopes,[scope]);
});
test('nonselected and excluded raw carryover cannot imply absence',()=>{
 const raw=response(720);raw.timetable.routes[0].schedules.push({name:'Sunday',knownJourneys:[{hour:'25',minute:'00',intervalId:7}]});
 const x=fixture([raw],(_p,e)=>{e.profiles[0].weekdays=[2,3,4,5,6,7];const rows=profileJourneys(raw,'Sunday');e.profiles.push({name:'Sunday',count:rows.length,sha256:profileFingerprint(rows),weekdays:[1],originatingServiceDateRanges:[{startDate:e.operatingStartDate,endDate:e.operatingEndDate}]});e.originatingDateGaps.push({serviceDate:'2026-10-02',reason:'carryover conflict'});});
 assert.deepEqual(x.assess(Date.parse('2026-10-02T23:30:00Z')).unresolvedScopes,[scope]);assert.deepEqual(x.assess(Date.parse('2026-10-03T12:00:00Z')).coveredScopes,[scope]);
 const y=fixture([response(1500)],(_p,e)=>{const p=e.profiles[0],key=profileJourneys(response(1500),p.name)[0].key;p.excludedJourneyKeys=[{key,count:1}];p.publishedCount=0;p.publishedSHA256=hash(Buffer.from(''));e.originatingDateGaps.push({serviceDate:'2026-10-02',reason:'carryover conflict'});});assert.deepEqual(y.assess(Date.parse('2026-10-02T23:30:00Z')).unresolvedScopes,[scope]);
});
test('direction completeness, cross-direction duplicates and counted multiplicity remain strict',()=>{
 const inbound=response(720,['940GZZLUBNK'],'inbound'),outbound=response(780,['940GZZLUCHX'],'outbound');const x=fixture([inbound,outbound]);assert.deepEqual(x.assess().coveredScopes,[scope]);x.sources.delete([...x.sources.keys()][0]);assert.deepEqual(x.assess().unresolvedScopes,[scope]);
 assert.deepEqual(fixture([inbound,response(720,['940GZZLUBNK'],'outbound')]).assess().unresolvedScopes,[scope]);
 const raw=response();raw.timetable.routes[0].schedules[0].knownJourneys.push({...raw.timetable.routes[0].schedules[0].knownJourneys[0]});const y=fixture([raw]);assert.deepEqual(y.assess().coveredScopes,[scope]);
 const source=[...y.sources.values()][0];source.body=Buffer.from(JSON.stringify(response()));assert.deepEqual(y.assess().unresolvedScopes,[scope]);
});
test('ambiguous/nonexistent London raw clocks reject even when expired; day identity uses London midnight',()=>{
 for(const at of ['2026-03-29T12:00:00Z','2026-10-25T12:00:00Z']){const x=fixture([response(1530)],(p,e)=>{p.holidayCoverageStart=e.operatingStartDate='2026-01-01';p.holidayCoverageEnd=e.operatingEndDate='2026-12-31';for(const profile of e.profiles)profile.originatingServiceDateRanges=[{startDate:e.operatingStartDate,endDate:e.operatingEndDate}];});assert.deepEqual(x.assess(Date.parse(at)).unresolvedScopes,[scope]);}
 assert.equal(fixture().assess(Date.parse('2026-10-02T23:30:00Z')).serviceDay,'2026-10-03');
});
test('invalid identity and excessive/unknown requested scopes are not healthy empty assessments',()=>{
 const x=fixture();assert.equal(x.assess(now,['northern/UNKNOWN']).valid,false);assert.equal(x.assess(NaN).valid,false);x.asset.proofBytes=Buffer.from('{}');assert.equal(x.assess().valid,false);
});
test('runtime freshness gate remains mandatory even when pure archived comparison covers today',()=>{
 const x=fixture();assert.deepEqual(x.assess().coveredScopes,[scope]);assert.throws(()=>qualifyTimetable(x.asset,[],record,{at:now}),/unavailable/);
});

test('narrower directional operating bounds are enforced while legacy directional metadata fallback stays compatible',()=>{
 const raws=[response(720,['940GZZLUBNK'],'inbound'),response(780,['940GZZLUCHX'],'outbound')];
 const legacy=assetFor(raws);assert.equal(qualify(legacy,raws).events.length,2);
 const bounded=fixture(raws,(_p,e)=>{e.directionalSourceEvidence[0].operatingEndDate='2026-10-02';});
 assert.deepEqual(bounded.assess().unresolvedScopes,[scope]);assert.throws(()=>qualify(bounded.asset,raws),/unsupportedCalendar/);
});

test('mandatory qualified coverage has separate bounded reserve from 256 legacy demand scopes',()=>{
 const pool=[...STATION_BOARD_STATIONS.values()].flatMap(s=>s.lineIDs.map(line=>line+'/'+s.stationID));
 const x=fixture(),demand=pool.filter(s=>s!==scope).slice(0,256);assert.equal(demand.length,256);
 const result=x.assess(now,demand);assert.equal(result.valid,true);assert.deepEqual(result.requiredScopes,[scope]);assert.equal(result.assessedScopes.length,257);assert.equal(result.unresolvedScopes.length,256);
 assert.equal(x.assess(now,result.assessedScopes).valid,true);
 assert.equal(x.assess(now,pool.filter(s=>s!==scope).slice(0,257)).valid,false);
});
test('required scope overflow rejects; exactly 256 required plus 256 demand remains bounded and explicit',()=>{
 const pool=[...STATION_BOARD_STATIONS.values()].flatMap(s=>s.lineIDs.map(line=>line+'/'+s.stationID));assert.ok(pool.length>=512);
 const make=count=>{const asset=assetFor(),template=asset.proof.entries[0];asset.proof.entries=pool.slice(0,count).map(pair=>{const [lineID,stationID]=pair.split('/');return {...structuredClone(template),lineID,stationID};});asset.proofBytes=Buffer.from(JSON.stringify(asset.proof));asset.identity.proofBodySHA256=hash(asset.proofBytes);return asset;};
 const comparisonIndex={isUnavailable:()=>true,get:()=>undefined};
 const valid=assessCurrentPublicationCoverage({asset:make(256),comparisonIndex,requestedScopes:pool.slice(256,512),at:now});assert.equal(valid.valid,true);assert.equal(valid.requiredScopes.length,256);assert.equal(valid.assessedScopes.length,512);assert.equal(valid.unresolvedScopes.length,512);
 assert.equal(assessCurrentPublicationCoverage({asset:make(257),comparisonIndex,at:now}).valid,false);
});
