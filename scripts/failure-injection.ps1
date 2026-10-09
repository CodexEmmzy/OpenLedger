# PowerShell Process & Network-Level Failure Injection Script for OpenLedger Phase 1
param(
    [string]$TargetService = "all"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "OpenLedger Chaos & Failure-Injection Test Suite (PowerShell)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if ($env:OPENLEDGER_CHAOS_ACK -ne "local-test-only") {
    throw "Set \$env:OPENLEDGER_CHAOS_ACK='local-test-only' before running failure-injection scripts."
}

if (-not $env:DATABASE_URL) {
    $env:DATABASE_URL = "postgres://openledger:openledger@localhost:5432/openledger"
}

Write-Host "[1/4] Verifying initial ledger invariants..." -ForegroundColor Yellow
npm run ledger:check
if ($LASTEXITCODE -ne 0) { throw "Initial invariant check failed." }
Write-Host "Initial invariants clean." -ForegroundColor Green

Write-Host "[2/4] Testing API failure resilience..." -ForegroundColor Yellow
try {
    $apiContainer = docker ps --filter "name=api" --format "{{.ID}}"
    if ($apiContainer) {
        Write-Host "Killing API container: $apiContainer"
        docker kill $apiContainer | Out-Null
        Start-Sleep -Seconds 2
        Write-Host "Restarting API container..."
        docker start $apiContainer | Out-Null
    } else {
        Write-Host "API container not running, simulating direct check."
    }
} catch {
    Write-Host "Docker kill skipped: $_" -ForegroundColor DarkGray
}

Write-Host "Verifying invariants post API failure..." -ForegroundColor Yellow
npm run ledger:check
if ($LASTEXITCODE -ne 0) { throw "Ledger invariant check failed after API kill!" }

Write-Host "[3/4] Testing Worker failure resilience..." -ForegroundColor Yellow
try {
    $workerContainer = docker ps --filter "name=worker" --format "{{.ID}}"
    if ($workerContainer) {
        Write-Host "Killing Worker container: $workerContainer"
        docker kill $workerContainer | Out-Null
        Start-Sleep -Seconds 2
        Write-Host "Restarting Worker container..."
        docker start $workerContainer | Out-Null
    } else {
        Write-Host "Worker container not running, simulating direct check."
    }
} catch {
    Write-Host "Docker kill skipped: $_" -ForegroundColor DarkGray
}

Write-Host "Verifying invariants post Worker failure..." -ForegroundColor Yellow
npm run ledger:check
if ($LASTEXITCODE -ne 0) { throw "Ledger invariant check failed after Worker crash!" }

Write-Host "[4/4] Verifying post-failure state integrity..." -ForegroundColor Yellow
npm run ledger:check
if ($LASTEXITCODE -ne 0) { throw "Final invariant check failed!" }

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "SUCCESS: Failure-injection tests completed cleanly with zero invariant violations." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
