import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { profileFingerprint, profileJourneys } from '../server/station-board-timetable.js';
import { response, assetFor, qualify, now } from './timetable-renewal-helpers.js';

const empty=createHash('sha256').update('').digest('hex');
function changed(asset,mutate){
  const proof=structuredClone(asset.proof);mutate(proof.entries[0]);
  const proofBytes=Buffer.from(JSON.stringify(proof));
  return {proof,proofBytes,identity:{...asset.identity,proofBodySHA256:createHash('sha256').update(proofBytes).digest('hex')}};
}
const mark=profile=>Object.assign(profile,{allExcluded:true,publishedCount:0,publishedSHA256:empty});

test('complete exclusions preserve raw authority while returning no departures',()=>{
  const raw=response(),asset=changed(assetFor([raw]),entry=>mark(entry.profiles[0]));
  const result=qualify(asset,[raw]);assert.deepEqual(result.events,[]);
  assert.equal(result.evidence.qualification[0].retainedCount,0);
  assert.equal(result.observedAt,now);
});
test('directional compact empty subset does not hide the opposite direction',()=>{
  const inbound=response(720,['940GZZLUBNK'],'inbound'),outbound=response(780,['940GZZLUCHX'],'outbound');
  const asset=changed(assetFor([inbound,outbound]),entry=>mark(entry.directionalDefinitions[0].profiles[0]));
  const result=qualify(asset,[inbound,outbound]);assert.equal(result.events.length,1);
  assert.equal(result.events[0].publicationDirection,'outbound');
});
test('malformed compact marker forms fail closed',()=>{
  const raw=response();
  for(const mutate of [p=>p.allExcluded=false,p=>p.allExcluded=null,p=>p.allExcluded=1,
    p=>p.excludedJourneyKeys=[],p=>p.excludedJourneyKeys=null,p=>p.publishedCount=1,
    p=>delete p.publishedCount,p=>p.publishedSHA256='a'.repeat(64),p=>delete p.publishedSHA256,
    p=>p.count=0,p=>p.count=20001,p=>p.sha256='invalid']){
    const asset=changed(assetFor([raw]),entry=>{mark(entry.profiles[0]);mutate(entry.profiles[0]);});
    assert.throws(()=>qualify(asset,[raw]));
  }
});
test('changed raw count duplicate path or clock cannot be interpreted as empty',()=>{
  const raw=response(),asset=changed(assetFor([raw]),entry=>mark(entry.profiles[0]));
  for(const alter of [r=>r.timetable.routes[0].schedules[0].knownJourneys.push({...r.timetable.routes[0].schedules[0].knownJourneys[0]}),
    r=>r.timetable.routes[0].schedules[0].knownJourneys=[],
    r=>r.timetable.routes[0].schedules[0].knownJourneys[0].minute='1',
    r=>r.timetable.routes[0].stationIntervals[0].intervals[0].stopId='940GZZLUCHX']){
    const changedRaw=structuredClone(raw);alter(changedRaw);assert.throws(()=>qualify(asset,[changedRaw]));
  }
});
test('compact marker retains current calendar and HTTP freshness gates',()=>{
  const raw=response(),asset=changed(assetFor([raw]),entry=>mark(entry.profiles[0]));
  const gap=changed(asset,entry=>entry.operatingEndDate='2026-10-02');assert.throws(()=>qualify(gap,[raw]));
  assert.throws(()=>qualify(asset,[raw],now+600001));
});
test('nonzero explicit exclusion representation stays unchanged',()=>{
  const raw=response();raw.timetable.routes[0].schedules[0].knownJourneys.push({...raw.timetable.routes[0].schedules[0].knownJourneys[0]});
  const asset=changed(assetFor([raw]),entry=>{
    const p=entry.profiles[0],rows=profileJourneys(raw,p.name);
    Object.assign(p,{excludedJourneyKeys:[{key:rows[0].key,count:1}],publishedCount:1,publishedSHA256:profileFingerprint(rows.slice(1))});
  });
  assert.equal(qualify(asset,[raw]).events.length,1);
});
