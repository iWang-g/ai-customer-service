$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32WindowEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
'@

function Get-WindowTextValue([IntPtr]$Handle) {
  $sb = [Text.StringBuilder]::new(512)
  [void][Win32WindowEnum]::GetWindowText($Handle, $sb, $sb.Capacity)
  $sb.ToString()
}

function Get-WindowClassValue([IntPtr]$Handle) {
  $sb = [Text.StringBuilder]::new(256)
  [void][Win32WindowEnum]::GetClassName($Handle, $sb, $sb.Capacity)
  $sb.ToString()
}

function Get-WindowRectValue([IntPtr]$Handle) {
  $rect = [Win32WindowEnum+RECT]::new()
  [void][Win32WindowEnum]::GetWindowRect($Handle, [ref]$rect)
  [pscustomobject]@{
    Left = $rect.Left
    Top = $rect.Top
    Right = $rect.Right
    Bottom = $rect.Bottom
    Width = $rect.Right - $rect.Left
    Height = $rect.Bottom - $rect.Top
  }
}

$processIds = Get-Process AliWorkbench,AliRender -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty Id

$top = New-Object System.Collections.Generic.List[object]
[Win32WindowEnum]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $ownerPid = [uint32]0
  [void][Win32WindowEnum]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
  if ($processIds -contains [int]$ownerPid) {
    $rect = Get-WindowRectValue $hWnd
    $top.Add([pscustomobject]@{
      Pid = [int]$ownerPid
      Handle = ('0x{0:X}' -f $hWnd.ToInt64())
      Visible = [Win32WindowEnum]::IsWindowVisible($hWnd)
      Class = Get-WindowClassValue $hWnd
      Title = Get-WindowTextValue $hWnd
      Left = $rect.Left
      Top = $rect.Top
      Width = $rect.Width
      Height = $rect.Height
    })
  }
  $true
}, [IntPtr]::Zero) | Out-Null

$topWindows = @($top.ToArray())
if ($topWindows.Count -eq 0) {
  Write-Output 'NO_QN_TOP_WINDOWS'
} else {
  foreach ($window in ($topWindows | Sort-Object Visible,Width,Height -Descending)) {
    Write-Output ("TOP pid={0} handle={1} visible={2} class={3} title={4} rect={5},{6},{7},{8}" -f $window.Pid, $window.Handle, $window.Visible, $window.Class, $window.Title, $window.Left, $window.Top, $window.Width, $window.Height)
  }
}

foreach ($window in ($topWindows | Where-Object { $_.Visible -and $_.Width -gt 200 -and $_.Height -gt 200 })) {
  Write-Output ''
  Write-Output ("CHILDREN {0} pid={1} class={2} title={3}" -f $window.Handle, $window.Pid, $window.Class, $window.Title)
  $handleValue = [Convert]::ToInt64($window.Handle.Replace('0x', ''), 16)
  $children = New-Object System.Collections.Generic.List[object]
  [Win32WindowEnum]::EnumChildWindows([IntPtr]$handleValue, {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $ownerPid = [uint32]0
    [void][Win32WindowEnum]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
    $rect = Get-WindowRectValue $hWnd
    if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
      $children.Add([pscustomobject]@{
        Pid = [int]$ownerPid
        Handle = ('0x{0:X}' -f $hWnd.ToInt64())
        Visible = [Win32WindowEnum]::IsWindowVisible($hWnd)
        Class = Get-WindowClassValue $hWnd
        Title = Get-WindowTextValue $hWnd
        Left = $rect.Left
        Top = $rect.Top
        Width = $rect.Width
        Height = $rect.Height
      })
    }
    $true
  }, [IntPtr]::Zero) | Out-Null
  foreach ($child in ($children.ToArray() | Sort-Object Width,Height -Descending | Select-Object -First 40)) {
    Write-Output ("CHILD pid={0} handle={1} visible={2} class={3} title={4} rect={5},{6},{7},{8}" -f $child.Pid, $child.Handle, $child.Visible, $child.Class, $child.Title, $child.Left, $child.Top, $child.Width, $child.Height)
  }
}
