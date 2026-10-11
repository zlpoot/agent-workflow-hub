import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { externalFilePath, readExternalFile } from '../shared/external-files.js';
import { fail } from '../shared/security.js';
import { enrollmentRequest } from '../shared/enrollment.js';
import { enrollmentPreview } from '../client/enrollment.js';

type OwnerConfig = {schema_version:'1.0';cp_entry:string;cp_entry_sha256:string;trusted_config_file:string;database:string;owner_sid:string;confirmation_script:string;confirmation_script_sha256:string;policy_trust_file?:string};
const digest = (bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');
export function createOwnerApproval(machinePath:string, configPath:string, database:string, launch:typeof spawn = spawn) {
  if(process.platform !== 'win32') fail(500,'owner_configuration','Windows owner confirmation required');
  const c=JSON.parse(readExternalFile(configPath,16384).toString('utf8')) as OwnerConfig;
  const keys=['schema_version','cp_entry','cp_entry_sha256','trusted_config_file','database','owner_sid','confirmation_script','confirmation_script_sha256'];
  if(!c || Object.keys(c).some(k=>!keys.includes(k) && k!=='policy_trust_file') || keys.some(k=>!Object.hasOwn(c,k)) || c.schema_version!=='1.0' || !/^S-1-5-\d+(?:-\d+)+$/.test(c.owner_sid) || ![c.cp_entry_sha256,c.confirmation_script_sha256].every(h=>/^[a-f0-9]{64}$/.test(h))) fail(500,'owner_configuration','Closed owner configuration required');
  if(externalFilePath(c.database)!==externalFilePath(database)) fail(500,'owner_configuration','Owner database differs from Viewer');
  externalFilePath(c.trusted_config_file);if(c.policy_trust_file)externalFilePath(c.policy_trust_file);
  const checkEntries=()=>{
    if(digest(readExternalFile(c.cp_entry,1024*1024))!==c.cp_entry_sha256 || digest(readExternalFile(c.confirmation_script,65536))!==c.confirmation_script_sha256) fail(409,'owner_installation','Pinned owner helper changed');
  };
  checkEntries();
  const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GIT_|GH_|GITHUB_|AWH_|SSH_|NODE_|NPM_CONFIG_)/i.test(k)));
  async function run(entry:string,args:string[],timeout:number,visible=false) {
    return new Promise<string>((resolve,reject)=>{
      const child=launch(entry,args,{env:cleanEnv(),windowsHide:!visible,stdio:['ignore','pipe','pipe']});
      let output='',error='',bytes=0;
      const timer=setTimeout(()=>{child.kill();reject(new Error('Owner operation timed out'));},timeout);
      child.stdout!.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){child.kill();reject(new Error('Owner output limit'));}else output+=chunk.toString('utf8');});
      child.stderr!.on('data',chunk=>{if(error.length<8192)error+=chunk.toString('utf8');});
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Owner helper unavailable'));});
      child.once('close',code=>{clearTimeout(timer);if(code===0)resolve(output.trim());else {let reason='owner_approval_failed';try{const e=JSON.parse(error);if(/^[a-z_]{1,64}$/.test(e.error?.code))reason=e.error.code;}catch{}reject(Object.assign(new Error('Owner approval failed'),{ownerCode:reason}));}});
    });
  }
  return async (directory:string) => {
    checkEntries();
    const preview=enrollmentPreview(machinePath,directory);
    if(!preview.request_file) fail(409,'owner_request_missing','Submit the selected local request first');
    const raw=readExternalFile(preview.request_file,16384), request=enrollmentRequest(JSON.parse(raw.toString('utf8')));
    if(request.repository!==preview.repository || request.machine.id!==preview.machine.id || request.executor_id!==preview.executor_id || request.worktree_id!==preview.worktree_id) fail(409,'owner_binding','Selected request differs from the worktree');
    const temporary=mkdtempSync(join(dirname(c.trusted_config_file),'awh-owner-confirm-')), snapshot=join(temporary,'request.json');
    try {
      writeFileSync(snapshot,raw,{flag:'wx',mode:0o600});
      const args=['approve-project','--request',snapshot,'--config',c.trusted_config_file,'--database',c.database,...(c.policy_trust_file?['--policy-trust',c.policy_trust_file]:[])];
      const plan=JSON.parse(await run(process.execPath,[c.cp_entry,...args],30000));
      if(!['approved','approval_required'].includes(plan.status) || plan.request_id!==request.id || plan.capability!=='register_presence' || plan.authority_verified!==false) fail(409,'owner_preview','Owner preview did not match the request');
      const prompt=await run(join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Sta','-File',c.confirmation_script,'-RequestFile',snapshot,'-ExpectedOwnerSid',c.owner_sid],200000,true);
      if(prompt==='CANCELLED') fail(409,'owner_cancelled','Owner cancelled approval');
      if(prompt!=='CONFIRMED') fail(403,'owner_confirmation','Explicit Windows owner confirmation required');
      checkEntries();
      if(digest(readFileSync(snapshot))!==digest(raw) || digest(readExternalFile(preview.request_file,16384))!==digest(raw)) fail(409,'owner_request_changed','Request changed during confirmation');
      const result=JSON.parse(await run(process.execPath,[c.cp_entry,...args,'--confirm'],30000));
      if(result.status!=='approved' || result.request_id!==request.id || result.capability!=='register_presence' || result.authority_verified!==false) fail(409,'owner_result','Approval result differs');
      return {status:'approved',request_id:request.id,project_id:result.project_id,capability:'register_presence',authority_verified:false};
    } catch(e) {
      if(e && typeof e==='object' && 'status' in e)throw e;
      const reason=e && typeof e==='object' && 'ownerCode' in e ? String(e.ownerCode) : 'owner_approval_failed';
      return fail(409,reason,'Local owner approval did not complete; original identity retained');
    } finally {try{unlinkSync(snapshot);}finally{rmdirSync(temporary);}}
  };
}
