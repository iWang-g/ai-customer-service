param(
  [string]$OutFile = '.\qn-uia-conversations.json'
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

$treeItemCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TreeItem
)
$items = $qnWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeItemCondition)

$rows = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $items.Count; $i++) {
  $item = $items.Item($i)
  $current = $item.Current
  if (-not $current.IsOffscreen -and $current.Name) {
    $rows.Add([pscustomobject]@{
      index = $rows.Count
      name = $current.Name
      isEnabled = [bool]$current.IsEnabled
      hasKeyboardFocus = [bool]$current.HasKeyboardFocus
      rect = Convert-Rect $current.BoundingRectangle
    })
  }
}

$result = [pscustomobject]@{
  generatedAt = Get-Date -Format o
  windowName = $qnWindow.Current.Name
  count = $rows.Count
  conversations = @($rows.ToArray())
}

$outPath = Resolve-RepoPath $OutFile
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outPath -Encoding UTF8
Write-Output "WROTE $outPath"
Write-Output "COUNT $($rows.Count)"
foreach ($row in $rows) {
  Write-Output ("ITEM index={0} name={1} rect={2},{3},{4},{5} focus={6}" -f $row.index, $row.name, $row.rect.left, $row.rect.top, $row.rect.width, $row.rect.height, $row.hasKeyboardFocus)
}
