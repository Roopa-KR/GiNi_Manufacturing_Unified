# Changed files - Fresh Factory delivery

Paths are relative to the project folder `GiNi_Manufacturing_App_Fixed/`. The same files are in `COPY_THESE_FILES/`
(same folder structure): copy that folder's contents over your project to apply the change.

**Your `.env` files:** only the database name was changed and four new keys were added (see the end). Secrets,
connection strings, Cloudinary and SMTP values are exactly as you had them. Your previous database is not modified.

## New files

| Path | What it is |
|---|---|
| `FRESH_FACTORY_SETUP.md` | how the empty factory works, database selection, bootstrap, modes, template, ports, e-mail, reset, going back |
| `ADMIN_FIRST_RUN_GUIDE.md` | the administrator's first run, step by step |
| `TEAM_TEST_WALKTHROUGH.md` | a team test with exact clicks (admin + operator + inspector) |
| `DATA_RESET_POLICY.md` | what is never reset, the optional guarded reset, evidence clean-up |
| `TEST_RESULTS_FRESH_FACTORY.md` | what was tested, how, results, mocked parts, BLOCKED items, open business policies |
| `CHANGED_FILES.md` | this file |
| `gini-fresh-setup.ps1` | one-time Windows setup of the fresh factory: checks tools/replica set/`.env`, aligns the engine `.env`, installs packages, runs `factory:init`. No workbook import, no deletes |
| `backend/.env.example`, `admin/.env.example`, `frontend/.env.example` | safe templates (no secrets; fresh-factory defaults; `VITE_*` only in the apps) |
| `backend/scripts/factory-init.js` | `npm run factory:init`: explicit bootstrap - indexes, admin only if missing (hash only, ≥15 chars, no default password), optional settings, empty `S-FACTORY` session; refuses a synthetic-demo database |
| `backend/scripts/build-illustrative-template.py` | rebuilds the illustrative configuration template from the seed bundle (configuration only) |
| `backend/config/templates/illustrative_tank_line.json` | optional illustrative configuration (work centres, products, routes, checklists, shifts), marked ILLUSTRATIVE/UNCONFIRMED; no people, orders or history |
| `backend/contracts/factory_indexes.json` | uniqueness indexes of the fresh factory (tank serial, order reference, configuration IDs, reset log) |
| `backend/src/services/factory.js` | fresh-factory service: environment banner, settings, configuration saves (audited, versioned, RECALC), shifts → calendar/rosters, products DRAFT/RELEASED + route versions, checklist versions, setup checklist, readiness, template import, guarded reset, session document |
| `backend/src/routes/factory.js` | `/api/factory/*` endpoints (admin app; permissions `factory_configuration`, `factory_reset`) |
| `backend/src/domain/identity.js` | unique tank identity `TNK-FACTORY-#####` + serial `<PREFIX>-<YY>-#####` |
| `backend/src/domain/commands/factory.js` | `MATERIAL_RECEIPT` command (explicit stock with lot; duplicate lot refused) |
| `backend/tests/fresh/scenario.test.js` | the 22-step scenario + separate checks X1-X7, over HTTP against the real API and engine |
| `backend/tests/fresh/modes.test.js` | Manual vs Simulated mode guards (runs only with `FRESH_MODES_TEST=1` on a disposable database) |
| `backend/docs/test-results/fresh-factory/` | logs of the final test runs (scenario, reset, modes, UI walkthrough, synthetic regression) and the UI walkthrough script |
| `docs/screenshots/fresh-factory/` | screenshots of the UI walkthrough on an empty database |
| `backend/tests/fresh/reset.test.js` | guarded reset test (runs only with `ALLOW_FACTORY_RESET_TEST=1` on a disposable database) |
| `admin/src/pages/Setup.jsx` | Factory setup: checklist + tabs (factory, work centres/stations, products & routes, checklists, skills, shifts, equipment & materials, template import, reset) |
| `admin/src/pages/Dispatch.jsx` | Dispatch & assign: readiness board with blockers, crew assignment |

## Changed files - backend (Node API)

| Path | Change |
|---|---|
| `backend/src/config/env.js` | `GINI_ENVIRONMENT`, `ENVIRONMENT_NAME`, `DATASET_ID` default per environment, `ALLOW_FACTORY_RESET`; checks that the engine `.env` uses the same database/environment (values never printed) |
| `backend/src/app.js` | mounts `/api/factory`, adds `/api/environment`; `/api/ready` reports environment and factory state |
| `backend/src/openapi.js`, `backend/scripts/print-openapi.js`, `backend/docs/openapi.json`, `DATABASE_PERSISTENCE_MAP.md` (Fresh Factory section) | factory and environment endpoints documented; the printed document now lists all registered commands |
| `backend/src/lib/time.js` | real-time clock for the factory session; plant timezone from the factory settings |
| `backend/src/domain/catalog.js` | factory timezone, no fallback to demo routes, checklist default specs / active versions / order, configuration stamp for immediate reload |
| `backend/src/domain/masterData.js` | checklist default specifications and active filter |
| `backend/src/domain/executor.js`, `backend/src/domain/helpers.js` | manual team test: agents may not act for people; only timed steps (`PROCESS_COMPLETE`, `UNIT_ARRIVE`, `RETURN_ARRIVE`) run unattended; simulated mode only for designated simulated workers |
| `backend/src/domain/commands/tasks.js` | people stay `HUMAN_ONLY` (no lease expiry into agent control); missing stock record blocks work in the factory |
| `backend/src/domain/commands/flow.js` | factory batch release (atomic, unique identities, pinned route version), `BATCH_CREATE`, duplicate open-operation guard, assignment without clock-in, crew min/max, duplicate assignment refused |
| `backend/src/domain/commands/quality.js` | checklist snapshot pinned at inspection start; inspector skill from the route; replacement tank with a new identity |
| `backend/src/domain/commands/orders.js` | optional unique customer reference, due/planned release in plant time, quantity basis = accepted good, route version stored |
| `backend/src/services/sessions.js` | factory fields; demo session create/reset/archive/clock refused for the factory (clock only in Simulated test) |
| `backend/src/services/plantViews.js`, `backend/src/services/operatorViews.js` | factory work centres, header fields, order view (planned batches, reference, completion), checklist snapshot |
| `backend/src/services/workersAdmin.js` | shifts from templates, future start, simulated-worker flag, employee-number duplicate check, shift change, qualification revoke, roster version + RECALC |
| `backend/src/routes/admin.js` | reference data includes environment, timezone, shift templates, products |
| `backend/contracts/permissions.json` | `factory_configuration`, `factory_reset` (ADMIN) |
| `backend/package.json` | scripts `factory:init`, `test:fresh` (the scenario) - no dependency change; lockfile unchanged |
| `backend/seed/seedlib.py` | the workbook seed refuses a fresh-factory database |
| `backend/docs/DATA_MODEL.md` | §6 Fresh Factory collections, fields, indexes |

## Changed files - Python engine

| Path | Change |
|---|---|
| `backend/python_engine/.env.example` | `GINI_ENVIRONMENT`, `DATASET_ID`, fresh database name |
| `gini_engine/config.py`, `gini_engine/timeutil.py` | environment/dataset; factory timezone |
| `gini_engine/catalog.py` | fresh flag, factory timezone, dynamic work centres/gates, reload on configuration stamp |
| `gini_engine/worker.py` | fresh start-up (no calendar continuation, no seed needed), heartbeat shows environment/database/dataset, quiesce during reset |
| `gini_engine/agents.py` | factory step: no agent acts for people, no automatic batch release or self-repair; timed steps only; simulated workers only in Simulated test |
| `gini_engine/variance.py` | rules use the configured work centres; insufficient data instead of false alarms with no history |
| `gini_engine/forecast.py` | standard-based forecast (labour standards, crew, shifts) with no history, labelled `STANDARD-BASED` |
| `gini_engine/baselines.py`, `gini_engine/recovery.py`, `gini_engine/alerts.py` | configured work centres, feasibility text, route guard, plant timezone in alert e-mails |

## Changed files - admin app (`admin/src`)

| Path | Change |
|---|---|
| `App.jsx` | environment banner, “Fresh factory” menu (Factory setup, Dispatch & assign), no clock controls in real time, “not initialised” message |
| `components/ui.jsx`, `lib/hooks.jsx`, `styles.css` | environment banner, mode badge, real-time clock, `useEnv`, `useWorkCenterIds` |
| `pages/Overview.jsx` | empty-state guidance, measured counts only (no placeholder bars) |
| `pages/Orders.jsx` | work-order wizard, planned batches, release with identities, add batch |
| `pages/WorkCenters.jsx`, `pages/Workforce.jsx` | configured work centres |
| `pages/Administration.jsx` | new-worker form (shift templates, future start, simulated worker, onboarding screen), edit shift / revoke qualifications |
| `pages/Login.jsx` | environment shown on the sign-in page |

## Changed files - operator app (`frontend/src`)

| Path | Change |
|---|---|
| `App.jsx` | no control lease in the factory; environment banner |
| `components/ui.jsx`, `lib/hooks.jsx`, `styles.css` | environment banner, real-time clock |
| `pages/Login.jsx`, `pages/Profile.jsx`, `pages/Queue.jsx` | environment, factory header fields; no demo checkpoint plan in the factory |

## Changed files - scripts and docs

| Path | Change |
|---|---|
| `gini-2-setup.ps1` | refuses to import the workbooks when `backend/.env` says `FRESH_FACTORY` |
| `gini-3-start.ps1` | start-up message for the fresh factory (real time, worker logins you create) instead of “press Play” |
| `DATABASE_PERSISTENCE_MAP.md` | Fresh Factory section: UI action → endpoint/command → collections |
| `README.md` | short “Fresh Factory” section pointing to the new guides |

## Your `.env` files

| File | Change |
|---|---|
| `backend/.env` | `MONGODB_DB_NAME=gini_factory_teamtest` (your previous name is in the comment above it); added `GINI_ENVIRONMENT=FRESH_FACTORY`, `ENVIRONMENT_NAME="Fresh factory - team test"`, `ALLOW_FACTORY_RESET=false`; `DATASET_ID=GINI-FRESH-FACTORY` |
| `backend/python_engine/.env` | `MONGODB_DB_NAME=gini_factory_teamtest` (previous name in a comment); added `GINI_ENVIRONMENT=FRESH_FACTORY`, `DATASET_ID=GINI-FRESH-FACTORY` |

`admin/.env` and `frontend/.env` are unchanged. No `package-lock.json` changed (no new dependency).
