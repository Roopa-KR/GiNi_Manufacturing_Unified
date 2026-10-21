# Quick start — local (Windows PowerShell first; macOS/Linux at the end)

GiNi runs as four processes:

- the **Express API** (`backend/`);
- the **Python engine worker** (`backend/python_engine/`);
- the **operator app** (`frontend/`);
- the **supervisor/admin app** (`admin/`).

Open VS Code with four terminals (Terminal → New Terminal) and name them `api`, `engine`, `operator` and `admin`. Every command
below is literal. A heading names the working directory for the commands under it.

All data is synthetic. Nothing here connects to a real factory or to any Siemens system.

## 0. Prerequisites (once)

| Tool | Version | Check |
|---|---|---|
| Node.js | **22.x** (all three packages declare `"engines": {"node": "22.x"}`, and `.nvmrc` = 22) | `node --version` |
| Python | **3.13** (`backend/python_engine/.python-version`; the Docker image is `python:3.13-slim`) | `py -3.13 --version` |
| MongoDB | a **replica set**, because transactions need one. Use Atlas (the full seed needs more than the free 512 MB; use M10 or a paid shared tier), or Docker: `docker compose up -d mongo` from the repository root | — |

The Atlas connection string is under Database → Connect → Drivers. With Docker it is `mongodb://localhost:27017/?replicaSet=rs0`.

If PowerShell refuses to activate a virtual environment, run this once in that terminal:
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

## 1. Configure (once), working directory: repository root

```powershell
Copy-Item backend\.env.example backend\.env
Copy-Item backend\python_engine\.env.example backend\python_engine\.env
Copy-Item frontend\.env.example frontend\.env
Copy-Item admin\.env.example admin\.env
```

Edit `backend\.env` and `backend\python_engine\.env`:

- `MONGODB_URI` and `MONGODB_DB_NAME`: the same in both files (for example `gini_demo_dev`).
- `SESSION_SECRET`: a long random value (API only).
- `INTERNAL_SERVICE_TOKEN`: another long random value, **identical** in both files.
- `NODE_API_INTERNAL_URL=http://localhost:5000` in the engine file.
- `DEMO_PIN_SEED` (12+ characters), `ADMIN_LOGIN` and `ADMIN_PASSWORD` (15+ characters). Only the explicit account-setup command in
  step 2 reads them; the running API never does.
- `EMAIL_MODE=capture`. Nothing is sent: notifications are built by Nodemailer and stored as CAPTURED.

Random value in PowerShell: `[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))`

## 2. Import the three Final workbooks (once, explicit), working directory: `backend\seed`

The three `Siemens_Manufacturing_*_Final.xlsx` workbooks are already in `backend\data\final\`, unchanged, together with
`SHA256SUMS` and the package manifest.

```powershell
cd backend\seed
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install pymongo==4.10.1 dnspython==2.7.0 openpyxl==3.1.5
Get-Content ..\.env | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] } }
python import_workflow.py verify
python import_workflow.py seed
python setup_accounts.py --dataset-id GINI-SYN-TANKS --guide ..\data\demo_accounts.csv
python setup_accounts.py --dataset-id GINI-SYN-TANKS --show-local-pins
deactivate
```

What these commands do:

- `verify` checks checksums, schema, business keys and all 174 relationships, and compares with the package manifest. No database
  is used.
- `seed` inserts the data (insert-only), reconciles it, and seeds again to prove idempotency.
- The JSON reports go to `backend\docs\test-results\import\`.
- `--show-local-pins` prints demo PINs to this terminal only. It is refused in production.

Row-level evidence for the one named checkpoint reconciliation exception (96 stale "current task" references), recomputed
from as-of-checkpoint records. Run it after the default session exists (step 5):

```powershell
python tools\checkpoint_task_exceptions.py --out ..\docs\test-results\import\checkpoint_task_exceptions.csv
```

The full disposable-database gate (preservation and drift proofs) is in DATA_IMPORT_REPORT.md:

```powershell
$env:MONGODB_DB_NAME="gini_import_gate"; python import_workflow.py gate --drop-after
```

## 3. API — terminal `api`, working directory: `backend`

```powershell
cd backend
npm ci
npm run check:config
npm run db:indexes
npm start
```

The API listens on <http://localhost:5000>. <http://localhost:5000/api/ready> reports the database identity: `MongoDB`, or `TEST
SUBSTITUTE` if one is configured. There is no lockfile yet (see DEPLOYMENT.md §Lockfiles). Until there is one, use `npm install`
instead of `npm ci`, then commit the generated `package-lock.json`.

## 4. Engine — terminal `engine`, working directory: `backend\python_engine`

```powershell
cd backend\python_engine
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m gini_engine check
python -m gini_engine
```

Expect `engine <host>-<pid> started`. Keep it running: it advances the simulation, evaluates deadline boundaries, runs the
calculations and dispatches the notification outbox.

## 5. Default session — terminal `api` (second tab), working directory: `backend`

```powershell
cd backend
npm run session:create-default
```

The engine initialises the session from checkpoint `CK-20261015-1055` (10:55 local, mid-shift) within seconds.

## 6. Operator app — terminal `operator`, working directory: `frontend`

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173> and sign in with an employee ID (for example `W0001`) and the PIN from step 2. Signing in does **not**
clock you in.

## 7. Supervisor/admin app — terminal `admin`, working directory: `admin`

```powershell
cd admin
npm install
npm run dev
```

Open <http://localhost:5174> and sign in as `ADMIN_LOGIN` with `ADMIN_PASSWORD`. Both apps proxy `/api` to `http://localhost:5000`,
which is the same rewrite as on Vercel.

## 8. Tests, working directory: `backend`

Use a **disposable test database**: the tests create sessions, workers and one test product. Keep the API, engine and both apps
running.

```powershell
cd backend
$env:API_URL="http://localhost:5000"; $env:GINI_TEST_MONGODB_URI=$env:MONGODB_URI
npm test                      # unit tests, incl. Nodemailer against a local fake SMTP server
npm run test:integration      # acceptance, admin atomicity, engine, quality, reliability, repair, standards/policy, story
npm install --no-save playwright@1.49.1; npx playwright install chromium
npm run test:e2e              # browser: operator, inspector photo, admin worker creation, alert row, tank passport,
                              # every browser closed while the clock runs, deadline crossing at x1 (about 3 minutes of that is x1 time)
npm run test:flags            # LIVE F1-F6 lifecycle with captured notifications, all six in one run (about 15-20 minutes)
npm run measure:latency       # API latency report (x1); add --speed 30 --out docs/test-results/latency-x30.json
npm run measure:latency:browser   # browser-visible latency report (Chromium)
```

Python, working directory `backend\python_engine` (virtual environment active):

```powershell
pip install -r requirements-dev.txt
$env:GINI_TEST_MONGODB_URI=$env:MONGODB_URI
python -m pytest -q tests
```

The engine process test needs exclusive control of the engine:

1. Stop the `engine` terminal.
2. Run `$env:GINI_INTEGRATION="1"; python -m pytest -q tests_integration`.
3. Restart the engine.

## macOS / Linux

The steps are the same, with `cp` instead of `Copy-Item`, `python3.13 -m venv .venv`, `source .venv/bin/activate` and
`set -a; . ../.env; set +a` to load the environment. Generate secrets with `openssl rand -base64 48`.

## Docker Compose alternative

From the repository root, after step 1:

```bash
docker compose up -d mongo
docker compose --profile seed run --rm seed      # import_workflow.py seed + setup_accounts.py
docker compose up -d
docker compose run --rm api node scripts/create-default-session.js
```

Operator: <http://localhost:5173>. Admin: <http://localhost:5174>. API: <http://localhost:5000>.
