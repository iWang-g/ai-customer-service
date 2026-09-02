param(
  [string]$OutDir = 'D:\packet-capture',
  [int]$MaxDepth = 14,
  [int]$MaxNodesPerWindow = 20000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public class QnWindowInfo {
  public int Pid { get; set; }
  public long Handle { get; set; }
  public bool Visible { get; set; }
  public string ClassName { get; set; }
  public string Title { get; set; }
  public int Left { get; set; }
  public int Top { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
}

public static class QnDesktopProbeWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  private static string GetText(IntPtr hWnd, bool className) {
    var sb = new StringBuilder(512);
    if (className) GetClassName(hWnd, sb, sb.Capacity);
    else GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static List<QnWindowInfo> ListTopWindows() {
    var list = new List<QnWindowInfo>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      RECT rect;
      GetWindowRect(hWnd, out rect);
      list.Add(new QnWindowInfo {
        Pid = (int)pid,
        Handle = hWnd.ToInt64(),
        Visible = IsWindowVisible(hWnd),
        ClassName = GetText(hWnd, true),
        Title = GetText(hWnd, false),
        Left = rect.Left,
        Top = rect.Top,
        Width = rect.Right - rect.Left,
        Height = rect.Bottom - rect.Top
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static List<QnWindowInfo> ListChildWindows(long parentHandle) {
    var list = new List<QnWindowInfo>();
    EnumChildWindows(new IntPtr(parentHandle), delegate(IntPtr hWnd, IntPtr lParam) {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      RECT rect;
      GetWindowRect(hWnd, out rect);
      list.Add(new QnWindowInfo {
        Pid = (int)pid,
        Handle = hWnd.ToInt64(),
        Visible = IsWindowVisible(hWnd),
        ClassName = GetText(hWnd, true),
        Title = GetText(hWnd, false),
        Left = rect.Left,
        Top = rect.Top,
        Width = rect.Right - rect.Left,
        Height = rect.Bottom - rect.Top
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

function Convert-BoundingRect($Rect) {
  @{
    left = $Rect.Left
    top = $Rect.Top
    width = $Rect.Width
    height = $Rect.Height
  }
}

function Get-UiaNodeInfo($Element, [int]$Depth) {
  $current = $Element.Current
  @{
    depth = $Depth
    processId = $current.ProcessId
    name = $current.Name
    automationId = $current.AutomationId
    className = $current.ClassName
    frameworkId = $current.FrameworkId
    controlType = $current.ControlType.ProgrammaticName
    localizedControlType = $current.LocalizedControlType
    isEnabled = $current.IsEnabled
    isOffscreen = $current.IsOffscreen
    isKeyboardFocusable = $current.IsKeyboardFocusable
    boundingRectangle = Convert-BoundingRect $current.BoundingRectangle
  }
}

function Add-UiaDescendants($Element, [int]$Depth, [System.Collections.Generic.List[object]]$Output, [int]$MaxDepth, [int]$MaxNodes) {
  if ($Depth -gt $MaxDepth -or $Output.Count -ge $MaxNodes) {
    return
  }

  try {
    $Output.Add((Get-UiaNodeInfo $Element $Depth))
  } catch {
    return
  }

  if ($Depth -eq $MaxDepth) {
    return
  }

  $children = $Element.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  for ($i = 0; $i -lt $children.Count -and $Output.Count -lt $MaxNodes; $i++) {
    Add-UiaDescendants $children.Item($i) ($Depth + 1) $Output $MaxDepth $MaxNodes
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $OutDir "qn-desktop-probe-$stamp.json"

$qnProcesses = Get-Process AliWorkbench,AliRender -ErrorAction SilentlyContinue |
  Select-Object ProcessName,Id,SessionId,MainWindowHandle,Path
$qnPids = @($qnProcesses | Select-Object -ExpandProperty Id)
$qnProcessesSimple = @(
  $qnProcesses | ForEach-Object {
    [pscustomobject]@{
      processName = $_.ProcessName
      id = [int]$_.Id
      sessionId = [int]$_.SessionId
      mainWindowHandle = $_.MainWindowHandle.ToString()
      path = $_.Path
    }
  }
)

$topWindows = [QnDesktopProbeWin32]::ListTopWindows() |
  ForEach-Object {
    $proc = Get-Process -Id $_.Pid -ErrorAction SilentlyContinue
    [pscustomobject]@{
      pid = $_.Pid
      processName = $proc.ProcessName
      path = $(try { $proc.Path } catch { $null })
      handle = ('0x{0:X}' -f $_.Handle)
      handleValue = $_.Handle
      visible = $_.Visible
      className = $_.ClassName
      title = $_.Title
      left = $_.Left
      top = $_.Top
      width = $_.Width
      height = $_.Height
      isQnProcess = $qnPids -contains $_.Pid
    }
  }

$candidateWindows = @(
  $topWindows | Where-Object {
    $_.isQnProcess -or
    $_.title -match '千牛|旺旺|聊天|Qianniu|AliWorkbench|AliRender|淘宝|天猫' -or
    $_.className -match 'Chrome|Cef|Qt|Ali'
  }
)

$qnTopWindows = @($topWindows | Where-Object { $_.isQnProcess })
$candidateTopWindows = @($candidateWindows | Select-Object -First 200)

$uiaWindows = New-Object System.Collections.Generic.List[object]
$root = [System.Windows.Automation.AutomationElement]::RootElement
$rootChildren = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition
)

for ($i = 0; $i -lt $rootChildren.Count; $i++) {
  $child = $rootChildren.Item($i)
  $info = Get-UiaNodeInfo $child 0
  if (($qnPids -contains $info.processId) -or
      ($info.name -match '千牛|旺旺|聊天|Qianniu|AliWorkbench|AliRender|淘宝|天猫')) {
    $nodes = New-Object System.Collections.Generic.List[object]
    Add-UiaDescendants $child 0 $nodes $MaxDepth $MaxNodesPerWindow
    $interestingNodes = @(
      $nodes | Where-Object {
        $_.controlType -match 'Edit|Document|Text|Pane|Button' -or
        $_.localizedControlType -match '编辑|文档|文本|窗格|按钮' -or
        $_.name -match '发送|输入|消息|聊天'
      }
    )
    $windowEntry = [pscustomobject]@{
      root = $info
      nodes = @($nodes.ToArray())
      interestingNodes = $interestingNodes
    }
    $uiaWindows.Add([object]$windowEntry)
  }
}

$result = [System.Collections.Specialized.OrderedDictionary]::new()
$result.Add('time', (Get-Date).ToString('o'))
$result.Add('currentProcess', @{
  pid = $PID
  sessionId = (Get-Process -Id $PID).SessionId
})
$result.Add('qnProcesses', [object]([object[]]$qnProcessesSimple))
$result.Add('topWindowCount', @($topWindows).Count)
$result.Add('qnTopWindows', [object]([object[]]$qnTopWindows))
$result.Add('candidateTopWindows', [object]([object[]]$candidateTopWindows))
$result.Add('uiaRootChildCount', $rootChildren.Count)
$result.Add('uiaCandidateWindows', [object]([object[]]$uiaWindows.ToArray()))

$json = $result | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $outFile -Value $json -Encoding UTF8

Write-Host "Wrote $outFile"
Write-Host "AliWorkbench/AliRender processes: $(@($qnProcesses).Count)"
Write-Host "Top windows visible to this process: $(@($topWindows).Count)"
Write-Host "Top windows owned by Qianniu processes: $(@($result.qnTopWindows).Count)"
Write-Host "UIA root children: $($rootChildren.Count)"
Write-Host "UIA candidate windows: $($uiaWindows.Count)"

if ($uiaWindows.Count -gt 0) {
  $uiaWindows |
    ForEach-Object { $_.interestingNodes } |
    Select-Object depth,processId,controlType,localizedControlType,name,automationId,className,isKeyboardFocusable,isOffscreen,boundingRectangle |
    Format-Table -AutoSize -Wrap
}
