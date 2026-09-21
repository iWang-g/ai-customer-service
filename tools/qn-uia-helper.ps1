param(
  [string]$QueueDir = '.\qn-uia-helper',
  [int]$PollMs = 250,
  [switch]$Once,
  [int]$IdleExitSec = 0,
  [string]$LogFile = '.\qn-uia-helper.log'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repoRoot

function Resolve-RepoPath([string]$Value) {
  if ([IO.Path]::IsPathRooted($Value)) {
    return $Value
  }
  return Join-Path $repoRoot $Value
}

$queueRoot = Resolve-RepoPath $QueueDir
$requestDir = Join-Path $queueRoot 'requests'
$responseDir = Join-Path $queueRoot 'responses'
$processingDir = Join-Path $queueRoot 'processing'
$doneDir = Join-Path $queueRoot 'done'
$failedDir = Join-Path $queueRoot 'failed'
$statusPath = Join-Path $queueRoot 'status.json'
$logPath = Resolve-RepoPath $LogFile
$startedAt = Get-Date
$lastWorkAt = Get-Date

New-Item -ItemType Directory -Force -Path $requestDir, $responseDir, $processingDir, $doneDir, $failedDir | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Write-HelperLog([string]$Message, $Details = $null) {
  $suffix = ''
  if ($null -ne $Details) {
    $suffix = ' ' + ($Details | ConvertTo-Json -Depth 8 -Compress)
  }
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("[{0}] {1}{2}" -f (Get-Date).ToString('o'), $Message, $suffix)
}

function Write-Status([switch]$Stopped) {
  $tmp = "$statusPath.tmp"
  $status = @{
    service = 'qn-uia-helper'
    pid = $PID
    startedAt = $startedAt.ToString('o')
    heartbeatAt = (Get-Date).ToString('o')
    queueRoot = $queueRoot
  }
  if ($Stopped) {
    $status['stoppedAt'] = (Get-Date).ToString('o')
  }
  $json = $status | ConvertTo-Json -Depth 8
  Write-Utf8NoBom $tmp $json
  Move-Item -LiteralPath $tmp -Destination $statusPath -Force
}

function Write-Response([string]$Id, $Response) {
  $path = Join-Path $responseDir "$Id.json"
  $tmp = "$path.tmp"
  $json = $Response | ConvertTo-Json -Depth 12
  Write-Utf8NoBom $tmp $json
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Move-RequestFile([string]$Path, [bool]$Ok) {
  $targetDir = if ($Ok) { $doneDir } else { $failedDir }
  $name = Split-Path -Leaf $Path
  $target = Join-Path $targetDir $name
  Move-Item -LiteralPath $Path -Destination $target -Force
}

function Invoke-UiaRequest($Request) {
  if (-not $Request.id) {
    throw 'request missing id'
  }
  if (-not $Request.conversationName) {
    throw 'request missing conversationName'
  }

  $scriptPath = Join-Path $repoRoot 'tools\qn-send-visible-conversation.ps1'
  $timeoutSec = if ($Request.timeoutSec) { [int]$Request.timeoutSec } else { 30 }
  $invokeArgs = @{
    ConversationName = [string]$Request.conversationName
    TimeoutSec = $timeoutSec
    UiaMode = 'Direct'
  }
  if ($Request.shopName) {
    $invokeArgs.ShopName = [string]$Request.shopName
  }
  if ($Request.expectedCid) {
    $invokeArgs.ExpectedCid = [string]$Request.expectedCid
  }
  if ($Request.expectedLoginDisplay) {
    $invokeArgs.ExpectedLoginDisplay = [string]$Request.expectedLoginDisplay
  }
  if ($Request.switchOnly) {
    $invokeArgs.SwitchOnly = $true
  } else {
    $invokeArgs.Text = [string]$Request.text
  }

  $started = Get-Date
  Write-HelperLog 'request_start' @{
    id = $Request.id
    type = $Request.type
    switchOnly = [bool]$Request.switchOnly
    shopName = $Request.shopName
    conversationName = $Request.conversationName
    expectedCid = $Request.expectedCid
    timeoutSec = $timeoutSec
  }

  $output = @(& $scriptPath @invokeArgs 2>&1)
  $exitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
  $finished = Get-Date

  @{
    id = $Request.id
    ok = ($exitCode -eq 0)
    exitCode = $exitCode
    startedAt = $started.ToString('o')
    finishedAt = $finished.ToString('o')
    output = @($output | ForEach-Object { [string]$_ })
  }
}

Write-HelperLog 'helper_start' @{ queueRoot = $queueRoot; pid = $PID }
Write-Status

$processedOnce = $false
while ($true) {
  Write-Status

  $file = @(Get-ChildItem -LiteralPath $requestDir -Filter '*.json' -File | Sort-Object LastWriteTimeUtc | Select-Object -First 1)
  if ($file.Count -eq 0) {
    if ($Once -and $processedOnce) {
      break
    }
    if ($IdleExitSec -gt 0 -and ((Get-Date) - $lastWorkAt).TotalSeconds -ge $IdleExitSec) {
      Write-HelperLog 'helper_idle_exit'
      break
    }
    Start-Sleep -Milliseconds $PollMs
    continue
  }

  $processingPath = Join-Path $processingDir $file[0].Name
  try {
    Move-Item -LiteralPath $file[0].FullName -Destination $processingPath -ErrorAction Stop
  } catch {
    Start-Sleep -Milliseconds $PollMs
    continue
  }

  $request = $null
  $response = $null
  try {
    $request = Get-Content -LiteralPath $processingPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $response = Invoke-UiaRequest $request
    Write-Response ([string]$request.id) $response
    Move-RequestFile $processingPath $response.ok
    Write-HelperLog 'request_finish' @{ id = $request.id; ok = $response.ok; exitCode = $response.exitCode }
  } catch {
    $id = if ($request -and $request.id) { [string]$request.id } else { [IO.Path]::GetFileNameWithoutExtension($processingPath) }
    $errorText = @(
      "ERROR $($_.Exception.Message)"
      "CATEGORY $($_.CategoryInfo)"
      "POSITION $($_.InvocationInfo.PositionMessage)"
      "STACK $($_.ScriptStackTrace)"
    ) | Where-Object { $_ -and $_.Trim() }
    $response = @{
      id = $id
      ok = $false
      exitCode = 99
      startedAt = (Get-Date).ToString('o')
      finishedAt = (Get-Date).ToString('o')
      output = @($errorText)
    }
    Write-Response $id $response
    Move-RequestFile $processingPath $false
    Write-HelperLog 'request_error' @{ id = $id; error = $_.Exception.Message }
  }

  $processedOnce = $true
  $lastWorkAt = Get-Date
}

Write-Status -Stopped
Write-HelperLog 'helper_stop'
