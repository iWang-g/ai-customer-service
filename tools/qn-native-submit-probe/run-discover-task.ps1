param(
  [string]$OutFile = '',
  [switch]$Activate,
  [switch]$Minimized,
  [switch]$FocusChain,
  [switch]$Aim
)

$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
if (-not $OutFile) {
  $OutFile = Join-Path $repoRoot '.tmp\qn-native-submit-probe\discover.log'
}
$outDirectory = Split-Path -Parent $OutFile
New-Item -ItemType Directory -Path $outDirectory -Force | Out-Null
$temporaryFile = "$OutFile.tmp"

try {
  if (($Activate -or $Minimized -or $FocusChain) -and $Aim) {
    throw 'Aim cannot be combined with an UI discovery mode.'
  }
  if ($Activate -and ($Minimized -or $FocusChain)) {
    throw 'Activate cannot be combined with Minimized or FocusChain.'
  }
  $mode = if ($Aim) {
    '--enumerate-aim'
  } elseif ($Activate) {
    '--discover-activate'
  } elseif ($FocusChain) {
    '--discover-focus-chain-minimized'
  } elseif ($Minimized) {
    '--discover-minimized'
  } else {
    '--discover'
  }
  $output = @(& (Join-Path $probeRoot 'build\qn_native_submit_probe.exe') $mode 2>&1 |
    ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
} catch {
  $output = @("ERROR task_exception=$($_.Exception.Message)")
  $exitCode = 100
}

$lines = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "activate=$([bool]$Activate)"
  "minimized=$([bool]$Minimized)"
  "focusChain=$([bool]$FocusChain)"
  "aim=$([bool]$Aim)"
  "exitCode=$exitCode"
) + $output
[IO.File]::WriteAllLines($temporaryFile, $lines, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $OutFile -Force
exit $exitCode
