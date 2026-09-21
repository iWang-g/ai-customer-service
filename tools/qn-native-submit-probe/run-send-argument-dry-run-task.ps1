param(
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
if (-not $OutFile) {
  $OutFile = Join-Path $repoRoot '.tmp\qn-native-submit-probe\send-argument-dry-run.log'
}
$outDirectory = Split-Path -Parent $OutFile
New-Item -ItemType Directory -Path $outDirectory -Force | Out-Null
$temporaryFile = "$OutFile.tmp"
$probe = Join-Path $probeRoot 'build\qn_native_submit_probe.exe'

try {
  $dryRunOutput = @(& $probe --dry-run-send-arguments 2>&1 |
    ForEach-Object { $_.ToString() })
  $dryRunExitCode = $LASTEXITCODE
  $enumerationOutput = @(& $probe --enumerate-app-message-services 2>&1 |
    ForEach-Object { $_.ToString() })
  $enumerationExitCode = $LASTEXITCODE
  $firstLookupOutput = @(& $probe --locate-app-message-service '3#2222303856223' 2>&1 |
    ForEach-Object { $_.ToString() })
  $firstLookupExitCode = $LASTEXITCODE
  $secondLookupOutput = @(& $probe --locate-app-message-service '3#2222397351256' 2>&1 |
    ForEach-Object { $_.ToString() })
  $secondLookupExitCode = $LASTEXITCODE
} catch {
  $dryRunOutput = @("ERROR task_exception=$($_.Exception.Message)")
  $dryRunExitCode = 100
  $enumerationOutput = @()
  $enumerationExitCode = 100
  $firstLookupOutput = @()
  $firstLookupExitCode = 100
  $secondLookupOutput = @()
  $secondLookupExitCode = 100
}

$lines = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "dryRunExitCode=$dryRunExitCode"
) + $dryRunOutput + @(
  "enumerationExitCode=$enumerationExitCode"
) + $enumerationOutput + @(
  "firstLookupExitCode=$firstLookupExitCode"
) + $firstLookupOutput + @(
  "secondLookupExitCode=$secondLookupExitCode"
) + $secondLookupOutput
[IO.File]::WriteAllLines($temporaryFile, $lines, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $OutFile -Force

$exitCodes = @(
  $dryRunExitCode,
  $enumerationExitCode,
  $firstLookupExitCode,
  $secondLookupExitCode
)
$failedExitCode = $exitCodes | Where-Object { $_ -ne 0 } | Select-Object -First 1
exit $(if ($null -eq $failedExitCode) { 0 } else { $failedExitCode })
