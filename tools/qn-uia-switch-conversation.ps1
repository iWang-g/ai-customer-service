param(
  [string]$Name = '',
  [string]$NameFile = '',
  [switch]$Contains,
  [int]$WaitMs = 800,
  [string]$OutFile = '.\qn-uia-switch-conversation.log'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Threading;
using System.Runtime.InteropServices;

public static class QnSwitchConversationWin32 {
  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  private const uint MOUSEEVENTF_LEFTUP = 0x0004;

  public static void Activate(long hwndValue) {
    IntPtr hWnd = new IntPtr(hwndValue);
    ShowWindow(hWnd, 9);
    Thread.Sleep(100);
    BringWindowToTop(hWnd);
    SetForegroundWindow(hWnd);
    Thread.Sleep(150);
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    Thread.Sleep(80);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(50);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }
}
'@

function Resolve-RepoPath([string]$Value) {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
  if ([IO.Path]::IsPathRooted($Value)) {
    return $Value
  }
  return Join-Path $repoRoot $Value
}

function Find-ByAutomationIdSuffix($Root, [string]$Suffix) {
  $all = $Root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  for ($i = 0; $i -lt $all.Count; $i++) {
    $item = $all.Item($i)
    if ($item.Current.AutomationId -like "*$Suffix") {
      return $item
    }
  }
  return $null
}

function Write-Log([string]$Value) {
  Add-Content -LiteralPath $script:LogPath -Value $Value -Encoding UTF8
}

$script:LogPath = Resolve-RepoPath $OutFile

if ($NameFile) {
  $resolvedNameFile = Resolve-RepoPath $NameFile
  $Name = Get-Content -LiteralPath $resolvedNameFile -Raw -Encoding UTF8
  $Name = $Name.TrimEnd("`r", "`n")
}
if (-not $Name) {
  throw 'Conversation name is required. Pass -Name or -NameFile.'
}

Set-Content -LiteralPath $script:LogPath -Value "START $(Get-Date -Format o) name=$Name contains=$Contains" -Encoding UTF8

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition
)

$qnWindow = $null
for ($i = 0; $i -lt $windows.Count; $i++) {
  $window = $windows.Item($i)
  if ($window.Current.ClassName -eq 'MutilChatView') {
    $qnWindow = $window
    break
  }
}

if ($null -eq $qnWindow) {
  throw 'UIA window not found: className=MutilChatView.'
}

[QnSwitchConversationWin32]::Activate([long]$qnWindow.Current.NativeWindowHandle)

$treeItemCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TreeItem
)
$items = $qnWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeItemCondition)

$target = $null
$visibleNames = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $items.Count; $i++) {
  $item = $items.Item($i)
  $current = $item.Current
  if ($current.IsOffscreen -or -not $current.Name) {
    continue
  }
  $visibleNames.Add($current.Name)
  if (($Contains -and $current.Name -like "*$Name*") -or ((-not $Contains) -and $current.Name -eq $Name)) {
    $target = $item
    break
  }
}

if ($null -eq $target) {
  Write-Log ("NOT_FOUND visible={0}" -f (($visibleNames.ToArray()) -join ', '))
  exit 2
}

$rect = $target.Current.BoundingRectangle
$clickX = [int]($rect.Left + ($rect.Width / 2))
$clickY = [int]($rect.Top + ($rect.Height / 2))
Write-Log ("TARGET name={0} rect={1},{2},{3},{4} click={5},{6}" -f $target.Current.Name, [int]$rect.Left, [int]$rect.Top, [int]$rect.Width, [int]$rect.Height, $clickX, $clickY)

[QnSwitchConversationWin32]::Click($clickX, $clickY)
Start-Sleep -Milliseconds $WaitMs

$title = Find-ByAutomationIdSuffix $qnWindow 'ChatContentView.titleWidget.titlename'
$titleName = if ($null -ne $title) { $title.Current.Name } else { '' }
Write-Log "CURRENT_TITLE $titleName"
Write-Log "END $(Get-Date -Format o) exit=0"
exit 0
