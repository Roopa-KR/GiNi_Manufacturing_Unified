"""Route forecast: resource-constrained discrete-event simulation of the session's current state (5-minute resolution).

Modelled: route precedence per product, DR-1.0 ready queues, workstation capacity, equipment outages until their recorded or
MTTR-estimated recovery, qualified crews (minimum / standard / maximum from CREW_CAPACITY_RULES - non-linear, adding people does not
always help), worker availability from attendance and the rosters known at the fork (cross-shift continuation, nights and weekends),
planned breaks per work-centre calendar, unattended cure (no labour), independent inspection capacity, transfers, material
availability and promised deliveries, holds with the versioned disposition matrix, return/rework/reinspection loops and planned batch
releases. Gate failures are drawn with seeded randomness from first-attempt fail rates known at the fork; the range across
replications is a scenario range, not a calibrated probability.

Never reads recorded future history: inputs are the session's operational records at `now` plus rosters/plans known at the fork.
The same function evaluates recovery options through `overrides` (transfers, overtime, replacements, resequencing, expedites, repairs).
"""
import bisect
import datetime as dt
import hashlib
import heapq
from collections import defaultdict

from .timeutil import local_to_utc, minutes, to_local

STEP_MIN = 5
REPLICATIONS = 5
DEFAULT_FAIL = 0.04
HOLD_DECISION_MIN = 12
RETURN_TRANSFER_MIN = 10
REWORK_LABOR_MIN = 60
QUEUE_STATES = ("QUEUED", "READY", "QUEUED_FOR_REWORK", "RECEIVED_AT_REWORK_STATION", "RELEASED_TO_NEXT_OPERATION", "PLANNED", "AUTHORIZED_REWORK", "RETURN_REQUESTED")
INSPECT_WAIT = ("WORK_COMPLETED_AWAITING_INSPECTION", "REWORK_COMPLETE_AWAITING_REINSPECTION", "INCOMPLETE_INSPECTION_HOLD")
INSPECTING = ("INSPECTION_IN_PROGRESS", "REINSPECTION_IN_PROGRESS")


def rnd(*keys):
    h = hashlib.blake2b("|".join(str(k) for k in keys).encode(), digest_size=8).digest()
    return int.from_bytes(h, "big") / 2 ** 64


# ------------------------------------------------------------------------------------------------ cutoff classification (pure)
def classify(forecast_ready, cutoff, buffer_min=10, shortfall=0, now=None, complete_at=None):
    """GREEN <= buffer deadline < AMBER <= cutoff < RED; RED also for a known quantity shortfall; UNKNOWN when not estimable.
    Completed output keeps its actual result. Boundaries are inclusive as specified (14:20 GREEN, 14:30 AMBER, 14:30:01 RED)."""
    if cutoff is None:
        return {"band": "UNKNOWN", "reason": "No cutoff (due time) recorded"}
    buffer_deadline = cutoff - dt.timedelta(minutes=buffer_min)
    if complete_at is not None:
        actual = "GREEN" if complete_at <= buffer_deadline else ("AMBER" if complete_at <= cutoff else "RED")
        return {"band": "COMPLETE", "actual_result": actual, "buffer_deadline": buffer_deadline, "reason": "Completed output keeps its actual deadline result (%s)" % actual}
    elapsed = now is not None and now > cutoff
    if shortfall and shortfall > 0:
        return {"band": "RED", "buffer_deadline": buffer_deadline, "cutoff_elapsed": elapsed, "reason": "Quantity shortfall of %s by cutoff" % shortfall}
    if forecast_ready is None:
        return {"band": "RED" if elapsed else "UNKNOWN", "buffer_deadline": buffer_deadline, "cutoff_elapsed": elapsed,
                "reason": "Cutoff already elapsed without the required output" if elapsed else "Readiness cannot be estimated from available evidence"}
    if forecast_ready <= buffer_deadline:
        band = "GREEN"
    elif forecast_ready <= cutoff:
        band = "AMBER"
    else:
        band = "RED"
    return {"band": band, "buffer_deadline": buffer_deadline, "cutoff_elapsed": elapsed,
            "reason": "Cutoff already elapsed" if elapsed else {"GREEN": "Forecast ready at or before the buffer deadline", "AMBER": "Forecast ready inside the safety buffer", "RED": "Forecast ready after the cutoff"}[band]}


def _core_wcs():
    from . import variance
    return variance.CORE_WCS


# ------------------------------------------------------------------------------------------------ model building
class Model:
    """inputs captured once; each replication copies the mutable parts"""

    def __init__(self, db, cat, session, now, baselines=None, efficiency=None, horizon_days=6):
        self.db, self.cat, self.s, self.now = db, cat, session, now
        sid, src = session["SESSION_ID"], session["SOURCE_RUN_ID"]
        q = {"SESSION_ID": sid}
        self.units = [u for u in db.sim_units.find(q) if u.get("STATE") not in ("ROUTE_COMPLETE", "SCRAPPED")]
        self.units_done = list(db.sim_units.find(dict(q, STATE="ROUTE_COMPLETE"), {"UNIT_ID": 1, "ORDER_LINE_ID": 1, "ROUTE_COMPLETED_AT": 1, "TERMINAL_IN_SESSION": 1}))
        self.ops = {o["OPERATION_INSTANCE_ID"]: o for o in db.sim_operations.find(dict(q, STATE={"$in": ["CREATED", "WORKING", "PAUSED", "BELOW_MIN_CREW", "CURING"]}))}
        self.tasks = list(db.sim_tasks.find(dict(q, STATUS={"$in": ["ASSIGNED", "ACCEPTED", "WORKING", "PAUSED"]})))
        self.workers = list(db.sim_workers.find(q))
        self.equipment = {e["EQUIPMENT_ID"]: e for e in db.sim_equipment.find(q)}
        self.materials = {m["MATERIAL_ID"]: m for m in db.sim_materials.find(q)}
        self.requests = [r for r in db.sim_material_requests.find(q) if r.get("STATUS") not in ("DELIVERED", "CANCELLED")]
        self.releases = list(db.sim_plan_releases.find(dict(q, RELEASED={"$ne": True})))
        self.holds = {h["HOLD_ID"]: h for h in db.sim_holds.find(dict(q, RESOLUTION={"$in": ["OPEN", "PENDING_REVIEW"]}))}
        self.defects = {d["DEFECT_ID"]: d for d in db.sim_defects.find(q)}
        self.drafts = {i["UNIT_ID"]: i for i in db.sim_inspections.find(dict(q, STATUS="DRAFT"))}
        self.policy = session.get("DISPOSITION_POLICY_ID") or "DEFAULT_REPAIRABLE_RETURN_V1"
        self.fail_rates = ((session.get("AGENT_SETTINGS") or {}).get("FAIL_RATES") or (baselines or {}).get("FIRST_ATTEMPT_FAIL_RATE") or {})
        # fresh factory: no history, so no failure rate is assumed (standard-based forecast); the synthetic demo uses its history
        self.no_history = bool(session.get("FACTORY_SESSION"))
        self.efficiency = efficiency or {}
        self.horizon_end = now + dt.timedelta(days=horizon_days)
        self.good_boundary = (session.get("INIT") or {}).get("AS_OF") or session["FORK_AT"]
        self.good_base = dict((session.get("INIT") or {}).get("GOOD_BY_LINE_AT_FORK") or {})
        for u in self.units_done:
            if u.get("TERMINAL_IN_SESSION") or (u.get("ROUTE_COMPLETED_AT") and u["ROUTE_COMPLETED_AT"] > self.good_boundary):
                self.good_base[u["ORDER_LINE_ID"]] = self.good_base.get(u["ORDER_LINE_ID"], 0) + 1
        self.last_good_at = {}
        for u in self.units_done:
            if u.get("ROUTE_COMPLETED_AT"):
                self.last_good_at[u["ORDER_LINE_ID"]] = max(self.last_good_at.get(u["ORDER_LINE_ID"], u["ROUTE_COMPLETED_AT"]), u["ROUTE_COMPLETED_AT"])
        self.lines = {l["ORDER_LINE_ID"]: l for l in db.order_lines.find({"RUN_ID": src, "SESSION_ID": {"$in": [None, sid]}, "DUE_AT": {"$gte": now - dt.timedelta(days=2)}, "RELEASE_AT": {"$lte": self.horizon_end}}, {"_seed": 0})}
        for u in self.units:
            lid = u.get("ORDER_LINE_ID")
            if lid and lid not in self.lines:
                l = db.order_lines.find_one({"RUN_ID": src, "ORDER_LINE_ID": lid, "SESSION_ID": {"$in": [None, sid]}}, {"_seed": 0})
                if l:
                    self.lines[lid] = l
        self._build_people()
        self._build_breaks()

    # ---------------------------------------------------------------- people availability
    def _build_people(self):
        cat, now, fork = self.cat, self.now, self.s["FORK_AT"]
        self.people = {}          # wid -> {"role", "intervals": [(start, end, wc)]}
        for w in self.workers:
            role = w.get("WORKER_ROLE")
            if role not in ("PRODUCTION_OPERATOR", "QUALITY_INSPECTOR"):
                continue
            wc = w.get("TEMP_WORK_CENTER_ID") or w.get("CURRENT_WORK_CENTER_ID") or w.get("PLANNED_WORK_CENTER_ID") or w.get("HOME_WORK_CENTER_ID")
            iv = []
            end = max([x for x in (w.get("PLANNED_END_AT"), w.get("OVERTIME_UNTIL")) if x] or [now])
            att = w.get("ATTENDANCE_STATE")
            if att == "CLOCKED_IN" and end > now:
                start = w.get("TRANSFER_ARRIVE_AT") if (w.get("ACTIVITY_STATE") == "TRANSFER" and w.get("TRANSFER_ARRIVE_AT")) else now
                iv.append((max(start, now), end, wc))
            elif att in ("NOT_CLOCKED_IN", "NOT_RECORDED") and w.get("ROSTER_STATUS") == "SCHEDULED" and w.get("PLANNED_START_AT") and w["PLANNED_START_AT"] >= fork - dt.timedelta(minutes=30) and end > now:
                iv.append((max(now, w["PLANNED_START_AT"]), end, w.get("PLANNED_WORK_CENTER_ID") or wc))
            self.people[w["WORKER_ID"]] = {"role": role, "intervals": iv, "current_shift": w.get("SHIFT_ID"), "absent": att == "ABSENT"}
        # rosters of later shifts known at the fork (continuation rule) + application-created rosters
        src = self.s["SOURCE_RUN_ID"]
        rows = list(self.db.shift_roster.find({"RUN_ID": src, "PLANNED_START_AT": {"$gt": now, "$lte": self.horizon_end}, "ROSTER_STATUS": "SCHEDULED"},
                                              {"WORKER_ID": 1, "SHIFT_ID": 1, "PLANNED_START_AT": 1, "PLANNED_END_AT": 1, "PLANNED_WORK_CENTER_ID": 1, "KNOWN_AT": 1}))
        rows += list(self.db.continuation_shift_roster.find({"PLANNED_START_AT": {"$gt": now, "$lte": self.horizon_end}},
                                                            {"WORKER_ID": 1, "SHIFT_ID": 1, "PLANNED_START_AT": 1, "PLANNED_END_AT": 1, "PLANNED_WORK_CENTER_ID": 1}))
        rows += list(self.db.app_shift_roster.find({"PLANNED_START_AT": {"$gt": now, "$lte": self.horizon_end}, "ROSTER_STATUS": {"$in": ["SCHEDULED", None]}, "SESSION_ID": {"$in": [None, self.s["SESSION_ID"]]}},
                                                   {"WORKER_ID": 1, "SHIFT_ID": 1, "PLANNED_START_AT": 1, "PLANNED_END_AT": 1, "PLANNED_WORK_CENTER_ID": 1}))
        for r in rows:
            if r.get("KNOWN_AT") and r["KNOWN_AT"] > max(fork, now):
                continue
            p = self.people.get(r["WORKER_ID"])
            if p is None or r.get("SHIFT_ID") == p.get("current_shift"):
                continue
            if any(a <= r["PLANNED_START_AT"] < b for a, b, _ in p["intervals"]):
                continue
            p["intervals"].append((r["PLANNED_START_AT"], r["PLANNED_END_AT"], r.get("PLANNED_WORK_CENTER_ID")))
        self.skills = {}
        for wid in self.people:
            self.skills[wid] = {q["SKILL_ID"] for q in cat.quals.get(wid, []) if q.get("QUALIFICATION_STATUS") in ("VALID", None)
                                and (q.get("VALID_TO") is None or q["VALID_TO"] >= now) and (q.get("VALID_FROM") is None or q["VALID_FROM"] <= self.horizon_end)}

    def _build_breaks(self):
        self.breaks = defaultdict(list)
        cat = self.cat
        for sid, sh in cat.shifts.items():
            d = sh["SHIFT_DATE"].strftime("%Y-%m-%d")
            start = local_to_utc(d, sh["START_AT_LOCAL"])
            if start > self.horizon_end or start < self.now - dt.timedelta(days=1):
                continue
            for c in cat.calendar:
                if c.get("SHIFT_ID") == sid and c.get("INTERVAL_TYPE") == "PLANNED_BREAK":
                    a, b = local_to_utc(d, c["START_AT_LOCAL"]), local_to_utc(d, c["END_AT_LOCAL"])
                    if b <= a:
                        b += dt.timedelta(days=1)
                    if a < start:
                        a += dt.timedelta(days=1); b += dt.timedelta(days=1)
                    self.breaks[c.get("RESOURCE_ID")].append((a, b))
        for k in self.breaks:
            self.breaks[k].sort()

    def in_break(self, wc, t):
        for a, b in self.breaks.get(wc, ()):
            if a <= t < b:
                return True
            if a > t:
                break
        return False


# ------------------------------------------------------------------------------------------------ simulation
class Sim:
    def __init__(self, m, rep, seed, overrides=None):
        self.m, self.cat, self.rep, self.seed = m, m.cat, rep, seed
        ov = overrides or {}
        self.t = m.now
        self.events = []
        self._n = 0
        self.good = defaultdict(list)            # line -> [completion times]
        self.scrap = defaultdict(list)
        self.unit_done = {}
        self.op_finish = {}
        self.wait = defaultdict(lambda: defaultdict(float))     # wc -> reason -> unit-minutes
        self.line_wait = defaultdict(lambda: defaultdict(float))
        self.starved = defaultdict(float)
        self.no_work_at = {}
        self.next_arrival = {}
        self.busy_min = defaultdict(float)
        self.notes = []
        # people (copy + overrides)
        self.people = {wid: {"role": p["role"], "iv": list(p["intervals"])} for wid, p in m.people.items()}
        for tr in ov.get("transfers", []):
            p = self.people.get(tr["workerId"])
            if not p:
                continue
            at = tr.get("arriveAt") or m.now
            until = tr.get("until")
            new = []
            for a, b, wc in p["iv"]:
                if b <= at or (until and a >= until):
                    new.append((a, b, wc)); continue
                if a < at:
                    new.append((a, at - dt.timedelta(minutes=float(tr.get("travelMin", 0))), wc))
                new.append((max(a, at), min(b, until) if until else b, tr["toWorkCenterId"]))
                if until and b > until:
                    new.append((until, b, wc))
            p["iv"] = [x for x in new if x[1] > x[0]]
        for rl in ov.get("reliefs", []):              # an off-shift person called in: an extra availability interval at the destination
            p = self.people.setdefault(rl["workerId"], {"role": "PRODUCTION_OPERATOR", "iv": []})
            if rl.get("until") and rl["until"] > rl["from"]:
                p["iv"].append((rl["from"], rl["until"], rl["toWorkCenterId"]))
        for ot in ov.get("overtime", []):
            p = self.people.get(ot["workerId"])
            if p and p["iv"]:
                cur = [x for x in p["iv"] if x[0] <= m.now + dt.timedelta(hours=10)]
                if cur:
                    a, b, wc = max(cur, key=lambda x: x[1])
                    p["iv"].remove((a, b, wc))
                    p["iv"].append((a, b + dt.timedelta(minutes=float(ot["minutes"])), wc))
        for p in self.people.values():
            p["iv"].sort()
        self.prio = dict(ov.get("priority", {}))
        self.repairs = dict(ov.get("repairs", {}))
        # equipment availability: down until recovery
        self.eq_down_until = {}
        for eid, e in m.equipment.items():
            if e.get("STATUS") == "DOWN":
                est = self.repairs.get(eid) or e.get("ESTIMATED_RECOVERY_AT")
                if not est:
                    mttr = float((self.cat.equipment.get(eid) or {}).get("MTTR_MIN") or 60)
                    est = max(m.now, (e.get("SINCE") or m.now) + dt.timedelta(minutes=mttr))
                    self.notes.append("%s recovery not recorded - MTTR estimate %s min used" % (eid, int(mttr)))
                self.eq_down_until[eid] = max(est, m.now)
        # materials
        self.stock = {mid: float(x.get("ON_HAND_QTY") or 0) - float(x.get("HOLD_QTY") or 0) - float(x.get("RESERVED_QTY") or 0) for mid, x in m.materials.items()}
        for r in m.requests:
            due = r.get("PROMISED_AT") or r.get("NEED_BY_AT")
            if due:
                self.push(max(due, m.now), "DELIVERY", {"mid": r["MATERIAL_ID"], "qty": float(r.get("QTY") or 0) - float(r.get("DELIVERED_QTY") or 0)})
        self.pending_delivery = {r["MATERIAL_ID"] for r in m.requests}
        self.supply_at = {mid: x["SUPPLY_AVAILABLE_AT"] for mid, x in m.materials.items() if x.get("SUPPLY_AVAILABLE_AT") and x["SUPPLY_AVAILABLE_AT"] > m.now}
        self.daily_use = ((m.s.get("AGENT_SETTINGS") or {}).get("BASELINES") or {}).get("MATERIAL_DAILY_USE") or {}
        for x in ov.get("expedites", []):        # an expedite is premium freight from the same supplier: it cannot beat a supply interruption
            self.push(max(x.get("at") or m.now + dt.timedelta(minutes=30), self.supply_at.get(x["materialId"]) or m.now), "DELIVERY", {"mid": x["materialId"], "qty": float(x["qty"])})
        # stations
        self.station_busy = {}                    # ws -> unit id
        self.worker_busy = {}                     # wid -> ("LABOR", uid) | ("INSPECT", uid)
        self.units = {}
        self.running = {}                         # uid -> labor op dict
        self.queue = defaultdict(list)            # wc -> [uid]
        self.insp_wait = []                       # [uid]
        self._load_units(ov)
        for r in m.releases:
            if r.get("PLANNED_RELEASE_AT") and r["PLANNED_RELEASE_AT"] <= m.horizon_end:
                self.push(max(r["PLANNED_RELEASE_AT"], m.now), "RELEASE", {"batch": r["BATCH_ID"], "line": r.get("ORDER_LINE_ID"), "product": r.get("PRODUCT_ID"), "qty": int(r.get("PLANNED_QTY") or 0), "due": r.get("TARGET_FINISH_AT")})
        for i, rp in enumerate(ov.get("replacements", [])):
            self.push(rp.get("at") or m.now, "RELEASE", {"batch": "REPL-%d" % i, "line": rp["orderLineId"], "product": rp["productId"], "qty": 1, "priority": 1, "replacement": True})

    # ------------------------------------------------------------- helpers
    def push(self, t, kind, data):
        self._n += 1
        heapq.heappush(self.events, (t, self._n, kind, data))

    def route(self, product):
        return self.cat.route(product)

    def opdef(self, product, op):
        return self.cat.op(product, op) or {}

    def next_after(self, product, op):
        seq = self.route(product)
        if op not in seq:
            return "ROUTE_END"
        i = seq.index(op)
        return seq[i + 1] if i + 1 < len(seq) else "ROUTE_END"

    def first_labor_from(self, product, op):
        seq = self.route(product)
        i = seq.index(op) if op in seq else 0
        for o in seq[i:]:
            if self.opdef(product, o).get("OPERATION_KIND") == "LABOR":
                return o
        return None

    def gate_after(self, product, op):
        seq = self.route(product)
        if op not in seq:
            return None
        for o in seq[seq.index(op) + 1:]:
            k = self.opdef(product, o).get("OPERATION_KIND")
            if k == "INSPECTION":
                return o
            if k == "LABOR":
                return None
        return None

    def wc_of_op(self, product, op):
        return self.opdef(product, op).get("WORK_CENTER_ID")

    def present(self, wid, t):
        """work centre where the person is available at t ('ANY' for people without a work-centre assignment), else None"""
        for a, b, wc in self.people[wid]["iv"]:
            if a <= t < b:
                return wc or "ANY"
            if a > t:
                break
        return None

    def eq_ok(self, eid, t):
        u = self.eq_down_until.get(eid)
        return u is None or u <= t

    # ------------------------------------------------------------- initial state
    def _load_units(self, ov):
        m = self.m
        for u in m.units:
            uid, prod, st = u["UNIT_ID"], u.get("PRODUCT_ID"), u.get("STATE")
            rec = {"uid": uid, "product": prod, "line": u.get("ORDER_LINE_ID"), "due": u.get("DUE_AT"), "prio": self.prio.get(uid, u.get("PRIORITY_CLASS") or 3),
                   "entered": u.get("QUEUE_ENTERED_AT") or u.get("STATE_SINCE") or m.now, "attempts": defaultdict(int), "rework": None, "state": st}
            self.units[uid] = rec
            op = m.ops.get(u.get("CURRENT_OPERATION_INSTANCE_ID")) if u.get("CURRENT_OPERATION_INSTANCE_ID") else None
            step = u.get("ROUTE_STEP")
            pend = u.get("REWORK_PENDING")
            if st in ("WORKING", "PAUSED", "REWORK_IN_PROGRESS", "READY") and op and op.get("OPERATION_KIND") == "LABOR":
                crew = [t["WORKER_ID"] for t in m.tasks if t["OPERATION_INSTANCE_ID"] == op["OPERATION_INSTANCE_ID"] and t["STATUS"] in ("WORKING", "PAUSED", "ACCEPTED", "ASSIGNED")]
                rw = str(op.get("INSTANCE_TYPE", "")).endswith("REWORK")
                self._start_labor(rec, op["OPERATION_ID"], op.get("WORKSTATION_ID"), [w for w in crew if w in self.people], float(op.get("PROGRESS_FRACTION") or 0), rw,
                                  op_instance=op["OPERATION_INSTANCE_ID"], equipment=op.get("EQUIPMENT_ID"), rework_std=float(op.get("REWORK_STANDARD_LABOR_MIN") or REWORK_LABOR_MIN))
            elif st == "CURING":
                pop = op if op and op.get("OPERATION_KIND") == "PROCESS" else None
                pid = pop["OPERATION_ID"] if pop else step
                el = float(self.opdef(prod, pid).get("STANDARD_ELAPSED_MIN") or 0)
                started = (pop or {}).get("STARTED_AT") or u.get("STATE_SINCE") or m.now
                self.push(max(m.now, started + dt.timedelta(minutes=el)), "PROCESS_DONE", {"uid": uid, "op": pid})
            elif st in INSPECT_WAIT:
                gate = step if self.opdef(prod, step).get("OPERATION_KIND") == "INSPECTION" else self.gate_after(prod, step)
                rec["gate"] = gate
                rec["is_reinspection"] = st == "REWORK_COMPLETE_AWAITING_REINSPECTION"
                self.insp_wait.append(uid)
            elif st in INSPECTING:
                d = m.drafts.get(uid)
                gate = (d or {}).get("GATE_OPERATION_ID") or step
                rec["gate"] = gate
                el = float(self.opdef(prod, gate).get("STANDARD_ELAPSED_MIN") or 15)
                started = (d or {}).get("STARTED_AT") or u.get("STATE_SINCE") or m.now
                insp = (d or {}).get("INSPECTOR_ID")
                if insp in self.people:
                    self.worker_busy[insp] = ("INSPECT", uid)
                self.push(max(m.now, started + dt.timedelta(minutes=el)), "INSPECT_DONE", {"uid": uid, "gate": gate, "inspector": insp, "attempt": int((d or {}).get("ATTEMPT_NO") or 1)})
            elif st == "PASS_PENDING_RELEASE":
                self.push(m.now + dt.timedelta(minutes=3), "GATE_PASSED", {"uid": uid, "gate": step})
            elif st in ("FAILED_INSPECTION", "QUALITY_HOLD", "PENDING_REVIEW"):
                h = m.holds.get(u.get("HOLD_ID")) or next((x for x in m.holds.values() if x["UNIT_ID"] == uid), None)
                code = None
                if h:
                    ds = [m.defects.get(d) for d in (h.get("DEFECT_IDS") or [])]
                    code = next((d["DEFECT_CODE"] for d in ds if d), None)
                gate = (h or {}).get("GATE_OPERATION_ID") or (h or {}).get("DETECTION_POINT") or step
                rule = self.cat.disposition(m.policy, gate, code or "UNCLASSIFIED") if code else None
                if st == "PENDING_REVIEW" or not rule or rule.get("DEFECT_CODE") != code:
                    rec["held_unknown"] = True
                    self.notes.append("%s on hold without an explicit disposition - excluded from forecast output (stays held for a named approver)" % uid)
                    continue
                at = max(m.now, ((h or {}).get("HOLD_STARTED_AT") or m.now) + dt.timedelta(minutes=HOLD_DECISION_MIN))
                origin = (h or {}).get("ORIGIN_OPERATION_ID") or self.cat.labor_op_of_gate(prod, gate) if gate in self.route(prod) else step
                self.push(at, "DISPOSITION", {"uid": uid, "decision": rule.get("DISPOSITION"), "origin": origin})
            elif st in ("AUTHORIZED_REWORK", "RETURN_REQUESTED", "IN_RETURN_TRANSFER", "RECEIVED_AT_REWORK_STATION", "QUEUED_FOR_REWORK"):
                origin = (pend or {}).get("ORIGIN_OPERATION_ID") or step
                rec["rework"] = {"op": origin, "ws": (pend or {}).get("DEST_WORKSTATION_ID"), "std": float((pend or {}).get("REWORK_STANDARD_LABOR_MIN") or REWORK_LABOR_MIN)}
                delay = {"AUTHORIZED_REWORK": 8 + RETURN_TRANSFER_MIN, "RETURN_REQUESTED": 4 + RETURN_TRANSFER_MIN, "IN_RETURN_TRANSFER": 0}.get(st, 0)
                arrive = u.get("ARRIVE_AT") if st == "IN_RETURN_TRANSFER" and u.get("ARRIVE_AT") else m.now + dt.timedelta(minutes=delay)
                self.push(max(arrive, m.now), "ENQUEUE", {"uid": uid, "op": origin})
            elif st == "IN_TRANSFER":
                nxt = self.first_labor_from(prod, step) or step
                arrive = u.get("ARRIVE_AT") or ((u.get("STATE_SINCE") or m.now) + dt.timedelta(minutes=10))
                self.push(max(arrive, m.now), "ENQUEUE", {"uid": uid, "op": nxt})
            elif st in QUEUE_STATES or op is None:
                if pend and pend.get("ORIGIN_OPERATION_ID"):
                    rec["rework"] = {"op": pend["ORIGIN_OPERATION_ID"], "ws": pend.get("DEST_WORKSTATION_ID"), "std": float(pend.get("REWORK_STANDARD_LABOR_MIN") or REWORK_LABOR_MIN)}
                    self.push(m.now, "ENQUEUE", {"uid": uid, "op": pend["ORIGIN_OPERATION_ID"]})
                    continue
                k = self.opdef(prod, step).get("OPERATION_KIND")
                if k == "INSPECTION" and st in ("RELEASED_TO_NEXT_OPERATION",):
                    step = self.next_after(prod, step)
                if step == "ROUTE_END":
                    self.push(m.now, "GATE_PASSED", {"uid": uid, "gate": None, "final": True})
                    continue
                nxt = self.first_labor_from(prod, step) if self.opdef(prod, step).get("OPERATION_KIND") != "PROCESS" else step
                if self.opdef(prod, step).get("OPERATION_KIND") == "PROCESS":
                    el = float(self.opdef(prod, step).get("STANDARD_ELAPSED_MIN") or 0)
                    self.push(m.now + dt.timedelta(minutes=el), "PROCESS_DONE", {"uid": uid, "op": step})
                elif nxt:
                    self.push(m.now, "ENQUEUE", {"uid": uid, "op": nxt})
            else:
                rec["held_unknown"] = True
                self.notes.append("%s state %s not forecastable" % (uid, st))

    # ------------------------------------------------------------- labour operations
    def elapsed(self, rec, op, crew_n, rework, rework_std):
        if rework:
            return rework_std / max(1, min(crew_n, 2))
        el = self.cat.elapsed_for_crew(rec["product"], op, crew_n)
        if el is None:
            return None
        wc = self.wc_of_op(rec["product"], op)
        f = self.m.efficiency.get(wc)
        return el / f if f else el

    def _start_labor(self, rec, op, ws, crew, progress, rework, op_instance=None, equipment=None, rework_std=REWORK_LABOR_MIN):
        d = self.opdef(rec["product"], op)
        r = {"uid": rec["uid"], "op": op, "ws": ws, "crew": list(crew), "p": progress, "rework": rework, "rework_std": rework_std, "wc": d.get("WORK_CENTER_ID"),
             "min": 1 if rework else int(d.get("MIN_CREW_SIZE") or 1), "std": (2 if int(d.get("MIN_CREW_SIZE") or 1) > 1 else 1) if rework else int(d.get("STD_CREW_SIZE") or 1),
             "max": int(d.get("MAX_CREW_SIZE") or 9), "skill": d.get("REQUIRED_SKILL_ID"), "inst": op_instance, "eq": equipment or (self.cat.stations.get(ws) or {}).get("EQUIPMENT_ID")}
        self.running[rec["uid"]] = r
        if ws:
            self.station_busy[ws] = rec["uid"]
        for w in crew:
            self.worker_busy[w] = ("LABOR", rec["uid"])
        rec["state"] = "WORKING"

    def _finish_labor(self, r, at):
        rec = self.units[r["uid"]]
        for w in r["crew"]:
            if self.worker_busy.get(w, (None, None))[1] == r["uid"]:
                self.worker_busy.pop(w, None)
        if r["ws"] and self.station_busy.get(r["ws"]) == r["uid"]:
            self.station_busy.pop(r["ws"], None)
        self.running.pop(r["uid"], None)
        if r.get("inst"):
            self.op_finish[r["inst"]] = at
        rec["rework"] = None
        nxt = self.next_after(rec["product"], r["op"])
        k = self.opdef(rec["product"], nxt).get("OPERATION_KIND") if nxt != "ROUTE_END" else None
        if k == "PROCESS":
            el = float(self.opdef(rec["product"], nxt).get("STANDARD_ELAPSED_MIN") or 0)
            self.push(at + dt.timedelta(minutes=el), "PROCESS_DONE", {"uid": rec["uid"], "op": nxt})
            rec["state"] = "CURING"
        elif k == "INSPECTION":
            rec["gate"] = nxt
            rec["is_reinspection"] = r["rework"]
            rec["state"] = "WAIT_INSPECTION"
            self.insp_wait.append(rec["uid"])
        else:
            self.push(at, "GATE_PASSED", {"uid": rec["uid"], "gate": None, "from_op": r["op"]})

    # ------------------------------------------------------------- event handling
    def handle(self, t, kind, d):
        m = self.m
        if kind == "DELIVERY":
            self.stock[d["mid"]] = self.stock.get(d["mid"], 0) + d["qty"]
            self.pending_delivery.discard(d["mid"])
        elif kind == "RELEASE":
            first = self.route(d["product"])[0] if d.get("product") else None
            if not first:
                return
            for i in range(d["qty"]):
                uid = "FC-%s-%d" % (d["batch"], i + 1)
                self.units[uid] = {"uid": uid, "product": d["product"], "line": d["line"], "due": d.get("due"), "prio": d.get("priority", 3), "entered": t, "attempts": defaultdict(int),
                                   "rework": None, "state": "QUEUED", "planned": True, "replacement": d.get("replacement")}
                self.handle(t, "ENQUEUE", {"uid": uid, "op": self.first_labor_from(d["product"], first)})
        elif kind == "ENQUEUE":
            rec = self.units[d["uid"]]
            rec["step"] = d["op"]
            rec["entered"] = t
            rec["state"] = "QUEUED"
            wc = self.wc_of_op(rec["product"], d["op"])
            self.queue[wc].append(d["uid"])
            self.next_arrival.setdefault(wc, t)
        elif kind == "PROCESS_DONE":
            rec = self.units[d["uid"]]
            nxt = self.next_after(rec["product"], d["op"])
            if nxt != "ROUTE_END" and self.opdef(rec["product"], nxt).get("OPERATION_KIND") == "INSPECTION":
                rec["gate"], rec["is_reinspection"], rec["state"] = nxt, False, "WAIT_INSPECTION"
                self.insp_wait.append(d["uid"])
            else:
                self.push(t, "GATE_PASSED", {"uid": d["uid"], "gate": None, "from_op": d["op"]})
        elif kind == "INSPECT_DONE":
            rec = self.units[d["uid"]]
            if d.get("inspector") and self.worker_busy.get(d["inspector"], (None, None))[1] == d["uid"]:
                self.worker_busy.pop(d["inspector"], None)
            gate = d["gate"]
            rec["attempts"][gate] += 1
            att = rec["attempts"][gate] + (int(d.get("attempt") or 1) - 1)
            rate = float(m.fail_rates.get(gate, 0.0 if m.no_history else DEFAULT_FAIL) or 0)
            if att > 1:
                rate = rate * 0.5
            failed = self.rep > 0 and rnd(self.seed, self.rep, rec["uid"], gate, att) < rate
            if not failed:
                self.push(t + dt.timedelta(minutes=3), "GATE_PASSED", {"uid": rec["uid"], "gate": gate})
            else:
                code = "OUT_OF_TOLERANCE"          # a failed numeric reading; the matrix entry for that code decides
                rule = self.cat.disposition(m.policy, gate, code) or {}
                origin = self.cat.labor_op_of_gate(rec["product"], gate) if gate in self.route(rec["product"]) else None
                esc = int(rule.get("ESCALATE_AFTER_FAILED_REINSPECTIONS") or 2)
                if att > esc:
                    rec["held_unknown"] = True; rec["state"] = "ESCALATED"
                    return
                self.push(t + dt.timedelta(minutes=HOLD_DECISION_MIN), "DISPOSITION", {"uid": rec["uid"], "decision": rule.get("DISPOSITION") or "REPAIRABLE_RETURN", "origin": origin})
                rec["state"] = "HOLD"
        elif kind == "DISPOSITION":
            rec = self.units[d["uid"]]
            if d["decision"] == "SCRAP":
                rec["state"] = "SCRAPPED"
                self.scrap[rec["line"]].append(t)
                self.unit_done[rec["uid"]] = ("SCRAP", t)
            elif d["decision"] == "REPAIRABLE_RETURN" and d.get("origin"):
                rec["rework"] = {"op": d["origin"], "ws": None, "std": REWORK_LABOR_MIN}
                self.push(t + dt.timedelta(minutes=4 + RETURN_TRANSFER_MIN), "ENQUEUE", {"uid": rec["uid"], "op": d["origin"]})
            else:
                rec["held_unknown"] = True
        elif kind == "GATE_PASSED":
            rec = self.units[d["uid"]]
            last = d.get("gate") or d.get("from_op")
            nxt = "ROUTE_END" if d.get("final") else self.next_after(rec["product"], last)
            if nxt == "ROUTE_END":
                rec["state"] = "ROUTE_COMPLETE"
                self.good[rec["line"]].append(t)
                self.unit_done[rec["uid"]] = ("GOOD", t)
                return
            tm = self.cat.transfer_min(last, nxt)
            k = self.opdef(rec["product"], nxt).get("OPERATION_KIND")
            if k == "PROCESS":
                el = float(self.opdef(rec["product"], nxt).get("STANDARD_ELAPSED_MIN") or 0)
                self.push(t + dt.timedelta(minutes=tm + el), "PROCESS_DONE", {"uid": rec["uid"], "op": nxt})
            else:
                self.push(t + dt.timedelta(minutes=tm), "ENQUEUE", {"uid": rec["uid"], "op": self.first_labor_from(rec["product"], nxt) or nxt})

    # ------------------------------------------------------------- resource allocation each step
    def material_ok(self, rec, op, consume=False):
        if rec.get("rework"):
            return True
        for r in self.cat.mat_reqs:
            if r["PRODUCT_ID"] == rec["product"] and r.get("CONSUMED_AT_OPERATION_ID") == op:
                q = float(r.get("QTY_PER_UNIT") or 0)
                if self.stock.get(r["MATERIAL_ID"], 0) < q:
                    return False
        if consume:
            for r in self.cat.mat_reqs:
                if r["PRODUCT_ID"] == rec["product"] and r.get("CONSUMED_AT_OPERATION_ID") == op:
                    self.stock[r["MATERIAL_ID"]] = self.stock.get(r["MATERIAL_ID"], 0) - float(r.get("QTY_PER_UNIT") or 0)
        return True

    def free_workers(self, wc, skill, t):
        out = []
        for wid, p in self.people.items():
            if p["role"] != "PRODUCTION_OPERATOR" or wid in self.worker_busy:
                continue
            if self.present(wid, t) != wc:
                continue
            if skill and skill not in self.m.skills.get(wid, ()):
                continue
            out.append(wid)
        out.sort()
        return out

    def replenish(self, t):
        """same replenishment continuation policy as the material-handler agent (reorder below 75% of a day's use, 1.5 days ordered,
        promised in 90 min); deterministic in the forecast"""
        for mid, daily in self.daily_use.items():
            daily = float(daily or 0)
            if daily > 0 and mid not in self.pending_delivery and self.stock.get(mid, 0) < daily * 0.75:
                self.pending_delivery.add(mid)
                at = max(t + dt.timedelta(minutes=90), self.supply_at.get(mid) or t)      # a supply interruption delays the re-order
                self.push(at, "DELIVERY", {"mid": mid, "qty": max(1, int(round(daily * 1.5 + 0.4999)))})

    def allocate(self, t):
        self.replenish(t)
        # 1) running labour: crew presence, breaks, progress
        for uid, r in list(self.running.items()):
            r["crew"] = [w for w in r["crew"] if self.present(w, t) == r["wc"]]
            for w in list(self.worker_busy):
                if self.worker_busy[w] == ("LABOR", uid) and w not in r["crew"]:
                    self.worker_busy.pop(w)
            if len(r["crew"]) < r["std"] and not self.m.in_break(r["wc"], t) and self.eq_ok(r["eq"], t):
                for w in self.free_workers(r["wc"], r["skill"], t)[: r["std"] - len(r["crew"])]:
                    r["crew"].append(w); self.worker_busy[w] = ("LABOR", uid)
        # 2) new starts in DR-1.0 order
        for wc, q in self.queue.items():
            if not q:
                continue
            q.sort(key=lambda uid: (1 if self.units[uid].get("rework") else self.units[uid]["prio"], self.units[uid].get("due") or dt.datetime.max, self.units[uid]["entered"]))
            stations = self.cat.stations_of(wc)
            for uid in list(q):
                rec = self.units[uid]
                op = rec["step"]
                d = self.opdef(rec["product"], op)
                rw = rec.get("rework")
                cands = [s for s in stations if s["WORKSTATION_ID"] not in self.station_busy and self.eq_ok(s.get("EQUIPMENT_ID"), t)]
                if rw and rw.get("ws"):
                    cands = [s for s in cands if s["WORKSTATION_ID"] == rw["ws"]]
                reason = None
                if not cands:
                    idle_down = [s for s in stations if s["WORKSTATION_ID"] not in self.station_busy and not self.eq_ok(s.get("EQUIPMENT_ID"), t)]
                    reason = "EQUIPMENT_DOWN" if idle_down else "STATIONS_BUSY"
                elif not self.material_ok(rec, op):
                    reason = "MATERIAL"
                elif self.m.in_break(wc, t):
                    reason = "BREAK"
                else:
                    minimum = 1 if rw else int(d.get("MIN_CREW_SIZE") or 1)
                    target = (2 if int(d.get("MIN_CREW_SIZE") or 1) > 1 else 1) if rw else int(d.get("STD_CREW_SIZE") or 1)
                    pool = self.free_workers(wc, d.get("REQUIRED_SKILL_ID"), t)
                    if len(pool) < minimum:
                        reason = "QUALIFIED_LABOUR"
                    else:
                        self.material_ok(rec, op, consume=True)
                        q.remove(uid)
                        self._start_labor(rec, op, cands[0]["WORKSTATION_ID"], pool[:target], 0.0, bool(rw), rework_std=(rw or {}).get("std", REWORK_LABOR_MIN))
                        continue
                self.wait[wc][reason] += STEP_MIN
                self.line_wait[rec["line"]][reason + "@" + wc] += STEP_MIN
        # 3) inspections (independent: not a crew member of the inspected attempt - approximated by role separation)
        if self.insp_wait:
            free = sorted(w for w, p in self.people.items() if p["role"] == "QUALITY_INSPECTOR" and w not in self.worker_busy and self.present(w, t))
            for uid in list(self.insp_wait):
                rec = self.units[uid]
                if not free:
                    self.wait["INSPECTION"]["INSPECTOR"] += STEP_MIN
                    self.line_wait[rec["line"]]["INSPECTOR@" + str(rec.get("gate"))] += STEP_MIN
                    continue
                w = free.pop(0)
                self.worker_busy[w] = ("INSPECT", uid)
                self.insp_wait.remove(uid)
                el = float(self.opdef(rec["product"], rec["gate"]).get("STANDARD_ELAPSED_MIN") or 15)
                self.push(t + dt.timedelta(minutes=el), "INSPECT_DONE", {"uid": uid, "gate": rec["gate"], "inspector": w})

    def progress(self, t, dtm):
        for uid, r in list(self.running.items()):
            if self.m.in_break(r["wc"], t) or not self.eq_ok(r["eq"], t):
                self.wait[r["wc"]]["BREAK" if self.m.in_break(r["wc"], t) else "EQUIPMENT_DOWN"] += dtm
                continue
            n = len(r["crew"])
            if n < r["min"]:
                self.wait[r["wc"]]["BELOW_MIN_CREW"] += dtm
                self.line_wait[self.units[uid]["line"]]["QUALIFIED_LABOUR@" + r["wc"]] += dtm
                continue
            el = self.elapsed(self.units[uid], r["op"], min(n, r["max"]), r["rework"], r["rework_std"])
            if not el:
                continue
            self.busy_min[r["wc"]] += dtm * n
            remaining = (1 - r["p"]) * el
            if remaining <= dtm:
                self._finish_labor(r, t + dt.timedelta(minutes=remaining))
            else:
                r["p"] += dtm / el

    def observe(self, t):
        for wc in _core_wcs():
            if wc in self.no_work_at:
                continue
            busy = any(r["wc"] == wc for r in self.running.values()) or self.queue.get(wc)
            if not busy and self.free_workers(wc, None, t) and not self.m.in_break(wc, t):
                self.no_work_at[wc] = t
            if not busy and self.free_workers(wc, None, t):
                self.starved[wc] += STEP_MIN

    def anyone_present(self, t):
        return any(self.present(w, t) for w in self.people)

    def next_presence(self, t):
        nxt = None
        for p in self.people.values():
            for a, b, wc in p["iv"]:
                if a > t:
                    nxt = a if nxt is None or a < nxt else nxt
                    break
        return nxt

    def run(self):
        m, t = self.m, self.m.now
        step = dt.timedelta(minutes=STEP_MIN)
        while t < m.horizon_end:
            while self.events and self.events[0][0] <= t:
                et, _, kind, d = heapq.heappop(self.events)
                self.handle(et, kind, d)
            if not self.anyone_present(t) and not self.running_process_pending(t):
                nxt = [x for x in (self.next_presence(t), self.events[0][0] if self.events else None) if x]
                if not nxt:
                    break
                t = max(t + step, min(nxt))
                continue
            self.allocate(t)
            self.progress(t, STEP_MIN)
            self.observe(t)
            if not self.running and not self.events and not any(self.queue.values()) and not self.insp_wait:
                break
            t += step
        self.end = t
        return self

    def running_process_pending(self, t):
        return bool(self.events and self.events[0][0] <= t + dt.timedelta(minutes=STEP_MIN))


# ------------------------------------------------------------------------------------------------ public API
def efficiency_factors(d_metrics):
    """observed completed-attempt efficiency per WC, bounded to 0.7..1.2; None when the sample is insufficient (standard used)"""
    out, basis = {}, {}
    for wc, lab in d_metrics.items():
        e = lab.get("efficiency_pct")
        if e is not None and lab.get("completed_operations", 0) >= 3 and lab.get("actual_labor_min", 0) >= 120:
            out[wc] = max(0.7, min(1.2, e / 100.0))
            basis[wc] = "OBSERVED_EFFICIENCY %.1f%% over %d completed attempts (bounded 70-120%%)" % (e, lab["completed_operations"])
        else:
            basis[wc] = "ROUTING_STANDARD (insufficient completed attempts for an empirical factor)"
    return out, basis


def run_forecast(model, seed, overrides=None, reps=REPLICATIONS, buffer_min=10):
    sims = [Sim(model, rep, seed, overrides).run() for rep in range(reps)]
    return summarise(model, sims, buffer_min)


def _median(xs):
    xs = sorted(xs)
    return xs[(len(xs) - 1) // 2] if xs else None


def summarise(model, sims, buffer_min):
    m = model
    lines_out = []
    for lid, l in m.lines.items():
        req = int(l.get("REQUIRED_GOOD_QTY") or 0)
        base = int(m.good_base.get(lid, 0))
        due = l.get("DUE_AT")
        active = [u for u in m.units if u.get("ORDER_LINE_ID") == lid]
        planned = sum(int(r.get("PLANNED_QTY") or 0) for r in m.releases if r.get("ORDER_LINE_ID") == lid)
        if not active and not planned and base >= req and (not due or due < m.now - dt.timedelta(days=1)):
            continue
        finishes, by_due, shortfalls, totals = [], [], [], []
        for s in sims:
            times = sorted(s.good.get(lid, []))
            need = req - base
            fin = None
            if need <= 0:
                fin = None
            elif len(times) >= need:
                fin = times[need - 1]
            finishes.append(fin)
            got = base + sum(1 for x in times if due and x <= due)
            by_due.append(got)
            totals.append(base + len(times))
        complete_at = m.last_good_at.get(lid) if base >= req else None
        known = [f for f in finishes if f is not None]
        p50_fin = _median(known) if len(known) * 2 > len(finishes) else None
        good_by_due = _median(by_due)
        shortfall = max(0, req - good_by_due) if due else 0
        held_unknown = sum(1 for u in sims[0].units.values() if u.get("line") == lid and u.get("held_unknown"))
        if complete_at is not None:
            cls = classify(None, due, buffer_min, 0, m.now, complete_at)
        elif p50_fin is not None:
            cls = classify(p50_fin, due, buffer_min, 0, m.now)
        elif due and due <= m.horizon_end and shortfall > 0:
            cls = classify(None, due, buffer_min, shortfall, m.now)
            if max(totals) < req:
                cls["reason"] = "Not enough released, planned or replacement tanks to reach the required good quantity (forecast %s of %s)" % (_median(totals), req)
        else:
            cls = classify(None, due, buffer_min, 0, m.now)
            if held_unknown:
                cls["reason"] = "%d tank(s) held without an explicit disposition - readiness cannot be estimated until a named approver decides" % held_unknown
        lw = defaultdict(float)
        for s in sims:
            for k, v in s.line_wait.get(lid, {}).items():
                lw[k] += v / len(sims)
        top = sorted(lw.items(), key=lambda kv: -kv[1])[:3]
        lines_out.append({
            "ORDER_LINE_ID": lid, "ORDER_ID": l.get("ORDER_ID"), "PRODUCT_ID": l.get("PRODUCT_ID"), "REQUIRED_GOOD_QTY": req, "GOOD_SO_FAR": base, "DUE_AT": due,
            "DUE_LOCAL": to_local(due).strftime("%a %d %b %H:%M") if due else None, "BUFFER_MIN": buffer_min, "BUFFER_DEADLINE_AT": cls.get("buffer_deadline"),
            "FORECAST_FINISH_AT": p50_fin, "FORECAST_FINISH_RANGE": [min(known), max(known)] if known else None, "FORECAST_GOOD_BY_DUE": good_by_due,
            "GOOD_BY_DUE_RANGE": [min(by_due), max(by_due)], "SHORTFALL": max(0, req - good_by_due) if due else None, "BAND": cls["band"], "BAND_REASON": cls.get("reason"),
            "ACTUAL_RESULT": cls.get("actual_result"), "CUTOFF_ELAPSED": bool(cls.get("cutoff_elapsed")), "SLACK_MIN": round(minutes(p50_fin, due), 1) if (p50_fin and due) else None,
            "ACTIVE_UNITS": len(active), "PLANNED_UNITS": planned, "HELD_WITHOUT_DISPOSITION": held_unknown,
            "LIMITING_CONSTRAINTS": [{"constraint": k.split("@")[0], "at": k.split("@")[1], "unit_minutes": round(v)} for k, v in top],
            "BASIS": ("STANDARD-BASED (fresh factory, no history): routing labour standards, crew rules, shifts and breaks; no failure rate or efficiency history assumed; "
                      "planned batches assumed released at their planned time; cutoff = tank route complete (DUE_AT); buffer %d min" % buffer_min) if m.no_history else
                     ("Route DES (5-min, %d seeded replications; replication 0 assumes no new gate failures); cutoff = tank route complete (DUE_AT); buffer %d min" % (len(sims), buffer_min)),
            "FORECAST_KIND": "STANDARD_BASED" if m.no_history else "HISTORY_CALIBRATED",
        })
    lines_out.sort(key=lambda x: (x["DUE_AT"] or dt.datetime.max))
    s0 = sims[_median_index(sims)]
    wc_out = {}
    for wc in _core_wcs():
        waits = defaultdict(float)
        for s in sims:
            for k, v in s.wait.get(wc, {}).items():
                waits[k] += v / len(sims)
        lim = max(waits.items(), key=lambda kv: kv[1])[0] if waits else None
        status = "STARVATION_PREDICTED" if s0.no_work_at.get(wc) and minutes(m.now, s0.no_work_at[wc]) < 480 else ("CONSTRAINED" if lim in ("QUALIFIED_LABOUR", "STATIONS_BUSY", "EQUIPMENT_DOWN", "MATERIAL") else "OK")
        wc_out[wc] = {"STATUS": status, "LIMITING_CONSTRAINT": lim, "WAIT_UNIT_MIN": {k: round(v) for k, v in waits.items()}, "PREDICTED_NO_WORK_AT": s0.no_work_at.get(wc),
                      "NEXT_ARRIVAL_AT": s0.next_arrival.get(wc), "PREDICTED_STARVED_MIN": round(s0.starved.get(wc, 0)), "PREDICTED_BUSY_LABOR_MIN": round(s0.busy_min.get(wc, 0))}
    wc_out["INSPECTION"] = {"WAIT_UNIT_MIN": {k: round(v) for k, v in s0.wait.get("INSPECTION", {}).items()}}
    ops = {}
    for inst, at in s0.op_finish.items():
        ops[inst] = at
    return {"lines": lines_out, "work_centers": wc_out, "operations": ops, "notes": sorted(set(sum((s.notes for s in sims[:1]), []))), "horizon_end": m.horizon_end}


def _median_index(sims):
    order = sorted(range(len(sims)), key=lambda i: sum(len(v) for v in sims[i].good.values()))
    return order[(len(order) - 1) // 2]
