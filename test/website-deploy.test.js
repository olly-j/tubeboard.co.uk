import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const bootstrap = `import importlib.util\ns=importlib.util.spec_from_file_location('deploy','scripts/deploy-website-only.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n`;
function verify(code) { execFileSync('python3', ['-c', bootstrap + code], { encoding: 'utf8' }); }
test('website overlay modifies only the exact old homepage price block', () => {
  verify(`source=('header\\n'+m.OLD_PRICE+'\\nfooter').encode(); out=m.price_page('index.html',source); assert out==('header\\n'+m.NEW_PRICE+'\\nfooter').encode()`);
});
test('support pricing preserves surrounding purchase and restore guidance', () => {
  verify(`source=('before '+m.OLD_SUPPORT+' after').encode(); assert m.price_page('support.html',source)==('before '+m.NEW_SUPPORT+' after').encode()`);
});
test('unknown page, absent/ambiguous old price and oversized HTML fail closed', () => {
  verify(`for name,body in [('server/index.js',b'code'),('index.html',b'no old price'),('index.html',(m.OLD_PRICE*2).encode()),('support.html',b'x'*256001)]:
 try: m.price_page(name,body)
 except ValueError: pass
 else: raise AssertionError(name)`);
});
test('Docker overlay retains immutable existing runtime and copies only two HTML files', () => {
  verify(`image='registry.fly.io/tubeboard-co-uk@sha256:'+'a'*64; text=m.overlay_dockerfile(image,'b'*40); assert text.splitlines()==['FROM '+image,'COPY index.html support.html /app/','LABEL uk.co.tubeboard.website-source="'+'b'*40+'"']; assert 'RUN ' not in text; assert 'ENV ' not in text`);
});
test('Docker overlay rejects mutable, external and malformed identities', () => {
  verify(`for image,source in [('registry.fly.io/tubeboard-co-uk:latest','b'*40),('docker.io/other@sha256:'+'a'*64,'b'*40),('registry.fly.io/tubeboard-co-uk@sha256:'+'a'*64,'main')]:
 try: m.overlay_dockerfile(image,source)
 except ValueError: pass
 else: raise AssertionError(image)`);
});
test('configuration fingerprint ignores only image and detects volume, worker and environment changes', () => {
  verify(`import copy
before={'config':{'image':'old','mounts':[{'path':'/data','volume':'one'}],'env':{'WORKER':'true'},'services':[{'port':8080}]}}
after=copy.deepcopy(before);after['config']['image']='new';assert m.config_digest(before)==m.config_digest(after)
for key,val in [('mounts',[]),('env',{'WORKER':'false'}),('services',[])]:
 changed=copy.deepcopy(after);changed['config'][key]=val;assert m.config_digest(before)!=m.config_digest(changed)`);
});
test('current homepage and support disclose both scheduled Lifetime price and effective date', () => {
  for (const name of ['index.html','support.html']) {
    const html=fs.readFileSync(name,'utf8');
    assert.ok(html.includes('£31.99'));
    assert.ok(html.includes('25 September 2026'));
    assert.ok(html.includes('£24.99 until 24 September 2026'));
    assert.ok(html.includes('£1.99') && html.includes('£9.99'));
  }
});
test('image update sends only changed image with optimistic version and never logs credentials', () => {
 verify(`from unittest.mock import patch
import io,json
before={'id':'abc123','instance_id':'version1','config':{'image':'old','env':{'WORKER':'true'},'mounts':[{'path':'/data'}]}}
requests=[]
def fake(req,**kwargs):
 requests.append(req)
 return io.BytesIO(json.dumps({'id':'abc123','instance_id':'version2'} if req.get_method()=='POST' else {'ok':True}).encode())
with patch.object(m,'checked',return_value='private-test-token') as auth,patch.object(m.urllib.request,'urlopen',side_effect=fake):
 result=m.update_image(before,'registry.fly.io/tubeboard-co-uk@sha256:'+'a'*64)
 assert auth.call_args.args[0]==['flyctl','auth','token']
body=json.loads(requests[0].data);assert body['current_version']=='version1';assert body['config']['env']==before['config']['env'];assert body['config']['mounts']==before['config']['mounts'];assert before['config']['image']=='old';assert body['config']['image'].count('@')==1;assert len(requests)==2;assert 'instance_id=version2' in requests[1].full_url;assert 'private-test-token' not in json.dumps(result)`);
});
test('image update refuses missing concurrency version before requesting credentials or mutation', () => {
 verify(`from unittest.mock import patch
with patch.object(m,'checked',side_effect=AssertionError('credential call')):
 try: m.update_image({'id':'abc123','config':{}},'registry.fly.io/tubeboard-co-uk@sha256:'+'a'*64)
 except ValueError: pass
 else: raise AssertionError('missing version accepted')`);
});
