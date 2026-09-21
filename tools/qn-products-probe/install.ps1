param([switch]$Remove, [switch]$Detail)
$ErrorActionPreference='Stop'
$versions=@(Get-Process AliWorkbench -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.Modules | Where-Object ModuleName -eq 'AppFramework.dll' | ForEach-Object { [IO.Path]::GetDirectoryName($_.FileName) } } catch {}
} | Sort-Object -Unique)
if($versions.Count -ne 1){throw 'Cannot identify exactly one running Qianniu version'}
$name=if($Detail){'qn-product-details-probe'}else{'qn-products-probe'}
$data=Join-Path $PSScriptRoot ('../../.tmp/'+$name)
$zipPath=Join-Path $versions[0] 'Resources/newWebui/webui.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $reader=[IO.StreamReader]::new($zip.GetEntry('web_chat-packer/recent.html').Open())
  try {$old=$reader.ReadToEnd()}finally{$reader.Dispose()}
}finally{$zip.Dispose()}
$html=[regex]::Replace($old,('(?s)\s*<!-- '+$name+'-start -->.*?<!-- '+$name+'-end -->'),'')
if(-not $Remove){
  $script=Get-Content -LiteralPath (Join-Path $data 'page.js') -Raw -Encoding UTF8
  if($script.Contains('</script')){throw 'Invalid script'}
  $anchor='<script src="./recent/vendor.js"></script>'
  if(-not $html.Contains($anchor)){throw 'Missing insertion point'}
  $addition="<!-- $name-start --><script>`n$script`n</script><!-- $name-end -->"
  if($old.Contains($addition)){Write-Output 'unchanged';exit 0}
  $html=$html.Replace($anchor,$addition+"`n"+$anchor)
}
$backup=Join-Path $data ('webui-before-'+(Get-Date -Format 'yyyyMMdd-HHmmssfff')+'.zip')
Copy-Item -LiteralPath $zipPath -Destination $backup
$staged=Join-Path ([IO.Path]::GetDirectoryName($zipPath)) ('products-staged-'+[guid]::NewGuid().ToString('N')+'.zip')
Copy-Item -LiteralPath $zipPath -Destination $staged
$zip=[IO.Compression.ZipFile]::Open($staged,[IO.Compression.ZipArchiveMode]::Update)
try {
  $zip.GetEntry('web_chat-packer/recent.html').Delete()
  $entry=$zip.CreateEntry('web_chat-packer/recent.html')
  $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
  try {$writer.Write($html)}finally{$writer.Dispose()}
}finally{$zip.Dispose()}
[IO.File]::Replace($staged,$zipPath,($staged+'.bak'))
Write-Output "Updated $zipPath; backup $backup; page reload required"
