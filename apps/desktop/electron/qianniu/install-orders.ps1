param([Parameter(Mandatory=$true)][string]$BundlePath,[Parameter(Mandatory=$true)][string]$BackupDirectory,[string]$VersionDirectory='',[ValidateSet('orders','messages','products','transfer')][string]$ModuleName='orders')
$ErrorActionPreference='Stop'
if (-not $VersionDirectory) {
  $candidates = @(Get-Process -Name AliWorkbench -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.Modules | Where-Object ModuleName -eq 'AppFramework.dll' | ForEach-Object { [IO.Path]::GetDirectoryName($_.FileName) } } catch {}
  } | Sort-Object -Unique)
  if ($candidates.Count -ne 1) { throw 'Cannot identify one running Qianniu version; specify VersionDirectory' }
  $VersionDirectory = $candidates[0]
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath=Join-Path $VersionDirectory 'Resources\newWebui\webui.zip'
$zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $reader=[IO.StreamReader]::new($zip.GetEntry('web_chat-packer/recent.html').Open())
  try {$old=$reader.ReadToEnd()}finally{$reader.Dispose()}
}finally{$zip.Dispose()}
$html=[regex]::Replace($old,"(?s)\s*<!-- qianniu-$ModuleName-start -->.*?<!-- qianniu-$ModuleName-end -->",'')
$script=Get-Content -LiteralPath $BundlePath -Raw -Encoding UTF8
if($script.Contains('</script')){throw 'Invalid script'}
$anchor='<script src="./recent/vendor.js"></script>'
if(-not $html.Contains($anchor)){throw 'Missing insertion point'}
$addition="<!-- qianniu-$ModuleName-start --><script>`n$script`n</script><!-- qianniu-$ModuleName-end -->"
if($old.Contains($addition)){Write-Output 'unchanged';exit 0}
$html=$html.Replace($anchor,$addition+"`n"+$anchor)
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$backup=Join-Path $BackupDirectory ('webui-'+(Get-Date -Format 'yyyyMMdd-HHmmssfff')+'.zip')
Copy-Item -LiteralPath $zipPath -Destination $backup
$staged=Join-Path ([IO.Path]::GetDirectoryName($zipPath)) ('orders-staged-'+[guid]::NewGuid().ToString('N')+'.zip')
Copy-Item -LiteralPath $zipPath -Destination $staged
$zip=[IO.Compression.ZipFile]::Open($staged,[IO.Compression.ZipArchiveMode]::Update)
try {
  $zip.GetEntry('web_chat-packer/recent.html').Delete()
  $entry=$zip.CreateEntry('web_chat-packer/recent.html')
  $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
  try {$writer.Write($html)}finally{$writer.Dispose()}
}finally{$zip.Dispose()}
$localBackup=$staged+'.bak'
[IO.File]::Replace($staged,$zipPath,$localBackup)
Remove-Item -LiteralPath $localBackup
Write-Output 'updated'
