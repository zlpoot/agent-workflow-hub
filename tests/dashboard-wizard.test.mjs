import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { WIZARD_STEPS, HISTORY, HISTORY_CHECKS, CANDIDATE_ARTIFACT, CONFIG_TEMPLATE, installationTemplate, projectChoices, stepAt, wizardModel } from '../dashboard/wizard-model.mjs';
import { selectWorkflow } from '../dist/profiles.js';
import { deliveryPolicy } from '../dist/client/delivery-policy.js';
import { CLIENT_VERSION } from '../dist/client/version.js';

const empty = { snapshot: null, events: [], phase: 'error', lastRefresh: null };
const reader = { snapshot: { cursor: 17, projects: [{ id: 'visible', repository: 'zlpoot/future-ui', profile_ref: 'future-ui/c1c-acceptance' }],
  runs: [{ id: 'retained', project_id: 'visible', source: { ref: 'product/active' }, profile: { version: 'stored-v1' }, executor_id: 'visible-executor',
    work_item: { reference: { number: 90 } }, updated_at: '2026-10-09T01:00:00.000Z' }] },
  events: [{ project_id: 'visible', cursor: 17 }], phase: 'outdated', lastRefresh: Date.parse('2026-10-09T01:00:00.000Z') };

test('all four steps remain navigable without Viewer or config, using a clearly separate historical source', () => {
  assert.equal(WIZARD_STEPS.length, 4);let step=0;
  for(let n=1;n<4;n++){step=stepAt(step,1);assert.equal(step,n);}assert.equal(stepAt(step,1),3);
  for(let n=2;n>=0;n--){step=stepAt(step,-1);assert.equal(step,n);}assert.equal(stepAt(step,-1),0);
  const model=wizardModel(empty,'history:future-ui');assert.equal(model.project.source,'history_35');
  assert.equal(model.configuration,'not_checked');assert.equal(model.currentDoctor,'not_checked');assert.equal(model.timeline.available,false);
  assert.equal(model.timeline.lastRefresh,null);assert.equal(model.timeline.cursor,null);assert.equal(model.authority_verified,false);
  assert(!projectChoices(empty).some(p=>p.source==='reader_snapshot'));
});

test('Viewer project selection is scoped, and stored versions/Issue/Executor are observations rather than approvals', () => {
  const before=JSON.stringify(reader),choices=projectChoices(reader);
  assert.deepEqual(choices.filter(p=>p.source==='reader_snapshot').map(p=>p.id),['visible']);
  assert.equal(wizardModel(reader,'reader:hidden').project,null);
  const model=wizardModel(reader,'reader:visible');assert.equal(model.historical,false);assert.equal(model.approvedVersion,null);
  assert.equal(model.observedVersion,'stored-v1');assert.equal(model.branch,'product/active');assert.equal(model.issue,90);
  assert(model.checks.every(c=>c.status==='not_checked'));assert(model.differences.every(d=>d.expected===null&&d.status==='not_checked'));
  assert.equal(model.authority_verified,false);assert.equal(JSON.stringify(reader),before);
});

test('Reader timeline retains cursor/lastRefresh/outdated provenance; synthetic connection cannot become real live PASS', () => {
  const model=wizardModel(reader,'reader:visible',true);
  assert.equal(model.sourceLabel,'模拟 Reader 快照 · 非真实 CP');assert.equal(model.timeline.source,'synthetic_reader');
  assert.equal(model.timeline.phase,'outdated');assert.equal(model.timeline.cursor,17);assert.equal(model.timeline.lastRefresh,reader.lastRefresh);
  assert.equal(model.timeline.runCount,1);assert.equal(model.timeline.eventCount,1);assert.equal(model.approvedVersion,null);
  const disconnected=wizardModel({...empty,phase:'offline'},'reader:visible');assert.equal(disconnected.timeline.available,false);
});

test('#35 original 9/4/9 remains immutable history, including conservative journals and separately retained Issue 90', () => {
  const model=wizardModel(reader,'history:future-ui');
  for(const [s,n] of Object.entries(HISTORY.counts))assert.equal(model.checks.filter(c=>c.status===s).length,n);
  assert.equal(model.checks.find(c=>c.id==='work_item').code,'work_item_profile_conflict');
  assert.equal(model.checks.find(c=>c.id==='journal').status,'blocked');
  assert(model.checks.find(c=>c.id==='journal').safe_next_step.includes('不表示新运行失败'));
  assert.equal(model.differences.find(d=>d.field==='期望 / 历史 Issue').expected,null);
  assert(model.differences.find(d=>d.field==='期望 / 历史 Issue').observed.includes('#90'));
  assert(!JSON.stringify(model).includes('#0'));assert.equal(model.approvedVersion,null);
  assert.equal(HISTORY.artifact.version,'0.4.5');assert.equal(CANDIDATE_ARTIFACT.version,CLIENT_VERSION);assert.equal(CANDIDATE_ARTIFACT.status,'not_checked');
});

test('installation templates copy instructions only, preserve existing identities and have no execution/credential values', () => {
  for(const platform of ['windows','mac']){
    const template=installationTemplate(platform);assert(template.includes('--offline --ignore-scripts'));
    assert(template.includes('--config'));assert(!template.includes('--probe-cp'));assert(template.includes('explicit_config_missing'));
    assert(!/awh_cp_|github_pat_|BEGIN PRIVATE|register|heartbeat|deliver/.test(template+CONFIG_TEMPLATE));
    assert(!template.includes(HISTORY.artifact.sha256));
  }
  assert.throws(()=>installationTemplate('arbitrary-shell'));
  const ui=readFileSync(new URL('../dashboard/wizard.tsx',import.meta.url),'utf8');
  assert(!/fetch\(|EventSource|FileReader|type="file"|localStorage|sessionStorage|document\.cookie|console\.|Authorization/.test(ui));
  assert(ui.includes('navigator.clipboard.writeText(template)'));
});

test('Wizard remains outside missing-snapshot branch, and scoped destinations reuse existing Reader navigation', () => {
  const source=readFileSync(new URL('../dashboard/app.tsx',import.meta.url),'utf8');
  assert(source.indexOf("view === 'Wizard' ?")<source.indexOf(': !snapshot ?'));
  assert(source.includes('setProject(id)'));assert(source.includes('onProject={id =>'));
});

test('one-time c1j publication mapping is exact and does not create Client Deliver authority or change existing workflows', () => {
  const {profile,workflow}=selectWorkflow({profile:'hub',workflow:'c1j'});
  assert.equal(profile.repository,'zlpoot/agent-workflow-hub');assert.equal(profile.base,'main');
  assert.equal(workflow.branch,'codex/c1j-dashboard-wizard-prototype');assert.deepEqual(workflow.work_item,{repo:profile.repository,issue:33});
  assert.equal(workflow.bootstrap_paths,null);assert.deepEqual(workflow.verification_commands,
    ['pnpm build','pnpm typecheck','node --test tests/dashboard-ui.test.mjs tests/dashboard-wizard.test.mjs tests/doctor.test.mjs']);
  assert.throws(()=>deliveryPolicy('hub/c1j'));
  assert.equal(selectWorkflow({profile:'future-ui',workflow:'repeatable-docs'}).workflow.work_item.issue,0);
  assert.deepEqual(selectWorkflow().workflow.verification_commands,['pnpm check']);
});
