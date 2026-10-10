param([Parameter(Mandatory=$true)][string]$RequestFile,[Parameter(Mandatory=$true)][string]$ExpectedOwnerSid)
$ErrorActionPreference='Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $ExpectedOwnerSid) { throw 'CP owner identity required' }
$taskRequest=Get-Content -LiteralPath $RequestFile -Raw -Encoding utf8 | ConvertFrom-Json
if ($taskRequest.kind -ne 'enrollment_request') { throw 'Expected dedicated enrollment request' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$taskForm=New-Object Windows.Forms.Form
$taskForm.Text='AWH 管理员批准接入'
$taskForm.Size=New-Object Drawing.Size(650,430)
$taskForm.StartPosition='CenterScreen'
$taskForm.FormBorderStyle='FixedDialog'
$taskForm.MaximizeBox=$false
$taskForm.MinimizeBox=$false
$taskForm.TopMost=$true
$taskForm.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
$taskText=New-Object Windows.Forms.TextBox
$taskText.Multiline=$true
$taskText.ReadOnly=$true
$taskText.ScrollBars='Vertical'
$taskText.BorderStyle='None'
$taskText.BackColor=$taskForm.BackColor
$taskText.Location=New-Object Drawing.Point(22,20)
$taskText.Size=New-Object Drawing.Size(590,290)
$taskText.TabStop=$false
$taskMode=if($taskRequest.mode -eq 'observe'){'仅观察'}else{'受信开发准备（仍需既有任务批准）'}
$taskText.Text="确认批准这个项目接入 AWH？`r`n`r`n仓库：$($taskRequest.repository)`r`n分支：$($taskRequest.branch)`r`n模式：$taskMode`r`n机器：$($taskRequest.machine.id)`r`n执行器：$($taskRequest.executor_id)`r`n`r`n只新增此项目 / 执行器的专用登记和心跳授权。`r`n保留已有项目身份；不授权开发任务、GitHub 写入或 Deliver。`r`n批准后浏览器将继续完成接入。"
$taskForm.Controls.Add($taskText)
$taskApprove=New-Object Windows.Forms.Button
$taskApprove.Text='批准并接入'
$taskApprove.Location=New-Object Drawing.Point(435,325)
$taskApprove.Size=New-Object Drawing.Size(160,42)
$taskApprove.DialogResult=[Windows.Forms.DialogResult]::OK
$taskForm.Controls.Add($taskApprove)
$taskCancel=New-Object Windows.Forms.Button
$taskCancel.Text='取消'
$taskCancel.Location=New-Object Drawing.Point(300,325)
$taskCancel.Size=New-Object Drawing.Size(120,42)
$taskCancel.DialogResult=[Windows.Forms.DialogResult]::Cancel
$taskForm.Controls.Add($taskCancel)
$taskForm.CancelButton=$taskCancel
$taskForm.AcceptButton=$taskCancel
$taskForm.ActiveControl=$taskCancel
$taskForm.Add_Shown({$taskForm.Activate();$taskForm.BringToFront();$taskCancel.Focus() | Out-Null})
$taskTimer=New-Object Windows.Forms.Timer
$taskTimer.Interval=180000
$taskTimer.Add_Tick({$taskForm.DialogResult=[Windows.Forms.DialogResult]::Cancel;$taskForm.Close()})
$taskTimer.Start()
try {$taskAnswer=$taskForm.ShowDialog();if($taskAnswer -eq [Windows.Forms.DialogResult]::OK){'CONFIRMED'}else{'CANCELLED'}}finally{$taskTimer.Stop();$taskTimer.Dispose();$taskForm.Dispose()}
