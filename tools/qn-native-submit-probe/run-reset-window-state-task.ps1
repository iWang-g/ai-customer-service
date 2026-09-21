$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$outFile = Join-Path $repoRoot '.tmp\qn-native-submit-probe\reset-window.log'
New-Item -ItemType Directory -Path (Split-Path -Parent $outFile) -Force |
  Out-Null

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class QnResetWindowState {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);
}
'@

$expectedTitle = [string]::Concat(
  [char]0x5343,
  [char]0x725B,
  [char]0x63A5,
  [char]0x5F85,
  [char]0x53F0)
$candidates = [Collections.Generic.List[object]]::new()
[QnResetWindowState]::EnumWindows({
  param([IntPtr]$handle, [IntPtr]$unused)
  if (-not [QnResetWindowState]::IsWindowVisible($handle)) {
    return $true
  }
  $title = [Text.StringBuilder]::new(256)
  $className = [Text.StringBuilder]::new(128)
  [void][QnResetWindowState]::GetWindowText($handle, $title, $title.Capacity)
  [void][QnResetWindowState]::GetClassName(
    $handle, $className, $className.Capacity)
  if ($title.ToString() -eq $expectedTitle -and
      $className.ToString() -eq 'Qt5152QWindowIcon') {
    $ownerPid = [uint32]0
    [void][QnResetWindowState]::GetWindowThreadProcessId(
      $handle, [ref]$ownerPid)
    $candidates.Add([pscustomobject]@{ Handle = $handle; Pid = $ownerPid })
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

if ($candidates.Count -ne 1) {
  throw "Expected one validated Qianniu window; found $($candidates.Count)."
}
$target = $candidates[0]
$process = Get-Process -Id $target.Pid -ErrorAction Stop
if ($process.ProcessName -ne 'AliWorkbench') {
  throw "Unexpected target process: $($process.ProcessName)."
}

$lines = [Collections.Generic.List[string]]::new()
$lines.Add("before minimized=$([QnResetWindowState]::IsIconic($target.Handle))")
[void][QnResetWindowState]::ShowWindow($target.Handle, 9)
Start-Sleep -Milliseconds 1000
$restored = -not [QnResetWindowState]::IsIconic($target.Handle)
$lines.Add("afterRestore minimized=$(-not $restored)")
if (-not $restored) {
  throw 'Qianniu did not restore during state reset.'
}
[void][QnResetWindowState]::ShowWindow($target.Handle, 6)
Start-Sleep -Milliseconds 1000
$minimized = [QnResetWindowState]::IsIconic($target.Handle)
$lines.Add("afterMinimize minimized=$minimized")
if (-not $minimized) {
  throw 'Qianniu did not minimize during state reset.'
}

[IO.File]::WriteAllLines(
  $outFile,
  $lines.ToArray(),
  [Text.UTF8Encoding]::new($false))
