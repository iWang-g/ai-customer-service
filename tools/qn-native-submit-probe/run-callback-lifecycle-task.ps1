param(
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
if (-not $OutFile) {
  $OutFile = Join-Path $repoRoot '.tmp\qn-native-submit-probe\callback-target-lifecycle.log'
}
$outDirectory = Split-Path -Parent $OutFile
New-Item -ItemType Directory -Path $outDirectory -Force | Out-Null
$temporaryFile = "$OutFile.tmp"
$probe = Join-Path $probeRoot 'build\qn_native_submit_probe.exe'

try {
  $output = @(& $probe --dry-run-callback-target-lifecycle 2>&1 |
    ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
} catch {
  $output = @("ERROR task_exception=$($_.Exception.Message)")
  $exitCode = 100
}

$lines = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "exitCode=$exitCode"
) + $output
[IO.File]::WriteAllLines($temporaryFile, $lines, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $OutFile -Force
exit $exitCode
