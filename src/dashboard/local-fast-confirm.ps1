param([Parameter(Mandatory=$true)][string]$RequestFile,[Parameter(Mandatory=$true)][string]$ExpectedOwnerSid)
$ErrorActionPreference='Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $ExpectedOwnerSid) { throw 'Windows Owner identity required' }
$watchRequest=Get-Content -LiteralPath $RequestFile -Raw -Encoding utf8 | ConvertFrom-Json
if ($watchRequest.kind -cne 'local_fast_watch_scope' -or $watchRequest.scope.source -cne 'windows-owner-confirmation' -or $watchRequest.scope.mode -cne 'local-fast') { throw 'Dedicated Local Fast scope required' }
$watchScope=$watchRequest.scope
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$watchForm=New-Object Windows.Forms.Form
$watchForm.Text='AWH Local Fast Windows Owner 授权'
$watchForm.Size=New-Object Drawing.Size(740,650)
$watchForm.StartPosition='CenterScreen'
$watchForm.FormBorderStyle='FixedDialog'
$watchForm.MaximizeBox=$false
$watchForm.MinimizeBox=$false
$watchForm.TopMost=$true
$watchForm.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$watchText=New-Object Windows.Forms.TextBox
$watchText.Multiline=$true
$watchText.ReadOnly=$true
$watchText.ScrollBars='Vertical'
$watchText.Location=New-Object Drawing.Point(22,20)
$watchText.Size=New-Object Drawing.Size(675,505)
$watchText.TabStop=$false
$watchMerge=if($watchScope.allow_merge){'允许：仅准确 HEAD 的独立 Review PASS 与现有合并门禁通过后'}else{'不允许'}
$watchDelivery=if($watchScope.delivery){'github-app'}else{'personal-gh'}
$watchChecks=$watchScope.checks -join "`r`n"
$watchText.Text="确认授予以下有限 Watcher scope？`r`n`r`n仓库：$($watchScope.repository) (ID $($watchScope.repository_id))`r`n项目：$($watchScope.root)`r`nGitHub Owner：$($watchScope.owner.login) (ID $($watchScope.owner.id))`r`n有序 Issue 队列：$($watchScope.issues -join ' -> ')`r`n队列标识：$($watchScope.queue_id)`r`nUTC 到期时间：$($watchScope.expires_at)`r`nCodex 可执行文件：$($watchScope.executor.executable)`r`n交付身份：$watchDelivery`r`n自动 Merge 并推进：$watchMerge`r`n`r`n定向检查：`r`n$watchChecks`r`n`r`n只保存此仓库、本轮队列的授权，不启动 Watcher。独立 Review 仍由另一个 ChatGPT 会话执行。本窗口不会授予 Reviewer 身份，也不会覆盖已有 scope。"
$watchForm.Controls.Add($watchText)
$watchSave=New-Object Windows.Forms.Button
$watchSave.Text='确认本轮授权'
$watchSave.Location=New-Object Drawing.Point(505,545)
$watchSave.Size=New-Object Drawing.Size(190,42)
$watchSave.DialogResult=[Windows.Forms.DialogResult]::OK
$watchForm.Controls.Add($watchSave)
$watchCancel=New-Object Windows.Forms.Button
$watchCancel.Text='取消'
$watchCancel.Location=New-Object Drawing.Point(355,545)
$watchCancel.Size=New-Object Drawing.Size(120,42)
$watchCancel.DialogResult=[Windows.Forms.DialogResult]::Cancel
$watchForm.Controls.Add($watchCancel)
$watchForm.CancelButton=$watchCancel
$watchForm.AcceptButton=$watchCancel
$watchForm.ActiveControl=$watchCancel
$watchForm.Add_Shown({$watchForm.Activate();$watchForm.BringToFront();$watchCancel.Focus() | Out-Null})
$watchTimer=New-Object Windows.Forms.Timer
$watchTimer.Interval=180000
$watchTimer.Add_Tick({$watchForm.DialogResult=[Windows.Forms.DialogResult]::Cancel;$watchForm.Close()})
$watchTimer.Start()
try {$watchAnswer=$watchForm.ShowDialog();if($watchAnswer -eq [Windows.Forms.DialogResult]::OK){'CONFIRMED'}else{'CANCELLED'}}finally{$watchTimer.Stop();$watchTimer.Dispose();$watchForm.Dispose()}
