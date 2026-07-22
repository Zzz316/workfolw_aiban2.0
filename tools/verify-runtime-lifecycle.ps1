<#
.SYNOPSIS
    Verify the AiBan Runtime lifecycle on Windows.

.DESCRIPTION
    Checks for existing AiBan Runner processes, runs the runtime test suite,
    and checks again for leaked processes.  The default executes the full
    Node.js regression suite, including the real Windows child-process test.

.PARAMETER SkipTests
    Only run the pre/post orphan-process scans.
#>

[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $repoRoot "node-red-contrib-aiban-workflow"
$scannerPath = Join-Path $PSScriptRoot "check-orphan-python.ps1"
$powershellExe = Join-Path $PSHOME "powershell.exe"
$startedAt = Get-Date
$testExitCode = 0
$postScanExitCode = 0

function Invoke-OrphanScan([string]$phase) {
    Write-Host ""
    Write-Host "[$phase] Checking AiBan Runner processes..." -ForegroundColor Cyan
    & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $scannerPath -Verbose | Out-Host
    return $LASTEXITCODE
}

$preScanExitCode = Invoke-OrphanScan "PRE"
if ($preScanExitCode -ne 0) {
    Write-Host "Pre-check failed. Stop or inspect existing AiBan Runner processes first." -ForegroundColor Red
    exit $preScanExitCode
}

try {
    if (-not $SkipTests) {
        Write-Host ""
        Write-Host "[TEST] Running full lifecycle regression..." -ForegroundColor Cyan
        Push-Location $packageRoot
        try {
            & npm.cmd test
            $testExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    }
} finally {
    $postScanExitCode = Invoke-OrphanScan "POST"
}

$elapsed = (Get-Date) - $startedAt
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Runtime Lifecycle Verification Summary" -ForegroundColor Cyan
Write-Host " Tests:       $(if ($SkipTests) { 'SKIPPED' } elseif ($testExitCode -eq 0) { 'PASS' } else { 'FAIL' })"
Write-Host " Orphan scan: $(if ($postScanExitCode -eq 0) { 'PASS' } else { 'FAIL' })"
Write-Host " Elapsed:     $([Math]::Round($elapsed.TotalSeconds, 1)) seconds"
Write-Host "========================================" -ForegroundColor Cyan

if ($testExitCode -ne 0) {
    exit $testExitCode
}
if ($postScanExitCode -ne 0) {
    exit $postScanExitCode
}
exit 0
