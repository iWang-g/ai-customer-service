param(
  [string]$TaskName = "CodexQnWin32Submit-$PID",
  [string]$BridgeBase = 'http://127.0.0.1:18082/qn-bridge',
  [Parameter(Mandatory = $true)]
  [string]$ClientId,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedShopTargetId,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedTargetId,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCid,
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$taskEntry = Join-Path $repoRoot 'tools\qn-win32-submit-task.ps1'
$runDir = Join-Path $repoRoot '.tmp\qn-win32-submit'
$requestFile = Join-Path $runDir 'request.json'
$resultLog = Join-Path $runDir 'result.log'
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $resultLog -Force -ErrorAction SilentlyContinue

$request = @{
  bridgeBase = $BridgeBase
  clientId = $ClientId
  expectedShopTargetId = $ExpectedShopTargetId
  expectedTargetId = $ExpectedTargetId
  expectedCid = $ExpectedCid
  resultLog = $resultLog
  createdAt = (Get-Date).ToString('o')
}
$request | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $requestFile -Encoding UTF8
$taskCommand = 'powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + $taskEntry + '"'
$taskCreated = $false

try {
  & schtasks.exe /Create /TN $TaskName /F /SC ONCE /ST 23:59 /IT /RL LIMITED /TR $taskCommand | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks create failed with exit code $LASTEXITCODE" }
  $taskCreated = $true

  & schtasks.exe /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks run failed with exit code $LASTEXITCODE" }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    Start-Sleep -Milliseconds 200
    if (-not (Test-Path -LiteralPath $resultLog)) { continue }
    $result = Get-Content -LiteralPath $resultLog -Raw -Encoding UTF8
    if ($result -match 'RESULT sent_enter') {
      Write-Output $result.Trim()
      exit 0
    }
    if ($result -match 'RESULT failed') {
      Write-Error $result.Trim()
      exit 1
    }
  } while ((Get-Date) -lt $deadline)

  throw "Win32 submit helper timed out after $TimeoutSec seconds."
} finally {
  if ($taskCreated) {
    try { & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null } catch {}
  }
  Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $resultLog -Force -ErrorAction SilentlyContinue
}
