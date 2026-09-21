$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$requestFile = Join-Path $runDir 'general-preflight-request.json'
$resultFile = Join-Path $runDir 'general-preflight-result.log'
$probe = Join-Path $probeRoot 'build\qn_direct_general_probe_v3.exe'

$request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$request.shopUid -notmatch '^\d+$') { throw 'invalid shopUid' }
$output = @(& $probe '--preflight' ([string]$request.shopUid) 2>&1 | ForEach-Object { $_.ToString() })
$header = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "pid=$PID"
)
[IO.File]::WriteAllLines($resultFile, $header + $output, [Text.UTF8Encoding]::new($false))
