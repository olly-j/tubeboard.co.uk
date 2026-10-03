// PRIVATE UNRUN transport test; real mock streaming Response, no external HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundedJSON } from '../server/bounded-json.js';
import { fetchJsonResponse } from '../server/notification-transport.js';
import { refreshStationBoard } from '../server/station-board-v2.js';
import { now,record,response,assetFor,refreshFetch,fakeAuthority } from './timetable-renewal-helpers.js';
test('rawTransportBoundsUniqueJSONAndImmutableAge',async()=>{
  for(const bytes of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','{"x":1} trailing','{"n":9007199254740992}','{"n":true,}'])assert.throws(()=>parseBoundedJSON(Buffer.from(bytes)));
  assert.deepEqual({...parseBoundedJSON(Buffer.from('{"b":2,"a":1}'))},{b:2,a:1});assert.throws(()=>parseBoundedJSON(Buffer.from([0xff])));assert.throws(()=>parseBoundedJSON(Buffer.from('{"count":1.0}'),131072,64,true));assert.throws(()=>parseBoundedJSON(Buffer.from('['.repeat(66)+'0'+']'.repeat(66))));
  const body=Buffer.from(JSON.stringify({s:'x'.repeat(1024)}));
  const result=await fetchJsonResponse(new URL('https://api.tfl.gov.uk/Line/northern/Timetable/940GZZLUEGW'),async()=>new Response(body,{headers:{date:new Date(now).toUTCString(),age:'0'}}),{includeHeaders:true,bodyLimitBytes:body.length,decodeJSON:parseBoundedJSON});assert.equal(result.value.s.length,1024);assert.equal(result.bodySHA256.length,64);
  await assert.rejects(()=>fetchJsonResponse(new URL('https://api.tfl.gov.uk/test'),async()=>new Response(body),{bodyLimitBytes:body.length-1,decodeJSON:parseBoundedJSON}),/byte bound/);
  const asset=assetFor(),requests=[],base=refreshFetch(asset,undefined,requests),responses=new Map();let firstTT=true;
  const fetchImpl=async url=>{const r=await base(url);if(new URL(url).pathname.includes('/Timetable/')&&firstTT){firstTT=false;r.headers.delete('age');}return r;};
  const state=await refreshStationBoard(record,{}, {workerIntervalMs:90000},fetchImpl,now,undefined,()=>now,responses,fakeAuthority(asset));
  assert.equal(requests.filter(u=>u.includes('/Timetable/')).length,2);assert.equal(state.sources.timetable.observedAt,now);assert.equal(state.sources.timetable.expiresAt,now+600000);
  let later=now+30000;const same=await refreshStationBoard(record,{sources:state.sources}, {workerIntervalMs:90000},async()=>{throw Error('must use original shared response');},now,undefined,()=>later,responses,fakeAuthority(asset));assert.equal(same.sources.timetable.observedAt,now);assert.equal(same.sources.timetable.expiresAt,now+600000);
});
