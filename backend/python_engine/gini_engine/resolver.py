"""Scenario resolver reused from the v3 dataset package (generator/scenario_resolver.py, unchanged rule).

resolved(R, X) = rows(R, X) + { b in resolved(BASELINE(R), X) : anchor(b) < BRANCH_AT(R) and key(b) not in keys(rows(R, X)) }

Used for replay of DELTA runs (RUN-ALT-*). Interactive sessions are stored separately in sim_* collections and read
history of their source run frozen at the fork (equivalent rule with anchor = KNOWN_AT/EVENT_TIME <= FORK_AT).
"""
ANCHOR = {
    "PRODUCTION_ORDERS": "ALL", "ORDER_LINES": "ALL", "PRODUCTION_BATCHES": "ALL",
    "SHIFT_ROSTER": "PLANNED_START_AT", "OPERATION_INSTANCES": "CREATED_AT", "LABOR_SEGMENTS": "SEGMENT_START", "MATERIAL_LOTS": "AVAILABLE_AT",
    "MATERIAL_REQUESTS": "REQUESTED_AT", "GT_NONCONFORMANCES": "CREATED_AT",
}
for _t in ("BATCH_UNIT_MEMBERSHIP", "BATCH_EVENTS", "UNIT_MASTER", "TASK_ASSIGNMENTS", "OPERATION_CREW", "ATTENDANCE_EVENTS", "LOGIN_EVENTS", "WORKER_EVENTS",
           "TASK_EVENTS", "PRODUCTION_EVENTS", "EQUIPMENT_EVENTS", "TRANSFER_EVENTS", "HANDOVERS", "DEVICE_HEARTBEATS", "MATERIAL_EVENTS", "MATERIAL_REQUEST_EVENTS",
           "INSPECTION_HEADER", "INSPECTION_READINGS", "QUALITY_DISPOSITIONS", "DEFECT_RECORDS", "DEFECT_INVESTIGATIONS", "INVESTIGATION_EVENTS",
           "INVESTIGATION_EVIDENCE", "REWORK_TASKS", "REPLACEMENT_REQUESTS", "ACTION_LOG", "STANDARD_REVISIONS", "ATTENDANCE_CORRECTIONS", "APP_SESSIONS",
           "ATTENDANCE_INTERVALS", "SUPPORT_REQUESTS", "ROSTER_CHANGES", "OVERTIME_APPROVALS", "WORKER_TASK_PLAN", "WORKSTATION_QUEUE_ENTRIES",
           "OPERATION_MILESTONE_EVENTS", "RETURN_MOVEMENTS", "HOLD_CASES", "POINTS_LEDGER"):
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
    "ATTENDANCE_CORRECTIONS": "CORRECTION_ID", "APP_SESSIONS": "SESSION_ID", "ATTENDANCE_INTERVALS": "INTERVAL_ID",
    "SUPPORT_REQUESTS": "SUPPORT_REQUEST_ID", "ROSTER_CHANGES": "ROSTER_CHANGE_ID", "OVERTIME_APPROVALS": "OVERTIME_ID",
    "WORKER_TASK_PLAN": "PLAN_ID", "WORKSTATION_QUEUE_ENTRIES": "QUEUE_ENTRY_ID", "OPERATION_MILESTONE_EVENTS": "MILESTONE_EVENT_ID", "RETURN_MOVEMENTS": "RETURN_ID",
    "HOLD_CASES": "HOLD_ID", "POINTS_LEDGER": "POINTS_TRANSACTION_ID",
}
INHERITABLE = set(ANCHOR)


def anchor_of(table, row):
    col = ANCHOR[table]
    if col == "ALL":
        return None
    v = row.get(col)
    return v if v is not None else row.get("KNOWN_AT")


def resolve(rows, table, run_id, catalog):
    """rows: stored rows of `table` for the run and its baselines; catalog: {run_id: RUN_CATALOG row}."""
    meta = catalog.get(run_id, {})
    own = [r for r in rows if r.get("RUN_ID") == run_id]
    out = [dict(r, RESOLVED_RUN_ID=run_id, SOURCE_RUN_ID=run_id) for r in own]
    if meta.get("STORAGE_MODE") != "DELTA" or table not in INHERITABLE:
        return out
    base, t_b = meta["BASELINE_RUN_ID"], meta["BRANCH_AT"]
    key = PK[table]
    own_keys = {r[key] for r in own}
    for b in resolve(rows, table, base, catalog):
        if b[key] in own_keys:
            continue
        a = anchor_of(table, b)
        if ANCHOR[table] == "ALL" or (a is not None and a < t_b):
            out.append(dict(b, RESOLVED_RUN_ID=run_id, SOURCE_RUN_ID=b["SOURCE_RUN_ID"]))
    return out


def run_chain(run_id, catalog):
    """run ids whose stored rows are needed to resolve run_id"""
    out = [run_id]
    meta = catalog.get(run_id, {})
    while meta.get("STORAGE_MODE") == "DELTA" and meta.get("BASELINE_RUN_ID"):
        out.append(meta["BASELINE_RUN_ID"])
        meta = catalog.get(meta["BASELINE_RUN_ID"], {})
    return out
