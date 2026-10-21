"""Background plant agents for interactive sessions.

Each simulated minute, agents look at the session's current operational state and propose the commands a real crew,
dispatcher, inspector, quality supervisor, material handler and maintenance technician would issue. Every decision is
sent to the Express internal command endpoint and executed by the same validated domain transitions as human commands.

Agents never act for a worker controlled by a human tester (CONTROL.MODE HUMAN with a live lease, HUMAN_PAUSED, HUMAN_ONLY),
never finish an operation on which a human-controlled crew member holds an active task, and never decide escalated or
unclassified quality cases (those stay on hold for people). Engine-owned derived fields (labour progress, roster pointer,
breaks taken) are written directly as projections.
"""
import datetime as dt
import hashlib
from collections import defaultdict

from .timeutil import local_to_utc, minutes, utcnow

MIN = dt.timedelta(minutes=1)
ACTIVE_TASK = ("ASSIGNED", "ACCEPTED", "WORKING", "PAUSED")
TERMINAL = ("ROUTE_COMPLETE", "SCRAPPED")
HOLD_STATES = ("FAILED_INSPECTION", "QUALITY_HOLD", "PENDING_REVIEW", "INCOMPLETE_INSPECTION_HOLD")
RESUMABLE = ("PLANNED_BREAK", "UNPLANNED_BREAK_PERSONAL", "EQUIPMENT_DOWN", "MATERIAL_SHORTAGE", "WAITING_FOR_INSTRUCTION", "HELP_REQUESTED", "OTHER")
INSPECT_STATES = ("WORK_COMPLETED_AWAITING_INSPECTION", "REWORK_COMPLETE_AWAITING_REINSPECTION", "INCOMPLETE_INSPECTION_HOLD")


def rng(*keys):
    h = hashlib.blake2b("|".join(str(k) for k in keys).encode(), digest_size=8).digest()
    return int.from_bytes(h, "big") / 2 ** 64


def is_agent(w, wall=None, session=None):
    # fresh factory: real people are never agents (whatever a lease says); in Simulated Test only designated simulated workers are
    if session is not None and session.get("FACTORY_SESSION"):
        return bool(session.get("OPERATING_MODE") == "SIMULATED_TEST" and w.get("SIMULATED_WORKER"))
    c = w.get("CONTROL") or {"MODE": "AGENT"}
    m = c.get("MODE", "AGENT")
    if m == "AGENT":
        return True
    if m == "HUMAN":
        exp = c.get("LEASE_EXPIRES_AT")
        return bool(exp and exp < (wall or utcnow()))
    return False


class Snapshot:
    """the session's operational state loaded once per simulated step"""

    def __init__(self, db, sid):
        q = {"SESSION_ID": sid}
        self.workers = {w["WORKER_ID"]: w for w in db.sim_workers.find(q)}
        self.tasks = list(db.sim_tasks.find(dict(q, STATUS={"$in": list(ACTIVE_TASK)})))
        self.ops = {o["OPERATION_INSTANCE_ID"]: o for o in db.sim_operations.find(dict(q, STATE={"$in": ["CREATED", "WORKING", "PAUSED", "BELOW_MIN_CREW", "CURING"]}))}
        self.units = {u["UNIT_ID"]: u for u in db.sim_units.find(dict(q, STATE={"$nin": list(TERMINAL)}))}
        self.drafts = list(db.sim_inspections.find(dict(q, STATUS="DRAFT")))
        self.holds = list(db.sim_holds.find(dict(q, RESOLUTION="OPEN")))
        self.equipment = {e["EQUIPMENT_ID"]: e for e in db.sim_equipment.find(q)}
        self.materials = {m["MATERIAL_ID"]: m for m in db.sim_materials.find(q)}
        self.requests = list(db.sim_material_requests.find(dict(q, STATUS={"$in": ["OPEN", "PARTIALLY_DELIVERED"]})))
        self.releases = list(db.sim_plan_releases.find(dict(q, RELEASED={"$ne": True})))
        self.tasks_by_worker = defaultdict(list)
        self.tasks_by_op = defaultdict(list)
        for t in self.tasks:
            self.tasks_by_worker[t["WORKER_ID"]].append(t)
            self.tasks_by_op[t["OPERATION_INSTANCE_ID"]].append(t)


class PlantAgents:
    def __init__(self, db, cat, session, settings, rosters):
        self.db, self.cat, self.s, self.settings = db, cat, session, settings
        self.sid = session["SESSION_ID"]
        self.seed = session.get("SEED", 42)
        self.cfg = settings.json("config/simulation.json")["agent"]
        self.fail_rates = (session.get("AGENT_SETTINGS") or {}).get("FAIL_RATES") or {}
        self.rosters = rosters            # worker_id -> sorted roster rows (shift_roster of the source run + admin rosters)
        self._break_windows = {}

    # ------------------------------------------------------------------ helpers
    def agent(self, w, wall=None):
        return is_agent(w, wall, session=self.s)

    def cmd(self, out, type_, payload, at, actor=None, system=False, ref=None):
        out.append({"type": type_, "payload": payload, "at": at, "actorWorkerId": actor, "system": system, "ref": ref,
                    "idempotencyKey": "agt-%s-%s-%s-%s" % (self.sid, type_, ref or payload.get("taskId") or payload.get("unitId") or payload.get("workerId") or "", at.strftime("%Y%m%d%H%M%S")),
                    "stopOnServerError": False})

    def wc_of(self, w):
        return w.get("TEMP_WORK_CENTER_ID") or w.get("CURRENT_WORK_CENTER_ID") or w.get("PLANNED_WORK_CENTER_ID") or w.get("HOME_WORK_CENTER_ID")

    def break_windows(self, shift_id, resource):
        key = (shift_id, resource)
        if key not in self._break_windows:
            sh = self.cat.shifts.get(shift_id)
            out = []
            if sh:
                d = sh["SHIFT_DATE"].strftime("%Y-%m-%d")
                for c in self.cat.calendar:
                    if c.get("SHIFT_ID") == shift_id and c.get("RESOURCE_ID") == resource and c.get("INTERVAL_TYPE") == "PLANNED_BREAK":
                        a, b = local_to_utc(d, c["START_AT_LOCAL"]), local_to_utc(d, c["END_AT_LOCAL"])
                        if b <= a:
                            b += dt.timedelta(days=1)
                        if a < local_to_utc(d, sh["START_AT_LOCAL"]):
                            a += dt.timedelta(days=1); b += dt.timedelta(days=1)
                        out.append((c["INTERVAL_ID"], a, b))
            self._break_windows[key] = out
        return self._break_windows[key]

    def qualified(self, wid, skill, at):
        return self.cat.qualified(wid, skill, at)

    def free_agents(self, snap, busy, at):
        out = []
        for wid, w in snap.workers.items():
            if wid in busy or not self.agent(w) or w.get("ATTENDANCE_STATE") != "CLOCKED_IN":
                continue
            if w.get("ACTIVITY_STATE") not in ("AVAILABLE", "WAITING", "PAUSED", "INDIRECT"):
                continue
            if any(t["STATUS"] == "WORKING" for t in snap.tasks_by_worker.get(wid, [])):
                continue
            out.append(w)
        return out

    def human_on_op(self, snap, op_id):
        for t in snap.tasks_by_op.get(op_id, []):
            w = snap.workers.get(t["WORKER_ID"])
            if w and not self.agent(w) and t["STATUS"] in ACTIVE_TASK:
                return True
        return False

    def station_busy(self, snap, ws_id, except_unit=None):
        for u in snap.units.values():
            if u["UNIT_ID"] != except_unit and u.get("CURRENT_WORKSTATION_ID") == ws_id and u["STATE"] not in ("QUEUED", "IN_TRANSFER", "RETURN_REQUESTED", "IN_RETURN_TRANSFER", "CURING"):
                return True
        return False

    # ------------------------------------------------------------------ one simulated step
    def step(self, t):
        snap = Snapshot(self.db, self.sid)
        out = []
        busy = set()
        if self.s.get("FACTORY_SESSION"):
            # fresh factory. MANUAL_TEAM_TEST: nobody is simulated - only unattended timed steps advance by rule (cure complete, transfer
            # arrival); progress estimates and the roster pointer are projections. No batch is released and nothing is repaired by itself.
            self.system_events(snap, t, out)
            self.roster_pointer(snap, t)
            self.progress(snap, t, out, busy)
            if self.s.get("OPERATING_MODE") != "SIMULATED_TEST":
                return out
            # SIMULATED_TEST: the designated simulated workers (and only they) behave like the demo agents
            self.attendance(snap, t, out, busy)
            self.breaks(snap, t, out, busy)
            self.inspections(snap, t, out, busy)
            self.quality(snap, t, out)
            self.resume_and_join(snap, t, out, busy)
            self.dispatch(snap, t, out, busy)
            return out
        self.system_events(snap, t, out)
        self.attendance(snap, t, out, busy)
        self.breaks(snap, t, out, busy)
        self.progress(snap, t, out, busy)
        self.inspections(snap, t, out, busy)
        self.quality(snap, t, out)
        self.resume_and_join(snap, t, out, busy)
        self.dispatch(snap, t, out, busy)
        self.materials(snap, t, out)
        return out

    # ------------------------------------------------------------------ system time events
    def system_events(self, snap, t, out):
        for u in snap.units.values():
            if u["STATE"] == "IN_TRANSFER" and u.get("ARRIVE_AT") and u["ARRIVE_AT"] <= t:
                self.cmd(out, "UNIT_ARRIVE", {"unitId": u["UNIT_ID"]}, max(u["ARRIVE_AT"], t - MIN), system=True, ref=u["UNIT_ID"] + "-arr-" + str(u.get("VERSION")))
            if u["STATE"] == "IN_RETURN_TRANSFER" and u.get("ARRIVE_AT") and u["ARRIVE_AT"] <= t:
                self.cmd(out, "RETURN_ARRIVE", {"unitId": u["UNIT_ID"]}, max(u["ARRIVE_AT"], t - MIN), system=True, ref=u["UNIT_ID"] + "-rarr")
        for o in snap.ops.values():
            if o.get("OPERATION_KIND") == "PROCESS" and o["STATE"] == "CURING" and o.get("STARTED_AT") and o.get("STANDARD_ELAPSED_MIN") is not None:
                if o["STARTED_AT"] + dt.timedelta(minutes=float(o["STANDARD_ELAPSED_MIN"])) <= t:
                    self.cmd(out, "PROCESS_COMPLETE", {"operationInstanceId": o["OPERATION_INSTANCE_ID"]}, t, system=True, ref=o["OPERATION_INSTANCE_ID"])
        factory = bool(self.s.get("FACTORY_SESSION"))
        for r in ([] if factory else snap.releases):           # a fresh factory releases batches only when a person does
            if r.get("PLANNED_RELEASE_AT") and r["PLANNED_RELEASE_AT"] <= t:
                self.cmd(out, "BATCH_RELEASE", {"batchId": r["BATCH_ID"]}, t, system=True, ref=r["BATCH_ID"])
        for e in snap.equipment.values():
            if e.get("STATUS") == "DOWN":
                est = e.get("ESTIMATED_RECOVERY_AT")
                if not est and e.get("SINCE"):
                    mttr = float((self.cat.equipment.get(e["EQUIPMENT_ID"]) or {}).get("MTTR_MIN") or 60)
                    est = e["SINCE"] + dt.timedelta(minutes=mttr)
                if est and est <= t:
                    tech = self.pick_role(snap, "MAINTENANCE_TECHNICIAN")
                    if factory and tech is None:
                        continue                                # a real repair is recorded by a person (no self-repair in a factory)
                    self.cmd(out, "EQUIPMENT_REPAIRED", {"equipmentId": e["EQUIPMENT_ID"]}, t, actor=tech, system=tech is None, ref=e["EQUIPMENT_ID"] + "-" + str(e.get("VERSION")))
        for w in snap.workers.values():
            if w.get("ACTIVITY_STATE") == "TRANSFER" and self.agent(w) and w.get("TRANSFER_ARRIVE_AT") and w["TRANSFER_ARRIVE_AT"] <= t:
                self.cmd(out, "TRANSFER_ARRIVE", {"workerId": w["WORKER_ID"]}, t, actor=w["WORKER_ID"], ref=w["WORKER_ID"] + "-" + str(w.get("TRANSFER_ID")))

    def pick_role(self, snap, role):
        cands = sorted([w for w in snap.workers.values() if w.get("WORKER_ROLE") == role and w.get("ATTENDANCE_STATE") == "CLOCKED_IN" and self.agent(w)], key=lambda w: w["WORKER_ID"])
        return cands[0]["WORKER_ID"] if cands else None

    # ------------------------------------------------------------------ attendance (shift start / end) for agent-controlled people
    def attendance(self, snap, t, out, busy):
        fork = self.s["FORK_AT"]
        for wid, w in snap.workers.items():
            if not self.agent(w):
                continue
            att = w.get("ATTENDANCE_STATE")
            end = w.get("PLANNED_END_AT")
            if att == "CLOCKED_IN":
                limit = max([x for x in (end, w.get("OVERTIME_UNTIL")) if x] or [None]) if end else None
                if limit and t >= limit:
                    self.cmd(out, "CLOCK_OUT", {"workerId": wid, "pauseActiveTasks": True}, t, actor=wid, ref=wid + "-" + str(w.get("SHIFT_ID")))
                    busy.add(wid)
                continue
            if att == "ABSENT":
                continue
            # roster pointer: current or next scheduled shift
            row = self.roster_row(wid, t)
            if row is None:
                continue
            if row["SHIFT_ID"] != w.get("SHIFT_ID") or att in ("CLOCKED_OUT", "OFF_SHIFT") and row["PLANNED_START_AT"] > (w.get("PLANNED_START_AT") or dt.datetime.min):
                if att == "CLOCKED_OUT" and w.get("PLANNED_END_AT") and t < w["PLANNED_END_AT"]:
                    continue        # left early; stays out for this shift
                self.db.sim_workers.update_one({"SESSION_ID": self.sid, "WORKER_ID": wid}, {"$set": {
                    "SHIFT_ID": row["SHIFT_ID"], "ROSTER_STATUS": row.get("ROSTER_STATUS", "SCHEDULED"), "PLANNED_WORK_CENTER_ID": row.get("PLANNED_WORK_CENTER_ID"),
                    "PLANNED_START_AT": row["PLANNED_START_AT"], "PLANNED_END_AT": row["PLANNED_END_AT"], "ATTENDANCE_STATE": "NOT_CLOCKED_IN" if row["PLANNED_START_AT"] <= t + dt.timedelta(hours=1) else "OFF_SHIFT",
                    "ACTIVITY_STATE": "NOT_STARTED" if row["PLANNED_START_AT"] <= t + dt.timedelta(hours=1) else "OFF_SHIFT", "TEMP_WORK_CENTER_ID": None, "BREAKS_TAKEN": [], "FIRST_CLOCK_IN_AT": None, "OVERTIME_UNTIL": None,
                    "ROSTER_SOURCE": row.get("ORIGIN") or "SHIFT_ROSTER"}})
                w.update(SHIFT_ID=row["SHIFT_ID"], PLANNED_START_AT=row["PLANNED_START_AT"], PLANNED_END_AT=row["PLANNED_END_AT"], ATTENDANCE_STATE="NOT_CLOCKED_IN")
                att = "NOT_CLOCKED_IN"
            if att in ("NOT_CLOCKED_IN", "NOT_RECORDED", "OFF_SHIFT") and row.get("ROSTER_STATUS") == "SCHEDULED":
                start = row["PLANNED_START_AT"]
                if start < fork - dt.timedelta(minutes=30):
                    continue        # scheduled but attendance not confirmed at the fork: agents do not invent an arrival
                jitter = int(rng(self.seed, wid, row["SHIFT_ID"], "in") * float(self.cfg.get("clock_in_spread_min", 12)))
                arrive = start - dt.timedelta(minutes=8) + dt.timedelta(minutes=jitter)
                if t >= arrive and t < row["PLANNED_END_AT"]:
                    self.cmd(out, "CLOCK_IN", {"workerId": wid, "deviceId": "BADGE-READER-MAIN"}, max(arrive, t - MIN), actor=wid, ref=wid + "-" + row["SHIFT_ID"])
                    busy.add(wid)

    def roster_pointer(self, snap, t):
        """fresh factory: keep each person's planned shift fields current (projection only - never clocks anyone in or out)"""
        for wid, w in snap.workers.items():
            if self.agent(w):
                continue
            att = w.get("ATTENDANCE_STATE")
            if att in ("CLOCKED_IN", "ABSENT"):
                continue
            row = self.roster_row(wid, t)
            if row is None:
                if w.get("SHIFT_ID") and w.get("PLANNED_END_AT") and w["PLANNED_END_AT"] <= t and att != "OFF_SHIFT":
                    self.db.sim_workers.update_one({"SESSION_ID": self.sid, "WORKER_ID": wid, "ATTENDANCE_STATE": {"$ne": "CLOCKED_IN"}},
                                                   {"$set": {"ATTENDANCE_STATE": "OFF_SHIFT", "ACTIVITY_STATE": "OFF_SHIFT", "ROSTER_STATUS": "NOT_ROSTERED", "STATE_SINCE": t}})
                continue
            if att == "CLOCKED_OUT" and w.get("PLANNED_END_AT") and t < w["PLANNED_END_AT"] and row["SHIFT_ID"] == w.get("SHIFT_ID"):
                continue            # left before the shift ended; stays out for this shift
            soon = row["PLANNED_START_AT"] <= t + dt.timedelta(hours=1)
            want_att = "NOT_CLOCKED_IN" if soon else "OFF_SHIFT"
            if row["SHIFT_ID"] == w.get("SHIFT_ID") and att == want_att:
                continue
            nxt = [r for r in (self.rosters.get(wid) or []) if r["PLANNED_START_AT"] > row["PLANNED_START_AT"]]
            self.db.sim_workers.update_one({"SESSION_ID": self.sid, "WORKER_ID": wid, "ATTENDANCE_STATE": {"$ne": "CLOCKED_IN"}}, {"$set": {
                "SHIFT_ID": row["SHIFT_ID"], "ROSTER_STATUS": row.get("ROSTER_STATUS", "SCHEDULED"), "PLANNED_WORK_CENTER_ID": row.get("PLANNED_WORK_CENTER_ID"),
                "PLANNED_START_AT": row["PLANNED_START_AT"], "PLANNED_END_AT": row["PLANNED_END_AT"], "ATTENDANCE_STATE": want_att, "ACTIVITY_STATE": "NOT_STARTED" if soon else "OFF_SHIFT",
                "NEXT_SHIFT_ID": nxt[0]["SHIFT_ID"] if nxt else None, "NEXT_PLANNED_START_AT": nxt[0]["PLANNED_START_AT"] if nxt else None, "NEXT_PLANNED_END_AT": nxt[0]["PLANNED_END_AT"] if nxt else None,
                "ROSTER_SOURCE": row.get("ORIGIN") or "APP_ROSTER", "STATE_SINCE": t}})

    def roster_row(self, wid, t):
        rows = self.rosters.get(wid) or []
        cur = [r for r in rows if r["PLANNED_START_AT"] - dt.timedelta(hours=1) <= t < r["PLANNED_END_AT"]]
        if cur:
            return cur[0]
        nxt = [r for r in rows if r["PLANNED_START_AT"] > t]
        return nxt[0] if nxt and nxt[0]["PLANNED_START_AT"] - t < dt.timedelta(hours=12) else None

    # ------------------------------------------------------------------ planned breaks
    def breaks(self, snap, t, out, busy):
        for wid, w in snap.workers.items():
            if wid in busy or not self.agent(w) or w.get("ATTENDANCE_STATE") != "CLOCKED_IN" or not w.get("SHIFT_ID"):
                continue
            role = w.get("WORKER_ROLE")
            resource = self.wc_of(w) if role == "PRODUCTION_OPERATOR" else "SUPPORT"
            taken = set(w.get("BREAKS_TAKEN") or [])
            for iid, a, b in self.break_windows(w["SHIFT_ID"], resource) or self.break_windows(w["SHIFT_ID"], w.get("HOME_WORK_CENTER_ID") or "SUPPORT"):
                if w.get("ACTIVITY_STATE") == "BREAK" and (w.get("REASON_CODE") == "PLANNED_BREAK") and t >= b:
                    self.cmd(out, "BREAK_END", {"workerId": wid, "resume": True}, t, actor=wid, ref=wid + "-" + iid + "-end")
                    busy.add(wid)
                    break
                if a <= t < b and iid not in taken:
                    if w.get("ACTIVITY_STATE") == "TRANSFER":
                        break                       # in transit: the break is taken after arrival (still inside the window)
                    self.db.sim_workers.update_one({"SESSION_ID": self.sid, "WORKER_ID": wid}, {"$addToSet": {"BREAKS_TAKEN": iid}})
                    if w.get("ACTIVITY_STATE") != "BREAK":
                        self.cmd(out, "BREAK_START", {"workerId": wid, "planned": True}, t, actor=wid, ref=wid + "-" + iid)
                        busy.add(wid)
                    break

    # ------------------------------------------------------------------ labour progress, milestones, finishing
    def progress(self, snap, t, out, busy):
        # labour progress accrues only while WORKING: other operations keep their progress clock at t
        self.db.sim_operations.update_many({"SESSION_ID": self.sid, "STATE": {"$ne": "WORKING"}, "OPERATION_KIND": "LABOR"}, {"$set": {"PROGRESS_UPDATED_AT": t}})
        fork = self.s["FORK_AT"]
        for oid, o in snap.ops.items():
            if o.get("OPERATION_KIND") != "LABOR" or o["STATE"] != "WORKING":
                continue
            u = snap.units.get(o["UNIT_ID"])
            if not u:
                continue
            crew = [tk for tk in snap.tasks_by_op.get(oid, []) if tk["STATUS"] == "WORKING"]
            n = len(crew)
            rework = str(o.get("INSTANCE_TYPE", "")).endswith("REWORK")
            if rework:
                elapsed = float(o.get("REWORK_STANDARD_LABOR_MIN") or self.cfg.get("default_rework_labor_min", 60)) / max(1, n)
            else:
                elapsed = self.cat.elapsed_for_crew(o.get("PRODUCT_ID") or u.get("PRODUCT_ID"), o["OPERATION_ID"], n)
            if not elapsed:
                continue
            last = o.get("PROGRESS_UPDATED_AT") or (fork if o.get("ORIGIN") == "INHERITED_AT_FORK" else (o.get("STARTED_AT") or t))
            last = max(last, fork)
            gain = max(0.0, minutes(last, t)) / elapsed
            prog = min(1.0, float(o.get("PROGRESS_FRACTION") or 0) + gain)
            self.db.sim_operations.update_one({"SESSION_ID": self.sid, "OPERATION_INSTANCE_ID": oid}, {"$set": {"PROGRESS_FRACTION": round(prog, 5), "PROGRESS_UPDATED_AT": t, "PROGRESS_BASIS": "ENGINE_LABOR_PROGRESS (elapsed / crew standard)"}})
            agents_on = [tk for tk in crew if self.agent(snap.workers.get(tk["WORKER_ID"], {}))]
            if not agents_on:
                continue
            actor = sorted(agents_on, key=lambda tk: tk["WORKER_ID"])[0]["WORKER_ID"]
            ms = self.cat.milestones_for(o["OPERATION_ID"], "REWORK" if rework else "STANDARD")
            ms = [m for m in ms if m.get("ATTENDED") != "N"]
            done = set(o.get("MILESTONES_DONE") or [])
            for m in ms[:-1]:
                if m["MILESTONE_ID"] not in done and prog >= float(m.get("PROGRESS_THRESHOLD") or 1):
                    self.cmd(out, "MILESTONE_COMPLETE", {"operationInstanceId": oid, "milestoneId": m["MILESTONE_ID"]}, t, actor=actor, ref=oid + "-" + m["MILESTONE_ID"])
                    done.add(m["MILESTONE_ID"])
            if prog >= 0.9999 and not self.human_on_op(snap, oid) and all(m["MILESTONE_ID"] in done for m in ms[:-1]):
                tk = [x for x in agents_on if x["WORKER_ID"] == actor][0]
                self.cmd(out, "TASK_FINISH", {"taskId": tk["TASK_ID"]}, t, actor=actor, ref=tk["TASK_ID"])
                for x in crew:
                    busy.add(x["WORKER_ID"])

    # ------------------------------------------------------------------ gate inspections (independent) by agent inspectors
    def inspections(self, snap, t, out, busy):
        # submit drafts whose inspection time has elapsed
        for d in snap.drafts:
            if d.get("INSPECTION_KIND") != "INDEPENDENT":
                continue
            w = snap.workers.get(d.get("INSPECTOR_ID"))
            if not w or not self.agent(w) or w.get("ATTENDANCE_STATE") != "CLOCKED_IN" or w.get("ACTIVITY_STATE") == "BREAK":
                continue
            u = snap.units.get(d["UNIT_ID"])
            if not u:
                continue
            gdef = self.cat.op(u["PRODUCT_ID"], d["GATE_OPERATION_ID"]) or {}
            dur = float(gdef.get("STANDARD_ELAPSED_MIN") or 12) * (0.85 + 0.3 * rng(self.seed, d["INSPECTION_ID"], "dur"))
            if d["STARTED_AT"] + dt.timedelta(minutes=dur) <= t:
                answers, failed = self.answers(u, d)
                self.cmd(out, "INSPECTION_SUBMIT", {"inspectionId": d["INSPECTION_ID"], "answers": answers, "release": True, "comment": "Agent inspection" + (" - out-of-limit reading recorded" if failed else "")},
                         t, actor=d["INSPECTOR_ID"], ref=d["INSPECTION_ID"])
                busy.add(d["INSPECTOR_ID"])
        # release passed tanks inspected by agents (or inherited) that are still waiting
        for u in snap.units.values():
            if u["STATE"] == "PASS_PENDING_RELEASE" and u.get("STATE_SINCE") and u["STATE_SINCE"] + dt.timedelta(minutes=3) <= t:
                last = self.db.sim_inspections.find_one({"SESSION_ID": self.sid, "INSPECTION_ID": u.get("LAST_INSPECTION_ID")})
                insp = snap.workers.get((last or {}).get("INSPECTOR_ID"))
                if last is None or (insp and self.agent(insp)) or (last or {}).get("ORIGIN") == "INHERITED_AT_FORK":
                    actor = (last or {}).get("INSPECTOR_ID") if insp and self.agent(insp) else self.pick_role(snap, "QUALITY_INSPECTOR")
                    if actor:
                        self.cmd(out, "UNIT_RELEASE", {"unitId": u["UNIT_ID"]}, t, actor=actor, ref=u["UNIT_ID"] + "-" + str(u.get("LAST_INSPECTION_ID")))
        # start new inspections
        drafting = {d["UNIT_ID"] for d in snap.drafts if d.get("INSPECTION_KIND") == "INDEPENDENT"}
        waiting = sorted([u for u in snap.units.values() if u["STATE"] in INSPECT_STATES and u["UNIT_ID"] not in drafting],
                         key=lambda u: u.get("AWAITING_INSPECTION_SINCE") or u.get("STATE_SINCE") or t)
        if not waiting:
            return
        inspectors = [w for w in self.free_agents(snap, busy, t) if w.get("WORKER_ROLE") == "QUALITY_INSPECTOR"]
        inspectors = [w for w in inspectors if w["WORKER_ID"] not in {d.get("INSPECTOR_ID") for d in snap.drafts}]
        delay = float(self.cfg.get("inspection_start_delay_min", 2))
        for u in waiting:
            since = u.get("AWAITING_INSPECTION_SINCE") or u.get("STATE_SINCE") or t
            if since + dt.timedelta(minutes=delay) > t or not inspectors:
                continue
            crew_ids = {tk["WORKER_ID"] for tk in self.db.sim_tasks.find({"SESSION_ID": self.sid, "OPERATION_INSTANCE_ID": u.get("LAST_LABOR_OPERATION_INSTANCE_ID")}, {"WORKER_ID": 1})}
            gate = (self.cat.op(u["PRODUCT_ID"], u.get("ROUTE_STEP")) or {})
            skill = gate.get("REQUIRED_SKILL_ID") or (None if self.s.get("FACTORY_SESSION") else "SK-INSP")
            cands = [w for w in inspectors if w["WORKER_ID"] not in crew_ids and self.qualified(w["WORKER_ID"], skill, t)]
            cands.sort(key=lambda w: (0 if self.wc_of(w) == u.get("CURRENT_WORK_CENTER_ID") else 1, w["WORKER_ID"]))
            if not cands:
                continue
            w = cands[0]
            inspectors.remove(w)
            busy.add(w["WORKER_ID"])
            self.cmd(out, "INSPECTION_START", {"unitId": u["UNIT_ID"], "inspectorId": w["WORKER_ID"]}, t, actor=w["WORKER_ID"], ref=u["UNIT_ID"] + "-" + str(u.get("VERSION")))

    def answers(self, u, d):
        """readings an inspector would record on this physical tank: inside the synthetic limits unless the tank has a seeded
        (console) defect or the deterministic first-attempt failure draw selects a defect; never a pre-set result."""
        gate = d["GATE_OPERATION_ID"]
        checks = sorted([c for c in self.cat.ctq.values() if c.get("OPERATION_ID") == gate], key=lambda c: c["CHECK_ID"])
        seeded = u.get("SEEDED_DEFECT") or {}
        fail_check = None
        if seeded and seeded.get("REMAINING", 0) > 0 and seeded.get("GATE_OPERATION_ID") in (None, gate):
            fail_check = seeded.get("CHECK_ID") or next((c["CHECK_ID"] for c in checks if c.get("ANSWER_TYPE") == "NUMERIC"), None)
            self.db.sim_units.update_one({"SESSION_ID": self.sid, "UNIT_ID": u["UNIT_ID"]}, {"$inc": {"SEEDED_DEFECT.REMAINING": -1}})
        elif (d.get("ATTEMPT_NO") or 1) == 1 and rng(self.seed, u["UNIT_ID"], gate, "fail") < float(self.fail_rates.get(gate, 0.04)):
            nums = [c["CHECK_ID"] for c in checks if c.get("ANSWER_TYPE") == "NUMERIC"]
            fail_check = nums[int(rng(self.seed, u["UNIT_ID"], gate, "which") * len(nums))] if nums else None
        ans = {}
        for c in checks:
            cid = c["CHECK_ID"]
            if c.get("ANSWER_TYPE") == "YES_NO":
                good = "Yes" if c.get("FAILURE_ANSWER") == "No" else "No"
                ans[cid] = {"answer": (c.get("FAILURE_ANSWER") if cid == fail_check else good)}
                continue
            vals = {}
            for sp in [s for s in self.cat.specs if s["CHECK_ID"] == cid and s["PRODUCT_ID"] == u["PRODUCT_ID"]]:
                lo, hi = sp.get("LOWER_LIMIT"), sp.get("UPPER_LIMIT")
                nom = sp.get("NOMINAL_VALUE") if sp.get("NOMINAL_VALUE") is not None else ((lo + hi) / 2 if lo is not None and hi is not None else 0)
                span = (hi - lo) if (lo is not None and hi is not None) else abs(nom) * 0.02 or 1
                readings = []
                for k in range(int(sp.get("REQUIRED_READING_COUNT") or 1)):
                    v = nom + (rng(self.seed, d["INSPECTION_ID"], sp["SPEC_ID"], k) - 0.5) * span * 0.6
                    readings.append(round(v, 2))
                if cid == fail_check and readings:
                    readings[0] = round((hi if hi is not None else nom) + span * 0.35, 2)
                    fail_check = "__done__"
                vals[sp["MEASUREMENT_POSITION"]] = readings
            ans[cid] = {"values": vals}
        return ans, fail_check == "__done__" or (fail_check is not None and fail_check != "__done__")

    # ------------------------------------------------------------------ quality decisions per disposition matrix (explicit entries only)
    def quality(self, snap, t, out):
        sup = self.pick_role(snap, "QUALITY_SUPERVISOR")
        delay = float(self.cfg.get("disposition_decision_delay_min", 12))
        policy = self.s.get("DISPOSITION_POLICY_ID")
        if sup:
            for h in snap.holds:
                if h.get("HOLD_STARTED_AT") and h["HOLD_STARTED_AT"] + dt.timedelta(minutes=delay) > t:
                    continue
                u = snap.units.get(h["UNIT_ID"])
                if not u or u["STATE"] != "QUALITY_HOLD":
                    continue
                defects = list(self.db.sim_defects.find({"SESSION_ID": self.sid, "DEFECT_ID": {"$in": h.get("DEFECT_IDS") or []}}))
                code = defects[0]["DEFECT_CODE"] if defects else "UNCLASSIFIED"
                if defects and str(defects[0].get("SEVERITY") or "").upper() == "NON_REPAIRABLE":
                    # the inspector recorded a non-repairable severity: the quality supervisor scraps with a stated reason
                    self.cmd(out, "DISPOSITION_DECIDE", {"holdId": h["HOLD_ID"], "decision": "SCRAP", "reasonCode": "NON_REPAIRABLE_SEVERITY", "note": "Severity recorded as non-repairable"}, t, actor=sup, ref=h["HOLD_ID"])
                    continue
                rule = self.cat.disposition(policy, h.get("DETECTION_POINT") or h.get("GATE_OPERATION_ID"), code)
                if not rule or rule.get("DISPOSITION") not in ("REPAIRABLE_RETURN", "SCRAP") or rule.get("DEFECT_CODE") != code:
                    continue        # unknown cases stay on hold for a named human approver
                fails = self.db.sim_inspections.count_documents({"SESSION_ID": self.sid, "UNIT_ID": u["UNIT_ID"], "GATE_OPERATION_ID": h.get("GATE_OPERATION_ID") or "__", "RESULT": "FAIL", "INSPECTION_KIND": "INDEPENDENT"})
                esc = int(rule.get("ESCALATE_AFTER_FAILED_REINSPECTIONS") or 2)
                if fails >= esc:
                    continue        # escalated: a quality supervisor (human) decides; never a forced pass
                payload = {"holdId": h["HOLD_ID"], "decision": "REWORK" if rule["DISPOSITION"] == "REPAIRABLE_RETURN" else "SCRAP", "reasonCode": "PER_DISPOSITION_MATRIX"}
                if payload["decision"] == "REWORK":
                    alt = self.alternate_if_needed(snap, h, u)
                    if alt:
                        payload.update(alternateWorkstationId=alt, alternateReason="ORIGIN_EQUIPMENT_DOWN")
                self.cmd(out, "DISPOSITION_DECIDE", payload, t, actor=sup, ref=h["HOLD_ID"])
        mh = self.pick_role(snap, "MATERIAL_HANDLER")
        for u in snap.units.values():
            if u["STATE"] == "RETURN_REQUESTED" and u.get("STATE_SINCE") and u["STATE_SINCE"] + dt.timedelta(minutes=4) <= t and mh:
                self.cmd(out, "RETURN_DISPATCH", {"unitId": u["UNIT_ID"]}, t, actor=mh, ref=u["UNIT_ID"] + "-rd")

    def alternate_if_needed(self, snap, h, u):
        origin = self.db.sim_operations.find_one({"SESSION_ID": self.sid, "OPERATION_INSTANCE_ID": h.get("ORIGIN_OPERATION_INSTANCE_ID") or u.get("LAST_LABOR_OPERATION_INSTANCE_ID")})
        if not origin or not origin.get("EQUIPMENT_ID"):
            return None
        eq = snap.equipment.get(origin["EQUIPMENT_ID"])
        if not eq or eq.get("STATUS") != "DOWN":
            return None
        for s in self.cat.stations_of(origin["WORK_CENTER_ID"]):
            e2 = snap.equipment.get(s.get("EQUIPMENT_ID"))
            if s["WORKSTATION_ID"] != origin["WORKSTATION_ID"] and (not e2 or e2.get("STATUS") != "DOWN") and not self.station_busy(snap, s["WORKSTATION_ID"]):
                return s["WORKSTATION_ID"]
        return None

    # ------------------------------------------------------------------ resume own paused tasks / join under-crewed operations
    def resume_and_join(self, snap, t, out, busy):
        for w in self.free_agents(snap, busy, t):
            wid = w["WORKER_ID"]
            paused = [tk for tk in snap.tasks_by_worker.get(wid, []) if tk["STATUS"] == "PAUSED" and (tk.get("PAUSE_REASON") in RESUMABLE or tk.get("PAUSE_REASON") is None)]
            for tk in paused:
                o = snap.ops.get(tk["OPERATION_INSTANCE_ID"])
                u = snap.units.get(tk["UNIT_ID"])
                if not o or not u or u["STATE"] in HOLD_STATES or o["STATE"] in ("WORK_COMPLETED", "CANCELLED"):
                    continue
                if o.get("EQUIPMENT_ID") and (snap.equipment.get(o["EQUIPMENT_ID"]) or {}).get("STATUS") == "DOWN":
                    continue
                if o.get("BLOCKED_REASON") == "MATERIAL_SHORTAGE" and not self.material_ok(snap, u, o["OPERATION_ID"]):
                    continue
                self.cmd(out, "TASK_RESUME", {"taskId": tk["TASK_ID"]}, t, actor=wid, ref=tk["TASK_ID"] + "-" + str(tk.get("VERSION")))
                busy.add(wid)
                break
        # join: labour operations short of standard crew whose remaining crew are not working there
        for oid, o in sorted(snap.ops.items()):
            if o.get("OPERATION_KIND") != "LABOR" or o["STATE"] not in ("CREATED", "PAUSED", "BELOW_MIN_CREW", "WORKING"):
                continue
            u = snap.units.get(o["UNIT_ID"])
            if not u or u["STATE"] in HOLD_STATES:
                continue
            if o.get("EQUIPMENT_ID") and (snap.equipment.get(o["EQUIPMENT_ID"]) or {}).get("STATUS") == "DOWN":
                continue
            active = [tk for tk in snap.tasks_by_op.get(oid, []) if tk["STATUS"] in ACTIVE_TASK]
            working = [tk for tk in active if tk["STATUS"] == "WORKING"]
            # paused crew members still on shift will resume themselves
            returning = [tk for tk in active if tk["STATUS"] == "PAUSED" and (snap.workers.get(tk["WORKER_ID"]) or {}).get("ATTENDANCE_STATE") == "CLOCKED_IN"]
            rework = str(o.get("INSTANCE_TYPE", "")).endswith("REWORK")
            target = 1 if rework else int(o.get("STD_CREW_SIZE") or o.get("MIN_CREW_SIZE") or 1)
            need = target - len(working) - len(returning)
            if need <= 0 or (o.get("MAX_CREW_SIZE") and len(active) >= int(o["MAX_CREW_SIZE"])):
                continue
            pool = [w for w in self.free_agents(snap, busy, t) if w.get("WORKER_ROLE") == "PRODUCTION_OPERATOR" and self.wc_of(w) == o.get("WORK_CENTER_ID")
                    and self.qualified(w["WORKER_ID"], o.get("REQUIRED_SKILL_ID"), t) and not any(tk["WORKER_ID"] == w["WORKER_ID"] for tk in active)]
            pool.sort(key=lambda w: w["WORKER_ID"])
            for w in pool[:need]:
                self.cmd(out, "TASK_JOIN", {"workerId": w["WORKER_ID"], "operationInstanceId": oid, "start": True}, t, actor=w["WORKER_ID"], ref=oid + "-" + w["WORKER_ID"])
                busy.add(w["WORKER_ID"])

    def material_ok(self, snap, u, op_id):
        for r in self.cat.mat_reqs:
            if r["PRODUCT_ID"] == u["PRODUCT_ID"] and r.get("CONSUMED_AT_OPERATION_ID") == op_id:
                m = snap.materials.get(r["MATERIAL_ID"]) or {}
                avail = float(m.get("ON_HAND_QTY") or 0) - float(m.get("HOLD_QTY") or 0) - float(m.get("RESERVED_QTY") or 0)
                if u.get("RESERVED_MATERIAL") == r["MATERIAL_ID"]:
                    avail += float(r.get("QTY_PER_UNIT") or 0)
                if avail < float(r.get("QTY_PER_UNIT") or 0):
                    return False
        return True

    # ------------------------------------------------------------------ dispatch new operations (DR-1.0) to free stations
    def dispatch(self, snap, t, out, busy):
        queued = [u for u in snap.units.values() if u["STATE"] in ("QUEUED", "QUEUED_FOR_REWORK", "RECEIVED_AT_REWORK_STATION")]
        queued.sort(key=lambda u: (1 if u.get("REWORK_PENDING") else (u.get("PRIORITY_CLASS") or 3), u.get("DUE_AT") or dt.datetime.max, u.get("QUEUE_ENTERED_AT") or dt.datetime.max))
        used_stations = set()
        for u in queued:
            d = self.cat.op(u["PRODUCT_ID"], u.get("ROUTE_STEP"))
            if not d or d.get("OPERATION_KIND") != "LABOR":
                continue
            wc = d["WORK_CENTER_ID"]
            rework = bool(u.get("REWORK_PENDING"))
            if not rework and not self.material_ok(snap, u, d["OPERATION_ID"]):
                continue
            stations = self.cat.stations_of(wc)
            if rework and (u["REWORK_PENDING"] or {}).get("DEST_WORKSTATION_ID"):
                stations = [s for s in stations if s["WORKSTATION_ID"] == u["REWORK_PENDING"]["DEST_WORKSTATION_ID"]]
            station = None
            for s in stations:
                if s["WORKSTATION_ID"] in used_stations or self.station_busy(snap, s["WORKSTATION_ID"], u["UNIT_ID"]):
                    continue
                e = snap.equipment.get(s.get("EQUIPMENT_ID"))
                if e and e.get("STATUS") == "DOWN":
                    continue
                if any(o.get("WORKSTATION_ID") == s["WORKSTATION_ID"] and o["STATE"] in ("CREATED", "WORKING", "PAUSED", "BELOW_MIN_CREW") for o in snap.ops.values()):
                    continue
                station = s
                break
            if not station:
                continue
            target = (2 if int(d.get("MIN_CREW_SIZE") or 1) > 1 else 1) if rework else int(d.get("STD_CREW_SIZE") or d.get("MIN_CREW_SIZE") or 1)
            minimum = 1 if rework else int(d.get("MIN_CREW_SIZE") or 1)
            pool = [w for w in self.free_agents(snap, busy, t) if w.get("WORKER_ROLE") == "PRODUCTION_OPERATOR" and self.wc_of(w) == wc and self.qualified(w["WORKER_ID"], d.get("REQUIRED_SKILL_ID"), t)
                    and not snap.tasks_by_worker.get(w["WORKER_ID"])]
            pool.sort(key=lambda w: (0 if self.cat.can_work_independently(w["WORKER_ID"], d.get("REQUIRED_SKILL_ID"), t) else 1, w["WORKER_ID"]))
            if len(pool) < minimum:
                continue
            crew = pool[:target]
            for w in crew:
                busy.add(w["WORKER_ID"])
            used_stations.add(station["WORKSTATION_ID"])
            self.cmd(out, "OPERATION_START", {"unitId": u["UNIT_ID"], "workstationId": station["WORKSTATION_ID"], "crew": [w["WORKER_ID"] for w in crew], "autoStart": True},
                     t, actor=crew[0]["WORKER_ID"], ref=u["UNIT_ID"] + "-" + str(u.get("ROUTE_STEP")) + "-" + str(u.get("VERSION")))

    # ------------------------------------------------------------------ materials: deliveries due, replenishment requests
    def materials(self, snap, t, out):
        mh = self.pick_role(snap, "MATERIAL_HANDLER")
        for r in snap.requests:
            due = r.get("PROMISED_AT") or r.get("NEED_BY_AT")
            outstanding = float(r.get("QTY") or 0) - float(r.get("DELIVERED_QTY") or 0)
            if due and due <= t and outstanding > 0:
                self.cmd(out, "MATERIAL_DELIVERY", {"materialId": r["MATERIAL_ID"], "qty": outstanding, "requestId": r["REQUEST_ID"]}, t, actor=mh, system=mh is None, ref=r["REQUEST_ID"])
        if not mh:
            return
        # replenishment continuation policy (synthetic assumption, documented in docs/assumptions): reorder when available stock
        # covers less than 75% of the average daily use known at the fork; order 1.5 days of use; 20% of deliveries are late
        use = ((self.s.get("AGENT_SETTINGS") or {}).get("BASELINES") or {}).get("MATERIAL_DAILY_USE") or {}
        open_by = {r["MATERIAL_ID"] for r in snap.requests}
        for mid, m in snap.materials.items():
            avail = float(m.get("ON_HAND_QTY") or 0) - float(m.get("HOLD_QTY") or 0) - float(m.get("RESERVED_QTY") or 0)
            daily = float(use.get(mid) or 0)
            if daily <= 0:
                if (self.cat.materials.get(mid) or {}).get("UOM") == "KIT" and avail < 2 and mid not in open_by:
                    daily = 4.0
                else:
                    continue
            if avail < daily * 0.75 and mid not in open_by:
                qty = max(1, int(round(daily * 1.5 + 0.4999)))
                late = rng(self.seed, mid, t.strftime("%Y%m%d%H"), "late") < 0.2
                self.cmd(out, "MATERIAL_REQUEST", {"materialId": mid, "qty": qty, "needByMin": 120, "promisedMin": 165 if late else 90}, t, actor=mh, ref=mid + "-" + t.strftime("%Y%m%d%H"))
