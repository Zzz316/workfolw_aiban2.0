<#
.SYNOPSIS
    Check for orphaned Python/aiBan processes on Windows.

.DESCRIPTION
    After Node-RED stops or aiban-runtime nodes are deleted, no Python
    or AiBan child processes should remain.  This script enumerates all
    python.exe processes (and their children) that match the AiBan
    runner pattern (aiban_runner.py in command line).

    It is designed for manual pre/post-deployment verification and can
    also be run in CI after test suites to detect leaks.

.PARAMETER Kill
    If specified, orphan processes are terminated after reporting.

.PARAMETER Verbose
    Show full command line for each process.

.EXAMPLE
    # Check only
    powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1

.EXAMPLE
    # Check and kill orphans
    powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1 -Kill

.EXAMPLE
    # Show detailed process info
    powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1 -Verbose

.NOTES
    Requires PowerShell 5.1 or later.  Run as the same user that launched
    Node-RED / Python, otherwise Get-WmiObject may lack permissions.
#>

param(
    [switch]$Kill,
    [switch]$Verbose
)

$ErrorActionPreference = "Continue"
$found = $false
$killed = 0
$total = 0

Write-Host "========================================"  -ForegroundColor Cyan
Write-Host " AiBan Orphan Python Process Scanner"     -ForegroundColor Cyan
Write-Host " Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "========================================"  -ForegroundColor Cyan
Write-Host ""

# ---- Method 1: Get-CimInstance (preferred on Win10+ / PS 5.1+) ----
$procs = $null
try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction Stop
} catch {
    Write-Host "  Get-CimInstance failed: $_" -ForegroundColor Yellow
}

if (-not $procs) {
    # Fallback: Get-Process + WMI for command line
    Write-Host "  Trying fallback via Get-Process..." -ForegroundColor Yellow
    try {
        $gprocs = Get-Process -Name "python" -ErrorAction SilentlyContinue
        $procs = @()
        foreach ($p in $gprocs) {
            try {
                $wmi = Get-WmiObject Win32_Process -Filter "ProcessId = $($p.Id)"
                if ($wmi) { $procs += $wmi }
            } catch {}
        }
    } catch {
        Write-Host "  Fallback also failed: $_" -ForegroundColor Yellow
    }
}

if (-not $procs -or $procs.Count -eq 0) {
    Write-Host "  No python.exe processes found." -ForegroundColor Green
    exit 0
}

Write-Host "  Found $($procs.Count) python.exe process(es)." -ForegroundColor White
Write-Host ""

# ---- Inspect each process ----
foreach ($proc in $procs) {
    $total++
    $cmd = $proc.CommandLine
    if (-not $cmd) { $cmd = "" }

    # Check if this is an AiBan runner process
    $isAiban = $cmd -match "aiban_runner\.py"

    if ($isAiban) {
        $found = $true
        $parentId = $proc.ParentProcessId
        $pid = $proc.ProcessId

        # Check if parent is still alive
        $parentAlive = $false
        try {
            $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
            if ($parent) { $parentAlive = $true }
        } catch {}

        $status = if ($parentAlive) { "PARENT ALIVE" } else { "ORPHANED" }
        $color = if ($parentAlive) { "Yellow" } else { "Red" }

        Write-Host "  [$status] PID=$pid, ParentPID=$parentId" -ForegroundColor $color
        if ($Verbose) {
            $shortCmd = if ($cmd.Length -gt 200) { $cmd.Substring(0, 200) + "..." } else { $cmd }
            Write-Host "    CmdLine: $shortCmd" -ForegroundColor Gray
        }

        if ($Kill -and -not $parentAlive) {
            try {
                Stop-Process -Id $pid -Force -ErrorAction Stop
                Write-Host "    → KILLED" -ForegroundColor Green
                $killed++
            } catch {
                Write-Host "    → FAILED to kill: $_" -ForegroundColor Red
            }
        }
    } else {
        # Regular python.exe — just note it
        if ($Verbose) {
            $shortCmd = if ($cmd.Length -gt 160) { $cmd.Substring(0, 160) + "..." } else { $cmd }
            Write-Host "  [other] PID=$($proc.ProcessId): $shortCmd" -ForegroundColor DarkGray
        }
    }
}

Write-Host ""
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "  Total python.exe:     $total"          -ForegroundColor White
Write-Host "  AiBan runner procs:   $(if ($found) { 'YES' } else { 'NONE' })" -ForegroundColor $(if ($found) { 'Yellow' } else { 'Green' })

if ($Kill) {
    Write-Host "  Killed orphans:       $killed" -ForegroundColor $(if ($killed -gt 0) { 'Green' } else { 'Gray' })
}

Write-Host "----------------------------------------" -ForegroundColor Cyan

if ($found -and -not $Kill) {
    Write-Host ""
    Write-Host "  ⚠ Orphan processes detected!" -ForegroundColor Yellow
    Write-Host "  Re-run with -Kill to terminate them, or inspect manually." -ForegroundColor Yellow
    Write-Host "  Command: powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1 -Kill" -ForegroundColor Gray
    exit 2
} elseif ($found -and $Kill -and $killed -gt 0) {
    Write-Host ""
    Write-Host "  ✓ Killed $killed orphan process(es)." -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "  ✓ No orphan AiBan processes found." -ForegroundColor Green
    exit 0
}
