import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { qualifyTimetable,profileJourneys,profileFingerprint } from '../server/station-board-timetable.js';
import { response,assetFor,wrap,record,sha,observation } from './timetable-renewal-helpers.js';
function change(asset,fn){const proof=structuredClone(asset.proof);fn(proof);const proofBytes=Buffer.from(JSON.stringify(proof));return {...asset,proof,proofBytes,identity:{...asset.identity,proofBodySHA256:crypto.createHash('sha256').update(proofBytes).digest('hex')}};}
function evaluate(raw,asset,at){return qualifyTimetable(asset,raw.map(r=>wrap(r,at)),record,{at,head:{sha256:sha,...observation(at)},serviceObservation:observation(at),stationObservation:observation(at)});}
const at=Date.parse('2026-11-16T12:00:00Z');
const previousGap=asset=>change(asset,p=>{p.entries[0].originatingDateGaps=[{serviceDate:'2026-11-15',reason:'retained original conflict'}];});
test('expired previous departures prune but exact-now and one-second future require yesterday',()=>{
  let raw=response(1500),asset=previousGap(assetFor([raw]));const result=evaluate([raw],asset,at);assert.deepEqual(result.evidence.qualification.map(q=>q.serviceDay),['2026-11-16']);assert.equal(result.observedAt,at);
  raw=response(2160);asset=previousGap(assetFor([raw]));assert.throws(()=>evaluate([raw],asset,at),/unsupportedCalendar/);assert.doesNotThrow(()=>evaluate([raw],asset,at+1000));
  raw=response(2161);asset=previousGap(assetFor([raw]));assert.throws(()=>evaluate([raw],asset,at+59000),/unsupportedCalendar/);
});
test('nonselected and excluded offered profiles remain conservative candidates',()=>{
  const raw=response(1500),route=raw.timetable.routes[0];route.schedules.push({name:'nonselected-saturday',knownJourneys:[{hour:'36',minute:'1',intervalId:7}]});
  let asset=change(assetFor([raw]),p=>{const profiles=p.entries[0].profiles;profiles[0].weekdays=[1,2,3,4,5,6];const rows=profileJourneys(raw,'nonselected-saturday');profiles.push({name:'nonselected-saturday',weekdays:[7],count:1,sha256:profileFingerprint(rows),excludedJourneyKeys:[{key:rows[0].key,count:1}],publishedCount:0,publishedSHA256:profileFingerprint([])});});
  asset=previousGap(asset);assert.throws(()=>evaluate([raw],asset,at),/unsupportedCalendar/);
});
test('today conflict missing offered identity and malformed raw rows never imply absence',()=>{
  const raw=response(1500);let asset=change(assetFor([raw]),p=>p.entries[0].originatingDateGaps=[{serviceDate:'2026-11-16',reason:'today conflict'}]);assert.throws(()=>evaluate([raw],asset,at),/unsupportedCalendar/);
  asset=assetFor([raw]);const unknown=structuredClone(raw);unknown.timetable.routes[0].schedules[0].name='unknown';assert.throws(()=>evaluate([unknown],asset,at));
  const malformed=response(2160);malformed.timetable.routes[0].schedules[0].knownJourneys.push({hour:'48',minute:'0',intervalId:7});assert.throws(()=>evaluate([malformed],assetFor([malformed]),at));
});
test('all raw conversions precede relevance result and London DST is not fixed-day arithmetic',()=>{
  const raw=response(1440);raw.timetable.routes[0].schedules[0].knownJourneys.push({hour:'25',minute:'30',intervalId:7});
  for(const instant of ['2026-10-24T23:00:00Z','2026-03-29T00:00:00Z']){
    const now=Date.parse(instant);const asset=change(assetFor([raw]),p=>{p.holidayCoverageStart='2026-01-01';p.entries[0].operatingStartDate='2026-01-01';});assert.throws(()=>evaluate([raw],asset,now),/unsupportedCalendar/);
  }
  for(const [instant,day] of [['2026-03-29T22:58:59Z','2026-03-28'],['2026-10-25T23:58:59Z','2026-10-24']]){
    const raw=response(2879),now=Date.parse(instant),asset=change(assetFor([raw]),p=>{p.holidayCoverageStart='2026-01-01';p.entries[0].operatingStartDate='2026-01-01';p.entries[0].originatingDateGaps=[{serviceDate:day,reason:'must retain'}];});assert.throws(()=>evaluate([raw],asset,now),/unsupportedCalendar/);
  }
});
test('independent directions retain counted duplicates while pruning only irrelevant originating day',()=>{
  const inbound=response(720,['940GZZLUBNK'],'inbound');inbound.timetable.routes[0].schedules[0].knownJourneys.push({...inbound.timetable.routes[0].schedules[0].knownJourneys[0]});
  const outbound=response(780,['940GZZLUCHX'],'outbound');const asset=change(assetFor([inbound,outbound]),p=>{p.entries[0].directionalSourceEvidence=['inbound','outbound'].map(direction=>({direction,apiBodySHA256:'b'.repeat(64),operatingStartDate:'2026-09-01',operatingEndDate:'2026-12-31',xmlMembers:[],originatingDateGaps:[{serviceDate:'2026-11-15',reason:'expired only'}]}));});
  const context=evaluate([inbound,outbound],asset,at);assert.deepEqual(context.evidence.qualification.map(q=>[q.publicationDirection,q.serviceDay,q.retainedCount]),[['inbound','2026-11-16',2],['outbound','2026-11-16',1]]);assert.equal(context.events.filter(e=>e.publicationDirection==='inbound').length,2);
});
