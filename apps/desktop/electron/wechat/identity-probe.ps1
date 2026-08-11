param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][long]$WindowHandle
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WechatIdentityNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
'@

function Write-Result([string]$Status, [string]$WechatName = '', [string]$WechatId = '', [string]$Detail = '') {
  [pscustomobject]@{
    status = $Status
    wechat_name = $WechatName
    wechat_id = $WechatId
    source = 'wechat_profile_uia'
    detail = $Detail
  } | ConvertTo-Json -Compress
}

function Get-Children($Element) {
  $items = @()
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child = $walker.GetFirstChild($Element)
  while ($null -ne $child) {
    $items += $child
    $child = $walker.GetNextSibling($child)
  }
  return $items
}

function Find-Descendant($Root, [scriptblock]$Predicate, [int]$MaxNodes = 1200) {
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue($Root)
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt $MaxNodes) {
    $current = $queue.Dequeue()
    $visited++
    try {
      if (& $Predicate $current) { return $current }
      foreach ($child in Get-Children $current) { $queue.Enqueue($child) }
    } catch {}
  }
  return $null
}

function Find-TargetWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($candidate in Get-Children $root) {
    try {
      if ($candidate.Current.ProcessId -ne $ProcessId) { continue }
      if ([long]$candidate.Current.NativeWindowHandle -ne $WindowHandle) { continue }
      if (@('mmui::MainWindow', 'Qt51514QWindowIcon', 'WeChatMainWndForPC') -notcontains $candidate.Current.ClassName) { continue }
      return $candidate
    } catch {}
  }
  return $null
}

function Find-ProfilePopup {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($candidate in Get-Children $root) {
    try {
      $candidateRect = $candidate.Current.BoundingRectangle
      $mainRect = $window.Current.BoundingRectangle
      $nearOwnAvatar = [Math]::Abs($candidateRect.Left - ($mainRect.Left + 32)) -le 80 -and
        [Math]::Abs($candidateRect.Top - ($mainRect.Top + 20)) -le 80
      if ($candidate.Current.ProcessId -eq $ProcessId -and
          $candidate.Current.ClassName -eq 'mmui::ProfileUniquePop' -and $nearOwnAvatar) {
        return $candidate
      }
    } catch {}
  }
  return $null
}

$previousForeground = [WechatIdentityNative]::GetForegroundWindow()
$cursor = [WechatIdentityNative+POINT]::new()
[void][WechatIdentityNative]::GetCursorPos([ref]$cursor)
$profileOpened = $false

try {
  $window = Find-TargetWindow
  if ($null -eq $window) {
    Write-Result 'window_not_found'
    exit 0
  }

  $mainView = Find-Descendant $window { param($item) $item.Current.AutomationId -eq 'MainView' } 300
  $tabbar = Find-Descendant $window { param($item) $item.Current.AutomationId -eq 'MainView.main_tabbar' } 300
  if ($null -eq $mainView -or $null -eq $tabbar) {
    Write-Result 'uia_unavailable' '' '' 'Wechat main window does not expose the complete UIA navigation tree'
    exit 0
  }

  $rect = $window.Current.BoundingRectangle
  if ($rect.Width -lt 300 -or $rect.Height -lt 300 -or $rect.Left -lt -10000 -or $rect.Top -lt -10000) {
    Write-Result 'window_not_ready'
    exit 0
  }

  [void][WechatIdentityNative]::SetForegroundWindow([IntPtr]$WindowHandle)
  Start-Sleep -Milliseconds 150
  [void][WechatIdentityNative]::SetCursorPos([int]($rect.Left + 30), [int]($rect.Top + 48))
  [WechatIdentityNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [WechatIdentityNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)

  $deadline = [DateTime]::UtcNow.AddMilliseconds(1800)
  $profile = $null
  while ([DateTime]::UtcNow -lt $deadline -and $null -eq $profile) {
    Start-Sleep -Milliseconds 100
    $profile = Find-ProfilePopup
  }
  if ($null -eq $profile) {
    Write-Result 'profile_not_opened'
    exit 0
  }
  $profileOpened = $true

  $nickname = Find-Descendant $profile {
    param($item)
    $item.Current.AutomationId -like '*nickname_button_view.display_name_text'
  }
  $wechatId = Find-Descendant $profile {
    param($item)
    $item.Current.AutomationId -like '*basic_line_view.ProfileTextView' -and $item.Current.Name
  }
  $nameValue = if ($null -ne $nickname) { [string]$nickname.Current.Name } else { '' }
  $idValue = if ($null -ne $wechatId) { [string]$wechatId.Current.Name } else { '' }
  if ([string]::IsNullOrWhiteSpace($nameValue) -or [string]::IsNullOrWhiteSpace($idValue)) {
    Write-Result 'identity_incomplete' $nameValue $idValue
    exit 0
  }
  Write-Result 'identified' $nameValue $idValue
} catch {
  Write-Result 'probe_failed' '' '' $_.Exception.Message
} finally {
  if ($profileOpened) {
    [WechatIdentityNative]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
    [WechatIdentityNative]::keybd_event(0x1B, 0, 0x0002, [UIntPtr]::Zero)
  }
  [void][WechatIdentityNative]::SetCursorPos($cursor.X, $cursor.Y)
  if ($previousForeground -ne [IntPtr]::Zero) {
    [void][WechatIdentityNative]::SetForegroundWindow($previousForeground)
  }
}
