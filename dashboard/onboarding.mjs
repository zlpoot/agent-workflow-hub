// Separate bounded read DTO; no uploads, browser credentials or local paths in URLs.
const status = value => ['passed','blocked','not_checked'].includes(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export function diagnosisContract(value) {
  if (!value || value.authority_verified !== false || !id(value.id) || !id(value.project_id) ||
      typeof value.repository !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
      value.source !== 'installed_client_offline' || !status(value.status) || !Number.isFinite(Date.parse(value.observed_at)) ||
      value.client_version !== null && typeof value.client_version !== 'string' || value.approved_version !== null && !id(value.approved_version) ||
      !Array.isArray(value.checks) || value.checks.length > 64 || value.checks.some(c => !id(c.id) || !id(c.code) || !id(c.source) || !status(c.status) || typeof c.safe_next_step !== 'string' || c.safe_next_step.length > 1024) ||
      value.differences !== undefined && (!Array.isArray(value.differences) || value.differences.length > 10 || value.differences.some(d => typeof d.field !== 'string' || d.field.length > 128 || !status(d.status) ||
        [d.expected,d.observed].some(v => v !== null && typeof v !== 'number' && (typeof v !== 'string' || v.length > 1024)))))
    throw new Error('诊断结果契约不匹配');
  return value;
}
async function read(path, signal) {
  const response = await fetch('/dashboard/onboarding/v1/' + path, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal });
  if (!response.ok) throw new Error(response.status === 404 ? '本机诊断通道未配置，请操作人登记安装与工作树。' : response.status === 401 ? 'Viewer 会话失效，请重新打开受信本机入口。' : '本机诊断暂不可用，请保留配置并联系操作人。');
  const data = await response.json(); if (data.authority_verified !== false) throw new Error('诊断结果契约不匹配'); return data;
}
export async function localBindings(signal) {
  const data = await read('projects', signal);
  if (!Array.isArray(data.items) || data.items.length > 64 || data.items.some(b => !id(b.id) || !id(b.project_id) || typeof b.repository !== 'string' || typeof b.worktree !== 'string' || b.worktree.length > 4096)) throw new Error('本机登记契约不匹配');
  return data.items.map(b => ({ ...b, current: b.current ? diagnosisContract(b.current) : null }));
}
export async function localDoctor(binding, signal) {
  if (!id(binding)) throw new Error('未知本机登记');
  return diagnosisContract((await read('doctor/' + binding, signal)).item);
}
export function matchLocalBinding(bindings, repository, worktree) {
  const normalize = path => /^[A-Za-z]:[\\/]/.test(path) ? path.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '') : path.replace(/\/$/, '');
  return bindings.find(b => b.repository === repository.trim() && normalize(b.worktree) === normalize(worktree.trim())) ?? null;
}
