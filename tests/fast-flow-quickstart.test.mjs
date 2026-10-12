import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Windows Quick Start blocks unpublished bootstrap, carries files into first Issue, and refuses CP config overwrite',
 {skip:process.platform !== 'win32'},t=>{
  const doc=readFileSync(new URL('../docs/windows-fast-flow.md',import.meta.url),'utf8');
  const gate=doc.match(/```powershell\r?\n(git fetch origin main\r?\nif \(\$LASTEXITCODE[\s\S]*?\$bootstrapBase =[^\n]+)\r?\n```/)?.[1];
  const output=doc.match(/^\s*(Out-File -FilePath C:\\AWH\\cp\\trust\.json[^\r\n]*)/m)?.[1];
  assert(gate,'Documented remote bootstrap gate required');assert(output,'Documented non-overwriting output command required');
  const root=mkdtempSync(join(tmpdir(),'awh-quickstart-')),remote=join(root,'remote.git'),repo=join(root,'repo'),candidate=join(root,'issue1');
  t.after(()=>{assert.equal(dirname(root),tmpdir());assert(root.startsWith(join(tmpdir(),'awh-quickstart-')));rmSync(root,{recursive:true,force:true});});
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(GIT_|GH_|GITHUB_|AWH_|NODE_OPTIONS$)/i.test(k)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_TERMINAL_PROMPT:'0'});
  const git=(cwd,args)=>{const r=spawnSync('git',['-c','core.hooksPath=NUL','-c','commit.gpgsign=false',...args],{cwd,env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const ps=(code,cwd=repo)=>spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';\n"+code],{cwd,env,encoding:'utf8',windowsHide:true});
  git(root,['init','--bare','-b','main',remote]);git(root,['clone',remote,repo]);
  git(repo,['config','user.name','Quick Start fixture']);git(repo,['config','user.email','fixture@example.invalid']);
  writeFileSync(join(repo,'README.md'),'Offline bootstrap smoke only\n');git(repo,['add','.']);git(repo,['commit','-m','Initial main']);git(repo,['push','origin','main']);
  mkdirSync(join(repo,'.awh'));writeFileSync(join(repo,'.awh/project.yaml'),'fixture manifest\n');writeFileSync(join(repo,'.awh/flow.json'),'{"schema_version":"1.0","issues":[1,2,3]}\n');
  git(repo,['add','.awh']);git(repo,['commit','-m','Local bootstrap']);
  let r=ps(gate);assert.notEqual(r.status,0);assert.match(r.stderr,/origin\/main missing \.awh\/project.yaml/);
  git(repo,['switch','-c','codex/awh-bootstrap']);git(repo,['push','origin','codex/awh-bootstrap']);
  r=ps(gate);assert.notEqual(r.status,0,'Pushing only bootstrap branch must still block');
  // Offline stand-in for the Human merge; no real GitHub/CP or administrator provisioning.
  git(repo,['push','origin','HEAD:main']);r=ps(gate);assert.equal(r.status,0,r.stderr);
  const base=git(repo,['rev-parse','origin/main']);git(repo,['worktree','add','-b','codex/task-1',candidate,base]);
  for(const file of ['project.yaml','flow.json'])assert.equal(readFileSync(join(candidate,'.awh',file),'utf8'),readFileSync(join(repo,'.awh',file),'utf8'));
  const config=join(root,'cp-config.json'),quoted="'"+config.replaceAll("'","''")+"'";
  const command=output.replace('C:\\AWH\\cp\\trust.json',quoted);
  r=ps("'{\"profiles\":[]}' | "+command);assert.equal(r.status,0,r.stderr);const before=readFileSync(config);
  r=ps("'replacement' | "+command);assert.notEqual(r.status,0);assert.deepEqual(readFileSync(config),before);
 });
