export function validQueue(value) {
  const parts=value.split(',');
  return parts.length<=128 && parts.every(v=>/^[1-9]\d*$/.test(v)&&Number.isSafeInteger(Number(v))) && new Set(parts).size===parts.length;
}
const quote=value=>"'"+value.replaceAll("'","''")+"'";
export function ownerCommand(preview,expires,executable,allowMerge) {
  if(!preview?.bound||!validQueue(preview.issues.join(','))||!Number.isFinite(Date.parse(expires))||!expires.endsWith('Z')||!/^([A-Za-z]:[\\/]|\\\\).+\.exe$/i.test(executable)||/[\r\n\0]/.test(executable))return null;
  const cli=preview.owner_cli;
  if(cli&&(![cli.node,cli.entry].every(v=>typeof v==='string'&&!/[\r\n\0]/.test(v))))return null;
  const launcher=cli?`& ${quote(cli.node)} ${quote(cli.entry)}`:'awh';
  return `Set-Location -LiteralPath ${quote(preview.directory)}\n${launcher} local-fast watch authorize --repo ${quote(preview.repository)} --issues ${quote(preview.issues.join(','))} --expires ${quote(expires)} --executor ${quote(executable)} --confirm${allowMerge?' --allow-merge':''}`;
}
export function canStart(status,now=Date.now()) {
  return !!status && now-status.observedAt<15000 && now>=status.observedAt && Date.parse(status.expires_at)>now && !['BLOCKED','QUEUE_COMPLETED'].includes(status.status) && !status.watcher_running && !status.stale_lock && !['RUNNING','STOPPING'].includes(status.gui_status);
}
export function canResumeStage(status,now=Date.now()) {
  return !!status&&status.stage_resume_available===true&&now-status.observedAt<15000&&now>=status.observedAt&&Date.parse(status.expires_at)>now&&!status.watcher_running&&!status.stale_lock&&!['RUNNING','STOPPING'].includes(status.gui_status);
}
export function recovery(code) {
  if(/queue_active/.test(code))return '当前队列正在开发或等待 Review。候选队列可以保存；执行队列需完成后再确认下一轮。';
  if(/queue_history/.test(code))return '该 Issue 已有执行历史，或历史记录冲突。保留记录并选择新的 OPEN Issue。';
  if(/expired/.test(code))return 'Owner 授权已到期。由 Owner 按现有 CLI 处理续期；刷新后再启动。';
  if(/scope|owner/.test(code))return '缺少有效的 Windows Owner scope 或与当前绑定不符。核对下方授权步骤，不覆盖旧授权。';
  if(/busy|lock|unavailable/.test(code))return '等待当前操作完成，刷新检查已有 Watcher、锁和完成状态；不要启动第二个 Watcher。';
  if(/permission|identity|github|auth|viewer/.test(code))return '核对本机 gh 登录、交付身份与仓库权限；会话到期时重新进入 V2。';
  if(/binding|preview/.test(code))return '已有队列冲突或 Git 身份变更。重新检查目录，保留旧 binding 与历史。';
  if(/directory/.test(code))return '目录丢失、重定向或超出已批准根目录。恢复原目录或选择已批准的 Git 根目录。';
  return '操作结果未确认。恢复连接后重新检查项目和状态；已有队列与历史保留。';
}
