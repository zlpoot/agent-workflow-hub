import { useEffect, useRef, useState } from 'react';

// Shared V1/V2 client lifecycle for the existing closed App routes.
// React state only: no UI framework, storage, backend authority or URL input.
export type Actor = { id: number; login: string; type: string };
export type Repository = { id: number; full_name: string };
export type Facts = { installation_id: number; account: Actor; repository_selection: string; permissions: { contents: string; pull_requests: string; metadata: string }; repositories: Repository[]; delivery_actor: Actor; reviewer: Actor };
export type Inspection = { status: string; facts?: Facts; installation_id?: number; account?: string; reason?: string };
export type State = { status: string; management_enabled?: boolean; fixture?: boolean; csrf?: string; app_id?: number; app_slug?: string; installation_id?: number;
  repositories?: Repository[]; delivery_actor?: Actor; reviewer?: Actor; installations?: Inspection[]; detection_id?: string; checked_at?: string;
  saved?: boolean; connection_status?: string; inspection?: Facts; scope_saved?: boolean; scope_change?: { proposal_id: string; repositories: Repository[]; added: Repository[]; removed: Repository[] }; problem?: { code: string; message: string; next_action: string } };
export const labels: Record<string,string> = { NOT_CONNECTED: '未连接', CONNECTED_LOCAL: '已保存本机连接 · 待检查', PREFLIGHT_PASS: '实际检查通过', BLOCKED: '检查受阻', DETECTED: '已检测 · 待确认', SCOPE_CHANGED: '仓库范围已更新 · 待本机确认', SCOPE_CURRENT: 'GitHub 仓库范围已核验', SCOPE_SYNCED: '新仓库范围已保存 · 待检查' };
export const errors: Record<string,string> = {
  app_input: '填写的信息不合法，请核对 App ID、slug、PEM 绝对路径和 Reviewer。',
  app_owner_unavailable: '当前是只读 Viewer，本机可信 Owner 管理功能尚未启用。',
  app_detection_expired: '检测结果已过期或属于其他会话，请重新检测后确认。',
  app_csrf: '操作凭据已过期或已使用，请重新检测或重新检查。',
  app_busy: '另一个 App 操作正在进行，请等待完成后重试。',
  app_origin: '需要当前 Dashboard 的同源本机会话，请重新进入 Dashboard。',
  app_already_connected: '本机已有连接，请刷新状态并使用“重新检查”。此页面不会覆盖连接。',
};
export const installationProblems: Record<string,string> = { all_repositories: '安装范围为 All repositories；请 Owner 在 GitHub 改为 Selected repositories。', permissions_insufficient: '缺少 Contents: write / Pull requests: write / Metadata: read。', installation_suspended: '安装已暂停，请 Owner 在 GitHub 恢复。', network_error: 'GitHub 网络请求失败或超时，请稍后重新检测。', reviewer_identity: 'Reviewer 必须是有效的个人 User。', identity_drift: 'App 或安装身份不匹配，请核对设置。', scope_drift: '无法核验完整安装仓库范围。' };
const endpoint = '/dashboard/github-app/v1/';
export function useGithubAppSettings() {
  const [state,setState] = useState<State|null>(null),[enabled,setEnabled] = useState(false),[busy,setBusy] = useState('读取状态'),[error,setError] = useState('');
  const [appId,setAppId] = useState(''),[slug,setSlug] = useState('zlpoot-awh-builder'),[key,setKey] = useState(''),[reviewer,setReviewer] = useState('zlpoot');
  const [installation,setInstallation] = useState(''),[repository,setRepository] = useState(''),[ack,setAck] = useState(false);
  const running = useRef(false), abort = useRef<AbortController|null>(null), alive = useRef(true);
  const lastRefresh = useRef(0), connectedRef = useRef(false);
  const read = async (signal: AbortSignal): Promise<State> => {
    const response = await fetch(endpoint+'status', { method:'GET', credentials: 'same-origin', cache:'no-store', redirect:'error', signal });
    if (response.status === 404) throw new Error('此 Viewer 尚未提供 GitHub App 设置。请本机管理员更新 Viewer 后重试。');
    if (response.status === 401) throw new Error('会话已到期，请点击顶部“重新进入 Dashboard”。');
    const result = await response.json();
    if (!response.ok || result.authority_verified !== false || !result.item?.status) throw new Error('无法读取本机 App 状态，请稍后重试。');
    return result.item;
  };
  const post = async (action: string, data: Record<string,unknown>, fresh: State, controller: AbortController): Promise<State> => {
    const response = await fetch(endpoint+action, {method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error', headers:{'Content-Type':'application/json','X-AWH-CSRF':fresh.csrf ?? ''}, body:JSON.stringify(data), signal:AbortSignal.any([controller.signal,AbortSignal.timeout(['connect','sync-scope'].includes(action) ? 430000 : 130000)])});
    if (response.status === 401) throw new Error('会话已到期，请重新进入 Dashboard。若连接状态不明，先刷新本机状态。');
    const result = await response.json();
    if (!response.ok || result.authority_verified !== false || !result.item) throw new Error(errors[result.error?.code] ?? '本机操作未完成，请刷新状态后重试。');
    return result.item;
  };
  const refresh = async () => {
    if (running.current) return; running.current = true; setBusy('读取状态'); setError('');
    lastRefresh.current = Date.now();
    const controller = abort.current = new AbortController();
    try {
      let value = await read(controller.signal);
      if (value.management_enabled && value.repositories?.length) {setBusy('同步 GitHub 仓库范围');value = {...await post('refresh-scope',{},value,controller),management_enabled:true};}
      if (alive.current) {setState(value);setEnabled(value.management_enabled === true);setRepository(current => value.repositories?.some(r => r.full_name === current) ? current : value.repositories?.[0]?.full_name ?? '');setAck(false);}
    }
    catch(e) { if (alive.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : '状态暂不可用'); }
    finally { if (alive.current) setBusy(''); running.current = false; }
  };
  useEffect(() => { alive.current = true; void refresh(); return () => {alive.current = false;abort.current?.abort();}; }, []);
  useEffect(() => {
    const returned = () => {if(document.visibilityState === 'visible' && connectedRef.current && Date.now()-lastRefresh.current>=1000)void refresh();};
    window.addEventListener('focus',returned);document.addEventListener('visibilitychange',returned);
    return () => {window.removeEventListener('focus',returned);document.removeEventListener('visibilitychange',returned);};
  }, []);
  const operation = async (action: 'detect' | 'connect' | 'preflight' | 'sync-scope', data: Record<string,unknown>, label: string) => {
    if (running.current) return; running.current = true; setBusy(label); setError('');
    const controller = abort.current = new AbortController();
    try {
      const fresh = await read(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setEnabled(fresh.management_enabled === true);
      if (fresh.management_enabled !== true) throw new Error(errors.app_owner_unavailable);
      const value = await post(action,data,fresh,controller);
      if (!alive.current) return;
      setState(value);setAck(false);
      if (action === 'detect') { const first = value.installations?.find(i => i.status === 'DETECTED')?.facts;setInstallation(String(first?.installation_id ?? ''));setRepository(first?.repositories[0]?.full_name ?? ''); }
      if (action === 'connect' && value.saved) {setKey('');setAppId('');}
      if (action === 'sync-scope' && value.scope_saved) setRepository(current=>value.repositories?.some(r=>r.full_name===current)?current:value.repositories?.[0]?.full_name??'');
    } catch(e) { if (alive.current && !controller.signal.aborted) {setError(e instanceof Error ? e.message : '操作未完成，请刷新状态后重试。');setAck(false);if(action === 'connect')setState(v => v ? {...v,detection_id:undefined} : v);} }
    finally { if (alive.current) setBusy('');running.current = false; }
  };
  const changed = () => {setAck(false);setState(v => v ? {status:'NOT_CONNECTED',management_enabled:enabled,fixture:v.fixture} : v);setInstallation('');setRepository('');setError('');};
  const selected = state?.installations?.find(i => i.status === 'DETECTED' && String(i.facts?.installation_id) === installation)?.facts;
  const connected = !!state?.repositories?.length && !!state?.installation_id || state?.saved === true || state?.connection_status === 'CONNECTED_LOCAL';
  connectedRef.current = connected;
  const invalid = !/^[1-9]\d*$/.test(appId) || !Number.isSafeInteger(Number(appId)) || !/^[a-z0-9-]{1,100}$/.test(slug) || !/^[A-Za-z0-9-]{1,39}$/.test(reviewer) || !/^[A-Za-z]:[\\/]/.test(key) || /[\x00-\x1f]/.test(key);
  const disabled = !!busy || !enabled;
  return { state,enabled,busy,error,appId,setAppId,slug,setSlug,key,setKey,reviewer,setReviewer,installation,setInstallation,repository,setRepository,ack,setAck,refresh,operation,changed,selected,connected,invalid,disabled };
}
