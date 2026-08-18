param(
    [string]$PythonExecutable = "python"
)

$ErrorActionPreference = "Stop"
$desktopDirectory = Split-Path -Parent $PSScriptRoot
$repositoryDirectory = Resolve-Path (Join-Path $desktopDirectory "..\..")
$agentDirectory = Join-Path $repositoryDirectory "agents\rpa"
$temporaryDirectory = Join-Path $repositoryDirectory ".tmp\pyinstaller-rpa"
$distDirectory = Join-Path $agentDirectory "dist"

& $PythonExecutable -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is missing. Run: python -m pip install pyinstaller==6.16.0"
}

New-Item -ItemType Directory -Force -Path $temporaryDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $distDirectory | Out-Null

& $PythonExecutable -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --noupx `
    --name "rpa-agent" `
    --distpath $distDirectory `
    --workpath (Join-Path $temporaryDirectory "work") `
    --specpath $temporaryDirectory `
    (Join-Path $agentDirectory "agent.py")
if ($LASTEXITCODE -ne 0) {
    throw "Failed to build the RPA executable."
}

$executablePath = Join-Path $distDirectory "rpa-agent.exe"
if (-not (Test-Path -LiteralPath $executablePath)) {
    throw "RPA build output was not found: $executablePath"
}
Write-Output "RPA executable created: $executablePath"
