param(
  [string]$OutFile = '.\qn-win32-submit-enter.log',
  [string]$BridgeBase = 'http://127.0.0.1:18082/qn-bridge',
  [string]$ClientId = '',
  [string]$ExpectedShopTargetId = '',
  [string]$ExpectedTargetId = '',
  [string]$ExpectedCid = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if (-not [IO.Path]::IsPathRooted($OutFile)) {
  $OutFile = Join-Path $repoRoot $OutFile
}

function Write-Result([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Set-Content -LiteralPath $OutFile -Value $line -Encoding UTF8
  Write-Output $line
}

function Invoke-QnCommand([string]$Cmd) {
  $body = @{ clientId = $ClientId; cmd = $Cmd; param = @{} } | ConvertTo-Json -Depth 6
  $queued = Invoke-RestMethod -Method Post -Uri "$BridgeBase/command" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
  $deadline = (Get-Date).AddSeconds(12)
  do {
    Start-Sleep -Milliseconds 100
    $result = (Invoke-RestMethod -Uri "$BridgeBase/results?commandId=$($queued.command.id)").result
    if ($null -ne $result) {
      if (-not $result.ok) { throw "Bridge getActiveUser failed: $($result.value | ConvertTo-Json -Compress)" }
      return $result
    }
  } while ((Get-Date) -lt $deadline)
  throw 'Bridge getActiveUser timed out.'
}

function Assert-ExpectedContext {
  if (-not ($ExpectedShopTargetId -or $ExpectedTargetId -or $ExpectedCid)) { return }
  if (-not $ClientId) { throw 'ClientId is required when expected context fields are set.' }
  $active = Invoke-QnCommand 'getActiveUser'
  $state = $active.state
  if ($ExpectedShopTargetId -and [string]$state.loginID.targetId -ne $ExpectedShopTargetId) {
    throw "Shop target mismatch: $($state.loginID.targetId)"
  }
  if ($ExpectedTargetId -and [string]$state.conversationID.targetId -ne $ExpectedTargetId) {
    throw "Conversation target mismatch: $($state.conversationID.targetId)"
  }
  if ($ExpectedCid -and [string]$state.conversationID.ccode -ne $ExpectedCid) {
    throw "Conversation cid mismatch: $($state.conversationID.ccode)"
  }
  if ($ExpectedTargetId -and [string]$active.value.securityUID -ne $ExpectedTargetId) {
    throw "Active securityUID mismatch: $($active.value.securityUID)"
  }
  if ($ExpectedCid -and [string]$active.value.cid -ne $ExpectedCid) {
    throw "Active cid mismatch: $($active.value.cid)"
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class QnSubmitWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll")]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'@

function Get-WindowTextValue([IntPtr]$Handle) {
  $value = [Text.StringBuilder]::new(512)
  [void][QnSubmitWin32]::GetWindowText($Handle, $value, $value.Capacity)
  $value.ToString()
}

function Get-WindowClassValue([IntPtr]$Handle) {
  $value = [Text.StringBuilder]::new(256)
  [void][QnSubmitWin32]::GetClassName($Handle, $value, $value.Capacity)
  $value.ToString()
}

try {
  Assert-ExpectedContext

  $processIds = @(Get-Process AliWorkbench,AliRender -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Id)
  if ($processIds.Count -eq 0) {
    throw 'No AliWorkbench or AliRender process is running.'
  }

  $windows = New-Object System.Collections.Generic.List[object]
  [QnSubmitWin32]::EnumWindows({
    param([IntPtr]$handle, [IntPtr]$lParam)
    $ownerPid = [uint32]0
    [void][QnSubmitWin32]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
    if ($processIds -contains [int]$ownerPid -and [QnSubmitWin32]::IsWindowVisible($handle)) {
      $rect = [QnSubmitWin32+RECT]::new()
      [void][QnSubmitWin32]::GetWindowRect($handle, [ref]$rect)
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      if ($width -gt 500 -and $height -gt 350) {
        $windows.Add([pscustomobject]@{
          Handle = $handle
          Pid = [int]$ownerPid
          Title = Get-WindowTextValue $handle
          Class = Get-WindowClassValue $handle
          Area = [long]$width * $height
        })
      }
    }
    $true
  }, [IntPtr]::Zero) | Out-Null

  $target = @($windows.ToArray()) |
    Sort-Object @{ Expression = { $_.Title -match '千牛接待台|千牛工作台|MutilChatView|聊天' }; Descending = $true }, Area -Descending |
    Select-Object -First 1
  if (-not $target) {
    throw 'No visible Qianniu top-level window was found on the interactive desktop.'
  }

  [void][QnSubmitWin32]::ShowWindow($target.Handle, 9)
  Start-Sleep -Milliseconds 250
  [void][QnSubmitWin32]::SetForegroundWindow($target.Handle)
  Start-Sleep -Milliseconds 350

  $foreground = [QnSubmitWin32]::GetForegroundWindow()
  $foregroundPid = [uint32]0
  [void][QnSubmitWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  if ($foreground -ne $target.Handle -or -not ($processIds -contains [int]$foregroundPid)) {
    throw "Qianniu did not become foreground. target=$($target.Handle) foreground=$foreground pid=$foregroundPid"
  }

  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Result "RESULT sent_enter pid=$($target.Pid) handle=$($target.Handle) class=$($target.Class) title=$($target.Title)"
  exit 0
} catch {
  Write-Result "RESULT failed error=$($_.Exception.Message)"
  exit 1
}
