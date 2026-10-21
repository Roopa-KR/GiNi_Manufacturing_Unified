# Source audit and legacy-to-manufacturing rule mapping

Audit date: 2026-10-17/18. Rule of evidence: a file counts as "read" only if it was opened and inspected in this
workspace; documentation that claims PASS was treated as a claim to verify, not as proof.

## 1. Inventory of supplied inputs

| Input | What it is | Used for | Status |
|---|---|---|---|
| `Siemens_Manufacturing_Master_Final.xlsx` (v3, 482 KB) | Master data: workers (196), skills, qualifications, routing, crew rules, workstations, equipment, CTQ checks/specs, instructions, milestones, calendars, transfer rules, disposition matrix, materials | **Seed source** (copied to `backend/data/final/`) | read, seeded |
| `Siemens_Manufacturing_Events_Final.xlsx`, `…_Analytics_Final.xlsx` (v3) | Event history and reference analytics | v3 seed source | **not supplied in this workspace** (see §3) |
| `Siemens_Manufacturing_Master.xlsx` / `…_Analytics.xlsx` (v1), `…_Master_Corrected.xlsx` (v2) | Earlier dataset versions | regression reference only (not needed at startup) | read during dataset phases |
| `generator.zip` (v2 generator: engine, forecast, metrics, points, alerts, replay, scenarios, validate) | Dataset generator | reference for intended calculations; regenerated the local Events/Analytics test fixture | read |
| `GiNi_v2.0_code_docs_validation.zip` | v2 docs (README, CLIENT_DECISIONS, UI_MAPPING, SCENARIO_WALKTHROUGH, DATA_DICTIONARY, validation) | client questions Q-01…Q-24, UI mapping | read |
| `README.md`, `VALIDATION_REPORT.md` (v2) | dataset documentation | claims cross-checked | read |
| `EN_Siemens_CTQ_Guide_1.xlsx` | Authoritative CTQ wording and answer polarity | checklist text; verified **16 tank + 5 cover + 3 accessory** checks (not 4 + 4) | read |
| `GiNi_SMD_Variance_Demo.xlsx` | Legacy warehouse variance workbook: `VARIANCE_RULE_CONFIG` R01–R12, S01–S03, `CONFIG` thresholds, alert lifecycle tables, expected results | legacy rule mapping (§4) | read |
| `GiNi_Live_Shift_Data.xlsx` | Legacy live-shift extension: attendance/login/break/labour/heartbeat events, `LIVE_OPERATOR_STATE`, freshness | worker-state, app-session ≠ attendance, freshness semantics | read |
| `workbook.xlsx` | Legacy 10-truck planning replay (cutoff, 30-min loading, 10-min minimum buffer) | cutoff/buffer concept (§5) | read |
| `TABLE_STRUCTURE.docx` | Legacy table schema notes (TI102, LM005S1, M150 …) | legacy column semantics | read |
| `Mockup_ingles_html.html` | UI mockup (English) | screen inventory and visual direction | read |
| `Pasted_text_20261016-072213_.txt` | Internal concept proposal | illustrative stories only (precedence 5) | read |
| `Pasted_markdown__2__4_.md`, `attachment-*.txt` | Conversation requirements: dataset structure, scoring, tank identity, batches, names, real-time behaviour, meeting transcript excerpt, product context | requirements | read |
| `GiNi_Claude_Full_Build_Prompt.md`, `attachment.txt` (final v3 prompt) | Implementation specification | governing spec | read |

## 2. Verified dataset facts (local fixture)

* People: **196** seeded = 160 `PRODUCTION_OPERATOR` + 12 `QUALITY_INSPECTOR` + 8 `MAINTENANCE_TECHNICIAN` + 8
  `MATERIAL_HANDLER` + 4 `AREA_SUPERVISOR` + 2 `SHIFT_MANAGER` + 2 `QUALITY_SUPERVISOR` (≥ 150 operators requirement met).
* Default checkpoint `CK-20261015-1055` on `RUN-BASE` reduces to: 196 people in the plant view, 62 with an active task, 34
  productively working, 28 active tanks, 10 queued, 18 open operations, 1 open inspection, 2 pieces of equipment down.
* **Superseded (v3 repair, 2026-10-18):** the earlier local fixture (123 collections, 539,360 documents) is no longer used.
  The actual Final workbooks are imported: 146 collections, 595,781 documents, 508 checks passed, 3,474,855 references, 0
  missing (DATA_IMPORT_REPORT.md at the project root).

## 3. Gaps and how they are handled

| Missing | Effect | Handling |
|---|---|---|
| v3 `Events_Final` and `Analytics_Final` workbooks | **Resolved in the v3 repair.** The actual Final workbooks are imported and validated (DATA_IMPORT_REPORT.md); the regenerated v2 fixture is not an accepted seed source. | — |
| `SMD-ETC-Analysis-main.zip` (incl. `calculations/bands.py`) | Original cutoff code not inspected | Bands implemented from the prompt's definition and the legacy workbook concept; tests cover every boundary. Not claimed to reproduce `bands.py`. |
| `real-time-visibility (1).zip`, `gini_smd_variance_demo_clear_ui(4).zip` | Legacy source code not inspected | Rule semantics taken from the legacy **workbooks** (which carry the rule config and expected results) |
| "Roopa" implementation | not located | Not claimed reproduced |
| `GiNi_Synthetic_v3_Final.zip` package | **Resolved in the v3 repair.** Manifest, checksums and reference checks are read by `seed/import_workflow.py`. | — |
| npm / PyPI registries and a MongoDB server | The registries and every MongoDB download were unreachable | **Updated in the v3 repair:** the real libraries (express, mongodb, bson, nodemailer, pymongo, dnspython) were built from their official GitHub release tags; the library stand-ins were removed. The database is still a labelled TEST SUBSTITUTE (`backend/devtools/`), so **the real-MongoDB gate is BLOCKED** — see IMPLEMENTATION_STATUS.md |

## 4. Legacy variance flags → manufacturing rules

Legacy source: `GiNi_SMD_Variance_Demo.xlsx` `VARIANCE_RULE_CONFIG` (warehouse picking: lines, pieces, SHORTQTY,
CUTQTY, work types). Manufacturing rules: `backend/config/rules.json` (each rule carries its `legacy` field).

| Legacy | Legacy definition (abridged) | Manufacturing rule | Changed semantics and denominators |
|---|---|---|---|
| R01 LOW_PRODUCTIVITY | (actual LPH − goal)/goal × 100, LPH = lines / labour-hours; −15 % low, −30 % critical, 3 consecutive | **M01** Low labour efficiency | Lines/hour → earned standard minutes ÷ eligible actual labour minutes of **completed** attempts; threshold ≤ 85 % (critical 70 %); the legacy `× RESOURCES` double count removed; min 3 completed operations and 120 labour-min |
| R02 PRODUCTIVITY_GAP | goal LPH × labour-hours − completed lines ≥ 10 lines and ≥ 10 % | **M02** Earned-work gap | gap in standard minutes (≥ 120 min and ≥ 15 % of earned); completion-bias guard |
| R03 WORKTYPE_PERFORMANCE | LOW < −15 %, ON_TARGET, OVER_TARGET > +10 % | **M03** classification | LOW < 85 %, ON_TARGET 85–110 %, OVER_TARGET > 110 %; classification only |
| R04 HIGH_BACKLOG, R05 BACKLOG_GROWTH | open lines vs same-time baseline (+30 %, ≥ 20 lines); growth 15 %/15 min; previous 0 → NEW_BACKLOG | **M04** | open lines → queued **standard labour minutes** (unlike products are not counted as equal tanks); +30 % and ≥ 300 std-min; growth 15 % and ≥ 100 std-min; zero baseline → absolute threshold / NEW_BACKLOG |
| R06 LABOR_IMBALANCE, R07 ESTIMATED_UNDERSTAFFING | required hours = open lines / goal LPH vs remaining worker-hours to cutoff; required workers = ceil | **M05** | remaining standard work vs **uniquely counted qualified** remaining productive minutes before shift end (breaks excluded); gap ≥ 60 min; staffing gap estimate |
| R08 HIGH_SHORT_RATE, R09 HIGH_CUT_RATE | SHORTQTY or CUTQTY / processed qty vs baseline (provisional) | **M06** Excess rework / scrap | **SHORT/CUT do not mean scrap or rework.** Replaced by first-attempt gate fail rate (failed ÷ first-attempt inspections, ≥ 10 % and ≥ 5 pp over baseline, ≥ 8 inspections) and scrap count (any scrap → HIGH) |
| R10 PRODUCTIVITY_QUALITY_CONFLICT | productivity +10 pp while short/cut rate +40 % over 120 min | **M07** | efficiency +10 pp while gate fail rate +40 % relative; correlation, never blame |
| R11 WORKLOAD_SURGE | open pieces vs baseline +30 % | **M08** | released standard minutes into WC1 in 120 min vs same-slot baseline (+30 %, ≥ 600 std-min) |
| R12 ETC_COMPLETION_RISK | ETC = open lines / recent throughput vs 14:30 cutoff; zero throughput → NO_THROUGHPUT | **M09** + cutoff bands | homogeneous throughput replaced by the route DES forecast of good tanks by due time; GREEN/AMBER/RED/UNKNOWN with 10-min buffer; unknown never on time |
| S01 OPERATOR_IDLE_WITH_WORK_AVAILABLE | logged in, no completion ≥ 15 min, ≥ 3 open lines | **M13** assignment delay (+ stale telemetry) | fires only when ready work **and** an eligible available worker exist for 20 min; a long operation without a completed tank is never "idle"; stale signal = last-known, not idle |
| S02 PASSED_WORK_SPIKE | passes in 60 min ≥ 4 × baseline | not applicable | no "pass" (skip a pick) action in tank manufacturing; handovers are recorded explicitly |
| S03 ALL_SHORT_EPISODE | ≥ 3 consecutive short lines | not applicable | no equivalent; quality episodes are gate FAILs with holds (M06) |
| — (new) | | **M10** starvation/blocking, **M11** equipment/material interruption, **M12** missing qualification/minimum crew | manufacturing-specific; waiting for an external cause is never underperformance |
| AR-01…AR-06 (requested flags) | | **F1** Stalled Active Assignment, **F2** Regional Workload Imbalance, **F3** Material Velocity Anomaly, **F4** Location Velocity Anomaly, **F5** Congestion, **F6** Replenishment Delay | evidence-driven; see `formulas.md` §4 |

Legacy lifecycle concepts reused: separate evaluation state and workflow state, consecutive-breach persistence,
recovery count, alert evidence. Legacy thresholds were kept where the meaning carried over (−15 %/−30 % → 85 %/70 %,
+30 % backlog/surge, 15 % growth, +10 pp / +40 % conflict).

## 5. Cutoff logic

Legacy (warehouse): fixed 14:30 cutoff, 30-min truck loading, minimum 10-min buffer, ETC from homogeneous throughput.
Manufacturing: each order line's due time is the cutoff for route-complete good output; the 10-min safety buffer is
configurable; bands are classified from the DES forecast (not throughput × time), quantity shortfall is RED, unknown
stays UNKNOWN, a passed deadline turns RED without new events. Implementation `gini_engine/forecast.py:classify`; tests
`python_engine/tests/test_cutoff.py`.

## 6. Reuse, hard-coding and provisional logic

* Reused from the v2/v3 generator (as the reference for intended calculations): DR-1.0 dispatch order, crew-size
  elapsed model, points rules PTS-TV1/NR3/OF2/DD4, alert lifecycle, checkpoint/known-at semantics.
* Configuration, not code: rules and thresholds (`config/rules.json`, versioned edits stored in `rule_settings`),
  points policy, simulation defaults, permissions (`contracts/permissions.json`), indexes (`contracts/indexes.json`),
  state machines (`contracts/state_machines.json`).
* Deliberately fixed in code (documented): rework standard default, agent timing, replenishment policy, escalation
  30 min, overtime cap 120 min — see `ASSUMPTIONS.md`.
* Provisional (awaiting Siemens): points allocation, disposition matrix contents, CTQ numeric limits, crew standards,
  queue capacities, deadline meaning.

Requirements-to-code-and-test matrix: `IMPLEMENTATION_STATUS.md`.
