# Copied unchanged (apart from this line) from GiNi_Synthetic_v3_Final/generator/scenario_resolver.py - the dataset package's own DELTA-run resolver.
"""Scenario model and executable resolver for the GiNi synthetic dataset.

Storage model (see SCENARIO_MODEL and SCENARIO_INHERITANCE sheets):
  * GLOBAL tables (no RUN_ID): shared immutable master data (workers, stations, products, CTQ checks...).
  * FULL runs (RUN-BASE, RUN-MINI-*): every scenario-specific row is stored under the run's own RUN_ID.
  * DELTA runs (RUN-ALT-*): counterfactual branches of RUN-BASE at BRANCH_AT. Only branch-specific rows are
    stored under the branch RUN_ID; everything else is inherited from the baseline by an explicit rule.

Resolution rule for table X, branch run R with baseline B and branch time t_b:
    resolved(R, X) = rows(R, X)                                                    (branch rows: new or override)
                   + { b in rows(B, X) : anchor(b) < t_b  and  key(b) not in keys(rows(R, X)) }   (inherited)
  where anchor() is the table's ANCHOR column (KNOWN_AT, or the creation time for tables without KNOWN_AT; "ALL" = plan tables
  whose every baseline row is inherited) and key() its primary key.
A baseline row is therefore inherited only when it was already known (or, for tables without KNOWN_AT, created)
before the branch AND the branch run did not override
it. An override carries the same primary key as the baseline row it replaces (same physical entity, e.g. an
operation started before the branch and finished differently after it) and SCENARIO_ROW_TYPE = BRANCH_OVERRIDE.
New branch rows carry run-specific ID prefixes (e.g. -A1-) and SCENARIO_ROW_TYPE = BRANCH_NEW, so a reference can
never be satisfied by accidentally matching an unrelated row of another scenario.

The resolver works on rows as loaded from the workbooks (datetimes) or on generator rows (sim minutes); the
caller supplies comparable anchor and branch values.
"""

ANCHOR = {
    # plan tables: every baseline row is inherited (attributes that change by run are overridden)
    "PRODUCTION_ORDERS": "ALL", "ORDER_LINES": "ALL", "PRODUCTION_BATCHES": "ALL",
    # rows without KNOWN_AT: their creation time
    "SHIFT_ROSTER": "PLANNED_START_AT", "OPERATION_INSTANCES": "CREATED_AT", "LABOR_SEGMENTS": "SEGMENT_START", "MATERIAL_LOTS": "AVAILABLE_AT",
    "MATERIAL_REQUESTS": "REQUESTED_AT", "GT_NONCONFORMANCES": "CREATED_AT",
    # everything else: inherited when it was already known (KNOWN_AT) before the branch
}
for _t in ("BATCH_UNIT_MEMBERSHIP", "BATCH_EVENTS", "UNIT_MASTER", "TASK_ASSIGNMENTS", "OPERATION_CREW", "ATTENDANCE_EVENTS", "LOGIN_EVENTS", "WORKER_EVENTS",
           "TASK_EVENTS", "PRODUCTION_EVENTS", "EQUIPMENT_EVENTS", "TRANSFER_EVENTS", "HANDOVERS", "DEVICE_HEARTBEATS", "MATERIAL_EVENTS", "MATERIAL_REQUEST_EVENTS",
           "INSPECTION_HEADER", "INSPECTION_READINGS", "QUALITY_DISPOSITIONS", "DEFECT_RECORDS", "DEFECT_INVESTIGATIONS", "INVESTIGATION_EVENTS",
           "INVESTIGATION_EVIDENCE", "REWORK_TASKS", "REPLACEMENT_REQUESTS", "ACTION_LOG", "STANDARD_REVISIONS",
           "ATTENDANCE_EVENTS_RAW", "ATTENDANCE_CORRECTIONS", "APP_SESSIONS", "ATTENDANCE_INTERVALS", "SUPPORT_REQUESTS", "ROSTER_CHANGES", "OVERTIME_APPROVALS",
           # v3 supplemental derived tables
           "WORKER_TASK_PLAN", "WORKSTATION_QUEUE_ENTRIES", "OPERATION_MILESTONE_EVENTS", "RETURN_MOVEMENTS", "HOLD_CASES"):
    ANCHOR.setdefault(_t, "KNOWN_AT")
PK = {
    "PRODUCTION_ORDERS": "ORDER_ID", "ORDER_LINES": "ORDER_LINE_ID", "PRODUCTION_BATCHES": "BATCH_ID", "SHIFT_ROSTER": "ROSTER_ID",
    "BATCH_UNIT_MEMBERSHIP": "MEMBERSHIP_ID", "BATCH_EVENTS": "EVENT_ID", "UNIT_MASTER": "UNIT_ID", "OPERATION_INSTANCES": "OPERATION_INSTANCE_ID",
    "TASK_ASSIGNMENTS": "TASK_ID", "OPERATION_CREW": "CREW_INTERVAL_ID", "LABOR_SEGMENTS": "SEGMENT_ID", "ATTENDANCE_EVENTS": "EVENT_ID",
    "LOGIN_EVENTS": "EVENT_ID", "WORKER_EVENTS": "EVENT_ID", "TASK_EVENTS": "TASK_EVENT_ID", "PRODUCTION_EVENTS": "EVENT_ID",
    "EQUIPMENT_EVENTS": "EVENT_ID", "TRANSFER_EVENTS": "EVENT_ID", "HANDOVERS": "HANDOVER_ID", "DEVICE_HEARTBEATS": "EVENT_ID",
    "MATERIAL_LOTS": "MATERIAL_LOT_ID", "MATERIAL_EVENTS": "EVENT_ID", "MATERIAL_REQUESTS": "REQUEST_ID", "MATERIAL_REQUEST_EVENTS": "EVENT_ID",
    "INSPECTION_HEADER": "INSPECTION_ID", "INSPECTION_READINGS": "READING_ID", "QUALITY_DISPOSITIONS": "DISPOSITION_ID", "DEFECT_RECORDS": "DEFECT_ID",
    "DEFECT_INVESTIGATIONS": "INVESTIGATION_ID", "INVESTIGATION_EVENTS": "EVENT_ID", "INVESTIGATION_EVIDENCE": "EVIDENCE_ID", "REWORK_TASKS": "REWORK_TASK_ID",
    "REPLACEMENT_REQUESTS": "REQUEST_ID", "ACTION_LOG": "ACTION_ID", "STANDARD_REVISIONS": "REVISION_ID", "GT_NONCONFORMANCES": "NC_ID",
    "ATTENDANCE_EVENTS_RAW": "RAW_EVENT_ID", "ATTENDANCE_CORRECTIONS": "CORRECTION_ID", "APP_SESSIONS": "SESSION_ID", "ATTENDANCE_INTERVALS": "INTERVAL_ID",
    "SUPPORT_REQUESTS": "SUPPORT_REQUEST_ID", "ROSTER_CHANGES": "ROSTER_CHANGE_ID", "OVERTIME_APPROVALS": "OVERTIME_ID",
    "WORKER_TASK_PLAN": "PLAN_ID", "WORKSTATION_QUEUE_ENTRIES": "QUEUE_ENTRY_ID", "OPERATION_MILESTONE_EVENTS": "MILESTONE_EVENT_ID", "RETURN_MOVEMENTS": "RETURN_ID", "HOLD_CASES": "HOLD_ID",
}
INHERITABLE = set(ANCHOR)


def anchor_of(table, row):
    col = ANCHOR[table]
    if col == "ALL":
        return None
    v = row.get(col)
    return v if v is not None else row.get("KNOWN_AT")


def resolve(rows, table, run_id, catalog, norm=None):
    """rows: all stored rows of `table` (every RUN_ID). catalog: {run_id: dict(BASELINE_RUN_ID, BRANCH_AT, STORAGE_MODE)}.
    Returns the complete logical view of `table` for `run_id`; each row gets RESOLVED_RUN_ID and SOURCE_RUN_ID."""
    meta = catalog.get(run_id, {})
    own = [r for r in rows if r.get("RUN_ID") == run_id]
    out = [dict(r, RESOLVED_RUN_ID=run_id, SOURCE_RUN_ID=run_id) for r in own]
    if meta.get("STORAGE_MODE") != "DELTA" or table not in INHERITABLE:
        return out
    base, t_b = meta["BASELINE_RUN_ID"], meta["BRANCH_AT"]
    key = PK[table]
    own_keys = {r[key] for r in own}
    nb = norm(t_b) if norm else t_b
    for b in resolve(rows, table, base, catalog, norm):    # baselines may themselves be branches
        if b[key] in own_keys:
            continue
        a = anchor_of(table, b)
        if ANCHOR[table] == "ALL" or (a is not None and (norm(a) if norm else a) < nb):
            out.append(dict(b, RESOLVED_RUN_ID=run_id, SOURCE_RUN_ID=b["SOURCE_RUN_ID"]))
    return out


def resolve_all(tables, run_id, catalog, norm=None):
    """tables: {table: rows}. Returns {table: resolved rows} for every scenario-specific table."""
    return {t: resolve(rows, t, run_id, catalog, norm) for t, rows in tables.items() if rows and "RUN_ID" in rows[0]}


def as_run(resolved_rows):
    """copy resolved rows with RUN_ID set to the resolved run (for code that filters on RUN_ID)."""
    return [dict(r, RUN_ID=r["RESOLVED_RUN_ID"]) for r in resolved_rows]
