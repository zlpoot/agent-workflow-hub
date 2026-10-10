import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createSessionProvisioner } from '../dist/dashboard/session-host.js';
import { createDashboardGateway } from '../dist/dashboard/gateway.js';
import { createViewerAuthenticator } from '../dist/dashboard/security.js';

async function setup(t) {
  const secret=randomBytes(32).toString('base64url');let now=Date.now();const sessions=[{id:'fixture-viewer',project_ids:['future-ui'],session_sha256:createHash('sha256').update(secret).digest('hex'),expires_at:new Date(now+60000).toISOString()}];
  const gateway=createDashboardGateway({enabled:true,store:{dashboardRevision:()=>'',dashboardReadView:()=>{throw new Error('Not used');}},assets:'dist/dashboard-ui',authenticate:createViewerAuthenticator(sessions,()=>now),provision:createSessionProvisioner(sessions,()=>now)});
  await new Promise(done=>gateway.server.listen(0,'127.0.0.1',done));t.after(()=>gateway.close());const origin='http://127.0.0.1:'+gateway.server.address().port;
  const exchange=(body=secret,headers={})=>fetch(origin+'/dashboard/session',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain',...headers},body});return {origin,secret,exchange,expire:()=>now+=60000};
}
test('trusted host only transfers a pre-provisioned secret into bounded HttpOnly cookie; UI stays protected',async t=>{const h=await setup(t);assert.equal((await fetch(h.origin+'/dashboard')).status,401);const r=await h.exchange();assert.equal(r.status,204);assert.equal(await r.text(),'');const cookie=r.headers.get('set-cookie');assert(cookie.includes('HttpOnly; SameSite=Strict; Path=/dashboard'));assert.equal((await fetch(h.origin+'/dashboard',{headers:{Cookie:cookie.split(';')[0]}})).status,200);h.expire();const expired=await h.exchange();assert.equal(expired.status,401);assert.equal(expired.headers.get('set-cookie'),null);});
test('session transfer denies missing/wrong credential, query tokens, cross-origin, unsupported body and oversized input',async t=>{const h=await setup(t);for(const [body,headers] of [['A'.repeat(43),{}],[h.secret,{Origin:'https://evil.invalid'}],[h.secret,{'Content-Type':'application/json'}],[h.secret+'\n',{}],['A'.repeat(129),{}],[h.secret,{Cookie:'awh_viewer='+h.secret}]] ){const r=await h.exchange(body,headers);assert.notEqual(r.status,204);assert.equal(r.headers.get('set-cookie'),null);}assert.equal((await fetch(h.origin+'/dashboard/session?token=fixture')).status,401);assert.equal((await fetch(h.origin+'/dashboard/session')).status,405);});
test('session registry validation remains closed, with no anonymous/default issuing host',async t=>{assert.throws(()=>createSessionProvisioner([]));assert.throws(()=>createSessionProvisioner([{id:'a',extra:true}]));const s=createServer(createDashboardGateway().server.listeners('request')[0]);await new Promise(done=>s.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>s.close(done)));assert.equal((await fetch('http://127.0.0.1:'+s.address().port+'/dashboard/session')).status,404);});
