param(
  [string]$ExpectedShopTargetId = '2222303856223',
  [string]$ExpectedTargetId = '2214525969878',
  [string]$ExpectedCid = '2214525969878.1-2216058631944.1#11001@cntaobao',
  [string]$ExpectedShop = '有求必应羊羊:王刚',
  [string]$ExpectedConversation = 'tb4947894539',
  [string]$ReplyPrefix = 'Codex新消息自动检测回复测试',
  [ValidateSet('Enter', 'Native')]
  [string]$SubmitMode = 'Enter',
  [int]$ListenTimeoutSec = 120,
  [string]$BridgeBase = 'http://127.0.0.1:18082/qn-bridge',
  [string]$AppLog = 'D:\AliWorkbenchData\System\log\app.log',
  [string]$HookLog = '.\qn-im-bridge-hook-events.ndjson'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repoRoot
if (-not [IO.Path]::IsPathRooted($HookLog)) {
  $HookLog = Join-Path $repoRoot $HookLog
}

function New-TailState([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Tail file does not exist: $Path"
  }
  @{
    Path = $Path
    Offset = ([IO.FileInfo]$Path).Length
    Partial = ''
  }
}

function Read-AppendedLines([hashtable]$State) {
  $info = [IO.FileInfo]$State.Path
  if ($info.Length -lt $State.Offset) {
    $State.Offset = 0L
    $State.Partial = ''
  }
  if ($info.Length -eq $State.Offset) {
    return @()
  }

  $stream = [IO.File]::Open($State.Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    [void]$stream.Seek([long]$State.Offset, [IO.SeekOrigin]::Begin)
    $length = [int]($stream.Length - $stream.Position)
    $buffer = New-Object byte[] $length
    $read = $stream.Read($buffer, 0, $length)
    $State.Offset = $stream.Length
    $text = $State.Partial + [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  } finally {
    $stream.Dispose()
  }

  $parts = [regex]::Split($text, "`r?`n")
  if ($parts.Count -eq 1) {
    $State.Partial = $text
    return @()
  }
  $State.Partial = $parts[$parts.Count - 1]
  @($parts[0..($parts.Count - 2)])
}

function Invoke-QnCommand([string]$ClientId, [string]$Cmd, [hashtable]$Param) {
  $body = @{ clientId = $ClientId; cmd = $Cmd; param = $Param } | ConvertTo-Json -Depth 8
  $queued = Invoke-RestMethod -Method Post -Uri "$BridgeBase/command" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
  $deadline = (Get-Date).AddSeconds(12)
  do {
    Start-Sleep -Milliseconds 150
    $result = (Invoke-RestMethod -Uri "$BridgeBase/results?commandId=$($queued.command.id)").result
    if ($null -ne $result) {
      if (-not $result.ok) {
        throw "$Cmd failed: $($result.value | ConvertTo-Json -Compress)"
      }
      return $result
    }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for $Cmd"
}

function Assert-TargetContext($Result, [string]$Step) {
  $state = $Result.state
  if ($state.loginID.targetId -ne $ExpectedShopTargetId -or
      $state.loginID.display -ne $ExpectedShop -or
      $state.conversationID.targetId -ne $ExpectedTargetId -or
      $state.conversationID.display -ne $ExpectedConversation -or
      $state.conversationID.ccode -ne $ExpectedCid) {
    throw "$Step returned a mismatched target context: $($state | ConvertTo-Json -Depth 8 -Compress)"
  }
}

function Get-IncomingMessageFromHook([string]$Line, [string]$MessageId) {
  try {
    $outer = $Line | ConvertFrom-Json
    if (-not $outer.body) { return $null }
    $body = $outer.body | ConvertFrom-Json
    if ($body.kind -ne 'bridge.invoke.result' -or $body.method -ne 'im.singlemsg.GetNewMsg') { return $null }
    @($body.messages) | Where-Object {
      $_.direction -eq 'incoming' -and $_.messageId -eq $MessageId -and $_.cid -eq $ExpectedCid
    } | Select-Object -First 1
  } catch {
    return $null
  }
}

function Invoke-ForegroundEnter {
  $taskName = 'CodexQnWin32SubmitOnce'
  $helper = Join-Path $repoRoot 'tools\qn-win32-submit-enter.ps1'
  $resultLog = Join-Path $repoRoot 'qn-win32-submit-enter.log'
  Remove-Item -LiteralPath $resultLog -Force -ErrorAction SilentlyContinue
  $taskCmd = 'powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + $helper + '"' +
    ' -OutFile "' + $resultLog + '"' +
    ' -BridgeBase "' + $BridgeBase + '"' +
    ' -ClientId "' + $clientId + '"' +
    ' -ExpectedShopTargetId "' + $ExpectedShopTargetId + '"' +
    ' -ExpectedTargetId "' + $ExpectedTargetId + '"' +
    ' -ExpectedCid "' + $ExpectedCid + '"'

  try {
    & schtasks.exe /Create /TN $taskName /F /SC ONCE /ST 23:59 /IT /RL LIMITED /TR $taskCmd | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks create failed: $LASTEXITCODE" }
    & schtasks.exe /Run /TN $taskName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks run failed: $LASTEXITCODE" }

    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 200
      if (Test-Path -LiteralPath $resultLog) {
        $result = Get-Content -LiteralPath $resultLog -Raw -Encoding UTF8
        if ($result -match 'RESULT sent_enter') { return $result.Trim() }
        if ($result -match 'RESULT failed') { throw $result.Trim() }
      }
    } while ((Get-Date) -lt $deadline)
    throw 'Foreground Enter helper timed out.'
  } finally {
    & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
  }
}

function Invoke-NativeSubmit {
  $taskName = "CodexQnNativeSubmitOnce-$PID"
  $probeRoot = Join-Path $repoRoot 'tools\qn-native-submit-probe'
  $taskEntry = Join-Path $probeRoot 'run-submit-task.ps1'
  $runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
  $requestFile = Join-Path $runDir 'submit-request.json'
  $resultLog = Join-Path $runDir 'submit.log'
  New-Item -ItemType Directory -Path $runDir -Force | Out-Null
  Remove-Item -LiteralPath $requestFile, $resultLog -Force -ErrorAction SilentlyContinue

  @{
    bridgeBase = $BridgeBase
    clientId = $clientId
    expectedShopTargetId = $ExpectedShopTargetId
    expectedTargetId = $ExpectedTargetId
    expectedCid = $ExpectedCid
    nonce = [guid]::NewGuid().ToString('N')
  } | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $requestFile -Encoding UTF8

  $taskCmd = 'powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' +
    $taskEntry + '"'
  $created = $false
  try {
    & schtasks.exe /Create /TN $taskName /F /SC ONCE /ST 23:59 /IT /RL LIMITED /TR $taskCmd | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks create failed: $LASTEXITCODE" }
    $created = $true
    & schtasks.exe /Run /TN $taskName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks run failed: $LASTEXITCODE" }

    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 100
      if (-not (Test-Path -LiteralPath $resultLog)) { continue }
      $result = Get-Content -LiteralPath $resultLog -Raw -Encoding UTF8
      if ($result -match '(?m)^exitCode=0\r?$' -and $result -match 'result=submit_invoked_once') {
        return ($result -split "`r?`n" | Where-Object {
          $_ -match '^(context_guard|method=|methodIndex=|submit_guard|metacallResult|result=)'
        }) -join '; '
      }
      if ($result -match '(?m)^exitCode=(?!0\r?$)\d+\r?$') {
        throw "Native submit failed: $($result.Trim())"
      }
    } while ((Get-Date) -lt $deadline)
    throw 'Native submit task timed out.'
  } finally {
    if ($created) {
      & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
    }
    Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
  }
}

$appTail = New-TailState $AppLog
$hookTail = New-TailState $HookLog
$incomingById = @{}
$wake = $null
$listenDeadline = (Get-Date).AddSeconds($ListenTimeoutSec)
Write-Output "LISTENING from=$(Get-Date -Format o) appOffset=$($appTail.Offset) hookOffset=$($hookTail.Offset) expectedCid=$ExpectedCid"

while ((Get-Date) -lt $listenDeadline -and $null -eq $wake) {
  foreach ($line in @(Read-AppendedLines $hookTail)) {
    try {
      $outer = $line | ConvertFrom-Json
      if (-not $outer.body) { continue }
      $body = $outer.body | ConvertFrom-Json
      if ($body.kind -ne 'bridge.invoke.result' -or $body.method -ne 'im.singlemsg.GetNewMsg') { continue }
      foreach ($message in @($body.messages)) {
        if ($message.direction -eq 'incoming' -and $message.messageId) {
          $incomingById[$message.messageId] = $message
        }
      }
    } catch {}
  }

  foreach ($line in @(Read-AppendedLines $appTail)) {
    if (-not $line.Contains('paas nty. OnMessageArrive')) { continue }
    $cid = [regex]::Match($line, 'dmsg\.cid=([^,\]\s]+)').Groups[1].Value
    $mid = [regex]::Match($line, 'dmsg\.mid=([^,\]\s]+)').Groups[1].Value
    $shopTargetId = [regex]::Match($line, 'MessageSDK \[\]\[3#(\d+)\]').Groups[1].Value
    $senderId = [regex]::Match($line, 'dmsg\.sender\.uid=([^,\]\s]+)').Groups[1].Value
    if ($cid -eq $ExpectedCid -and $shopTargetId -eq $ExpectedShopTargetId -and $senderId -eq $ExpectedTargetId -and $mid) {
      $wake = [pscustomobject]@{ cid = $cid; messageId = $mid; shopTargetId = $shopTargetId; senderId = $senderId; detectedAt = (Get-Date).ToString('o') }
      break
    }
  }
  if ($null -eq $wake) { Start-Sleep -Milliseconds 100 }
}

if ($null -eq $wake) {
  throw "No matching incoming message arrived within $ListenTimeoutSec seconds."
}
Write-Output "DETECTED messageId=$($wake.messageId) cid=$($wake.cid) sender=$($wake.senderId) shopTargetId=$($wake.shopTargetId)"

$clients = @((Invoke-RestMethod -Uri "$BridgeBase/clients").clients | Where-Object {
  $_.waiting -and $_.abilityReady -and $_.state.loginID.targetId -eq $ExpectedShopTargetId
} | Sort-Object lastSeen -Descending)
if ($clients.Count -eq 0) {
  throw "No waiting Ability client exists for shopTargetId=$ExpectedShopTargetId."
}
$clientId = $clients[0].clientId
Write-Output "CLIENT clientId=$clientId"

$open = Invoke-QnCommand $clientId 'openChat' @{ targetId = $ExpectedTargetId; bizDomain = 'taobao' }
Assert-TargetContext $open 'openChat'
$active = Invoke-QnCommand $clientId 'getActiveUser' @{}
Assert-TargetContext $active 'getActiveUser'
if ($active.value.securityUID -ne $ExpectedTargetId -or $active.value.cid -ne $ExpectedCid) {
  throw "getActiveUser identity mismatch: $($active.value | ConvertTo-Json -Compress)"
}
Write-Output "SWITCHED shop=$ExpectedShop conversation=$ExpectedConversation cid=$ExpectedCid"

# A hidden shop may not call GetNewMsg until openChat activates its target conversation.
$messageDeadline = (Get-Date).AddSeconds(10)
while (-not $incomingById.ContainsKey($wake.messageId) -and (Get-Date) -lt $messageDeadline) {
  foreach ($line in @(Read-AppendedLines $hookTail)) {
    $message = Get-IncomingMessageFromHook $line $wake.messageId
    if ($null -ne $message) { $incomingById[$wake.messageId] = $message }
  }
  if (-not $incomingById.ContainsKey($wake.messageId)) { Start-Sleep -Milliseconds 100 }
}
if (-not $incomingById.ContainsKey($wake.messageId)) {
  throw "GetNewMsg plaintext was not observed for $($wake.messageId) after openChat."
}
$incoming = $incomingById[$wake.messageId]
Write-Output "PLAINTEXT from=$($incoming.fromNick) text=$($incoming.text | ConvertTo-Json -Compress)"

$emptyBefore = Invoke-QnCommand $clientId 'isInputboxEmpty' @{}
Assert-TargetContext $emptyBefore 'isInputboxEmpty(before)'
if (-not $emptyBefore.value.isEmpty) {
  throw 'Target input box already contains text; refusing to append or send.'
}

$reply = "$ReplyPrefix-$(Get-Date -Format 'HHmmss')"
$insert = Invoke-QnCommand $clientId 'insertText2Inputbox' @{
  uid = "cntaobao$ExpectedConversation"
  securityUID = $ExpectedTargetId
  bizDomain = 'taobao'
  type = 0
  text = $reply
}
Assert-TargetContext $insert 'insertText2Inputbox'
$emptyAfterInsert = Invoke-QnCommand $clientId 'isInputboxEmpty' @{}
Assert-TargetContext $emptyAfterInsert 'isInputboxEmpty(after insert)'
if ($emptyAfterInsert.value.isEmpty) {
  throw 'Ability reported an empty input box after insertion.'
}
Write-Output "INSERTED reply=$reply"

$sendTail = New-TailState $AppLog
$submitResult = if ($SubmitMode -eq 'Native') {
  Invoke-NativeSubmit
} else {
  Invoke-ForegroundEnter
}
Write-Output "SUBMIT mode=$SubmitMode result=$submitResult"

$sendResult = $null
$sendDeadline = (Get-Date).AddSeconds(15)
while ($null -eq $sendResult -and (Get-Date) -lt $sendDeadline) {
  foreach ($line in @(Read-AppendedLines $sendTail)) {
    if ($line.Contains('onMsgSendUpdate') -and $line.Contains($ExpectedCid) -and $line.Contains($reply) -and $line.Contains('"sendStatus":0')) {
      $messageId = [regex]::Match($line, '"messageId":"([^"]+)"').Groups[1].Value
      $clientMessageId = [regex]::Match($line, '"clientId":"([^"]+)"').Groups[1].Value
      $sendResult = [pscustomobject]@{ messageId = $messageId; clientId = $clientMessageId; line = $line }
      break
    }
  }
  if ($null -eq $sendResult) { Start-Sleep -Milliseconds 100 }
}
if ($null -eq $sendResult) {
  throw 'No matching sendStatus=0 receipt was observed after Enter.'
}

$emptyAfterSend = Invoke-QnCommand $clientId 'isInputboxEmpty' @{}
Assert-TargetContext $emptyAfterSend 'isInputboxEmpty(after send)'
if (-not $emptyAfterSend.value.isEmpty) {
  throw 'Send receipt succeeded but the target input box is not empty.'
}

[pscustomobject]@{
  ok = $true
  incoming = @{ messageId = $wake.messageId; text = $incoming.text; cid = $wake.cid }
  target = @{ shop = $ExpectedShop; conversation = $ExpectedConversation; targetId = $ExpectedTargetId; cid = $ExpectedCid }
  reply = @{ text = $reply; messageId = $sendResult.messageId; clientId = $sendResult.clientId; sendStatus = 0; submitMode = $SubmitMode }
} | ConvertTo-Json -Depth 8
