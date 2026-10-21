"""Labour accounting and observed manufacturing metrics for a session at time `now` (pure functions over loaded records).

Formula registry (also published in docs/formulas.md):
  actual labour minutes      = sum of non-overlapping participation intervals (DIRECT/REWORK) per worker; 3 people x 30 min = 90 labour-min
  earned standard minutes    = sum of STANDARD_LABOR_MIN of labour attempts completed in the window (completed work only: completion-bias guard)
  labour efficiency %        = earned standard minutes / eligible actual labour minutes of the same completed attempts x 100; undefined (reason) if 0
  productivity variance pp   = efficiency - 100
  labour budget gap          = eligible actual minutes - earned standard minutes (same completed attempts)
  remaining standard work    = standard labour of queued units' next operation + (1 - progress) x standard labour of in-process attempts
  available labour           = unique qualified clocked-in workers x remaining productive minutes to shift end (breaks excluded)
  first-attempt fail rate    = failed first-attempt gate inspections / first-attempt gate inspections (window)
"""
import datetime as dt
from collections import defaultdict

from .timeutil import minutes


def overlap_min(a0, a1, b0, b1):
    s, e = max(a0, b0), min(a1, b1)
    return max(0.0, (e - s).total_seconds() / 60)


class SessionData:
    """records needed for metrics, loaded once per calculation pass"""

    def __init__(self, db, cat, session, now, lookback_min=480):
        self.db, self.cat, self.s, self.now = db, cat, session, now
        sid, src, fork = session["SESSION_ID"], session["SOURCE_RUN_ID"], session["FORK_AT"]
        self.since = now - dt.timedelta(minutes=lookback_min)
        q = {"SESSION_ID": sid}
        self.workers = list(db.sim_workers.find(q))
        self.units = list(db.sim_units.find(q))
        self.ops = list(db.sim_operations.find(q))
        self.tasks = list(db.sim_tasks.find(dict(q, STATUS={"$in": ["ASSIGNED", "ACCEPTED", "WORKING", "PAUSED"]})))
        self.equipment = list(db.sim_equipment.find(q))
        self.materials = list(db.sim_materials.find(q))
        self.requests = list(db.sim_material_requests.find(q))
        self.segments = list(db.sim_participation.find(dict(q, START_AT={"$lte": now})))
        self.inspections = list(db.sim_inspections.find(dict(q, STATUS="SUBMITTED")))
        self.events_window = list(db.sim_events.find(dict(q, EVENT_TIME={"$gte": self.since, "$lte": now}, EVENT_TYPE={"$in": ["MATERIAL_CONSUMED", "MATERIAL_ISSUE_REVERSED", "QUEUE_ENTERED", "BATCH_RELEASED", "UNIT_SCRAPPED", "ROUTE_COMPLETED", "MILESTONE_REACHED"]})))
        # history inside the window (only when the window starts before the fork)
        self.hist_segments, self.hist_ops, self.hist_ins = [], [], []
        if self.since < fork:
            self.hist_segments = list(db.labor_segments.find({"RUN_ID": src, "SEGMENT_START": {"$lt": fork}, "SEGMENT_END": {"$gt": self.since}}, {"_seed": 0}))
            self.hist_ops = list(db.operation_instances.find({"RUN_ID": src, "OPERATION_KIND": "LABOR", "FINISHED_AT": {"$gte": self.since, "$lte": fork}}, {"_seed": 0}))
            self.hist_ins = list(db.inspection_header.find({"RUN_ID": src, "COMPLETED_AT": {"$gte": self.since, "$lte": fork}, "KNOWN_AT": {"$lte": fork}}, {"_seed": 0}))
        self.fork = fork


def wc_labor(d, wc, window_min):
    """completed-attempt efficiency per work centre over the window (history before the fork + session)"""
    start = d.now - dt.timedelta(minutes=window_min)
    earned, actual, n = 0.0, 0.0, 0
    sess_ops = [o for o in d.ops if o.get("OPERATION_KIND") == "LABOR" and o.get("WORK_CENTER_ID") == wc and o.get("STATE") == "WORK_COMPLETED" and o.get("WORK_COMPLETED_AT") and o["WORK_COMPLETED_AT"] >= start]
    seg_by_op = defaultdict(float)
    for s in d.segments:
        if s.get("CATEGORY") in ("DIRECT", "REWORK") and not s.get("REASON"):
            seg_by_op[s.get("OPERATION_INSTANCE_ID")] += minutes(s["START_AT"], s.get("END_AT") or d.now)
    hseg_by_op = defaultdict(float)
    for s in d.hist_segments:
        if s.get("SEGMENT_PHASE") in ("NORMAL", "REWORK", "CORRECTION"):
            hseg_by_op[s["OPERATION_INSTANCE_ID"]] += minutes(s["SEGMENT_START"], min(s["SEGMENT_END"], d.fork))
    for o in sess_ops:
        std = float(o.get("REWORK_STANDARD_LABOR_MIN") or 60) if str(o.get("INSTANCE_TYPE", "")).endswith("REWORK") else float(o.get("STANDARD_LABOR_MIN") or 0)
        act = seg_by_op.get(o["OPERATION_INSTANCE_ID"], 0) + hseg_by_op.get(o["OPERATION_INSTANCE_ID"], 0)
        if act > 0:
            earned += std; actual += act; n += 1
    for o in d.hist_ops:
        if o.get("WORK_CENTER_ID") != wc or o["FINISHED_AT"] < start:
            continue
        r = d.cat.op(o.get("PRODUCT_ID"), o["OPERATION_ID"]) or {}
        std = float(o.get("REWORK_STANDARD_LABOR_MIN") or 60) if str(o.get("INSTANCE_TYPE", "")).endswith("REWORK") else float(r.get("STANDARD_LABOR_MIN") or 0)
        act = hseg_by_op.get(o["OPERATION_INSTANCE_ID"], 0)
        if act > 0:
            earned += std; actual += act; n += 1
    eff = round(earned / actual * 100, 1) if actual > 0 else None
    return {"earned_std_min": round(earned, 1), "actual_labor_min": round(actual, 1), "completed_operations": n, "efficiency_pct": eff,
            "variance_pp": round(eff - 100, 1) if eff is not None else None, "budget_gap_min": round(actual - earned, 1), "efficiency_status": "OK" if eff is not None else "UNDEFINED_NO_ACTUAL_MINUTES"}


def remaining_std_work(d, wc):
    queued, inproc = 0.0, 0.0
    for u in d.units:
        if u.get("STATE") in ("QUEUED", "QUEUED_FOR_REWORK", "RECEIVED_AT_REWORK_STATION") and u.get("CURRENT_WORK_CENTER_ID") == wc:
            r = d.cat.op(u.get("PRODUCT_ID"), u.get("ROUTE_STEP")) or {}
            queued += 60.0 if u.get("REWORK_PENDING") else float(r.get("STANDARD_LABOR_MIN") or 0)
    for o in d.ops:
        if o.get("OPERATION_KIND") == "LABOR" and o.get("WORK_CENTER_ID") == wc and o.get("STATE") in ("CREATED", "WORKING", "PAUSED", "BELOW_MIN_CREW"):
            std = float(o.get("REWORK_STANDARD_LABOR_MIN") or 60) if str(o.get("INSTANCE_TYPE", "")).endswith("REWORK") else float(o.get("STANDARD_LABOR_MIN") or 0)
            inproc += std * (1 - float(o.get("PROGRESS_FRACTION") or 0))
    return round(queued, 1), round(inproc, 1)


def available_labor(d, wc, skill_ids):
    """unique qualified clocked-in people at the work centre x remaining minutes to their shift end"""
    total, people = 0.0, 0
    for w in d.workers:
        if w.get("ATTENDANCE_STATE") != "CLOCKED_IN" or w.get("WORKER_ROLE") != "PRODUCTION_OPERATOR":
            continue
        here = (w.get("TEMP_WORK_CENTER_ID") or w.get("CURRENT_WORK_CENTER_ID") or w.get("PLANNED_WORK_CENTER_ID")) == wc
        if not here or not any(d.cat.qualified(w["WORKER_ID"], s, d.now) for s in skill_ids):
            continue
        end = max([x for x in (w.get("PLANNED_END_AT"), w.get("OVERTIME_UNTIL")) if x] or [d.now])
        rem = max(0.0, minutes(d.now, end))
        total += rem; people += 1
    return round(total, 1), people


def gate_fail_rate(d, gate, window_min):
    start = d.now - dt.timedelta(minutes=window_min)
    first, fails = 0, 0
    for i in d.inspections:
        if i.get("GATE_OPERATION_ID") == gate and i.get("INSPECTION_KIND") == "INDEPENDENT" and (i.get("ATTEMPT_NO") or 1) == 1 and i.get("COMPLETED_AT") and i["COMPLETED_AT"] >= start:
            first += 1; fails += 1 if i.get("RESULT") == "FAIL" else 0
    for i in d.hist_ins:
        if i.get("GATE_OPERATION_ID") == gate and (i.get("ATTEMPT_NO") or 1) == 1 and i["COMPLETED_AT"] >= start:
            first += 1; fails += 1 if i.get("RESULT") == "FAIL" else 0
    scrap = sum(1 for e in d.events_window if e["EVENT_TYPE"] == "UNIT_SCRAPPED")
    return {"first_attempts": first, "fails": fails, "fail_rate_pct": round(fails / first * 100, 1) if first else None, "scrap_in_window": scrap}


def worker_metrics(d, w):
    cats = defaultdict(float)
    for s in d.segments:
        if s["WORKER_ID"] == w["WORKER_ID"]:
            cats[s["CATEGORY"]] += minutes(s["START_AT"], s.get("END_AT") or d.now)
    return {k: round(v, 1) for k, v in cats.items()}
