param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$versions = @(Get-Process AliWorkbench -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.Modules | Where-Object ModuleName -eq 'AppFramework.dll' | ForEach-Object { [IO.Path]::GetDirectoryName($_.FileName) } } catch {}
} | Sort-Object -Unique)
if ($versions.Count -ne 1) { throw 'Cannot identify exactly one running Qianniu version' }
$data = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.tmp/qn-staff-probe'))
$zipPath = Join-Path $versions[0] 'Resources/newWebui/webui.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-Entries($file) {
  $zip = [IO.Compression.ZipFile]::OpenRead($file)
  $hashes = @{}
  try {
    foreach ($entry in $zip.Entries) {
      if ($hashes.ContainsKey($entry.FullName)) { throw 'Duplicate ZIP entry' }
      $stream = $entry.Open()
      try { $hashes[$entry.FullName] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) }
      finally { $stream.Dispose() }
    }
  } finally { $zip.Dispose() }
  return $hashes
}
$beforeHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
$zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entry = $zip.GetEntry('web_chat-packer/recent.html')
  if (-not $entry) { throw 'Missing chat entry' }
  $reader = [IO.StreamReader]::new($entry.Open())
  try { $old = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally { $zip.Dispose() }
$name = 'qn-staff-probe'
$html = [regex]::Replace($old, '(?s)\s*<!-- qn-staff-probe-start -->.*?<!-- qn-staff-probe-end -->', '')
if (-not $Remove) {
  $script = Get-Content -LiteralPath (Join-Path $data 'page.js') -Raw -Encoding UTF8
  if ($script -match '</script') { throw 'Invalid inline script' }
  $anchor = '<script src="./recent/vendor.js"></script>'
  if ([regex]::Matches($html, [regex]::Escape($anchor)).Count -ne 1) { throw 'Ambiguous insertion point' }
  $addition = "<!-- $name-start --><script>`n$script`n</script><!-- $name-end -->"
  if ($old.Contains($addition)) { Write-Output 'unchanged'; exit 0 }
  $html = $html.Replace($anchor, $addition + "`n" + $anchor)
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
$backup = Join-Path $data "webui-before-$stamp.zip"
Copy-Item -LiteralPath $zipPath -Destination $backup
$staged = Join-Path ([IO.Path]::GetDirectoryName($zipPath)) ('staff-staged-' + [guid]::NewGuid().ToString('N') + '.zip')
Copy-Item -LiteralPath $backup -Destination $staged
$zip = [IO.Compression.ZipFile]::Open($staged, [IO.Compression.ZipArchiveMode]::Update)
try {
  $zip.GetEntry('web_chat-packer/recent.html').Delete()
  $entry = $zip.CreateEntry('web_chat-packer/recent.html')
  $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
  try { $writer.Write($html) } finally { $writer.Dispose() }
} finally { $zip.Dispose() }
$before = Read-Entries $backup
$after = Read-Entries $staged
if ($before.Count -ne $after.Count) { throw 'ZIP entry count changed' }
$changed = @($before.Keys | Where-Object { $before[$_] -ne $after[$_] })
if ($changed.Count -ne 1 -or $changed[0] -ne 'web_chat-packer/recent.html') { throw 'Unexpected resource change' }
if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Qianniu resources changed while staging' }
[IO.File]::Replace($staged, $zipPath, ($staged + '.bak'))
$audit = @{ versionDirectory = $versions[0]; backup = $backup; changedEntries = $changed; remove = [bool]$Remove;
  beforeSha256 = $beforeHash; afterSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash }
$audit | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $data "install-$stamp.json") -Encoding UTF8
Write-Output "Installed staff probe; only recent.html changed; backup: $backup; page reload required"
