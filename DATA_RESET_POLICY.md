# Data reset policy

## What never happens

* **Starting the app never resets anything.** The API, the engine, `gini-3-start.ps1` and `gini-fresh-setup.ps1` contain no
  delete path for business data. `npm run factory:init` only creates what is missing (indexes, the admin if absent,
  the empty `S-FACTORY` session) and never resets an existing admin's password.
* **Your previous database is never touched.** The fresh factory works in the database named by `MONGODB_DB_NAME`
  (`gini_factory_teamtest` in the delivered `.env`). Nothing in this delivery drops, renames or overwrites another database.
* `factory:init` refuses a database that holds the synthetic demonstration; the workbook seed tools refuse a fresh-factory
  database. The synthetic session reset / archive endpoints refuse the factory session.
* No reset was executed against your database while this delivery was built. The reset was tested only on a disposable
  test database (`TEST_RESULTS_FRESH_FACTORY.md`).

## The optional “Reset test factory” action

For a **disposable team-test environment only**. Default: **disabled**.

| Protection | How |
|---|---|
| Off by default | `ALLOW_FACTORY_RESET=false` in `backend/.env`. To enable it you must edit the file and restart the API. |
| Never in production | refused when `NODE_ENV=production`, whatever the flag says |
| Fresh factory only | refused unless `GINI_ENVIRONMENT=FRESH_FACTORY` |
| Admin only | permission `factory_reset` (ADMIN role only) |
| Shows the exact target | Factory setup → **Reset** shows database name, dataset, factory name, session |
| Preview | counts per collection of what would be removed and what is kept |
| Typed confirmation | type `RESET <database name>` **and** the factory name exactly, **and** tick the acknowledgement |
| Quiesce first | the session goes to `RESETTING`; the engine and commands stop touching it; queued jobs, pending notifications and idempotency keys of the session are removed, so a stale job or browser cannot recreate deleted records |
| Operator sign-ins end | every worker login session is revoked; admin sign-ins stay |
| Audit kept outside the cleared data | `factory_reset_log` (started / completed, preview, options, removed counts) and an `audit_log` row `FACTORY_RESET` |
| Clean result | `S-FACTORY` re-created empty (same ID, new `RESET_GENERATION`), configured equipment UP and materials at stock 0, workers back in the session not clocked in; the engine recalculates forecasts and projections from the empty state on its next cycle |

### What the reset removes and keeps

| Removed (session `S-FACTORY` only) | Kept |
|---|---|
| tanks, batches, operations, tasks, attendance, labour segments, milestones, inspections, readings, holds, dispositions, returns, replacements, materials stock and lots, equipment status, events, points ledger and evaluations, alerts, forecasts, projections, actions, session change log; orders / order lines / batches / plan rows of the session | admin accounts, roles and permissions, rule settings and points policy, `audit_log`, `factory_reset_log`, evidence files |
| **only if “also remove workers” is ticked**: workers, worker logins, qualifications, rosters | otherwise workers and their logins (with zero history) |
| **only if “also remove the configuration” is ticked**: work centres, stations, skills, equipment, materials, products, routes, checklists, shifts, calendar | otherwise the whole factory configuration |

### Evidence photos (Cloudinary / local storage)

The reset **does not delete** stored photos - not in Cloudinary (which may be shared with other environments) and not in
the local evidence folder. After a reset their database references are gone. To clean them up, do it separately and
deliberately: in Cloudinary delete the folder used by this environment from the Media Library; for local storage delete
the files under `EVIDENCE_LOCAL_DIR`. Check first that no other environment uses the same folder.

### Recommended procedure

1. Only on a database you can lose. Prefer a **new** database name for a new test round instead of a reset
   (change `MONGODB_DB_NAME` in both `.env` files, run `gini-fresh-setup.ps1` again).
2. If you really want a reset: set `ALLOW_FACTORY_RESET=true`, restart the API, ask the team to stop working,
   Factory setup → **Reset** → read the preview → type the two confirmations → tick → **Reset operational data**.
3. Set `ALLOW_FACTORY_RESET=false` again and restart the API.

## Going back to the synthetic demonstration

Not a reset: point both `.env` files back to your previous database (the name is in the comment above
`MONGODB_DB_NAME`), `GINI_ENVIRONMENT=SYNTHETIC_DEMO`, `DATASET_ID=GINI-SYN-TANKS`, restart. Both databases stay intact.
