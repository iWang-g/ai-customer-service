$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class QnRestoreWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Get-WindowTextValue([IntPtr]$Handle) {
  $sb = [Text.StringBuilder]::new(512)
  [void][QnRestoreWin32]::GetWindowText($Handle, $sb, $sb.Capacity)
  $sb.ToString()
}

function Get-WindowClassValue([IntPtr]$Handle) {
  $sb = [Text.StringBuilder]::new(256)
  [void][QnRestoreWin32]::GetClassName($Handle, $sb, $sb.Capacity)
  $sb.ToString()
}

$processIds = @(Get-Process AliWorkbench,AliRender -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$candidates = New-Object System.Collections.Generic.List[object]

[QnRestoreWin32]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $ownerPid = [uint32]0
  [void][QnRestoreWin32]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
  if ($processIds -contains [int]$ownerPid) {
    $title = Get-WindowTextValue $hWnd
    $class = Get-WindowClassValue $hWnd
    if ($title -match '千牛接待台|千牛工作台|MutilChatView|聊天') {
      $candidates.Add([pscustomobject]@{
        Handle = $hWnd
        Pid = [int]$ownerPid
        Title = $title
        Class = $class
        Visible = [QnRestoreWin32]::IsWindowVisible($hWnd)
      })
    }
  }
  $true
}, [IntPtr]::Zero) | Out-Null

$target = @($candidates.ToArray()) | Sort-Object @{ Expression = { $_.Title -match '千牛接待台' }; Descending = $true }, Visible -Descending | Select-Object -First 1
if (-not $target) {
  Write-Output 'NO_QN_RESTORE_TARGET'
  exit 1
}

[void][QnRestoreWin32]::ShowWindow($target.Handle, 9)
Start-Sleep -Milliseconds 200
[void][QnRestoreWin32]::SetForegroundWindow($target.Handle)
Write-Output ("RESTORED pid={0} class={1} title={2}" -f $target.Pid, $target.Class, $target.Title)
