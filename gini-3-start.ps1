# GiNi - start everything (every time): opens 4 windows - API, engine, operator app, admin app - then the browser.
# Run from the project folder:   powershell -ExecutionPolicy Bypass -File .\gini-3-start.ps1
# Stop: close the 4 windows, or run  powershell -ExecutionPolicy Bypass -File .\gini-stop.ps1
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

function Wait-Url($url, $seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true } catch { Start-Sleep -Seconds 1 }
    }
    return $false
}
function Open-Window($title, $dir, $command) {
    $cmd = "`$host.UI.RawUI.WindowTitle = '$title'; Set-Location -LiteralPath '$dir'; Write-Host '$title - keep this window open (Ctrl+C or close it to stop)' -ForegroundColor Cyan; $command"
    Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) | Out-Null
}

$svc = Get-Service -Name MongoDB -ErrorAction SilentlyContinue
if (-not $svc -or $svc.Status -ne 'Running') { Write-Host "MongoDB is not running. Run gini-2-setup.ps1 first, or start the MongoDB service." -ForegroundColor Red; exit 1 }

if (Wait-Url 'http://localhost:5000/api/health' 1) { Write-Host "The API is already running on port 5000." -ForegroundColor Yellow }
else {
    Write-Host "Starting the API (port 5000)..."
    Open-Window 'GiNi API (port 5000)' (Join-Path $Root 'backend') 'npm.cmd start'
    if (-not (Wait-Url 'http://localhost:5000/api/health' 60)) { Write-Host "The API did not start within 60 s - look at the 'GiNi API' window for the error." -ForegroundColor Red; exit 1 }
}
Write-Host "API is up: http://localhost:5000/api/ready" -ForegroundColor Green

Write-Host "Starting the engine..."
Open-Window 'GiNi engine' (Join-Path $Root 'backend\python_engine') 'py -3.13 -m gini_engine'

Write-Host "Starting the operator app (port 5173) and the admin app (port 5174)..."
Open-Window 'GiNi operator app (port 5173)' (Join-Path $Root 'frontend') 'npm.cmd run dev'
Open-Window 'GiNi admin app (port 5174)' (Join-Path $Root 'admin') 'npm.cmd run dev'

if (Wait-Url 'http://localhost:5174' 90) {
    Start-Process 'http://localhost:5174'
    Write-Host ""
    Write-Host "RUNNING." -ForegroundColor Green
    Write-Host "  Admin app:    http://localhost:5174   (opened in your browser; ADMIN_LOGIN / ADMIN_PASSWORD from backend\.env)"
    Write-Host "  Operator app: http://localhost:5173   (the worker logins you created, or W0001 and its PIN in the synthetic demo)"
    $envFile = Join-Path $Root 'backend\.env'
    $fresh = (Test-Path $envFile) -and ((Get-Content $envFile) -match '^\s*GINI_ENVIRONMENT\s*=\s*"?FRESH_FACTORY')
    if ($fresh) { Write-Host "  FRESH FACTORY (team test, real time): workers sign in with the logins you create in the admin app." }
    else { Write-Host "  The simulation clock starts paused - press Play at the top of the admin app." }
} else {
    Write-Host "The admin app did not answer within 90 s - look at the 'GiNi admin app' window for the error." -ForegroundColor Red
}
