# GiNi - step 1 (once): switch on replica-set mode in the local MongoDB service.
# Needs administrator rights because MongoDB's settings file is in C:\Program Files. Windows will ask you to approve.
# Run from the project folder:   powershell -ExecutionPolicy Bypass -File .\gini-1-enable-replica-set.ps1
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Asking Windows for administrator permission (click Yes in the prompt)..." -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$svc = Get-Service -Name MongoDB -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "MongoDB is not installed as a Windows service yet." -ForegroundColor Red
    Write-Host "Install MongoDB Community Server first (see GINI-LOCAL-SETUP.txt), then run this again."
    exit 1
}

# find the settings file the service actually uses
$svcInfo = Get-CimInstance Win32_Service -Filter "Name='MongoDB'"
$cfg = $null
if ($svcInfo.PathName -match '--config\s+"([^"]+)"') { $cfg = $matches[1] }
elseif ($svcInfo.PathName -match '--config\s+(\S+)') { $cfg = $matches[1] }
if (-not $cfg -or -not (Test-Path $cfg)) {
    $cfg = (Get-ChildItem 'C:\Program Files\MongoDB\Server\*\bin\mongod.cfg' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1).FullName
}
if (-not $cfg) { Write-Host "Could not find mongod.cfg" -ForegroundColor Red; exit 1 }
Write-Host "MongoDB settings file: $cfg"

$text = Get-Content $cfg -Raw
if ($text -match '(?m)^replication:') {
    Write-Host "Replica-set mode is already in the settings file." -ForegroundColor Green
} else {
    Copy-Item $cfg "$cfg.before-gini" -Force
    Add-Content -Path $cfg -Value "`r`nreplication:`r`n  replSetName: rs0`r`n"
    Write-Host "Added 'replication: replSetName: rs0' (backup saved as mongod.cfg.before-gini)." -ForegroundColor Green
}

Write-Host "Restarting the MongoDB service..."
Restart-Service -Name MongoDB
Start-Sleep -Seconds 5
$svc = Get-Service -Name MongoDB
if ($svc.Status -ne 'Running') {
    Write-Host "MongoDB did not start again. Restoring the previous settings file." -ForegroundColor Red
    if (Test-Path "$cfg.before-gini") { Copy-Item "$cfg.before-gini" $cfg -Force; Start-Service MongoDB }
    exit 1
}
Write-Host "Done: MongoDB is running with replica-set mode switched on. You can close this window." -ForegroundColor Green
Write-Host "Next, in VS Code:  powershell -ExecutionPolicy Bypass -File .\gini-2-setup.ps1"
