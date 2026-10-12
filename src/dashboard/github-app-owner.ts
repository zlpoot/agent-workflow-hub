import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExternalFile } from '../shared/external-files.js';
import { fail } from '../shared/security.js';
import { protectedAppPath, type AppInput, type AppInstallation } from '../workflow/github-app.js';

export type AppOwnerRequest = { kind: 'github_app_connection'; input: AppInput; facts: AppInstallation; repository: string };
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Opt-in, external Owner policy. Helper path is fixed to the installed package. */
export function createGithubAppOwnerConfirmation(configPath: string, launch: typeof spawn = spawn) {
  if (process.platform !== 'win32') fail(500, 'app_owner_configuration', 'Windows Owner required');
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'github-app-confirm.ps1');
  protectedAppPath(configPath);
  const raw = readExternalFile(configPath, 4096, true), c = JSON.parse(raw.toString('utf8'));
  if (!c || Object.keys(c).sort().join(',') !== 'confirmation_script_sha256,owner_sid,schema_version' || c.schema_version !== '1.0' ||
      !/^S-1-5-\d+(?:-\d+)+$/.test(c.owner_sid) || !/^[a-f0-9]{64}$/.test(c.confirmation_script_sha256)) fail(500, 'app_owner_configuration', 'Closed Owner policy required');
  const check = () => {
    protectedAppPath(configPath); protectedAppPath(helper); protectedAppPath(dirname(configPath));
    if (digest(readExternalFile(configPath, 4096, true)) !== digest(raw) || digest(readExternalFile(helper, 65536)) !== c.confirmation_script_sha256)
      fail(409, 'app_owner_changed', 'Pinned Owner policy/helper changed');
  };
  check();
  return async (request: AppOwnerRequest, signal: AbortSignal): Promise<boolean> => {
    check();
    const directory = mkdtempSync(join(dirname(configPath), 'awh-app-confirm-')), snapshot = join(directory, 'request.json');
    const bytes = Buffer.from(JSON.stringify(request));
    try {
      writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o600 }); protectedAppPath(snapshot);
      const answer = await new Promise<string>((resolve, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|GH_|GITHUB_|AWH_|SSH_|NODE_|NPM_CONFIG_)/i.test(k)));
        const child = launch(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile','-NonInteractive','-Sta','-File',helper,'-RequestFile',snapshot,'-ExpectedOwnerSid',c.owner_sid],
          { env, windowsHide: false, stdio: ['ignore','pipe','pipe'] });
        let output = '', settled = false;
        const finish = (error?: Error, value?: string) => {
          if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (error) { child.kill(); reject(error); } else resolve(value!);
        };
        const abort = () => finish(new Error('Owner confirmation cancelled'));
        const timer = setTimeout(abort, 190000);
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        child.stdout!.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 256) finish(new Error('Owner output limit')); });
        child.stderr!.on('data', () => {}); // Never forward helper diagnostics.
        child.once('error', () => finish(new Error('Owner helper unavailable')));
        child.once('close', code => finish(code === 0 ? undefined : new Error('Owner helper failed'), output.trim()));
      });
      check();
      if (digest(readFileSync(snapshot)) !== digest(bytes) || signal.aborted) fail(409, 'app_owner_changed', 'Confirmation snapshot changed');
      if (answer === 'CANCELLED') return false;
      if (answer !== 'CONFIRMED') fail(403, 'app_owner_confirmation', 'Native Owner confirmation required');
      return true;
    } finally { try { unlinkSync(snapshot); } finally { rmdirSync(directory); } }
  };
}
