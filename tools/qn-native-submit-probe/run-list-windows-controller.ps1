$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$resultFile = Join-Path $runDir 'list-windows-result.log'
$taskName = "CodexQnListWindows-$PID"
$taskEntry = Join-Path $probeRoot 'run-list-windows-task.ps1'
$taskCommand = 'powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + $taskEntry + '"'
$created = $false
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
try {
  & schtasks.exe /Create /TN $taskName /F /SC ONCE /ST 23:59 /IT /RL LIMITED /TR $taskCommand | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "task create failed: $LASTEXITCODE" }
  $created = $true
  & schtasks.exe /Run /TN $taskName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "task run failed: $LASTEXITCODE" }
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $resultFile)) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $resultFile)) { throw 'interactive list-windows timed out' }
  Get-Content -LiteralPath $resultFile -Raw -Encoding UTF8
} finally {
  if ($created) { & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null }
}
