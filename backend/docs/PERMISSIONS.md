# Permissions

Generated from `contracts/permissions.json`, which the Express API enforces on every request (`middleware/auth.js`,
`domain/executor.js`) and `seed/setup_accounts.py` mirrors. The browser hides actions a role cannot use, but the API is the
authority: a hidden button is never the only protection.

## Role per worker role (explicit map — never substring matching)

| WORKER_MASTER.WORKER_ROLE | Application role | Can sign in to |
|---|---|---|
| PRODUCTION_OPERATOR | OPERATOR | operator |
| QUALITY_INSPECTOR | INSPECTOR | operator |
| QUALITY_SUPERVISOR | QUALITY_SUPERVISOR | operator, admin |
| AREA_SUPERVISOR | SUPERVISOR | operator, admin |
| SHIFT_MANAGER | MANAGER | operator, admin |
| MAINTENANCE_TECHNICIAN | MAINTENANCE | operator |
| MATERIAL_HANDLER | MATERIAL_HANDLER | operator |
| (administrator account created by `setup_accounts.py`) | ADMIN | admin |

Unknown worker roles get no account and cannot sign in (reported by `setup_accounts.py`).

## Permission matrix

| Permission | Meaning | OPERATOR | INSPECTOR | QUALITY_SUPERVISOR | SUPERVISOR | MANAGER | MAINTENANCE | MATERIAL_HANDLER | ADMIN |
|---|---|---|---|---|---|---|---|---|---|
| `operate_own_tasks` | Accept/start/pause/finish own tasks, record milestones, clock in/out, breaks | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| `submit_self_check` | Submit an operator self-check where a gate allows it (never an independent release) | ✓ |  |  |  |  |  |  |  |
| `report_incoming_defect` | Report a defect found on a received tank against the prior operation | ✓ | ✓ |  |  |  |  |  |  |
| `view_own_progress` | Own progress, labour categories and points ledger | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `perform_quality_inspection` | Perform an independent gate inspection and record readings/evidence |  | ✓ | ✓ |  |  |  |  | ✓ |
| `release_gate` | Release a tank that passed an independent gate inspection |  | ✓ | ✓ |  |  |  |  | ✓ |
| `quality_approval` | Decide dispositions (rework/scrap/pending review), approve alternate rework stations, confirm investigation causes |  |  | ✓ |  |  |  |  | ✓ |
| `operational_supervision` | Assign/dispatch tasks, confirm absences, view all workers, acknowledge alerts |  |  |  | ✓ | ✓ |  |  | ✓ |
| `approve_transfers` | Approve worker transfers and recovery actions |  |  |  | ✓ | ✓ |  |  | ✓ |
| `rule_editing` | Edit variance/cutoff/points rule settings (versioned) |  |  |  |  | ✓ |  |  | ✓ |
| `manage_workers` | Create, edit, deactivate workers and accounts; qualifications; rosters |  |  |  |  |  |  |  | ✓ |
| `scenario_control` | Create demo sessions, control the simulation clock, use the scenario console, reset to checkpoint |  |  |  |  |  |  |  | ✓ |
| `view_all_workers` | Plant-wide workforce views and worker timelines |  |  | ✓ | ✓ | ✓ |  |  | ✓ |
| `equipment_status` | Record breakdowns/repairs |  |  |  |  |  | ✓ |  | ✓ |
| `material_movements` | Record deliveries, shortages and stock movements |  |  |  |  |  |  | ✓ | ✓ |
| `view_evidence` | View inspection photos/evidence |  | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `view_audit` | View audit log and import validation |  |  |  |  | ✓ |  |  | ✓ |

## Commands and the permission each requires

All writes are `POST /api/sessions/{sid}/commands/{type}` with an `Idempotency-Key`. Operators may act only on their
own worker record (ownership is checked in the handler); `trustedOnly` commands are issued by the engine through the
internal endpoint; `agentAllowed: false` commands are never issued by simulated agents.

| Command | Requires | Notes |
|---|---|---|
| `ALERT_WORKFLOW` | [operational_supervision, quality_approval] |  |
| `ACTION_PROPOSE` | [operational_supervision, approve_transfers] |  |
| `ACTION_APPROVE` | approve_transfers |  |
| `ACTION_REJECT` | approve_transfers |  |
| `ACTION_START` | approve_transfers |  |
| `ACTION_COMPLETE` | approve_transfers |  |
| `EVIDENCE_REQUEST_UPLOAD` | [perform_quality_inspection, submit_self_check, report_incoming_defect] | agentAllowed: false |
| `EVIDENCE_MARK_VERIFIED` | [perform_quality_inspection, submit_self_check, report_incoming_defect] | trustedOnly, agentAllowed: false |
| `OPERATION_START` | [operational_supervision, operate_own_tasks] |  |
| `TASK_ASSIGN` | operational_supervision |  |
| `PROCESS_COMPLETE` | [operational_supervision, scenario_control] |  |
| `BATCH_RELEASE` | [operational_supervision, scenario_control] |  |
| `EQUIPMENT_BREAKDOWN` | [equipment_status, scenario_control, operational_supervision] |  |
| `EQUIPMENT_REPAIRED` | [equipment_status, scenario_control, operational_supervision] |  |
| `MATERIAL_SHORTAGE` | [material_movements, scenario_control] |  |
| `MATERIAL_REQUEST` | [material_movements, operational_supervision, scenario_control] |  |
| `MATERIAL_DELIVERY` | [material_movements, scenario_control, operational_supervision] |  |
| `MATERIAL_REQUEST_CANCEL` | [material_movements, operational_supervision] |  |
| `WORKER_TRANSFER` | approve_transfers |  |
| `TRANSFER_ARRIVE` | [approve_transfers, operate_own_tasks] |  |
| `ABSENCE_CONFIRM` | [operational_supervision, scenario_control] |  |
| `OVERTIME_APPROVE` | [operational_supervision, approve_transfers] |  |
| `ATTENDANCE_CORRECTION` | operational_supervision |  |
| `SEED_DEFECT` | scenario_control | agentAllowed: false |
| `SET_ENTRY_LAG` | scenario_control | agentAllowed: false |
| `INSPECTION_START` | [perform_quality_inspection, submit_self_check] |  |
| `INSPECTION_SAVE_DRAFT` | [perform_quality_inspection, submit_self_check] |  |
| `INSPECTION_SUBMIT` | [perform_quality_inspection, submit_self_check] |  |
| `UNIT_RELEASE` | release_gate |  |
| `UNIT_ARRIVE` | [material_movements, operational_supervision, release_gate] |  |
| `INCOMING_DEFECT_REPORT` | report_incoming_defect |  |
| `DISPOSITION_DECIDE` | quality_approval |  |
| `RETURN_DISPATCH` | [material_movements, operational_supervision, quality_approval] |  |
| `RETURN_ARRIVE` | [material_movements, operational_supervision, quality_approval] |  |
| `INVESTIGATION_UPDATE` | quality_approval |  |
| `REPLACEMENT_REQUEST` | [operational_supervision, quality_approval] |  |
| `REPLACEMENT_APPROVE` | [operational_supervision, approve_transfers] |  |
| `TASK_ACCEPT` | operate_own_tasks |  |
| `TASK_START` | operate_own_tasks |  |
| `TASK_RESUME` | operate_own_tasks |  |
| `TASK_PAUSE` | operate_own_tasks |  |
| `MILESTONE_COMPLETE` | operate_own_tasks |  |
| `TASK_FINISH` | operate_own_tasks |  |
| `TASK_JOIN` | operate_own_tasks |  |
| `TASK_HANDOVER` | operate_own_tasks |  |
| `HELP_REQUEST` | operate_own_tasks |  |
| `SUPPORT_RESOLVE` | [operational_supervision, equipment_status] |  |
| `CLOCK_IN` | [operate_own_tasks, perform_quality_inspection, operational_supervision] |  |
| `CLOCK_OUT` | [operate_own_tasks, perform_quality_inspection, operational_supervision] |  |
| `BREAK_START` | [operate_own_tasks, perform_quality_inspection] |  |
| `BREAK_END` | [operate_own_tasks, perform_quality_inspection] |  |
| `TAKE_CONTROL` | [operate_own_tasks, perform_quality_inspection, scenario_control] | agentAllowed: false |
| `CONTROL_HEARTBEAT` | [operate_own_tasks, perform_quality_inspection, scenario_control] | agentAllowed: false |
| `RELEASE_CONTROL` | [operate_own_tasks, perform_quality_inspection, scenario_control] | agentAllowed: false |

## Other protected endpoints

| Endpoint | Requires |
|---|---|
| `GET /api/sessions/{sid}/overview`, `/workforce`, `/orders`, `/alerts`, `/forecasts`, `/actions`, `/events` | any of operational_supervision, quality_approval, view_all_workers, scenario_control |
| `GET /api/sessions/{sid}/workers/{wid}` | own record, or a supervisory permission above |
| `GET /api/sessions/{sid}/inspections/{id}` | the inspector, or view_evidence / quality_approval / operational_supervision / perform_quality_inspection |
| `POST /api/sessions` , `/clock`, `/reset`, `/archive`, `/default` | scenario_control |
| `POST /api/sessions/{sid}/recalculate` | operational_supervision, scenario_control or quality_approval |
| `GET/POST/PATCH /api/admin/workers…` | manage_workers (read also view_all_workers) |
| `PUT /api/admin/rules` | rule_editing |
| `GET /api/admin/audit` | view_audit or manage_workers |
| `GET /api/admin/import-status` | view_audit, manage_workers or scenario_control |
| `GET /api/admin/jobs` / `POST …/retry` | scenario_control or view_audit / scenario_control |
| `/api/internal/*` | `INTERNAL_SERVICE_TOKEN` bearer (engine only; not reachable with a browser session) |

Sign-in is also bound to the app: an operator-app session cookie is not accepted by the admin app and vice versa
(`X-App-Kind` + per-app cookie names), and roles outside `app_kinds` for that app are refused at sign-in.
