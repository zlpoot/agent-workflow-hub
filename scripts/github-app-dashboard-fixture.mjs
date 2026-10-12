import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fixtureStore } from '../tests/store-fixture.mjs';
import { dashboardAppFixture } from '../tests/helpers/github-app-dashboard-fixture.mjs';
import { createDashboardGateway } from '../dist/dashboard/gateway.js';
import { createGithubAppManagement } from '../dist/dashboard/github-app-management.js';

// Isolated injected Viewer preview. No production DB, credentials, configuration or URL input.
if (process.argv.length !== 2) throw new Error('Fixture accepts no arguments');
const directory = mkdtempSync(join(tmpdir(),'awh-app-viewer-fixture-')), app = dashboardAppFixture(directory);
const fixture = JSON.parse(readFileSync('examples/protocol/project-alpha.json'));
const store = fixtureStore(':memory:',[fixture.profile_policy]);
writeFileSync(join(directory,'index.html'),readFileSync('dist/dashboard-ui/index.html','utf8').replace('<title>','<meta name="awh-dataset" content="fixture"><title>'));
for(const file of ['app.js','app.css'])writeFileSync(join(directory,file),readFileSync(join('dist/dashboard-ui',file)));
let cancelled=false, confirmations=0, enabled=true;
const makeService=()=>createGithubAppManagement({app:app.app,fixture:true,confirm:enabled?async()=>{confirmations++;return !cancelled;}:undefined});
let service=makeService();
const proxy={read:s=>service.read(s),handle:(...args)=>service.handle(...args),close:()=>service.close()};
const gateway=createDashboardGateway({enabled:true,store,assets:directory,localBrowserViewer:{id:'fixture-app-viewer',project_ids:[fixture.project.id]},githubApp:proxy});
await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:`http://127.0.0.1:${gateway.server.address().port}/dashboard`,input:app.input,fixture:true,live_preflight:'NOTRUN'}));
process.on('message',message=>{
  if(message?.kind==='mode'&&['success','cancel','permissions','identity','scope','network','not-installed','all','readonly','restart'].includes(message.value)){
    if(message.value==='restart'||message.value==='readonly'){service.close();enabled=message.value!=='readonly';service=makeService();}
    else {cancelled=message.value==='cancel';app.setMode(cancelled?'success':message.value);}
    process.send?.({kind:'ack',id:message.id,confirmations,calls:app.calls.length});
  }
});
let stopped=false;
const stop=async()=>{if(stopped)return;stopped=true;await gateway.close();store.close();const target=realpathSync(directory);if(dirname(target)!==realpathSync(tmpdir())||!basename(target).startsWith('awh-app-viewer-fixture-'))throw new Error('Refuse fixture cleanup');rmSync(target,{recursive:true,force:true});process.exit(0);};
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());process.once('disconnect',()=>void stop());
setTimeout(()=>void stop(),900000).unref();
