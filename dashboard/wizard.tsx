import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Flex, Heading, Select, Text, TextField } from '@radix-ui/themes';
import { CANDIDATE_ARTIFACT, CONFIG_TEMPLATE, HISTORY, WIZARD_STEPS, installationTemplate, projectChoices, stepAt, wizardModel } from './wizard-model.mjs';
import { text } from './zh-CN.mjs';
import { localBindings, localDoctor, matchLocalBinding } from './onboarding.mjs';

type ReaderState = { snapshot: { cursor: number; projects: { id: string; repository: string; profile_ref: string }[];
  runs: { id: string; project_id: string; updated_at: string; source: { ref: string }; profile: { version: string };
    executor_id: string; work_item: { reference: { number: number } } | null }[] } | null;
  phase: string; lastRefresh: number | null; events: { project_id: string }[] };
type Destination = 'Projects' | 'Executors' | 'Runs' | 'Timeline';
type Diagnosis = { id: string; project_id: string; repository: string; status: string; observed_at: string; client_version: string | null;
  approved_version: string | null; checks: { id: string; status: string; code: string; source: string; safe_next_step: string }[] };
type LocalBinding = { id: string; project_id: string; repository: string; worktree: string; current: Diagnosis | null };
const statusColor = (status: string) => status === 'passed' ? 'teal' : status === 'blocked' ? 'red' : 'gray';
function CheckStatus({ status }: { status: string }) { return <Badge color={statusColor(status)}>{status} · {text(status)}</Badge>; }
const unavailable = (value: string | number | null) => value ?? 'not_checked · 未核验 / unavailable';

export function Wizard({ state, fixture, onNavigate, onProject }: { state: ReaderState; fixture: boolean;
  onNavigate: (view: Destination, project: string) => void; onProject: (id: string) => void }) {
  const [step, setStep] = useState(0), [key, setKey] = useState(''), [platform, setPlatform] = useState('windows');
  const [copyStatus, setCopyStatus] = useState('');
  const [bindings, setBindings] = useState<LocalBinding[]>([]), [localError, setLocalError] = useState<string | null>(null), [checking, setChecking] = useState(false);
  const [enteredRepo, setEnteredRepo] = useState(''), [enteredRoot, setEnteredRoot] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { const abort = new AbortController();
    void localBindings(abort.signal).then(setBindings).catch((error: Error) => { if (!abort.signal.aborted) setLocalError(error.message); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);
  const panel = useRef<HTMLHeadingElement>(null);
  useEffect(() => { panel.current?.focus(); }, [step]);
  const choices = projectChoices(state, fixture, bindings), selected = choices.find(p => p.key === key);
  const binding = key.startsWith('local:') ? bindings.find(b => 'local:' + b.id === key) : bindings.find(b => b.project_id === selected?.id && b.repository === selected?.repository);
  const model = wizardModel(state, key, fixture, binding?.current, bindings);
  useEffect(() => { if (!key) { const first = choices.find(p => p.source !== 'history_35'); if (first) setKey(first.key); } }, [key, state.snapshot, bindings]);
  const diagnose = async () => {
    if (!binding) return;
    controller.current?.abort(); const abort = controller.current = new AbortController(); setChecking(true); setLocalError(null);
    try { const current = await localDoctor(binding.id, abort.signal); if (!abort.signal.aborted) setBindings(previous => previous.map(b => b.id === binding.id ? { ...b, current } : b)); }
    catch (error) { if (!abort.signal.aborted) setLocalError(error instanceof Error ? error.message : '本机诊断不可用'); }
    finally { if (!abort.signal.aborted) setChecking(false); }
  };
  const template = installationTemplate(platform);
  const copy = async () => {
    try { await navigator.clipboard.writeText(template); setCopyStatus('已复制脱敏命令模板；占位符需人工替换。'); }
    catch { setCopyStatus('浏览器未允许复制；可手工选中下方模板。'); }
  };
  const choose = (value: string) => { controller.current?.abort(); setChecking(false); setKey(value); setCopyStatus(''); setLocalError(null); };
  return <section className="wizard" aria-label="项目接入向导">
    <div className="notice">只读接入向导 · 可显式请求已登记 Client 的离线 Doctor；不接收配置或凭据、不批准权限。原 #30 历史结论 PHASE_C_ACCEPTED_WITH_EXCEPTION 保留。</div>
    <nav aria-label="接入步骤"><ol className="wizard-steps">{WIZARD_STEPS.map((label, index) => <li key={label}><button
      aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}><span>{index + 1}</span>{label}</button></li>)}</ol></nav>
    <div className="wizard-source"><Badge color="amber">{model.sourceLabel}</Badge><Text size="2">当前本机 Doctor：{model.currentDoctor} · 批准 Work Item 版本：{model.approvedVersion ?? 'not_checked'}</Text></div>
    {localError && <div className="notice" role="status">{localError}</div>}
    <Card className="wizard-panel"><Heading ref={panel} tabIndex={-1} size="5">第 {step + 1} 步 · {WIZARD_STEPS[step]}</Heading>
      {step === 0 && <div className="wizard-stack">
        <Text color="gray">选择当前 Reader 项目或操作人已登记的本机工作树。历史样本需显式选择；选择不会注册项目或改变策略。</Text>
        <label className="wizard-label">项目 / 数据来源<Select.Root value={model.project ? key : ''} onValueChange={choose}>
          <Select.Trigger placeholder="请选择已有项目" aria-label="选择项目与来源" /><Select.Content>{choices.map(p => <Select.Item key={p.key} value={p.key}>{p.label}</Select.Item>)}</Select.Content></Select.Root></label>
        {!state.snapshot && <div className="notice">没有 Viewer 快照：真实项目列表与连接均未核验。向导仍可使用明确的历史离线样本走完四步。</div>}
        <details><summary>输入本机实际 Git 工作树与仓库</summary><div className="wizard-stack">
          <label>仓库<TextField.Root aria-label="本机仓库" value={enteredRepo} onChange={e => setEnteredRepo(e.target.value)} placeholder="owner/repository" /></label>
          <label>工作树绝对路径<TextField.Root aria-label="本机工作树" value={enteredRoot} onChange={e => setEnteredRoot(e.target.value)} /></label>
          <Button variant="soft" onClick={() => { const matched = matchLocalBinding(bindings, enteredRepo, enteredRoot); if (matched) choose(choices.find(p => p.id === matched.project_id && p.repository === matched.repository)?.key ?? 'local:' + matched.id); else setLocalError('BLOCKED：此工作树未在当前 Viewer 范围登记。请操作人登记可信接入；表单不能增加权限。'); }}>核对本机登记</Button>
          <Text size="2">输入只与已登记项比较，不扫描磁盘或上传配置。</Text></div></details>
        {model.project ? <dl className="wizard-facts"><dt>仓库</dt><dd>{model.project.repository}</dd><dt>当前 Profile ref</dt><dd>{model.project.profile_ref}</dd>
          <dt>观察到的版本</dt><dd>{unavailable(model.observedVersion)} · 存储 / 历史记录，非审批</dd><dt>已批准 Work Item 版本</dt><dd>{model.approvedVersion ?? 'not_checked · 未核验'}</dd>
          <dt>App Scope / 写权限</dt><dd>not_checked · Viewer 可见项目不授予写权限</dd></dl> : <Text>所选项目不在当前 Viewer 范围；请重新选择。</Text>}
        {model.timeline.available && model.project && <Button variant="soft" onClick={() => onProject(model.project!.id)}>查看已有项目详情</Button>}
      </div>}
      {step === 1 && <div className="wizard-stack">
        <Text>安装独立 Client，无需 Hub checkout。已安装时优先使用原安装与原 Machine / Executor / endpoint / CA / state；不要初始化、覆盖或重新认领。</Text>
        <label className="wizard-label">平台<Select.Root value={platform} onValueChange={value => { setPlatform(value); setCopyStatus(''); }}><Select.Trigger aria-label="安装平台" />
          <Select.Content><Select.Item value="windows">Windows · PowerShell</Select.Item><Select.Item value="mac">macOS · shell</Select.Item></Select.Content></Select.Root></label>
        <div className="diagnostic"><strong>本轮新包：not_checked · {CANDIDATE_ARTIFACT.version} 源码候选</strong><p>{CANDIDATE_ARTIFACT.note}</p></div>
        <div className="diagnostic"><strong>当前安装：{model.installedVersion ?? 'not_checked'} · 配置：{model.configuration}</strong><p>最近本机观测：{model.observedAt ?? 'not_checked'}</p></div>
        <Button variant="soft" disabled={!binding || model.historical || checking} onClick={() => void diagnose()}>{checking ? '正在检查…' : '检测当前安装与配置'}</Button>
        <details className="wizard-artifact"><summary>#35 历史实测产物 · 仅适用于原 0.4.5 样本</summary><p>{HISTORY.artifact.package}@{HISTORY.artifact.version}</p>
          <p>来源 commit：<code>{HISTORY.artifact.source_sha}</code></p><p>实测 SHA-256：<code>{HISTORY.artifact.sha256}</code></p>
          <a href={HISTORY.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看 #35 原始脱敏证据 ↗</a><p>这份历史 digest 不适用于更新后的 {CANDIDATE_ARTIFACT.version} 或来源不明 tarball。</p></details>
        <Flex gap="3" align="center" wrap="wrap"><Button variant="soft" onClick={() => void copy()}>复制脱敏命令模板</Button><Text size="2" role="status">{copyStatus}</Text></Flex>
        <pre className="wizard-code" tabIndex={0} aria-label="脱敏安装与 Doctor 命令">{template}</pre>
        <details><summary>人工可信外部配置 · 脱敏结构示意</summary><p>示意不能直接运行，不是新的审批。不要上传文件或真实字段值。已有配置直接复用；既有 CA 字段按原值保留。</p><pre className="wizard-code">{CONFIG_TEMPLATE}</pre></details>
      </div>}
      {step === 2 && <div className="wizard-stack">
        <Text>{model.historical ? '以下为原 #35 离线历史诊断，9 passed / 4 blocked / 9 not_checked；没有重新运行，原记录保持不变。' : model.observedAt ? `当前已安装 Client 离线 Doctor · 观测时间 ${model.observedAt}；远端权限保持未核验。` : '尚未运行当前本机 Doctor；存储的 Run 不代表本次接入。'}</Text>
        <Button disabled={!binding || model.historical || checking} onClick={() => void diagnose()}>{checking ? '正在诊断…' : '运行离线 Doctor'}</Button>
        {!binding && !model.historical && <Text>not_checked：请操作人在 Viewer 外置配置中登记 Client 安装与工作树，再重新启动独立 Viewer。</Text>}
        {model.historical && <><div className="notice">工作树 dirty；分支不匹配；有 3 个保留 Journal 和 recovery record，待人工核对。这些记录不表示新运行失败。</div>
          <div className="diagnostic"><strong>本轮 Doctor 小修正 · 与历史统计分开</strong><p>非法动态分支的期望 Issue：null / unavailable；work_item = not_checked: dynamic_issue_unavailable。历史 Issue #90 单独保留，不反推当前授权；branch 仍 blocked: branch_profile_conflict。</p><p>原 #35 曾输出未解析的数字占位值；它不是已批准的 Issue。此处不把修正后的结果写成真实重跑 PASS。</p></div></>}
        <Heading size="3">有效批准策略 vs observed</Heading><Text size="2">{model.approvedVersion ? `本机 Doctor 已核验批准 Work Item 版本 ${model.approvedVersion}；比较不授予 Provider 权限。` : '批准策略未提供；下列预期仅是静态映射或 unavailable，不是生效授权。'}</Text>
        <div className="wizard-differences">{model.differences.map((d: { field: string; expected: string | number | null; observed: string | number | null; status: string }) => <div className="diagnostic" key={d.field}><Flex justify="between" wrap="wrap" gap="2"><strong>{d.field}</strong><CheckStatus status={d.status} /></Flex>
          <p>比较预期：{unavailable(d.expected)}</p><p>observed：{unavailable(d.observed)}</p><div className="secondary">{model.sourceLabel} · authority_verified=false</div></div>)}</div>
        <Heading size="3">检查与下一步</Heading><div className="wizard-checks">{model.checks.map((c: Diagnosis['checks'][number]) => <article className="diagnostic" key={c.id}><Flex justify="between" wrap="wrap" gap="2"><strong>{c.id}</strong><CheckStatus status={c.status} /></Flex>
          <code>{c.code}</code><div className="secondary">source：{c.source} · {model.sourceLabel}</div><p>{c.safe_next_step}</p></article>)}</div>
      </div>}
      {step === 3 && <div className="wizard-stack">
        <Text>沿用现有 DashboardReader 的同源只读快照与事件游标。存储的 Run / Event 是历史记录，不是 GitHub 审批或当前本机验证。</Text>
        <dl className="wizard-facts"><dt>Reader 数据来源</dt><dd>{model.timeline.source === 'synthetic_reader' ? '模拟 Fixture · 非真实 CP' : model.timeline.source === 'reader_snapshot' ? '当前 / 上次只读快照' : 'not_checked · 没有快照'}</dd>
          <dt>连接 / 过期状态</dt><dd>{text(model.timeline.phase)} · 仅 Reader 状态</dd><dt>lastRefresh</dt><dd>{model.timeline.lastRefresh === null ? 'not_checked · 暂无成功观测' : new Date(model.timeline.lastRefresh).toISOString()}</dd>
          <dt>事件 cursor</dt><dd>{model.timeline.cursor ?? 'not_checked'}</dd><dt>该项目 Run / Event</dt><dd>{model.timeline.available ? `${model.timeline.runCount} / ${model.timeline.eventCount} · 当前范围内存储记录` : 'not_checked · 无授权范围内快照'}</dd></dl>
        {!model.timeline.available && <div className="notice">项目 / 机器 / 时间线 Live 未核验；向导四步已可浏览。真实 Viewer / CP 读取仍需要专门有界授权。</div>}
        <Flex gap="3" wrap="wrap">{(['Projects', 'Executors', 'Runs', 'Timeline'] as Destination[]).map(view => <Button key={view} variant="soft" disabled={!model.timeline.available}
          onClick={() => onNavigate(view, model.project!.id)}>查看{text(view)}</Button>)}</Flex>
      </div>}
    </Card>
    <Flex justify="between" gap="3" wrap="wrap" className="wizard-actions"><Button variant="soft" disabled={step === 0} onClick={() => setStep(stepAt(step, -1))}>上一步</Button>
      <Text size="2" color="gray">{step + 1} / 4 · 观察步骤，不代表授权完成</Text><Button disabled={step === 3 || !model.project} onClick={() => setStep(stepAt(step, 1))}>下一步</Button></Flex>
  </section>;
}
