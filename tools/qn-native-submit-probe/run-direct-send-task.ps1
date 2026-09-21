$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$requestFile = Join-Path $runDir 'direct-send-request.json'
$outFile = Join-Path $runDir 'direct-send.log'
$temporaryFile = "$outFile.tmp"
$probeExe = Join-Path $probeRoot 'build\qn_native_submit_probe.exe'

function Get-AppendedText([string]$Path, [long]$Offset) {
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite)
  try {
    if ($stream.Length -le $Offset) { return '' }
    [void]$stream.Seek($Offset, [IO.SeekOrigin]::Begin)
    $length = [int]($stream.Length - $Offset)
    $buffer = [byte[]]::new($length)
    $read = 0
    while ($read -lt $length) {
      $count = $stream.Read($buffer, $read, $length - $read)
      if ($count -eq 0) { break }
      $read += $count
    }
    return [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  } finally {
    $stream.Dispose()
  }
}

function Add-ProcessOutput(
    [Collections.Generic.List[string]]$Lines,
    [string]$Prefix,
    [string]$Path) {
  foreach ($line in Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue) {
    $Lines.Add("$Prefix $line")
  }
}

New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$lines = [Collections.Generic.List[string]]::new()
$watcher = $null
$exitCode = 100
try {
  if (-not (Test-Path -LiteralPath $probeExe)) {
    throw "Missing probe executable: $probeExe"
  }
  $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 |
    ConvertFrom-Json
  foreach ($required in @(
      'targetId', 'cid', 'text', 'appLog', 'nonce', 'confirmation')) {
    if (-not [string]$request.$required) {
      throw "Missing request field: $required"
    }
  }
  if (-not $request.requireMinimized -or
      $request.confirmation -ne 'QN_DIRECT_SEND_TEXT_ONCE') {
    throw 'Direct-send safety confirmation is invalid.'
  }
  if ([string]$request.targetId -notmatch '^3#[0-9]+$') {
    throw 'targetId must have the form 3#<digits>.'
  }
  if ([string]$request.cid -notmatch '^[0-9.\-#@a-z]+#11001@cntaobao$') {
    throw 'cid has an invalid shape.'
  }
  if ([string]$request.text -match '[\r\n]' -or
      [string]$request.text -eq '' -or
      ([string]$request.text).Length -ge 1024) {
    throw 'text must be one non-empty line under 1024 characters.'
  }
  if (-not (Test-Path -LiteralPath $request.appLog)) {
    throw "Missing app log: $($request.appLog)"
  }

  $watchStdout = Join-Path $runDir 'direct-send-watch.stdout.log'
  $watchStderr = Join-Path $runDir 'direct-send-watch.stderr.log'
  Remove-Item -LiteralPath $watchStdout, $watchStderr `
    -Force -ErrorAction SilentlyContinue
  $watcher = Start-Process -FilePath $probeExe `
    -ArgumentList @('--watch-window-state', '20000') `
    -RedirectStandardOutput $watchStdout `
    -RedirectStandardError $watchStderr `
    -PassThru -WindowStyle Hidden
  [void]$watcher.Handle
  Start-Sleep -Milliseconds 300
  if ($watcher.HasExited) {
    throw "Window watcher exited before direct send: $($watcher.ExitCode)"
  }

  $appLogOffset = (Get-Item -LiteralPath $request.appLog).Length
  $probeOutput = @(& $probeExe `
    --send-text-direct-minimized `
    --target-id ([string]$request.targetId) `
    --cid ([string]$request.cid) `
    --text ([string]$request.text) `
    --confirm QN_DIRECT_SEND_TEXT_ONCE 2>&1 |
    ForEach-Object { $_.ToString() })
  $probeExitCode = $LASTEXITCODE
  foreach ($line in $probeOutput) { $lines.Add("probe $line") }
  if ($probeExitCode -ne 0) {
    throw "Direct-send probe failed: $probeExitCode"
  }
  if (($probeOutput -join "`n") -notmatch
      'result=direct_send_text_invoked_once receipt_pending=1') {
    throw 'Probe did not report exactly one pending direct-send invocation.'
  }

  $receipt = $null
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $appended = Get-AppendedText $request.appLog $appLogOffset
    foreach ($line in @($appended -split "`r?`n")) {
      if ($line.Contains('onMsgSendUpdate') -and
          $line.Contains([string]$request.cid) -and
          $line.Contains([string]$request.text) -and
          $line.Contains('"sendStatus":0') -and
          $line.Contains('"progress":100')) {
        $receipt = [pscustomobject]@{
          messageId = [regex]::Match(
            $line, '"messageId":"([^"]+)"').Groups[1].Value
          clientId = [regex]::Match(
            $line, '"clientId":"([^"]+)"').Groups[1].Value
        }
        break
      }
    }
    if ($null -eq $receipt) { Start-Sleep -Milliseconds 100 }
  } while ($null -eq $receipt -and (Get-Date) -lt $deadline)
  if ($null -eq $receipt) {
    throw 'No matching sendStatus=0, progress=100 receipt was observed.'
  }
  $lines.Add(
    "receipt sendStatus=0 progress=100 messageId=$($receipt.messageId) clientId=$($receipt.clientId)")

  $watcher.WaitForExit()
  $watcher.WaitForExit()
  $watcher.Refresh()
  $watcherExitCode = [int]$watcher.ExitCode
  Add-ProcessOutput $lines 'watch' $watchStdout
  Add-ProcessOutput $lines 'watch' $watchStderr
  if ($watcherExitCode -ne 0) {
    throw "Window watcher failed: $watcherExitCode"
  }
  if (($lines -join "`n") -notmatch
      'everNotMinimized=0 everForeground=0') {
    throw 'Window watcher observed restore or foreground activation.'
  }

  $lines.Add(
    "result=direct_send_ok targetId=$($request.targetId) cid=$($request.cid) nonce=$($request.nonce)")
  $exitCode = 0
} catch {
  $lines.Add("ERROR task_exception=$($_.Exception.Message)")
  if ($null -ne $watcher -and -not $watcher.HasExited) {
    $watcher.Kill()
    $watcher.WaitForExit()
  }
}

$header = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "exitCode=$exitCode"
)
[IO.File]::WriteAllLines(
  $temporaryFile,
  $header + $lines.ToArray(),
  [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $outFile -Force
exit $exitCode
