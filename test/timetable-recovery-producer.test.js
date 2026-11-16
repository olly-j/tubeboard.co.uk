import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TimetableRecoveryProducer } from '../server/timetable-recovery-producer.js';
import { canonicalResource } from '../server/timetable-publication-resource.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url));
const scope='northern/940GZZLUEGW';
const heldRoots=new Set();
const archive=Buffer.from('offline adapter archive fixture');
const publication=hash(archive);
const priorPub='788955e868b7ae85219db15b4e05c2f187bdf3be1767f16b1c369b60dea08ad7';
const sourceRoot=path.join(root,'server/timetable-source-archives/v1',priorPub,'0c5fba0afe99c032a4477fc9126158f26aeafc3ad9fdd173c3d6c489f2fb191c');
function resource(pub,entries,revision=1){
 const proof=Buffer.from(JSON.stringify({schemaVersion:1,timezone:'Europe/London',publication:{sha256:pub,url:'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip'},entries}));
 return canonicalResource({schemaVersion:1,publicationSHA256:pub,proofRevision:revision,proofBodySHA256:hash(proof),proofBodyBase64:proof.toString('base64')});
}
async function setup(t,options={}){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'tb-recovery-producer-'));t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
 const priorBytes=resource(priorPub,[{lineID:'northern',stationID:'940GZZLUEGW',status:'qualified'}]);
 const priorWrapper=JSON.parse(priorBytes),calls=[],admissions=[];
 const store={latestAdmittedIdentity:{publicationSHA256:priorPub,resourceSHA256:hash(priorBytes),proofBodySHA256:priorWrapper.proofBodySHA256,proofRevision:1},
  async admitTrustedPackage(value){admissions.push(value);const wrapper=JSON.parse(value.resourceBytes),manifest=JSON.parse(value.manifestBytes);
   const first=manifest.sources[0];assert.equal(hash(await value.readBody(first.bodySHA256)),first.bodySHA256);
   return {publicationSHA256:wrapper.publicationSHA256,proofRevision:wrapper.proofRevision,proofBodySHA256:wrapper.proofBodySHA256};}};
 const spawnChild=(command,args,opts)=>{
  assert.equal(command,'/usr/bin/python3');assert.deepEqual(args.slice(0,3),['-I','-B','-c']);
  assert.deepEqual(Object.keys(opts.env).sort(),['LANG','PATH','TEMP','TMP','TMPDIR']);
  const holderConfig=JSON.parse(args.at(-1));
  if(options.workerScript){
   const actualLauncher=holderConfig.launcher;
   holderConfig.launcher="import os,sys,json,time,signal\nsys.path.insert(0,sys.argv[1]+'/scripts')\nimport tb085_prepare_renewal as fixture_module\njob=json.loads(sys.argv[2])\ndef offline(*args,**kwargs):exec("+JSON.stringify(options.workerScript)+",globals())\nfixture_module.acquire_and_record=offline\nfixture_module.prepare=offline\nexec("+JSON.stringify(actualLauncher)+",globals())";
   const child=spawn(command,[...args.slice(0,-1),JSON.stringify(holderConfig)],opts);options.onHolder?.(child);return child;
  }
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');let locked=false,ended=false;
  setImmediate(async()=>{if(holderConfig.roots.some(r=>heldRoots.has(r))){emit({status:'busy'});child.emit('close',2,null);return;}
   for(const r of holderConfig.roots){heldRoots.add(r);await fs.writeFile(path.join(r,'.producer-lock'),'');}locked=true;emit({status:'ready'});});
  child.stdin.on('end',()=>{if(ended)return;ended=true;if(locked)for(const r of holderConfig.roots)heldRoots.delete(r);setImmediate(()=>child.emit('close',0,null));});
  let pending='';child.stdin.on('data',chunk=>{pending+=chunk.toString();if(!pending.endsWith('\n'))return;
   const job=JSON.parse(pending);pending='';calls.push(job);emit({status:'started',pid:1});
   setImmediate(async()=>{try{
   if(job.mode==='acquire'){
    const metadata={body:'official.body',sha256:job.publication,bytes:archive.length,startedAt:'2026-11-16T12:00:00Z',receivedAt:'2026-11-16T12:00:01Z'};
    await fs.writeFile(path.join(job.work,'source.zip'),archive);
    await fs.writeFile(path.join(job.work,'metadata.json'),JSON.stringify(metadata));
    await fs.writeFile(path.join(job.work,'receipt.json'),JSON.stringify({status:'verified-source-only',publication:job.publication,sha256:job.publication,bytes:archive.length}));
    await options.alterAcquire?.(job.work);
   }else{
    await options.beforePrepare?.(job);
    const candidate=path.join(job.work,'candidate');await fs.mkdir(path.join(candidate,'source-archive/bodies'),{recursive:true});
    const bytes=resource(job.publication,options.entries??[{lineID:'northern',stationID:'940GZZLUEGW',status:'qualified'}]);
    const wrapper=JSON.parse(bytes),manifest=JSON.parse(await fs.readFile(path.join(sourceRoot,'manifest.json')));
    manifest.publicationSHA256=job.publication;manifest.proofBodySHA256=wrapper.proofBodySHA256;
    for(const item of manifest.sources)await fs.copyFile(path.join(sourceRoot,item.bodyPath),path.join(candidate,'source-archive',item.bodyPath));
    await fs.writeFile(path.join(candidate,job.publication+'.json'),bytes);
    await fs.writeFile(path.join(candidate,'source-archive/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    await options.alterCandidate?.(candidate,job);
   }
   emit({status:'done',code:0});
  }catch{emit({status:'done',code:1});}});
  });return child;
 };
 const config={cacheDirectory:path.join(tmp,'cache'),workDirectory:path.join(tmp,'work'),admissionStore:store,readCurrentResource:async()=>priorBytes,spawnChild,...options.config};
 const producer=new TimetableRecoveryProducer(config);
 return {producer,tmp,calls,admissions,store,priorBytes,config};
}

test('verified predecessor, bounded bundle and cache are passed to preparation; admission CAS and unresolved scopes retained',async t=>{
 const x=await setup(t);assert.deepEqual(await x.producer.recover({publicationSHA256:publication,scopes:[scope]}),{unresolvedScopes:[]});
 assert.deepEqual(x.calls.map(c=>c.mode),['acquire','prepare']);assert.deepEqual(x.calls[1].scopes,[scope]);
 assert.equal(x.calls[1].previous.resourceSHA256,hash(x.priorBytes));assert.equal(x.admissions[0].previousResourceSHA256,hash(x.priorBytes));
 const metadata=await fs.readFile(path.join(x.tmp,'cache',publication,'metadata.json'));
 await x.producer.recover({publicationSHA256:publication,scopes:[scope]});
 assert.equal(x.calls.filter(c=>c.mode==='acquire').length,1);assert.deepEqual(await fs.readFile(path.join(x.tmp,'cache',publication,'metadata.json')),metadata);
 assert.deepEqual((await fs.readdir(path.join(x.tmp,'work'))).filter(n=>n!=='.producer-lock'),[]);
});
test('rollover without pending scopes seeds only actual validated prior qualification; no history fails closed',async t=>{
 const x=await setup(t);await x.producer.recover({publicationSHA256:publication,scopes:[]});assert.deepEqual(x.calls[1].scopes,[scope]);
 x.store.latestAdmittedIdentity=null;await assert.rejects(x.producer.recover({publicationSHA256:publication,scopes:[]}),/predecessor-missing/);assert.equal(x.calls.length,2);
});
test('unknown and duplicate scopes, predecessor mismatch cannot launch a producer',async t=>{
 const x=await setup(t);
 for(const scopes of [[scope,scope],['northern/UNKNOWN'],['../escape'],Array(33).fill(scope)])await assert.rejects(x.producer.recover({publicationSHA256:publication,scopes}),/scope-invalid/);
 x.store.latestAdmittedIdentity.resourceSHA256='a'.repeat(64);await assert.rejects(x.producer.recover({publicationSHA256:publication,scopes:[scope]}),/predecessor-mismatch/);assert.equal(x.calls.length,0);
});
test('unqualified request remains unresolved; candidate path symlink cannot escape',async t=>{
 const x=await setup(t,{entries:[]});assert.deepEqual(await x.producer.recover({publicationSHA256:publication,scopes:[scope]}),{unresolvedScopes:[scope]});
 const y=await setup(t,{alterCandidate:async candidate=>{await fs.rm(path.join(candidate,'source-archive'),{recursive:true});await fs.symlink(sourceRoot,path.join(candidate,'source-archive'));}});
 await assert.rejects(y.producer.recover({publicationSHA256:publication,scopes:[scope]}),/(?:output|workspace)-path/);assert.equal(y.admissions.length,0);
});
test('corrupt archive is reacquired and completed cache retains at most two editions; owned stale stages cleaned',async t=>{
 const x=await setup(t);await x.producer.recover({publicationSHA256:publication,scopes:[scope]});
 await fs.writeFile(path.join(x.tmp,'cache',publication,'source.zip'),'corrupt');
 for(const name of ['a'.repeat(64),'b'.repeat(64)])await fs.mkdir(path.join(x.tmp,'cache',name));
 await fs.mkdir(path.join(x.tmp,'cache','.acquire-stale'));await fs.mkdir(path.join(x.tmp,'work','producer-stale'));
 await x.producer.recover({publicationSHA256:publication,scopes:[scope]});
 assert.equal(x.calls.filter(c=>c.mode==='acquire').length,2);assert.equal(((await fs.readdir(path.join(x.tmp,'cache'))).filter(n=>n!=='.producer-lock')).length,2);assert.deepEqual((await fs.readdir(path.join(x.tmp,'work'))).filter(n=>n!=='.producer-lock'),[]);
});
for(const kind of ['timeout','cancel','output-limit','workspace-limit'])test(`real process ${kind} terminates before cleanup; no admission or simultaneous call`,{timeout:8000},async t=>{
 let started;const ready=new Promise(r=>started=r);let holder;
 const script=kind==='output-limit'?"print('x'*129,flush=True)\ntime.sleep(20)":kind==='workspace-limit'?"for name in ['a','b']:\n with open(job['work']+'/'+name,'wb') as f:f.truncate(85*1024*1024)\ntime.sleep(20)":"signal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(20)";
 const x=await setup(t,{config:{timeoutMs:kind==='timeout'?1000:4000,outputLimit:128},workerScript:script,onHolder:child=>{holder=child;child.stdout.on('data',b=>{if(String(b).includes('"status":"started"'))started();});}});
 const controller=new AbortController(),running=x.producer.recover({publicationSHA256:publication,scopes:[scope],signal:controller.signal});await ready;
 await assert.rejects(x.producer.recover({publicationSHA256:publication,scopes:[scope]}),/busy/);
 if(kind==='cancel')controller.abort(new Error('caller cancelled'));
 await assert.rejects(running,kind==='cancel'?/caller cancelled/:new RegExp(kind));assert.ok(holder.exitCode!==null || holder.signalCode!==null);
 assert.equal(x.admissions.length,0);assert.equal(x.producer.active,false);assert.deepEqual((await fs.readdir(path.join(x.tmp,'cache'))).filter(n=>n!=='.producer-lock'),[]);
});

test('real bundled acquisition/cache functions preserve original clocks after source.zip rename; exact launcher prepare API smoke', {timeout:10000}, async t=>{
 const x=await setup(t);let captured;
 const adapter=new TimetableRecoveryProducer({...x.config,spawnChild:(cmd,args,opts)=>{
  captured={cmd,args,opts};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();setImmediate(()=>child.emit('close',1));return child;}});
 await assert.rejects(adapter.recover({publicationSHA256:publication,scopes:[scope]}));assert.ok(captured);
 const smoke=String.raw`
import sys,json,runpy,tempfile,zipfile,hashlib,time,datetime
from pathlib import Path
sys.path.insert(0,sys.argv[1]+'/scripts')
import tb085_prepare_renewal as p
base=Path(sys.argv[2]); cache=base/'smoke-cache';cache.mkdir(); out=base/'smoke-out';out.mkdir()
archive=cache/'official.body'
nested=__import__('io').BytesIO()
with zipfile.ZipFile(nested,'w') as z:z.writestr('one.xml','<root/>')
with zipfile.ZipFile(archive,'w') as z:z.writestr('LULDLRTRAMRIVERCABLE FULL fixture.zip',nested.getvalue())
pub=hashlib.sha256(archive.read_bytes()).hexdigest();clock='2026-11-16T12:00:01+00:00'
headers={'x-amz-meta-sha256':pub,'date':'Mon, 16 Nov 2026 12:00:01 GMT','age':'0','cache-control':'max-age=60'}
metadata={'body':'official.body','url':p.qualifier.SOURCE_URL,'status':200,'sha256':pub,'bytes':archive.stat().st_size,'headers':headers,'startedAt':'2026-11-16T12:00:00+00:00','receivedAt':clock}
p.acquire_current_zip=lambda *args:metadata
p.confirm_current_edition=lambda *args:{'headers':headers}
assert p.acquire_and_record(cache,pub,time.monotonic()+10,cache/'receipt.json')==metadata
p.write_json(cache/'metadata.json',metadata);archive.rename(cache/'source.zip')
p.fresh_cached_edition=lambda *args:{'headers':headers}
retained=p.acquire_cached_archive(out,pub,time.monotonic()+10,cache/'source.zip',cache/'receipt.json',cache/'metadata.json')
assert retained['receivedAt']==clock and retained['startedAt']==metadata['startedAt'] and retained['body']=='cached-official.zip'
assert json.loads((cache/'metadata.json').read_text())==metadata
launcher=sys.argv[3]
job={'mode':'acquire','publication':pub,'work':str(base/'launcher-acquire'),'remainingSeconds':10};Path(job['work']).mkdir()
def acquire(work,publication,deadline,receipt):
 assert publication==pub and receipt==work/'receipt.json'
 (work/'original.body').write_bytes(b'fixture');return dict(metadata,body='original.body')
p.acquire_and_record=acquire
original=sys.argv[:]
def launch(job):
 pid=__import__('os').fork()
 if pid==0:
  sys.argv=['launcher',original[1],json.dumps(job)]
  try:exec(launcher,{'__name__':'__main__'})
  except BaseException:__import__('traceback').print_exc();__import__('os')._exit(1)
  __import__('os')._exit(0)
 assert __import__('os').waitpid(pid,0)[1]==0
launch(job)
assert (Path(job['work'])/'source.zip').read_bytes()==b'fixture'

def prepare(publication,output,*,same_edition,additive_only,expected_resource_sha,expected_proof_sha,expected_revision,prior_served,requested_scopes,source_archive,source_archive_receipt,source_archive_metadata):
 assert publication==pub and requested_scopes==['northern/940GZZLUEGW']
 assert source_archive==cache/'source.zip' and source_archive_receipt==cache/'receipt.json' and source_archive_metadata==cache/'metadata.json'
 assert expected_resource_sha=='a'*64 and expected_proof_sha=='b'*64 and expected_revision==7
 assert same_edition==additive_only and ((prior_served is None)==same_edition)
 (out/('same' if same_edition else 'rollover')).write_text('verified')
p.prepare=prepare
for previous in (pub,'c'*64):
 job={'mode':'prepare','publication':pub,'remainingSeconds':10,'work':str(out),'cache':str(cache),'scopes':['northern/940GZZLUEGW'],'previous':{'publication':previous,'resourceSHA256':'a'*64,'proofBodySHA256':'b'*64,'revision':7}}
 launch(job)
assert (out/'same').read_text()==(out/'rollover').read_text()=='verified'
print('exact bundled acquisition/cache and launcher API smoke passed')
`;
 const output=execFileSync('/usr/bin/python3',['-I','-B','-c',smoke,JSON.parse(captured.args.at(-1)).bundle,x.tmp,JSON.parse(captured.args.at(-1)).launcher],{encoding:'utf8',timeout:9000,env:{PATH:'/usr/bin:/bin',TMPDIR:x.tmp,TMP:x.tmp,TEMP:x.tmp}});
 assert.match(output,/smoke passed/);
});

test('preparation captures predecessor CAS before asynchronous work; second adapter cannot clean active stages',async t=>{
 let release,entered;const barrier=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const x=await setup(t,{beforePrepare:async()=>{entered();await barrier;}});
 const initial=x.store.latestAdmittedIdentity.resourceSHA256;
 const running=x.producer.recover({publicationSHA256:publication,scopes:[scope]});await ready;
 const other=new TimetableRecoveryProducer(x.config);
 await assert.rejects(other.recover({publicationSHA256:publication,scopes:[scope]}),/busy/);
 x.store.latestAdmittedIdentity.resourceSHA256='f'.repeat(64);
 release();await running;assert.equal(x.admissions[0].previousResourceSHA256,initial);
});
test('valid wrapper without prior qualification does not invent a rollover station',async t=>{
 const x=await setup(t),bytes=resource(priorPub,[]),wrapper=JSON.parse(bytes);
 x.store.latestAdmittedIdentity={publicationSHA256:priorPub,proofRevision:1,resourceSHA256:hash(bytes),proofBodySHA256:wrapper.proofBodySHA256};
 const producer=new TimetableRecoveryProducer({...x.config,readCurrentResource:async()=>bytes});
 await assert.rejects(producer.recover({publicationSHA256:publication,scopes:[]}),/predecessor-no-qualified-scope/);assert.equal(x.calls.length,0);
});
test('cancellation terminates a real descendant process group before removing owned workspace', {timeout:8000},async t=>{
 let started;const ready=new Promise(r=>started=r);let descendant;
 t.after(()=>{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}});
 const x=await setup(t,{workerScript:"import subprocess\np=subprocess.Popen(['/usr/bin/python3','-c','import time;time.sleep(20)'])\nprint(p.pid,flush=True)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(20)",
 onHolder:child=>child.stderr.once('data',b=>{descendant=Number(String(b).trim());started();})});
 const controller=new AbortController();const running=x.producer.recover({publicationSHA256:publication,scopes:[scope],signal:controller.signal});await ready;
 controller.abort(new Error('stop group'));await assert.rejects(running,/stop group/);
 assert.throws(()=>process.kill(descendant,0),{code:'ESRCH'});assert.equal(x.admissions.length,0);
});

for(const direction of ['cache-inside-work','work-inside-cache'])test(`overlapping dedicated roots rejected before locks/cleanup: ${direction}`,async t=>{
 const x=await setup(t),outer=path.join(x.tmp,'owned'),inner=path.join(outer,direction==='cache-inside-work'?'producer-cache':'.acquire-work');
 await fs.mkdir(inner,{recursive:true});await fs.writeFile(path.join(inner,'sentinel'),'preserve');
 const cacheDirectory=direction==='cache-inside-work'?inner:outer,workDirectory=direction==='cache-inside-work'?outer:inner;
 const producer=new TimetableRecoveryProducer({...x.config,cacheDirectory,workDirectory});
 await assert.rejects(producer.recover({publicationSHA256:publication,scopes:[scope]}),/directory-invalid/);
 assert.equal(await fs.readFile(path.join(inner,'sentinel'),'utf8'),'preserve');assert.equal(x.calls.length,0);
 assert.deepEqual(await fs.readdir(inner),['sentinel']);assert.deepEqual(await fs.readdir(outer),[path.basename(inner)]);
});
test('fast acquisition overflow is rejected even before sampled watchdog could run',async t=>{
 const x=await setup(t,{alterAcquire:async work=>{const name=path.join(work,'oversized-final');await fs.writeFile(name,'');await fs.truncate(name,165*1024*1024);}});
 await assert.rejects(x.producer.recover({publicationSHA256:publication,scopes:[scope]}),/workspace-limit/);
 assert.equal(x.calls.length,1);assert.equal(x.admissions.length,0);assert.deepEqual((await fs.readdir(path.join(x.tmp,'cache'))).filter(n=>n!=='.producer-lock'),[]);
});

for(const kind of ['unknown-file','unknown-symlink','oversized-edition'])test(`cache rejects unbounded or unknown retained state without deleting it: ${kind}`,async t=>{
 const x=await setup(t),cache=path.join(x.tmp,'cache');await fs.mkdir(cache);
 const target=path.join(x.tmp,'sentinel');await fs.writeFile(target,'preserve');
 if(kind==='unknown-file')await fs.writeFile(path.join(cache,'unrecognized'),'preserve');
 else if(kind==='unknown-symlink')await fs.symlink(target,path.join(cache,'unrecognized'));
 else {const dir=path.join(cache,'a'.repeat(64));await fs.mkdir(dir);const file=path.join(dir,'large');await fs.writeFile(file,'');await fs.truncate(file,165*1024*1024);}
 await assert.rejects(x.producer.recover({publicationSHA256:publication,scopes:[scope]}),/(?:cache-path|workspace-limit)/);
 assert.equal(x.calls.length,0);assert.equal(await fs.readFile(target,'utf8'),'preserve');assert.equal(((await fs.readdir(cache)).filter(n=>n!=='.producer-lock')).length,1);
});

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,limit=5000){const deadline=performance.now()+limit;while(!await predicate()){if(performance.now()>=deadline)assert.fail('bounded OS lifetime observation timed out');await pause(25);}}
function canLock(roots){return spawnSync('/usr/bin/python3',['-I','-B','-c',"import sys,fcntl,os\nf=[]\ntry:\n for root in sys.argv[1:]:\n  fd=os.open(root+'/.producer-lock',os.O_RDWR|os.O_NOFOLLOW);f.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(2)",...roots],{timeout:1000}).status===0;}

test('abrupt holder death retains kernel custody until actual independent producer deadline; next attempt self-recovers', {timeout:12000},async t=>{
 let ready;const started=new Promise(r=>ready=r);let holder;
 const x=await setup(t,{config:{timeoutMs:3000},workerScript:"open(job['work']+'/sentinel','w').write('preserve while alive')\nprint('ready',flush=True)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(30)",onHolder:child=>{holder=child;child.stderr.once('data',()=>ready());}});
 const running=x.producer.recover({publicationSHA256:publication,scopes:[scope]}).then(()=>null,error=>error);await started;
 const roots=[x.config.cacheDirectory,x.config.workDirectory];assert.equal(canLock(roots),false);
 holder.kill('SIGKILL');
 const other=await setup(t,{workerScript:"raise ValueError('offline intentional failure')"});
 const next=new TimetableRecoveryProducer({...other.config,cacheDirectory:roots[0],workDirectory:roots[1]});
 await assert.rejects(next.recover({publicationSHA256:publication,scopes:[scope]}),/busy/);
 const stages=(await fs.readdir(roots[0])).filter(n=>n.startsWith('.acquire-'));assert.equal(stages.length,1);
 assert.equal(await fs.readFile(path.join(roots[0],stages[0],'sentinel'),'utf8'),'preserve while alive');
 await until(()=>canLock(roots));assert.match((await running).message,/(?:holder-ended|timeout)/);
 await assert.rejects(next.recover({publicationSHA256:publication,scopes:[scope]}),/failed/);
 assert.deepEqual((await fs.readdir(roots[0])).filter(n=>n!=='.producer-lock'),[]);
 assert.deepEqual((await fs.readdir(roots[1])).filter(n=>n!=='.producer-lock'),[]);
});

test('abrupt parent death closes stdin, kills producer group and releases persistent kernel lock files automatically', {timeout:12000},async t=>{
 const x=await setup(t),paths=[x.config.cacheDirectory,x.config.workDirectory],prior=path.join(x.tmp,'prior.json');await fs.writeFile(prior,x.priorBytes);
 const parentScript=`import fs from 'node:fs/promises';import {spawn} from 'node:child_process';import {TimetableRecoveryProducer} from ${JSON.stringify(new URL('../server/timetable-recovery-producer.js',import.meta.url).href)};
 const config=JSON.parse(process.argv[1]),bytes=await fs.readFile(config.prior);
 const producer=new TimetableRecoveryProducer({cacheDirectory:config.roots[0],workDirectory:config.roots[1],admissionStore:{latestAdmittedIdentity:config.identity,admitTrustedPackage:async()=>{throw Error('unexpected');}},readCurrentResource:async()=>bytes,
 spawnChild:(cmd,args,opts)=>{const h=JSON.parse(args.at(-1)),actual=h.launcher;h.launcher="import sys,time,json\\nsys.path.insert(0,sys.argv[1]+'/scripts')\\nimport tb085_prepare_renewal as p\\ndef offline(*a,**k):print('ready',flush=True);time.sleep(30)\\np.acquire_and_record=offline\\nexec("+JSON.stringify(actual)+",globals())";const c=spawn(cmd,[...args.slice(0,-1),JSON.stringify(h)],opts);c.stderr.once('data',()=>console.log('worker-ready'));return c;}});
 await producer.recover({publicationSHA256:config.publication,scopes:[config.scope]});`;
 let ready;const started=new Promise(r=>ready=r);
 const parent=spawn(process.execPath,['--input-type=module','-e',parentScript,JSON.stringify({prior,roots:paths,identity:x.store.latestAdmittedIdentity,publication,scope})],{stdio:['ignore','pipe','pipe'],env:process.env});
 t.after(()=>parent.kill('SIGKILL'));let diagnostic='';parent.stderr.on('data',b=>diagnostic+=b);parent.stdout.on('data',b=>{if(String(b).includes('worker-ready'))ready();});
 parent.once('exit',()=>{if(diagnostic)ready();});await started;assert.equal(diagnostic,'');assert.equal(canLock(paths),false);
 parent.kill('SIGKILL');await until(()=>canLock(paths));
 const nextFixture=await setup(t,{workerScript:"raise ValueError('offline intentional failure')"});
 const next=new TimetableRecoveryProducer({...nextFixture.config,cacheDirectory:paths[0],workDirectory:paths[1]});
 await assert.rejects(next.recover({publicationSHA256:publication,scopes:[scope]}),/failed/);
 assert.deepEqual((await fs.readdir(paths[0])).filter(n=>n!=='.producer-lock'),[]);
 assert.deepEqual((await fs.readdir(paths[1])).filter(n=>n!=='.producer-lock'),[]);
});

test('leader exits on TERM while descendant ignores TERM: entire group still ends before lock release', {timeout:8000},async t=>{
 let ready;const started=new Promise(r=>ready=r);let descendant;
 t.after(()=>{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}});
 const script="import subprocess\nsubprocess.Popen(['/usr/bin/python3','-c',\"import os,time,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(os.getpid(),flush=True);time.sleep(30)\"])\ntime.sleep(30)";
 const x=await setup(t,{workerScript:script,onHolder:child=>child.stderr.once('data',b=>{descendant=Number(String(b).trim());ready();})});
 const controller=new AbortController(),running=x.producer.recover({publicationSHA256:publication,scopes:[scope],signal:controller.signal});await started;
 controller.abort(new Error('stop leader and descendant'));await assert.rejects(running,/stop leader and descendant/);
 await until(()=>{try{process.kill(descendant,0);return false;}catch(error){return error.code==='ESRCH';}},2000);
 assert.equal(canLock([x.config.cacheDirectory,x.config.workDirectory]),true);assert.equal(x.admissions.length,0);
});

test('completed job fences a delayed watchdog error from closing the next job', {timeout:5000},async t=>{
 const original=fs.readdir;let watched,intercepted=false,begin,release,finished;
 const began=new Promise(r=>begin=r),held=new Promise(r=>release=r),ended=new Promise(r=>finished=r);
 fs.readdir=async function(directory,...args){
  if(directory===watched && !intercepted){intercepted=true;begin();try{await held;throw Object.assign(new Error('former stage moved'),{code:'ENOENT'});}finally{finished();}}
  return original.call(this,directory,...args);
 };
 try{
  const x=await setup(t,{alterAcquire:async work=>{watched=work;await began;},beforePrepare:async()=>{release();await ended;}});
  assert.deepEqual(await x.producer.recover({publicationSHA256:publication,scopes:[scope]}),{unresolvedScopes:[]});
  assert.equal(intercepted,true);assert.equal(x.admissions.length,1);
 }finally{release();fs.readdir=original;}
});

test('producer leader error cannot release custody with a surviving descendant', {timeout:6000},async t=>{
 let ready;const started=new Promise(r=>ready=r);let descendant,running;
 t.after(async()=>{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await running;});
 const script="import subprocess\nchild=subprocess.Popen(['/usr/bin/python3','-c',\"import os,time,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(os.getpid(),flush=True);time.sleep(30)\"],stdout=subprocess.PIPE,text=True)\nprint(child.stdout.readline(),end='',flush=True)\nraise ValueError('offline leader error')";
 const x=await setup(t,{workerScript:script,onHolder:child=>child.stderr.once('data',b=>{descendant=Number(String(b).trim().match(/^\d+/)?.[0]);ready();})});
 running=x.producer.recover({publicationSHA256:publication,scopes:[scope]}).then(()=>null,error=>error);await started;assert.ok(descendant);
 await until(()=>canLock([x.config.cacheDirectory,x.config.workDirectory]),3000);
 assert.throws(()=>process.kill(descendant,0),{code:'ESRCH'});assert.match((await running).message,/failed/);
});
