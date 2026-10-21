"""Fork an interactive session (or refresh a replay projection) from the reduced state at the checkpoint.

Writes the session-scoped operational projections (sim_units, sim_operations, sim_tasks, sim_workers, sim_equipment,
sim_materials, sim_inspections, sim_holds, sim_returns, sim_plan_releases, sim_material_requests). Idempotent: a retry
first removes this session's projections (the session is INITIALIZING, so no user command can have written yet).
"""
import datetime as dt

from .reduce import reduce_state, summary
from .timeutil import utcnow

SESSION_COLLS = ["sim_units", "sim_operations", "sim_tasks", "sim_workers", "sim_equipment", "sim_materials", "sim_inspections", "sim_holds",
                 "sim_returns", "sim_plan_releases", "sim_material_requests"]
RESET_COLLS = SESSION_COLLS + ["sim_events", "sim_participation", "sim_readings", "sim_evidence", "sim_dispositions", "sim_defects", "sim_investigations",
                               "sim_points_ledger", "sim_alerts", "sim_alert_transitions", "sim_forecasts", "sim_projections", "sim_actions", "sim_replacements",
                               "sim_milestones", "sim_queue_events", "sim_attendance", "sim_progress", "sim_notifications_view", "sim_points_evaluations", "sim_batch_membership", "sim_batches"]


def _base(session, doc, now):
    d = dict(doc)
    d.update({"SESSION_ID": session["SESSION_ID"], "RUN_ID": session["RUN_ID"], "DATASET_ID": session["DATASET_ID"], "VERSION": 1, "UPDATED_AT": now, "_origin": "APP"})
    return d


def write_state(db, session, state, replace=True):
    sid = session["SESSION_ID"]
    now = utcnow()
    if replace:
        for c in SESSION_COLLS:
            db[c].delete_many({"SESSION_ID": sid})
    groups = {
        "sim_units": [u for u in state["units"].values() if u["STATE"] not in ("ROUTE_COMPLETE", "SCRAPPED") or True],
        "sim_operations": list(state["operations"].values()),
        "sim_tasks": list(state["tasks"].values()),
        "sim_workers": [dict(w, CONTROL={"MODE": "AGENT"}) for w in state["workers"].values()],
        "sim_equipment": list(state["equipment"].values()),
        "sim_materials": list(state["materials"].values()),
        "sim_inspections": list(state["inspections"].values()),
        "sim_holds": list(state["holds"].values()),
        "sim_returns": list(state["returns"].values()),
        "sim_plan_releases": list(state["plan_releases"]),
        "sim_material_requests": list(state["material_deliveries"]),
    }
    counts = {}
    for c, docs in groups.items():
        docs = [_base(session, d, now) for d in docs]
        for i in range(0, len(docs), 500):
            if docs[i:i + 500]:
                db[c].insert_many(docs[i:i + 500], ordered=False)
        counts[c] = len(docs)
    return counts


def init_session(db, cat, session):
    """INIT_SESSION job: reduce the source run at the fork and write the session's projections."""
    state = reduce_state(db, cat, session["SOURCE_RUN_ID"], session["FORK_AT"], session["DATASET_ID"])
    counts = write_state(db, session, state)
    s = summary(state)
    good = {k: len(v) for k, v in state["good_by_line"].items()}
    scrap = {k: len(v) for k, v in state["scrap_by_line"].items()}
    # conditional on INITIALIZING: an archive (or a second reset) that happened meanwhile is never overwritten
    db.sim_sessions.update_one({"SESSION_ID": session["SESSION_ID"], "STATUS": "INITIALIZING"}, {"$set": {
        "STATUS": "READY", "INIT": {"COMPLETED_AT": utcnow(), "COUNTS": counts, "SUMMARY": s, "WARNINGS": state["warnings"],
                                    "GOOD_BY_LINE_AT_FORK": good, "SCRAP_BY_LINE_AT_FORK": scrap,
                                    "BASIS": "Records with EVENT_TIME <= FORK_AT and KNOWN_AT <= FORK_AT of the source run; ref_* analytics not used"},
        "ENGINE.SIM_AT": session["FORK_AT"], "UPDATED_AT": utcnow()}})
    return {"counts": counts, "summary": s}
