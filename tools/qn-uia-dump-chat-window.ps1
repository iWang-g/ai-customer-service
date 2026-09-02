param(
  [string]$OutFile = '.\qn-uia-visible-dump.json',
  [int]$MaxDepth = 18,
  [int]$MaxNodes = 30000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Resolve-PathFromRepo([string]$Value) {
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
  if ([IO.Path]::IsPathRooted($Value)) {
    return $Value
  }
  return Join-Path $repoRoot $Value
}

function Convert-Rect($Rect) {
  @{
    left = [int]$Rect.Left
    top = [int]$Rect.Top
    width = [int]$Rect.Width
    height = [int]$Rect.Height
    right = [int]($Rect.Left + $Rect.Width)
    bottom = [int]($Rect.Top + $Rect.Height)
  }
}

function Get-Node($Element, [int]$Depth) {
  $current = $Element.Current
  @{
    depth = $Depth
    processId = [int]$current.ProcessId
    name = $current.Name
    automationId = $current.AutomationId
    className = $current.ClassName
    frameworkId = $current.FrameworkId
    controlType = $current.ControlType.ProgrammaticName
    localizedControlType = $current.LocalizedControlType
    isEnabled = [bool]$current.IsEnabled
    isOffscreen = [bool]$current.IsOffscreen
    isKeyboardFocusable = [bool]$current.IsKeyboardFocusable
    hasKeyboardFocus = [bool]$current.HasKeyboardFocus
    rect = Convert-Rect $current.BoundingRectangle
  }
}

function Add-Descendants($Element, [int]$Depth, [System.Collections.Generic.List[object]]$Output) {
  if ($Depth -gt $MaxDepth -or $Output.Count -ge $MaxNodes) {
    return
  }

  try {
    $Output.Add((Get-Node $Element $Depth))
  } catch {
    return
  }

  $children = $Element.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  for ($i = 0; $i -lt $children.Count -and $Output.Count -lt $MaxNodes; $i++) {
    Add-Descendants $children.Item($i) ($Depth + 1) $Output
  }
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
  throw 'UIA window not found: className=MutilChatView.'
}

$nodes = New-Object System.Collections.Generic.List[object]
Add-Descendants $qnWindow 0 $nodes

$windowRect = $qnWindow.Current.BoundingRectangle
$allNodes = @($nodes.ToArray())
$visibleNamedNodes = @(
  $allNodes | Where-Object {
    -not $_.isOffscreen -and
    $_.rect.width -gt 0 -and
    $_.rect.height -gt 0 -and
    ($_.name -or $_.automationId -or $_.className -eq 'TextRichEdit')
  }
)

$leftPanelNodes = @(
  $visibleNamedNodes | Where-Object {
    $_.rect.left -ge ($windowRect.Left + 40) -and
    $_.rect.left -le ($windowRect.Left + 360) -and
    $_.rect.top -ge ($windowRect.Top + 100)
  }
)

$result = @{
  generatedAt = (Get-Date -Format o)
  window = Get-Node $qnWindow 0
  counts = @{
    all = $allNodes.Count
    visibleNamed = $visibleNamedNodes.Count
    leftPanel = $leftPanelNodes.Count
  }
  leftPanel = $leftPanelNodes
  visibleNamed = $visibleNamedNodes
}

$outPath = Resolve-PathFromRepo $OutFile
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null
$result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $outPath -Encoding UTF8
Write-Output "WROTE $outPath"
Write-Output ("COUNTS all={0} visibleNamed={1} leftPanel={2}" -f $allNodes.Count, $visibleNamedNodes.Count, $leftPanelNodes.Count)
