// PRIVATE UNRUN PROPOSAL. Synthetic trusted asset tuples exercise rejection,
// not live TfL/source qualification. The seed body is unchanged actual Swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveActivityStore, validateTokenPayload, registrationTuple, loadConfig, runLiveActivityWorkerCycle } from '../server/live-activity.js';
import { admitPlannedSeed } from '../server/station-board-seed.js';
import { observePublication, observeRevision, applyPublicationAuthority, publicationGeneration, scopedSeedMatchesAsset, normalizedPublicationAuthority } from '../server/station-board-publication.js';
const input = JSON.parse(await fs.readFile(new URL('./fixtures/actual-swift-date-range-seed-metropolitan.json', import.meta.url), 'utf8'));
const now = Date.parse(input.contexts[0].observedAt), sha = input.contexts[0].publication.sha256;
const identity = (revision, body = 'a') => ({ publicationSHA256: sha, proofRevision: revision, proofBodySHA256: body.repeat(64) });
function seed(revision = 1, body = 'a') {
  const value = structuredClone(input);
  value.contexts[0].publicationProofIdentity = identity(revision, body);
  value.contexts[0].independentPublicationObservedAt = new Date(now).toISOString();
  return value;
}
function assetFor(id) {
  const profiles = [...new Map(input.contexts[0].rows.map(row => [row.profileName, {
    name: row.profileName, sha256: row.profileSHA256, weekdays: row.weekdays,
    originatingServiceDateRanges: row.originatingServiceDateRanges
  }])).values()];
  return { identity: id, proof: { entries: [{ stationID: input.stationID, lineID: input.lineID, status: 'qualified', profiles }] } };
}
function registration(seedValue = seed()) {
  return { installID: '00000000-0000-4000-8000-000000000001', activityID: 'synthetic-publication-activity',
    stationID: input.stationID, lineID: input.lineID, selectionMode: 'allPlatforms',
    pushTokenHex: 'ab'.repeat(32), tokenUpdatedAt: new Date(now).toISOString(), appBundleID: 'OllyJ.My-Train-Times',
    appVersion: 'test', buildNumber: '0', environment: 'sandbox', contentStateContract: 'station-board-v2',
    plannedPresentationVersion: 2, timetablePublicationAuthorityVersion: 1, plannedContextSeed: seedValue };
}
test('independent original HEAD and persistent revision conflicts cannot be reordered by completion or expiry', () => {
  let state = observePublication({}, { sha256: sha, observedAt: now });
  state = observeRevision(state, identity(2, 'b'));
  const original = JSON.stringify(state);
  assert.deepEqual(observePublication(state, { sha256: 'c'.repeat(64), observedAt: now-1 }), state);
  const conflict = observePublication(state, { sha256: 'c'.repeat(64), observedAt: now });
  assert.equal(conflict.officialIdentity.conflict, true);
  const sameRevisionConflict = observeRevision(state, identity(2, 'a'));
  assert.equal(sameRevisionConflict.revisions[0].conflict, true);
  assert.equal(observeRevision(sameRevisionConflict, identity(1)).revisions[0].conflict, true);
  const recovered = observePublication(conflict, { sha256: sha, observedAt: now+1 });
  assert.equal(recovered.officialIdentity.conflict, undefined);
  assert.equal(JSON.stringify(state), original);
  assert.deepEqual(normalizedPublicationAuthority(state),state);
  for (const malformed of [null, { revisions: null }, { officialIdentity: {sha256:sha, observedAt:'now'} }, { unknown: true }]) assert.deepEqual(normalizedPublicationAuthority(malformed),{overflow:true});
  const admitted = admitPlannedSeed(seed(2,'b'), registration(), now);
  assert.deepEqual(admitted.errors, []);
  assert.ok(applyPublicationAuthority(admitted, JSON.parse(JSON.stringify(state))).sources.timetable);
  assert.equal(applyPublicationAuthority(admitPlannedSeed(seed(), registration(), now), state).sources.timetable, undefined);
});
test('original Swift seed plus proposed synthetic authority carries exact reference and independent HEAD while malformed optional shapes reject', () => {
  const source = seed(), accepted = admitPlannedSeed(source, registration(source), now);
  assert.deepEqual(accepted.errors, []);
  assert.deepEqual(accepted.sources.timetable.evidence.publicationProofIdentity, identity(1));
  assert.equal(accepted.sources.timetable.evidence.independentPublicationObservedAt, now);
  assert.equal(accepted.sources.timetable.events[0].receivedAt, Date.parse(source.contexts[0].observedAt));
  assert.equal(accepted.sources.timetable.events[0].expiresAt, Date.parse(source.contexts[0].expiresAt));
  for (const wrong of [null, true, '1', -1, Number.MAX_SAFE_INTEGER+1]) {
    const mutated = seed(); mutated.contexts[0].publicationProofIdentity.proofRevision = wrong;
    assert.ok(admitPlannedSeed(mutated, registration(mutated), now).errors.length);
  }
  for (const wrong of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(64)+'\n']) {
    const mutated = seed(); mutated.contexts[0].publicationProofIdentity.proofBodySHA256 = wrong;
    assert.ok(admitPlannedSeed(mutated, registration(mutated), now).errors.length);
  }
  const missing = seed(); delete missing.contexts[0].independentPublicationObservedAt;
  assert.ok(admitPlannedSeed(missing, registration(missing), now).errors.length);
  assert.ok(admitPlannedSeed(seed(), { ...registration(), timetablePublicationAuthorityVersion: undefined }, now).errors.length);
  assert.deepEqual(admitPlannedSeed(input, { ...registration(input), timetablePublicationAuthorityVersion: undefined }, now).errors, []);
  assert.equal(validateTokenPayload(registration(), new Date(now)).ok, true);
  for (const wrong of [null,true,'1',0,2]) assert.equal(validateTokenPayload({ ...registration(), timetablePublicationAuthorityVersion: wrong }, new Date(now)).ok, false);
  assert.notEqual(registrationTuple(registration()), registrationTuple({ ...registration(), timetablePublicationAuthorityVersion: undefined }));
});
test('real isolated store applies trusted revision before stale source merge in both input orders and after restart', async t => {
  for (const oldFirst of [true,false]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),'tb085-publication-'));
    t.after(() => fs.rm(directory,{recursive:true,force:true}));
    let asset = assetFor(identity(1));
    const store = new LiveActivityStore(path.join(directory,'records.json'), { publicationLoader: async requested => { assert.equal(requested,sha); return asset; } });
    await store.upsertToken(registration(),new Date(now));
    assert.ok(store.state.records[0].stationBoardCache.sources.timetable);
    const old = structuredClone(store.state.records[0].stationBoardCache);
    asset = assetFor(identity(2,'b'));
    if (oldFirst) await store.retainStationBoard('synthetic-publication-activity','sandbox',old,new Date(now+1));
    await store.observePublicationRevision(asset.identity);
    await store.upsertToken({ ...registration(seed(2,'b')), tokenUpdatedAt: new Date(now+1).toISOString() },new Date(now+1));
    if (!oldFirst) await store.retainStationBoard('synthetic-publication-activity','sandbox',old,new Date(now+2));
    assert.deepEqual(store.state.records[0].stationBoardCache.sources.timetable.evidence.publicationProofIdentity,identity(2,'b'));
    assert.equal(store.state.records[0].stationBoardCache.sources.timetable.events[0].expiresAt, Date.parse(input.contexts[0].expiresAt));
    const restarted = new LiveActivityStore(store.filePath,{publicationLoader:async()=>asset}); await restarted.load();
    assert.equal(publicationGeneration(restarted.publicationAuthority()),publicationGeneration(store.publicationAuthority()));
    await restarted.upsertToken({ ...registration(), tokenUpdatedAt: new Date(now+2).toISOString() },new Date(now+2));
    assert.equal(restarted.state.records[0].stationBoardCache.sources.timetable.evidence.publicationProofIdentity.proofRevision,2);
    asset = assetFor(identity(3,'b'));
    await restarted.observePublicationRevision(asset.identity);
    assert.equal(restarted.state.records[0].stationBoardCache.sources.timetable.evidence.publicationProofIdentity.proofRevision,2);
  }
});
test('cache-only source dispatch cannot acknowledge or back off after a newer trusted body invalidates its tuple',async t=>{
  for (const failedPush of [false,true]) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tb085-source-callback-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const store=new LiveActivityStore(path.join(directory,'records.json'),{publicationLoader:async()=>assetFor(identity(1))});
    await store.upsertToken(registration(),new Date(now));let reads=0,pushes=0;
    await runLiveActivityWorkerCycle({store,config:loadConfig({}),now:new Date(now),clock:()=>now,cacheOnly:true,
      fetchImpl:async()=>{reads++;throw Error('unexpected HTTP');}, pushImpl:async()=>{pushes++;await store.observePublicationRevision(identity(2,'b'));if(failedPush)throw Error('synthetic expired dispatch');},logger:{info(){},warn(){}}});
    assert.equal(reads,0);assert.equal(pushes,1);assert.equal(store.state.records[0].lastBoardContentDigest,undefined);
    assert.equal(store.state.records[0].backoffUntil,null);assert.equal(store.state.records[0].stationBoardCache.sources.timetable,undefined);
  }
});
test('direction provenance matches complete exact local metadata without flattening identical profile names',()=>{
  const value=seed(), context=value.contexts[0];context.publicationDirections=['inbound','outbound'];
  const oversized=structuredClone(value);
  for(const row of oversized.contexts[0].rows){row.publicationDirection='inbound';row.providerDirection='inbound';}
  assert.deepEqual(admitPlannedSeed(oversized,registration(oversized),now).errors,['plannedContextSeed is invalid']);
  // Two distinct original rows exercise both scopes without exceeding the seed byte budget.
  context.rows=context.rows.slice(0,2);
  for(const [index,row] of context.rows.entries()){row.publicationDirection=context.publicationDirections[index];row.providerDirection=row.publicationDirection;}
  const profiles=[...new Map(context.rows.map(row=>[row.profileName,{name:row.profileName,sha256:row.profileSHA256,weekdays:row.weekdays,originatingServiceDateRanges:row.originatingServiceDateRanges}])).values()];
  const asset={identity:identity(1),proof:{entries:[{lineID:input.lineID,stationID:input.stationID,status:'qualified',profiles:[],directionalDefinitions:[{direction:'inbound',profiles},{direction:'outbound',profiles}]}]}};
  assert.equal(scopedSeedMatchesAsset(context,asset,registration()),true);
  assert.deepEqual(admitPlannedSeed(value,registration(value),now).errors,[]);
  const original=JSON.stringify(context);const partial=structuredClone(asset);partial.proof.entries[0].directionalDefinitions.pop();assert.equal(scopedSeedMatchesAsset(context,partial,registration()),false);
  const wrong=structuredClone(context);wrong.rows[0].publicationDirection='northbound';assert.ok(admitPlannedSeed({...value,contexts:[wrong]},registration(value),now).errors.length);
  const malformed=structuredClone(asset);delete malformed.proof.entries[0].directionalDefinitions[0].profiles[0].weekdays;assert.equal(scopedSeedMatchesAsset(context,malformed,registration()),false);
  assert.equal(JSON.stringify(context),original);
});

test('exact same token/scope can monotonically gain authority mode without retiming or admitting old callbacks',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tb085-capability-tuple-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=new LiveActivityStore(path.join(directory,'records.json'),{publicationLoader:async()=>assetFor(identity(1))});
  const old={...registration(input),timetablePublicationAuthorityVersion:undefined};await store.upsertToken(old,new Date(now));
  const oldTuple=registrationTuple(store.state.records[0]);
  const accepted=await store.upsertToken(registration(),new Date(now));
  assert.equal(accepted.registrationAccepted,true);assert.equal(accepted.timetablePublicationAuthorityVersion,1);
  assert.equal(accepted.tokenUpdatedAt,old.tokenUpdatedAt);
  await store.markPushed(accepted.activityID,'sandbox',{expectedTuple:oldTuple,contentDigest:'old'},new Date(now+1));
  assert.equal(store.state.records[0].lastBoardContentDigest,undefined);
  const downgraded=await store.upsertToken(old,new Date(now+2));
  assert.equal(downgraded.registrationAccepted,false);assert.equal(store.state.records[0].timetablePublicationAuthorityVersion,1);
});

// PRIVATE UNRUN successor regressions: these use the real atomic store queue,
// with synthetic trusted revision tuples; no current publication/API claim.
test('typed failure callbacks recheck publication generation inside the queued mutation',async t=>{
  for (const permanent of [false,true]) for (const revisionFirst of [true,false]) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tb085-queued-authority-failure-'));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const store=new LiveActivityStore(path.join(directory,'records.json'),{publicationLoader:async()=>assetFor(identity(1))});
    await store.upsertToken(registration(),new Date(now));
    const generation=publicationGeneration(store.publicationAuthority());
    const tuple=registrationTuple(store.state.records[0]);
    const method=permanent?'deactivate':'markBackoff', original=store[method].bind(store);
    let callbacks=0;
    store[method]=async(...args)=>{
      callbacks++;
      assert.equal(args.at(-1),generation);
      const revision=revisionFirst?store.observePublicationRevision(identity(2,'b')):null;
      // The revision is queued, but has not committed at this synchronous point.
      assert.equal(publicationGeneration(store.publicationAuthority()),generation);
      const failure=original(...args);
      const laterRevision=revisionFirst?null:store.observePublicationRevision(identity(2,'b'));
      await Promise.all([revision,failure,laterRevision]);
    };
    await runLiveActivityWorkerCycle({store,config:loadConfig({}),now:new Date(now),clock:()=>now,cacheOnly:true,
      fetchImpl:async()=>{throw Error('unexpected HTTP');},pushImpl:async()=>{throw Object.assign(Error('synthetic failure'),{permanent,reason:'syntheticFailure'});},logger:{info(){},warn(){}}});
    assert.equal(callbacks,1);
    assert.equal(registrationTuple(store.state.records[0]),tuple);
    assert.notEqual(publicationGeneration(store.publicationAuthority()),generation);
    const record=store.state.records[0];
    if(revisionFirst){assert.equal(record.active,true);assert.equal(record.backoffUntil,null);assert.equal(record.apnsFailureReason,null);}
    else if(permanent){assert.equal(record.active,false);assert.equal(record.apnsFailureReason,'syntheticFailure');}
    else{assert.equal(record.active,true);assert.equal(record.backoffReason,'stationBoardPushFailed');assert.equal(record.backoffUntil,new Date(now+120000).toISOString());}
  }
});
test('legacy and duration-style failure calls without publication guard keep their existing semantics',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tb085-unguarded-duration-failure-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=new LiveActivityStore(path.join(directory,'records.json'),{publicationLoader:async()=>assetFor(identity(1))});
  await store.upsertToken(registration(),new Date(now));
  const tuple=registrationTuple(store.state.records[0]);
  await store.observePublicationRevision(identity(2,'b'));
  await store.markBackoff(registration().activityID,'sandbox',1000,'durationFailure',new Date(now),tuple);
  assert.equal(store.state.records[0].backoffReason,'durationFailure');
  await store.deactivate(registration().activityID,'sandbox','durationPermanentFailure',new Date(now+1),tuple);
  assert.equal(store.state.records[0].active,false);
  assert.equal(store.state.records[0].apnsFailureReason,'durationPermanentFailure');
});
test('endpoint seed validation rejects null rows and partitions same-day profile ambiguity by declared direction',()=>{
  for(const malformedRow of [null,true,[],1,'row']){
    const malformed=seed();malformed.contexts[0].rows=[malformedRow];
    assert.doesNotThrow(()=>validateTokenPayload(registration(malformed),new Date(now)));
    assert.equal(validateTokenPayload(registration(malformed),new Date(now)).ok,false);
  }
  const scoped=seed(),context=scoped.contexts[0];context.publicationDirections=['inbound','outbound'];
  context.rows=context.rows.slice(0,2);
  for(const [index,row] of context.rows.entries()){
    const direction=index===0?'inbound':'outbound';
    row.publicationDirection=direction;row.providerDirection=direction;
    row.profileName=`Synthetic ${direction} Friday`;
    row.profileSHA256=(index===0?'c':'d').repeat(64);
  }
  const asset={identity:identity(1),proof:{entries:[{stationID:input.stationID,lineID:input.lineID,status:'qualified',profiles:[],
    directionalDefinitions:context.rows.map(row=>({direction:row.publicationDirection,profiles:[{name:row.profileName,sha256:row.profileSHA256,weekdays:row.weekdays,originatingServiceDateRanges:row.originatingServiceDateRanges}]}))}]}};
  for(const reverse of [false,true]){
    const value=structuredClone(scoped);if(reverse)value.contexts[0].rows.reverse();
    assert.equal(validateTokenPayload(registration(value),new Date(now)).ok,true);
    const admitted=admitPlannedSeed(value,registration(value),now);
    assert.deepEqual(admitted.errors,[]);assert.equal(admitted.sources.timetable.events.length,2);
    assert.deepEqual(new Set(admitted.sources.timetable.evidence.rows.map(row=>row.publicationDirection)),new Set(['inbound','outbound']));
    assert.equal(scopedSeedMatchesAsset(value.contexts[0],asset,registration(value)),true);
    for(const event of admitted.sources.timetable.events){assert.equal(event.receivedAt,now);assert.equal(event.expiresAt,Date.parse(context.expiresAt));}
    const ambiguous=structuredClone(value);for(const row of ambiguous.contexts[0].rows){row.publicationDirection='inbound';row.providerDirection='inbound';}
    assert.equal(validateTokenPayload(registration(ambiguous),new Date(now)).ok,false);
  }
});

// PRIVATE UNRUN fresh-GET amendment, synthetic assets only. Existing nine
// authority-r3 methods remain above unchanged; actual parity artifact is needed.
test('workerSingleOrTwoGETBudgetAndNoSeed',async()=>{
  const {refreshStationBoard}=await import('../server/station-board-v2.js');
  const h=await import('./timetable-renewal-helpers.js');
  for(const directional of [false,true]){
    const raws=directional?[h.response(720,['940GZZLUBNK'],'inbound'),h.response(780,['940GZZLUCHX'],'outbound')]:[h.response()];const asset=h.assetFor(raws),requests=[],responses=directional?{inbound:raws[0],outbound:raws[1]}:{legacy:raws[0]};
    const state=await refreshStationBoard(h.record,{}, {workerIntervalMs:90000},h.refreshFetch(asset,responses,requests),h.now,undefined,()=>h.now,new Map(),h.fakeAuthority(asset));assert.ok(state.sources.timetable);assert.equal(requests.filter(u=>u.includes('/Timetable/')).length,raws.length);assert.equal(state.sources.timetable.events.length,raws.length);
    let calls=0;await refreshStationBoard(h.record,state,{workerIntervalMs:90000},async()=>{calls++;throw Error('cache-only');},h.now+1,undefined,()=>h.now+1,new Map(),h.fakeAuthority(asset));assert.equal(calls,0);
  }
});
test('storePublicationGenerationAndRegistrationRaces',async t=>{
  const h=await import('./timetable-renewal-helpers.js');const {refreshStationBoard}=await import('../server/station-board-v2.js');
  for(const changedDuringTT of [true,false]){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tb085-renewal-race-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    let asset=h.assetFor();const store=new LiveActivityStore(path.join(directory,'records.json'),{publicationLoader:async()=>asset});
    const reg={...registration(undefined),stationID:h.record.stationID,lineID:h.record.lineID,plannedContextSeed:undefined,tokenUpdatedAt:new Date(h.now).toISOString()};await store.upsertToken(reg,new Date(h.now));const oldRecord=structuredClone(store.state.records[0]),oldTuple=registrationTuple(oldRecord),fetchBase=h.refreshFetch(asset);
    const fetchImpl=async url=>{
      if(changedDuringTT&&new URL(url).pathname.includes('/Timetable/')){asset={...asset,identity:{...asset.identity,proofRevision:2,proofBodySHA256:'e'.repeat(64)}};await store.observePublicationRevision(asset.identity);}
      const value=await fetchBase(url);if(!changedDuringTT&&new URL(url).pathname.includes('/Journey/'))await store.upsertToken({...reg,tokenUpdatedAt:new Date(h.now+1).toISOString(),timetablePublicationAuthorityVersion:undefined},new Date(h.now+1));return value;
    };
    const result=await refreshStationBoard(oldRecord,{}, {workerIntervalMs:90000},fetchImpl,h.now,undefined,()=>h.now,new Map(),store);
    if(changedDuringTT)assert.equal(result.sources.timetable,undefined);
    else {const saved=await store.retainStationBoard(oldRecord.activityID,'sandbox',result,new Date(h.now+1),oldTuple);assert.equal(saved,null);assert.equal(store.state.records[0].tokenUpdatedAt,new Date(h.now+1).toISOString());}
  }
});
test('restartOutOfOrderExpiredAndRecover',async t=>{
  const h=await import('./timetable-renewal-helpers.js'),{refreshStationBoard,selectEvents}=await import('../server/station-board-v2.js');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tb085-renewal-restart-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const asset=h.assetFor();
  const store=new LiveActivityStore(path.join(directory,'records.json'),{publicationLoader:async()=>asset});const reg={...registration(undefined),stationID:h.record.stationID,lineID:h.record.lineID,plannedContextSeed:undefined,tokenUpdatedAt:new Date(h.now).toISOString()};await store.upsertToken(reg,new Date(h.now));
  const current=store.state.records[0],cache=await refreshStationBoard(current,{}, {workerIntervalMs:90000},h.refreshFetch(asset),h.now,undefined,()=>h.now,new Map(),store);await store.retainStationBoard(current.activityID,'sandbox',cache,new Date(h.now),registrationTuple(current));
  const restarted=new LiveActivityStore(store.filePath,{publicationLoader:async()=>asset});await restarted.load();assert.equal(selectEvents(restarted.state.records[0].stationBoardCache,current,h.now).length,1);assert.equal(selectEvents(restarted.state.records[0].stationBoardCache,current,h.now+600001).length,0);
  const original=structuredClone(cache);await restarted.observeOfficialPublication({sha256:'f'.repeat(64),observedAt:h.now+1});await restarted.retainStationBoard(current.activityID,'sandbox',original,new Date(h.now+2),registrationTuple(current));assert.equal(restarted.state.records[0].stationBoardCache.sources.timetable,undefined);
  // HTTP Date is second-precision. Re-admit at a genuinely newer original
  // second, never mutate the original captured fixtures or prior source clocks.
  const recoveredClock=h.now+1000;
  const fetchRecovered=async url=>{const response=await h.refreshFetch(asset)(url);response.headers.set('date',new Date(recoveredClock).toUTCString());response.headers.set('age','0');return response;};
  const recovered=await refreshStationBoard(restarted.state.records[0],{}, {workerIntervalMs:90000},fetchRecovered,recoveredClock,undefined,()=>recoveredClock,new Map(),restarted);
  assert.equal(recovered.sources.timetable.observedAt,recoveredClock);
  assert.equal(recovered.sources.timetable.expiresAt,recoveredClock+600000);
  await restarted.retainStationBoard(current.activityID,'sandbox',recovered,new Date(recoveredClock),registrationTuple(current));
  await restarted.retainStationBoard(current.activityID,'sandbox',original,new Date(recoveredClock+1),registrationTuple(current));
  assert.equal(restarted.state.records[0].stationBoardCache.sources.timetable.observedAt,recoveredClock);
});
