$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$requestFile = Join-Path $runDir 'cbt-request.json'
$outFile = Join-Path $runDir 'cbt-openchat.log'
$temporaryFile = "$outFile.tmp"

function Invoke-QnCommand(
    [string]$BridgeBase,
    [string]$ClientId,
    [string]$Cmd,
    [hashtable]$Param) {
  $body = @{ clientId = $ClientId; cmd = $Cmd; param = $Param } |
    ConvertTo-Json -Depth 8
  $deadline = (Get-Date).AddSeconds(12)
  $queued = $null
  do {
    try {
      $queued = Invoke-RestMethod -Method Post -Uri "$BridgeBase/command" `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
      break
    } catch {
      $statusCode = [int]$_.Exception.Response.StatusCode
      if ($statusCode -ne 409 -or (Get-Date) -ge $deadline) {
        throw
      }
      Start-Sleep -Milliseconds 100
    }
  } while ((Get-Date) -lt $deadline)
  if ($null -eq $queued) {
    throw "$Cmd could not be queued before timeout."
  }
  do {
    Start-Sleep -Milliseconds 100
    $result = (Invoke-RestMethod `
      -Uri "$BridgeBase/results?commandId=$($queued.command.id)").result
    if ($null -ne $result) {
      if (-not $result.ok) {
        throw "$Cmd failed: $($result.value | ConvertTo-Json -Compress -Depth 8)"
      }
      return $result
    }
  } while ((Get-Date) -lt $deadline)
  throw "$Cmd timed out."
}

function Assert-Context($Result, $Request, [string]$Step) {
  $state = $Result.state
  if ([string]$state.loginID.targetId -ne [string]$Request.expectedShopTargetId) {
    throw "$Step shop mismatch: $($state.loginID.targetId)"
  }
  if ([string]$state.conversationID.targetId -ne [string]$Request.expectedTargetId) {
    throw "$Step target mismatch: $($state.conversationID.targetId)"
  }
  if ([string]$state.conversationID.ccode -ne [string]$Request.expectedCid) {
    throw "$Step cid mismatch: $($state.conversationID.ccode)"
  }
}

New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$lines = [Collections.Generic.List[string]]::new()
$process = $null
$exitCode = 100
try {
  $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 |
    ConvertFrom-Json
  foreach ($required in @(
      'bridgeBase', 'clientId', 'expectedShopTargetId',
      'expectedTargetId', 'expectedCid', 'nonce')) {
    if (-not [string]$request.$required) {
      throw "Missing request field: $required"
    }
  }
  if (-not $request.suppress -or -not $request.requireMinimized) {
    throw 'CBT openChat probe requires suppress=true and requireMinimized=true.'
  }

  $active = Invoke-QnCommand `
    $request.bridgeBase $request.clientId 'getActiveUser' @{}
  Assert-Context $active $request 'getActiveUser(before)'
  $empty = Invoke-QnCommand `
    $request.bridgeBase $request.clientId 'isInputboxEmpty' @{}
  Assert-Context $empty $request 'isInputboxEmpty(before)'
  if (-not $empty.value.isEmpty) {
    throw 'Input box is not empty; refusing CBT openChat probe.'
  }

  $stdoutFile = Join-Path $runDir 'cbt-openchat.stdout.log'
  $stderrFile = Join-Path $runDir 'cbt-openchat.stderr.log'
  Remove-Item -LiteralPath $stdoutFile, $stderrFile `
    -Force -ErrorAction SilentlyContinue
  $process = Start-Process `
    -FilePath (Join-Path $probeRoot 'build\qn_native_submit_probe.exe') `
    -ArgumentList @('--suppress-cbt-minimized', '10000') `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile `
    -PassThru `
    -WindowStyle Hidden
  Start-Sleep -Milliseconds 1000
  if ($process.HasExited) {
    throw "CBT probe exited before openChat with code $($process.ExitCode)."
  }

  $open = Invoke-QnCommand `
    $request.bridgeBase $request.clientId 'openChat' `
    @{ targetId = [string]$request.expectedTargetId; bizDomain = 'taobao' }
  Assert-Context $open $request 'openChat'
  $lines.Add("openChat=ok nonce=$($request.nonce)")

  $process.WaitForExit()
  $process.Refresh()
  $exitCode = [int]$process.ExitCode
  foreach ($line in Get-Content -LiteralPath $stdoutFile -ErrorAction SilentlyContinue) {
    $lines.Add($line)
  }
  foreach ($line in Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue) {
    $lines.Add($line)
  }
} catch {
  $lines.Add("ERROR task_exception=$($_.Exception.Message)")
  if ($null -ne $process -and -not $process.HasExited) {
    $process.Kill()
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
