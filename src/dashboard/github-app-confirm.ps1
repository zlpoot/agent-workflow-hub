param([Parameter(Mandatory=$true)][string]$RequestFile,[Parameter(Mandatory=$true)][string]$ExpectedOwnerSid)
$ErrorActionPreference='Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $ExpectedOwnerSid) { throw 'Windows Owner identity required' }
$appRequest=Get-Content -LiteralPath $RequestFile -Raw -Encoding utf8 | ConvertFrom-Json
if ($appRequest.kind -cne 'github_app_connection' -or $appRequest.facts.repository_selection -cne 'selected') { throw 'Dedicated App connection request required' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$appForm=New-Object Windows.Forms.Form
$appForm.Text='AWH GitHub App 本机 Owner 确认'
$appForm.Size=New-Object Drawing.Size(700,600)
$appForm.StartPosition='CenterScreen'
$appForm.FormBorderStyle='FixedDialog'
$appForm.MaximizeBox=$false
$appForm.MinimizeBox=$false
$appForm.TopMost=$true
$appForm.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$appText=New-Object Windows.Forms.TextBox
$appText.Multiline=$true
$appText.ReadOnly=$true
$appText.ScrollBars='Vertical'
$appText.Location=New-Object Drawing.Point(22,20)
$appText.Size=New-Object Drawing.Size(635,460)
$appText.TabStop=$false
$appRepos=($appRequest.facts.repositories | ForEach-Object {"$($_.full_name) (ID $($_.id))"}) -join "`r`n"
$appText.Text="确认保存以下 GitHub App 本机连接？`r`n`r`nApp：$($appRequest.input.app_slug) (ID $($appRequest.input.app_id))`r`nInstallation：$($appRequest.facts.installation_id)`r`n账号：$($appRequest.facts.account.login) (ID $($appRequest.facts.account.id))`r`nBot：$($appRequest.facts.delivery_actor.login) (ID $($appRequest.facts.delivery_actor.id))`r`nReviewer：$($appRequest.facts.reviewer.login) (ID $($appRequest.facts.reviewer.id))`r`nPEM 本机路径：$($appRequest.input.private_key_path)`r`n权限：Contents write / Pull requests write / Metadata read`r`n`r`n完整 Selected Repository 集合：`r`n$appRepos`r`n`r`n只读检查仓库：$($appRequest.repository)`r`n`r`n本操作只保存本机连接并执行只读检查。不会创建 PR、Push、改变安装范围或授权 Merge。"
$appForm.Controls.Add($appText)
$appSave=New-Object Windows.Forms.Button
$appSave.Text='确认连接并保存'
$appSave.Location=New-Object Drawing.Point(470,495)
$appSave.Size=New-Object Drawing.Size(185,42)
$appSave.DialogResult=[Windows.Forms.DialogResult]::OK
$appForm.Controls.Add($appSave)
$appCancel=New-Object Windows.Forms.Button
$appCancel.Text='取消'
$appCancel.Location=New-Object Drawing.Point(330,495)
$appCancel.Size=New-Object Drawing.Size(120,42)
$appCancel.DialogResult=[Windows.Forms.DialogResult]::Cancel
$appForm.Controls.Add($appCancel)
$appForm.CancelButton=$appCancel
$appForm.AcceptButton=$appCancel
$appForm.ActiveControl=$appCancel
$appForm.Add_Shown({$appForm.Activate();$appForm.BringToFront();$appCancel.Focus() | Out-Null})
$appTimer=New-Object Windows.Forms.Timer
$appTimer.Interval=180000
$appTimer.Add_Tick({$appForm.DialogResult=[Windows.Forms.DialogResult]::Cancel;$appForm.Close()})
$appTimer.Start()
try {$appAnswer=$appForm.ShowDialog();if($appAnswer -eq [Windows.Forms.DialogResult]::OK){'CONFIRMED'}else{'CANCELLED'}}finally{$appTimer.Stop();$appTimer.Dispose();$appForm.Dispose()}
