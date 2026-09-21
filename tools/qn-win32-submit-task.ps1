$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$requestFile = Join-Path $repoRoot '.tmp\qn-win32-submit\request.json'
$request = $null

try {
  $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  & (Join-Path $repoRoot 'tools\qn-win32-submit-enter.ps1') `
    -OutFile $request.resultLog `
    -BridgeBase $request.bridgeBase `
    -ClientId $request.clientId `
    -ExpectedShopTargetId $request.expectedShopTargetId `
    -ExpectedTargetId $request.expectedTargetId `
    -ExpectedCid $request.expectedCid
  exit $LASTEXITCODE
} catch {
  $message = "$(Get-Date -Format o) RESULT failed error=$($_.Exception.Message)"
  if ($null -ne $request -and $request.resultLog) {
    Set-Content -LiteralPath $request.resultLog -Value $message -Encoding UTF8
  }
  Write-Error $message
  exit 1
}
