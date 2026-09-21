param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$versions = @(Get-Process AliWorkbench -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.Modules | Where-Object ModuleName -eq 'AppFramework.dll' | ForEach-Object {
    [IO.Path]::GetDirectoryName($_.FileName)
  } } catch {}
} | Sort-Object -Unique)
if ($versions.Count -ne 1) { throw 'Cannot identify exactly one running Qianniu version' }
$data = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.tmp/qn-order-identity-probe'))
$zipPath = Join-Path $versions[0] 'Resources/newWebui/webui.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-EntryHashes($file) {
  $archive = [IO.Compression.ZipFile]::OpenRead($file)
  $hashes = @{}
  try { foreach ($entry in $archive.Entries) {
    $stream = $entry.Open()
    try { $hashes[$entry.FullName] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) }
    finally { $stream.Dispose() }
  } } finally { $archive.Dispose() }
  return $hashes
}
$beforeHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $reader = [IO.StreamReader]::new($archive.GetEntry('web_chat-packer/recent.html').Open())
  try { $old = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally { $archive.Dispose() }
$html = [regex]::Replace($old, '(?s)\s*<!-- qn-order-identity-probe-start -->.*?<!-- qn-order-identity-probe-end -->', '')
if (-not $Remove) {
  $script = Get-Content -LiteralPath (Join-Path $data 'page.js') -Raw -Encoding UTF8
  if ($script -match '</script') { throw 'Invalid inline script' }
  $anchor = '<script src="./recent/vendor.js"></script>'
  if (([regex]::Matches($html, [regex]::Escape($anchor))).Count -ne 1) { throw 'Ambiguous insertion point' }
  $addition = "<!-- qn-order-identity-probe-start --><script>`n$script`n</script><!-- qn-order-identity-probe-end -->"
  if ($old.Contains($addition)) { Write-Output 'unchanged'; exit 0 }
  $html = $html.Replace($anchor, $addition + "`n" + $anchor)
}
$backup = Join-Path $data ('webui-before-' + (Get-Date -Format yyyyMMdd-HHmmssfff) + '.zip')
Copy-Item -LiteralPath $zipPath -Destination $backup
$staged = Join-Path ([IO.Path]::GetDirectoryName($zipPath)) ('identity-staged-' + [guid]::NewGuid().ToString('N') + '.zip')
Copy-Item -LiteralPath $backup -Destination $staged
$archive = [IO.Compression.ZipFile]::Open($staged, [IO.Compression.ZipArchiveMode]::Update)
try {
  $archive.GetEntry('web_chat-packer/recent.html').Delete()
  $entry = $archive.CreateEntry('web_chat-packer/recent.html')
  $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
  try { $writer.Write($html) } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
$before = Get-EntryHashes $backup
$after = Get-EntryHashes $staged
if ($before.Count -ne $after.Count) { throw 'ZIP entry count changed' }
$changed = @($before.Keys | Where-Object { $before[$_] -ne $after[$_] })
if ($changed.Count -ne 1 -or $changed[0] -ne 'web_chat-packer/recent.html') { throw 'Unexpected resource change' }
if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Resources changed during staging' }
[IO.File]::Replace($staged, $zipPath, ($staged + '.bak'))
Write-Output "Installed independent identity probe in $($versions[0]); backup: $backup; page reload required"
