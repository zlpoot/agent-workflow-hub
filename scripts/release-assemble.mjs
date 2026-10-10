import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkCandidate, components, targets, sha256 } from './release-lib.mjs';
import { checkManifest, checkSums } from './release-validate.mjs';

// Freeze a single build. Platform evidence is appended later without rewriting these bytes.
const args=process.argv.slice(2);assert(args.length===4 && args[0]==='--candidate' && args[2]==='--output','release-assemble --candidate <candidate-dir> --output <new-dir>');
const input=resolve(args[1]),candidate=JSON.parse(readFileSync(join(input,'candidate-index.json')));
checkCandidate(candidate,name=>readFileSync(join(input,name)));
const source=candidate.source_commit,root=dirname(dirname(fileURLToPath(import.meta.url)));
const git=args=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0);return r.stdout.trim();};
assert.equal(git(['rev-parse','HEAD']),source,'Assembly code/guides must match candidate source');assert.equal(git(['status','--porcelain']),'','Assembly requires clean source');
const output=resolve(args[3]);assert(!existsSync(output),'Never overwrite frozen candidates');mkdirSync(output,{recursive:true});
const artifacts=candidate.artifacts;
for(const a of artifacts)copyFileSync(join(input,a.filename),join(output,a.filename));
for(const name of ['candidate-index.json','CANDIDATE-SHA256SUMS'])copyFileSync(join(input,name),join(output,name));
const guides={};
for(const [key,name] of [['windows','install-windows.md'],['macos','install-macos.md']]){copyFileSync(join(root,'docs/release',name),join(output,name));guides[key]={filename:name,sha256:sha256(readFileSync(join(output,name)))};}
const verification=targets.map(target=>({layer:'package',target,status:'NOTRUN',evidence:null})),p=artifacts[0].build.provenance;
const manifest={schema_version:'1.0',kind:'awh_release_manifest',release:{id:'awh-'+source+'-rc.1',name:'AWH v0.1.0-rc.1',tag:'v0.1.0-rc.1',channel:'rc',state:'candidate_frozen',source_commit:source,source_clean:true,human_release_gate:'NOT_AUTHORIZED'},components,artifacts,
 compatibility:{protocol:'1.0',cp_database_schema:2,dashboard_api:'1.0.0',dashboard_contract_sha256:p['contracts/dashboard-v1.openapi.json'],handoff:'0.1',fixed_profile_policy_sha256:p['src/profiles.ts']},verification,
 unsupported_targets:[{target:'darwin-x64',status:'NOT_VERIFIED'},{target:'other',status:'NOT_VERIFIED'}],acceptance:{runtime_write:'NOT_ACCEPTED',full_delivery:'NOT_ACCEPTED'},historical_dispositions:{issue30:'PHASE_C_ACCEPTED_WITH_EXCEPTION',issue35:'WINDOWS_FIRST_USABLE_OBSERVE_ONLY',onboarding_api_1_0_0:'OFFLINE_FIXTURE_ONLY'},guides};
checkManifest(manifest,name=>readFileSync(join(output,name)),source);writeFileSync(join(output,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const names=[...artifacts.map(a=>a.filename),...Object.values(guides).map(g=>g.filename),'release-manifest.json'];
const sums=names.map(name=>sha256(readFileSync(join(output,name)))+'  '+name).join('\n')+'\n';checkSums(sums,manifest,name=>readFileSync(join(output,name)));writeFileSync(join(output,'SHA256SUMS'),sums,{flag:'wx'});
assert.equal(git(['rev-parse','HEAD']),source);assert.equal(git(['status','--porcelain']),'');
console.log(JSON.stringify({source_commit:source,assets:5,package_verification:verification,publishable:false,authority_verified:false}));
