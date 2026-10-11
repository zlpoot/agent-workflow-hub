import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdminError, deny } from './admin/registry.js';
import { approveProposal, compareProposals, diagnoseRegistry, inspectProposal, inspectRegistry, launcherDescriptor, prepareApproval, prepareGrant, prepareRevoke, proposeGrant } from './admin/operations.js';
import { parse, read, type Task } from './admin/registry.js';

const usage = `AWH local administrator CLI (no Provider operations)
inspect [--proposal <external-json>]
compare --left <external-proposal> --right <external-proposal>
register --policy <external-builder-policy> --task <external-task-json> --version <id> --out <new-external-proposal>
prepare --template <external-policy> --profile <id> --workflow <id> --repo <owner/repo> --issue <number> --branch <ref> --base-sha <sha> --head-sha <sha> --executor <id> --machine <id> --expires-at <ISO> --version <id> --out <new-external-proposal>
approval-prepare --proposal <external-proposal> --receipt <id> --reason <ASCII-text> --out <new-external-receipt>
approve --proposal <external-proposal> --confirm
revoke --version <new-revocation-id> --target <approved-version> --out <new-external-proposal>
preflight --version <approved-version>
launcher --version <approved-version>
diagnose
Approve requires independently provisioned AWH_ADMIN_TRUST_FILE/SHA256 and AWH_ADMIN_APPROVAL_FILE/SHA256. Preparation and --confirm alone grant nothing.`;
export function main(args: string[]): object | string {
  if (args.length === 1 && args[0] === '--help') return usage;
  const command = args[0] ?? '', options = new Map<string,string>();
  const keys: Record<string, string[]> = {
    inspect: ['--proposal'], compare: ['--left','--right'], register: ['--policy','--task','--version','--out'],
    prepare: ['--template','--profile','--workflow','--repo','--issue','--branch','--base-sha','--head-sha','--executor','--machine','--expires-at','--version','--out'],
    'approval-prepare': ['--proposal','--receipt','--reason','--out'], approve: ['--proposal','--confirm'],
    revoke: ['--version','--target','--out'], preflight: ['--version'], launcher: ['--version'], diagnose: []
  };
  if (!Object.hasOwn(keys,command)) deny('arguments');
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!;
    if (!keys[command]!.includes(key) || options.has(key)) deny('arguments');
    if (key === '--confirm') { options.set(key,'true'); continue; }
    const value = args[++index]; if (!value || value.startsWith('--')) deny('arguments'); options.set(key,value);
  }
  if (command !== 'inspect' && keys[command]!.some(key => !options.has(key))) deny('arguments');
  const get = (key: string): string => options.get('--' + key)!;
  if (command === 'inspect') return options.has('--proposal') ? inspectProposal(get('proposal')) : inspectRegistry();
  if (command === 'compare') return compareProposals(get('left'),get('right'));
  if (command === 'diagnose') return diagnoseRegistry();
  if (command === 'preflight' || command === 'launcher') return launcherDescriptor(get('version'));
  if (command === 'approve') return approveProposal(get('proposal'));
  if (command === 'revoke') return prepareRevoke(get('version'),get('target'),get('out'));
  if (command === 'approval-prepare') return prepareApproval(get('proposal'),get('receipt'),get('reason'),get('out'));
  if (command === 'register') return proposeGrant(parse(read(get('policy'))),get('version'),parse(read(get('task'))),get('out'));
  if (!/^[1-9]\d*$/.test(get('issue'))) deny('arguments');
  const task: Task = { repository: get('repo'), issue: Number(get('issue')), branch: get('branch'), base_sha: get('base-sha'), head_sha: get('head-sha'),
    profile: get('profile'), workflow: get('workflow'), executor_id: get('executor'), machine_id: get('machine'), expires_at: get('expires-at') };
  return prepareGrant(get('template'),get('version'),task,get('out'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = main(process.argv.slice(2)); console.log(typeof result === 'string' ? result : JSON.stringify(result));
    if (typeof result === 'object' && 'status' in result && result.status === 'BLOCKED') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', code: error instanceof AdminError ? error.code : 'admin_operation_failed',
      recovery: 'Inspect the proposal and obtain independent administrator approval/pins; preserve existing files and history.', authority_verified: false }));
    process.exitCode = 2;
  }
}
