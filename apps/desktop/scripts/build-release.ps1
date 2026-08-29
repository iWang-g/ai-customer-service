param(
    [string]$PythonExecutable = "python",
    [string]$RuntimeConfigFile = "config/release.json"
)

$ErrorActionPreference = "Stop"
$desktopDirectory = Split-Path -Parent $PSScriptRoot
$buildId = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDirectory = Join-Path "release-windows" $buildId

Push-Location $desktopDirectory
try {
    & node scripts/validate-release-config.mjs $RuntimeConfigFile
    if ($LASTEXITCODE -ne 0) { throw "Release configuration validation failed." }

    & pnpm build:icon
    if ($LASTEXITCODE -ne 0) { throw "Windows icon build failed." }

    & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-rpa.ps1 `
        -PythonExecutable $PythonExecutable
    if ($LASTEXITCODE -ne 0) { throw "RPA build failed." }

    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Desktop renderer build failed." }

    $absoluteRuntimeConfigFile = Resolve-Path $RuntimeConfigFile
    & pnpm exec electron-builder --win nsis `
        "--config.directories.output=$outputDirectory" `
        "--config.extraResources.1.from=$absoluteRuntimeConfigFile" `
        "--config.extraResources.1.to=runtime-config.json"
    if ($LASTEXITCODE -ne 0) { throw "NSIS installer build failed." }

    & node scripts/validate-package.mjs $outputDirectory $RuntimeConfigFile
    if ($LASTEXITCODE -ne 0) { throw "Windows package validation failed." }

    Write-Output "Release output: $(Join-Path $desktopDirectory $outputDirectory)"
} finally {
    Pop-Location
}
