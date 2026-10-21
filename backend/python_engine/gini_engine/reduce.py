"""State reduction: the plant state known at time T, derived only from records with EVENT_TIME <= T and KNOWN_AT <= T.

Single implementation used for (a) forking an interactive session at a checkpoint and (b) synthetic live replay
projections. Excel analytics (ref_*) are never read here; they are used only by tests to reconcile the result.
"""
import datetime as dt
from collections import defaultdict

from . import resolver
from .timeutil import add_min, minutes

WINDOW_DAYS = 5          # active WIP is found within this look-back; older units are terminal or not yet released

UNIT_STATE_MAP = {
    "QUEUED": "QUEUED", "AT_WORKSTATION": "READY", "IN_OPERATION": "WORKING", "IN_OPERATION_PAUSED": "PAUSED", "CURING": "CURING",
    "AWAITING_INSPECTION": "WORK_COMPLETED_AWAITING_INSPECTION", "IN_INSPECTION": "INSPECTION_IN_PROGRESS", "INSPECTION_DECIDED": "INSPECTION_DECIDED",
    "IN_TRANSFER": "IN_TRANSFER", "REWORK_QUEUED": "QUEUED_FOR_REWORK", "ON_HOLD": "QUALITY_HOLD", "ON_HOLD_INCOMPLETE_INSPECTION": "INCOMPLETE_INSPECTION_HOLD",
    "BLOCKED_OUTBOUND": "RELEASED_TO_NEXT_OPERATION", "ROUTE_COMPLETE": "ROUTE_COMPLETE", "SCRAPPED": "SCRAPPED",
}
WORKER_STATE_MAP = {
    "AVAILABLE_WAITING": "WAITING", "WORKING": "WORKING", "INDIRECT": "INDIRECT", "OFF_SHIFT": "OFF_SHIFT", "BREAK": "BREAK", "INSPECTING": "INSPECTING",
    "ON_DUTY": "AVAILABLE", "TRANSFER": "TRANSFER", "ABSENT": "ABSENT", "REPAIRING": "REPAIRING",
}
TASK_EVENT_STATUS = {"ASSIGNED": "ASSIGNED", "ACCEPTED": "ACCEPTED", "STARTED": "WORKING", "RESUMED": "WORKING", "PAUSED": "PAUSED",
                     "COMPLETED": "COMPLETED", "CANCELLED": "CANCELLED", "REASSIGNED": "HANDED_OVER"}


class History:
    """reads one run's records as known at T (DELTA runs resolved with the v3 rule)."""

    def __init__(self, db, catalog, run_id, ds="GINI-SYN-TANKS"):
        self.db, self.cat, self.run_id, self.ds = db, catalog, run_id, ds
        self.chain = resolver.run_chain(run_id, catalog.run_catalog)
        self.delta = len(self.chain) > 1

    def rows(self, coll, table, flt=None, projection=None):
        # rows entered inside an interactive session (SESSION_ID set) belong to that branch only - never to history reduction
        f = {"dataset_id": self.ds, "RUN_ID": {"$in": self.chain} if self.delta else self.run_id, "SESSION_ID": None}
        f.update(flt or {})
        proj = projection or {"_seed": 0}
        docs = list(self.db[coll].find(f, proj))
        if self.delta:
            docs = [dict(d, RUN_ID=self.run_id) for d in resolver.resolve(docs, table, self.run_id, self.cat.run_catalog)]
        return docs

    def known(self, coll, table, T, time_field="EVENT_TIME", since=None, extra=None):
        f = {"KNOWN_AT": {"$lte": T}}
        if time_field:
            f[time_field] = {"$lte": T} if since is None else {"$lte": T, "$gte": since}
        f.update(extra or {})
        return self.rows(coll, table, f)


def _last(rows, key, order=("EVENT_TIME", "KNOWN_AT")):
    out = {}
    for r in sorted(rows, key=lambda r: tuple(r.get(o) or dt.datetime.min for o in order) + (r.get("EVENT_ID") or r.get("TASK_EVENT_ID") or "",)):
        out[r[key]] = r
    return out


def shift_at(cat, T):
    """the shift covering T (or None between shifts)."""
    for s in cat.shifts.values():
        d = s["SHIFT_DATE"]
        date_str = d.strftime("%Y-%m-%d")
        from .timeutil import local_to_utc
        start = local_to_utc(date_str, s["START_AT_LOCAL"])
        end = local_to_utc(date_str, s["END_AT_LOCAL"])
        if end <= start:
            end = end + dt.timedelta(days=1)
        if start <= T < end:
            return dict(s, START_AT=start, END_AT=end)
    return None


def reduce_state(db, cat, run_id, T, ds="GINI-SYN-TANKS"):
    h = History(db, cat, run_id, ds)
    since = T - dt.timedelta(days=WINDOW_DAYS)
    out = {"AS_OF": T, "RUN_ID": run_id, "units": {}, "operations": {}, "tasks": {}, "workers": {}, "equipment": {}, "materials": {},
           "holds": {}, "returns": {}, "inspections": {}, "queue": [], "plan_releases": [], "material_deliveries": [], "points_known": 0, "warnings": []}

    # ------------------------------------------------------------ units
    um = {u["UNIT_ID"]: u for u in h.rows("unit_master", "UNIT_MASTER", {"KNOWN_AT": {"$lte": T}})}
    pe = h.known("production_events", "PRODUCTION_EVENTS", T, since=since)
    last_pe = _last([e for e in pe if e.get("UNIT_ID")], "UNIT_ID")
    terminal = {e["UNIT_ID"]: e for e in h.known("production_events", "PRODUCTION_EVENTS", T, extra={"EVENT_TYPE": {"$in": ["ROUTE_COMPLETED", "UNIT_SCRAPPED"]}})}
    disp = h.known("quality_dispositions", "QUALITY_DISPOSITIONS", T, time_field="DECIDED_AT", since=since)
    disp_by_ins = {d["INSPECTION_ID"]: d for d in disp if d.get("INSPECTION_ID")}
    lines = {l["ORDER_LINE_ID"]: l for l in h.rows("order_lines", "ORDER_LINES")}
    orders = {o["ORDER_ID"]: o for o in h.rows("production_orders", "PRODUCTION_ORDERS")}
    ops_all = {o["OPERATION_INSTANCE_ID"]: o for o in h.rows("operation_instances", "OPERATION_INSTANCES", {"CREATED_AT": {"$lte": T, "$gte": since - dt.timedelta(days=2)}})}
    queue_entries = h.known("workstation_queue_entries", "WORKSTATION_QUEUE_ENTRIES", T, time_field="ENTERED_AT", since=since)
    open_q = {}
    for q in queue_entries:
        exited_known = q.get("EXITED_AT") is not None and q.get("EXIT_KNOWN_AT") is not None and q["EXIT_KNOWN_AT"] <= T and q["EXITED_AT"] <= T
        if not exited_known:
            open_q[q["UNIT_ID"]] = q
    last_labor = {}
    for o in ops_all.values():
        if o.get("OPERATION_KIND") == "LABOR" and o.get("FINISHED_AT") is not None and o["FINISHED_AT"] <= T:
            cur = last_labor.get(o["UNIT_ID"])
            if cur is None or o["FINISHED_AT"] > cur["FINISHED_AT"]:
                last_labor[o["UNIT_ID"]] = o
    for uid, u in um.items():
        ev = last_pe.get(uid)
        term = terminal.get(uid)
        if ev is None and term is None:
            continue                      # not active in the window (old completed units are reported via terminal below)
        if term and (ev is None or term["EVENT_TIME"] >= ev["EVENT_TIME"]):
            state = "ROUTE_COMPLETE" if term["EVENT_TYPE"] == "ROUTE_COMPLETED" else "SCRAPPED"
            ev = term
        else:
            raw = ev.get("UNIT_STATE_AFTER")
            state = UNIT_STATE_MAP.get(raw, raw)
        opi = ops_all.get(ev.get("OPERATION_INSTANCE_ID")) if ev.get("OPERATION_INSTANCE_ID") else None
        is_rework = bool(opi and str(opi.get("INSTANCE_TYPE", "")).endswith("REWORK"))
        if state == "INSPECTION_DECIDED":
            d = disp_by_ins.get(ev.get("INSPECTION_ID"))
            if d and d.get("DISPOSITION") == "RELEASE":
                state = "RELEASED_TO_NEXT_OPERATION"
            elif d and d.get("RESULT") == "INCOMPLETE":
                state = "INCOMPLETE_INSPECTION_HOLD"
            elif d:
                state = "QUALITY_HOLD"
            else:
                state = "PASS_PENDING_RELEASE"
        if state == "WORKING" and is_rework:
            state = "REWORK_IN_PROGRESS"
        if state == "WORK_COMPLETED_AWAITING_INSPECTION" and is_rework:
            state = "REWORK_COMPLETE_AWAITING_REINSPECTION"
        line = lines.get(u.get("ORDER_LINE_ID"), {})
        order = orders.get(u.get("ORDER_ID"), {})
        qe = open_q.get(uid)
        out["units"][uid] = {
            "UNIT_ID": uid, "TANK_SERIAL_NO": u.get("TANK_SERIAL_NO"), "PRODUCT_ID": u.get("PRODUCT_ID"), "ORDER_ID": u.get("ORDER_ID"),
            "ORDER_LINE_ID": u.get("ORDER_LINE_ID"), "BATCH_ID": u.get("INITIAL_BATCH_ID"), "REPLACEMENT_FOR_UNIT_ID": u.get("REPLACEMENT_FOR_UNIT_ID"),
            "DRAWING_REVISION": u.get("DRAWING_REVISION"), "STATE": state, "ROUTE_STEP": ev.get("ROUTE_STEP"),
            "CURRENT_WORK_CENTER_ID": ev.get("TO_WORK_CENTER_ID") or (opi or {}).get("WORK_CENTER_ID") or ev.get("FROM_WORK_CENTER_ID"),
            "CURRENT_WORKSTATION_ID": ev.get("WORKSTATION_ID") or (opi or {}).get("WORKSTATION_ID"),
            "CURRENT_OPERATION_INSTANCE_ID": ev.get("OPERATION_INSTANCE_ID"), "STATE_SINCE": ev.get("EVENT_TIME"), "LAST_EVENT_ID": ev.get("EVENT_ID"),
            "QUEUE_ENTERED_AT": qe["ENTERED_AT"] if qe else None, "QUEUE_ENTRY_ID": qe["QUEUE_ENTRY_ID"] if qe else None,
            "PRIORITY_CLASS": (qe or {}).get("PRIORITY_CLASS") or (2 if order.get("PRIORITY") == "HIGH" else 3), "DUE_AT": line.get("DUE_AT") or order.get("DUE_AT"),
            "TIMING_NOTE": (qe or {}).get("TIMING_NOTE"), "ORIGIN": "INHERITED_AT_FORK",
            "ROUTE_COMPLETED_AT": term["EVENT_TIME"] if term and term["EVENT_TYPE"] == "ROUTE_COMPLETED" else None,
            "SCRAPPED_AT": term["EVENT_TIME"] if term and term["EVENT_TYPE"] == "UNIT_SCRAPPED" else None,
            "LAST_LABOR_OPERATION_INSTANCE_ID": (last_labor.get(uid) or {}).get("OPERATION_INSTANCE_ID"),
            "LAST_LABOR_WORKSTATION_ID": (last_labor.get(uid) or {}).get("WORKSTATION_ID"),
        }
        if state in ("QUEUED", "QUEUED_FOR_REWORK") and not qe:
            out["units"][uid]["QUEUE_ENTERED_AT"] = ev.get("EVENT_TIME")
    # good counts known at T for orders (all time, not only window)
    out["good_by_line"] = defaultdict(set)
    out["scrap_by_line"] = defaultdict(set)
    for uid, e in terminal.items():
        u = um.get(uid)
        if not u:
            continue
        (out["good_by_line"] if e["EVENT_TYPE"] == "ROUTE_COMPLETED" else out["scrap_by_line"])[u.get("ORDER_LINE_ID")].add(uid)

    # ------------------------------------------------------------ operations in progress at T (no future fields copied)
    segs = h.rows("labor_segments", "LABOR_SEGMENTS", {"SEGMENT_START": {"$lte": T, "$gte": since - dt.timedelta(days=2)}})
    seg_by_op = defaultdict(dict)
    for s in segs:
        g = s["SEGMENT_ID"].rsplit("-W", 1)[0]
        seg_by_op[s["OPERATION_INSTANCE_ID"]][g] = s
    crew = h.rows("operation_crew", "OPERATION_CREW", {"KNOWN_AT": {"$lte": T}, "JOINED_AT": {"$lte": T, "$gte": since - dt.timedelta(days=2)}})
    crew_at = defaultdict(list)
    for c in crew:
        if c.get("LEFT_AT") is None or c["LEFT_AT"] > T:
            crew_at[c["OPERATION_INSTANCE_ID"]].append(c)
    milestones = h.known("operation_milestone_events", "OPERATION_MILESTONE_EVENTS", T, since=since)
    ms_by_op = defaultdict(list)
    for m in milestones:
        ms_by_op[m["OPERATION_INSTANCE_ID"]].append(m["MILESTONE_ID"])
    for oid, o in ops_all.items():
        if o.get("CREATED_AT") is None or o["CREATED_AT"] > T:
            continue
        finished = o.get("FINISHED_AT") is not None and o["FINISHED_AT"] <= T
        if finished or o.get("STATE") == "CANCELLED" and (o.get("FINISHED_AT") or T) <= T:
            continue
        unit = out["units"].get(o["UNIT_ID"])
        if unit is None or unit["STATE"] in ("ROUTE_COMPLETE", "SCRAPPED"):
            continue
        prog = 0.0
        for g, s in seg_by_op.get(oid, {}).items():
            pf = float(s.get("PROGRESS_FRACTION") or 0)
            if s["SEGMENT_END"] <= T:
                prog += pf
            elif s["SEGMENT_START"] < T:
                span = minutes(s["SEGMENT_START"], s["SEGMENT_END"])
                prog += pf * (minutes(s["SEGMENT_START"], T) / span if span > 0 else 0)
        kind = o.get("OPERATION_KIND")
        started = o.get("STARTED_AT") is not None and o["STARTED_AT"] <= T
        crew_ids = sorted({c["WORKER_ID"] for c in crew_at.get(oid, [])})
        if kind == "PROCESS":
            state = "CURING" if started else "CREATED"
            if started and o.get("STANDARD_ELAPSED_MIN"):
                prog = min(1.0, minutes(o["STARTED_AT"], T) / float(o["STANDARD_ELAPSED_MIN"]))
        elif kind == "INSPECTION":
            state = "WORKING" if started else "CREATED"
        else:
            if unit["STATE"] in ("PAUSED",):
                state = "PAUSED"
            elif unit["STATE"] in ("WORKING", "REWORK_IN_PROGRESS"):
                state = "WORKING" if crew_ids else "BELOW_MIN_CREW"
            elif unit["STATE"] in ("WORK_COMPLETED_AWAITING_INSPECTION", "REWORK_COMPLETE_AWAITING_REINSPECTION"):
                continue
            else:
                state = "WORKING" if (started and crew_ids) else ("PAUSED" if started else "CREATED")
        r = cat.op(o.get("PRODUCT_ID"), o["OPERATION_ID"]) or {}
        out["operations"][oid] = {
            "OPERATION_INSTANCE_ID": oid, "UNIT_ID": o["UNIT_ID"], "OPERATION_ID": o["OPERATION_ID"], "OPERATION_KIND": kind, "PRODUCT_ID": o.get("PRODUCT_ID"),
            "WORK_CENTER_ID": o.get("WORK_CENTER_ID"), "WORKSTATION_ID": o.get("WORKSTATION_ID"), "EQUIPMENT_ID": o.get("EQUIPMENT_ID"),
            "ATTEMPT_NO": o.get("ATTEMPT_NO"), "INSTANCE_TYPE": o.get("INSTANCE_TYPE"), "REWORK_OF_OPERATION_INSTANCE_ID": o.get("REWORK_OF_OPERATION_INSTANCE_ID"),
            "PRIOR_ATTEMPT_OPERATION_INSTANCE_ID": o.get("PRIOR_ATTEMPT_OPERATION_INSTANCE_ID"), "INSTRUCTION_VERSION_ID": o.get("INSTRUCTION_VERSION_ID"),
            "BATCH_ID": o.get("BATCH_ID"), "STATE": state, "PROGRESS_FRACTION": round(min(prog, 0.999), 4), "CREW": crew_ids,
            "CREW_ROLES": {c["WORKER_ID"]: c.get("ROLE") for c in crew_at.get(oid, [])},
            "MILESTONES_DONE": sorted(set(ms_by_op.get(oid, []))), "CREATED_AT": o.get("CREATED_AT"), "STARTED_AT": o["STARTED_AT"] if started else None,
            "STANDARD_ELAPSED_MIN": r.get("STANDARD_ELAPSED_MIN"), "STANDARD_LABOR_MIN": r.get("STANDARD_LABOR_MIN") if not str(o.get("INSTANCE_TYPE", "")).endswith("REWORK") else o.get("REWORK_STANDARD_LABOR_MIN"),
            "MIN_CREW_SIZE": r.get("MIN_CREW_SIZE"), "STD_CREW_SIZE": r.get("STD_CREW_SIZE"), "MAX_CREW_SIZE": r.get("MAX_CREW_SIZE"), "REQUIRED_SKILL_ID": r.get("REQUIRED_SKILL_ID"),
            "ORIGIN": "INHERITED_AT_FORK",
        }

    # ------------------------------------------------------------ tasks (status derived from TASK_EVENTS <= T, never the terminal TASK_STATUS)
    tasks = h.rows("task_assignments", "TASK_ASSIGNMENTS", {"KNOWN_AT": {"$lte": T}, "ASSIGNED_AT": {"$lte": T, "$gte": since - dt.timedelta(days=2)}})
    tev = h.known("task_events", "TASK_EVENTS", T, since=since - dt.timedelta(days=2))
    last_te = _last(tev, "TASK_ID")
    first_start = {}
    for e in tev:
        if e.get("EVENT_TYPE") == "STARTED" and (e["TASK_ID"] not in first_start or e["EVENT_TIME"] < first_start[e["TASK_ID"]]):
            first_start[e["TASK_ID"]] = e["EVENT_TIME"]
    for t in tasks:
        e = last_te.get(t["TASK_ID"])
        status = TASK_EVENT_STATUS.get(e["EVENT_TYPE"]) if e else "ASSIGNED"
        if status in ("COMPLETED", "CANCELLED", "HANDED_OVER"):
            continue
        op = out["operations"].get(t["OPERATION_INSTANCE_ID"])
        if op is None:
            continue                      # operation finished or not visible -> not an active association
        out["tasks"][t["TASK_ID"]] = {
            "TASK_ID": t["TASK_ID"], "OPERATION_INSTANCE_ID": t["OPERATION_INSTANCE_ID"], "UNIT_ID": t["UNIT_ID"], "OPERATION_ID": t["OPERATION_ID"],
            "WORKER_ID": t["ASSIGNED_WORKER_ID"], "ROLE": t.get("ROLE"), "SUBTASK_ID": t.get("SUBTASK_ID"), "STATUS": status,
            "ASSIGNED_AT": t.get("ASSIGNED_AT"), "ASSIGNED_BY": t.get("ASSIGNED_BY"), "ACCEPTED_AT": t.get("ACCEPTED_AT") if (t.get("ACCEPTED_AT") and t["ACCEPTED_AT"] <= T) else None,
            "STATUS_BASIS_EVENT_ID": e.get("TASK_EVENT_ID") if e else None, "PAUSE_REASON": e.get("REASON_CODE") if e and status == "PAUSED" else None,
            "STATUS_SINCE": e.get("EVENT_TIME") if e else t.get("ASSIGNED_AT"), "STARTED_AT": first_start.get(t["TASK_ID"]), "ORIGIN": "INHERITED_AT_FORK",
        }

    # ------------------------------------------------------------ workers
    sh = shift_at(cat, T)
    roster = h.rows("shift_roster", "SHIFT_ROSTER", {"PLANNED_START_AT": {"$lte": T + dt.timedelta(hours=10)}, "PLANNED_END_AT": {"$gte": T - dt.timedelta(hours=10)}})
    roster_now = {}
    for r in roster:
        if r["PLANNED_START_AT"] <= T < r["PLANNED_END_AT"] or (sh and r.get("SHIFT_ID") == sh["SHIFT_ID"]):
            roster_now[r["WORKER_ID"]] = r
    next_roster = {}
    for r in sorted(roster, key=lambda r: r["PLANNED_START_AT"]):
        if r["PLANNED_START_AT"] > T and r["WORKER_ID"] not in next_roster and r.get("ROSTER_STATUS") == "SCHEDULED":
            next_roster[r["WORKER_ID"]] = r
    att = h.known("attendance_events", "ATTENDANCE_EVENTS", T, since=T - dt.timedelta(hours=20))
    last_att = _last(att, "WORKER_ID")
    first_in = {}
    for a in sorted(att, key=lambda a: a["EVENT_TIME"]):
        if a["EVENT_TYPE"] == "CLOCK_IN" and (not sh or a.get("SHIFT_ID") == sh["SHIFT_ID"]):
            first_in.setdefault(a["WORKER_ID"], a["EVENT_TIME"])
    wev = h.known("worker_events", "WORKER_EVENTS", T, since=T - dt.timedelta(hours=20))
    last_we = _last(wev, "WORKER_ID")
    logins = h.known("login_events", "LOGIN_EVENTS", T, since=T - dt.timedelta(hours=20))
    last_login = _last(logins, "WORKER_ID")
    active_task_by_worker = defaultdict(list)
    for t in out["tasks"].values():
        active_task_by_worker[t["WORKER_ID"]].append(t)
    for wid, w in cat.workers.items():
        r = roster_now.get(wid)
        a = last_att.get(wid)
        we = last_we.get(wid)
        if a and a["EVENT_TYPE"] == "ABSENCE_CONFIRMED" and (not sh or a.get("SHIFT_ID") == sh["SHIFT_ID"]):
            att_state = "ABSENT"
        elif a and a["EVENT_TYPE"] == "CLOCK_IN" and (not sh or a.get("SHIFT_ID") == sh["SHIFT_ID"]):
            att_state = "CLOCKED_IN"
        elif a and a["EVENT_TYPE"] in ("CLOCK_OUT", "EARLY_DEPARTURE_APPROVED", "MID_SHIFT_EXIT_APPROVED") and (not sh or a.get("SHIFT_ID") == sh["SHIFT_ID"]):
            att_state = "CLOCKED_OUT"
        elif r and r.get("ROSTER_STATUS") == "SCHEDULED":
            att_state = "NOT_CLOCKED_IN" if not (we and we.get("SHIFT_ID") == (sh or {}).get("SHIFT_ID")) else "NOT_RECORDED"
        else:
            att_state = "OFF_SHIFT"
        act = WORKER_STATE_MAP.get(we["STATE_AFTER"], we["STATE_AFTER"]) if we and (not sh or we.get("SHIFT_ID") == sh["SHIFT_ID"]) else None
        if att_state in ("OFF_SHIFT", "CLOCKED_OUT") and act not in ("WORKING", "INSPECTING", "REPAIRING"):
            act = "OFF_SHIFT"
        if att_state == "ABSENT":
            act = "ABSENT"
        if act is None:
            act = "NOT_STARTED" if att_state in ("NOT_CLOCKED_IN", "NOT_RECORDED") else ("AVAILABLE" if att_state == "CLOCKED_IN" else "OFF_SHIFT")
        tasks_w = sorted(active_task_by_worker.get(wid, []), key=lambda t: (t["STATUS"] != "WORKING", t["STATUS_SINCE"] or T))
        cur = tasks_w[0] if tasks_w else None
        lg = last_login.get(wid)
        out["workers"][wid] = {
            "WORKER_ID": wid, "DISPLAY_NAME": w.get("DISPLAY_NAME"), "WORKER_ROLE": w.get("WORKER_ROLE"), "HOME_WORK_CENTER_ID": w.get("HOME_WORK_CENTER_ID"),
            "SHIFT_ID": (r or {}).get("SHIFT_ID") or (sh or {}).get("SHIFT_ID"), "ROSTER_STATUS": (r or {}).get("ROSTER_STATUS") or "NOT_ROSTERED",
            "PLANNED_WORK_CENTER_ID": (r or {}).get("PLANNED_WORK_CENTER_ID"), "PLANNED_START_AT": (r or {}).get("PLANNED_START_AT"), "PLANNED_END_AT": (r or {}).get("PLANNED_END_AT"),
            "NEXT_SHIFT_ID": (next_roster.get(wid) or {}).get("SHIFT_ID"), "NEXT_PLANNED_START_AT": (next_roster.get(wid) or {}).get("PLANNED_START_AT"),
            "NEXT_PLANNED_END_AT": (next_roster.get(wid) or {}).get("PLANNED_END_AT"), "NEXT_PLANNED_WORK_CENTER_ID": (next_roster.get(wid) or {}).get("PLANNED_WORK_CENTER_ID"),
            "ATTENDANCE_STATE": att_state, "ACTIVITY_STATE": act, "REASON_CODE": (we or {}).get("REASON_CODE") if act not in ("OFF_SHIFT", "NOT_STARTED") else None,
            "FIRST_CLOCK_IN_AT": first_in.get(wid), "APP_SESSION_STATE": "OPEN" if (lg and lg["EVENT_TYPE"] in ("APP_LOGIN", "STATION_LOGIN")) else "CLOSED",
            "CURRENT_TASK_ID": cur["TASK_ID"] if cur else None, "CURRENT_OPERATION_INSTANCE_ID": cur["OPERATION_INSTANCE_ID"] if cur else (we or {}).get("OPERATION_INSTANCE_ID") if act in ("WORKING", "INSPECTING") else None,
            "CURRENT_WORKSTATION_ID": (we or {}).get("WORKSTATION_ID") if act not in ("OFF_SHIFT", "ABSENT") else None,
            "CURRENT_WORK_CENTER_ID": (we or {}).get("WORK_CENTER_ID") if act not in ("OFF_SHIFT", "ABSENT") else None,
            "STATE_SINCE": (we or {}).get("EVENT_TIME"), "LAST_ACTIVITY_AT": (we or {}).get("EVENT_TIME"), "ACTIVE_TASK_COUNT": len(tasks_w), "ORIGIN": "INHERITED_AT_FORK",
        }

    # ------------------------------------------------------------ open inspections at T (draft without readings: readings become known later)
    ins = h.rows("inspection_header", "INSPECTION_HEADER", {"STARTED_AT": {"$lte": T, "$gte": since}})
    for i in ins:
        if i.get("COMPLETED_AT") is None or i["COMPLETED_AT"] > T or i.get("KNOWN_AT") is None or i["KNOWN_AT"] > T:
            u = out["units"].get(i["UNIT_ID"])
            if not u or u["STATE"] not in ("INSPECTION_IN_PROGRESS", "REINSPECTION_IN_PROGRESS", "WORK_COMPLETED_AWAITING_INSPECTION", "REWORK_COMPLETE_AWAITING_REINSPECTION"):
                continue
            out["inspections"][i["INSPECTION_ID"]] = {
                "INSPECTION_ID": i["INSPECTION_ID"], "UNIT_ID": i["UNIT_ID"], "OPERATION_INSTANCE_ID": i.get("OPERATION_INSTANCE_ID"), "INSPECTED_OPERATION_INSTANCE_ID": i.get("INSPECTED_OPERATION_INSTANCE_ID"),
                "GATE_OPERATION_ID": i.get("GATE_OPERATION_ID"), "WORK_CENTER_ID": i.get("WORK_CENTER_ID"), "WORKSTATION_ID": i.get("WORKSTATION_ID"), "INSPECTOR_ID": i.get("INSPECTOR_ID"),
                "ATTEMPT_NO": i.get("ATTEMPT_NO"), "INSPECTION_TRIGGER": i.get("INSPECTION_TRIGGER"), "REINSPECTION_OF_INSPECTION_ID": i.get("REINSPECTION_OF_INSPECTION_ID"),
                "CHECKLIST_VERSION": i.get("CHECKLIST_VERSION"), "STATUS": "DRAFT", "STARTED_AT": i.get("STARTED_AT"), "DRAFT_ANSWERS": {}, "ORIGIN": "INHERITED_AT_FORK",
                "INSPECTION_KIND": "INDEPENDENT",
            }

    # ------------------------------------------------------------ holds and returns open at T
    for hc in h.known("hold_cases", "HOLD_CASES", T, time_field="HOLD_STARTED_AT"):
        if hc.get("RESOLVED_AT") is None or hc["RESOLVED_AT"] > T or (hc.get("ROW_COMPLETE_KNOWN_AT") and hc["ROW_COMPLETE_KNOWN_AT"] > T):
            u = out["units"].get(hc["UNIT_ID"])
            if not u or u["STATE"] in ("ROUTE_COMPLETE", "SCRAPPED"):
                continue
            out["holds"][hc["HOLD_ID"]] = {k: hc.get(k) for k in ("HOLD_ID", "UNIT_ID", "HOLD_TYPE", "HOLD_EVENT_ID", "HOLD_STARTED_AT", "INSPECTION_ID", "DEFECT_IDS", "HOLD_LOCATION", "HOLD_LOCATION_TYPE")}
            out["holds"][hc["HOLD_ID"]].update({"DECISION": None, "RESOLUTION": "OPEN", "ORIGIN": "INHERITED_AT_FORK"})
    for rm in h.known("return_movements", "RETURN_MOVEMENTS", T, time_field="DETECTED_AT"):
        complete_known = rm.get("ROW_COMPLETE_KNOWN_AT") and rm["ROW_COMPLETE_KNOWN_AT"] <= T
        if complete_known:
            continue
        u = out["units"].get(rm["UNIT_ID"])
        if not u or u["STATE"] in ("ROUTE_COMPLETE", "SCRAPPED"):
            continue
        keep = {k: rm.get(k) for k in ("RETURN_ID", "UNIT_ID", "REWORK_OPERATION_INSTANCE_ID", "REWORK_TYPE", "CORRECTED_OPERATION_INSTANCE_ID", "ORIGIN_OPERATION_ID",
                                       "ORIGIN_WORK_CENTER_ID", "ORIGIN_WORKSTATION_ID", "DETECTION_TYPE", "DETECTION_INSPECTION_ID", "DETECTED_AT", "DETECTED_AT_WORK_CENTER_ID")}
        # later stages are only shown when their own known-at has passed
        for f, kf in (("AUTHORIZED_BY", "AUTHORIZATION_KNOWN_AT"), ("AUTHORIZED_DESTINATION_WORKSTATION_ID", "AUTHORIZATION_KNOWN_AT"), ("DESTINATION_BASIS", "AUTHORIZATION_KNOWN_AT")):
            keep[f] = rm.get(f) if rm.get(kf) and rm[kf] <= T else None
        keep.update({"LOOP_STATUS": "OPEN_AT_FORK", "ORIGIN": "INHERITED_AT_FORK"})
        out["returns"][rm["RETURN_ID"]] = keep

    # ------------------------------------------------------------ equipment
    eqe = h.known("equipment_events", "EQUIPMENT_EVENTS", T, since=T - dt.timedelta(days=3))
    last_eq = _last(eqe, "EQUIPMENT_ID")
    for eid, e in cat.equipment.items():
        ev = last_eq.get(eid)
        down = bool(ev and ev["EVENT_TYPE"] in ("BREAKDOWN", "PREVENTIVE_MAINTENANCE_START", "DEGRADATION_CONFIRMED", "ESTIMATE_REVISED"))
        if ev and ev["EVENT_TYPE"] == "ESTIMATE_REVISED":
            prior = [x for x in eqe if x["EQUIPMENT_ID"] == eid and x["EVENT_TYPE"] in ("BREAKDOWN", "RECOVERED", "PREVENTIVE_MAINTENANCE_START", "PREVENTIVE_MAINTENANCE_COMPLETED")]
            down = bool(prior and sorted(prior, key=lambda x: x["EVENT_TIME"])[-1]["EVENT_TYPE"] in ("BREAKDOWN", "PREVENTIVE_MAINTENANCE_START"))
        out["equipment"][eid] = {"EQUIPMENT_ID": eid, "WORKSTATION_ID": e.get("WORKSTATION_ID"), "WORK_CENTER_ID": e.get("WORK_CENTER_ID"),
                                 "STATUS": "DOWN" if down else "UP", "SINCE": ev["EVENT_TIME"] if ev else None, "REASON_CODE": ev.get("REASON_CODE") if (ev and down) else None,
                                 "ESTIMATED_RECOVERY_AT": ev.get("ESTIMATED_RECOVERY_AT") if (ev and down) else None, "LAST_EVENT_ID": ev.get("EVENT_ID") if ev else None,
                                 "ORIGIN": "INHERITED_AT_FORK"}

    # ------------------------------------------------------------ materials (stock = sum of signed quantities known at T)
    me = h.known("material_events", "MATERIAL_EVENTS", T, time_field="EVENT_TIME")
    stock = defaultdict(float)
    for m in me:
        stock[m["MATERIAL_ID"]] += float(m.get("QTY") or 0)
    for mid, m in cat.materials.items():
        out["materials"][mid] = {"MATERIAL_ID": mid, "MATERIAL_NAME": m.get("MATERIAL_NAME"), "UOM": m.get("UOM"), "ON_HAND_QTY": round(stock.get(mid, 0.0), 3),
                                 "HOLD_QTY": 0.0, "ORIGIN": "INHERITED_AT_FORK"}
    reqs = h.rows("material_requests", "MATERIAL_REQUESTS", {"REQUESTED_AT": {"$lte": T}})
    for r in reqs:
        delivered_known = r.get("DELIVERED_AT") is not None and r["DELIVERED_AT"] <= T
        if not delivered_known and r.get("STATUS") != "CANCELLED" and float(r.get("QTY") or 0) > 0:
            out["material_deliveries"].append({"REQUEST_ID": r["REQUEST_ID"], "MATERIAL_ID": r["MATERIAL_ID"], "QTY": r.get("QTY"), "NEED_BY_AT": r.get("NEED_BY_AT"),
                                               "PROMISED_AT": r.get("PROMISED_AT"), "REQUEST_TYPE": r.get("REQUEST_TYPE"), "STATUS": "OPEN"})

    # ------------------------------------------------------------ planned releases after T (continuation rule: plan rows known before the fork)
    plan = h.rows("production_plan", "PRODUCTION_PLAN", {"PLANNED_START_AT": {"$gt": T, "$lte": T + dt.timedelta(days=7)}})
    released_batches = {u.get("INITIAL_BATCH_ID") for u in um.values()}
    batches = {b["BATCH_ID"]: b for b in h.rows("production_batches", "PRODUCTION_BATCHES")}
    for p in plan:
        if p["BATCH_ID"] in released_batches:
            continue
        b = batches.get(p["BATCH_ID"], {})
        out["plan_releases"].append({"BATCH_ID": p["BATCH_ID"], "ORDER_LINE_ID": p.get("ORDER_LINE_ID"), "ORDER_ID": b.get("ORDER_ID"), "PRODUCT_ID": b.get("PRODUCT_ID"),
                                     "PLANNED_QTY": p.get("PLANNED_QTY"), "PLANNED_RELEASE_AT": p["PLANNED_START_AT"], "TARGET_FINISH_AT": p.get("TARGET_FINISH_AT"), "RELEASED": False})

    # ------------------------------------------------------------ queue (dispatch order DR-1.0: priority class, due date, age)
    out["queue"] = sorted([u for u in out["units"].values() if u["STATE"] in ("QUEUED", "QUEUED_FOR_REWORK")],
                          key=lambda u: (u["CURRENT_WORK_CENTER_ID"] or "", 1 if u["STATE"] == "QUEUED_FOR_REWORK" else (u["PRIORITY_CLASS"] or 3), u["DUE_AT"] or dt.datetime.max, u["QUEUE_ENTERED_AT"] or dt.datetime.max))
    out["shift"] = sh
    return out


def summary(state):
    w = state["workers"].values()
    return {
        "people_in_plant_view": len(state["workers"]),
        "people_with_active_task": sum(1 for x in w if x["ACTIVE_TASK_COUNT"] > 0),
        "people_working": sum(1 for x in w if x["ACTIVITY_STATE"] == "WORKING"),
        "queued_tanks": len(state["queue"]),
        "units_active": sum(1 for u in state["units"].values() if u["STATE"] not in ("ROUTE_COMPLETE", "SCRAPPED")),
        "operations_open": len(state["operations"]),
        "open_inspections": len(state["inspections"]),
        "open_holds": len(state["holds"]),
        "equipment_down": sum(1 for e in state["equipment"].values() if e["STATUS"] == "DOWN"),
    }
