param(
  [string]$ShopName = '',
  [Parameter(Mandatory = $true)]
  [string]$ConversationName,
  [string]$Text = "codex-send-visible-$(Get-Date -Format 'HHmmss')",
  [switch]$Contains,
  [switch]$ShopContains,
  [string]$ExpectedCid = '',
  [string]$ExpectedLoginDisplay = '',
  [switch]$SkipTitleCheck,
  [int]$TimeoutSec = 25
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repoRoot

function Read-Tail([string]$Path, [int]$Count) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }
  return @(Get-Content -LiteralPath $Path -Tail $Count)
}

function Read-CurrentContext() {
  $contextText = & (Join-Path $repoRoot 'tools\qn-current-context.ps1') -Tail 500
  try {
    return ($contextText | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Context-Matches($Context) {
  if ($null -eq $Context -or -not $Context.found) {
    return $false
  }
  if ($ExpectedCid -and $Context.conversation.ccode -ne $ExpectedCid) {
    return $false
  }
  if ($ExpectedLoginDisplay -and $Context.login.display -ne $ExpectedLoginDisplay) {
    return $false
  }
  if (-not $ExpectedCid -and $ConversationName -and $Context.conversation.display -and $Context.conversation.display -ne $ConversationName) {
    return $false
  }
  return $true
}

$targetFile = Join-Path $repoRoot 'qn-target-conversation.txt'
$shopFile = Join-Path $repoRoot 'qn-target-shop.txt'
$switchLog = Join-Path $repoRoot 'qn-uia-switch-conversation.log'
Set-Content -LiteralPath $targetFile -Value $ConversationName -Encoding UTF8
Set-Content -LiteralPath $switchLog -Value "PENDING $(Get-Date -Format o) name=$ConversationName" -Encoding UTF8

if ($ShopName) {
  $shopLog = Join-Path $repoRoot 'qn-uia-switch-shop-tab.log'
  Set-Content -LiteralPath $shopFile -Value $ShopName -Encoding UTF8
  Set-Content -LiteralPath $shopLog -Value "PENDING $(Get-Date -Format o) name=$ShopName" -Encoding UTF8

  $shopContainsArg = if ($ShopContains) { ' -Contains' } else { '' }
  $shopTaskCmd = 'powershell.exe -NoP -EP Bypass -File "' +
    (Join-Path $repoRoot 'tools\qn-uia-switch-shop-tab.ps1') +
    '" -NameFile "qn-target-shop.txt" -OutFile "qn-uia-switch-shop-tab.log"' +
    $shopContainsArg

  Write-Output "SHOP $ShopName"
  & schtasks /Create /TN CodexQnSwitchShopTab /F /SC ONCE /ST 23:59 /IT /RL LIMITED /TR $shopTaskCmd | Write-Output
  if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Create shop switch failed with exit code $LASTEXITCODE"
  }

  & schtasks /Run /TN CodexQnSwitchShopTab | Write-Output
  if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Run shop switch failed with exit code $LASTEXITCODE"
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $shopDone = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $tail = Read-Tail $shopLog 30
    if ($tail -match '^END .* exit=0' -or $tail -match '^NOT_FOUND ') {
      $shopDone = $true
      break
    }
  }

  Write-Output '--- SHOP SWITCH LOG ---'
  $shopTail = Read-Tail $shopLog 80
  $shopTail | Write-Output

  if (-not $shopDone) {
    Write-Output "RESULT shop_switch_timeout after ${TimeoutSec}s"
    exit 8
  }
  if ($shopTail -match '^NOT_FOUND ') {
    Write-Output 'RESULT shop_not_found'
    exit 9
  }
}

$containsArg = if ($Contains) { ' -Contains' } else { '' }
$taskCmd = 'powershell.exe -NoP -EP Bypass -File "' +
  (Join-Path $repoRoot 'tools\qn-uia-switch-conversation.ps1') +
  '" -NameFile "qn-target-conversation.txt" -OutFile "qn-uia-switch-conversation.log"' +
  $containsArg

Write-Output "CONVERSATION $ConversationName"
Write-Output "TEXT $Text"

& schtasks /Create /TN CodexQnSwitchConversation /F /SC ONCE /ST 23:59 /IT /RL LIMITED /TR $taskCmd | Write-Output
if ($LASTEXITCODE -ne 0) {
  throw "schtasks /Create switch failed with exit code $LASTEXITCODE"
}

& schtasks /Run /TN CodexQnSwitchConversation | Write-Output
if ($LASTEXITCODE -ne 0) {
  throw "schtasks /Run switch failed with exit code $LASTEXITCODE"
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$switchDone = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $tail = Read-Tail $switchLog 30
  if ($tail -match '^END .* exit=0' -or $tail -match '^NOT_FOUND ') {
    $switchDone = $true
    break
  }
}

Write-Output '--- SWITCH LOG ---'
$switchTail = Read-Tail $switchLog 80
$switchTail | Write-Output

if (-not $switchDone) {
  Write-Output "RESULT switch_timeout after ${TimeoutSec}s"
  exit 3
}
if ($switchTail -match '^NOT_FOUND ') {
  Write-Output 'RESULT conversation_not_found'
  exit 2
}

$context = $null
if ($ExpectedCid -or $ExpectedLoginDisplay) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $context = Read-CurrentContext
    if (Context-Matches $context) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  $contextJson = if ($null -ne $context) { $context | ConvertTo-Json -Depth 8 -Compress } else { '' }
  Write-Output "PRE_SEND_CONTEXT $contextJson"
  if (-not (Context-Matches $context)) {
    Write-Output "RESULT pre_send_context_failed expectedCid=$ExpectedCid expectedLoginDisplay=$ExpectedLoginDisplay"
    exit 10
  }
}

$sendArgs = @{
  Text = $Text
  SendMethod = 'Enter'
  TimeoutSec = $TimeoutSec
}
if (-not $SkipTitleCheck) {
  $sendArgs.ExpectedTitle = $ConversationName
}
if ($ExpectedCid) {
  $sendArgs.ExpectedCid = $ExpectedCid
}
if ($ExpectedLoginDisplay) {
  $sendArgs.ExpectedLoginDisplay = $ExpectedLoginDisplay
}

& (Join-Path $repoRoot 'tools\qn-send-current.ps1') @sendArgs
exit $LASTEXITCODE
