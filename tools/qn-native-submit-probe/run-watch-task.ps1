param(
  [ValidateRange(100, 30000)]
  [int]$DurationMs = 8000
)

$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$readyFile = Join-Path $runDir 'watch.ready'
$outFile = Join-Path $runDir 'watch.log'
$temporaryFile = "$outFile.tmp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
Remove-Item -LiteralPath $readyFile, $outFile, $temporaryFile -Force -ErrorAction SilentlyContinue

$exitCode = 100
$output = @()
try {
  [IO.File]::WriteAllText(
    $readyFile,
    [DateTimeOffset]::Now.ToString('o'),
    [Text.UTF8Encoding]::new($false))
  $output = @(& (Join-Path $probeRoot 'build\qn_native_submit_probe.exe') `
    --watch-window-state $DurationMs 2>&1 | ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
} catch {
  $output = @("ERROR task_exception=$($_.Exception.Message)")
}

$header = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "exitCode=$exitCode"
)
[IO.File]::WriteAllLines(
  $temporaryFile,
  $header + $output,
  [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $outFile -Force
exit $exitCode
