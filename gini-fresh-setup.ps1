# GiNi - FRESH FACTORY setup (once). Prepares an EMPTY factory database for team testing.
#   - does NOT import the Excel workbooks, does NOT create seeded workers, orders or history
#   - does NOT touch your previous (synthetic demo) database: it uses MONGODB_DB_NAME from backend\.env (gini_factory_teamtest)
#   - never deletes or resets anything; safe to run again (nothing is duplicated, an existing admin is NOT reset)
# Run from the project folder in VS Code:   powershell -ExecutionPolicy Bypass -File .\gini-fresh-setup.ps1
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$EnvApi = Join-Path $Backend '.env'
$EnvEngine = Join-Path $Backend 'python_engine\.env'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Step($n, $text) { Write-Host ""; Write-Host "==== $n. $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Fail($text) { Write-Host "  STOPPED: $text" -ForegroundColor Red; exit 1 }
function Run($what, [scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE). Copy the red text above into the chat (no passwords)." } }
function Read-Env($file) {
    $map = [ordered]@{}
    if (Test-Path $file) { foreach ($line in [IO.File]::ReadAllLines($file)) { if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $map[$matches[1]] = $matches[2].Trim().Trim('"') } } }
    return $map
}
function Set-EnvValue($file, $key, $value) {
    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path $file) { $lines.AddRange([string[]][IO.File]::ReadAllLines($file)) }
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$key\s*=") { $lines[$i] = "$key=$value"; $found = $true } }
    if (-not $found) { $lines.Add("$key=$value") }
    [IO.File]::WriteAllLines($file, $lines.ToArray(), $Utf8)
}
function New-Secret { -join ((1..48) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
function Bad($v, $min) { return (-not $v) -or ($v.Length -lt $min) -or ($v -match 'GENERATE|REPLACE_ME|YOUR_|SAME_SERVER') }

Step 1 'Checking the installed tools'
try { $nodeV = (& node --version) } catch { Fail "Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and open a new terminal." }
Ok "Node.js $nodeV"
try { $pyV = (& py -3.13 --version) } catch { $pyV = $null }
if (-not $pyV) { Fail "Python 3.13 is not installed (https://www.python.org/downloads/, tick 'Add python.exe to PATH')." }
Ok $pyV
$svc = Get-Service -Name MongoDB -ErrorAction SilentlyContinue
if (-not $svc) { Fail "MongoDB is not installed. See GINI-LOCAL-SETUP.txt, step A." }
if ($svc.Status -ne 'Running') { Fail "The MongoDB service is $($svc.Status). Start it as administrator:  Start-Service MongoDB" }
Ok "MongoDB service is running"

Step 2 'Python packages (no virtual environment)'
Run 'pip install' { py -3.13 -m pip install --disable-pip-version-check -q pymongo==4.10.1 dnspython==2.7.0 }
Ok "pymongo, dnspython"

Step 3 'Local MongoDB replica set'
& py -3.13 (Join-Path $Root 'mongo_local.py') init
if ($LASTEXITCODE -eq 3) { Fail "Run  powershell -ExecutionPolicy Bypass -File .\gini-1-enable-replica-set.ps1  first, then this script again." }
if ($LASTEXITCODE -ne 0) { Fail "MongoDB is not ready (see above)." }

Step 4 'Checking backend\.env for the fresh factory (values are never printed)'
if (-not (Test-Path $EnvApi)) { Copy-Item (Join-Path $Backend '.env.example') $EnvApi; Ok "created backend\.env from backend\.env.example" }
$api = Read-Env $EnvApi
if (($api['GINI_ENVIRONMENT'] + '').ToUpper() -ne 'FRESH_FACTORY') { Fail "backend\.env must contain GINI_ENVIRONMENT=FRESH_FACTORY (see FRESH_FACTORY_SETUP.md). Nothing was changed." }
if (-not $api['MONGODB_DB_NAME']) { Fail "backend\.env has no MONGODB_DB_NAME - use a NEW name such as gini_factory_teamtest." }
if (-not $api['DATASET_ID']) { Set-EnvValue $EnvApi 'DATASET_ID' 'GINI-FRESH-FACTORY'; Ok "DATASET_ID set to GINI-FRESH-FACTORY" }
if (-not $api['MONGODB_URI']) { Set-EnvValue $EnvApi 'MONGODB_URI' 'mongodb://localhost:27017/?replicaSet=rs0'; Ok "MONGODB_URI set to the local MongoDB" }
if (Bad $api['SESSION_SECRET'] 32) { Set-EnvValue $EnvApi 'SESSION_SECRET' (New-Secret); Ok "SESSION_SECRET generated" }
if (Bad $api['INTERNAL_SERVICE_TOKEN'] 32) { Set-EnvValue $EnvApi 'INTERNAL_SERVICE_TOKEN' (New-Secret); Ok "INTERNAL_SERVICE_TOKEN generated" }
if (-not $api['ALLOW_FACTORY_RESET']) { Set-EnvValue $EnvApi 'ALLOW_FACTORY_RESET' 'false'; Ok "ALLOW_FACTORY_RESET=false (default)" }
$api = Read-Env $EnvApi
Ok ("database for the fresh factory: " + $api['MONGODB_DB_NAME'])

Step 5 'Making the engine use the SAME database and environment as the API'
if (-not (Test-Path $EnvEngine)) { Copy-Item (Join-Path $Backend 'python_engine\.env.example') $EnvEngine; Ok "created backend\python_engine\.env" }
foreach ($k in 'MONGODB_URI', 'MONGODB_DB_NAME', 'GINI_ENVIRONMENT', 'DATASET_ID', 'INTERNAL_SERVICE_TOKEN') { Set-EnvValue $EnvEngine $k $api[$k] }
Set-EnvValue $EnvEngine 'APP_ENV' 'development'
Set-EnvValue $EnvEngine 'NODE_API_INTERNAL_URL' ('http://localhost:' + $(if ($api['PORT']) { $api['PORT'] } else { '5000' }))
Ok "backend\python_engine\.env now matches backend\.env"
foreach ($app in 'frontend', 'admin') { $f = Join-Path $Root "$app\.env"; if (-not (Test-Path $f)) { Copy-Item (Join-Path $Root "$app\.env.example") $f; Ok "created $app\.env" } }

Step 6 'Node.js packages (backend, operator app, admin app)'
foreach ($dir in 'backend', 'frontend', 'admin') {
    Push-Location (Join-Path $Root $dir)
    try { if ($dir -eq 'backend') { Run "npm install in $dir" { npm.cmd install --omit=dev --no-audit --no-fund } } else { Run "npm install in $dir" { npm.cmd install --no-audit --no-fund } } } finally { Pop-Location }
    Ok "$dir packages installed"
}

Step 7 'Configuration check'
Push-Location $Backend
try { Run 'config check' { npm.cmd run --silent check:config } } finally { Pop-Location }

Step 8 'Bootstrap: indexes, the administrator (only if missing) and the empty factory session'
Write-Host "  If no ADMIN_PASSWORD is set in backend\.env you are asked for one now (at least 15 characters, not shown)." -ForegroundColor Yellow
Push-Location $Backend
try { Run 'factory:init' { npm.cmd run --silent factory:init } } finally { Pop-Location }

Write-Host ""
Write-Host "FRESH FACTORY READY (empty: no workers, orders, tanks or history)." -ForegroundColor Green
Write-Host "Start the app with:   powershell -ExecutionPolicy Bypass -File .\gini-3-start.ps1"
Write-Host "Then open http://localhost:5174, sign in as the admin and follow Factory setup (ADMIN_FIRST_RUN_GUIDE.md)."
