// Presentation-only sources. No policy approval, file/config discovery or execution.
export const WIZARD_STEPS = Object.freeze(['选择项目', '安装 / 认领', 'Doctor / Policy 诊断', '任务 / 机器 / 时间线']);
export const HISTORY = Object.freeze({
  label: '#35 已脱敏离线样本 · 2026-10-09',
  url: 'https://github.com/zlpoot/agent-workflow-hub/issues/35#issuecomment-6080926077',
  repository: 'zlpoot/future-ui', profile_ref: 'future-ui/c1c-acceptance',
  observed_version: 'v02-repeatable-v1', branch: 'feat/r1-04-phase-c-ark-ui-contrast',
  head: '3502243c78f4981d06b49d57fe4fb6c31f3a6167', retained_issue: 90,
  counts: { passed: 9, blocked: 4, not_checked: 9 },
  artifact: { package: '@zlpoot/awh-client', version: '0.4.5',
    source_sha: '1e507c35f0cd908bcd8b226417ff471a505d677b',
    sha256: 'a8e9a771a5a17e55b5797ef3c31c8ee1aa56813e850a088c3796b0b9921c257c' }
});
export const CANDIDATE_ARTIFACT = Object.freeze({ version: '0.4.8', status: 'not_checked',
  note: '当前源码候选 0.4.8；新包来源 SHA 与实际 digest 需从本次产物证据核对。历史包 digest 不适用。' });
const preserve = '保留当前产品分支、文件与原有 Client state；请操作人做有界诊断，不自动切换、修复或重试。';
const request = '向操作人申请已批准的 Profile / Work Item 版本；项目表单和历史记录不能批准权限。';
const check = (id, status, code, source, safe_next_step) => ({ id, status, code, source, safe_next_step });
// Keep the original #35 statuses/counts, including the old Work Item conflict.
export const HISTORY_CHECKS = Object.freeze([
  check('installation', 'passed', 'standalone_metadata_matches', 'client_artifact', '历史安装元数据匹配；新包需重新核对来源与 digest。'),
  check('artifact_provenance', 'not_checked', 'tarball_digest_not_verified', 'not_observed', 'Doctor 不校验 tarball；#35 独立产物证据另行核对了历史包。'),
  check('repository', 'passed', 'canonical_root_origin_verified', 'local_git', '历史 root/origin/HEAD 已核对；当前本机未验证。'),
  check('worktree', 'blocked', 'worktree_dirty', 'local_git', preserve),
  check('manifest', 'passed', 'manifest_origin_matches', 'manifest_identity', 'Manifest 仅声明项目身份，不批准策略。'),
  check('configuration', 'passed', 'external_config_valid', 'external_config', '历史显式配置有效；保持 endpoint / CA / credential / namespace 不变。'),
  check('profile', 'passed', 'static_profile_mapping', 'checked_in_profile', '静态映射仅作比较，不授予执行或交付权限。'),
  check('branch', 'blocked', 'branch_profile_conflict', 'checked_in_profile', request),
  check('legacy_bootstrap', 'not_checked', 'acceptance_is_not_bootstrap_authorization', 'checked_in_profile', 'acceptance ref 不批准 bootstrap 的分支或 lint/typecheck/test。'),
  check('profile_version', 'not_checked', 'effective_approved_version_not_observed', 'not_observed', request),
  check('machine_executor', 'passed', 'existing_machine_executor_valid', 'local_state', '历史已有身份；真实 CP 注册仍未核验。'),
  check('client_state', 'passed', 'existing_session_binding_valid', 'local_state', '历史 Session 绑定有效，不证明 CP 已同步。'),
  check('pending_events', 'passed', 'no_local_pending_events', 'local_state', '历史 pending Events = 0；不执行 sync。'),
  check('journal', 'blocked', 'journal_or_reconciliation_requires_inspection', 'local_state', '有 3 个保留记录和 recovery record，待人工核对；不表示新运行失败，不 reconcile/retry。'),
  check('work_item', 'blocked', 'work_item_profile_conflict', 'checked_in_profile', '保留原 #35 诊断；未解析的期望 Issue 不代表审批，历史 Issue #90 不授予当前授权。'),
  check('verification', 'passed', 'recorded_commands_match', 'checked_in_profile', '历史记录命令匹配；Doctor 未执行或证实检查通过。'),
  check('cp_connection', 'not_checked', 'cp_probe_not_requested', 'not_observed', '真实 CP Live 读取需要另行有界授权。'),
  check('cp_profile', 'not_checked', 'cp_registry_not_observed', 'not_observed', request),
  check('cp_executor', 'not_checked', 'cp_registration_not_observed', 'not_observed', preserve),
  check('app_scope', 'not_checked', 'app_selected_set_permissions_not_live_verified', 'not_observed', '浏览器不访问 GitHub；需要单独授权的 App live preflight。'),
  check('remote_state', 'not_checked', 'github_remote_not_observed', 'not_observed', '存储的 GitHub 引用不是当前远端核验。'),
  check('github_review', 'not_checked', 'independent_exact_head_review_not_observed', 'not_observed', '独立 Review 需要对 GitHub exact head 另行进行。')
]);
export function stepAt(step, direction) {
  if (!Number.isInteger(step) || step < 0 || step > 3 || ![-1, 1].includes(direction)) throw new Error('Invalid wizard navigation');
  return Math.max(0, Math.min(3, step + direction));
}
export function projectChoices(state, fixture = false, bindings = []) {
  return [...(state.snapshot?.projects ?? []).map(p => ({ key: 'reader:' + p.id, id: p.id,
    repository: p.repository, profile_ref: p.profile_ref, source: fixture ? 'synthetic_reader' : 'reader_snapshot',
    label: `${p.id} · ${fixture ? '模拟 Reader 快照' : '当前 Reader 只读快照'}` })),
    ...bindings.filter(b => !state.snapshot?.projects.some(p => p.id === b.project_id && p.repository === b.repository)).map(b => ({ key: 'local:' + b.id,
      id: b.project_id, repository: b.repository, profile_ref: 'not_checked', source: 'trusted_local_binding', label: b.project_id + ' · 操作人登记本机工作树' })),
    { key: 'history:future-ui', id: 'future-ui', repository: HISTORY.repository, profile_ref: HISTORY.profile_ref,
      source: 'history_35', label: 'Future UI · #35 历史离线样本' }];
}
/** @param {any} state @param {string} key @param {boolean} fixture @param {any} diagnosis @param {any[]} bindings */
export function wizardModel(state, key, fixture = false, diagnosis = null, bindings = []) {
  const project = projectChoices(state, fixture, bindings).find(p => p.key === key) ?? null;
  const historical = project?.source === 'history_35';
  const runs = project && !historical ? (state.snapshot?.runs ?? []).filter(r => r.project_id === project.id) : [];
  const latest = [...runs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const sourceLabel = historical ? HISTORY.label : project?.source === 'synthetic_reader' ? '模拟 Reader 快照 · 非真实 CP' : '当前 Reader 只读快照 · 存储记录，非本机 Doctor';
  const branch = historical ? HISTORY.branch : latest?.source.ref ?? null;
  const issue = historical ? HISTORY.retained_issue : latest?.work_item?.reference.number ?? null;
  const observedVersion = historical ? HISTORY.observed_version : latest?.profile.version ?? null;
  const compare = (field, expected, observed, status = 'not_checked') => ({ field, expected, observed, status });
  const differences = [
    compare('Profile 版本', null, observedVersion),
    compare('分支', historical ? 'codex/awh-task-<正整数 Issue>' : null, branch, historical ? 'blocked' : 'not_checked'),
    compare('检查命令', historical ? 'git diff --check origin/main...HEAD' : null, historical ? '历史记录：git diff --check origin/main...HEAD' : null, historical ? 'passed' : 'not_checked'),
    compare('期望 / 历史 Issue', null, issue ? `历史保留 #${issue} · 非当前授权` : null),
    compare('执行器', null, historical ? '历史本地身份存在 · 标识已脱敏' : latest?.executor_id ?? null)
  ];
  const current = !historical && project && diagnosis?.project_id === project.id && diagnosis?.repository === project.repository ? diagnosis : null;
  const checks = historical ? HISTORY_CHECKS : current ? current.checks : [
    check('doctor', 'not_checked', 'local_doctor_not_observed', 'not_observed', '在真实工作树运行可信独立 Client 的离线 Doctor；本页面不执行命令或读取文件。'),
    check('configuration', 'not_checked', 'external_config_not_observed', 'not_observed', '操作人手工提供既有仓库外配置；不要上传到浏览器。'),
    check('approved_policy', 'not_checked', 'approved_work_item_unavailable', state.snapshot ? 'reader_snapshot' : 'not_observed', request),
    check('app_scope', 'not_checked', 'app_scope_not_verified', 'not_observed', '受保护 Reader 的项目可见性不等于 App 仓库写权限。')
  ];
  return { project, historical, sourceLabel: current ? '当前已安装 Client · 本机离线诊断' : project ? sourceLabel : '未实际验证', approvedVersion: current?.approved_version ?? null,
    observedVersion, branch, issue, differences: current?.differences ?? differences, checks, runs, authority_verified: false,
    configuration: current?.checks.find(c => c.id === 'configuration')?.status ?? 'not_checked', currentDoctor: current?.status ?? 'not_checked',
    observedAt: current?.observed_at ?? null, installedVersion: current?.client_version ?? null,
    timeline: { available: !!state.snapshot && !!project && state.snapshot.projects.some(p => p.id === project.id),
      source: !state.snapshot ? 'not_observed' : fixture ? 'synthetic_reader' : 'reader_snapshot',
      phase: state.phase, cursor: state.snapshot?.cursor ?? null, lastRefresh: state.lastRefresh,
      runCount: state.snapshot && project ? state.snapshot.runs.filter(r => r.project_id === project.id).length : 0,
      eventCount: project ? state.events.filter(e => e.project_id === project.id).length : 0 }
  };
}
export function installationTemplate(platform) {
  if (!['windows', 'mac'].includes(platform)) throw new Error('Unsupported instruction platform');
  const install = 'npm install --prefix "<新的仓库外工具目录>" --offline --ignore-scripts --no-audit --no-fund "<已核验来源及SHA256的tarball绝对路径>"';
  const doctor = platform === 'windows'
    ? '& "<新工具目录>/node_modules/.bin/awh.cmd" --config "<既有可信仓库外配置绝对路径>" doctor\n& "<新工具目录>/node_modules/.bin/awh.cmd" --config "<既有可信仓库外配置绝对路径>" doctor --json'
    : '"<新工具目录>/node_modules/.bin/awh" --config "<既有可信仓库外配置绝对路径>" doctor\n"<新工具目录>/node_modules/.bin/awh" --config "<既有可信仓库外配置绝对路径>" doctor --json';
  return `${platform === 'windows' ? '# Windows PowerShell · Node.js 24+ / Git' : '# macOS shell · Node.js 24+ / Git'}\n# 仅为脱敏模板：由操作人替换占位符，本页面不会执行\n${platform === 'windows' ? 'Get-FileHash -Algorithm SHA256 "<tarball绝对路径>"' : 'shasum -a 256 "<tarball绝对路径>"'}\n# 与本次可信来源的 digest 人工核对，再选择新的安装目录\n${install}\n# 已安装时优先使用原安装及原身份，不重复初始化\n# 无既有配置时去掉 --config 参数，保留 explicit_config_missing\n${doctor}`;
}
export const CONFIG_TEMPLATE = '{\n  "schema_version": "1.0",\n  "endpoint": "<操作人提供的原 endpoint>",\n  "credential_file": "<原专用凭据文件绝对路径，不粘贴内容>",\n  "state_directory": "<原 state 目录绝对路径>",\n  "executor_id": "<原 Executor ID>",\n  "executor_type": "codex",\n  "profile_version": "<操作人批准的原版本>"\n}';
