param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('api', 'worker')]
    [string]$Service
)

$ErrorActionPreference = 'Stop'

if ($env:OPENLEDGER_CHAOS_ACK -ne 'local-test-only') {
    throw 'Set OPENLEDGER_CHAOS_ACK=local-test-only to confirm this is an isolated development stack.'
}

Write-Host "Restarting local Compose service: $Service"
docker compose kill $Service
if ($LASTEXITCODE -ne 0) { throw "Failed to stop $Service" }

docker compose up -d $Service
if ($LASTEXITCODE -ne 0) { throw "Failed to restart $Service" }

npm run ledger:check
if ($LASTEXITCODE -ne 0) { throw 'Ledger invariant check failed after service restart.' }

Write-Host 'Service restart completed and ledger invariants hold.'