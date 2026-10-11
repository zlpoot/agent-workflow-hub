import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdminError, deny, managedContext } from './admin/registry.js';
import { approveProposal, compareProposals, diagnoseRegistry, inspectProposal, inspectRegistry, launcherDescriptor, prepareApproval, prepareGrant, prepareRevoke, proposeProject } from './admin/operations.js';
import { parse, read, type Task, type Stage, type ProviderOperation } from './admin/registry.js';

const usage = `AWH local administrator CLI (no Provider operations)
inspect [--proposal <external-json>]
compare --left <external-proposal> --right <external-proposal>
register --policy <external-project-policy> --version <id> --out <new-external-proposal>
propose --policy-version <approved-project> --profile <id> --workflow <id> --repo <owner/repo> --issue <number> --branch <ref> --base-sha <sha> [--head-sha <existing-sha>] --executor <id> --machine <id> --expires-at <ISO> [--stages observe,develop,deliver] [--operations push,draft_pr,evidence,handoff] --version <id> --out <new-external-proposal>
approval-prepare --proposal <external-proposal> --receipt <id> --reason <ASCII-text> --out <new-external-receipt>
approve --proposal <external-proposal> --confirm
recover --proposal <same-external-proposal> --confirm
revoke --version <new-revocation-id> --target <approved-version> --out <new-external-proposal>
preflight --version <approved-version>
launcher --version <approved-version>
validate --proposal <external-proposal> | --version <approved-work-item> --stage <observe|develop|deliver>
diagnose [--version <approved-work-item>]
Defaults: Develop only, zero Provider operations, no future HEAD. prepare aliases propose.
Revision: add --original-version <first-grant> --run <Run> --pr <same-PR> --previous-head <old-SHA> --review <native-REQUEST_CHANGES-id>, exact --head-sha, and operations push,evidence,handoff. Separate independent approval required.
Approve requires independently provisioned AWH_ADMIN_TRUST_FILE/SHA256 and AWH_ADMIN_APPROVAL_FILE/SHA256. Preparation and --confirm alone grant nothing.`;
export function main(args: string[]): object | string {
  if (args.length === 1 && args[0] === '--help') return usage;
  const command = args[0] === 'prepare' ? 'propose' : args[0] ?? '', options = new Map<string,string>();
  const keys: Record<string, string[]> = {
    inspect: ['--proposal'], compare: ['--left','--right'], register: ['--policy','--version','--out'],
    propose: ['--policy-version','--profile','--workflow','--repo','--issue','--branch','--base-sha','--head-sha','--executor','--machine','--expires-at','--stages','--operations','--version','--out','--original-version','--run','--pr','--previous-head','--review'],
    'approval-prepare': ['--proposal','--receipt','--reason','--out'], approve: ['--proposal','--confirm'], recover: ['--proposal','--confirm'],
    revoke: ['--version','--target','--out'], preflight: ['--version'], launcher: ['--version'], validate: ['--proposal','--version','--stage'], diagnose: ['--version']
  };
  if (!Object.hasOwn(keys,command)) deny('arguments');
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!;
    if (!keys[command]!.includes(key) || options.has(key)) deny('arguments');
    if (key === '--confirm') { options.set(key,'true'); continue; }
    const value = args[++index]; if (!value || value.startsWith('--')) deny('arguments'); options.set(key,value);
  }
  if (!['inspect','diagnose','validate'].includes(command) && keys[command]!.some(key => !['--head-sha','--stages','--operations','--original-version','--run','--pr','--previous-head','--review'].includes(key) && !options.has(key))) deny('arguments');
  const get = (key: string): string => options.get('--' + key)!;
  if (command === 'inspect') return options.has('--proposal') ? inspectProposal(get('proposal')) : inspectRegistry();
  if (command === 'compare') return compareProposals(get('left'),get('right'));
  if (command === 'diagnose') return diagnoseRegistry(get('version'));
  if (command === 'validate') {
    if (options.size === 1 && options.has('--proposal')) return inspectProposal(get('proposal'));
    if (options.size !== 2 || !options.has('--version') || !['observe','develop','deliver'].includes(get('stage'))) deny('arguments');
    const context = managedContext({ ...process.env, AWH_ADMIN_VERSION: get('version') });
    if (!context || !context.proposed.task!.stages.includes(get('stage') as Stage)) deny('stage_not_authorized');
    return { status: 'LOCAL_STAGE_VALID', version: context.version, stage: get('stage'), provider_scope: 'NOTRUN', authority_verified: false };
  }
  if (command === 'preflight' || command === 'launcher') return launcherDescriptor(get('version'));
  if (command === 'approve' || command === 'recover') return approveProposal(get('proposal'),command === 'recover');
  if (command === 'revoke') return prepareRevoke(get('version'),get('target'),get('out'));
  if (command === 'approval-prepare') return prepareApproval(get('proposal'),get('receipt'),get('reason'),get('out'));
  if (command === 'register') return proposeProject(parse(read(get('policy'))),get('version'),get('out'));
  if (!/^[1-9]\d*$/.test(get('issue'))) deny('arguments');
  const task: Task = { repository: get('repo'), issue: Number(get('issue')), branch: get('branch'), base_sha: get('base-sha'), head_sha: get('head-sha') ?? null,
    profile: get('profile'), workflow: get('workflow'), executor_id: get('executor'), machine_id: get('machine'), expires_at: get('expires-at'),
    stages: (get('stages') ?? 'develop').split(',') as Stage[], provider_operations: get('operations') ? get('operations').split(',') as ProviderOperation[] : [] };
  const revisionKeys = ['original-version','run','pr','previous-head','review'];
  if (revisionKeys.some(k => options.has('--' + k))) {
    if (!revisionKeys.every(k => options.has('--' + k)) || ![get('pr'),get('review')].every(v => /^[1-9]\d*$/.test(v))) deny('arguments');
    task.revision = {original_version:get('original-version'),run_id:get('run'),pull_request:Number(get('pr')),previous_head:get('previous-head'),review_id:Number(get('review'))};
  }
  return prepareGrant(get('policy-version'),get('version'),task,get('out'));
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
