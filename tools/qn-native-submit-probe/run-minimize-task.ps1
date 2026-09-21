$ErrorActionPreference = 'Stop'
$probeRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $probeRoot)
$outFile = Join-Path $repoRoot '.tmp\qn-native-submit-probe\minimize.log'
New-Item -ItemType Directory -Path (Split-Path -Parent $outFile) -Force | Out-Null

trap {
  [IO.File]::WriteAllText(
    $outFile,
    "ERROR $($_.Exception.Message)",
    [Text.UTF8Encoding]::new($false))
  exit 1
}

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class QnProbeMinimizeWin32 {
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
  public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int count);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);
}
'@

$candidates = [Collections.Generic.List[object]]::new()
$expectedTitle = [string]::Concat(
  [char]0x5343,
  [char]0x725B,
  [char]0x63A5,
  [char]0x5F85,
  [char]0x53F0)
[QnProbeMinimizeWin32]::EnumWindows({
  param([IntPtr]$handle, [IntPtr]$unused)
  if (-not [QnProbeMinimizeWin32]::IsWindowVisible($handle)) {
    return $true
  }

  $title = [Text.StringBuilder]::new(256)
  $className = [Text.StringBuilder]::new(128)
  [void][QnProbeMinimizeWin32]::GetWindowText($handle, $title, $title.Capacity)
  [void][QnProbeMinimizeWin32]::GetClassName($handle, $className, $className.Capacity)
  if ($title.ToString() -ne $expectedTitle -or
      $className.ToString() -ne 'Qt5152QWindowIcon') {
    return $true
  }

  $ownerPid = [uint32]0
  [void][QnProbeMinimizeWin32]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
  $candidates.Add([pscustomobject]@{ Handle = $handle; Pid = $ownerPid })
  return $true
}, [IntPtr]::Zero) | Out-Null

if ($candidates.Count -ne 1) {
  throw "Expected one validated Qianniu window; found $($candidates.Count)."
}

$target = $candidates[0]
$process = Get-Process -Id $target.Pid -ErrorAction Stop
if ($process.ProcessName -ne 'AliWorkbench') {
  throw "Target window belongs to unexpected process: $($process.ProcessName)."
}
[void][QnProbeMinimizeWin32]::ShowWindow($target.Handle, 6)
Start-Sleep -Milliseconds 500
if (-not [QnProbeMinimizeWin32]::IsIconic($target.Handle)) {
  throw 'Qianniu window did not enter the minimized state.'
}

$result = "MINIMIZED pid={0} hwnd=0x{1:x}" -f $target.Pid, $target.Handle.ToInt64()
[IO.File]::WriteAllText($outFile, $result, [Text.UTF8Encoding]::new($false))
Write-Output $result
