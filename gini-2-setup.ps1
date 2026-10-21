# GiNi - step 2 (once): check the tools, connect to the local MongoDB, finish the .env files, install packages,
# load the three Final workbooks into the database, create the accounts and the default simulation session.
# No virtual environment is used. Safe to run again: nothing is duplicated.
# Run from the project folder in VS Code:   powershell -ExecutionPolicy Bypass -File .\gini-2-setup.ps1
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$EnvApi = Join-Path $Backend '.env'
$EnvEngine = Join-Path $Backend 'python_engine\.env'
$LocalUri = 'mongodb://localhost:27017/?replicaSet=rs0'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Step($n, $text) { Write-Host ""; Write-Host "==== $n. $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  STOPPED: $text" -ForegroundColor Red; exit 1 }
function Run($what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). Copy the red text above into the chat (no passwords)." }
}
function Read-Env($file) {
    $map = [ordered]@{}
    if (Test-Path $file) {
        foreach ($line in [IO.File]::ReadAllLines($file)) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $map[$matches[1]] = $matches[2].Trim().Trim('"') }
        }
    }
    return $map
}
function Set-EnvValue($file, $key, $value) {
    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path $file) { $lines.AddRange([string[]][IO.File]::ReadAllLines($file)) }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$key\s*=") { $lines[$i] = "$key=$value"; $found = $true }
    }
    if (-not $found) { $lines.Add("$key=$value") }
    [IO.File]::WriteAllLines($file, $lines.ToArray(), $Utf8)
}
function New-Secret { -join ((1..48) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
function Bad($v, $min) { return (-not $v) -or ($v.Length -lt $min) -or ($v -match 'GENERATE|REPLACE_ME|YOUR_|SEED_ONLY_PASSPHRASE|SAME_SERVER') }

# ------------------------------------------------------------------------------------------------------------
Step 1 'Checking the installed tools'
try { $nodeV = (& node --version) } catch { Fail "Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and open a new terminal." }
if ($nodeV -notmatch '^v22\.') { Write-Host "  WARNING: Node.js $nodeV found; this project is built and tested for Node.js 22." -ForegroundColor Yellow } else { Ok "Node.js $nodeV" }
try { $pyV = (& py -3.13 --version) } catch { $pyV = $null }
if (-not $pyV) { Fail "Python 3.13 is not installed. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') and open a new terminal." }
Ok $pyV
$svc = Get-Service -Name MongoDB -ErrorAction SilentlyContinue
if (-not $svc) { Fail "MongoDB is not installed. See GINI-LOCAL-SETUP.txt, step A." }
if ($svc.Status -ne 'Running') { Fail "The MongoDB service is $($svc.Status). Start it: open PowerShell as administrator and run  Start-Service MongoDB" }
Ok "MongoDB service is running"

Step 2 'Installing the Python packages (directly into Python 3.13, no virtual environment)'
Run 'pip install' { py -3.13 -m pip install --disable-pip-version-check -q pymongo==4.10.1 dnspython==2.7.0 openpyxl==3.1.5 }
Ok "pymongo, dnspython, openpyxl"

Step 3 'Connecting to the local MongoDB and switching on the replica set'
& py -3.13 (Join-Path $Root 'mongo_local.py') init
if ($LASTEXITCODE -eq 3) { Fail "Run  powershell -ExecutionPolicy Bypass -File .\gini-1-enable-replica-set.ps1  first (approve the Windows prompt), then run this script again." }
if ($LASTEXITCODE -ne 0) { Fail "MongoDB is not ready (see the message above)." }

Step 4 'Finishing the .env files (values are written to the files, never printed)'
if (-not (Test-Path $EnvApi)) { Fail "backend\.env is missing. Copy backend\.env.example to backend\.env first." }
$api = Read-Env $EnvApi
if (($api['GINI_ENVIRONMENT'] + '').ToUpper() -eq 'FRESH_FACTORY') { Fail "backend\.env is set to the FRESH FACTORY (GINI_ENVIRONMENT=FRESH_FACTORY). This script loads the SYNTHETIC demo workbooks and is not used for the fresh factory - run gini-fresh-setup.ps1 instead. To go back to the synthetic demo, see FRESH_FACTORY_SETUP.md (section 'Returning to the synthetic demonstration')." }
if ($api['MONGODB_URI'] -ne $LocalUri) {
    $backup = "$EnvApi.backup-before-local-mongodb"
    if (-not (Test-Path $backup)) { Copy-Item $EnvApi $backup }
    Set-EnvValue $EnvApi 'MONGODB_URI' $LocalUri
    Ok "backend\.env now uses the local MongoDB (your previous file is kept as backend\.env.backup-before-local-mongodb)"
} else { Ok "backend\.env already uses the local MongoDB" }
if (Bad $api['MONGODB_DB_NAME'] 1) { Set-EnvValue $EnvApi 'MONGODB_DB_NAME' 'gini_demo_dev'; Ok "MONGODB_DB_NAME set to gini_demo_dev" }
if (Bad $api['SESSION_SECRET'] 32) { Set-EnvValue $EnvApi 'SESSION_SECRET' (New-Secret); Ok "SESSION_SECRET generated (64+ random characters)" }
if (Bad $api['INTERNAL_SERVICE_TOKEN'] 32) { Set-EnvValue $EnvApi 'INTERNAL_SERVICE_TOKEN' (New-Secret); Ok "INTERNAL_SERVICE_TOKEN generated" }
if ($api['NODE_ENV'] -eq 'production') { Set-EnvValue $EnvApi 'NODE_ENV' 'development'; Ok "NODE_ENV set to development (local run)" }
if (@('capture', 'smtp', 'disabled') -notcontains $api['EMAIL_MODE']) { Set-EnvValue $EnvApi 'EMAIL_MODE' 'capture'; Ok "EMAIL_MODE set to capture (no email is sent)" }
if ($api['EVIDENCE_STORAGE_MODE'] -ne 'local' -and (Bad $api['CLOUDINARY_API_SECRET'] 8)) { Set-EnvValue $EnvApi 'EVIDENCE_STORAGE_MODE' 'local'; Ok "EVIDENCE_STORAGE_MODE set to local (photos stored on this computer)" }
$api = Read-Env $EnvApi
$problems = @()
if (Bad $api['DEMO_PIN_SEED'] 12) { $problems += "DEMO_PIN_SEED must be your own value of at least 12 characters" }
if (Bad $api['ADMIN_PASSWORD'] 15) { $problems += "ADMIN_PASSWORD must be your own password of at least 15 characters" }
if (-not $api['ADMIN_LOGIN']) { $problems += "ADMIN_LOGIN is empty (for example: admin)" }
if ($problems.Count) { Fail ("Please edit backend\.env and fix: " + ($problems -join '; ') + ". Then run this script again.") }
Ok "backend\.env has DEMO_PIN_SEED, ADMIN_LOGIN and ADMIN_PASSWORD"

# the engine's .env: created from the example; shares the database and the server-to-server token with the API
if (-not (Test-Path $EnvEngine)) { Copy-Item (Join-Path $Backend 'python_engine\.env.example') $EnvEngine; Ok "created backend\python_engine\.env from its example" }
Set-EnvValue $EnvEngine 'APP_ENV' 'development'
Set-EnvValue $EnvEngine 'MONGODB_URI' $LocalUri
Set-EnvValue $EnvEngine 'MONGODB_DB_NAME' $api['MONGODB_DB_NAME']
Set-EnvValue $EnvEngine 'INTERNAL_SERVICE_TOKEN' $api['INTERNAL_SERVICE_TOKEN']
Set-EnvValue $EnvEngine 'NODE_API_INTERNAL_URL' ('http://localhost:' + $(if ($api['PORT']) { $api['PORT'] } else { '5000' }))
Ok "backend\python_engine\.env matches the API (same database, same internal token)"
foreach ($app in 'frontend', 'admin') {
    $f = Join-Path $Root "$app\.env"
    if (-not (Test-Path $f)) { Copy-Item (Join-Path $Root "$app\.env.example") $f; Ok "created $app\.env from its example" }
}

Step 5 'Installing the Node.js packages (backend, operator app, admin app) - a few minutes the first time'
foreach ($dir in 'backend', 'frontend', 'admin') {
    Push-Location (Join-Path $Root $dir)
    # the backend's only dev package is the test browser driver, which running the app does not need
    try { if ($dir -eq 'backend') { Run "npm install in $dir" { npm.cmd install --omit=dev --no-audit --no-fund } } else { Run "npm install in $dir" { npm.cmd install --no-audit --no-fund } } } finally { Pop-Location }
    Ok "$dir packages installed"
}

# put the API .env values into this script's environment for the seed tools (they read environment variables)
foreach ($kv in (Read-Env $EnvApi).GetEnumerator()) { Set-Item -Path "env:$($kv.Key)" -Value $kv.Value }

Step 6 'Loading the three Final workbooks into MongoDB (verify, seed, reconcile, re-seed) - about 3 to 10 minutes'
Push-Location (Join-Path $Backend 'seed')
try {
    Run 'import verify' { py -3.13 import_workflow.py verify }
    Run 'import seed' { py -3.13 import_workflow.py seed }
    Step 7 'Creating the sign-in accounts (196 workers + the admin)'
    Run 'account setup' { py -3.13 setup_accounts.py --dataset-id GINI-SYN-TANKS --guide ..\data\demo_accounts.csv }
} finally { Pop-Location }

Step 8 'Database indexes and the default simulation session'
Push-Location $Backend
try {
    Run 'config check' { npm.cmd run --silent check:config }
    Run 'indexes' { npm.cmd run --silent db:indexes }
    Run 'default session' { npm.cmd run --silent session:create-default }
} finally { Pop-Location }

Step 9 'Your demo PINs (shown here only - do not paste them anywhere)'
Push-Location (Join-Path $Backend 'seed')
try { py -3.13 setup_accounts.py --dataset-id GINI-SYN-TANKS --show-local-pins } finally { Pop-Location }

Write-Host ""
Write-Host "SETUP COMPLETE." -ForegroundColor Green
Write-Host "Start the app with:   powershell -ExecutionPolicy Bypass -File .\gini-3-start.ps1"
Write-Host "Admin app: http://localhost:5174  (ADMIN_LOGIN / ADMIN_PASSWORD from backend\.env)"
Write-Host "Operator app: http://localhost:5173  (for example W0001 and its PIN above)"
