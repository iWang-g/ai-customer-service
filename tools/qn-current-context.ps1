param(
  [string]$HookLog = '.\qn-im-bridge-hook-events.ndjson',
  [int]$Tail = 300
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repoRoot

function Resolve-RepoPath([string]$Value) {
  if ([IO.Path]::IsPathRooted($Value)) {
    return $Value
  }
  return Join-Path $repoRoot $Value
}

function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) {
    return $null
  }
  if ($Object.PSObject.Properties.Name -contains $Name) {
    return $Object.$Name
  }
  return $null
}

$path = Resolve-RepoPath $HookLog
if (-not (Test-Path -LiteralPath $path)) {
  Write-Output (@{
    found = $false
    reason = 'hook_log_not_found'
    path = $path
  } | ConvertTo-Json -Depth 8)
  exit 1
}

$lines = @(Get-Content -LiteralPath $path -Tail $Tail -Encoding UTF8)
$latestAny = $null
for ($i = $lines.Count - 1; $i -ge 0; $i--) {
  $line = $lines[$i]
  try {
    $event = $line | ConvertFrom-Json
    $bodyText = Get-Prop $event 'body'
    if (-not $bodyText) {
      continue
    }
    $body = $bodyText | ConvertFrom-Json
    $state = Get-Prop $body 'state'
    if ($null -eq $state) {
      continue
    }

    $conversation = Get-Prop $state 'conversationID'
    $login = Get-Prop $state 'loginID'
    $ccode = Get-Prop $conversation 'ccode'
    $display = Get-Prop $conversation 'display'
    $nick = Get-Prop $conversation 'nick'
    $targetId = Get-Prop $conversation 'targetId'
    $loginDisplay = Get-Prop $login 'display'
    $loginNick = Get-Prop $login 'nick'
    $loginTargetId = Get-Prop $login 'targetId'
    $loginMainId = Get-Prop $login 'havMainId'

    if ($ccode -or $loginDisplay -or $loginNick) {
      $candidate = @{
        found = $true
        eventTime = Get-Prop $event 'time'
        bodyAt = Get-Prop $body 'at'
        kind = Get-Prop $body 'kind'
        namespace = Get-Prop $body 'namespace'
        cmd = Get-Prop $body 'cmd'
        method = Get-Prop $body 'method'
        conversation = @{
          ccode = $ccode
          display = $display
          nick = $nick
          targetId = $targetId
        }
        login = @{
          display = $loginDisplay
          nick = $loginNick
          targetId = $loginTargetId
          havMainId = $loginMainId
        }
      }

      if ($null -eq $latestAny) {
        $latestAny = $candidate
      }
      if ($ccode) {
        Write-Output ($candidate | ConvertTo-Json -Depth 8)
        exit 0
      }
    }
  } catch {
    continue
  }
}

if ($null -ne $latestAny) {
  Write-Output ($latestAny | ConvertTo-Json -Depth 8)
  exit 0
}

Write-Output (@{
  found = $false
  reason = 'context_not_found'
  path = $path
  tail = $Tail
} | ConvertTo-Json -Depth 8)
exit 2
