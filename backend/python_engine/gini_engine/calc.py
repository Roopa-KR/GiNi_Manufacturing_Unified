"""One calculation pass for a session at simulated time `now`.

Order: input watermark -> labour metrics -> route forecast (order bands, work-centre and operation projections) -> variance rules
(M01-M13, F1-F6) -> alert lifecycle and notification outbox -> points ledger -> worker metrics -> action verification -> publish.

Every projection document of a pass carries the same PROJECTION_VERSION; the session's PROJECTION_VERSION and ENGINE.WATERMARK_SEQ
are advanced only at the end, and only if no newer pass has already published (a delayed job can never overwrite a newer projection).
Readers select projections with PROJECTION_VERSION <= the session's published version, so a screen never mixes two versions.
"""
import datetime as dt

from pymongo import ReturnDocument
import json

from . import ENGINE_VERSION
from . import alerts as AL
from . import baselines as BL
from . import forecast as F
from . import metrics as M
from . import variance as V
from . import verify as VR
from .points import PointsEngine
from .reduce import shift_at
from .timeutil import utcnow

KEEP_VERSIONS = 3


def active_rules(db, settings, now):
    # effective-dated in application (wall-clock) time: the newest version whose EFFECTIVE_FROM has passed; a version saved with a
    # future date waits until then (simulated plant time is not used, so a change applies to every running session alike)
    rows = list(db.rule_settings.find({"EFFECTIVE_FROM": {"$lte": utcnow()}, "STATUS": {"$ne": "WITHDRAWN"}}).sort([("VERSION_NO", -1)]).limit(1))
    if rows and rows[0].get("RULES"):
        r = rows[0]
        return r["RULES"].get("rules", []), "v%s" % r.get("VERSION_NO"), r["RULES"]
    cfg = settings.json("config/rules.json")
    return cfg["rules"], "config-%s" % cfg.get("version"), cfg


def ensure_baselines(db, cat, session, now=None):
    ag = session.get("AGENT_SETTINGS") or {}
    if session.get("FACTORY_SESSION"):
        from .timeutil import sim_now
        now = now or sim_now(session)
        previous = ag.get("BASELINES") or {}
        computed = previous.get("COMPUTED_AT")
        if computed and computed <= now and (now - computed).total_seconds() < 300:
            return previous
        b = BL.compute_factory(db, cat, session, now)
        db.sim_sessions.update_one({"SESSION_ID": session["SESSION_ID"]}, {"$set": {"AGENT_SETTINGS.BASELINES": _bsonable(b)}})
        session.setdefault("AGENT_SETTINGS", {})["BASELINES"] = b
        return b
    if ag.get("BASELINES") and ag.get("FAIL_RATES") is not None:
        return ag["BASELINES"]
    b = BL.compute(db, cat, session["SOURCE_RUN_ID"], session["FORK_AT"])
    fr = {g: (r if r is not None else F.DEFAULT_FAIL) for g, r in (b.get("FIRST_ATTEMPT_FAIL_RATE") or {}).items()}
    db.sim_sessions.update_one({"SESSION_ID": session["SESSION_ID"]}, {"$set": {"AGENT_SETTINGS.BASELINES": _bsonable(b), "AGENT_SETTINGS.FAIL_RATES": fr}})
    session.setdefault("AGENT_SETTINGS", {}).update(BASELINES=b, FAIL_RATES=fr)
    return b


def _bsonable(v):
    if isinstance(v, dict):
        return {str(k): _bsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_bsonable(x) for x in v]
    return v


def allocate_version(db, session):
    """a unique projection version per calculation pass (two concurrent passes never share a version number)"""
    sid = session["SESSION_ID"]
    db.sim_sessions.update_one({"SESSION_ID": sid}, {"$max": {"ENGINE.PROJECTION_SEQ": int(session.get("PROJECTION_VERSION") or 0)}})
    s = db.sim_sessions.find_one_and_update({"SESSION_ID": sid}, {"$inc": {"ENGINE.PROJECTION_SEQ": 1}}, return_document=ReturnDocument.AFTER)
    return int(s["ENGINE"]["PROJECTION_SEQ"])


def publish(db, sid, pv, watermark, docs, extra_set=None):
    """write this pass's projection documents, then make them current only if no pass with a newer input watermark or a higher
    version has published meanwhile. A superseded pass removes exactly its own documents (its version is unique)."""
    for i in range(0, len(docs), 500):
        db.sim_projections.insert_many(docs[i:i + 500], ordered=False)
    upd = {"PROJECTION_VERSION": pv, "ENGINE.WATERMARK_SEQ": watermark}
    upd.update(extra_set or {})
    r = db.sim_sessions.update_one({"SESSION_ID": sid, "PROJECTION_VERSION": {"$lt": pv}, "$or": [{"ENGINE.WATERMARK_SEQ": {"$lte": watermark}}, {"ENGINE.WATERMARK_SEQ": None}]},
                                   {"$set": upd})
    if r.modified_count != 1:
        db.sim_projections.delete_many({"SESSION_ID": sid, "PROJECTION_VERSION": pv})
        return False
    db.sim_projections.delete_many({"SESSION_ID": sid, "PROJECTION_VERSION": {"$lt": pv - KEEP_VERSIONS + 1}, "KIND": {"$ne": "WO_AWARD_EVALUATION"}})
    return True


BOUNDARY_STEP = dt.timedelta(seconds=1)        # bands are inclusive at the deadline (14:30:00 AMBER), so the result changes at 14:30:01;
                                               # worker.plan_advance evaluates exactly then, not at the next whole minute


def next_boundaries(db, cat, session, now, lines, rules_by_id):
    """simulated times after `now` at which a result can change with no new event: buffer deadlines and cutoffs (band/elapsed
    changes), replenishment need-by + F6 threshold, shift start/end. Sorted [(time, reason)]."""
    out = []
    for l in lines:
        if l.get("BAND") == "COMPLETE":
            continue
        for k, label in (("BUFFER_DEADLINE_AT", "buffer deadline"), ("DUE_AT", "cutoff")):
            t = l.get(k)
            if t and t + BOUNDARY_STEP > now:
                out.append((t + BOUNDARY_STEP, "%s passed for %s" % (label, l["ORDER_LINE_ID"])))
    f6 = int(((rules_by_id.get("F6") or {}).get("threshold") or {}).get("min_minutes") or 10)
    for q in db.sim_material_requests.find({"SESSION_ID": session["SESSION_ID"], "STATUS": {"$nin": ["DELIVERED", "CANCELLED"]}, "NEED_BY_AT": {"$ne": None}}, {"NEED_BY_AT": 1, "REQUEST_ID": 1}):
        t = q["NEED_BY_AT"] + dt.timedelta(minutes=f6)          # F6 breaches at late >= threshold (inclusive)
        if t > now:
            out.append((t, "replenishment %s exceeds need-by + %d min (F6)" % (q.get("REQUEST_ID"), f6)))
    sh = shift_at(cat, now)
    if sh and sh["END_AT"] > now:
        out.append((sh["END_AT"], "shift %s ends" % sh.get("SHIFT_ID")))
    nxt = shift_at(cat, (sh["END_AT"] if sh else now) + dt.timedelta(minutes=1))
    if nxt and nxt["START_AT"] > now:
        out.append((nxt["START_AT"], "shift %s starts" % nxt.get("SHIFT_ID")))
    return sorted(out)


def run_pass(db, cat, settings, session, now, notify_dispatch=None, log=print, trigger="EVENTS"):
    sid = session["SESSION_ID"]
    t0 = utcnow()
    watermark = int(session.get("EVENT_SEQ") or 0)
    pv = allocate_version(db, session)
    rules, rule_version, rules_cfg = active_rules(db, settings, now)
    buffer_min = int((rules_cfg.get("cutoff") or {}).get("safety_buffer_minutes") or settings.safety_buffer_minutes)
    baselines = ensure_baselines(db, cat, session, now)
    base_doc = {"SESSION_ID": sid, "PROJECTION_VERSION": pv, "COMPUTED_AT": utcnow(), "AS_OF": now, "INPUT_WATERMARK": watermark, "ENGINE_VERSION": ENGINE_VERSION,
                "RULE_VERSION": rule_version, "CALCULATION_ID": "CALC-%s-%d" % (session.get("SHORT_ID") or sid[-6:], pv), "TRIGGER": trigger, "_origin": "APP"}
    docs = []
    # ------------------------------------------------ labour metrics + forecast
    d = M.SessionData(db, cat, session, now)
    labs = {wc: M.wc_labor(d, wc, 120) for wc in V.CORE_WCS}
    eff, eff_basis = F.efficiency_factors(labs)
    model = F.Model(db, cat, session, now, baselines=baselines, efficiency=eff)
    seed = "%s|%s|%s" % (session.get("SEED", 42), sid, watermark)
    fc = F.run_forecast(model, seed, reps=F.REPLICATIONS, buffer_min=buffer_min)
    for l in fc["lines"]:
        if l["BAND"] == "COMPLETE":
            l["COMPLETE_AT"] = model.last_good_at.get(l["ORDER_LINE_ID"])
    docs.append(dict(base_doc, KIND="ORDER_FORECAST_SUMMARY", ENTITY_ID="ALL", DATA=fc["lines"], NOTES=fc["notes"], EFFICIENCY_BASIS=eff_basis,
                     METHOD="Route DES %d-min resolution, %d seeded replications, horizon %s; GREEN <= cutoff - %d min < AMBER <= cutoff < RED; UNKNOWN when not estimable" % (F.STEP_MIN, F.REPLICATIONS, fc["horizon_end"].isoformat(), buffer_min)))
    wc_data = {}
    for wc in V.CORE_WCS:
        q, inproc = M.remaining_std_work(d, wc)
        avail, people = M.available_labor(d, wc, V.wc_skills(cat, wc))
        x = dict(fc["work_centers"].get(wc, {}))
        x.update(LOAD_STD_MIN=round(q + inproc, 1), QUEUED_STD_MIN=q, IN_PROCESS_REMAINING_STD_MIN=inproc, AVAILABLE_LABOR_MIN=avail, QUALIFIED_PEOPLE=people, LABOR=labs[wc], EFFICIENCY_BASIS=eff_basis.get(wc))
        wc_data[wc] = x
    wc_data["INSPECTION"] = fc["work_centers"].get("INSPECTION")
    docs.append(dict(base_doc, KIND="WORK_CENTER_SUMMARY", ENTITY_ID="ALL", DATA=wc_data))
    if session.get("FACTORY_SESSION"):
        # Retained samples survive projection pruning; one immutable row per five-minute bucket.
        bucket = int(now.timestamp()) // 300
        released = 0.0
        seen = set()
        for e in d.events_window:
            if e.get("EVENT_TYPE") == "BATCH_RELEASED" and e.get("EVENT_TIME") >= now - dt.timedelta(minutes=120):
                for uid in (e.get("PAYLOAD") or {}).get("UNIT_IDS", []):
                    if uid in seen: continue
                    seen.add(uid)
                    u = next((u for u in d.units if u["UNIT_ID"] == uid), {})
                    first = next((r for r in cat.routing if r.get("PRODUCT_ID") == u.get("PRODUCT_ID") and r.get("OPERATION_KIND") == "LABOR"), {})
                    released += float(first.get("STANDARD_LABOR_MIN") or 0)
        db.factory_baseline_samples.update_one({"_id": "%s:%s:%s" % (sid, session.get("RESET_GENERATION", 0), bucket)},
            {"$setOnInsert": {"SESSION_ID": sid, "AS_OF": now, "WORK_CENTERS": [{"WORK_CENTER_ID": w, "QUEUED_STD_MIN": x.get("QUEUED_STD_MIN", 0)} for w, x in wc_data.items() if x and w != "INSPECTION"], "RELEASED_STD_MIN_120": released}}, upsert=True)
    for inst, at in fc["operations"].items():
        docs.append(dict(base_doc, KIND="OPERATION_FORECAST", ENTITY_ID=inst, FORECAST_FINISH_AT=at, BASIS="Median-replication route DES finish with current crew, breaks and shift rosters"))
    # running operations not finished inside the horizon still get an explicit 'not estimable' projection
    for o in model.ops.values():
        if o.get("OPERATION_KIND") == "LABOR" and o["OPERATION_INSTANCE_ID"] not in fc["operations"]:
            docs.append(dict(base_doc, KIND="OPERATION_FORECAST", ENTITY_ID=o["OPERATION_INSTANCE_ID"], FORECAST_FINISH_AT=None, BASIS="Not estimable inside the forecast horizon (no qualified crew scheduled or blocked)"))
    # ------------------------------------------------ variance + alerts
    prev = {}
    last_eval = db.sim_projections.find_one({"SESSION_ID": sid, "KIND": "RULE_EVALUATION"}, sort=[("PROJECTION_VERSION", -1)])
    for o in (last_eval or {}).get("DATA") or []:
        prev[(o["rule_id"], o["entity_id"])] = o
    obs = V.evaluate(d, rules, baselines, fc["lines"], prev)
    sh = shift_at(cat, now)
    am = AL.AlertManager(db, session, rules, rule_version, now, shift_start=(sh or {}).get("START_AT"), initial=int(session.get("PROJECTION_VERSION") or 0) == 0)
    astats = am.apply(obs)
    docs.append(dict(base_doc, KIND="RULE_EVALUATION", ENTITY_ID="ALL", DATA=[_bsonable(_compact(o)) for o in obs],
                     COUNTS={s: sum(1 for o in obs if o["status"] == s) for s in ("BREACH", "OK", "NO_DATA", "INSUFFICIENT_DATA")}))
    # ------------------------------------------------ points
    pstats = None
    if session.get("MODE") == "INTERACTIVE":
        try:
            pstats = PointsEngine(db, cat, session, calc_id="CALC-%s-%d" % (session.get("SHORT_ID") or sid[-6:], pv)).run(now)
        except Exception as e:          # a points failure must not block forecasts/alerts; it is reported and retried next pass
            pstats = {"error": str(e)[:300]}
            log("points pass failed for %s: %s" % (sid, e))
    # ------------------------------------------------ worker metrics (clocked-in people and anyone with a session segment)
    seg_workers = {s["WORKER_ID"] for s in d.segments}
    for w in d.workers:
        if w.get("ATTENDANCE_STATE") == "CLOCKED_IN" or w["WORKER_ID"] in seg_workers:
            docs.append(dict(base_doc, KIND="WORKER_METRICS", ENTITY_ID=w["WORKER_ID"], DATA={"labor_categories_min": M.worker_metrics(d, w), "basis": "Session participation segments since the fork (history shown separately)"}))
    # ------------------------------------------------ verification of started/completed actions
    lines_by = {l["ORDER_LINE_ID"]: l for l in fc["lines"]}
    for v in VR.run(db, session, now, lines_by, model.good_base, model.lines):
        docs.append(dict(base_doc, KIND="ACTION_VERIFICATION", ENTITY_ID=v["actionId"], DATA=_bsonable(v)))
    # ------------------------------------------------ publish (fenced by watermark/version)
    bounds = next_boundaries(db, cat, session, now, fc["lines"], {r.get("rule_id"): r for r in rules})
    published = publish(db, sid, pv, watermark, docs, {"ENGINE.LAST_CALC_AT": utcnow(), "ENGINE.LAST_CALC_SIM_AT": now, "ENGINE.LAST_CALC_TRIGGER": trigger,
                                                       "ENGINE.NEXT_BOUNDARY_SIM_AT": bounds[0][0] if bounds else None,
                                                       "ENGINE.NEXT_BOUNDARIES": [{"at": t, "reason": r} for t, r in bounds[:6]], "ENGINE.LAST_CALC_MS": int((utcnow() - t0).total_seconds() * 1000),
                                                       "ENGINE.LAST_CALC_STATS": {"alerts": astats, "points": _bsonable(pstats) if pstats else None, "projections": len(docs)}})
    if not published:
        log("pass for %s at watermark %s superseded by a newer projection - discarded" % (sid, watermark))
    return {"published": published, "projection_version": pv, "watermark": watermark, "ms": int((utcnow() - t0).total_seconds() * 1000), "alerts": astats, "points": pstats, "lines": len(fc["lines"])}


def _compact(o):
    keep = ("rule_id", "rule_name", "entity_type", "entity_id", "status", "severity", "actual", "expected", "threshold", "delta", "window", "message", "classification", "band", "sample", "stale", "pending")
    return {k: o.get(k) for k in keep if k in o}
