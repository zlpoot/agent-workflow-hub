import { clientFail } from '../client/local.js';
import { GithubApp } from './github-app.js';

export const GITHUB_APP_COMMANDS = [
  'github-app connect --app-id <ID> --slug <slug> --key <absolute-external-PEM> --repos <owner/repo[,owner/repo]> --reviewer <personal-login> --confirm',
  'github-app preflight --repo <owner/repo>', 'github-app status'
];
export async function githubAppMain(args: string[], app = new GithubApp()) {
  if (args.length === 1 && args[0] === '--help') return { commands: GITHUB_APP_COMMANDS };
  if (args.length === 1 && args[0] === 'status') return app.status();
  if (args.length === 3 && args[0] === 'preflight' && args[1] === '--repo') {
    const p = await app.preflight(args[2]!);
    return { status: 'PREFLIGHT_PASS', ...p.binding, writes_performed: false };
  }
  if (args[0] !== 'connect') clientFail('arguments', 'Use github-app --help; arbitrary API or credential commands are unavailable.');
  const values = new Map<string,string>();
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (!['--app-id','--slug','--key','--repos','--reviewer','--confirm'].includes(key) || values.has(key)) clientFail('arguments', 'Unknown or duplicate App option.');
    if (key === '--confirm') values.set(key, 'true');
    else { const v = args[++i]; if (!v || v.startsWith('--')) clientFail('arguments', 'Missing App option value.'); values.set(key,v); }
  }
  if (values.size !== 6) clientFail('arguments', 'Owner must supply App ID, slug, external key, complete selected repositories and personal Reviewer once.');
  return app.connect({ app_id: Number(values.get('--app-id')), app_slug: values.get('--slug')!, private_key_path: values.get('--key')!,
    repositories: values.get('--repos')!.split(','), reviewer: values.get('--reviewer')! }, values.has('--confirm'));
}
