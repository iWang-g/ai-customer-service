$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$requestFile = Join-Path $runDir 'cross-shop-draft-request.json'
$outFile = Join-Path $runDir 'cross-shop-draft.log'
$temporaryFile = "$outFile.tmp"
$probeExe = Join-Path $probeRoot 'build\qn_native_submit_probe.exe'

function Invoke-QnCommand(
    [string]$BridgeBase,
    [string]$ClientId,
    [string]$Cmd,
    [hashtable]$Param = @{}) {
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

function Assert-Context(
    $Result,
    [string]$ShopTargetId,
    [string]$TargetId,
    [string]$Cid,
    [string]$Step) {
  $state = $Result.state
  if ([string]$state.loginID.targetId -ne $ShopTargetId) {
    throw "$Step shop mismatch: $($state.loginID.targetId)"
  }
  if ([string]$state.conversationID.targetId -ne $TargetId) {
    throw "$Step target mismatch: $($state.conversationID.targetId)"
  }
  if ([string]$state.conversationID.ccode -ne $Cid) {
    throw "$Step cid mismatch: $($state.conversationID.ccode)"
  }
}

function Add-ProcessOutput(
    [Collections.Generic.List[string]]$Lines,
    [string]$Prefix,
    [string]$StdoutFile,
    [string]$StderrFile) {
  foreach ($line in Get-Content -LiteralPath $StdoutFile -ErrorAction SilentlyContinue) {
    $Lines.Add("$Prefix $line")
  }
  foreach ($line in Get-Content -LiteralPath $StderrFile -ErrorAction SilentlyContinue) {
    $Lines.Add("$Prefix $line")
  }
}

function Invoke-SuppressedOpenChat(
    $Request,
    [string]$Label,
    [string]$ClientId,
    [string]$ShopTargetId,
    [string]$TargetId,
    [string]$Cid,
    [Collections.Generic.List[string]]$Lines) {
  $stdoutFile = Join-Path $runDir "$Label-cbt.stdout.log"
  $stderrFile = Join-Path $runDir "$Label-cbt.stderr.log"
  Remove-Item -LiteralPath $stdoutFile, $stderrFile `
    -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $probeExe `
    -ArgumentList @('--suppress-cbt-minimized', '3500') `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile `
    -PassThru -WindowStyle Hidden
  [void]$process.Handle
  try {
    Start-Sleep -Milliseconds 600
    if ($process.HasExited) {
      throw "$Label CBT probe exited before openChat: $($process.ExitCode)"
    }
    $open = Invoke-QnCommand $Request.bridgeBase $ClientId 'openChat' @{
      targetId = $TargetId
      bizDomain = 'taobao'
    }
    Assert-Context $open $ShopTargetId $TargetId $Cid "$Label openChat"
    $Lines.Add("$Label openChat=ok")
    $process.WaitForExit()
    $process.WaitForExit()
    $process.Refresh()
    $processExitCode = [int]$process.ExitCode
    Add-ProcessOutput $Lines $Label $stdoutFile $stderrFile
    if ($processExitCode -ne 0) {
      throw "$Label CBT probe failed: $processExitCode"
    }
  } finally {
    if (-not $process.HasExited) {
      $process.Kill()
      $process.WaitForExit()
    }
  }

  $reconcile = @(& $probeExe --reconcile-minimized `
    --confirm QN_NATIVE_RECONCILE_MINIMIZED_ONCE 2>&1 |
    ForEach-Object { $_.ToString() })
  $reconcileCode = $LASTEXITCODE
  foreach ($line in $reconcile) { $Lines.Add("$Label reconcile $line") }
  if ($reconcileCode -ne 0) {
    throw "$Label minimized-state reconcile failed: $reconcileCode"
  }
}

New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$lines = [Collections.Generic.List[string]]::new()
$watcher = $null
$exitCode = 100
try {
  $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 |
    ConvertFrom-Json
  foreach ($required in @(
      'bridgeBase', 'sourceClientId', 'sourceShopTargetId',
      'sourceTargetId', 'sourceCid', 'targetClientId',
      'targetShopTargetId', 'targetTargetId', 'targetCid', 'text', 'nonce')) {
    if (-not [string]$request.$required) {
      throw "Missing request field: $required"
    }
  }
  if (-not $request.requireMinimized -or -not $request.useFocusChain) {
    throw 'Cross-shop draft probe requires both safety flags.'
  }

  $source = Invoke-QnCommand `
    $request.bridgeBase $request.sourceClientId 'getActiveUser'
  Assert-Context $source $request.sourceShopTargetId `
    $request.sourceTargetId $request.sourceCid 'source getActiveUser'
  $sourceEmpty = Invoke-QnCommand `
    $request.bridgeBase $request.sourceClientId 'isInputboxEmpty'
  Assert-Context $sourceEmpty $request.sourceShopTargetId `
    $request.sourceTargetId $request.sourceCid 'source isInputboxEmpty'
  if (-not $sourceEmpty.value.isEmpty) {
    throw 'Source input box is not empty.'
  }

  $watchStdout = Join-Path $runDir 'cross-shop-watch.stdout.log'
  $watchStderr = Join-Path $runDir 'cross-shop-watch.stderr.log'
  Remove-Item -LiteralPath $watchStdout, $watchStderr `
    -Force -ErrorAction SilentlyContinue
  $watcher = Start-Process -FilePath $probeExe `
    -ArgumentList @('--watch-window-state', '20000') `
    -RedirectStandardOutput $watchStdout `
    -RedirectStandardError $watchStderr `
    -PassThru -WindowStyle Hidden
  [void]$watcher.Handle
  Start-Sleep -Milliseconds 300

  Invoke-SuppressedOpenChat $request 'source' $request.sourceClientId `
    $request.sourceShopTargetId $request.sourceTargetId $request.sourceCid $lines
  Invoke-SuppressedOpenChat $request 'target' $request.targetClientId `
    $request.targetShopTargetId $request.targetTargetId $request.targetCid $lines

  $target = Invoke-QnCommand `
    $request.bridgeBase $request.targetClientId 'getActiveUser'
  Assert-Context $target $request.targetShopTargetId `
    $request.targetTargetId $request.targetCid 'target getActiveUser'
  if ([string]$target.value.securityUID -ne [string]$request.targetTargetId -or
      [string]$target.value.cid -ne [string]$request.targetCid) {
    throw 'Target getActiveUser identity mismatch.'
  }
  $targetEmpty = Invoke-QnCommand `
    $request.bridgeBase $request.targetClientId 'isInputboxEmpty'
  Assert-Context $targetEmpty $request.targetShopTargetId `
    $request.targetTargetId $request.targetCid 'target isInputboxEmpty(before)'
  if (-not $targetEmpty.value.isEmpty) {
    throw 'Target input box is not empty; refusing to overwrite it.'
  }

  $write = @(& $probeExe --write-draft-focus-chain-minimized `
    --text ([string]$request.text) `
    --confirm QN_NATIVE_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE 2>&1 |
    ForEach-Object { $_.ToString() })
  $writeCode = $LASTEXITCODE
  foreach ($line in $write) { $lines.Add("write $line") }
  if ($writeCode -ne 0) { throw "Focus-chain draft write failed: $writeCode" }

  $notEmpty = Invoke-QnCommand `
    $request.bridgeBase $request.targetClientId 'isInputboxEmpty'
  Assert-Context $notEmpty $request.targetShopTargetId `
    $request.targetTargetId $request.targetCid 'target isInputboxEmpty(after write)'
  if ($notEmpty.value.isEmpty) {
    throw 'Target draft write was not visible through the bridge.'
  }

  $clear = @(& $probeExe --clear-draft-focus-chain-minimized `
    --confirm QN_NATIVE_CLEAR_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE 2>&1 |
    ForEach-Object { $_.ToString() })
  $clearCode = $LASTEXITCODE
  foreach ($line in $clear) { $lines.Add("clear $line") }
  if ($clearCode -ne 0) { throw "Focus-chain draft clear failed: $clearCode" }

  $emptyAfter = Invoke-QnCommand `
    $request.bridgeBase $request.targetClientId 'isInputboxEmpty'
  Assert-Context $emptyAfter $request.targetShopTargetId `
    $request.targetTargetId $request.targetCid 'target isInputboxEmpty(after clear)'
  if (-not $emptyAfter.value.isEmpty) {
    throw 'Target input box remained non-empty after cleanup.'
  }

  $watcher.WaitForExit()
  $watcher.WaitForExit()
  $watcher.Refresh()
  $watcherExitCode = [int]$watcher.ExitCode
  Add-ProcessOutput $lines 'watch' $watchStdout $watchStderr
  if ($watcherExitCode -ne 0) {
    throw "Window watcher failed: $watcherExitCode"
  }
  if (($lines -join "`n") -notmatch 'everNotMinimized=0 everForeground=0') {
    throw 'Window watcher observed restore or foreground activation.'
  }
  $lines.Add("result=cross_shop_draft_roundtrip_ok no_submit=1 nonce=$($request.nonce)")
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
