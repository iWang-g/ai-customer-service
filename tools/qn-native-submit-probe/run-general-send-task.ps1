$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$requestFile = Join-Path $runDir 'general-send-request.json'
$resultFile = Join-Path $runDir 'general-send-result.log'
$temporaryFile = "$resultFile.tmp"
$probe = Join-Path $probeRoot 'build\qn_direct_general_probe_v3.exe'

$lines = [Collections.Generic.List[string]]::new()
$exitCode = 100
try {
  $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$request.requestId -notmatch '^CodexDirect-[0-9]+-[0-9]+$') { throw 'invalid requestId' }
  if ([string]$request.shopUid -notmatch '^\d+$') { throw 'invalid shopUid' }
  if ([string]$request.cid -notmatch '^\d+\.1-\d+\.1#11001@cntaobao$') { throw 'invalid cid' }
  $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
  if ([string]$request.text -eq '' -or $strictUtf8.GetByteCount([string]$request.text) -gt 4095 -or
      [string]$request.text -match '[\x00\r]') {
    throw 'invalid text'
  }
  $output = @(& $probe '--send-once' 'QN_DIRECT_SEND_ONCE' ([string]$request.shopUid) ([string]$request.cid) ([string]$request.text) 2>&1 |
    ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) { $lines.Add($line) }
} catch {
  $lines.Add("OUTCOME task_exception unknown retry=0 message=$($_.Exception.Message)")
}

$header = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "pid=$PID"
  "exitCode=$exitCode"
)
[IO.File]::WriteAllLines($temporaryFile, $header + $lines.ToArray(), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $resultFile -Force
exit $exitCode
