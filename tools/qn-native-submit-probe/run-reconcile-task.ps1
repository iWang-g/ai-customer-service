$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$outFile = Join-Path $runDir 'reconcile.log'
$temporaryFile = "$outFile.tmp"

New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$output = @(& (Join-Path $probeRoot 'build\qn_native_submit_probe.exe') `
  --reconcile-minimized `
  --confirm QN_NATIVE_RECONCILE_MINIMIZED_ONCE 2>&1 |
  ForEach-Object { $_.ToString() })
$exitCode = $LASTEXITCODE
$lines = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "exitCode=$exitCode"
) + $output
[IO.File]::WriteAllLines(
  $temporaryFile,
  $lines,
  [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $outFile -Force
exit $exitCode
