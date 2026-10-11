import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { externalPath, externalFilePath, readExternalFile, absoluteDeploymentPath } from '../shared/external-files.js';
import { enrollmentRequest, enrollmentGrants, type EnrollmentRequest } from '../shared/enrollment.js';
import { AwhClient } from './client.js';
import { atomicJson, clientFail, inspectRepository, initManifest, machine, readConfig, readCredential, readCaCertificate, readManifest, same, locked, type ClientConfig } from './local.js';
import { requestJson } from './http.js';
import { loadApprovedWorkItem, listApprovedWorkItems } from './versioned-profile.js';

export interface MachineConfig {
  schema_version: '1.0'; endpoint: string; home: string; project_roots: string[];
  client_entry: string; client_entry_sha256: string; executor_type: string;
  ca_certificate_file?: string; policy_trust_file?: string;
}
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export function readMachineConfig(path: string): MachineConfig {
  const c = JSON.parse(readExternalFile(path, 16384).toString('utf8')) as MachineConfig;
  if (!c || Object.keys(c).some(k => !['schema_version','endpoint','home','project_roots','client_entry','client_entry_sha256','executor_type','ca_certificate_file','policy_trust_file'].includes(k)) ||
      c.schema_version !== '1.0' || !Array.isArray(c.project_roots) || !c.project_roots.length || c.project_roots.length > 16 ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(c.executor_type) || !/^[a-f0-9]{64}$/.test(c.client_entry_sha256)) clientFail('machine_configuration','Invalid machine setup');
  const endpoint = new URL(c.endpoint);
  if (!['https:','http:'].includes(endpoint.protocol) || endpoint.protocol === 'http:' && endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.hash || endpoint.search)
    clientFail('endpoint','Configured CP requires verified HTTPS or numeric loopback');
  c.home = externalPath(c.home); c.client_entry = externalFilePath(c.client_entry, 1024 * 1024);
  if (hash(readFileSync(c.client_entry)) !== c.client_entry_sha256) clientFail('installation','Installed Client differs from machine setup');
  c.project_roots = c.project_roots.map(p => {
    absoluteDeploymentPath(p); if (realpathSync(p) !== p || !lstatSync(p).isDirectory()) clientFail('directory','Project root cannot be redirected'); return p;
  });
  if (c.ca_certificate_file) { externalFilePath(c.ca_certificate_file); readCaCertificate({ ca_certificate_file: c.ca_certificate_file } as ClientConfig); }
  if (c.policy_trust_file) externalFilePath(c.policy_trust_file);
  if (c.ca_certificate_file && endpoint.protocol !== 'https:') clientFail('certificate','CA requires HTTPS');
  return c;
}
export function setupMachine(options: { path: string; endpoint: string; home: string; projectRoot: string; clientEntry: string; ca?: string; policyTrust?: string; existingMachineState?: string }) {
  const home = externalPath(options.home), entry = externalFilePath(options.clientEntry, 1024 * 1024);
  const config: MachineConfig = { schema_version: '1.0', endpoint: options.endpoint, home, project_roots: [realpathSync(options.projectRoot)],
    client_entry: entry, client_entry_sha256: hash(readFileSync(entry)), executor_type: 'codex', ...(options.ca ? { ca_certificate_file: options.ca } : {}), ...(options.policyTrust ? {policy_trust_file:options.policyTrust} : {}) };
  const path = absoluteDeploymentPath(options.path); externalPath(dirname(path));
  const temporary = path + '.setup.tmp';
  let created = false;
  try {
    writeFileSync(temporary,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});created = true;readMachineConfig(temporary);
    mkdirSync(join(home,'state'),{recursive:true,mode:0o700});externalPath(join(home,'state'));
    if (options.existingMachineState) {
      const source = externalPath(options.existingMachineState), original = machine({state_directory:source,executor_type:config.executor_type} as ClientConfig,false);
      const target = join(home,'state','machine.json');
      if (existsSync(target)) {if (!same(machine({state_directory:join(home,'state'),executor_type:config.executor_type} as ClientConfig,false),original)) clientFail('machine','Existing Machine identity cannot be replaced');}
      else writeFileSync(target,JSON.stringify(original),{flag:'wx',mode:0o600});
    }
    machine({state_directory:join(home,'state'),executor_type:config.executor_type} as ClientConfig);
    writeFileSync(path,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
  } finally {if (created) try {unlinkSync(temporary);}catch(e){if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}}
  return { status: 'machine_initialized', machine_config: path, authority_verified: false };
}
function selected(c: MachineConfig, directory: string) {
  if (!isAbsolute(directory)) clientFail('directory','Select an absolute local directory');
  absoluteDeploymentPath(directory);
  const root = realpathSync(directory);
  if (root !== directory || !c.project_roots.some(parent => root === parent || relative(parent,root) && !relative(parent,root).startsWith('..') && !isAbsolute(relative(parent,root))))
    clientFail('directory','Directory is outside configured local project roots');
  return root;
}
function paths(c: MachineConfig, root: string) {
  const worktree = 'worktree-' + hash(root).slice(0,32), base = join(c.home,'bindings',worktree);
  return { worktree, base, receipt: join(base,'request.json'), config: join(base,'client.json'), credential: join(base,'credential'), approved: join(base,'approved.json') };
}
export function browseDirectories(machinePath: string, directory?: string) {
  const c = readMachineConfig(machinePath);
  if (!directory) return { roots: c.project_roots, directories: [], current: null };
  const root = selected(c,directory);
  const dirs = readdirSync(root,{withFileTypes:true}).filter(d => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.')).slice(0,128);
  return { roots: c.project_roots, current: root, directories: dirs.map(d => join(root,d.name)) };
}
export function enrollmentPolicies(machinePath: string, directory: string) {
  const c = readMachineConfig(machinePath), preview = enrollmentPreview(machinePath,directory);
  return {items:c.policy_trust_file ? listApprovedWorkItems(c.policy_trust_file).filter(w => w.repository === preview.repository && w.branch === preview.branch && w.stages.includes('develop'))
    .map(w => ({id:w.id,version:w.work_item_version,issue:w.issue,branch:w.branch,profile_ref:w.profile_ref})) : []};
}
export function enrollmentPreview(machinePath: string, directory: string) {
  const c = readMachineConfig(machinePath), root = selected(c,directory), identity = inspectRepository(root);
  if (identity.root !== root) clientFail('directory','Choose the Git worktree root');
  const p = paths(c,root), m = machine({ state_directory: join(c.home,'state'), executor_type: c.executor_type } as ClientConfig,false);
  let manifest = null;
  if (existsSync(join(root,'.awh','project.yaml'))) manifest = readManifest(identity);
  const projectId = manifest?.project.id ?? 'project-' + hash(identity.repository.toLowerCase()).slice(0,32);
  const request = existsSync(p.receipt) ? enrollmentRequest(JSON.parse(readExternalFile(p.receipt,16384).toString('utf8'))) : null;
  const approved = existsSync(p.approved) ? enrollmentGrants([JSON.parse(readExternalFile(p.approved,16384).toString('utf8'))])[0]! : null;
  return { kind: 'enrollment_preview', repository: identity.repository, branch: identity.ref, head: identity.sha, dirty: identity.dirty,
    worktree: root, worktree_id: p.worktree, machine: { id: m.id, platform: m.platform }, project_id: approved?.manifest.project.id ?? projectId,
    executor_id: request?.executor_id ?? 'executor-' + hash(m.id + p.worktree).slice(0,32), manifest: manifest ? 'existing' : 'missing',
    installation: 'verified', status: approved ? 'configured' : request ? 'approval_required' : 'confirmation_required', request_id: request?.id ?? null,
    request_file: request ? p.receipt : null, mode: request?.mode ?? 'observe', writes: ['external project configuration', 'minimal Manifest if missing', 'approved registration and heartbeat'],
    business_writes: false, authority_verified: false };
}
export function submitEnrollment(machinePath: string, directory: string, mode: 'observe' | 'develop', workItem?: { id: string; version: string }) {
  const c = readMachineConfig(machinePath), preview = enrollmentPreview(machinePath,directory), p = paths(c,preview.worktree);
  if (existsSync(p.receipt)) {
    const old = enrollmentRequest(JSON.parse(readExternalFile(p.receipt,16384).toString('utf8')));
    if (old.mode !== mode || !same(old.work_item,workItem ?? null)) clientFail('enrollment_conflict','Existing request cannot be replaced or broadened');
    return preview;
  }
  let profile = 'observe/' + preview.project_id, executor = preview.executor_id;
  if (mode === 'develop') {
    if (!c.policy_trust_file || !workItem) clientFail('development_authorization_required','Select an operator-approved Work Item before requesting development');
    const w = loadApprovedWorkItem(c.policy_trust_file,workItem).work_item;
    if (!w.stages.includes('develop') || w.repository !== preview.repository || w.branch !== preview.branch) clientFail('development_authorization_required','Current branch does not match approved development Work Item');
    profile = w.profile_ref; executor = w.executor;
  }
  mkdirSync(p.base,{recursive:true,mode:0o700}); externalPath(p.base);
  const credential = existsSync(p.credential) ? readCredential({credential_file:p.credential} as ClientConfig) : 'awh_cp_' + randomBytes(32).toString('base64url');
  const request: EnrollmentRequest = { schema_version:'1.0',kind:'enrollment_request',id:'enroll-' + hash(preview.machine.id + p.worktree).slice(0,32),
    repository:preview.repository,project_id:preview.project_id,profile_ref:profile,client_id:'client-' + hash(preview.machine.id + p.worktree).slice(0,32),
    executor_id:executor,machine:preview.machine,worktree_id:p.worktree,token_sha256:hash(credential),mode,branch:preview.branch,sha:preview.head,work_item:workItem ?? null };
  enrollmentRequest(request);
  if (!existsSync(p.credential)) writeFileSync(p.credential,credential,{flag:'wx',mode:0o600});
  writeFileSync(p.receipt,JSON.stringify(request,null,2),{flag:'wx',mode:0o600});
  return enrollmentPreview(machinePath,directory);
}
export async function finishEnrollment(machinePath: string, directory: string) {
  const c = readMachineConfig(machinePath), p = paths(c,selected(c,directory));
  externalPath(p.base);
  return locked(join(p.base,'enrollment.lock'),()=>applyEnrollment(machinePath,directory));
}
async function applyEnrollment(machinePath: string, directory: string) {
  const c = readMachineConfig(machinePath), preview = enrollmentPreview(machinePath,directory), p = paths(c,preview.worktree);
  const request = enrollmentRequest(JSON.parse(readExternalFile(p.receipt,16384).toString('utf8')));
  if (request.repository !== preview.repository || !same(request.machine,preview.machine) || request.worktree_id !== p.worktree) clientFail('enrollment_binding','Request differs from selected worktree or Machine');
  const config: ClientConfig = { schema_version:'1.0',endpoint:c.endpoint,credential_file:p.credential,state_directory:join(c.home,'state'),executor_id:request.executor_id,executor_type:c.executor_type,
    ...(c.ca_certificate_file ? {ca_certificate_file:c.ca_certificate_file} : {}) };
  const credential = readCredential(config);
  if (hash(credential) !== request.token_sha256) clientFail('enrollment_binding','Dedicated credential differs from request');
  const response = await requestJson(c.endpoint,'/v1/enrollment',credential,'GET',undefined,readCaCertificate(config)) as { enrollment: unknown };
  const grant = enrollmentGrants([response.enrollment])[0]!;
  if (!same(grant.request,request)) clientFail('enrollment_binding','CP approval differs from submitted request');
  if (request.mode === 'develop') {
    if (!c.policy_trust_file || !request.work_item) clientFail('development_authorization_required','Approved Work Item is required');
    const w = loadApprovedWorkItem(c.policy_trust_file,request.work_item).work_item;
    if (w.branch !== preview.branch || w.repository !== preview.repository || w.executor !== request.executor_id) clientFail('development_authorization_required','Current development binding differs');
    if (w.profile_ref === grant.manifest.profile.ref) config.profile_version = w.profile_version;
  }
  // Preview conflicts before any repository write. Never replace another Client config/Manifest.
  if (existsSync(p.config) && !same(readConfig(p.config,preview.worktree,true),{...config,endpoint:new URL(config.endpoint).origin})) clientFail('configuration','Existing binding cannot be replaced');
  const identity = inspectRepository(preview.worktree);
  if (existsSync(join(identity.root,'.awh','project.yaml')) && !same(readManifest(identity),grant.manifest)) clientFail('manifest_conflict','Existing Manifest requires owner resolution');
  initManifest(identity,grant.manifest.project.id,grant.manifest.profile.ref);
  if (!existsSync(p.config)) writeFileSync(p.config,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
  await new AwhClient(p.config,identity.root).register();
  atomicJson(join(p.base,'binding.json'),{worktree:identity.root,config_file:p.config});
  atomicJson(p.approved,grant);
  return { ...enrollmentPreview(machinePath,directory), status:'registered',config_file:p.config,capability:'register_presence',next:'resident start',authority_verified:false };
}
export function enrollmentBindings(machinePath: string) {
  const c = readMachineConfig(machinePath), directory = join(c.home,'bindings');
  if (!existsSync(directory)) return [];
  externalPath(directory);
  const names = readdirSync(directory).filter(n => /^worktree-[a-f0-9]{32}$/.test(n));
  if (names.length > 64) clientFail('enrollment_limit','Local binding capacity reached');
  return names.flatMap(n => {
    const path = join(directory,n,'approved.json'); if (!existsSync(path)) return [];
    const grant = enrollmentGrants([JSON.parse(readExternalFile(path,16384).toString('utf8'))])[0]!;
    const binding = JSON.parse(readExternalFile(join(directory,n,'binding.json'),16384).toString('utf8'));
    if (Object.keys(binding).sort().join(',') !== 'config_file,worktree' || paths(c,selected(c,binding.worktree)).worktree !== n || binding.config_file !== join(directory,n,'client.json')) clientFail('enrollment_binding','Local binding metadata conflicts');
    return [{ project_id:grant.manifest.project.id,executor_id:grant.request.executor_id,client_id:grant.request.client_id,machine_id:grant.request.machine.id,worktree_id:n,worktree:binding.worktree,config_file:binding.config_file }];
  });
}

export async function diagnoseEnrollment(machinePath: string, directory: string, probe = false) {
  const c = readMachineConfig(machinePath), preview = enrollmentPreview(machinePath,directory), p = paths(c,preview.worktree);
  const checks = [
    { id:'repository',status:'passed',code:'canonical_root_origin_verified',source:'local_git',safe_next_step:'已识别 Git 工作树。' },
    { id:'worktree',status:'passed',code:preview.dirty ? 'local_changes_retained' : 'worktree_clean',source:'local_git',safe_next_step:'仅观察允许保留本机改动；开发授权单独核对。' },
    { id:'manifest',status:preview.manifest === 'existing' ? 'passed' : 'blocked',code:preview.manifest === 'existing' ? 'manifest_origin_matches' : 'manifest_missing',source:'manifest_identity',safe_next_step:'使用初始化流程恢复缺失 Manifest；不覆盖冲突身份。' },
    { id:'configuration',status:existsSync(p.config) ? 'passed' : 'blocked',code:existsSync(p.config) ? 'external_binding_exists' : 'project_configuration_missing',source:'external_config',safe_next_step:'预览 Doctor 修复，再明确确认。' },
    { id:'cp_connection',status:'not_checked',code:'cp_probe_not_requested',source:'not_observed',safe_next_step:'可以显式请求只读 CP 核对。' },
    { id:'history',status:'not_checked',code:'retained_history_not_reconciled',source:'local_state',safe_next_step:'旧 Session、Journal 和待发事件保留，接入修复不进行业务重试。' }
  ];
  if (existsSync(p.config)) {
    try {
      const config = readConfig(p.config,preview.worktree,true); machine(config,false);
      const grant = enrollmentGrants([JSON.parse(readExternalFile(p.approved,16384).toString('utf8'))])[0]!;
      if (grant.manifest.project.repository !== preview.repository || grant.request.worktree_id !== p.worktree || !same(readManifest(inspectRepository(preview.worktree)),grant.manifest)) throw new Error();
      if (grant.request.mode === 'develop') {
        if (!c.policy_trust_file || !grant.request.work_item) throw new Error();
        const w = loadApprovedWorkItem(c.policy_trust_file,grant.request.work_item).work_item;
        checks.push({id:'development',status:w.branch === preview.branch && !preview.dirty ? 'passed' : 'blocked',code:w.branch !== preview.branch ? 'development_branch_not_authorized' : preview.dirty ? 'development_worktree_dirty' : 'development_branch_checked',source:'operator_policy',safe_next_step:'开发检查失败不影响仅观察；不得从历史记录推断新授权。'});
      }
      if (probe) {
        const result = await requestJson(config.endpoint,'/v1/enrollment',readCredential(config),'GET',undefined,readCaCertificate(config)) as {enrollment:unknown};
        if (!same(enrollmentGrants([result.enrollment])[0],grant)) throw new Error();
        checks[4] = {id:'cp_connection',status:'passed',code:'approved_enrollment_matches',source:'control_plane_get',safe_next_step:'CP 授权记录与本机绑定一致；未发送心跳。'};
      }
    } catch { checks.push({id:'binding',status:'blocked',code:'binding_requires_repair',source:'external_config',safe_next_step:'预览修复；未知 CA、凭据或身份冲突须由操作人处理。'}); }
  }
  return {schema_version:'1.0',kind:'enrollment_doctor',mode:probe ? 'cp_readonly_probe' : 'offline',status:checks.some(c => c.status === 'blocked') ? 'blocked' : 'not_checked',checks,observed_at:new Date().toISOString(),authority_verified:false};
}
