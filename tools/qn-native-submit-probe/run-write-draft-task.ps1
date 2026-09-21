$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$requestFile = Join-Path $runDir 'draft-request.json'
$outFile = Join-Path $runDir 'draft.log'
$temporaryFile = "$outFile.tmp"

function Invoke-QnCommand([string]$BridgeBase, [string]$ClientId, [string]$Cmd) {
  $body = @{ clientId = $ClientId; cmd = $Cmd; param = @{} } |
    ConvertTo-Json -Depth 6
  $deadline = (Get-Date).AddSeconds(12)
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
    $result = (Invoke-RestMethod -Uri "$BridgeBase/results?commandId=$($queued.command.id)").result
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
$exitCode = 100
try {
  if (-not (Test-Path -LiteralPath $requestFile)) {
    throw "Missing request file: $requestFile"
  }
  $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 |
    ConvertFrom-Json
  foreach ($required in @(
      'bridgeBase', 'clientId', 'expectedShopTargetId',
      'expectedTargetId', 'expectedCid', 'text', 'nonce')) {
    if (-not [string]$request.$required) {
      throw "Missing request field: $required"
    }
  }
  if (-not $request.requireMinimized) {
    throw 'Draft probe requires requireMinimized=true.'
  }

  $active = Invoke-QnCommand $request.bridgeBase $request.clientId 'getActiveUser'
  Assert-Context $active $request 'getActiveUser'
  if ([string]$active.value.securityUID -ne [string]$request.expectedTargetId -or
      [string]$active.value.cid -ne [string]$request.expectedCid) {
    throw 'getActiveUser identity mismatch.'
  }

  $empty = Invoke-QnCommand $request.bridgeBase $request.clientId 'isInputboxEmpty'
  Assert-Context $empty $request 'isInputboxEmpty'
  if (-not $empty.value.isEmpty) {
    throw 'Input box is not empty; refusing to overwrite the current draft.'
  }

  $lines.Add("context_guard=ok nonce=$($request.nonce)")
  $mode = if ($request.useFocusChain) {
    '--write-draft-focus-chain-minimized'
  } else {
    '--write-draft-minimized'
  }
  $confirm = if ($request.useFocusChain) {
    'QN_NATIVE_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE'
  } else {
    'QN_NATIVE_DRAFT_MINIMIZED_ONCE'
  }
  $output = @(& (Join-Path $probeRoot 'build\qn_native_submit_probe.exe') `
    $mode --text ([string]$request.text) --confirm $confirm 2>&1 |
    ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) { $lines.Add($line) }
} catch {
  $lines.Add("ERROR task_exception=$($_.Exception.Message)")
  $exitCode = 100
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
