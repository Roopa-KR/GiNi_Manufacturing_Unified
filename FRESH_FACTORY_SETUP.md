# Fresh Factory setup (empty database for team testing)

The **Fresh Factory** environment starts with **nothing**: no workers, orders, batches, tanks, attendance, inspections,
points or history. An administrator configures the factory from the admin application and the team then works in real
time. The synthetic demonstration is not touched and stays usable in its own database.

| | Fresh Factory | Synthetic demonstration |
|---|---|---|
| `GINI_ENVIRONMENT` | `FRESH_FACTORY` | `SYNTHETIC_DEMO` (default) |
| `DATASET_ID` | `GINI-FRESH-FACTORY` | `GINI-SYN-TANKS` |
| `MONGODB_DB_NAME` | a **new** database, e.g. `gini_factory_teamtest` | your existing demo database, e.g. `gini_demo_dev` |
| Data | created by people in the app | imported from the three Final workbooks |
| Session | one permanent session `S-FACTORY`, no checkpoint, real-time clock | sessions forked from checkpoints, simulated clock |
| Start-up | `npm run factory:init` once (explicit) | `gini-2-setup.ps1` (workbook import) |

> Your `.env` files in this delivery are already switched: `MONGODB_DB_NAME=gini_factory_teamtest`,
> `GINI_ENVIRONMENT=FRESH_FACTORY`, `DATASET_ID=GINI-FRESH-FACTORY`, `ALLOW_FACTORY_RESET=false`. Everything else in them
> (connection string, secrets, Cloudinary, SMTP) is exactly as you had it. Your previous database name is written in a comment
> above `MONGODB_DB_NAME` so you can switch back.

## 1. Connecting to a fresh database

* `MONGODB_DB_NAME` **always** decides the database. A database name inside `MONGODB_URI` is ignored by both services
  (`client.db(MONGODB_DB_NAME)` in Node, `client[MONGODB_DB_NAME]` in Python).
* MongoDB creates the database the first time something is written, so a new name is enough - there is nothing to create by hand.
* The fresh factory needs a **replica set** (transactions), exactly like the demo: the local Windows MongoDB from
  `GINI-LOCAL-SETUP.txt` (rs0) or Atlas.
* Nothing ever drops or overwrites another database: `factory:init` writes only into `MONGODB_DB_NAME`, and it **refuses**
  to run on a database that contains the synthetic demonstration (run catalog, unit master, checkpoints or demo sessions).
* The workbook import tools refuse to write into a fresh-factory database (`GINI_ENVIRONMENT=FRESH_FACTORY`, or a database
  holding `factory_settings` / `S-FACTORY`).

## 2. How all services use the same database

| Service | Reads | Must match |
|---|---|---|
| API (`backend`) | `backend/.env` | - |
| Engine (`backend/python_engine`) | `backend/python_engine/.env` | `MONGODB_URI`, `MONGODB_DB_NAME`, `GINI_ENVIRONMENT`, `DATASET_ID`, `INTERNAL_SERVICE_TOKEN` |
| Operator / admin apps | only `VITE_*` values (no secrets) | they call the API through `/api`; they never connect to MongoDB |

There is one database for the operator and the admin application - both go through the same API.
`/api/ready` (and `npm run check:config`, and the engine at start-up) report any mismatch between the two `.env` files
**without printing the values**. `gini-fresh-setup.ps1` copies the five values from `backend/.env` into the engine's file.

## 3. Step by step (Windows, local MongoDB)

1. MongoDB installed and replica set on (once): `GINI-LOCAL-SETUP.txt` steps A and B (unchanged).
2. In VS Code, terminal in the project folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\gini-fresh-setup.ps1
   ```
   It checks the tools, the replica set and `backend/.env` (must say `GINI_ENVIRONMENT=FRESH_FACTORY`), aligns the engine's
   `.env`, installs packages and runs the **bootstrap** (`npm run factory:init`). It does **not** import workbooks or create
   any worker, order or history.
3. Start everything: `powershell -ExecutionPolicy Bypass -File .\gini-3-start.ps1`
4. Admin app `http://localhost:5174` → sign in as the bootstrap admin → **Factory setup** (see `ADMIN_FIRST_RUN_GUIDE.md`).
5. Operator app `http://localhost:5173` → workers sign in with the logins you create.

Manual alternative to step 2 (any OS):
```bash
cd backend
npm install
npm run check:config        # lists problems, prints no secret
npm run factory:init        # explicit bootstrap (see section 4)
npm start                   # API
cd python_engine && python -m gini_engine     # engine (Python 3.12+ with pymongo)
cd ../../admin && npm install && npm run dev  # admin app, port 5174
cd ../frontend && npm install && npm run dev  # operator app, port 5173
```

## 4. The bootstrap command (`npm run factory:init`)

Explicit, idempotent, never run at start-up:

1. refuses unless `GINI_ENVIRONMENT=FRESH_FACTORY`, and refuses a database that holds the synthetic demonstration;
2. creates the indexes (application + fresh-factory uniqueness: tank serials, order references, configuration IDs);
3. creates the **bootstrap administrator** only if that login does not exist:
   * login = `ADMIN_LOGIN` (default `admin`);
   * password = `ADMIN_PASSWORD` from `backend/.env`, or - if empty - typed at the prompt (hidden, twice). Minimum 15 characters.
   * stored only as a scrypt hash; never printed, never written to a workbook or committed; **there is no default password**;
   * a password that came from the `.env` file is flagged "must change" (the admin app shows a reminder until you change it under Administration → My account);
   * running the command again **never resets** an existing admin; the guarded reset also keeps admins;
   * the admin account has no `WORKER_ID` - an administrator is not a worker;
4. optionally saves the factory settings: `npm run factory:init -- --factory-name "Plant 1" --site-id PLANT-01 --timezone Europe/Berlin --mode MANUAL_TEAM_TEST --serial-prefix TT`
   (otherwise you set them in the app, step 1 of the checklist);
5. creates the permanent operational session **S-FACTORY**: no checkpoint, no inherited history, real-time clock, empty.

There is no public registration endpoint. Worker logins are created by an administrator (Administration → Workers) and are
application accounts linked to a `WORKER_ID`; roles are enforced on every request.

## 5. Manual Team Test vs Simulated Test

Set in Factory setup → 1 · Factory (`operatingMode`).

**MANUAL_TEAM_TEST** (default)
* The clock is the **real current time** in the plant timezone; it cannot be paused, sped up or rewound.
* Workers and admins create every operational event (clock-in, start, milestones, finish, inspection, decisions).
* **No background agent completes human work.** Every person is `HUMAN_ONLY`; a sign-in lease can never expire into agent
  control (fixed for every environment). The API refuses agent commands for people and every agent command except the
  timed, unattended steps (`PROCESS_COMPLETE` of a configured cure time, `UNIT_ARRIVE` / `RETURN_ARRIVE` after a configured
  transfer time).
* No batch is released and no equipment is repaired by itself.
* The Python engine keeps calculating: forecasts, cutoffs/deadlines (exactly at the boundary, without a new event), alerts,
  points, the roster pointer of each person.
* Closing all browsers changes nothing: a running task stays running until a person finishes or pauses it.

**SIMULATED_TEST** (optional, explicit)
* Only workers created with **“Designated simulated worker”** ticked are driven by agents. Real people are still never
  acted for. The session clock can then be paused / sped up (forward only).
* Switching back to Manual Team Test is refused while the simulated clock is ahead of real time.

## 6. Starting without Excel seeding / optional configuration template

The fresh factory never reads the workbooks. If you want a starting point, **Factory setup → Template import** loads an
**illustrative** configuration only (work centres WC1-WC8, stations, skills, equipment, materials/BOM, products TT-S/M/L,
routes with crew and labour standards, milestones, instructions, checklists with synthetic limits, shift pattern A/B with
breaks, the repairable-return disposition policy). Every record is marked `ILLUSTRATIVE` / `UNCONFIRMED` and shown with an
“illustrative · unconfirmed” label. It contains **no workers, accounts, orders, batches, tanks or history**, it only fills an
empty configuration, and it needs the typed confirmation `IMPORT ILLUSTRATIVE TEMPLATE`. Material stock stays 0 until you
receive stock. The file is `backend/config/templates/illustrative_tank_line.json` (rebuilt from the seed bundle with
`python backend/scripts/build-illustrative-template.py`).

## 7. Ports

API 5000 (`PORT`), operator app 5173, admin app 5174 - unchanged. If you change the API port, also change
`NODE_API_INTERNAL_URL` in the engine's `.env`, `DEV_API_PROXY_TARGET` in both app `.env` files and `FRONTEND_URL` /
`ADMIN_URL` if the app ports change (the API only accepts those origins).

## 8. Cloudinary, SMTP and capture-only e-mail

* Photos: `EVIDENCE_STORAGE_MODE=local` (files on this computer) or `cloudinary` with `CLOUDINARY_*`. Unchanged from your setup.
* E-mail: `EMAIL_MODE=capture` renders and stores alert e-mails in the database (Administration → Notifications) and sends
  nothing - use it for team tests. `EMAIL_MODE=smtp` sends only to addresses in `ALERT_EMAIL_ALLOWLIST`. Automated tests always
  use capture mode.

## 9. Reset protections

See `DATA_RESET_POLICY.md`. In short: disabled unless `ALLOW_FACTORY_RESET=true`, always refused in production, admin-only,
shows the exact database, previews counts, needs the typed database name + factory name + a tick, keeps admins and the audit,
and **starting the app never resets anything**.

## 10. Returning to the synthetic demonstration

Your demo database was not modified. To use it again, in **both** `backend/.env` and `backend/python_engine/.env`:
```
MONGODB_DB_NAME=<your previous name - written in the comment above the line, e.g. gini_demo_dev>
GINI_ENVIRONMENT=SYNTHETIC_DEMO
DATASET_ID=GINI-SYN-TANKS
```
restart the API and the engine. Switch back to the fresh factory the same way (`gini_factory_teamtest`, `FRESH_FACTORY`,
`GINI-FRESH-FACTORY`). Both databases can live side by side on the same MongoDB server.
