$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$resultFile = Join-Path $runDir 'list-windows-result.log'
$temporaryFile = "$resultFile.tmp"
$script = Join-Path $repoRoot 'tools\qn-list-windows.ps1'

$lines = [Collections.Generic.List[string]]::new()
$lines.Add("timestamp=$([DateTimeOffset]::Now.ToString('o'))")
$lines.Add("sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)")
$lines.Add("user=$([Environment]::UserDomainName)\$([Environment]::UserName)")
$lines.Add("pid=$PID")
try {
  $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script 2>&1 | ForEach-Object { $_.ToString() })
  foreach ($line in $output) { $lines.Add($line) }
} catch {
  $lines.Add("ERROR $($_.Exception.Message)")
}
[IO.File]::WriteAllLines($temporaryFile, $lines.ToArray(), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $resultFile -Force
