param([switch]$Remove)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = 'D:\qianniu\9.97.80N\Resources\newWebui\webui.zip'
$outputDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\.tmp\qn-media-probe'))
$bundle = Join-Path $outputDir 'bundle.js'
if (-not $Remove -and -not (Test-Path -LiteralPath $bundle)) { throw 'Run server.cjs --prepare first' }
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entry = $archive.GetEntry('web_chat-packer/recent.html')
  if (-not $entry) { throw 'recent.html missing' }
  $reader = [IO.StreamReader]::new($entry.Open())
  try { $html = $reader.ReadToEnd() } finally { $reader.Dispose() }
} finally { $archive.Dispose() }
$html = [regex]::Replace($html, '(?s)\s*<!-- qn-media-probe-start -->.*?<!-- qn-media-probe-end -->', '')
if (-not $Remove) {
  $anchor = '<script src="./recent/vendor.js"></script>'
  if (-not $html.Contains($anchor)) { throw 'Insertion anchor missing' }
  $script = Get-Content -LiteralPath $bundle -Raw -Encoding UTF8
  if ($script -match '</script') { throw 'Unexpected script closing tag' }
  $html = $html.Replace($anchor, "<!-- qn-media-probe-start --><script>`n$script`n</script><!-- qn-media-probe-end -->`n$anchor")
}
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$backup = Join-Path $outputDir ('webui-before-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.zip')
Copy-Item -LiteralPath $zipPath -Destination $backup
$staged = Join-Path $outputDir ('webui-staged-' + [guid]::NewGuid().ToString('N') + '.zip')
Copy-Item -LiteralPath $zipPath -Destination $staged
$archive = [IO.Compression.ZipFile]::Open($staged, [IO.Compression.ZipArchiveMode]::Update)
try {
  $archive.GetEntry('web_chat-packer/recent.html').Delete()
  $entry = $archive.CreateEntry('web_chat-packer/recent.html')
  $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
  try { $writer.Write($html) } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
[IO.File]::Replace($staged, $zipPath, $backup)
Write-Output "Backup: $backup"
Write-Output 'Only the independent media probe block was changed. Page reload required.'
