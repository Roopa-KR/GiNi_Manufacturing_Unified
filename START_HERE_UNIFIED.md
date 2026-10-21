# GiNi Manufacturing — unified fresh factory

This delivery uses ONE manufacturing model and the original Python engine. It does not use the disconnected FactoryOps `ops_*` model. A tank is the transformer tank being manufactured, not a reusable processing vessel. The newer ZIP's setup/assignment goals are implemented through the existing Factory setup, Administration, Orders and Dispatch screens.

## Folder layout

- `frontend/`: operator and inspector device interface, port 5173.
- `admin/`: supervisor and administrator interface, port 5174.
- `backend/`: Express API, port 5000; MongoDB is the shared database.
- `backend/python_engine/`: continuously running calculations, forecasting, points, flags, cutoff, recovery and verification.

## Start an empty factory in VS Code on Windows

1. Extract this entire ZIP to a NEW folder and open that folder in VS Code. Keep your previous app and database as a backup.
2. Install Node 22, Python 3.13 and MongoDB as a replica set. For MongoDB setup, follow `GINI-LOCAL-SETUP.txt`. Transactions are required; the API does not fall back to partial writes.
3. Open Terminal → New Terminal at this project root.
4. Run `powershell -ExecutionPolicy Bypass -File .\gini-fresh-setup.ps1`. It installs packages, creates local `.env` files, generates service secrets and asks for your first administrator password. It does NOT import Excel or create demo workers/orders.
5. Check that BOTH `backend/.env` and `backend/python_engine/.env` use `MONGODB_DB_NAME=gini_unified_teamtest`, `GINI_ENVIRONMENT=FRESH_FACTORY` and `DATASET_ID=GINI-FRESH-FACTORY`. Choose another NEW database name if you already used this one.
6. Run `powershell -ExecutionPolicy Bypass -File .\gini-3-start.ps1`. Keep all four terminals running: API, Python engine, operator frontend and admin frontend.
7. Open http://localhost:5174 and sign in with the administrator account you created. Open Administration → Jobs & engine and check the heartbeat. The Python engine must remain running even when browser windows are closed.
8. For team members open http://localhost:5173. Each uses the login ID and PIN you created for them. Inspector accounts use this same device interface, with inspection permissions.

`.env.example` files contain placeholders only. No supplied private credentials or old demo PIN export is bundled. Add Cloudinary and SMTP credentials only to your local or hosting environment. Email defaults to capture mode; no messages are sent until you configure SMTP and the recipient allowlist.

## First team demonstration

1. Admin → Factory setup: name, site, timezone and Manual Team Test mode. Optionally tick "Require a scan of the tank before people start work / before an inspection starts" (the tank label is the tank serial; every scan is saved in the tank history).
2. Configure work centers and stations, shifts, skills, equipment and materials.
3. Configure a tank product route with labor minutes, elapsed minutes, crew requirements, milestones, inspection gates and versioned questions/limits. Release the product when valid. The optional illustrative template requires explicit import and is not Siemens-approved.
4. Administration → Workers: create production operators and a quality inspector; set home centers, shifts, qualifications and login PINs. A newly created account is NOT automatically clocked in.
5. Materials & Equipment: receive the required material lots/quantities.
6. Orders & Batches → New work order: request FIVE good tanks, a due date/time, an optional planned release date/time, and two batches of TWO and THREE. Release each batch. You now have five permanent tank IDs, not two vessels. Use "Print tank labels" in the release dialog to print a barcode label for each tank (station labels: Factory setup → Work centres → Label).
7. Dispatch & assign: choose each tank's next step, station and crew. Step target times and the order/batch identity are shown. The operator sees assigned work at port 5173.
8. Operator → Work: clock in, press "Confirm tank" and scan the tank label (camera where the browser supports it, a handheld scanner, or typing the serial), start the assigned task, record milestones, pause/resume with reasons, then finish. Finishing labor puts the tank into inspection; it does not release it.
9. Admin → Dispatch & assign → Assign inspector. Select a qualified, independent inspector. Their Work screen shows the assigned tank, even when it is outside their home center. Assignment does not start their labor or inspect automatically.
10. Inspector → Work → start the gate inspection. Enter measurements/answers; take or upload photographs. Required photos must finish uploading and be verified before submission. A question set to "photo required when the answer fails" needs a photo only when that answer fails. Browser camera use needs browser permission and HTTPS outside localhost.
11. Pass and release moves the SAME tank to the next route step. Fail places it on hold. Quality & Rework lets an authorized reviewer hold, scrap or authorize rework. Rework uses a new attempt on the same unit, followed by a fresh inspection. Alternate stations require authorization.
12. Scrap one tank and approve its replacement. The replacement has a NEW ID linked to the original. Customer demand stays FIVE good tanks. Scrap is never good output.
13. Click any tank ID to see its passport: current location, route progress, attempts, crew/labor, inspections, evidence, holds, rework, material traceability, points and expected next action. At ROUTE_COMPLETE the final release is already recorded; there is no further manufacturing release button.
14. Observe Overview, Workforce, Alerts and Orders while operators work. Predictions remain separate from observed output. Recovery compares feasible actions; Verify compares stored predictions against recorded results.

## Points and flags

The original rules are retained: +3 per completed eligible no-rework WO; +2 per eligible origin-correction WO; -4 per distinct downstream defect only after confirmed worker attribution; time = standard eligible labor minutes minus actual eligible labor minutes. WO awards are shared, not multiplied by crew size. Reversals preserve historical records. Inspecting a tank does not automatically earn the production crew's WO award.

F1 stalled assignment, F2 regional imbalance, F3 material velocity, F4 location dwell, F5 congestion and F6 replenishment delay use the same database records as the application. The manufacturing M01–M13 rules are also retained. Rule settings control thresholds and persistence; acknowledging an alert does not resolve its cause.

An empty factory legitimately has insufficient history for comparable-baseline flags. The engine now learns material velocity and dwell from earlier completed operational records and retains five-minute queue samples for comparable baselines. It excludes the current two-hour evaluation window; dwell needs three past completed attempts, material velocity needs one past productive hour, and comparable queue/release slots need three prior sampled days. These are documented demo defaults, not customer-approved policies. It does not fabricate history to force an alert.

Cutoff transitions are evaluated by the Python scheduler even with no new operator input. A forecast may be UNKNOWN when there are insufficient resources or data. That must not be presented as on-time.

## Employee deletion and reset

Use Administration → Workers → Delete unused for an accidentally created worker with no operational references. Type the worker ID to confirm. The worker, account, qualifications, roster and live placeholder are removed from MongoDB, with an audit record retained.

For a worker with history, finish/hand over work, clock out and deactivate them. Deleting their referenced production/inspection records would damage traceability. To erase ALL test activity and people, use the existing guarded Factory reset, with clear-workers selected. It is disabled by default, requires typed confirmations and is refused in production. Never point that operation at a customer database.

## Original workbook mode

All three Final workbooks remain under `backend/data/final/`, together with existing import tools. They are NOT loaded in fresh-factory mode. To use historical synthetic replay, use a separate database, `GINI_ENVIRONMENT=SYNTHETIC_DEMO` and the seed README. Never seed the workbooks into the empty team-test factory accidentally.

## Hosting

Deploy `frontend/`, `admin/` and `backend/` as three separate Vercel projects. Configure the frontend/admin API rewrites with each application's existing `configure:vercel` command. Run `backend/python_engine/` continuously as the separate worker described in `render.yaml`. Set the SAME MongoDB database, environment, dataset and internal service token on API and Python worker. Use Cloudinary mode on Vercel; local image disk is development-only. Keep Preview and Production databases separate.

Read `UNIFIED_CHANGE_REPORT.md` for changed paths and `UNIFIED_TEST_REPORT.md` for what was actually verified in this delivery. Historical test reports elsewhere describe earlier versions.
