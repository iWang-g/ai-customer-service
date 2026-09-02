param(
  [string]$Text = "codex-uia-send-$(Get-Date -Format 'HHmmss')",
  [ValidateSet('Button', 'Enter', 'CtrlEnter')]
  [string]$SendMethod = 'Enter',
  [switch]$NoSend,
  [switch]$KeepExistingDraft,
  [switch]$AllowSendWithoutDraftConfirm,
  [string]$ExpectedTitle = '',
  [string]$ExpectedTitleFile = '',
  [switch]$ExpectedTitleContains
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies System.Windows.Forms @'
using System;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public static class QnClipboardSta {
  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  private const uint MOUSEEVENTF_LEFTUP = 0x0004;

  public static bool ForceForeground(long hwndValue) {
    IntPtr hWnd = new IntPtr(hwndValue);
    ShowWindow(hWnd, 9);
    Thread.Sleep(100);

    uint unused;
    uint currentThread = GetCurrentThreadId();
    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
    uint targetThread = GetWindowThreadProcessId(hWnd, out unused);

    if (foregroundThread != 0 && foregroundThread != currentThread) {
      AttachThreadInput(currentThread, foregroundThread, true);
    }
    if (targetThread != 0 && targetThread != currentThread) {
      AttachThreadInput(currentThread, targetThread, true);
    }

    BringWindowToTop(hWnd);
    bool ok = SetForegroundWindow(hWnd);
    Thread.Sleep(150);

    if (targetThread != 0 && targetThread != currentThread) {
      AttachThreadInput(currentThread, targetThread, false);
    }
    if (foregroundThread != 0 && foregroundThread != currentThread) {
      AttachThreadInput(currentThread, foregroundThread, false);
    }

    return ok;
  }

  public static void SetText(string text) {
    Exception captured = null;
    Thread thread = new Thread(delegate() {
      try {
        Clipboard.SetText(text);
      } catch (Exception ex) {
        captured = ex;
      }
    });
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    thread.Join();
    if (captured != null) {
      throw new ApplicationException("Clipboard.SetText failed.", captured);
    }
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

$inputAutomationId = 'UIWindow.mutilcentralwidget.stackedWidget.SingleChatView.centralwidget.stackedWidget.SubChatView.ChatDisplayWidget.ChatContentView.splitter.sendMsgWidget.chatInputArea.plainTextEdit'
$sendAutomationId = 'UIWindow.mutilcentralwidget.stackedWidget.SingleChatView.centralwidget.stackedWidget.SubChatView.ChatDisplayWidget.ChatContentView.splitter.sendMsgWidget.enterAreaKeyWidget.sendMsg'

function Set-ClipboardTextSta([string]$Value) {
  [QnClipboardSta]::SetText($Value)
}

function Find-DescendantByAutomationId($Root, [string]$AutomationId) {
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
    $AutomationId
  )
  return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Find-DescendantByAutomationIdSuffix($Root, [string]$Suffix) {
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

function Get-ElementText($Element) {
  if ($null -eq $Element) {
    return ''
  }

  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    try {
      return $pattern.Current.Value
    } catch {
    }
  }

  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
    try {
      return $pattern.DocumentRange.GetText(10000)
    } catch {
    }
  }

  return ''
}

function Set-ElementText($Element, [string]$Value) {
  if ($null -eq $Element) {
    return $false
  }

  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    try {
      if ($pattern.Current.IsReadOnly) {
        return $false
      }
      $pattern.SetValue($Value)
      return $true
    } catch {
      Write-Output "SetValue failed: $($_.Exception.Message)"
      return $false
    }
  }

  return $false
}

function Invoke-Element($Element) {
  if ($null -eq $Element) {
    return $false
  }

  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    return $true
  }

  return $false
}

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

if ($ExpectedTitleFile) {
  $ExpectedTitle = Get-Content -LiteralPath (Resolve-RepoPath $ExpectedTitleFile) -Raw -Encoding UTF8
  $ExpectedTitle = $ExpectedTitle.TrimEnd("`r", "`n")
}

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
  throw 'UIA window not found: className=MutilChatView. Make sure Qianniu chat window is visible and run this script from desktop PowerShell.'
}

$input = Find-DescendantByAutomationId $qnWindow $inputAutomationId
if ($null -eq $input) {
  $input = Find-DescendantByAutomationIdSuffix $qnWindow 'sendMsgWidget.chatInputArea.plainTextEdit'
}
if ($null -eq $input) {
  throw 'Chat input not found: sendMsgWidget.chatInputArea.plainTextEdit.'
}

$sendButton = Find-DescendantByAutomationId $qnWindow $sendAutomationId
if ($null -eq $sendButton) {
  $sendButton = Find-DescendantByAutomationIdSuffix $qnWindow 'sendMsgWidget.enterAreaKeyWidget.sendMsg'
}
if ($null -eq $sendButton -and $SendMethod -eq 'Button' -and -not $NoSend) {
  throw 'Send button not found: sendMsgWidget.enterAreaKeyWidget.sendMsg. Try -SendMethod Enter.'
}

$windowRect = $qnWindow.Current.BoundingRectangle
$windowHandle = $qnWindow.Current.NativeWindowHandle
$inputRect = $input.Current.BoundingRectangle
$buttonRect = if ($null -ne $sendButton) { $sendButton.Current.BoundingRectangle } else { $null }

Write-Output "Window: name=$($qnWindow.Current.Name) pid=$($qnWindow.Current.ProcessId) rect=$windowRect"
Write-Output "Input: type=$($input.Current.ControlType.ProgrammaticName) class=$($input.Current.ClassName) enabled=$($input.Current.IsEnabled) focus=$($input.Current.HasKeyboardFocus) rect=$inputRect"
if ($null -ne $sendButton) {
  Write-Output "SendButton: name=$($sendButton.Current.Name) enabled=$($sendButton.Current.IsEnabled) rect=$buttonRect"
}
Write-Output "Text: $Text"

$foregroundOk = [QnClipboardSta]::ForceForeground([long]$windowHandle)
Write-Output "ForceForeground: hwnd=0x$('{0:X}' -f $windowHandle) ok=$foregroundOk"
Start-Sleep -Milliseconds 250

if ($ExpectedTitle) {
  $title = Find-ByAutomationIdSuffix $qnWindow 'ChatContentView.titleWidget.titlename'
  $titleName = if ($null -ne $title) { $title.Current.Name } else { '' }
  Write-Output "CurrentTitleBeforeSend: $titleName"
  $titleOk = if ($ExpectedTitleContains) {
    $titleName -like "*$ExpectedTitle*"
  } else {
    $titleName -eq $ExpectedTitle
  }
  if (-not $titleOk) {
    Write-Output "Send skipped because title check failed. expected=$ExpectedTitle actual=$titleName"
    exit 6
  }
}

$qnWindow.SetFocus()
Start-Sleep -Milliseconds 200
$clickInputX = [int]($inputRect.Left + [Math]::Min(24, [Math]::Max(8, $inputRect.Width * 0.05)))
$clickInputY = [int]($inputRect.Top + [Math]::Min(22, [Math]::Max(8, $inputRect.Height * 0.35)))
[QnClipboardSta]::Click($clickInputX, $clickInputY)
Start-Sleep -Milliseconds 150
Write-Output "InputFocusAfterClick: $($input.Current.HasKeyboardFocus)"

Set-ClipboardTextSta $Text

if (-not $KeepExistingDraft) {
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 80
}

[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 250
$draftText = Get-ElementText $input
if ($draftText.Length -gt 300) {
  $draftText = $draftText.Substring(0, 300)
}
Write-Output "DraftAfterPaste: length=$($draftText.Length) value=$draftText"

if ($NoSend) {
  Write-Output 'Pasted only. Not sent.'
  exit 0
}

if (-not $AllowSendWithoutDraftConfirm -and $draftText -ne $Text) {
  Write-Output 'Send skipped because draft text was not confirmed.'
  exit 2
}

if ($SendMethod -eq 'Button') {
  if (Invoke-Element $sendButton) {
    Write-Output 'SendButton invoked via UIA InvokePattern.'
  } else {
    $clickX = [int]($buttonRect.Left + [Math]::Min(18, [Math]::Max(8, $buttonRect.Width * 0.28)))
    $clickY = [int]($buttonRect.Top + ($buttonRect.Height / 2))
    [QnClipboardSta]::Click($clickX, $clickY)
    Write-Output "SendButton clicked at x=$clickX y=$clickY."
  }
} elseif ($SendMethod -eq 'CtrlEnter') {
  [System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

Write-Output 'Send triggered. Check hook log or app.log for sendStatus/messageId.'
