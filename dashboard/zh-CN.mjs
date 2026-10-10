// Presentation only: protocol states, identifiers, URLs and response data stay unchanged.
const messages = {
  Overview: '总览', Projects: '项目', Executors: '执行器', Runs: '运行记录', Timeline: '时间线', Wizard: '接入向导',
  Project: '项目', Executor: '执行器', Run: '运行记录',
  loading: '加载中', refreshing: '刷新中', connecting: '连接实时更新中', live: '已连接',
  partial: '部分数据 · 同步中', offline: '离线', outdated: '数据已过期', error: '暂不可用',
  online: '在线', unknown: '未知', created: '已创建', running: '运行中', verifying: '验证中',
  awaiting_review: '等待审查', completed: '已完成', failed: '失败', passed: '通过', blocked: '未通过', not_checked: '未核验',
  issue: '议题', pull_request: '拉取请求', comment: '评论', review: '审查',
  RUN_STARTED: '运行开始', STEP_STARTED: '步骤开始', STEP_COMPLETED: '步骤完成',
  VERIFICATION_STARTED: '验证开始', VERIFICATION_PASSED: '验证通过', VERIFICATION_FAILED: '验证失败',
  GITHUB_PUSH_COMPLETED: 'GitHub 推送完成', GITHUB_PR_CREATED: 'GitHub 拉取请求已创建',
  PR_REVISION_LINKED: '拉取请求修订已关联',
  HANDOFF_PUBLISHED: '交接记录已发布', REVIEW_STARTED: '审查开始', REVIEW_PASSED: '审查通过',
  RUN_COMPLETED: '运行完成', RUN_FAILED: '运行失败',
  branch: '分支', checks: '验证命令', work_item: '工作项', policy_version: '策略版本',
  github_app: 'GitHub App', provider_permissions: 'GitHub 权限',
  stored_registry: '已保存的注册信息', server_registration_or_heartbeat: '服务端记录的注册或心跳',
  runtime_projection: '运行时状态投影', runtime_event_declaration: '运行时事件声明', not_recorded: '未记录',
  client_source_declaration_vs_trusted_policy: '客户端源码声明与受信策略的比较',
  runtime_verification_declaration: '运行时验证声明', runtime_binding_only: '仅运行时绑定',
  stored_trusted_binding: '已保存的受信绑定', no_live_provider_check: '未实时核验 GitHub',
  'Confirm the real branch against the approved Policy; do not switch active worktrees automatically.': '对照已批准的策略确认实际分支；请勿自动切换活动工作区。',
  'Verify exact source SHA and the ordered checks through Builder evidence.': '通过 Builder 验证证据核对准确源码 SHA 和验证命令顺序。',
  'Confirm the selected Issue against the approved per-work-item Policy.': '对照已批准的工作项策略确认所选议题。',
  'Confirm the exact immutable Policy version.': '确认准确且不可变的策略版本。',
  'Run an explicitly authorized App live preflight outside the Dashboard.': '在面板之外执行已明确授权的 App 实时预检。',
  'Live-verify provider permissions before delivery.': '交付前实时核验 GitHub 权限。'
};
export const text = value => Object.hasOwn(messages, value) ? messages[value] : value;
const errors = {
  'Viewer session unavailable or expired': '查看会话不可用或已过期',
  'Read gateway is not enabled': '只读网关尚未启用',
  'Read projection temporarily unavailable': '读取数据暂时不可用',
  'Dashboard request failed': '面板请求失败',
  'Dashboard contract mismatch': '数据不符合面板接口契约',
  'Read projection or connection unavailable': '数据读取或网络连接不可用',
  'Invalid stream contract': '实时更新数据不符合接口契约',
  'Invalid refresh contract': '刷新提示不符合接口契约',
  'Live connection interrupted': '实时更新连接已中断'
};
export const errorText = value => Object.hasOwn(errors, value) ? errors[value] : '数据读取失败，请检查连接后重试';
export const searchText = value => JSON.stringify(value) + ' ' + JSON.stringify(value, (_key, item) => typeof item === 'string' ? text(item) : item);
