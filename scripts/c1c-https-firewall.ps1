#Requires -RunAsAdministrator
# Narrow one-time LAN firewall setup only. Does not start or install any service.
param([Parameter(Mandatory=$true)][string]$NodeExecutable,[Parameter(Mandatory=$true)][string]$ProofPath)
$ErrorActionPreference='Stop'
$taskHostIP='192.168.2.5';$taskMacIP='192.168.2.3'
if(-not [IO.Path]::IsPathFullyQualified($NodeExecutable) -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)){throw 'Explicit Node executable required.'}
$taskNode=[IO.Path]::GetFullPath($NodeExecutable)
if(-not [IO.Path]::IsPathFullyQualified($ProofPath) -or -not (Test-Path -LiteralPath (Split-Path $ProofPath) -PathType Container)){throw 'Existing external proof directory required.'}
for($taskAncestor=Split-Path $ProofPath;$taskAncestor;$taskAncestor=[IO.Path]::GetDirectoryName($taskAncestor)){if(Test-Path -LiteralPath (Join-Path $taskAncestor '.git')){throw 'Firewall proof must be external.'}}
$taskAddress=Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $taskHostIP
if(@($taskAddress).Count -ne 1){throw 'Expected Windows LAN interface is absent or ambiguous.'}
$taskNetwork=Get-NetConnectionProfile -InterfaceIndex $taskAddress.InterfaceIndex
if(@($taskNetwork).Count -ne 1){throw 'Expected exactly one LAN interface profile.'}
if(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object {-not $_.Enabled}){throw 'All effective Windows Firewall profiles must be enabled.'}
if(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object {$_.AllowLocalFirewallRules -eq 'False'}){throw 'Local rule merge is disabled by policy; stop for administrator inspection.'}
# Blocks override unrelated broad allow rules. Restrict this chosen LAN IP/port on all profiles.
$taskRules=@('AWH-C1C-HTTPS-Mac','AWH-C1C-HTTPS-Other-IPv4')
foreach($taskName in $taskRules){
  $taskExisting=Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue
  if($taskExisting -and $taskExisting.Group -ne 'AWH C1C HTTPS'){throw 'Unmanaged conflicting rule name; refusing replacement.'}
  $taskExisting | Remove-NetFirewallRule | Out-Null
}
New-NetFirewallRule -Name $taskRules[1] -DisplayName 'AWH C1C HTTPS block non-Mac IPv4' -Group 'AWH C1C HTTPS' -Direction Inbound -Action Block -Enabled True -Profile Any -Protocol TCP -LocalAddress $taskHostIP -LocalPort 8443 -RemoteAddress '0.0.0.0-192.168.2.2','192.168.2.4-255.255.255.255' | Out-Null
New-NetFirewallRule -Name $taskRules[0] -DisplayName 'AWH C1C HTTPS Mac only' -Group 'AWH C1C HTTPS' -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalAddress $taskHostIP -LocalPort 8443 -RemoteAddress $taskMacIP -Program $taskNode | Out-Null
$taskEffective=@()
foreach($taskName in $taskRules){
  $taskRule=Get-NetFirewallRule -PolicyStore ActiveStore -Name $taskName
  $taskPort=$taskRule | Get-NetFirewallPortFilter;$taskScope=$taskRule | Get-NetFirewallAddressFilter;$taskProgram=$taskRule | Get-NetFirewallApplicationFilter
  if($taskRule.Enabled -ne 'True' -or $taskRule.Direction -ne 'Inbound' -or $taskPort.Protocol -notin @('TCP','6') -or $taskPort.LocalPort -ne '8443' -or $taskScope.LocalAddress -ne $taskHostIP){throw 'Effective rule differs; do not start HTTPS.'}
  if($taskName -eq $taskRules[0]){
    if($taskRule.Action -ne 'Allow' -or $taskScope.RemoteAddress -ne $taskMacIP -or $taskProgram.Program -ne $taskNode -or $taskRule.Profile -ne 'Any'){throw 'Effective Mac allow scope differs; do not start HTTPS.'}
  }else{
    if($taskRule.Action -ne 'Block' -or $taskRule.Profile -ne 'Any' -or $taskProgram.Program -ne 'Any' -or (($taskScope.RemoteAddress | Sort-Object) -join ',') -ne '0.0.0.0-192.168.2.2,192.168.2.4-255.255.255.255'){throw 'Effective block complement differs; do not start HTTPS.'}
  }
  $taskEffective+=[ordered]@{name=$taskName;action=$taskRule.Action.ToString();profile=$taskRule.Profile.ToString();local_address=$taskScope.LocalAddress;remote_address=$taskScope.RemoteAddress;local_port=$taskPort.LocalPort;program=$taskProgram.Program}
}
$taskProof=[ordered]@{status='EFFECTIVE_FIREWALL_SCOPE_VERIFIED_NOT_MAC_CONNECTED';at=[DateTime]::UtcNow.ToString('o');host=$taskHostIP;port=8443;allowed_client=$taskMacIP;node=$taskNode;network_profile=$taskNetwork.NetworkCategory.ToString();effective_rules=$taskEffective;unrelated_broad_allows='OVERRIDDEN_BY_EXPLICIT_NON_MAC_BLOCK';plaintext_lan_http='PROHIBITED'}
$taskProof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ProofPath -Encoding utf8
$taskProof | ConvertTo-Json -Depth 8
