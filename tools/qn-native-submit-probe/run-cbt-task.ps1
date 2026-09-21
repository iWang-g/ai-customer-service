param(
  [ValidateRange(100, 30000)]
  [int]$DurationMs = 30000,
  [switch]$Suppress
)

$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$runDir = Join-Path $repoRoot '.tmp\qn-native-submit-probe'
$readyFile = Join-Path $runDir 'cbt.ready'
$outFile = Join-Path $runDir 'cbt.log'
$temporaryFile = "$outFile.tmp"
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
Remove-Item -LiteralPath $readyFile, $outFile, $temporaryFile `
  -Force -ErrorAction SilentlyContinue

$mode = if ($Suppress) {
  '--suppress-cbt-minimized'
} else {
  '--watch-cbt-minimized'
}
$process = $null
$exitCode = 100
try {
  $stdoutFile = Join-Path $runDir 'cbt.stdout.log'
  $stderrFile = Join-Path $runDir 'cbt.stderr.log'
  Remove-Item -LiteralPath $stdoutFile, $stderrFile `
    -Force -ErrorAction SilentlyContinue
  $process = Start-Process `
    -FilePath (Join-Path $probeRoot 'build\qn_native_submit_probe.exe') `
    -ArgumentList @($mode, [string]$DurationMs) `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile `
    -PassThru `
    -WindowStyle Hidden
  Start-Sleep -Milliseconds 1000
  if ($process.HasExited) {
    throw "CBT probe exited before ready with code $($process.ExitCode)."
  }
  [IO.File]::WriteAllText(
    $readyFile,
    [DateTimeOffset]::Now.ToString('o'),
    [Text.UTF8Encoding]::new($false))
  $process.WaitForExit()
  $process.Refresh()
  $exitCode = [int]$process.ExitCode
  $output = @(
    Get-Content -LiteralPath $stdoutFile -ErrorAction SilentlyContinue
    Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue
  )
} catch {
  $output = @("ERROR task_exception=$($_.Exception.Message)")
  if ($null -ne $process -and -not $process.HasExited) {
    $process.Kill()
  }
}

$header = @(
  "timestamp=$([DateTimeOffset]::Now.ToString('o'))"
  "sessionId=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
  "suppress=$([bool]$Suppress)"
  "exitCode=$exitCode"
)
[IO.File]::WriteAllLines(
  $temporaryFile,
  $header + $output,
  [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryFile -Destination $outFile -Force
exit $exitCode
