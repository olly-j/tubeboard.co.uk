// Explicit offline image integration only; never imported by the service.
// Usage inside a network-disabled test container:
// node /evidence/smoke-timetable-producer-image.mjs /input /evidence/fixtures /evidence
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { TimetableRecoveryProducer } from '/app/server/timetable-recovery-producer.js';
import { TimetablePublicationAdmissionStore } from '/app/server/timetable-publication-admission-store.js';
import { loadSourceBodyArchiveIndex } from '/app/server/timetable-source-body-resource.js';
const [input,fixtures,evidence]=process.argv.slice(2);
assert.ok([input,fixtures,evidence].every(p=>p && path.isAbsolute(p)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const phase=async name=>{const entry={phase:name,at:new Date().toISOString(),memory:process.memoryUsage()};
 for(const key of ['memory.current','memory.peak','memory.stat'])try{entry[key]=(await fs.readFile('/sys/fs/cgroup/'+key,'utf8')).trim();}catch{}
 await fs.appendFile(path.join(evidence,'phases.ndjson'),JSON.stringify(entry)+'\n');};
await phase('imports-ready');
const bundle='/app/runtime/timetable-producer';
const manifest=JSON.parse(await fs.readFile(bundle+'/manifest.json'));
for(const [name,identity] of Object.entries(manifest.files)){
 const bytes=await fs.readFile(path.join(bundle,name));assert.equal(bytes.length,identity.bytes);assert.equal(digest(bytes),identity.sha256);
}
assert.equal(Object.keys(manifest.files).length,13);
const pythonEnvironment=JSON.parse(execFileSync('/usr/bin/python3',['-I','-B','-c',
 "import sys,ssl,zoneinfo,fcntl,json;print(json.dumps({'python':sys.version,'london':str(zoneinfo.ZoneInfo('Europe/London')),'ca':ssl.get_default_verify_paths().cafile,'fcntl':True}))"],{encoding:'utf8'}));
assert.ok(pythonEnvironment.ca);execFileSync('curl',['--version']);
const metadata=await fs.readFile(path.join(input,'offline-replay-captures/publication-download.json'));
const original=JSON.parse(metadata),publication=original.sha256;
const cache=path.join(evidence,'cache',publication);await fs.mkdir(cache,{recursive:true});
await phase('before-cache-copy');
await fs.copyFile(path.join(input,'official-download.body'),path.join(cache,'source.zip'));
await phase('after-cache-copy');
await fs.writeFile(path.join(cache,'metadata.json'),metadata);
await fs.copyFile(path.join(fixtures,'source-receipt.json'),path.join(cache,'receipt.json'));
const priorBytes=await fs.readFile(path.join(fixtures,'previous-resource.body')),priorWrapper=JSON.parse(priorBytes);
const priorDirectory=path.join(evidence,'prior'),emptyArchives=path.join(evidence,'empty-archives');
await fs.mkdir(priorDirectory,{recursive:true});await fs.mkdir(emptyArchives,{recursive:true});
await fs.writeFile(path.join(priorDirectory,priorWrapper.publicationSHA256+'.json'),priorBytes);
const clock=Date.parse('2026-11-16T20:51:30.845807Z');
const observation={current:()=>({schemaVersion:1,source:'https://tfl.gov.uk/tfl/syndication/feeds/journey-planner-timetables.zip',publicationSHA256:publication,observedAt:new Date(clock).toISOString(),expiresAt:new Date(clock+600000).toISOString()})};
const baseSourceIndex=await loadSourceBodyArchiveIndex({publicationDirectory:priorDirectory,archiveDirectory:emptyArchives});
await phase('before-store-initialize');
const store=await new TimetablePublicationAdmissionStore({directory:path.join(evidence,'admission'),baselineSHA256:priorWrapper.publicationSHA256,publicationDirectory:priorDirectory,archiveDirectory:emptyArchives,observation,baseSourceIndex,now:()=>clock}).initialize();
await phase('after-store-initialize');
// Only the network boundary and civil clock are replayed. Qualification, prior
// coverage, cache validation, packaging and trusted admission remain real.
const replay=String.raw`
import sys,json,hashlib,shutil
from pathlib import Path
from datetime import datetime
from urllib.parse import urlsplit,parse_qs
sys.path.insert(0,'/app/runtime/timetable-producer/scripts')
import tb085_prepare_renewal as p
import tb085_live_parity as live
fixtures=Path('/evidence/fixtures');used=[]
class CapturedDatetime(datetime):
 at=datetime.fromisoformat('2026-11-16T14:02:58.940326+00:00')
 @classmethod
 def now(cls,tz=None):return cls.at.astimezone(tz) if tz else cls.at.replace(tzinfo=None)
p.datetime=p.monitor.datetime=live.datetime=CapturedDatetime
records=[json.loads(f.read_text()) for f in sorted((fixtures/'retained-fetches').glob('*.body.json'))]
def key(url):
 u=urlsplit(url);return u.scheme,u.hostname,u.path,parse_qs(u.query).get('direction')
def fetch(directory,name,url,limit,deadline,*,head=False,allowed=(200,)):
 # Final readback reuses the actual original previous resource; final official
 # HEAD reuses the captured after-HEAD. Each original HTTP clock remains intact.
 selected='previous-resource' if name=='final-resource' else 'cached-official-after' if name=='cached-official-final' else name
 matches=[r for r in records if Path(r['body']).stem==selected and key(r['url'])==key(url)]
 if not matches:raise ValueError('No retained transport capture for '+name)
 record=matches[-1];body=(fixtures/'retained-fetches'/record['retainedBody']).read_bytes()
 assert len(body)<=limit and hashlib.sha256(body).hexdigest()==record['sha256'] and record['status'] in allowed
 target=directory/(name+'.body');target.write_bytes(body)
 CapturedDatetime.at=datetime.fromisoformat(record['receivedAt']);used.append({'name':name,'sha256':record['sha256'],'receivedAt':record['receivedAt']})
 return {**{k:v for k,v in record.items() if k!='retainedBody'},'body':target.name}
p.fetch=fetch
responses=json.loads((fixtures/'live-fourteen-current/summary.json').read_text())['requests']
def request(url,method,limit):
 matches=[r for r in responses if r['method']==method and key(r['url'])==key(url)]
 if not matches:raise ValueError('No retained live comparison capture')
 record=matches[-1];body=(fixtures/'live-fourteen-current'/record['body']).read_bytes()
 assert len(body)<=limit and hashlib.sha256(body).hexdigest()==record['sha256']
 CapturedDatetime.at=datetime.fromisoformat(record['receivedAt']);used.append({'method':method,'sha256':record['sha256'],'receivedAt':record['receivedAt']})
 return {k.title():v for k,v in record['headers'].items()},body
p.monitor.request=request
import atexit
atexit.register(lambda:Path('/evidence/transport-replay.json').write_text(json.dumps({'networkRequests':0,'actualCaptureClocks':used},indent=2)+'\n'))
`;
const replayPath=path.join(evidence,'offline-transport.py');await fs.writeFile(replayPath,replay);
const children=[];const diagnostic=[];let diagnosticBytes=0;
const producer=new TimetableRecoveryProducer({cacheDirectory:path.join(evidence,'cache'),workDirectory:path.join(evidence,'work'),admissionStore:store,
 readCurrentResource:(identity,{signal})=>{signal.throwIfAborted();return store.readPublicPublicationBytes(identity.publicationSHA256);},
 spawnChild:(command,args,options)=>{
  const config=JSON.parse(args.at(-1));
  config.launcher=`exec(open(${JSON.stringify(replayPath)}).read(),globals())\n`+config.launcher;
  const child=spawn(command,[...args.slice(0,-1),JSON.stringify(config)],options);children.push(child.pid);
  child.stdout.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))try{const message=JSON.parse(line);void phase('holder-'+message.status);}catch{}});
  child.stderr.on('data',chunk=>{const remaining=65536-diagnosticBytes;if(remaining>0){const kept=chunk.subarray(0,remaining);diagnostic.push(kept);diagnosticBytes+=kept.length;}});
  return child;
 }});
await phase('before-producer-recover');
const start=performance.now();let outcome;
try{
 const result=await producer.recover({publicationSHA256:publication,scopes:['northern/940GZZLUEGW']});
 assert.deepEqual(result,{unresolvedScopes:[]});assert.equal(store.latestAdmittedIdentity.publicationSHA256,publication);
 assert.deepEqual(await fs.readFile(path.join(cache,'metadata.json')),metadata);
 const wrapper=JSON.parse(await store.readPublicPublicationBytes(publication)),proof=JSON.parse(Buffer.from(wrapper.proofBodyBase64,'base64'));
 assert.equal(proof.publication.capturedAt,original.receivedAt);assert.equal(proof.entries.filter(e=>e.status==='qualified').length,14);
 outcome={status:'passed-offline-image-preparation-and-local-admission',qualified:14,identity:store.latestAdmittedIdentity};
}catch(error){outcome={status:'failed',reason:error.producerReason??error.code??'integration-failed'};}
await phase('after-producer-recover');
await fs.writeFile(path.join(evidence,'offline-child-diagnostic.txt'),Buffer.concat(diagnostic));
const cg=async name=>{try{return (await fs.readFile('/sys/fs/cgroup/'+name,'utf8')).trim();}catch{return null;}};
const result={...outcome,seconds:(performance.now()-start)/1000,bundleRevision:manifest.revision,producerSourceSHA256:manifest.files['scripts/tb085_timetable_publication.py'].sha256,pythonEnvironment,children,publicationSHA256:publication,originalArchiveReceivedAt:original.receivedAt,memoryMax:await cg('memory.max'),memoryPeak:await cg('memory.peak'),memoryEvents:await cg('memory.events'),cpuMax:await cg('cpu.max'),networkRequests:0,productionWrites:0,qualification:'Historical clock/HTTP replay, not current live acceptance; no notification workers or APNs exercised.'};
await fs.writeFile(path.join(evidence,'image-smoke-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exit(result.status==='failed'?1:0);
