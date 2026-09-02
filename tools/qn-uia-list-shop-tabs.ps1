param(
  [string]$OutFile = '.\qn-uia-shop-tabs.json'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Resolve-RepoPath([string]$Value) {
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

$windowRect = $qnWindow.Current.BoundingRectangle
$tabItemCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem
)
$items = $qnWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabItemCondition)

$tabs = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $items.Count; $i++) {
  $item = $items.Item($i)
  $current = $item.Current
  $rect = $current.BoundingRectangle
  $isTopShopTab = -not $current.IsOffscreen -and
    $current.Name -and
    $rect.Width -gt 40 -and
    $rect.Height -gt 20 -and
    $rect.Top -ge ($windowRect.Top - 5) -and
    $rect.Top -le ($windowRect.Top + 80)

  if ($isTopShopTab) {
    $tabs.Add([pscustomobject]@{
      index = $tabs.Count
      name = $current.Name
      isEnabled = [bool]$current.IsEnabled
      hasKeyboardFocus = [bool]$current.HasKeyboardFocus
      rect = Convert-Rect $rect
    })
  }
}

$result = [pscustomobject]@{
  generatedAt = Get-Date -Format o
  windowName = $qnWindow.Current.Name
  count = $tabs.Count
  tabs = @($tabs.ToArray())
}

$outPath = Resolve-RepoPath $OutFile
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outPath -Encoding UTF8
Write-Output "WROTE $outPath"
Write-Output "COUNT $($tabs.Count)"
foreach ($tab in $tabs) {
  Write-Output ("TAB index={0} name={1} rect={2},{3},{4},{5} focus={6}" -f $tab.index, $tab.name, $tab.rect.left, $tab.rect.top, $tab.rect.width, $tab.rect.height, $tab.hasKeyboardFocus)
}
