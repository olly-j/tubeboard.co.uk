import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrimaryArrivalsSource, PRIMARY_ARRIVALS_PATH, PRIMARY_ARRIVALS_UPSTREAM, loadPrimaryArrivalsConfig, handlePrimaryArrivalsSource } from '../server/primary-arrivals-source.js';
const key = 'mock-private-product-key-A9';
const anchor = Date.parse('2026-10-18T14:00:00Z');
const xml = '<?xml version="1.0"?><ROOT><WhenCreated>18 Oct 2026 15:00:00</WhenCreated><S Code="WFD"><P N="2"><T TrainId="004" SetNo="022" SecondsTo="100"/></P></S></ROOT>';
function response(body = xml, extra = {}) { return new Response(body, { status: 200, headers: { 'content-type':'application/xml; charset=utf-8','date':new Date(anchor).toUTCString(), 'age':'0','cache-control':'public, max-age=30', ...extra } }); }
function fixture(fetcher = async () => response(), options = {}) { let now = anchor, calls = []; const source = new PrimaryArrivalsSource({ enabled:true,appKey:key,clock:()=>now,fetchImpl:async (...args)=>{calls.push(args);return fetcher(...args);},...options }); return {source,calls,advance:ms=>{now+=ms;}}; }
function noKey(value) { assert.equal(JSON.stringify(value).includes(key),false); }
test('configuration defaults disabled and uses only explicit separate TrackerNet key', () => {
 assert.deepEqual(loadPrimaryArrivalsConfig({TFL_APP_KEY:key}),{enabled:false,appKey:''});
 assert.deepEqual(loadPrimaryArrivalsConfig({TUBEBOARD_PRIMARY_ARRIVALS_ENABLED:'true',TFL_TRACKERNET_APP_KEY:key}),{enabled:true,appKey:key});
});
test('disabled and missing key never perform network', async () => {
 for (const options of [{enabled:false},{enabled:'true'},{appKey:''},{appKey:'bad\nkey'}]) {const f=fixture(undefined,options);assert.equal((await f.source.getSource()).status,'unavailable');assert.equal(f.calls.length,0);}
});
test('fixed HTTPS single read attaches key header only and preserves exact bytes/clocks', async () => {
 const f=fixture(async()=>{f.advance(120);return response();});const v=await f.source.getSource();assert.equal(v.status,'source');assert.equal(f.calls.length,1);
 const [url,options]=f.calls[0];assert.equal(url,PRIMARY_ARRIVALS_UPSTREAM);assert.equal(new URL(url).search,'');assert.equal(options.redirect,'error');assert.equal(options.headers.app_key,key);assert.equal(options.method,'GET');
 assert.equal(v.bodyUTF8,xml);assert.equal(v.bodySHA256,createHash('sha256').update(xml).digest('hex'));assert.equal(v.sourceID,'trackernet-arrivals-v1');assert.equal(v.requestStartedAt,new Date(anchor).toISOString());assert.equal(v.receivedAt,new Date(anchor+120).toISOString());assert.equal(v.upstream.age,'0');noKey(v);
});
test('concurrent consumers share one acquisition and identical immutable envelope', async()=>{
 let complete;const gate=new Promise(r=>{complete=r;});const f=fixture(async()=>{await gate;return response();});const a=f.source.getSource(),b=f.source.getSource();assert.equal(a,b);complete();const [x,y]=await Promise.all([a,b]);assert.equal(x,y);assert.equal(f.calls.length,1);assert.ok(Object.isFrozen(x));assert.ok(Object.isFrozen(x.upstream));
});
test('cache hit retains original receipt; expiry fetches once without mutating old object',async()=>{
 const f=fixture();const old=await f.source.getSource();f.advance(29999);assert.equal(await f.source.getSource(),old);f.advance(1);const fresh=await f.source.getSource();assert.equal(f.calls.length,2);assert.notEqual(fresh,old);assert.equal(old.receivedAt,new Date(anchor).toISOString());assert.equal(fresh.receivedAt,new Date(anchor+30000).toISOString());
});
test('original stale or missing HTTP metadata replays unchanged observation without inventing qualification',async()=>{
 for(const headers of [{'age':'40'},{'cache-control':''},{'date':'not-a-date'},{'age':'bad'}]) {
  const f=fixture(async()=>response(xml,headers));const first=await f.source.getSource();assert.equal(first.status,'source');
  f.advance(20000);const later=await f.source.getSource();assert.equal(later,first);assert.deepEqual(later.upstream,first.upstream);assert.equal(later.receivedAt,first.receivedAt);assert.equal(f.calls.length,1);
  f.advance(10000);await f.source.getSource();assert.equal(f.calls.length,2);
 }
});
test('explicit no-store or private forbids observation retention but preserves thirty-second admission floor',async()=>{
 for(const cache of ['no-store','private','public, no-store, max-age=30','private="authorization", max-age=30']) {
  const f=fixture(async()=>response(xml,{'cache-control':cache}));await f.source.getSource();f.advance(29999);assert.equal((await f.source.getSource()).reason,'rateLimited');assert.equal(f.calls.length,1);assert.equal(f.source.cached,null);
  f.advance(1);await f.source.getSource();assert.equal(f.calls.length,2);
 }
});
test('failed source admission is paced for thirty seconds with no retry burst',async()=>{
 const f=fixture(async()=>new Response('unavailable',{status:503}));const first=await f.source.getSource();assert.equal(first.reason,'upstreamFailed');
 f.advance(29999);assert.equal((await f.source.getSource()).reason,'rateLimited');assert.equal(f.calls.length,1);f.advance(1);await f.source.getSource();assert.equal(f.calls.length,2);
});
test('HTTP failure and 429 are explicit unavailable, not successful empty or retried',async()=>{
 for(const status of [401,403,429,500]){const f=fixture(async()=>new Response(key,{status}));const v=await f.source.getSource();assert.equal(v.status,'unavailable');assert.equal(v.reason,status===429?'rateLimited':'upstreamFailed');assert.equal(f.calls.length,1);noKey(v);assert.equal((await f.source.getSource()).reason,'rateLimited');}
});
test('network exception text and malformed response never expose key',async()=>{
 const f=fixture(async()=>{throw Error(key);});const v=await f.source.getSource();assert.equal(v.reason,'invalidResponse');noKey(v);
});
test('complete transport XML with zero trains is distinct from empty bytes without semantic empty claim',async()=>{
 const zero=fixture(async()=>response('<ROOT><S Code="WFD"/></ROOT>'));const v=await zero.source.getSource();assert.equal(v.status,'source');assert.equal('rows' in v,false);
 const empty=fixture(async()=>response(''));assert.equal((await empty.source.getSource()).reason,'invalidResponse');
});
test('body and metadata bounds, invalid UTF8, DTD and residual gzip fail closed',async()=>{
 const cases=[()=>response('x'.repeat(65537)),()=>response(Buffer.from([0xff,0xfe])),()=>response('<!DOCTYPE ROOT [<!ENTITY x "bad">]><ROOT/>'),()=>response(Buffer.from([0x1f,0x8b,8,0])),()=>response(xml,{'date':'x'.repeat(1025)}),()=>response(xml,{'content-length':'65537'}),()=>response(xml,{'content-type':'text/html'})];
 for(const create of cases){const f=fixture(async()=>create());const v=await f.source.getSource();assert.equal(v.reason,'invalidResponse');noKey(v);}
});
test('credential reflection plaintext/percent/base64/XML entity/nested representations withheld',async()=>{
 const escaped=Array.from(key).map(c=>'&#'+c.charCodeAt(0)+';').join('');
 for(const value of [key,encodeURIComponent(key),Buffer.from(key).toString('base64'),escaped,escaped.replaceAll('&','&amp;')]) {const f=fixture(async()=>response('<ROOT>'+value+'</ROOT>'));const v=await f.source.getSource();assert.equal(v.reason,'invalidResponse');noKey(v);}
 const f=fixture(async()=>response(xml,{'cache-control':key}));assert.equal((await f.source.getSource()).reason,'invalidResponse');
});
test('accepted quote and backslash key reflected in a raw header is withheld before JSON escaping',async()=>{
 const specialKey='mock"accepted\\key';
 const accepted=fixture(undefined,{appKey:specialKey});
 assert.equal((await accepted.source.getSource()).status,'source','special characters are accepted key input, not the missingKey gate');
 assert.equal(accepted.calls[0][1].headers.app_key,specialKey);
 for(const name of ['date','age','cache-control']) {
  const f=fixture(async()=>response(xml,{[name]:specialKey}),{appKey:specialKey});
  const value=await f.source.getSource();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].headers.app_key,specialKey);
  assert.equal(value.status,'unavailable');assert.equal(value.reason,'invalidResponse');
  assert.equal(value.upstream,undefined);assert.equal(value.bodyUTF8,undefined);assert.equal(f.source.cached,null);
  assert.equal((await f.source.getSource()).reason,'rateLimited');assert.equal(f.calls.length,1);
 }
});
test('deadline bounds hung fetch once with no retry',async()=>{
 const f=fixture(async()=>new Promise(()=>{}),{timeoutMs:15});const start=Date.now();const v=await f.source.getSource();assert.equal(v.reason,'timeout');assert.equal(f.calls.length,1);assert.ok(Date.now()-start<1000);
});
test('deadline includes never-ending body; cancellation completion cannot extend deadline',async()=>{
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('<ROOT>'));},cancel(){return new Promise(()=>{});}});
 const f=fixture(async()=>new Response(body,{headers:{'content-type':'application/xml'}}),{timeoutMs:15});const start=Date.now();assert.equal((await f.source.getSource()).reason,'timeout');assert.ok(Date.now()-start<1000);
});
test('response redirect mismatch withheld even if injected transport ignores redirect:error',async()=>{
 const value=response();Object.defineProperty(value,'url',{value:'https://other.invalid/'});const f=fixture(async()=>value);assert.equal((await f.source.getSource()).reason,'invalidResponse');
});
test('fixed endpoint rejects method/query/other selection without acquiring source',async()=>{
 let calls=0;const source={getSource:async()=>{calls++;return {status:'source'};}};
 for(const [method,path,status] of [['POST',PRIMARY_ARRIVALS_PATH,405],['GET',PRIMARY_ARRIVALS_PATH+'?upstream=evil',400],['GET','/api/primary-arrivals/v1/northern/940GZZLUEGW',404]]) {
  const result={writeHead(s,h){this.status=s;this.headers=h;},end(body){this.body=JSON.parse(body);}};assert.equal(await handlePrimaryArrivalsSource({method},result,new URL(path,'https://tubeboard.co.uk'),source),true);assert.equal(result.status,status);assert.equal(result.headers['cache-control'],'no-store');
 }
 assert.equal(calls,0);assert.equal(await handlePrimaryArrivalsSource({method:'GET'},{},new URL('https://tubeboard.co.uk/healthz'),source),false);
});
test('successful fixed handler serializes envelope no-store; disconnected consumer does not cancel other waiter',async()=>{
 const f=fixture();const result={writeHead(s,h){this.status=s;this.headers=h;},end(body){this.body=JSON.parse(body);}};await handlePrimaryArrivalsSource({method:'GET'},result,new URL(PRIMARY_ARRIVALS_PATH,'https://tubeboard.co.uk'),f.source);assert.equal(result.status,200);assert.equal(result.body.bodyUTF8,xml);assert.equal(result.headers['cache-control'],'no-store');
 await handlePrimaryArrivalsSource({method:'GET'},{destroyed:true},new URL(PRIMARY_ARRIVALS_PATH,'https://tubeboard.co.uk'),f.source);assert.equal(f.calls.length,1);
});
