import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GithubApp } from '../../dist/workflow/github-app.js';

// Injected fixture only. Never accepted through a Viewer configuration or REST body.
export function dashboardAppFixture(directory, count = 2) {
  const key = join(directory, 'fixture.pem'), configPath = join(directory, 'connection.json');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const input = { app_id: 5, app_slug: 'synthetic-builder', private_key_path: key, reviewer: 'synthetic-owner' };
  const repositories = Array.from({ length: count }, (_,i) => ({ id: 42 + i, full_name: `synthetic-org/repository-${i+1}` }));
  let mode = 'success'; const calls = [];
  const account = { id: 20, login: 'synthetic-org', type: 'Organization' };
  const installation = () => ({ id: 9, app_id: 5, app_slug: 'synthetic-builder', account, repository_selection: mode === 'all' ? 'all' : 'selected', suspended_at: null,
    permissions: { contents: mode === 'permissions' ? 'read' : 'write', pull_requests: 'write', metadata: 'read' } });
  const fetch = async (url, init) => {
    const u = new URL(url), path = u.pathname, body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body });
    if (mode === 'network') throw new Error('Fixture private diagnostic must not escape');
    let value;
    if (path === '/app') value = { id: mode === 'identity' ? 6 : 5, slug: 'synthetic-builder' };
    else if (path === '/app/installations') value = mode === 'not-installed' ? [] : Number(u.searchParams.get('page')) === 1 ? mode === 'mixed' ? [{...installation(),id:8,account:{id:21,login:'synthetic-other',type:'Organization'},repository_selection:'all'},installation()] : [installation()] : [];
    else if (path.endsWith('/installation') || path === '/app/installations/9') value = installation();
    else if (path.endsWith('/access_tokens')) value = { token: 'ghs_NEVER_EXPOSE_FIXTURE', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: { metadata: 'read', ...body.permissions },
      ...(body.repository_ids ? { repositories: repositories.filter(r => body.repository_ids.includes(r.id)) } : {}) };
    else if (path === '/installation/repositories') { const page = Number(u.searchParams.get('page')); value = { total_count: repositories.length, repositories: mode === 'scope' ? [{id:99,full_name:'synthetic-org/drift'}] : repositories.slice((page-1)*100,page*100) }; }
    else if (path.startsWith('/users/synthetic-builder')) value = { id: mode === 'bot' ? 78 : 77, login: 'synthetic-builder[bot]', type: 'Bot' };
    else if (path === '/users/synthetic-owner') value = { id: mode === 'reviewer' ? 12 : 11, login: 'synthetic-owner', type: 'User' };
    else throw new Error('Unexpected fixture request');
    return new Response(JSON.stringify(value));
  };
  const app = new GithubApp({ fetch, configPath, protect: () => {} });
  return { app, input, repositories, key, configPath, calls, setMode(value) { mode = value; } };
}
