// PRIVATE UNRUN transport test; real mock streaming Response, no external HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundedJSON } from '../server/bounded-json.js';
import { fetchJsonResponse } from '../server/notification-transport.js';
import { refreshStationBoard } from '../server/station-board-v2.js';
import { now,record,response,assetFor,refreshFetch,fakeAuthority,qualify,reply } from './timetable-renewal-helpers.js';
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

const publicationURL = 'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function originalURL(wireURL) { const u = new URL(wireURL); u.searchParams.delete('tb085'); return u.href; }
function assertNonce(wireURL) { const u = new URL(wireURL); assert.equal(u.searchParams.getAll('tb085').length, 1); assert.match(u.searchParams.get('tb085'), uuidPattern); return u.searchParams.get('tb085'); }

test('official HEAD and declared directional TT share canonical reads but have separate per-request UUIDs', async () => {
  const raws = [response(720, ['940GZZLUBNK'], 'inbound'), response(722, ['940GZZLUCHX'], 'outbound')], asset = assetFor(raws);
  const previous = { sources: { timetable: qualify(asset, raws) } }, wire = [], shared = new Map(), authority = fakeAuthority(asset);
  const base = refreshFetch(asset, Object.fromEntries(raws.map(r => [r.direction, r])));
  const config = { workerIntervalMs: 90000, tflAppKey: 'synthetic-nonce-key' };
  const fetchImpl = async (url, options) => { wire.push({url: String(url), method: options.method || 'GET'}); return base(url); };
  const states = await Promise.all([0,1].map(() => refreshStationBoard(record, previous, config, fetchImpl, now, undefined, () => now, shared, authority)));
  const heads = wire.filter(r => r.method === 'HEAD'), tt = wire.filter(r => new URL(r.url).pathname.includes('/Timetable/'));
  assert.equal(heads.length, 1); assert.equal(originalURL(heads[0].url), publicationURL);
  assert.equal(tt.length, 2); assert.deepEqual(tt.map(r => new URL(r.url).searchParams.get('direction')).sort(), ['inbound','outbound']);
  const nonces = [assertNonce(heads[0].url), ...tt.map(r => assertNonce(r.url))]; assert.equal(new Set(nonces).size, 3);
  for (const r of tt) { const u = new URL(r.url); assert.equal(r.method, 'GET'); assert.equal(u.origin + u.pathname, `https://api.tfl.gov.uk/Line/${record.lineID}/Timetable/${record.stationID}`); assert.equal(u.searchParams.get('app_key'), config.tflAppKey); assert.deepEqual([...u.searchParams.keys()].sort(), ['app_key','direction','tb085']); }
  assert.ok([...shared.keys()].every(k => !k.includes('tb085=')));
  assert.equal(shared.has('HEAD:' + publicationURL), true);
  for (const r of tt) assert.equal(shared.has('GET:' + originalURL(r.url)), true);
  for (const state of states) { assert.equal(state.sources.timetable.events.length, 2); assert.equal(state.sources.timetable.observedAt, now); assert.equal(state.sources.timetable.expiresAt, now + 600000); }
  const same = await refreshStationBoard(record, previous, config, async () => { throw Error('shared response must not be fetched again'); }, now, undefined, () => now + 1000, shared, authority);
  assert.equal(wire.filter(r => r.method === 'HEAD').length, 1); assert.equal(same.sources.timetable.observedAt, now); assert.equal(same.sources.timetable.expiresAt, now + 600000);
  const freshWire = [], nextBase = refreshFetch(asset, Object.fromEntries(raws.map(r => [r.direction, r])));
  const next = await refreshStationBoard(record, previous, config, async (url, options) => { freshWire.push({url: String(url), method: options.method || 'GET'}); return nextBase(url); }, now + 1000, undefined, () => now + 1000, new Map(), fakeAuthority(asset));
  const nextHeads = freshWire.filter(r => r.method === 'HEAD'), nextTT = freshWire.filter(r => new URL(r.url).pathname.includes('/Timetable/'));
  assert.equal(nextHeads.length, 1); assert.equal(nextTT.length, 2);
  for (const r of [...nextHeads,...nextTT]) assert.equal(nonces.includes(assertNonce(r.url)), false);
  assert.equal(next.sources.timetable.observedAt, now); assert.equal(next.sources.timetable.expiresAt, now + 600000); // A new nonce is not a new authority clock.
});

test('official HEAD and bounded TT missing-Age readback each reuse one URL and retain original response clocks', async () => {
  const asset = assetFor(), base = refreshFetch(asset), wire = [], counts = new Map(), shared = new Map(), authority = fakeAuthority(asset);
  const fetchImpl = async (url, options) => {
    const u = new URL(url), targeted = options.method === 'HEAD' || u.pathname.includes('/Timetable/');
    wire.push({url: String(url), method: options.method || 'GET'}); const value = await base(url);
    if (targeted) { const key = (options.method || 'GET') + ':' + originalURL(url), count = (counts.get(key) || 0) + 1; counts.set(key, count); value.headers.set('date', new Date(now - 1000).toUTCString()); if (count === 1) value.headers.delete('age'); else value.headers.set('age', '0'); }
    return value;
  };
  const state = await refreshStationBoard(record, {}, {workerIntervalMs:90000}, fetchImpl, now, undefined, () => now, shared, authority);
  for (const requests of [wire.filter(r => r.method === 'HEAD'), wire.filter(r => new URL(r.url).pathname.includes('/Timetable/'))]) { assert.equal(requests.length, 2); assert.equal(requests[0].url, requests[1].url); assertNonce(requests[0].url); }
  assert.equal(authority.publicationAuthority().officialIdentity.observedAt, now - 1000);
  assert.equal(state.sources.timetable.observedAt, now - 1000); assert.equal(state.sources.timetable.expiresAt, now - 1000 + 600000);
  assert.ok(state.sources.timetable.events.every(r => r.receivedAt === now - 1000 && r.expiresAt === now - 1000 + 600000));
});

test('a nonce cannot qualify stale or invalid official Age and missing Age remains at most two same-URL attempts', async () => {
  for (const [age, attempts] of [['6349',1], ['not-an-age',1], [null,2]]) {
    const asset = assetFor(), authority = fakeAuthority(asset), wire = [], base = refreshFetch(asset);
    const state = await refreshStationBoard(record, {}, {workerIntervalMs:90000}, async (url, options) => {
      wire.push({url:String(url),method:options.method || 'GET'}); const value = await base(url);
      if (options.method === 'HEAD') { if (age === null) value.headers.delete('age'); else value.headers.set('age', age); }
      return value;
    }, now, undefined, () => now, new Map(), authority);
    const heads = wire.filter(r => r.method === 'HEAD'); assert.equal(heads.length, attempts); assertNonce(heads[0].url); assert.ok(heads.every(r => r.url === heads[0].url));
    assert.equal(wire.some(r => new URL(r.url).pathname.includes('/Timetable/')), false);
    assert.equal(authority.publicationAuthority().officialIdentity, undefined); assert.equal(state.sources.timetable, undefined);
  }
});

test('primary, disruption, planner and incoming rail URLs retain their source authority while selected Status gains one UUID', async () => {
  const r = {...record, stationID:'910GSHENFLD', lineID:'elizabeth'}, wire = [], config = {workerIntervalMs:90000, tflAppKey:'synthetic-nonce-key'};
  const incoming = {naptanId:r.stationID, lineId:r.lineID, destinationNaptanId:r.stationID, destinationName:'Shenfield', departureStatus:'OnTime', platformName:'6', estimatedTimeOfArrival:new Date(now+70000).toISOString(), scheduledTimeOfArrival:new Date(now+300000).toISOString()};
  const outgoing = {naptanId:r.stationID, lineId:r.lineID, destinationNaptanId:'910GPADTLL', destinationName:'Paddington', departureStatus:'OnTime', platformName:'2', scheduledTimeOfDeparture:new Date(now+420000).toISOString()};
  const state = await refreshStationBoard(r, {}, config, async (url, options) => {
    const u = new URL(url); wire.push({url:String(url), method:options.method || 'GET'}); if (u.pathname.endsWith('/Status')) assertNonce(u); else assert.equal(u.searchParams.has('tb085'), false); assert.equal(u.searchParams.get('app_key'), config.tflAppKey);
    if (u.pathname.endsWith('/ArrivalDepartures')) return reply([outgoing,incoming], now, {'cache-control':'max-age=90'});
    if (u.pathname.endsWith('/Status')) return reply([{id:r.lineID,lineStatuses:[{statusSeverity:10,statusSeverityDescription:'Good Service'}]}]);
    if (u.pathname.includes('/Journey/')) return reply({journeys:[]});
    if (u.pathname.endsWith('/Arrivals') || u.pathname.endsWith('/Disruption')) return reply([]);
    throw Error('Unknown control URL '+u.href);
  }, now, undefined, () => now);
  assert.equal(wire.length, 5); assert.ok(wire.every(v => v.method === 'GET'));
  const byPath = new Map(wire.map(v => { const u = new URL(v.url); return [u.pathname,u]; }));
  for (const [path,query] of [[`/StopPoint/${r.stationID}/Arrivals`,[['app_key',config.tflAppKey]]],[`/StopPoint/${r.stationID}/ArrivalDepartures`,[['lineIds',r.lineID],['app_key',config.tflAppKey]]],[`/Line/${r.lineID}/Status`,[['detail','true'],['app_key',config.tflAppKey]]],[`/StopPoint/${r.stationID}/Disruption`,[['getFamily','true'],['includeRouteBlockedStops','true'],['flattenResponse','true'],['app_key',config.tflAppKey]]]]) { assert.equal(byPath.get(path).origin,'https://api.tfl.gov.uk'); const params = [...byPath.get(path).searchParams].filter(([k]) => !path.endsWith('/Status') || k !== 'tb085'); assert.deepEqual(params,query); }
  const planner = wire.find(v => new URL(v.url).pathname.includes('/Journey/')); assert.equal(new URL(planner.url).searchParams.get('timeIs'), 'Departing'); assert.equal(new URL(planner.url).searchParams.get('useRealTimeLiveArrivals'), 'false');
  const rows = state.sources['rail-departures'].events; assert.equal(rows.length,2); const arrived = rows.find(e => e.kind === 'incomingArrival'), departed = rows.find(e => e.kind === 'outgoingDeparture');
  assert.equal(arrived.time, now+70000); assert.equal(arrived.scheduledArrival, now+300000); assert.equal(arrived.platform,'6'); assert.equal(arrived.timeEvidence,'arrivalPrediction'); assert.equal(departed.time,now+420000); assert.equal(departed.timeEvidence,'scheduledDeparture');
  assert.ok(rows.every(e => e.receivedAt === now && e.expiresAt === now+90000));
});


test('all19 selected Status scopes keep one canonical shared request and original30-second authority', async () => {
  const { STATION_BOARD_LINES } = await import('../server/station-board-v2.js');
  assert.equal(STATION_BOARD_LINES.size,19);
  for (const [lineID,line] of STATION_BOARD_LINES) {
    const r = {...record,lineID,stationID:line.boundedOriginID}, wire=[], shared=new Map(), config={workerIntervalMs:90000,tflAppKey:'synthetic-status-key'};
    const fetchImpl=async(url,options)=>{const u=new URL(url);wire.push({url:String(url),method:options.method || 'GET'});return reply(u.pathname.endsWith('/Status')?[{id:lineID,lineStatuses:[{statusSeverity:10,statusSeverityDescription:'Good Service'}]}]:u.pathname.includes('/Journey/')?{journeys:[]}:[],now-5000);};
    const states=await Promise.all([0,1].map(()=>refreshStationBoard(r,{},config,fetchImpl,now,undefined,()=>now,shared)));
    const status=wire.filter(v=>new URL(v.url).pathname.endsWith('/Status'));assert.equal(status.length,1);const id=assertNonce(status[0].url);
    const canonical=`https://api.tfl.gov.uk/Line/${lineID}/Status?detail=true&app_key=${config.tflAppKey}`;assert.equal(originalURL(status[0].url),canonical);assert.equal(shared.has('GET:'+canonical),true);assert.ok([...shared.keys()].every(k=>!k.includes('tb085=')));
    for(const state of states){const p=state.availabilityProofs.find(p=>p.sourceScope==='lineStatus');assert.ok(p);assert.equal(p.stationID,r.stationID);assert.equal(p.lineID,lineID);assert.equal(p.observedAt,now-5000);assert.equal(p.expiresAt,now+25000);}
    const later=[];const next=await refreshStationBoard(r,{},config,async(u,o)=>{later.push(String(u));return fetchImpl(u,o);},now+1000,undefined,()=>now+1000,new Map());const nextURL=later.find(u=>new URL(u).pathname.endsWith('/Status'));assert.notEqual(assertNonce(nextURL),id);assert.equal(next.availabilityProofs.find(p=>p.sourceScope==='lineStatus').observedAt,now-5000);assert.equal(next.availabilityProofs.find(p=>p.sourceScope==='lineStatus').expiresAt,now+25000);
  }
});

test('selected Status missing-Age readback reuses exact URL without clock renewal', async()=>{
  const wire=[], config={workerIntervalMs:90000};let count=0;
  const state=await refreshStationBoard(record,{},config,async(url,options)=>{const u=new URL(url);wire.push(String(url));const value=reply(u.pathname.endsWith('/Status')?[{id:record.lineID,lineStatuses:[{statusSeverity:10,statusSeverityDescription:'Good Service'}]}]:u.pathname.includes('/Journey/')?{journeys:[]}:[],now-5000);if(u.pathname.endsWith('/Status')&&++count===1)value.headers.delete('age');return value;},now,undefined,()=>now);
  const status=wire.filter(u=>new URL(u).pathname.endsWith('/Status'));assert.equal(status.length,2);assert.equal(status[0],status[1]);assertNonce(status[0]);const p=state.availabilityProofs.find(p=>p.sourceScope==='lineStatus');assert.equal(p.observedAt,now-5000);assert.equal(p.expiresAt,now+25000);
});

test('selected Status present malformed or stale Age does not retry; absent stops after one readback', async()=>{
  for(const age of ['invalid','-1','601','31',null]){const wire=[];const state=await refreshStationBoard(record,{}, {workerIntervalMs:90000},async(url)=>{const u=new URL(url);wire.push(String(url));const value=reply(u.pathname.endsWith('/Status')?[{id:record.lineID,lineStatuses:[{statusSeverity:10,statusSeverityDescription:'Good Service'}]}]:u.pathname.includes('/Journey/')?{journeys:[]}:[],now-5000);if(u.pathname.endsWith('/Status')){if(age===null)value.headers.delete('age');else value.headers.set('age',age);}return value;},now,undefined,()=>now);const status=wire.filter(u=>new URL(u).pathname.endsWith('/Status'));assert.equal(status.length,age===null?2:1);assertNonce(status[0]);assert.ok(status.every(u=>u===status[0]));assert.equal(state.availabilityProofs.some(p=>p.sourceScope==='lineStatus'),false);}
});
