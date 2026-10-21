# Environment matrix

Which variable goes to which deployed service. **No secret value is stored in this repository.** Each project's
`.env.example` holds placeholders only; real values go in the Vercel / Render dashboards (or a local `.env` that git
ignores). Browser bundles only ever contain `VITE_*` values, and none of those are secrets.

Legend: **S** = secret (dashboard only), **R** = required, **O** = optional, — = not used by that service.

## Services

| Service | Folder | Host | Secrets it holds |
|---|---|---|---|
| Express API | `backend/` (entry `api/index.js`) | Vercel project `gini-api` | DB string, session secret, internal token, Cloudinary secret, SMTP password |
| Operator app | `frontend/` | Vercel project `gini-operator` | none |
| Supervisor/admin app | `admin/` | Vercel project `gini-admin` | none |
| Engine worker | `backend/python_engine/` (Docker build context `backend/`) | Render background worker `gini-engine` | DB string, internal token |
| Seed commands | `backend/seed/` | your machine or CI job, run **explicitly** | DB string, `DEMO_PIN_SEED`, `ADMIN_PASSWORD` |

## Express API (`backend/.env`, Vercel project `gini-api`)

| Variable | Kind | Example / default | Notes |
|---|---|---|---|
| `NODE_ENV` | R | `production` on Vercel | `development` locally (enables the `.env` loader) |
| `PORT` | O | `5000` | local only; Vercel ignores it |
| `FRONTEND_URL` | R | `https://gini-operator.vercel.app` | exact origin of the operator app (scheme + host, no path) |
| `ADMIN_URL` | R | `https://gini-admin.vercel.app` | exact origin of the admin app |
| `EXTRA_ALLOWED_ORIGINS` | O | empty | comma-separated extra exact origins (e.g. a preview URL); avoid wildcards |
| `MONGODB_URI` | R, S | Atlas SRV string | must be a replica set (Atlas always is) |
| `MONGODB_DB_NAME` | R | `gini_demo` | same value as the engine |
| `MONGODB_MAX_POOL_SIZE` | O | `5` | small pools suit serverless instances |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | O | `10000` | |
| `SESSION_SECRET` | R, S | 48+ random bytes | |
| `SESSION_IDLE_MINUTES` | O | `120` | sliding idle expiry |
| `SESSION_ABSOLUTE_HOURS` | O | `12` | absolute expiry |
| `DEMO_MODE` | O | `true` | shows synthetic-data labelling and enables the scenario console for `scenario_control` |
| `DATASET_ID` | R | `GINI-SYN-TANKS` | must match the seeded dataset |
| `INTERNAL_SERVICE_TOKEN` | R, S | random | identical in the engine; authorises `/api/internal/*` (agent commands, notification dispatch) |
| `EVIDENCE_STORAGE_MODE` | R | `cloudinary` deployed / `local` for development | `local` stores files on the API host (development only — Vercel's filesystem is not persistent) |
| `EVIDENCE_LOCAL_DIR` | O | empty = `<repository>/.local/evidence` | local mode only (git-ignored) |
| `CLOUDINARY_CLOUD_NAME` | R if cloudinary | | |
| `CLOUDINARY_API_KEY` | R if cloudinary | | |
| `CLOUDINARY_API_SECRET` | R if cloudinary, S | | never sent to the browser; used to sign uploads and verify completed uploads |
| `UPLOAD_MAX_IMAGE_MB` | O | `8` | |
| `UPLOAD_MAX_FILES` | O | `10` | per check |
| `UPLOAD_MAX_MEGAPIXELS` | O | `40` | |
| `EMAIL_MODE` | R | `capture` | `capture` stores messages in the outbox (default demo mode); `smtp` sends **only** to allowlisted addresses; `disabled` |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_SECURE` | R if smtp | `smtp.gmail.com` / `587` / `false` | |
| `EMAIL_USER` | R if smtp | | |
| `EMAIL_PASS` | R if smtp, S | app password | |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | R if smtp | verified sender | |
| `EMAIL_TIMEOUT_MS` | O | `15000` | |
| `ALERT_EMAIL_ALLOWLIST` | R if smtp | comma-separated | live SMTP never emails an address outside this list (fabricated worker addresses are never used) |
| `ALERT_EMAIL_RECIPIENTS` | O | comma-separated | must also be allowlisted |
| `EMAIL_COOLDOWN_SECONDS` | O | `900` | per alert episode/transition |
| `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_MIN` | O | `10` / `15` | failed sign-ins allowed per login ID in the window; per IP address the limit is 5× (shared office/demo-room networks) |

Not read by the API (seed-only): `DEMO_PIN_SEED`, `ADMIN_LOGIN`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
Do **not** add them to the Vercel API project.

## Engine worker (`backend/python_engine/.env`, Render service `gini-engine`)

| Variable | Kind | Default | Notes |
|---|---|---|---|
| `APP_ENV` | R | `production` on Render | `development` locally loads `python_engine/.env` |
| `MONGODB_URI` | R, S | | same cluster and database as the API |
| `MONGODB_DB_NAME` | R | `gini_demo_dev` | same as the API |
| `NODE_API_INTERNAL_URL` | R | `http://localhost:5000` | deployed: `https://gini-api.vercel.app`; agent commands go through the API so humans and agents share one set of validated transitions |
| `INTERNAL_SERVICE_TOKEN` | R, S | | identical to the API |
| `ENGINE_TICK_SECONDS` | O | `5` | loop interval (local tests use 1–3) |
| `ENGINE_JOB_LEASE_SECONDS` | O | `60` | job and session lease length; a crashed worker's lease is taken over after this |
| `ENGINE_MAX_RETRIES` | O | `5` | then the job is dead-lettered (visible and retryable under Administration → Jobs & engine) |
| `ENGINE_WORKER_ID` | O | `<hostname>-<pid>` | |
| `SNAPSHOT_INTERVAL_SECONDS` | O | `300` | |
| `SIMULATION_SEED` | O | `42` | deterministic agents |
| `DEFAULT_PLANT_TIMEZONE` | O | `America/Bogota` | must match the dataset's site timezone |
| `DEFAULT_SIMULATION_MODE` | O | `interactive` | |
| `SAFETY_BUFFER_MINUTES` | O | `10` | cutoff band buffer |

## Operator and admin apps (`frontend/.env`, `admin/.env`, Vercel projects `gini-operator` / `gini-admin`)

| Variable | Kind | Operator | Admin | Notes |
|---|---|---|---|---|
| `VITE_API_BASE_URL` | R | `/api` | `/api` | keep `/api`: the browser calls its own origin, Vercel rewrites to the API project |
| `VITE_APP_KIND` | R | `operator` | `admin` | selects cookie names and permitted roles |
| `VITE_POLL_INTERVAL_MS` | O | `5000` | `5000` | |
| `VITE_SHOW_SYNTHETIC_BANNER` | O | `true` | `true` | keep `true` for the demo |
| `DEV_API_PROXY_TARGET` | O (local) | `http://localhost:5000` | `http://localhost:5000` | Vite dev/preview proxy only; not in browser code |

The deployed `/api` destination is **not** an environment variable — Vercel does not interpolate variables in
`vercel.json`. Set it once per app project:

```bash
cd frontend && npm run configure:vercel -- https://gini-api.vercel.app
cd admin    && npm run configure:vercel -- https://gini-api.vercel.app
```

This rewrites the first rule in that project's `vercel.json` (commit the change).

## Seed commands (`backend/.env` or the shell)

| Variable | Used by | Notes |
|---|---|---|
| `MONGODB_URI`, `MONGODB_DB_NAME` | all seed scripts | |
| `DEMO_PIN_SEED` | `setup_accounts.py` | 12+ chars; demo PIN = HMAC-SHA256(seed, loginId) mod 10^6, six digits with leading zeros. Keep it secret: anyone with it can derive demo PINs |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `ADMIN_EMAIL` | `setup_accounts.py` | creates the administrator once (insert-only); password 15+ chars; must be changed at first sign-in |
