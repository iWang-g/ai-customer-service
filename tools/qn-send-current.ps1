param(
  [string]$Text = "codex-send-current-$(Get-Date -Format 'HHmmss')",
  [ValidateSet('Enter', 'CtrlEnter', 'Button')]
  [string]$SendMethod = 'Enter',
  [switch]$NoSend,
  [int]$TimeoutSec = 25,
  [string]$TaskName = 'CodexQnUiaSend',
  [string]$OutFile = '.\qn-scheduled-uia-send.log',
  [string]$AppLog = 'D:\AliWorkbenchData\System\log\app.log',
  [string]$ExpectedTitle = '',
  [switch]$ExpectedTitleContains,
  [string]$ExpectedCid = '',
  [string]$ExpectedLoginDisplay = '',
  [string]$HookLog = '.\qn-im-bridge-hook-events.ndjson'
  ,
  [ValidateSet('Scheduled', 'Direct')]
  [string]$UiaMode = 'Scheduled'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repoRoot

function Quote-PsSingle([string]$Value) {
  "'" + ($Value -replace "'", "''") + "'"
}

function Resolve-RepoPath([string]$Value) {
  if ([IO.Path]::IsPathRooted($Value)) {
    return $Value
  }
  return Join-Path $repoRoot $Value
}

function Read-TextFileTail([string]$Path, [int]$Count) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      return @(Get-Content -LiteralPath $Path -Tail $Count -Encoding UTF8 -ErrorAction Stop)
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 100
    }
  }
  return @(Get-Content -LiteralPath $Path -Tail $Count -Encoding UTF8 -ErrorAction Stop)
}

function Get-FileSize([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return 0
  }
  return ([IO.FileInfo]$Path).Length
}

function Read-TextAfterOffset([string]$Path, [long]$Offset) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return ''
  }

  $info = [IO.FileInfo]$Path
  if ($info.Length -lt $Offset) {
    $Offset = 0
  }
  if ($info.Length -eq $Offset) {
    return ''
  }

  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $stream.Seek($Offset, [IO.SeekOrigin]::Begin) | Out-Null
    $length = [int]($stream.Length - $stream.Position)
    $buffer = New-Object byte[] $length
    $read = $stream.Read($buffer, 0, $length)
    return [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  } finally {
    $stream.Dispose()
  }
}

function Find-SendResult([string]$Path, [string]$Needle, [long]$StartOffset) {
  $text = Read-TextAfterOffset $Path $StartOffset
  if (-not $text) {
    return $null
  }

  $allLines = @($text -split "`r?`n")
  $matchIndexes = New-Object System.Collections.Generic.List[int]
  for ($i = 0; $i -lt $allLines.Count; $i++) {
    if ($allLines[$i].Contains($Needle)) {
      $matchIndexes.Add($i)
    }
  }
  if ($matchIndexes.Count -eq 0) {
    return $null
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $matchIndex = $matchIndexes[$matchIndexes.Count - 1]
  $from = [Math]::Max(0, $matchIndex - 4)
  $to = [Math]::Min($allLines.Count - 1, $matchIndex + 12)
  for ($i = $from; $i -le $to; $i++) {
    $lines.Add($allLines[$i])
  }

  $joined = ($lines.ToArray() -join "`n")
  $clientId = ''
  $messageId = ''
  $cid = ''
  $sendStatus = ''

  if ($joined -match '"clientId":"([^"]+)"') {
    $clientId = $Matches[1]
  }
  if ($joined -match '"messageId":"([^"]+)"') {
    $messageId = $Matches[1]
  }
  if ($joined -match '"ccode":"([^"]+)"') {
    $cid = $Matches[1]
  } elseif ($joined -match 'dmsg\.cid=([^,\]]+)') {
    $cid = $Matches[1]
  }
  if ($joined -match '"sendStatus":([0-9-]+)') {
    $sendStatus = $Matches[1]
  }

  [pscustomobject]@{
    found = $true
    sendStatus = $sendStatus
    clientId = $clientId
    messageId = $messageId
    cid = $cid
    evidence = @($lines.ToArray() | Select-Object -Last 10)
  }
}

function Read-CurrentContext() {
  $contextText = & (Join-Path $repoRoot 'tools\qn-current-context.ps1') -HookLog $HookLog -Tail 500
  try {
    return ($contextText | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Context-Matches($Context) {
  if ($null -eq $Context -or -not $Context.found) {
    return $false
  }
  if ($ExpectedCid -and $Context.conversation.ccode -ne $ExpectedCid) {
    return $false
  }
  if ($ExpectedLoginDisplay -and $Context.login.display -ne $ExpectedLoginDisplay) {
    return $false
  }
  return $true
}

$logPath = Resolve-RepoPath $OutFile
$textPath = Join-Path $repoRoot 'qn-next-send-text.txt'
$expectedTitlePath = Join-Path $repoRoot 'qn-expected-title.txt'
$taskEntry = Join-Path $repoRoot 'qnt.ps1'

Set-Content -LiteralPath $textPath -Value $Text -Encoding UTF8
Set-Content -LiteralPath $logPath -Value "PENDING $(Get-Date -Format o) text=$Text" -Encoding UTF8
if ($ExpectedTitle) {
  Set-Content -LiteralPath $expectedTitlePath -Value $ExpectedTitle -Encoding UTF8
}

if ($ExpectedCid -or $ExpectedLoginDisplay) {
  $context = $null
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $context = Read-CurrentContext
    if (Context-Matches $context) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  $contextJson = if ($null -ne $context) { $context | ConvertTo-Json -Depth 8 -Compress } else { '' }
  Write-Output "PRECHECK_CONTEXT $contextJson"
  if (-not (Context-Matches $context)) {
    Write-Output "RESULT precheck_context_failed expectedCid=$ExpectedCid expectedLoginDisplay=$ExpectedLoginDisplay"
    exit 6
  }
}

$noSendArg = if ($NoSend) { ' -NoSend' } else { '' }
$expectedTitleArg = if ($ExpectedTitle) { ' -ExpectedTitleFile "qn-expected-title.txt"' } else { '' }
$expectedTitleContainsArg = if ($ExpectedTitleContains) { ' -ExpectedTitleContains' } else { '' }
$taskCmd = 'powershell.exe -WindowStyle Hidden -NoP -EP Bypass -File "' + $taskEntry + '"' +
  ' -TextFile "qn-next-send-text.txt"' +
  ' -SendMethod "' + $SendMethod + '"' +
  $expectedTitleArg +
  $expectedTitleContainsArg +
  $noSendArg

Write-Output "TEXT $Text"
Write-Output "TASK $TaskName"
Write-Output "LOG $logPath"
Write-Output "UIA_MODE $UiaMode"

$appLogStartOffset = Get-FileSize $AppLog

if ($UiaMode -eq 'Direct') {
  $directArgs = @(
    '-WindowStyle', 'Hidden',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $repoRoot 'tools\qn-uia-send-current.ps1'),
    '-Text', $Text,
    '-SendMethod', $SendMethod
  )
  if ($ExpectedTitle) {
    $directArgs += @('-ExpectedTitleFile', 'qn-expected-title.txt')
  }
  if ($ExpectedTitleContains) {
    $directArgs += '-ExpectedTitleContains'
  }
  if ($NoSend) {
    $directArgs += '-NoSend'
  }

  $uiaOutput = @(& powershell.exe @directArgs 2>&1)
  $uiaExit = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
  $uiaOutput | Add-Content -LiteralPath $logPath -Encoding UTF8
  Add-Content -LiteralPath $logPath -Value "END $(Get-Date -Format o) exit=$uiaExit" -Encoding UTF8
} else {
  & schtasks /Create /TN $TaskName /F /SC ONCE /ST 23:59 /IT /RL LIMITED /TR $taskCmd | Write-Output
  if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Create failed with exit code $LASTEXITCODE"
  }

  & schtasks /Run /TN $TaskName | Write-Output
  if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Run failed with exit code $LASTEXITCODE"
  }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$done = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $tail = Read-TextFileTail $logPath 40
  $hasCurrentText = ($tail -match ("^Text: " + [regex]::Escape($Text) + '$')).Count -gt 0
  if (($hasCurrentText -and $tail -match '^END .* exit=') -or $tail -match '^ERROR ') {
    $done = $true
    break
  }
}

$uiaTail = Read-TextFileTail $logPath 80
Write-Output '--- UIA LOG ---'
$uiaTail | Write-Output

if (-not $done) {
  Write-Output "RESULT timeout waiting for UIA task after ${TimeoutSec}s"
  exit 3
}

if ($NoSend) {
  Write-Output 'RESULT pasted_only'
  exit 0
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$result = $null
while ((Get-Date) -lt $deadline -and $null -eq $result) {
  Start-Sleep -Milliseconds 800
  $result = Find-SendResult $AppLog $Text $appLogStartOffset
}

if ($null -eq $result) {
  Write-Output 'RESULT not_found_in_app_log'
  exit 4
}

Write-Output '--- APP LOG RESULT ---'
Write-Output ("RESULT sendStatus={0} clientId={1} messageId={2} cid={3}" -f $result.sendStatus, $result.clientId, $result.messageId, $result.cid)
$result.evidence | Write-Output

if ($result.sendStatus -eq '0') {
  if ($ExpectedCid -and $result.cid -ne $ExpectedCid) {
    Write-Output "RESULT postcheck_cid_failed expectedCid=$ExpectedCid actualCid=$($result.cid)"
    exit 7
  }
  exit 0
}

exit 5
