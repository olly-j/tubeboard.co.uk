// Prepared TB-085 adapter only: no server construction or default activation.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { validBoard } from './station-board-v2.js';
import { validatePublicationResource, MAX_RESOURCE_BYTES } from './timetable-publication-resource.js';
import { readBoundedFile, validateSourceManifest, MAX_SOURCE_MANIFEST_BYTES, MAX_SOURCE_BODY_BYTES, MAX_SOURCE_ARCHIVE_BYTES } from './timetable-source-body-resource.js';
import { MAX_SOURCE_ZIP_BYTES } from './timetable-source-archive-transfer.js';

const BUNDLE = fileURLToPath(new URL('../runtime/timetable-producer/', import.meta.url));
const SHA = /^[a-f0-9]{64}$/;
const FILES = ['tb085_prepare_renewal','tb085_package_timetable_proof','tb085_timetable_publication',
  'tb085_monitor_publication','tb085_source_transfer','tb085_additive_qualification','tb085_reference_readback',
  'tb085_live_parity','tb085_tram_stations','check_tfl_api_health'].map(n=>`scripts/${n}.py`).concat([
  'scripts/tb085_renewal_roster.json','TubeBoard Watch App/TubeStationCatalog.json','My Train Times/PublishedLineMaps.json']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = reason => Object.assign(new Error(`Timetable producer ${reason}`), { producerReason: reason });
// Constant reviewed launcher; inputs choose data/scopes, never code, URLs or executable paths.
const LAUNCHER = String.raw`
import sys,json,time,os,resource,signal
job=json.loads(sys.argv[2])
signal.signal(signal.SIGALRM,lambda *_:os.killpg(os.getpgrp(),signal.SIGKILL))
signal.alarm(max(1,min(300,job['remainingSeconds'])))
from pathlib import Path
sys.path.insert(0,sys.argv[1]+"/scripts")
import tb085_prepare_renewal as p
work=Path(job['work']);publication=job['publication']
limit=(160 if job['mode']=='acquire' else 256)*1024*1024
resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit))
if job['mode']=='acquire':
    metadata=p.acquire_and_record(work,publication,time.monotonic()+300,work/'receipt.json')
    p.write_json(work/'metadata.json',metadata)
    os.replace(work/metadata['body'],work/'source.zip')
elif job['mode']=='prepare':
    same=job['previous']['publication']==publication
    p.prepare(publication,work/'candidate',same_edition=same,additive_only=same,
        expected_resource_sha=job['previous']['resourceSHA256'],expected_proof_sha=job['previous']['proofBodySHA256'],
        expected_revision=job['previous']['revision'],prior_served=None if same else job['previous'],
        requested_scopes=job['scopes'],source_archive=Path(job['cache'])/'source.zip',
        source_archive_receipt=Path(job['cache'])/'receipt.json',source_archive_metadata=Path(job['cache'])/'metadata.json')
else:raise ValueError('Unknown fixed producer operation')
`;

async function directory(root) {
  if (!path.isAbsolute(root) || root.split(path.sep).includes('..')) throw failure('directory-invalid');
  let current=path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    try { await fs.mkdir(current,{mode:0o700}); } catch(error) { if(error.code!=='EEXIST')throw error; }
    const info=await fs.lstat(current);if(info.isSymbolicLink() || !info.isDirectory())throw failure('directory-invalid');
  }
  return fs.realpath(root);
}
async function bounded(root,relative,limit) {
  const rootInfo=await fs.lstat(root);if(rootInfo.isSymbolicLink() || !rootInfo.isDirectory())throw failure('output-path');
  if (path.isAbsolute(relative) || relative.split('/').some(p=>!p || p==='.' || p==='..'))throw failure('output-path');
  let current=root;
  for(const part of relative.split('/').slice(0,-1)) {
    current=path.join(current,part);const info=await fs.lstat(current);
    if(info.isSymbolicLink() || !info.isDirectory())throw failure('output-path');
  }
  return readBoundedFile(root,relative,limit);
}
async function verifyBundle() {
  const manifest=JSON.parse(await bounded(BUNDLE,'manifest.json',64*1024));
  if(manifest.schemaVersion!==1 || manifest.repository!=='olly-j/My-Train-Times' || !/^[a-f0-9]{40}$/.test(manifest.revision)
      || JSON.stringify(Object.keys(manifest.files??{}).sort())!==JSON.stringify([...FILES].sort()))throw failure('bundle-invalid');
  for(const relative of FILES){const expected=manifest.files[relative],bytes=await bounded(BUNDLE,relative,2*1024*1024);
    if(bytes.length!==expected.bytes || hash(bytes)!==expected.sha256)throw failure('bundle-invalid');}
  return manifest.revision;
}
async function workspaceWithinLimit(root,limit) {
  let bytes=0,entries=0;const pending=[root];
  while(pending.length){for(const item of await fs.readdir(pending.pop(),{withFileTypes:true})){
    if(++entries>16384)throw failure('workspace-limit');
    const name=path.join(item.parentPath??item.path,item.name),info=await fs.lstat(name);
    if(info.isSymbolicLink())throw failure('workspace-path');
    if(info.isDirectory())pending.push(name);else if(info.isFile())bytes+=info.size;else throw failure('workspace-path');
    if(bytes>limit)throw failure('workspace-limit');
  }}
}
async function removeStages(root,prefix){
  for(const name of await fs.readdir(root)){if(!name.startsWith(prefix))continue;
    const target=path.join(root,name),info=await fs.lstat(target);
    if(info.isSymbolicLink() || !info.isDirectory())throw failure('workspace-path');
    await fs.rm(target,{recursive:true,force:true});
  }
}
// Kernel custody survives holder death: producers inherit these locked descriptors.
// Parent EOF stops the producer group before normal holder exit. Independent
// producer alarm also bounds orphan custody if both parent and holder are killed.
const HOLDER = String.raw`
import sys,os,json,fcntl,stat,subprocess,select,signal,time
config=json.loads(sys.argv[1]);fds=[];worker=None

def emit(value):print(json.dumps(value,separators=(',',':')),flush=True)
def stop():
 global worker
 if worker is not None:
  try:os.killpg(worker.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:worker.wait(timeout=1)
  except subprocess.TimeoutExpired:pass
  # The leader can exit on TERM while a descendant ignores it. Always stop the
  # remaining owned group before releasing custody, even after leader completion.
  try:os.killpg(worker.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  worker.wait();worker=None
def terminate(*_):stop();sys.exit(0)
signal.signal(signal.SIGTERM,terminate)
try:
 for root in config['roots']:
  fd=os.open(root+'/.producer-lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
  if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('lock type')
  fds.append(fd)
  try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:emit({'status':'busy'});sys.exit(2)
 emit({'status':'ready'})
 while True:
  line=sys.stdin.buffer.readline(16385)
  if not line:break
  if len(line)>16384 or not line.endswith(b'\n'):raise ValueError('job bound')
  job=json.loads(line)
  if job.get('mode') not in ('acquire','prepare'):raise ValueError('job mode')
  worker=subprocess.Popen(['/usr/bin/python3','-I','-B','-c',config['launcher'],config['bundle'],json.dumps(job)],
    stdin=subprocess.DEVNULL,stdout=sys.stderr,stderr=sys.stderr,start_new_session=True,pass_fds=tuple(fds))
  emit({'status':'started','pid':worker.pid})
  while worker.poll() is None:
   if select.select([sys.stdin],[],[],0.05)[0]:
    # The parent sends no next job until completion: any input here is EOF or invalid.
    stop();sys.exit(0)
  code=worker.wait();stop();emit({'status':'done','code':code})
finally:
 stop()
 for fd in fds:os.close(fd)
`;

export class TimetableRecoveryProducer {
  constructor({cacheDirectory,workDirectory,admissionStore,readCurrentResource,
    timeoutMs=300000,outputLimit=65536,spawnChild=spawn}={}) {
    if(typeof cacheDirectory!=='string' || typeof workDirectory!=='string' || !admissionStore
        || typeof admissionStore.admitTrustedPackage!=='function' || typeof readCurrentResource!=='function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>300000
        || !Number.isSafeInteger(outputLimit) || outputLimit<1 || outputLimit>65536)throw failure('configuration');
    Object.assign(this,{cacheDirectory,workDirectory,admissionStore,readCurrentResource,timeoutMs,outputLimit,spawnChild});
    this.active=false;
  }
  async #openHolder(roots,signal,deadline,onLost) {
    const events=new EventEmitter();let pending='',closed=false;
    const child=this.spawnChild('/usr/bin/python3',['-I','-B','-c',HOLDER,JSON.stringify({roots,launcher:LAUNCHER,bundle:BUNDLE})],{
      cwd:BUNDLE,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:roots[1],TMP:roots[1],TEMP:roots[1]}});
    const holder={child,events,closed:false,workerActive:false};this.holder=holder;
    holder.close=new Promise(resolve=>child.once('close',(code,exitSignal)=>{closed=true;holder.closed=true;
      holder.safeCleanup=code===0 && exitSignal===null && holder.expectedClose;
      if(holder.ready && !holder.expectedClose)onLost();events.emit('failure',failure('holder-ended'));resolve();}));
    child.on('error',()=>events.emit('failure',failure('start-failed')));
    child.stdin.on('error',()=>events.emit('failure',failure('holder-ended')));
    child.stdout.on('data',chunk=>{
      pending+=chunk.toString('ascii');if(pending.length>4096){child.stdin.end();events.emit('failure',failure('protocol'));return;}
      while(pending.includes('\n')){const index=pending.indexOf('\n'),line=pending.slice(0,index);pending=pending.slice(index+1);
        try{const value=JSON.parse(line);if(!['ready','busy','started','done'].includes(value.status))throw failure('protocol');
          if(value.status==='started'){if(!Number.isSafeInteger(value.pid) || value.pid<1)throw failure('protocol');holder.workerActive=true;}
          if(value.status==='done'){if(!Number.isSafeInteger(value.code))throw failure('protocol');holder.workerActive=false;}
          events.emit('message',value);
        }catch{child.stdin.end();events.emit('failure',failure('protocol'));}
      }
    });
    // Discard bounded child diagnostics unless a job-specific cap observer is installed.
    child.stderr.on('data',()=>{});
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);events.off('message',message);events.off('failure',failed);signal.removeEventListener('abort',abort);};
      const failed=error=>{cleanup();reject(error);};
      const abort=()=>{holder.expectedClose=true;child.stdin.end();failed(signal.reason);};
      const message=value=>{if(value.status==='ready'){holder.ready=true;cleanup();resolve();}else if(value.status==='busy')failed(failure('busy'));};
      const timer=setTimeout(()=>{child.stdin.end();failed(failure('timeout'));},Math.max(1,deadline-performance.now()));
      events.on('message',message);events.on('failure',failed);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      if(closed)failed(failure('holder-ended'));
    });
  }
  async #child(job,signal,deadline) {
    signal.throwIfAborted();const remaining=deadline-performance.now();if(remaining<=0)throw failure('timeout');
    const holder=this.holder;if(holder.closed)throw failure('holder-ended');
    await new Promise((resolve,reject)=>{
      let reason=null,total=0,checking=false,settled=false;
      const stop=why=>{if(settled)return;reason??=why;holder.expectedClose=true;holder.child.stdin.end();};
      const abort=()=>stop('cancelled');
      const timer=setTimeout(()=>stop('timeout'),remaining);
      const monitor=setInterval(async()=>{if(checking)return;checking=true;
        try{await workspaceWithinLimit(job.work,(job.mode==='acquire'?164:384)*1024*1024);}
        catch{stop('workspace-limit');}finally{checking=false;}},250);
      const cleanup=()=>{settled=true;clearTimeout(timer);clearInterval(monitor);signal.removeEventListener('abort',abort);
        holder.child.stderr.off('data',data);holder.events.off('message',message);holder.events.off('failure',failed);};
      const failed=error=>{cleanup();reject(reason==='cancelled'?signal.reason:reason?failure(reason):error);};
      const message=value=>{if(value.status==='done'){cleanup();if(reason || value.code!==0)reject(failure(reason??'failed'));else resolve();}};
      const data=chunk=>{total+=chunk.length;if(total>this.outputLimit)stop('output-limit');};
      holder.events.on('message',message);holder.events.on('failure',failed);holder.child.stderr.on('data',data);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      holder.child.stdin.write(JSON.stringify({...job,remainingSeconds:Math.max(1,Math.min(300,Math.ceil(remaining/1000)))})+'\n');
    });
  }
  async #verifyCache(root,publication,signal) {
    const receipt=JSON.parse(await bounded(root,'receipt.json',65536));
    const metadata=JSON.parse(await bounded(root,'metadata.json',65536));
    const info=await fs.lstat(path.join(root,'source.zip'));
    if(info.isSymbolicLink() || !info.isFile() || info.size<1 || info.size>MAX_SOURCE_ZIP_BYTES
        || receipt.status!=='verified-source-only' || receipt.publication!==publication || receipt.sha256!==publication
        || receipt.bytes!==info.size || metadata.sha256!==publication || metadata.bytes!==info.size
        || metadata.receivedAt===undefined || metadata.startedAt===undefined)throw failure('cache-invalid');
    const handle=await fs.open(path.join(root,'source.zip'),constants.O_RDONLY|constants.O_NOFOLLOW);
    const digest=createHash('sha256');let count=0;
    const unchanged=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]);
    try {
      const before=await handle.stat();if(!before.isFile() || !unchanged(info,before))throw failure('cache-invalid');
      // Reuse one bounded buffer: streaming allocation must not accumulate ZIP-
      // sized transient buffers while the producer runs beside this Node process.
      const buffer=Buffer.allocUnsafe(64*1024);
      for(;;){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
        if(!bytesRead)break;count+=bytesRead;
        if(count>info.size || count>MAX_SOURCE_ZIP_BYTES)throw failure('cache-invalid');
        digest.update(buffer.subarray(0,bytesRead));
      }
      if(!unchanged(before,await handle.stat()))throw failure('cache-invalid');
    }finally{await handle.close();}
    if(count!==info.size || digest.digest('hex')!==publication)throw failure('cache-invalid');
    // Full original clock/source/receipt validation and fresh official HEADs are
    // performed again by bundled acquire_cached_archive before qualification.
  }
  async #cache(publication,root,signal,deadline) {
    const target=path.join(root,publication);
    try {const info=await fs.lstat(target);if(info.isSymbolicLink() || !info.isDirectory())throw failure('cache-path');
      try{await this.#verifyCache(target,publication,signal);return target;}catch{signal?.throwIfAborted();await fs.rm(target,{recursive:true,force:true});}
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const stage=await fs.mkdtemp(path.join(root,'.acquire-'));
    try {await this.#child({mode:'acquire',publication,work:stage},signal,deadline);
      await workspaceWithinLimit(stage,164*1024*1024);
      await this.#verifyCache(stage,publication,signal);signal?.throwIfAborted();await fs.rename(stage,target);
    }finally{if(this.holder && (this.holder.safeCleanup || (!this.holder.closed && !this.holder.workerActive)))await fs.rm(stage,{recursive:true,force:true});}
    return target;
  }
  async recover({publicationSHA256:publication,scopes,signal}={}) {
    if(this.active)throw failure('busy');
    if(!SHA.test(publication) || !Array.isArray(scopes) || scopes.length>32 || new Set(scopes).size!==scopes.length
        || scopes.some(s=>typeof s!=='string' || !/^[a-z0-9-]{1,64}\/[A-Z0-9]{1,32}$/.test(s) || !validBoard(s.split('/')[1],s.split('/')[0])))throw failure('scope-invalid');
    this.active=true;let work;let safeCleanup=false;
    const timeout=new AbortController(),deadlineTimer=setTimeout(()=>timeout.abort(failure('timeout')),this.timeoutMs);
    signal=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
    try {
      const deadline=performance.now()+this.timeoutMs;signal?.throwIfAborted();await verifyBundle();
      const root=await directory(this.cacheDirectory),workRoot=await directory(this.workDirectory);
      if(root===workRoot || root.startsWith(workRoot+path.sep) || workRoot.startsWith(root+path.sep)
          || root===path.parse(root).root || workRoot===path.parse(workRoot).root)throw failure('directory-invalid');
      await this.#openHolder([root,workRoot],signal,deadline,()=>timeout.abort(failure('holder-ended')));safeCleanup=true;
      await removeStages(root,'.acquire-');await removeStages(workRoot,'producer-');
      const identity=this.admissionStore.latestAdmittedIdentity;
      const previous=identity?{...identity}:null;
      if(!previous || ![previous.publicationSHA256,previous.resourceSHA256,previous.proofBodySHA256].every(s=>SHA.test(s))
          || !Number.isSafeInteger(previous.proofRevision) || previous.proofRevision<1)throw failure('predecessor-missing');
      const previousBytes=await this.readCurrentResource({...previous},{signal});
      if(!Buffer.isBuffer(previousBytes) || hash(previousBytes)!==previous.resourceSHA256)throw failure('predecessor-mismatch');
      const metadata=validatePublicationResource(previousBytes,previous.publicationSHA256);
      if(metadata.revision!==previous.proofRevision || metadata.proofBodySHA256!==previous.proofBodySHA256)throw failure('predecessor-mismatch');
      const wrapper=JSON.parse(previousBytes),prior=JSON.parse(Buffer.from(wrapper.proofBodyBase64,'base64'));
      const requested=scopes.length?scopes:[...prior.entries].filter(e=>e.status==='qualified' && validBoard(e.stationID,e.lineID)).map(e=>`${e.lineID}/${e.stationID}`).sort().slice(0,1);
      if(!requested.length)throw failure('predecessor-no-qualified-scope');
      const editions=[];
      for(const name of await fs.readdir(root)){if(name==='.producer-lock')continue;
        if(!SHA.test(name))throw failure('cache-path');const info=await fs.lstat(path.join(root,name));
        if(info.isSymbolicLink() || !info.isDirectory())throw failure('cache-path');
        await workspaceWithinLimit(path.join(root,name),164*1024*1024);editions.push({name,mtime:info.mtimeMs});}
      const obsolete=editions.filter(e=>e.name!==publication).sort((a,b)=>b.mtime-a.mtime).slice(1);
      for(const entry of obsolete)await fs.rm(path.join(root,entry.name),{recursive:true,force:true});
      const cache=await this.#cache(publication,root,signal,deadline);
      work=await fs.mkdtemp(path.join(workRoot,'producer-'));
      await this.#child({mode:'prepare',publication,work,cache,scopes:requested,previous:{publication:previous.publicationSHA256,
        resourceSHA256:previous.resourceSHA256,proofBodySHA256:previous.proofBodySHA256,revision:previous.proofRevision}},signal,deadline);
      await workspaceWithinLimit(work,384*1024*1024);
      const candidate=path.join(work,'candidate');const resourceBytes=await bounded(candidate,`${publication}.json`,MAX_RESOURCE_BYTES);
      const candidateMetadata=validatePublicationResource(resourceBytes,publication);
      const manifestBytes=await bounded(candidate,'source-archive/manifest.json',MAX_SOURCE_MANIFEST_BYTES);
      const manifest=validateSourceManifest(manifestBytes,publication,candidateMetadata.proofBodySHA256);
      if(manifest.totalBodyBytes>MAX_SOURCE_ARCHIVE_BYTES)throw failure('output-limit');
      const sources=new Map(manifest.sources.map(s=>[s.bodySHA256,s]));
      const proof=JSON.parse(Buffer.from(JSON.parse(resourceBytes).proofBodyBase64,'base64'));
      const unresolvedScopes=scopes.filter(scope=>!proof.entries.some(e=>`${e.lineID}/${e.stationID}`===scope && e.status==='qualified'));
      signal?.throwIfAborted();
      const admitted=await this.admissionStore.admitTrustedPackage({resourceBytes,manifestBytes,previousResourceSHA256:previous.resourceSHA256,signal,
        readBody:async sha=>{const source=sources.get(sha);if(!source)throw failure('output-path');return bounded(candidate,'source-archive/'+source.bodyPath,MAX_SOURCE_BODY_BYTES);}});
      if(admitted.publicationSHA256!==publication || admitted.proofRevision!==candidateMetadata.revision
          || admitted.proofBodySHA256!==candidateMetadata.proofBodySHA256)throw failure('admission-mismatch');
      return {unresolvedScopes};
    }catch(error){if(signal?.aborted)throw signal.reason??failure('cancelled');
      if(error.producerReason)throw error;throw failure('failed');
    }finally{clearTimeout(deadlineTimer);
      const holder=this.holder;this.holder=null;
      // Unexpected holder death may leave a live producer holding kernel locks.
      // Leave its bounded stage for the next successfully locked attempt to clean.
      const owned=safeCleanup && holder && (holder.safeCleanup || (!holder.closed && !holder.workerActive));
      try{if(owned && work)await fs.rm(work,{recursive:true,force:true});}
      finally{if(holder && !holder.closed){holder.expectedClose=true;holder.child.stdin.end();await holder.close;}this.active=false;}
    }
  }
}
