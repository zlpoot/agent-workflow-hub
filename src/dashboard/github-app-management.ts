import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fail } from '../shared/security.js';
import { GithubApp, GithubAppError, type AppInput, type AppInspection } from '../workflow/github-app.js';
import type { AppOwnerRequest } from './github-app-owner.js';

const messages: Record<string, [string,string]> = {
  not_installed: ['此 App 尚未安装到账号。','在 GitHub 安装 App，明确选择仓库后重新检测。'],
  all_repositories: ['安装范围为 All repositories，AWH 要求 Selected repositories。','由 Owner 在 GitHub 安装设置中选择具体仓库；此页面不会修改安装范围。'],
  permissions_insufficient: ['安装缺少所需仓库权限。','由 Owner 核对 Contents: write、Pull requests: write、Metadata: read，并接受待确认权限。'],
  unsafe_key_path: ['PEM 路径不存在、不合法、被重定向或位于 Git 仓库内。','填写已有 PEM 的本机绝对路径，放在 Git 外受保护的普通目录。'],
  unsafe_acl: ['本机文件或目录的拥有者/ACL 不符合保护要求。','请本机 Owner 将拥有者和允许访问者限定为 Owner、SYSTEM、Administrators。'],
  invalid_key: ['文件不是可用的 RSA PEM 私钥。','核对该 App 的已有 PEM 文件，不要粘贴密钥内容或 Token。'],
  app_authentication: ['GitHub 未接受该 App ID 与 PEM 身份。','核对 App ID、slug 和对应的有效私钥。'],
  github_not_found: ['GitHub 未返回所请求的 App、安装或用户。','核对 App 设置、安装账号及 Reviewer 登录名。'],
  github_forbidden: ['GitHub 拒绝请求或触发限流。','检查安装是否暂停、权限是否批准；稍后重试。'],
  network_error: ['无法完成 GitHub 网络请求或请求已超时。','检查本机网络和 GitHub 可用性后重新检查。'],
  installation_suspended: ['此 App 安装已暂停。','由 Owner 在 GitHub 恢复该安装后重新检测。'],
  identity_drift: ['App、Installation、Bot 或 Reviewer 与已确认身份不一致。','停止连接/交付，核对 GitHub 与本机配置；新连接请重新检测。'],
  scope_drift: ['GitHub 仓库范围发生变化，或完整范围暂未核验通过。','点击“同步 GitHub 仓库范围”回读实际范围；核对新增和移除仓库，再由 Windows Owner 确认保存。已有队列不会被重绑。'],
  reviewer_identity: ['Reviewer 不是该登录名对应的独立个人 User。','填写真实个人 Reviewer 登录名；不能使用 Bot 身份。'],
  bot_identity: ['GitHub 返回的 Bot 身份不符合该 App。','核对 App slug 及真实 Bot 用户。'],
  configuration_invalid: ['已有受保护连接配置无法校验。','由本机 Owner 检查配置文件和 ACL；此页面不会覆盖已有连接。'],
  installation_limit: ['安装列表超过安全上限或无法完整读取。','由 Owner 核对安装范围；AWH 最多检查 128 个安装/选中仓库。'],
  owner_cancelled: ['本机 Owner 已取消连接。','配置未保存。需要连接时重新检测并在 Windows 确认窗口中确认。'],
  owner_failed: ['Windows Owner 确认未完成。','检查本机 Owner 配置及确认窗口；配置不会由浏览器确认代替。'],
  operation_cancelled: ['操作会话已失效或已取消，连接未更新。','返回设置重新同步 GitHub 范围，再核对并确认。'],
  invalid_input: ['填写的信息格式不正确。','App ID 必须为正整数，PEM 必须是本机绝对路径；核对 slug 和 Reviewer。'],
  configuration_directory: ['本机受保护 App 配置目录尚未就绪。','请本机管理员完成 AWH 安装的 Owner 目录保护后重试，不要在 Git 仓库内创建配置。'],
  connection_save_failed: ['连接文件未能安全保存，或已有文件不能覆盖。','刷新连接状态；由本机 Owner 检查受保护配置目录。'],
  token_expiry: ['GitHub 返回的 Installation Token 有效期不符合要求。','检查本机时间与 GitHub 服务状态后重试。'],
  token_permissions: ['GitHub 返回的 Token 权限与请求的最小权限不一致。','核对 App 权限和 GitHub 返回值；AWH 不接受额外权限 Token。'],
  token_scope: ['GitHub 返回的 Token 不符合指定的单仓库范围。','核对保存的仓库 ID 与安装范围，停止使用不一致的 Token。'],
};
export function appProblem(code: string) {
  const value = messages[code] ?? ['App 身份、范围或最小权限 Token 未能校验。','核对 App 设置和本机受保护配置后重试。'];
  return { code: Object.hasOwn(messages, code) ? code : 'verification_failed', message: value[0], next_action: value[1], settings_url: 'https://github.com/settings/installations' };
}
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const keys = (v: Record<string,unknown>, expected: string) => Object.keys(v).sort().join(',') === expected;
export function appInput(data: Record<string,unknown>): AppInput {
  if (!keys(data, 'app_id,app_slug,private_key_path,reviewer') || !id(data.app_id) || typeof data.app_slug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(data.app_slug) ||
      typeof data.reviewer !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(data.reviewer) || typeof data.private_key_path !== 'string' ||
      data.private_key_path.length > 1024 || !/^[A-Za-z]:[\\/]/.test(data.private_key_path) || /[\x00-\x1f]/.test(data.private_key_path)) fail(400, 'app_input', 'Closed Windows App input required');
  return data as unknown as AppInput;
}
export async function githubAppBody(request: IncomingMessage): Promise<Record<string,unknown>> {
  if (request.headersDistinct['content-type']?.length !== 1 || request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) fail(415, 'app_content_type', 'JSON required');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) fail(413, 'app_body_limit', 'Bounded input required'); chunks.push(chunk); }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return fail(400, 'app_input', 'Valid JSON required'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => ['__proto__','constructor','prototype'].includes(k))) fail(400, 'app_input', 'Closed object required');
  return data as Record<string,unknown>;
}
/** Fixed local business actions. No credentials, executable or configuration paths are accepted from the browser. */
export function createGithubAppManagement(options: { app?: GithubApp; confirm?: (request: AppOwnerRequest, signal: AbortSignal) => Promise<boolean>; now?: () => number; fixture?: boolean } = {}) {
  const app = options.app ?? new GithubApp(), now = options.now ?? Date.now;
  const csrf = new Map<string, { digest: string; expires: number }>();
  const detections = new Map<string, { session: string; input: AppInput; inspection: AppInspection; expires: number }>();
  const scopes = new Map<string, { session: string; value: Awaited<ReturnType<GithubApp['inspectScope']>>; expires: number }>();
  let busy = false, active: AbortController | undefined;
  const prune = () => { for (const [k,v] of csrf) if (v.expires <= now()) csrf.delete(k); for (const [k,v] of detections) if (v.expires <= now()) detections.delete(k); for (const [k,v] of scopes) if (v.expires <= now()) scopes.delete(k); };
  const blocked = (code: string, extra: Record<string,unknown> = {}) => ({ status: 'BLOCKED', problem: appProblem(code), fixture: options.fixture === true, ...extra });
  const status = () => { try { return app.status(); } catch (e) { return blocked(e instanceof GithubAppError ? e.reason : 'configuration_invalid'); } };
  return {
    read(session: string) {
      prune(); const token = randomBytes(32).toString('base64url');
      if (csrf.size >= 64 && !csrf.has(session)) fail(429, 'app_session_limit', 'Session limit');
      csrf.set(session, { digest: hash(token), expires: now() + 300000 });
      return { ...status(), management_enabled: !!options.confirm, confirmation: 'native_windows_owner', csrf: token, fixture: options.fixture === true };
    },
    async handle(action: string, data: Record<string,unknown>, session: string, token: string, signal: AbortSignal, authorized: () => boolean = () => true) {
      prune();
      if (!options.confirm) fail(403, 'app_owner_unavailable', 'Local Owner configuration required');
      const grant = csrf.get(session);
      if (!grant || grant.expires <= now() || grant.digest !== hash(token)) fail(403, 'app_csrf', 'Fresh same-session CSRF required');
      csrf.delete(session); // Consume before any asynchronous work, including errors/cancellation.
      if (!['detect','connect','preflight','refresh-scope','sync-scope'].includes(action)) fail(404, 'not_found', 'Fixed App action required');
      if (busy) fail(409, 'app_busy', 'Wait for current App operation');
      busy = true;
      active = new AbortController(); signal = AbortSignal.any([signal, active.signal]);
      const inspectionSignal = () => AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      try {
        if (action === 'refresh-scope') {
          if (!keys(data, '')) fail(400, 'app_input', 'Scope refresh accepts no configuration');
          const value = await app.inspectScope(inspectionSignal());
          for (const [k,v] of scopes) if (v.session === session) scopes.delete(k);
          if (scopes.size >= 64) fail(429, 'app_session_limit', 'Scope inspection limit');
          if (signal.aborted || !authorized()) return blocked('owner_failed');
          const proposal = randomBytes(32).toString('base64url');
          if (value.changed) scopes.set(proposal, { session, value, expires: now() + 300000 });
          const added = value.facts.repositories.filter(r => !value.previous_repositories.some(p => p.id === r.id && p.full_name === r.full_name));
          const removed = value.previous_repositories.filter(r => !value.facts.repositories.some(p => p.id === r.id && p.full_name === r.full_name));
          return { ...app.status(), status: value.changed ? 'SCOPE_CHANGED' : 'SCOPE_CURRENT', inspection: value.facts,
            scope_change: value.changed ? { proposal_id: proposal, added, removed, repositories: value.facts.repositories } : undefined,
            checked_at: new Date(now()).toISOString(), writes_performed: false, fixture: options.fixture === true };
        }
        if (action === 'sync-scope') {
          if (!keys(data, 'proposal_id') || typeof data.proposal_id !== 'string') fail(400, 'app_input', 'Select the server-inspected scope proposal');
          const snapshot = scopes.get(data.proposal_id); scopes.delete(data.proposal_id);
          if (!snapshot || snapshot.session !== session || snapshot.expires <= now()) fail(409, 'app_detection_expired', 'Refresh scope again');
          const value = snapshot.value;
          const retained = value.facts.repositories.find(r => value.previous_repositories.some(p => p.id === r.id && p.full_name === r.full_name));
          const repository = (retained ?? value.facts.repositories[0]!).full_name;
          let confirmed: boolean;
          try { confirmed = await options.confirm({ kind: 'github_app_connection', input: structuredClone(value.input), facts: structuredClone(value.facts), repository }, signal); }
          catch { return blocked('owner_failed', { ...status(), status: 'BLOCKED' }); }
          if (!confirmed) return blocked('owner_cancelled', { ...status(), status: 'BLOCKED' });
          const saveSignal = inspectionSignal();
          await value.save(true, saveSignal, () => !saveSignal.aborted && snapshot.expires > now() && authorized());
          return { ...app.status(), status: 'SCOPE_SYNCED', inspection: value.facts, checked_at: new Date(now()).toISOString(),
            scope_saved: true, writes_performed: false, fixture: options.fixture === true };
        }
        if (action === 'detect') {
          if (app.status().status !== 'NOT_CONNECTED') fail(409, 'app_already_connected', 'Existing connection retained');
          const input = appInput(data), inspection = await app.detect(input, inspectionSignal()), detection = randomBytes(32).toString('base64url');
          for (const [k,v] of detections) if (v.session === session) detections.delete(k);
          if (detections.size >= 64) fail(429, 'app_session_limit', 'Detection limit');
          detections.set(detection, { session, input: structuredClone(input), inspection: structuredClone(inspection), expires: now() + 300000 });
          return { status: inspection.installations.some(v => v.status === 'DETECTED') ? 'DETECTED' : 'BLOCKED', detection_id: detection, ...inspection, fixture: options.fixture === true };
        }
        if (action === 'connect') {
          if (!keys(data, 'detection_id,installation_id,repository') || typeof data.detection_id !== 'string' || !id(data.installation_id) || typeof data.repository !== 'string') fail(400, 'app_input', 'Connect accepts only detected selection');
          const snapshot = detections.get(data.detection_id); detections.delete(data.detection_id);
          if (!snapshot || snapshot.session !== session || snapshot.expires <= now()) fail(409, 'app_detection_expired', 'Detect again');
          if (app.status().status !== 'NOT_CONNECTED') fail(409, 'app_already_connected', 'Existing connection retained');
          const selected = snapshot.inspection.installations.find(v => v.status === 'DETECTED' && v.facts.installation_id === data.installation_id);
          if (!selected || selected.status !== 'DETECTED' || !selected.facts.repositories.some(r => r.full_name === data.repository)) fail(400, 'app_input', 'Select a detected installation/repository');
          const facts = selected.facts;
          let confirmed: boolean;
          try { confirmed = await options.confirm({ kind: 'github_app_connection', input: structuredClone(snapshot.input), facts: structuredClone(facts), repository: data.repository }, signal); }
          catch { return blocked('owner_failed'); }
          if (!confirmed) return blocked('owner_cancelled');
          if (signal.aborted || snapshot.expires <= now() || !authorized()) return blocked('owner_failed');
          const saveSignal = inspectionSignal();
          await app.connect({ ...snapshot.input, repositories: facts.repositories.map(r => r.full_name) }, true, facts, saveSignal, () => !saveSignal.aborted && snapshot.expires > now() && authorized());
          try { const live = await app.preflight(data.repository, inspectionSignal()); return { ...app.status(), status: 'PREFLIGHT_PASS', binding: live.binding, inspection: live.inspection, checked_at: new Date(now()).toISOString(), writes_performed: false, saved: true, fixture: options.fixture === true }; }
          catch (e) { return blocked(e instanceof GithubAppError ? e.reason : 'verification_failed', { saved: true, connection_status: 'CONNECTED_LOCAL', ...app.status(), status: 'BLOCKED' }); }
        }
        if (!keys(data, 'repository') || typeof data.repository !== 'string') fail(400, 'app_input', 'Choose a saved repository');
        const live = await app.preflight(data.repository, inspectionSignal());
        return { ...app.status(), status: 'PREFLIGHT_PASS', binding: live.binding, inspection: live.inspection, checked_at: new Date(now()).toISOString(), writes_performed: false, fixture: options.fixture === true };
      } catch (e) {
        if (e instanceof GithubAppError) {
          let saved: Record<string,unknown> = {}; try { const current = app.status(); if (current.status === 'CONNECTED_LOCAL') saved = { ...current, status: 'BLOCKED', connection_status: 'CONNECTED_LOCAL' }; } catch {}
          return blocked(e.reason, saved);
        }
        throw e;
      }
      finally { busy = false; active = undefined; }
    },
    close() { active?.abort(); csrf.clear(); detections.clear(); scopes.clear(); }
  };
}
