#Requires -Version 7.0
# One-time #21 certificate provisioning; no global trust import or service installation.
param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
try {
  if(-not [IO.Path]::IsPathFullyQualified($Directory)){throw 'Absolute external certificate directory required.'}
  $taskDirectory=[IO.Path]::GetFullPath($Directory)
  for($taskAncestor=$taskDirectory;$taskAncestor;$taskAncestor=[IO.Path]::GetDirectoryName($taskAncestor)){
    if(Test-Path -LiteralPath (Join-Path $taskAncestor '.git')){throw 'Certificate files must remain outside repositories.'}
    if((Test-Path -LiteralPath $taskAncestor) -and ((Get-Item -LiteralPath $taskAncestor).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Redirected certificate paths are prohibited.'}
  }
  if(Test-Path -LiteralPath $taskDirectory){throw 'Use a new directory; existing certificate material is never overwritten.'}
  $null=New-Item -ItemType Directory -Path $taskDirectory
  $taskAccount=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $taskDirectory /inheritance:r /grant:r ($taskAccount+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' *> $null
  if($LASTEXITCODE -ne 0){throw 'Certificate directory ACL setup failed.'}
  $taskNow=Get-Date
  $taskRoot=New-SelfSignedCertificate -Type Custom -Subject 'CN=AWH C1C private LAN CA' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign -CertStoreLocation 'Cert:\CurrentUser\My' -NotBefore $taskNow.AddMinutes(-5) -NotAfter $taskNow.AddYears(3) -TextExtension '2.5.29.19={critical}{hex}30060101ff020100'
  $taskLeaf=New-SelfSignedCertificate -Type Custom -Subject 'CN=AWH Windows C1C Control Plane' -Signer $taskRoot -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -CertStoreLocation 'Cert:\CurrentUser\My' -NotBefore $taskNow.AddMinutes(-5) -NotAfter $taskNow.AddMonths(6) -TextExtension @('2.5.29.19={critical}{hex}3000','2.5.29.17={text}IPAddress=192.168.2.5','2.5.29.37={text}1.3.6.1.5.5.7.3.1')
  $taskCaPath=Join-Path $taskDirectory 'awh-ca.pem'
  $taskCertPath=Join-Path $taskDirectory 'leaf.pem'
  $taskKeyPath=Join-Path $taskDirectory 'leaf-key.pem'
  [IO.File]::WriteAllText($taskCaPath,$taskRoot.ExportCertificatePem())
  [IO.File]::WriteAllText($taskCertPath,$taskLeaf.ExportCertificatePem())
  # Export encrypted PKCS#8 in memory, import into a transient RSA object, write only the private file.
  if(-not ('AwhC1cPrivateExport' -as [type])){Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
public static class AwhC1cPrivateExport {
  public static void WriteLeaf(X509Certificate2 cert, string path) {
    using RSA rsa = cert.GetRSAPrivateKey();
    string password = Guid.NewGuid().ToString("N");
    byte[] encrypted = rsa.ExportEncryptedPkcs8PrivateKey(password, new PbeParameters(PbeEncryptionAlgorithm.Aes256Cbc,HashAlgorithmName.SHA256,100000));
    try { using RSA transient = RSA.Create(); transient.ImportEncryptedPkcs8PrivateKey(password,encrypted,out int consumed); File.WriteAllText(path,transient.ExportPkcs8PrivateKeyPem()); }
    finally { CryptographicOperations.ZeroMemory(encrypted); }
  }
}
'@ }
  [AwhC1cPrivateExport]::WriteLeaf($taskLeaf,$taskKeyPath)
  $taskFingerprint=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskRoot.RawData)).ToLowerInvariant()
  $taskProof=[ordered]@{status='OS_CERTIFICATE_PROVISIONED_NOT_LAN_ACCEPTED';host='192.168.2.5';ca_certificate_file=$taskCaPath;certificate_file=$taskCertPath;private_key_file=$taskKeyPath;ca_sha256_der=$taskFingerprint;leaf_sha256_der=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskLeaf.RawData)).ToLowerInvariant();leaf_expires=$taskLeaf.NotAfter.ToUniversalTime().ToString('o');ca_private_key='NON_EXPORTABLE_WINDOWS_CURRENT_USER_STORE';leaf_private_key_transfer='PROHIBITED'}
  $taskProof | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDirectory 'certificate-proof.json') -Encoding utf8
  [ordered]@{host='192.168.2.5';port=8443;certificate_file=$taskCertPath;private_key_file=$taskKeyPath} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDirectory 'https.json') -Encoding utf8
  $taskProof | ConvertTo-Json
} catch { Write-Error 'OS certificate provisioning failed; inspect permissions and retained private directory locally. Details suppressed.';exit 1 }
