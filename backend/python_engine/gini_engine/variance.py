"""Manufacturing variance rules (M01-M13) and the six operational flags (F1-F6). Pure evaluation: each rule returns observations
{rule_id, entity_type, entity_id, status BREACH|OK|NO_DATA|INSUFFICIENT_DATA, actual, expected, threshold, delta, window, severity,
message, recommended, evidence, sample}. Missing data is never treated as zero throughput or as on-time."""
import datetime as dt
from collections import defaultdict

from . import metrics as M
from .timeutil import minutes, to_local, utcnow

# work centres and areas the rules evaluate. The synthetic demo keeps its four core work centres (WC1-WC4, two areas); a fresh factory
# uses the work centres it configured, in route order (configure() is called by Catalog.load). Module attributes are read at call time.
DEFAULT_CORE_WCS = ("WC1", "WC2", "WC3", "WC4")
DEFAULT_AREAS = {"AREA-FAB": ("WC1", "WC2"), "AREA-FIN": ("WC3", "WC4")}
CORE_WCS = DEFAULT_CORE_WCS
AREAS = dict(DEFAULT_AREAS)
GATES = ("QG10", "QG20", "QG30", "QG40")


def configure(cat, fresh=False):
    """set CORE_WCS / AREAS / GATES from the catalog: synthetic data with WC1-WC4 keeps the demo set; otherwise the active configured
    work centres that appear in routes (ordered by first route sequence), grouped by AREA_ID."""
    global CORE_WCS, AREAS, GATES
    if not fresh and all(w in cat.wcs for w in DEFAULT_CORE_WCS):
        CORE_WCS, AREAS, GATES = DEFAULT_CORE_WCS, dict(DEFAULT_AREAS), ("QG10", "QG20", "QG30", "QG40")
        return
    first = {}
    for r in sorted(cat.routing, key=lambda r: r.get("SEQUENCE_NO") or 0):
        wc = r.get("WORK_CENTER_ID")
        if wc and wc not in first and (cat.wcs.get(wc) or {}).get("ACTIVE_FLAG") != "N":
            first[wc] = r.get("SEQUENCE_NO") or 0
    extra = sorted(w for w, x in cat.wcs.items() if w not in first and x.get("ACTIVE_FLAG") != "N")
    CORE_WCS = tuple(sorted(first, key=lambda w: (first[w], w)) + extra)
    areas = {}
    for wc in CORE_WCS:
        areas.setdefault((cat.wcs.get(wc) or {}).get("AREA_ID") or wc, []).append(wc)
    AREAS = {a: tuple(v) for a, v in areas.items()}
    GATES = tuple(sorted({r["OPERATION_ID"] for r in cat.routing if r.get("OPERATION_KIND") == "INSPECTION"}))


def release_wc():
    """the work centre where released work enters (first in route order)"""
    return CORE_WCS[0] if CORE_WCS else None


def obs(rule, etype, eid, status, **kw):
    o = {"rule_id": rule["rule_id"], "rule_name": rule.get("name"), "entity_type": etype, "entity_id": eid, "status": status, "severity": kw.pop("severity", "MEDIUM"),
         "window": kw.pop("window", rule.get("window_min")), "legacy": rule.get("legacy")}
    o.update(kw)
    return o


def wc_skills(cat, wc):
    return sorted({r["REQUIRED_SKILL_ID"] for r in cat.routing if r.get("WORK_CENTER_ID") == wc and r.get("OPERATION_KIND") == "LABOR" and r.get("REQUIRED_SKILL_ID")})


def evaluate(d, rules, baselines, forecast_orders, prev):
    """d: metrics.SessionData; rules: list from rule settings; baselines: from baselines.compute; forecast_orders: latest order forecast rows;
    prev: {(rule, entity): last observation dict} for growth/conflict rules."""
    out = []
    R = {r["rule_id"]: r for r in rules if r.get("enabled", True)}
    slot = str(to_local(d.now).hour)
    cat = d.cat
    # ---------------- M01/M02/M03 labour efficiency per work centre (completed attempts only)
    for wc in CORE_WCS:
        if "M01" in R:
            r = R["M01"]; lab = M.wc_labor(d, wc, r.get("window_min", 120))
            ms = r.get("min_samples", {})
            if lab["efficiency_pct"] is None:
                out.append(obs(r, "WORK_CENTER", wc, "NO_DATA", message="No completed attempts with recorded labour in the window", sample=lab))
            elif lab["completed_operations"] < ms.get("completed_operations", 3) or lab["actual_labor_min"] < ms.get("actual_labor_min", 120):
                out.append(obs(r, "WORK_CENTER", wc, "INSUFFICIENT_DATA", actual=lab["efficiency_pct"], message="Below minimum sample (%s completed attempts, %s labour-min)" % (lab["completed_operations"], lab["actual_labor_min"]), sample=lab))
            else:
                th = r["threshold"]["value"]; crit = r["threshold"].get("critical", 0)
                b = lab["efficiency_pct"] <= th
                out.append(obs(r, "WORK_CENTER", wc, "BREACH" if b else "OK", actual=lab["efficiency_pct"], expected=100, threshold=th, delta=lab["variance_pp"], severity="HIGH" if lab["efficiency_pct"] <= crit else "MEDIUM",
                               message="%s labour efficiency %.1f%% (earned %.0f std-min / %.0f eligible labour-min on %d completed attempts)" % (wc, lab["efficiency_pct"], lab["earned_std_min"], lab["actual_labor_min"], lab["completed_operations"]),
                               recommended="Check the attempts in the window for waiting, crew below standard or instruction issues before drawing conclusions about people", sample=lab))
        if "M02" in R:
            r = R["M02"]; lab = M.wc_labor(d, wc, r.get("window_min", 480))
            if lab["completed_operations"] < r.get("min_samples", {}).get("completed_operations", 3):
                out.append(obs(r, "WORK_CENTER", wc, "INSUFFICIENT_DATA", actual=lab["budget_gap_min"], sample=lab, message="Too few completed attempts for a gap judgement"))
            else:
                th = r["threshold"]; pct = (lab["budget_gap_min"] / lab["earned_std_min"] * 100) if lab["earned_std_min"] else None
                b = lab["budget_gap_min"] >= th["value"] and (pct is None or pct >= th.get("pct_of_earned", 0))
                out.append(obs(r, "WORK_CENTER", wc, "BREACH" if b else "OK", actual=lab["budget_gap_min"], expected=0, threshold=th["value"], delta=lab["budget_gap_min"], sample=lab,
                               message="%s spent %.0f labour-min more than earned standard (%s%%) on completed attempts" % (wc, lab["budget_gap_min"], round(pct, 1) if pct is not None else "n/a")))
        if "M03" in R:
            r = R["M03"]; lab = M.wc_labor(d, wc, 480)
            cls = None if lab["efficiency_pct"] is None else ("LOW" if lab["efficiency_pct"] < 85 else "OVER_TARGET" if lab["efficiency_pct"] > 110 else "ON_TARGET")
            out.append(obs(r, "WORK_CENTER", wc, "OK" if cls else "NO_DATA", actual=lab["efficiency_pct"], classification=cls, sample=lab, alert=False, message="Classification %s" % cls))
    # ---------------- M04 backlog vs time-of-shift baseline + growth
    for wc in CORE_WCS:
        if "M04" not in R:
            break
        r = R["M04"]; th = r["threshold"]
        q, inproc = M.remaining_std_work(d, wc)
        base = ((baselines or {}).get("QUEUE_STD_MIN") or {}).get(wc, {}).get(slot)
        days = ((baselines or {}).get("QUEUE_SAMPLE_DAYS") or {}).get(wc, 0)
        p = prev.get(("M04", wc))
        growth = (q - p["actual"]) if p and p.get("actual") is not None else None
        if base is None or days < r.get("min_samples", {}).get("baseline_days", 3):
            b = q >= th.get("min_abs_std_min", 300) * 2
            out.append(obs(r, "WORK_CENTER", wc, "BREACH" if b else "INSUFFICIENT_DATA", actual=q, expected=None, threshold=th.get("min_abs_std_min"), message="No comparable baseline; absolute threshold only", sample={"queued_std_min": q}))
            continue
        if base == 0:
            b = q >= th.get("min_abs_std_min", 300)
            out.append(obs(r, "WORK_CENTER", wc, "BREACH" if b else "OK", actual=q, expected=0, threshold=th.get("min_abs_std_min"), classification="NEW_BACKLOG" if q > 0 else None,
                           message="Baseline is zero at this time of shift - absolute threshold (no infinite percentage)", sample={"queued_std_min": q, "baseline": base}))
            continue
        over = (q - base) / base * 100
        b1 = over >= th.get("pct_over_baseline", 30) and q - base >= th.get("min_abs_std_min", 300)
        b2 = growth is not None and p["actual"] and (growth / p["actual"] * 100) >= th.get("growth_pct", 15) and growth >= th.get("min_growth_std_min", 100)
        out.append(obs(r, "WORK_CENTER", wc, "BREACH" if (b1 or b2) else "OK", actual=q, expected=base, threshold="+%s%% and +%s std-min" % (th.get("pct_over_baseline"), th.get("min_abs_std_min")), delta=round(q - base, 1),
                       message="%s queued standard work %.0f std-min vs %.0f typical at this hour (%+.0f%%)%s" % (wc, q, base, over, "; growing %+.0f std-min since last evaluation" % growth if b2 else ""),
                       recommended="Check upstream release rate and %s staffing; compare with M05 capacity" % wc, sample={"queued_std_min": q, "baseline": base, "baseline_days": days, "growth": growth}))
    # ---------------- M05 capacity gap
    for wc in CORE_WCS:
        if "M05" not in R:
            break
        r = R["M05"]
        q, inproc = M.remaining_std_work(d, wc)
        avail, people = M.available_labor(d, wc, wc_skills(cat, wc))
        gap = round(q + inproc - avail, 1)
        crew = max([float(x.get("STD_CREW_SIZE") or 1) for x in cat.routing if x.get("WORK_CENTER_ID") == wc and x.get("OPERATION_KIND") == "LABOR"] or [1])
        rem_shift = max([minutes(d.now, w["PLANNED_END_AT"]) for w in d.workers if w.get("PLANNED_END_AT") and w.get("ATTENDANCE_STATE") == "CLOCKED_IN"] or [0])
        staffing_gap = round(gap / rem_shift, 1) if rem_shift > 0 and gap > 0 else 0
        b = gap >= r["threshold"]["value"]
        out.append(obs(r, "WORK_CENTER", wc, "BREACH" if b else "OK", actual=gap, expected=0, threshold=r["threshold"]["value"], severity="HIGH" if staffing_gap >= 2 else "MEDIUM",
                       message="%s remaining standard work %.0f labour-min vs %.0f qualified labour-min available before shift end (%d people); estimated staffing gap %.1f people" % (wc, q + inproc, avail, people, staffing_gap),
                       recommended="Consider qualified transfers or overtime - check donor stations first (Recovery)", sample={"remaining_std_min": q + inproc, "available_min": avail, "qualified_people": people, "staffing_gap": staffing_gap, "crew_std": crew}))
    # ---------------- M06 gate fail / scrap rate
    for gate in GATES:
        if "M06" not in R:
            break
        r = R["M06"]; th = r["threshold"]
        f = M.gate_fail_rate(d, gate, r.get("window_min", 480))
        base = ((baselines or {}).get("FIRST_ATTEMPT_FAIL_RATE") or {}).get(gate)
        if f["first_attempts"] < r.get("min_samples", {}).get("inspections", 8):
            out.append(obs(r, "GATE", gate, "INSUFFICIENT_DATA", actual=f["fail_rate_pct"], sample=f, message="%d first-attempt inspections in the window (minimum %d)" % (f["first_attempts"], r.get("min_samples", {}).get("inspections", 8))))
            continue
        bp = (base or 0) * 100           # no history (fresh factory): the absolute threshold alone decides; expected is shown as unknown
        b = f["fail_rate_pct"] >= th.get("fail_rate_pct", 10) and f["fail_rate_pct"] - bp >= th.get("min_pp_over_baseline", 5)
        out.append(obs(r, "GATE", gate, "BREACH" if b else "OK", actual=f["fail_rate_pct"], expected=round(bp, 1) if base is not None else None, threshold=th.get("fail_rate_pct"), delta=round(f["fail_rate_pct"] - bp, 1), severity="HIGH" if f["scrap_in_window"] else "MEDIUM",
                       message="%s first-attempt fail rate %.1f%% (%d of %d) vs %.1f%% baseline" % (gate, f["fail_rate_pct"], f["fails"], f["first_attempts"], bp), sample=f,
                       recommended="Review failed readings and the linked operations; a detection is not a finding of fault"))
    # ---------------- M07 productivity-quality conflict (correlation only)
    if "M07" in R:
        r = R["M07"]; th = r["threshold"]
        pairs = list(zip(CORE_WCS, ("QG10", "QG20", "QG30", "QG40"))) if CORE_WCS == DEFAULT_CORE_WCS else [(w, cat.gate_of_wc(w)) for w in CORE_WCS]
        for wc, gate in pairs:
            if not gate:
                continue
            now_e = M.wc_labor(d, wc, 120)["efficiency_pct"]; f = M.gate_fail_rate(d, gate, 120)
            p = prev.get(("M07", wc)) or {}
            pe, pf = (p.get("sample") or {}).get("eff"), (p.get("sample") or {}).get("fail")
            samp = {"eff": now_e, "fail": f["fail_rate_pct"], "prev_eff": pe, "prev_fail": pf, "inspections": f["first_attempts"]}
            if None in (now_e, f["fail_rate_pct"], pe, pf) or f["first_attempts"] < r.get("min_samples", {}).get("inspections", 6):
                out.append(obs(r, "WORK_CENTER", wc, "INSUFFICIENT_DATA", sample=samp, message="Needs two comparable windows with enough inspections"))
                continue
            b = (now_e - pe) >= th["prod_pp"] and pf > 0 and (f["fail_rate_pct"] - pf) / pf * 100 >= th["quality_rel_pct"]
            out.append(obs(r, "WORK_CENTER", wc, "BREACH" if b else "OK", actual=now_e, expected=pe, sample=samp, severity="LOW",
                           message="Efficiency up %.1f pp while %s fail rate rose from %.1f%% to %.1f%% - correlation, not blame" % (now_e - pe, gate, pf, f["fail_rate_pct"])))
    # ---------------- M08 workload surge
    if "M08" in R:
        r = R["M08"]
        rel = 0.0

        def wc1_std(unit_id):
            # standard labour of the product's first labour operation at the release work centre (from the routing, not a hard-coded ID)
            u = next((x for x in d.units if x["UNIT_ID"] == unit_id), None) or {}
            first = sorted((x for x in cat.routing if x.get("PRODUCT_ID") == u.get("PRODUCT_ID") and x.get("WORK_CENTER_ID") == release_wc() and x.get("OPERATION_KIND") == "LABOR"),
                           key=lambda x: x.get("SEQUENCE_NO") or 0)
            return float(first[0].get("STANDARD_LABOR_MIN") or 0) if first else 0.0
        counted = set()
        for e in d.events_window:
            if e["EVENT_TIME"] < d.now - dt.timedelta(minutes=120):
                continue
            pl = e.get("PAYLOAD") or {}
            if e["EVENT_TYPE"] == "BATCH_RELEASED":
                ids = pl.get("UNIT_IDS") or []
            elif e["EVENT_TYPE"] == "QUEUE_ENTERED" and pl.get("WORK_CENTER_ID") == release_wc():
                ids = [e["ENTITY_ID"]]
            else:
                ids = []
            for uid in ids:
                if uid not in counted:            # a released tank is counted once even if it also has a queue-entry event
                    counted.add(uid)
                    rel += wc1_std(uid)
        base = ((baselines or {}).get("WC1_RELEASE_STD_MIN_120") or {}).get(slot)
        if base is None:
            out.append(obs(r, "PLANT", release_wc() or "PLANT", "INSUFFICIENT_DATA", actual=rel, message="No release baseline for this hour (no comparable history)"))
        else:
            b = rel - base >= r["threshold"]["min_abs_std_min"] and (base == 0 or (rel - base) / base * 100 >= r["threshold"]["pct_over_baseline"])
            out.append(obs(r, "PLANT", release_wc(), "BREACH" if b else "OK", actual=round(rel, 1), expected=base, delta=round(rel - base, 1), severity="LOW", message="Standard work released into %s in the last 120 min: %.0f std-min vs %.0f typical" % (release_wc(), rel, base)))
    # ---------------- M09 deadline risk from the order forecast (cutoff bands)
    if "M09" in R:
        r = R["M09"]
        for f in forecast_orders or []:
            band = f.get("BAND")
            if band == "COMPLETE":
                continue
            st = "BREACH" if band == "RED" else ("NO_DATA" if band == "UNKNOWN" else "OK")
            out.append(obs(r, "ORDER_LINE", f["ORDER_LINE_ID"], st, actual=f.get("FORECAST_FINISH_AT"), expected=f.get("DUE_AT"), threshold="cutoff - %s min buffer" % f.get("BUFFER_MIN", 10), severity="HIGH", band=band,
                           pending=band == "AMBER", message="%s forecast %s good of %s by due (%s); band %s" % (f["ORDER_LINE_ID"], f.get("FORECAST_GOOD_BY_DUE"), f.get("REQUIRED_GOOD_QTY"), f.get("DUE_LOCAL"), band),
                           recommended="Open Recovery to compare feasible actions", evidence=[f.get("FORECAST_ID")]))
    # ---------------- M10 starvation / blocking, M12 minimum crew, M13 assignment delay
    workers_by_wc = defaultdict(list)
    for w in d.workers:
        if w.get("ATTENDANCE_STATE") == "CLOCKED_IN" and w.get("WORKER_ROLE") == "PRODUCTION_OPERATOR":
            workers_by_wc[w.get("TEMP_WORK_CENTER_ID") or w.get("CURRENT_WORK_CENTER_ID") or w.get("PLANNED_WORK_CENTER_ID")].append(w)
    for wc in CORE_WCS:
        skills = wc_skills(cat, wc)
        waiting = [w for w in workers_by_wc.get(wc, []) if w.get("ACTIVITY_STATE") in ("WAITING", "AVAILABLE") and any(cat.qualified(w["WORKER_ID"], s, d.now) for s in skills)]
        queued = [u for u in d.units if u.get("CURRENT_WORK_CENTER_ID") == wc and u.get("STATE") in ("QUEUED", "QUEUED_FOR_REWORK")]
        stations = cat.stations_of(wc)
        busy_ws = {u.get("CURRENT_WORKSTATION_ID") for u in d.units if u.get("STATE") not in ("QUEUED", "ROUTE_COMPLETE", "SCRAPPED", "IN_TRANSFER")}
        free = [s for s in stations if s["WORKSTATION_ID"] not in busy_ws and not any(e.get("STATUS") == "DOWN" and e["EQUIPMENT_ID"] == s.get("EQUIPMENT_ID") for e in d.equipment)]
        if "M10" in R:
            r = R["M10"]
            since = min([w.get("STATE_SINCE") or d.now for w in waiting] or [d.now])
            starved_min = minutes(since, d.now) if (waiting and free and not queued) else 0
            blocked = [u for u in d.units if u.get("BLOCKED_ARRIVAL") and u.get("TRANSFER_TO_WORK_CENTER_ID") == wc]
            st = "BREACH" if starved_min >= r["threshold"]["min_minutes"] or blocked else "OK"
            out.append(obs(r, "WORK_CENTER", wc, st, actual=round(starved_min, 1), threshold=r["threshold"]["min_minutes"],
                           message=("%s: %d qualified people waiting %.0f min with %d free stations and no released tank - upstream supply, not a performance issue" % (wc, len(waiting), starved_min, len(free))) if starved_min else ("%d arrivals blocked by a full %s queue" % (len(blocked), wc) if blocked else "Supply normal"),
                           evidence=[w["WORKER_ID"] for w in waiting][:10] + [u["UNIT_ID"] for u in blocked], recommended="Fix supply upstream (transfer, relief, replacement); waiting is not underperformance"))
        if "M12" in R:
            r = R["M12"]
            need = max([int(x.get("MIN_CREW_SIZE") or 1) for x in cat.routing if x.get("WORK_CENTER_ID") == wc and x.get("OPERATION_KIND") == "LABOR"] or [1])
            avail = [w for w in workers_by_wc.get(wc, []) if any(cat.qualified(w["WORKER_ID"], s, d.now) for s in skills)]
            ready = [u for u in queued if not u.get("REWORK_PENDING")]
            st = "BREACH" if ready and free and len([w for w in avail if w.get("ACTIVITY_STATE") in ("WAITING", "AVAILABLE")]) < need and len(avail) < need else "OK"
            out.append(obs(r, "WORK_CENTER", wc, st, actual=len(avail), expected=need, message="%s: %d qualified people present for a minimum crew of %d with %d tanks ready" % (wc, len(avail), need, len(ready))))
        if "M13" in R:
            r = R["M13"]
            age = minutes(min([u.get("QUEUE_ENTERED_AT") or d.now for u in queued] or [d.now]), d.now)
            need = 1
            delay = queued and free and len(waiting) >= need and age >= r["threshold"]["assignment_delay_min"]
            out.append(obs(r, "WORK_CENTER", wc, "BREACH" if delay else "OK", actual=round(age, 1), threshold=r["threshold"]["assignment_delay_min"], severity="LOW",
                           message="%s: ready work waiting %.0f min while %d eligible people are available and %d stations are free" % (wc, age, len(waiting), len(free)) if delay else "No assignment delay"))
    if "M13" in R:
        r = R["M13"]
        for w in d.workers:
            c = w.get("CONTROL") or {}
            if c.get("MODE") == "HUMAN" and c.get("LEASE_EXPIRES_AT") and c["LEASE_EXPIRES_AT"] < utcnow() and w.get("CURRENT_TASK_ID") and w.get("ACTIVITY_STATE") == "WORKING":
                out.append(obs(r, "WORKER", w["WORKER_ID"], "NO_DATA", severity="LOW", message="Stale: no signal from %s's device since %s - shown as last known WORKING, not idle" % (w.get("DISPLAY_NAME"), c["LEASE_EXPIRES_AT"].strftime("%H:%M:%S UTC")), stale=True))
    # ---------------- M11 equipment / material interruption
    if "M11" in R:
        r = R["M11"]
        for e in d.equipment:
            if e.get("STATUS") == "DOWN":
                dur = minutes(e.get("SINCE") or d.now, d.now)
                out.append(obs(r, "WORKSTATION", e.get("WORKSTATION_ID") or e["EQUIPMENT_ID"], "BREACH", actual=round(dur, 1), severity="HIGH" if dur > 60 else "MEDIUM",
                               message="%s down %.0f min (%s)%s" % (e["EQUIPMENT_ID"], dur, e.get("REASON_CODE"), "; estimated recovery %s" % to_local(e["ESTIMATED_RECOVERY_AT"]).strftime("%H:%M") if e.get("ESTIMATED_RECOVERY_AT") else ""),
                               recommended="Maintenance; affected crews wait with an external reason (no performance penalty)", evidence=[e["EQUIPMENT_ID"]]))
        for o in d.ops:
            if o.get("BLOCKED_REASON") == "MATERIAL_SHORTAGE" and o.get("STATE") not in ("WORK_COMPLETED", "CANCELLED"):
                out.append(obs(r, "WORKSTATION", o.get("WORKSTATION_ID"), "BREACH", severity="MEDIUM", message="%s blocked by material shortage (%s)" % (o["OPERATION_INSTANCE_ID"], o.get("BLOCKED_MATERIAL_ID")), evidence=[o["OPERATION_INSTANCE_ID"]]))
    # ---------------- F1 stalled active assignment
    if "F1" in R:
        r = R["F1"]; th = r["threshold"]
        for o in d.ops:
            if o.get("OPERATION_KIND") != "LABOR" or o.get("STATE") != "WORKING":
                continue
            crew = len(o.get("CREW") or [])
            el = cat.elapsed_for_crew(o.get("PRODUCT_ID"), o["OPERATION_ID"], max(crew, 1)) if not str(o.get("INSTANCE_TYPE", "")).endswith("REWORK") else float(o.get("REWORK_STANDARD_LABOR_MIN") or 60) / max(crew, 1)
            ms = [m for m in cat.milestones_for(o["OPERATION_ID"], "REWORK" if str(o.get("INSTANCE_TYPE", "")).endswith("REWORK") else "STANDARD") if m.get("ATTENDED") != "N"]
            done = set(o.get("MILESTONES_DONE") or [])
            nxt = next((m for m in ms if m["MILESTONE_ID"] not in done), None)
            if not el or not nxt:
                continue
            prev_th = max([float(m.get("PROGRESS_THRESHOLD") or 0) for m in ms if m["MILESTONE_ID"] in done] or [0])
            expected = (float(nxt.get("PROGRESS_THRESHOLD") or 1) - prev_th) * el
            last = o.get("LAST_MILESTONE_AT") or o.get("STARTED_AT") or d.now
            last = max(last, d.fork) if o.get("ORIGIN") == "INHERITED_AT_FORK" and not o.get("LAST_MILESTONE_AT") else last
            since = minutes(last, d.now)
            b = since >= expected * th["factor"] and since - expected >= th["min_excess_min"]
            out.append(obs(r, "OPERATION", o["OPERATION_INSTANCE_ID"], "BREACH" if b else "OK", actual=round(since, 1), expected=round(expected, 1), threshold="x%s and +%s min" % (th["factor"], th["min_excess_min"]),
                           severity="HIGH" if since >= expected * 2 else "MEDIUM", message="%s on %s: %.0f min since last progress evidence; next milestone '%s' expected after ~%.0f min with crew %d" % (o["OPERATION_ID"], o["UNIT_ID"], since, nxt.get("MILESTONE_NAME"), expected, crew),
                           evidence=[o["OPERATION_INSTANCE_ID"]] + list(o.get("CREW") or []), recommended="Ask the crew whether help or material is needed (fresh activity evidence present; not a break or external hold)"))
    # ---------------- F2 regional workload imbalance
    if "F2" in R and len(AREAS) < 2:
        out.append(obs(R["F2"], "PLANT", "AREAS", "NO_DATA", message="Regional imbalance needs at least two areas; %d configured (not applicable)" % len(AREAS)))
    elif "F2" in R:
        r = R["F2"]; ratios = {}
        for area, wcs in AREAS.items():
            load = sum(sum(M.remaining_std_work(d, wc)) for wc in wcs)
            cap = sum(M.available_labor(d, wc, wc_skills(cat, wc))[0] for wc in wcs)
            ratios[area] = (round(load / cap, 2) if cap > 0 else None, load, cap)
        hi = [a for a, (x, l, c) in ratios.items() if x is not None and x > r["threshold"]["high_ratio"]]
        lo = [a for a, (x, l, c) in ratios.items() if x is not None and x < r["threshold"]["low_ratio"]]
        if any(x is None for x, l, c in ratios.values()):
            out.append(obs(r, "PLANT", "AREAS", "NO_DATA", message="An area has no qualified capacity on shift", sample={a: list(v) for a, v in ratios.items()}))
        else:
            transferable = 0
            if hi and lo:
                skills = [s for wc in AREAS[hi[0]] for s in wc_skills(cat, wc)]
                transferable = sum(1 for wc in AREAS[lo[0]] for w in workers_by_wc.get(wc, []) if any(cat.qualified(w["WORKER_ID"], s, d.now) for s in skills))
            b = bool(hi and lo and transferable >= r.get("min_samples", {}).get("qualified_people", 2))
            out.append(obs(r, "PLANT", "AREAS", "BREACH" if b else "OK", actual={a: v[0] for a, v in ratios.items()}, threshold="%s / %s" % (r["threshold"]["high_ratio"], r["threshold"]["low_ratio"]),
                           message="Load/capacity ratio %s; %d people in the lighter area are qualified for the heavier one" % (", ".join("%s %.2f" % (a, v[0]) for a, v in ratios.items()), transferable), sample={a: {"ratio": v[0], "load_std_min": v[1], "capacity_min": v[2]} for a, v in ratios.items()}))
    # ---------------- F3 material velocity: plant-wide material issues per productive labour hour vs the same ratio in history
    if "F3" in R:
        r = R["F3"]
        start = max(d.now - dt.timedelta(minutes=120), d.fork)          # session part of the window only (history is in the baseline)
        # net issues: an issue reversed as recorded-in-error does not count (the reversal names the issue event)
        reversed_ids = {(e.get("PAYLOAD") or {}).get("REVERSES_EVENT_ID") for e in d.events_window if e["EVENT_TYPE"] == "MATERIAL_ISSUE_REVERSED"}
        issues = sum(1 for e in d.events_window if e["EVENT_TYPE"] == "MATERIAL_CONSUMED" and e["EVENT_TIME"] >= start and e.get("EVENT_ID") not in reversed_ids)
        prod_h = sum(max(0.0, M.minutes(max(s["START_AT"], start), s.get("END_AT") or d.now)) for s in d.segments
                     if s.get("CATEGORY") in ("DIRECT", "REWORK") and (s.get("END_AT") or d.now) > start) / 60
        base = (baselines or {}).get("MATERIAL_ISSUES_PER_PRODUCTIVE_HOUR")
        if prod_h < r.get("min_samples", {}).get("productive_hours", 1):
            out.append(obs(r, "MATERIAL", "PLANT", "INSUFFICIENT_DATA", actual=issues, sample={"productive_hours": round(prod_h, 2)},
                           message="Too little productive labour time in the window (zero demand is not a fault)"))
        elif base is None:
            out.append(obs(r, "MATERIAL", "PLANT", "INSUFFICIENT_DATA", actual=issues, message="No material-issue baseline (issues per productive hour) in eligible prior history"))
        else:
            rate = issues / prod_h
            expected = base * prod_h
            rel = (abs(rate - base) / base * 100) if base > 0 else None
            b = abs(issues - expected) >= r["threshold"]["min_abs"] and (rel is None or rel >= r["threshold"]["rel_pct"])
            out.append(obs(r, "MATERIAL", "PLANT", "BREACH" if b else "OK", actual=round(rate, 3), expected=round(base, 3), delta=round(issues - expected, 1), severity="LOW",
                           sample={"issues": issues, "expected_issues": round(expected, 1), "productive_hours": round(prod_h, 2)},
                           message="%d material issues in %.1f productive labour hours (%.2f/h) vs %.2f/h in history (%.1f expected) - %s" % (
                               issues, prod_h, rate, base, expected, "check kitting / consumption recording" if b else "within the normal range")))
    # ---------------- F4 location velocity (dwell)
    if "F4" in R:
        r = R["F4"]
        for u in d.units:
            if u.get("STATE") not in ("WORKING", "PAUSED", "READY", "REWORK_IN_PROGRESS") or not u.get("CURRENT_WORKSTATION_ID") or not u.get("STATE_SINCE"):
                continue
            wc = u.get("CURRENT_WORK_CENTER_ID")
            base = ((baselines or {}).get("DWELL_MEDIAN_MIN") or {}).get(wc)
            op = next((o for o in d.ops if o["OPERATION_INSTANCE_ID"] == u.get("CURRENT_OPERATION_INSTANCE_ID")), None)
            start = (op or {}).get("STARTED_AT") or u["STATE_SINCE"]
            dwell = minutes(start, d.now)
            if not base:
                continue
            b = dwell >= base * (1 + r["threshold"]["rel_pct"] / 100) and dwell - base >= r["threshold"]["min_abs_min"]
            if b or u.get("_f4_prev"):
                out.append(obs(r, "WORKSTATION", u["CURRENT_WORKSTATION_ID"], "BREACH" if b else "OK", actual=round(dwell, 1), expected=base, severity="LOW",
                               message="%s at %s for %.0f min vs %.0f min median - slow processing at an occupied station (not lack of supply)" % (u["UNIT_ID"], u["CURRENT_WORKSTATION_ID"], dwell, base)))
    # ---------------- F5 congestion (finite queue capacity)
    if "F5" in R:
        r = R["F5"]
        for wc in CORE_WCS:
            cap = (cat.wcs.get(wc) or {}).get("QUEUE_CAPACITY_UNITS")
            queued = sum(1 for u in d.units if u.get("CURRENT_WORK_CENTER_ID") == wc and u.get("STATE") in ("QUEUED", "QUEUED_FOR_REWORK"))
            blocked = sum(1 for u in d.units if u.get("BLOCKED_ARRIVAL") and u.get("TRANSFER_TO_WORK_CENTER_ID") == wc)
            if not cap:
                out.append(obs(r, "WORK_CENTER", wc, "NO_DATA", message="No configured queue capacity - congestion is not claimed"))
                continue
            occ = queued / cap * 100
            out.append(obs(r, "WORK_CENTER", wc, "BREACH" if occ >= r["threshold"]["occupancy_pct"] or blocked else "OK", actual=round(occ, 1), threshold=r["threshold"]["occupancy_pct"],
                           severity="HIGH" if occ >= 100 and blocked else "MEDIUM", message="%s queue %d of %d (%.0f%%)%s" % (wc, queued, cap, occ, "; %d arrivals blocked" % blocked if blocked else "")))
    # ---------------- F6 replenishment delay
    if "F6" in R:
        r = R["F6"]
        for q in d.requests:
            if q.get("STATUS") in ("DELIVERED", "CANCELLED") or not q.get("NEED_BY_AT"):
                continue
            outst = float(q.get("QTY") or 0) - float(q.get("DELIVERED_QTY") or 0)
            late = minutes(q["NEED_BY_AT"], d.now)
            waiting_ops = [o["OPERATION_INSTANCE_ID"] for o in d.ops if o.get("BLOCKED_MATERIAL_ID") == q["MATERIAL_ID"] and o.get("STATE") not in ("WORK_COMPLETED",)]
            b = outst > 0 and late >= r["threshold"]["min_minutes"]
            out.append(obs(r, "MATERIAL_REQUEST", q["REQUEST_ID"], "BREACH" if b else "OK", actual=round(max(late, 0), 1), threshold=r["threshold"]["min_minutes"], severity="HIGH" if waiting_ops else "MEDIUM",
                           message="%s: %s %s outstanding, %.0f min past need-by%s" % (q["REQUEST_ID"], outst, q["MATERIAL_ID"], max(late, 0), "; operations waiting: " + ", ".join(waiting_ops) if waiting_ops else ""), evidence=[q["REQUEST_ID"]] + waiting_ops))
    return out
