"""Always-on engine worker (Render background worker; no HTTP listener).

Each tick (ENGINE_TICK_SECONDS):
  1. heartbeat in `engine_workers`;
  2. claim and run durable jobs (INIT_SESSION, REPLAY_REFRESH, RECALC, RECOVERY) with lease, heartbeat, fencing, retry, dead letter;
  3. for every active session take/renew the single-advancer session lease, then
       interactive: advance simulated minutes up to the shared clock, issuing plant-agent commands through the Express internal
                    endpoint (same validated transitions as humans), and run a calculation pass when new events arrived or
                    5 simulated minutes passed (time-based rules: cutoff passage, persistence, shift change, equipment recovery);
       replay:      rebuild the read-only projection at the replay clock every refresh interval;
  4. ask the API to dispatch ready notifications from the durable outbox.
Restart-safe: progress is persisted in sim_sessions.ENGINE (SIM_AT, WATERMARK_SEQ, FENCE); agent commands carry deterministic
idempotency keys, so a replayed minute after a crash never duplicates tasks, events or points.
"""
import datetime as dt
import os
import signal
import socket
import sys
import time
import traceback

from pymongo import ASCENDING, MongoClient

from . import ENGINE_VERSION
from . import calc as CALC
from . import config as CFG
from . import forecast as F
from . import jobs as J
from . import recovery as REC
from .agents import PlantAgents
from .api_client import ApiClient, ApiError
from .catalog import Catalog
from .reduce import reduce_state, summary
from .session_init import init_session, write_state
from .timeutil import sim_now, utcnow

MAX_MINUTES_PER_TICK = 30
MAX_MINUTES_MANUAL = 720        # manual team test: catching up after the engine was stopped (only timed process steps are simulated)
CALC_EVERY_SIM_MIN = 5          # periodic pass for rolling-window rules; deadline boundaries are evaluated exactly (calc.next_boundaries)
CALC_MIN_WALL_S = 3
ACTIVE = ("READY", "RUNNING", "PAUSED")


def log(*a):
    print(utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), *a, flush=True)


def ensure_indexes(db, settings):
    spec = settings.json("contracts/indexes.json")
    n = 0
    for i in spec["indexes"]:
        kw = {}
        if i.get("unique"):
            kw["unique"] = True
        if i.get("partial"):
            kw["partialFilterExpression"] = i["partial"]
        if i.get("name"):
            kw["name"] = i["name"]
        if i.get("ttl") is not None:
            kw["expireAfterSeconds"] = i["ttl"]
        try:
            db[i["c"]].create_index([(k, d) for k, d in i["k"]], **kw)
            n += 1
        except Exception as e:      # an index with the same keys but other options already exists: report, keep running
            log("index %s %s not created: %s" % (i["c"], i["k"], str(e)[:200]))
    return n


class Engine:
    def __init__(self, settings, db=None):
        self.st = settings
        self.owner = settings.worker_id
        self.db = db
        self.api = ApiClient(settings.api_internal_url, settings.internal_token)
        self.stop = False
        self.cat = None
        self.agents = {}
        self.rosters = {}
        self.last_calc_wall = {}
        self.last_replay_wall = {}
        self.sim_cfg = settings.json("config/simulation.json")

    def connect(self):
        if self.db is None:
            client = MongoClient(self.st.mongo_uri, serverSelectionTimeoutMS=10000, tz_aware=False)
            self.db = client[self.st.mongo_db]
        self.db.command("ping")
        log("environment %s, database \"%s\", dataset %s" % (self.st.environment, self.st.mongo_db, self.st.dataset_id))
        if self.st.is_fresh:
            # fresh factory: no synthetic calendar continuation, no workbook data; an empty configuration is normal until the admin sets it up
            self.cat = Catalog(self.db, self.st.dataset_id, fresh=True)
            if not self.db.sim_sessions.find_one({"SESSION_ID": "S-FACTORY"}):
                log("fresh factory not initialised yet (no S-FACTORY session) - run `npm run factory:init` in backend/; the engine keeps waiting")
            if not self.cat.routing:
                log("no products/routes configured yet - forecasts stay empty until the admin configures the factory")
        else:
            from . import continuation
            log("calendar continuation:", continuation.ensure(self.db, self.st.dataset_id))
            self.cat = Catalog(self.db, self.st.dataset_id)
            if not self.cat.routing:
                raise RuntimeError("routing_operations is empty - seed the v3 Final workbooks first (backend/seed/README_SEED.md)")
        ensure_indexes(self.db, self.st)
        self.db.engine_workers.update_one({"WORKER_ID": self.owner}, {"$set": {"WORKER_ID": self.owner, "STARTED_AT": utcnow(), "HEARTBEAT_AT": utcnow(), "ENGINE_VERSION": ENGINE_VERSION,
                                                                              "HOST": os.environ.get("RENDER_INSTANCE_ID") or socket.gethostname(), "STATUS": "RUNNING",
                                                                              "ENVIRONMENT": self.st.environment, "DATABASE": self.st.mongo_db, "DATASET_ID": self.st.dataset_id}}, upsert=True)

    # ------------------------------------------------------------------ loop
    def run_forever(self):
        self.connect()
        log("engine %s started (tick %ss, lease %ss)" % (self.owner, self.st.tick_seconds, self.st.lease_seconds))
        while not self.stop:
            t0 = time.time()
            try:
                self.tick()
            except Exception as e:
                log("tick failed:", e)
                traceback.print_exc()
            time.sleep(max(0.2, self.st.tick_seconds - (time.time() - t0)))
        self.shutdown()

    def shutdown(self):
        try:
            for s in self.db.sim_sessions.find({"ENGINE.LEASE_OWNER": self.owner}):
                J.release_session(self.db, s, self.owner)
            self.db.engine_workers.update_one({"WORKER_ID": self.owner}, {"$set": {"STATUS": "STOPPED", "STOPPED_AT": utcnow()}})
        except Exception:
            pass
        log("engine stopped")

    def tick(self):
        self.db.engine_workers.update_one({"WORKER_ID": self.owner}, {"$set": {"HEARTBEAT_AT": utcnow(), "STATUS": "RUNNING"}})
        self.cat.refresh_if_stale()
        deadline = time.time() + max(2.0, self.st.tick_seconds * 3)
        while time.time() < deadline:
            job = J.claim(self.db, self.owner, self.st.lease_seconds)
            if not job:
                break
            self.run_job(job)
        for s in list(self.db.sim_sessions.find({"STATUS": {"$in": list(ACTIVE)}})):
            leased = J.lease_session(self.db, s["SESSION_ID"], self.owner, self.st.lease_seconds)
            if not leased:
                continue
            try:
                if leased.get("MODE") == "REPLAY":
                    self.replay(leased)
                else:
                    self.advance(leased)
            except Exception as e:
                log("session %s failed: %s" % (s["SESSION_ID"], e))
                traceback.print_exc()
                self.db.sim_sessions.update_one({"SESSION_ID": s["SESSION_ID"]}, {"$set": {"ENGINE.LAST_ERROR": str(e)[:500], "ENGINE.LAST_ERROR_AT": utcnow()}})
        if self.db.notifications.count_documents({"STATUS": {"$in": ["PENDING", "RETRY"]}, "NEXT_ATTEMPT_AT": {"$lte": utcnow()}}, limit=1):
            try:
                self.api.dispatch_notifications(20)
            except ApiError as e:
                log("notification dispatch unavailable:", e)

    # ------------------------------------------------------------------ jobs
    def run_job(self, job):
        sid = job.get("SESSION_ID")
        try:
            s = self.db.sim_sessions.find_one({"SESSION_ID": sid}) if sid else None
            if sid and not s:
                J.complete(self.db, job, self.owner, {"skipped": "session not found"})
                return
            if s and s.get("STATUS") in ("ARCHIVED", "PURGED"):
                J.complete(self.db, job, self.owner, {"skipped": "archived"})
                return
            t = job["TYPE"]
            if t == "INIT_SESSION":
                res = init_session(self.db, self.cat, s)
                s = self.db.sim_sessions.find_one({"SESSION_ID": sid})
                CALC.ensure_baselines(self.db, self.cat, s)
                s = self.db.sim_sessions.find_one({"SESSION_ID": sid})
                self.agents.pop(sid, None)
                res["calc"] = self._calc(s, sim_now(s))
            elif t == "REPLAY_REFRESH":
                res = self.replay_refresh(s)
            elif t == "RECALC":
                res = self._calc(s, sim_now(s) if s.get("MODE") == "INTERACTIVE" else (s.get("INIT") or {}).get("AS_OF") or sim_now(s))
            elif t == "RECOVERY":
                res = self.recovery(s, (job.get("PAYLOAD") or {}).get("orderLineId"))
            else:
                res = {"skipped": "unknown job type %s" % t}
            J.complete(self.db, job, self.owner, _jsonable(res))
        except Exception as e:
            dead = J.fail(self.db, job, self.owner, e, self.st.max_retries)
            log("job %s %s failed%s: %s" % (job["JOB_ID"], job["TYPE"], " -> DEAD LETTER" if dead else " (will retry)", e))
            traceback.print_exc()

    def _calc(self, s, now, trigger="EVENTS"):
        sess = dict(s)
        if s.get("MODE") == "REPLAY":
            sess["FORK_AT"] = (s.get("INIT") or {}).get("AS_OF") or now
        res = CALC.run_pass(self.db, self.cat, self.st, sess, now, log=log, trigger=trigger)
        self.last_calc_wall[s["SESSION_ID"]] = time.time()
        return res

    # ------------------------------------------------------------------ replay (read-only)
    def replay_refresh(self, s):
        T = sim_now(s)
        state = reduce_state(self.db, self.cat, s["SOURCE_RUN_ID"], T, s["DATASET_ID"])
        counts = write_state(self.db, s, state)
        good = {k: len(v) for k, v in state["good_by_line"].items()}
        scrap = {k: len(v) for k, v in state["scrap_by_line"].items()}
        # never resurrect a session archived while this refresh ran; READY only replaces INITIALIZING
        self.db.sim_sessions.update_one({"SESSION_ID": s["SESSION_ID"], "STATUS": "INITIALIZING"}, {"$set": {"STATUS": "READY"}})
        self.db.sim_sessions.update_one({"SESSION_ID": s["SESSION_ID"], "STATUS": {"$nin": ["ARCHIVED", "PURGED"]}}, {"$set": {
            "INIT": {"COMPLETED_AT": utcnow(), "AS_OF": T, "COUNTS": counts, "SUMMARY": summary(state), "WARNINGS": state["warnings"],
                                                                                       "GOOD_BY_LINE_AT_FORK": good, "SCRAP_BY_LINE_AT_FORK": scrap, "BASIS": "Replay projection at the replay clock (records with EVENT_TIME and KNOWN_AT <= replay time)"},
            "ENGINE.SIM_AT": T, "UPDATED_AT": utcnow()}, "$inc": {"EVENT_SEQ": 1}})
        s2 = self.db.sim_sessions.find_one({"SESSION_ID": s["SESSION_ID"]})
        CALC.ensure_baselines(self.db, self.cat, s2)
        s2 = self.db.sim_sessions.find_one({"SESSION_ID": s["SESSION_ID"]})
        self.last_replay_wall[s["SESSION_ID"]] = time.time()
        return {"as_of": T, "counts": counts, "calc": self._calc(s2, T)}

    def replay(self, s):
        c = s.get("CLOCK") or {}
        last = self.last_replay_wall.get(s["SESSION_ID"], 0)
        if c.get("PAUSED") and (s.get("INIT") or {}).get("AS_OF"):
            return
        if time.time() - last >= float(self.sim_cfg.get("replay_refresh_seconds", 30)):
            self.replay_refresh(s)

    # ------------------------------------------------------------------ interactive advance
    def rosters_for(self, s):
        key = (s["SESSION_ID"], int(time.time() // 300), s.get("ROSTER_VERSION") or 0)
        if self.rosters.get(s["SESSION_ID"], (None,))[0] != key:
            rows = {}
            q = {"RUN_ID": s["SOURCE_RUN_ID"], "PLANNED_END_AT": {"$gte": s["FORK_AT"] - dt.timedelta(hours=12)}, "PLANNED_START_AT": {"$lte": (s.get("HORIZON_AT") or s["FORK_AT"]) + dt.timedelta(days=1)}}
            for r in self.db.shift_roster.find(q, {"_seed": 0}):
                if r.get("KNOWN_AT") and r["KNOWN_AT"] > s["FORK_AT"] and r["PLANNED_START_AT"] < s["FORK_AT"]:
                    continue
                rows.setdefault(r["WORKER_ID"], []).append(r)
            for r in self.db.continuation_shift_roster.find({"PLANNED_START_AT": {"$gte": s["FORK_AT"]}}, {"_id": 0}):
                rows.setdefault(r["WORKER_ID"], []).append(r)
            for r in self.db.app_shift_roster.find({"PLANNED_END_AT": {"$gte": s["FORK_AT"] - dt.timedelta(hours=12)}, "SESSION_ID": {"$in": [None, s["SESSION_ID"]]}}, {"_id": 0}):
                rows.setdefault(r["WORKER_ID"], []).append(dict(r, ORIGIN="APP_ROSTER"))
            for v in rows.values():
                v.sort(key=lambda r: r["PLANNED_START_AT"])
            self.rosters[s["SESSION_ID"]] = (key, rows)
        return self.rosters[s["SESSION_ID"]][1]

    def advance(self, s):
        sid = s["SESSION_ID"]
        target = sim_now(s)
        cur = (s.get("ENGINE") or {}).get("SIM_AT") or s["FORK_AT"]
        e0 = s.get("ENGINE") or {}
        boundary = e0.get("NEXT_BOUNDARY_SIM_AT")
        # a deadline boundary already passed without an evaluation (engine down / restarted while the clock ran): evaluate now
        if boundary and cur >= boundary and (e0.get("LAST_CALC_SIM_AT") is None or e0["LAST_CALC_SIM_AT"] < boundary):
            self._calc(s, cur, trigger="RECOVERED_OVERDUE_BOUNDARY")
            s = self.db.sim_sessions.find_one({"SESSION_ID": sid})
            boundary = (s.get("ENGINE") or {}).get("NEXT_BOUNDARY_SIM_AT")
        agents = PlantAgents(self.db, self.cat, s, self.st, self.rosters_for(s))
        steps, issued, rejected = 0, 0, 0
        rej = []
        manual = s.get("FACTORY_SESSION") and s.get("OPERATING_MODE") != "SIMULATED_TEST"
        plan, planned_hit = plan_advance(cur, target, boundary, MAX_MINUTES_MANUAL if manual else MAX_MINUTES_PER_TICK)
        hit_boundary = None
        completed = True
        for t in plan:
            if self.stop:
                completed = False
                break
            cmds = agents.step(t)
            if cmds:
                try:
                    res = self.api.commands(sid, cmds)
                    issued += len(cmds)
                    bad = [r for r in res if not r.get("ok")]
                    rejected += len(bad)
                    for r in bad:
                        rej.append({"at": t, "type": r.get("type"), "ref": r.get("ref"), "code": r.get("code"), "message": (r.get("message") or "")[:200]})
                except ApiError as e:
                    log("session %s: command endpoint unavailable (%s) - minute %s will be retried" % (sid, e, t.isoformat()))
                    completed = False
                    break
            cur = t
            steps += 1
            if not J.renew_session(self.db, s, self.owner, self.st.lease_seconds, {"ENGINE.SIM_AT": cur}):
                log("session %s: lease lost (another worker) - stopping advance" % sid)
                return
            if s.get("FACTORY_SESSION") and steps % 30 == 0 and (self.db.sim_sessions.find_one({"SESSION_ID": sid}, {"STATUS": 1}) or {}).get("STATUS") not in ACTIVE:
                log("session %s left the active states (reset) - stopping advance" % sid)
                return
        if completed and planned_hit:
            hit_boundary = planned_hit           # evaluate exactly AT the boundary (to the second), continue next tick
        if steps == 0:
            J.renew_session(self.db, s, self.owner, self.st.lease_seconds)
        if issued:
            upd = {"$inc": {"ENGINE.AGENT_COMMANDS": issued, "ENGINE.AGENT_REJECTED": rejected}}
            if rej:
                upd["$push"] = {"ENGINE.LAST_REJECTIONS": {"$each": rej[-20:], "$slice": -40}}
                log("session %s: %d agent proposals rejected by domain validation (expected when state changed): %s" % (sid, len(rej), "; ".join(sorted({"%s %s" % (r["type"], r["code"]) for r in rej}))))
            self.db.sim_sessions.update_one({"SESSION_ID": sid}, upd)
        s = self.db.sim_sessions.find_one({"SESSION_ID": sid})
        e = s.get("ENGINE") or {}
        new_events = (s.get("EVENT_SEQ") or 0) > (e.get("WATERMARK_SEQ") or 0)
        last_sim = e.get("LAST_CALC_SIM_AT")
        due_time = last_sim is None or (cur - last_sim) >= dt.timedelta(minutes=CALC_EVERY_SIM_MIN)
        wall_ok = time.time() - self.last_calc_wall.get(sid, 0) >= CALC_MIN_WALL_S
        if hit_boundary:
            reason = next((b.get("reason") for b in (e.get("NEXT_BOUNDARIES") or []) if b.get("at") == hit_boundary), "deadline boundary")
            # as-of = the boundary itself: agent activity is applied up to the last whole minute <= boundary, and nothing can
            # happen between that minute and the boundary except human commands, which are already committed in the database
            self._calc(s, max(cur, hit_boundary), trigger="BOUNDARY: %s" % reason)
        elif (new_events or due_time) and wall_ok:
            self._calc(s, cur, trigger="EVENTS" if new_events else "PERIODIC")

    # ------------------------------------------------------------------ recovery options
    def recovery(self, s, line_id=None):
        now = sim_now(s) if s.get("MODE") == "INTERACTIVE" else ((s.get("INIT") or {}).get("AS_OF") or sim_now(s))
        sess = dict(s)
        if s.get("MODE") == "REPLAY":
            sess["FORK_AT"] = now
        baselines = CALC.ensure_baselines(self.db, self.cat, sess)
        from . import metrics as M, variance as V
        d = M.SessionData(self.db, self.cat, sess, now)
        eff, _ = F.efficiency_factors({wc: M.wc_labor(d, wc, 120) for wc in V.CORE_WCS})
        model = F.Model(self.db, self.cat, sess, now, baselines=baselines, efficiency=eff)
        seed = "%s|%s|%s" % (s.get("SEED", 42), s["SESSION_ID"], s.get("EVENT_SEQ") or 0)
        base = F.run_forecast(model, seed, reps=REC.OPTION_REPS, buffer_min=self.st.safety_buffer_minutes)
        rec = REC.Recovery(model, seed, base, self.st.safety_buffer_minutes)
        targets = [l for l in base["lines"] if (l["ORDER_LINE_ID"] == line_id) or (not line_id and l["BAND"] in ("RED", "AMBER"))][:3]
        out = []
        _, rule_version, _ = CALC.active_rules(self.db, self.st, now)
        for line in targets:
            b, options = rec.evaluate(line)
            doc = REC.build_doc(s, line["ORDER_LINE_ID"], now, s.get("EVENT_SEQ") or 0, b, options, base["notes"], ENGINE_VERSION, rule_version)
            self.db.sim_forecasts.update_one({"SESSION_ID": s["SESSION_ID"], "FORECAST_ID": doc["FORECAST_ID"]}, {"$setOnInsert": _bsonable(doc)}, upsert=True)
            out.append({"forecastId": doc["FORECAST_ID"], "orderLineId": line["ORDER_LINE_ID"], "options": len(options), "feasible": sum(1 for o in options if o["FEASIBLE"])})
        if not targets:
            out.append({"note": "No order line at risk%s" % (" matching %s" % line_id if line_id else "")})
        return {"recovery": out}



def plan_advance(cur, target, boundary, max_steps):
    """The whole simulated minutes to step from `cur` towards `target`, and the deadline boundary to evaluate afterwards.
    Agents act on whole minutes; deadline boundaries are exact to the second (calc.next_boundaries, e.g. 14:30:01 for a 14:30
    cutoff). Stepping stops BEFORE the first minute that would pass the boundary, so the evaluation is made as of the boundary
    itself rather than up to a minute later. A boundary exactly on a minute (shift start/end) is evaluated after that minute's
    step, so the shift change is applied first. Returns ([minute, ...], boundary or None)."""
    one = dt.timedelta(minutes=1)
    steps, t = [], cur
    while t + one <= target and len(steps) < max_steps:
        nxt = t + one
        if boundary and t < boundary < nxt:
            return steps, boundary
        steps.append(nxt)
        t = nxt
        if boundary and t >= boundary:
            return steps, boundary
    if boundary and t < boundary <= target and len(steps) < max_steps:
        return steps, boundary
    return steps, None


def _bsonable(v):
    if isinstance(v, dict):
        return {str(k): _bsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_bsonable(x) for x in v]
    return v


def _jsonable(v):
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (str, int, float, bool)) or v is None or isinstance(v, dt.datetime):
        return v
    return str(v)


def main(argv=None):
    settings = CFG.load()
    probs = settings.problems()
    if probs:
        for p in probs:
            log("CONFIG ERROR:", p)
        sys.exit(2)
    eng = Engine(settings)

    def _stop(*_):
        eng.stop = True
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    eng.run_forever()


if __name__ == "__main__":
    main()
