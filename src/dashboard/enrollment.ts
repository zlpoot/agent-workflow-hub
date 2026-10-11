import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readMachineConfig, enrollmentBindings } from '../client/enrollment.js';
import { CLIENT_PACKAGE, CLIENT_VERSION } from '../client/version.js';
import { fail, safeData } from '../shared/security.js';
import type { IncomingMessage } from 'node:http';

export function createEnrollmentService(machinePath: string) {
  let busy = false;
  const residents = new Map<string,{child:ChildProcess;config_file:string;worktree:string}>();
  const config = () => {
    const c = readMachineConfig(machinePath);
    const packagePath = join(dirname(dirname(dirname(c.client_entry))),'package.json');
    const pkg = JSON.parse(readFileSync(packagePath,'utf8'));
    if (pkg.name !== CLIENT_PACKAGE || pkg.version !== CLIENT_VERSION || pkg.bin?.awh !== 'dist/client/cli.js') fail(409,'installation','Installed Client metadata differs');
    return c;
  };
  config();
  const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|SSH_|NODE_|NPM_CONFIG_)/i.test(k)));
  async function run(args: string[], cwd?: string): Promise<Record<string,any>> {
    const c = config();
    return new Promise((resolve,reject) => {
      const child = spawn(process.execPath,[c.client_entry,...args],{cwd,env:env(),windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output = '', errors = '', bytes = 0;
      const timer = setTimeout(() => {child.kill(); reject(new Error());},30000);
      child.stdout!.on('data',chunk => { bytes += chunk.length; if (bytes > 65536) {child.kill();reject(new Error());} else output += chunk.toString('utf8'); });
      child.stderr!.on('data',chunk => {if (errors.length < 8192) errors += chunk.toString('utf8');});
      child.once('error',() => {clearTimeout(timer);reject(new Error());});
      child.once('close',code => {clearTimeout(timer);try {
        if (code !== 0 && !(code === 2 && args[0] === 'doctor' && !args.includes('--repair'))) {
          let reason = 'enrollment_blocked';try { const e = JSON.parse(errors);if (typeof e.error?.code === 'string' && /^[a-z_]{1,64}$/.test(e.error.code)) reason = e.error.code; }catch{}
          fail(409,reason,'本机接入未完成，请核对批准状态或诊断结果。');
        }
        const value = JSON.parse(output);safeData(value);resolve(value);
      }catch(e){reject(e);}});
    });
  }
  async function handle(action: string, data: Record<string,unknown>) {
    if (busy) fail(409,'enrollment_busy','Wait for the current local enrollment operation');
    busy = true;
    try {
      if (!['browse','inspect','request','connect','doctor','repair','plan','policies','bindings'].includes(action) || Object.keys(data).some(k => !['directory','mode','work_item'].includes(k))) fail(400,'enrollment_input','Invalid local enrollment action');
      if (action === 'bindings') {if (Object.keys(data).length) fail(400,'enrollment_input','Bindings accept no override');return {items:enrollmentBindings(machinePath).map(({config_file:_config,client_id:_client,...binding}) => binding)};}
      if (data.directory !== undefined && (typeof data.directory !== 'string' || data.directory.length > 1024)) fail(400,'directory','Invalid directory selection');
      const directory = data.directory as string | undefined;
      if (action !== 'browse' && !directory) fail(400,'directory','Choose a local Git directory');
      if (action !== 'request' && (data.mode !== undefined || data.work_item !== undefined)) fail(400,'enrollment_input','Capability selection belongs to the request step');
      const common = ['--machine-config',machinePath,...(directory ? ['--directory',directory] : [])];
      if (action === 'browse') return run(['init',...common,'--browse']);
      if (action === 'inspect') return run(['init',...common]);
      if (action === 'policies') return run(['init',...common,'--policies']);
      if (action === 'plan') return run(['doctor',...common,'--repair']);
      if (action === 'doctor') return run(['doctor',...common,'--json']);
      if (action === 'request') {
        if (!['observe','develop'].includes(String(data.mode))) fail(400,'mode','Choose observe or develop');
        const w = data.work_item as {id:string;version:string} | undefined;
        if (w && (Object.keys(w).sort().join(',') !== 'id,version' || ![w.id,w.version].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)))) fail(400,'work_item','Invalid approved Work Item selection');
        return run(['init',...common,'--confirm','--mode',String(data.mode),...(w ? ['--work-item',w.id,'--work-item-version',w.version] : [])]);
      }
      const result = await run(action === 'repair' ? ['doctor',...common,'--repair','--confirm'] : ['init',...common,'--complete','--confirm']);
      const binding = enrollmentBindings(machinePath).find(b => b.worktree === directory);
      if (!binding) fail(409,'enrollment_binding','Registered local binding was not found');
      if (!residents.has(binding.worktree_id)) {
        const c = config(), child = spawn(process.execPath,[c.client_entry,'--config',binding.config_file,'resident','start'],{cwd:directory,env:env(),windowsHide:true,stdio:['ignore','pipe','ignore']});
        residents.set(binding.worktree_id,{child,config_file:binding.config_file,worktree:directory!});
        child.once('error',() => residents.delete(binding.worktree_id)); child.once('close',() => residents.delete(binding.worktree_id));
        await new Promise<void>((resolve,reject) => {
          const timeout = setTimeout(() => reject(new Error()),5000);
          child.stdout!.once('data',chunk => {clearTimeout(timeout);try {if (JSON.parse(chunk.toString()).resident !== 'started') throw new Error();resolve();}catch{reject(new Error());}});
          child.once('error',() => {clearTimeout(timeout);reject(new Error());});child.once('close',() => {clearTimeout(timeout);reject(new Error());});
        });
      }
      return {...result,resident:'starting',worktree:directory};
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e) throw e;
      return fail(409,'enrollment_blocked','本机接入未完成。请核对 CP 批准、Client 安装和配置；原身份与历史保留。');
    } finally { busy = false; }
  }
  return {handle,bindings:() => enrollmentBindings(machinePath),close:async () => {
    const children = [...residents.values()];
    await Promise.allSettled(children.map(async ({child,config_file,worktree}) => {
      if (child.exitCode !== null) return;
      const closed = new Promise<void>(resolve => child.once('close',() => resolve()));
      await run(['--config',config_file,'resident','stop'],worktree);
      await closed;
    }));
    residents.clear();
  }};
}

export async function enrollmentBody(request: IncomingMessage): Promise<Record<string,unknown>> {
  if (request.headersDistinct['content-type']?.length !== 1 || request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) fail(415,'content_type','JSON required');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) fail(413,'body_too_large','Enrollment input is bounded');chunks.push(chunk); }
  const value = JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));safeData(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'enrollment_input','Closed input required');
  return value;
}
