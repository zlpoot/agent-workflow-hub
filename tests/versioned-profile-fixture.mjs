import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { policyFingerprint } from '../dist/client/versioned-profile.js';
export const facts = { repository:'zlpoot/agent-workflow-hub',issue_repository:'zlpoot/agent-workflow-hub',issue:901,base:'main',
  branch:'codex/new-business-901',executor:'fixture-executor',checks:['pnpm lint','pnpm typecheck'],profile_ref:'hub/fixture-business',profile_version:'v1',work_item_version:'v1' };
export function trustedFixture(directory, mutate=()=>{}) {
  const template={ref:facts.profile_ref,version:'v1',repository:facts.repository,base:'main',branch_prefix:'codex/new-business-',executors:[facts.executor],checks:facts.checks,stages:['observe','develop']};
  const item={...facts,id:'business-901',expires_at:'2099-01-01T00:00:00.000Z',stages:['observe','develop']};
  const catalog={schema_version:'1.0',kind:'versioned_profiles',profiles:[template],work_items:[item]};
  const approval=(kind,id,version,value)=>({kind,id,version,fingerprint:policyFingerprint(value),operator:'fixture-owner',source:'fixture-approval-901',approved_at:'2026-01-01T00:00:00.000Z',reason:'Offline fixture approval only',supersedes:null});
  const approvals={schema_version:'1.0',kind:'policy_approvals',entries:[approval('profile',template.ref,template.version,template),approval('work_item',item.id,item.work_item_version,item)]};
  mutate({catalog,approvals,approval});
  const encoded=JSON.stringify(catalog),encodedApprovals=JSON.stringify(approvals),sha=x=>createHash('sha256').update(x).digest('hex');
  const anchor={schema_version:'1.0',kind:'policy_trust',operator:'fixture-owner',source:'fixture-approval-901',catalog_sha256:sha(encoded),approvals_sha256:sha(encodedApprovals)};
  writeFileSync(join(directory,'profiles.json'),encoded);writeFileSync(join(directory,'approvals.json'),encodedApprovals);writeFileSync(join(directory,'trust.json'),JSON.stringify(anchor));
  return {path:join(directory,'trust.json'),selection:{id:item.id,version:item.work_item_version},catalog,approvals};
}
