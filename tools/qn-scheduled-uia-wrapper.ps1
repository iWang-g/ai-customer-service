param(
  [ValidateSet('Probe', 'Send')]
  [string]$Mode = 'Probe',
  [string]$Text = "codex-scheduled-send-$(Get-Date -Format 'yyyyMMdd-HHmmss')",
  [ValidateSet('Button', 'Enter', 'CtrlEnter')]
  [string]$SendMethod = 'Enter',
  [string]$OutFile = ".\qn-scheduled-uia-last.log",
  [string]$TextFile = '',
  [string]$ExpectedTitleFile = '',
  [switch]$ExpectedTitleContains,
  [switch]$NoSend
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repoRoot

$logPath = if ([IO.Path]::IsPathRooted($OutFile)) {
  $OutFile
} else {
  Join-Path $repoRoot $OutFile
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null

if ($TextFile) {
  $resolvedTextFile = if ([IO.Path]::IsPathRooted($TextFile)) {
    $TextFile
  } else {
    Join-Path $repoRoot $TextFile
  }
  $Text = Get-Content -LiteralPath $resolvedTextFile -Raw -Encoding UTF8
  $Text = $Text.TrimEnd("`r", "`n")
}

function Write-LogLine([string]$Value) {
  Add-Content -LiteralPath $logPath -Value $Value -Encoding UTF8
}

Set-Content -LiteralPath $logPath -Value "START $(Get-Date -Format o) mode=$Mode pid=$PID user=$env:USERNAME session=$((Get-Process -Id $PID).SessionId)" -Encoding UTF8

try {
  if ($Mode -eq 'Probe') {
    & (Join-Path $repoRoot 'tools\qn-list-windows.ps1') 2>&1 | ForEach-Object { Write-LogLine ($_ | Out-String).TrimEnd() }
  } else {
    $sendArgs = @{
      Text = $Text
      SendMethod = $SendMethod
    }
    if ($ExpectedTitleFile) {
      $sendArgs.ExpectedTitleFile = $ExpectedTitleFile
    }
    if ($ExpectedTitleContains) {
      $sendArgs.ExpectedTitleContains = $true
    }
    if ($NoSend) {
      $sendArgs.NoSend = $true
    }
    & (Join-Path $repoRoot 'tools\qn-uia-send-current.ps1') @sendArgs 2>&1 | ForEach-Object { Write-LogLine ($_ | Out-String).TrimEnd() }
  }
  $childExit = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
  Write-LogLine "END $(Get-Date -Format o) exit=$childExit"
  exit $childExit
} catch {
  Write-LogLine "ERROR $(Get-Date -Format o) $($_.Exception.Message)"
  Write-LogLine ($_.ScriptStackTrace | Out-String).TrimEnd()
  exit 1
}
