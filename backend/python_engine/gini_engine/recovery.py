"""Recovery options for an at-risk order line: candidates are generated from the forecast's limiting constraints, checked for
feasibility (recipient AND donor), simulated through the same route DES and compared with the no-action baseline.

Candidate families: qualified transfer (relief), approved overtime, replacement for scrapped tanks, permitted resequencing,
material expedition, maintenance expedite (advisory only), and combinations (replacement + transfer, transfer + overtime,
resequence + transfer). Infeasible candidates are kept with their rejection reason so the supervisor can see why.
Preview is not execution: nothing here changes operational state.
"""
import datetime as dt
import hashlib
import itertools

from . import forecast as F
from . import variance as V
from .timeutil import minutes, to_local, utcnow

BAND_RANK = {"GREEN": 0, "COMPLETE": 0, "AMBER": 1, "RED": 2, "UNKNOWN": 3}
MAX_TRANSFER_CANDIDATES = 4
RELIEF_LEAD_MIN = 30          # call-in lead time for an off-shift relief worker (demo policy)
OPTION_REPS = 3


def _result(line):
    if not line:
        return None
    return {k: line.get(k) for k in ("BAND", "BAND_REASON", "FORECAST_FINISH_AT", "FORECAST_FINISH_RANGE", "FORECAST_GOOD_BY_DUE", "GOOD_BY_DUE_RANGE", "SHORTFALL", "SLACK_MIN", "BUFFER_DEADLINE_AT", "DUE_AT", "LIMITING_CONSTRAINTS")}


def transfer_rule(cat, frm, to):
    for r in cat.transfer_rules:
        if r.get("FROM_WORK_CENTER_ID") == frm and r.get("TO_WORK_CENTER_ID") == to:
            return r
    return None


def wc_skills(cat, wc):
    return sorted({r["REQUIRED_SKILL_ID"] for r in cat.routing if r.get("WORK_CENTER_ID") == wc and r.get("OPERATION_KIND") == "LABOR" and r.get("REQUIRED_SKILL_ID")})


class Recovery:
    def __init__(self, model, seed, baseline, buffer_min=10):
        self.m, self.cat, self.seed, self.base, self.buffer = model, model.cat, seed, baseline, buffer_min
        self.base_by_line = {l["ORDER_LINE_ID"]: l for l in baseline["lines"]}

    # ---------------------------------------------------------------- donor / recipient checks
    def donor_check(self, w, to_wc):
        """returns (ok, checks[], reason). Recipient: qualification at arrival; donor: minimum crew on its active operation."""
        m, cat, now = self.m, self.cat, self.m.now
        checks = []
        frm = w.get("TEMP_WORK_CENTER_ID") or w.get("CURRENT_WORK_CENTER_ID") or w.get("PLANNED_WORK_CENTER_ID") or w.get("HOME_WORK_CENTER_ID")
        rule = transfer_rule(cat, frm, to_wc)
        travel = float((rule or {}).get("TRAVEL_MIN") or 5) + float((rule or {}).get("HANDOVER_MIN") or 10)
        arrive = now + dt.timedelta(minutes=travel)
        skills = str((rule or {}).get("REQUIRED_SKILL_ID") or "").split("|") if rule and rule.get("REQUIRED_SKILL_ID") else wc_skills(cat, to_wc)
        qual = [s for s in skills if s and cat.qualified(w["WORKER_ID"], s, arrive)]
        checks.append({"check": "RECIPIENT_QUALIFICATION_AT_ARRIVAL", "ok": bool(qual), "detail": "valid %s at %s" % ("/".join(qual), to_local(arrive).strftime("%H:%M")) if qual else "no valid %s at arrival" % "/".join(skills)})
        if w.get("ATTENDANCE_STATE") != "CLOCKED_IN":
            checks.append({"check": "PRESENT", "ok": False, "detail": "not clocked in"})
        else:
            checks.append({"check": "PRESENT", "ok": True, "detail": "clocked in until %s" % (to_local(w["PLANNED_END_AT"]).strftime("%H:%M") if w.get("PLANNED_END_AT") else "?")})
        # a person on a break or already travelling cannot be sent now (WORKER_TRANSFER refuses ON_BREAK / IN_TRANSFER)
        act = w.get("ACTIVITY_STATE")
        checks.append({"check": "AVAILABLE_TO_LEAVE_NOW", "ok": act not in ("BREAK", "TRANSFER"),
                       "detail": {"BREAK": "on a break - transfer after the break", "TRANSFER": "already in transfer"}.get(act, "not on a break or in transfer")})
        rem = minutes(arrive, max([x for x in (w.get("PLANNED_END_AT"), w.get("OVERTIME_UNTIL")) if x] or [now]))
        mind = float((rule or {}).get("MIN_TRANSFER_DURATION_MIN") or 60)
        checks.append({"check": "MINIMUM_USEFUL_DURATION", "ok": rem >= mind, "detail": "%.0f min usable after %.0f min travel/handover (minimum %.0f)" % (max(rem, 0), travel, mind)})
        ctl = (w.get("CONTROL") or {}).get("MODE", "AGENT")
        checks.append({"check": "CONTROL", "ok": ctl in ("AGENT",) or ctl == "HUMAN", "detail": "controlled by %s" % ctl.lower()})
        donor_ok, donor_detail = True, "not working on an operation (waiting/available)"
        task_ops = [t for t in m.tasks if t["WORKER_ID"] == w["WORKER_ID"] and t["STATUS"] == "WORKING"]
        for t in task_ops:
            op = m.ops.get(t["OPERATION_INSTANCE_ID"]) or {}
            crew = [x for x in m.tasks if x["OPERATION_INSTANCE_ID"] == t["OPERATION_INSTANCE_ID"] and x["STATUS"] == "WORKING"]
            minc = int(op.get("MIN_CREW_SIZE") or 1)
            if len(crew) - 1 < minc:
                donor_ok, donor_detail = False, "would leave %s at %s with %d (minimum %d)" % (op.get("OPERATION_ID"), op.get("WORKSTATION_ID"), len(crew) - 1, minc)
            else:
                donor_detail = "%s at %s keeps %d of minimum %d" % (op.get("OPERATION_ID"), op.get("WORKSTATION_ID"), len(crew) - 1, minc)
        checks.append({"check": "DONOR_MINIMUM_CREW", "ok": donor_ok, "detail": donor_detail})
        # donor queue protection: the donor work centre must keep enough qualified people for its queued work's minimum crew
        q_from = [u for u in m.units if u.get("CURRENT_WORK_CENTER_ID") == frm and u.get("STATE") in ("QUEUED", "QUEUED_FOR_REWORK")]
        if q_from:
            skills_from = wc_skills(cat, frm)
            avail = [x for x in m.workers if x["WORKER_ID"] != w["WORKER_ID"] and x.get("ATTENDANCE_STATE") == "CLOCKED_IN" and x.get("WORKER_ROLE") == "PRODUCTION_OPERATOR"
                     and (x.get("TEMP_WORK_CENTER_ID") or x.get("CURRENT_WORK_CENTER_ID") or x.get("PLANNED_WORK_CENTER_ID")) == frm and any(cat.qualified(x["WORKER_ID"], s, now) for s in skills_from)]
            minq = max([int(r.get("MIN_CREW_SIZE") or 1) for r in cat.routing if r.get("WORK_CENTER_ID") == frm and r.get("OPERATION_KIND") == "LABOR"] or [1])
            ok = len(avail) >= minq
            checks.append({"check": "DONOR_QUEUE_COVERAGE", "ok": ok, "detail": "%s keeps %d qualified people for %d queued tank(s) (minimum crew %d)" % (frm, len(avail), len(q_from), minq)})
        bad = [c for c in checks if not c["ok"]]
        return (not bad), checks, ("; ".join("%s: %s" % (c["check"], c["detail"]) for c in bad) or None), {"from": frm, "travel": travel, "arrive": arrive, "rule": rule}

    # ---------------------------------------------------------------- candidate generation
    def candidates(self, line):
        m, cat = self.m, self.cat
        lid = line["ORDER_LINE_ID"]
        out = []
        cons = [c for c in (line.get("LIMITING_CONSTRAINTS") or [])]
        target_wcs = [c["at"] for c in cons if c["constraint"] in ("QUALIFIED_LABOUR", "BELOW_MIN_CREW") and c["at"] in V.CORE_WCS]
        # always consider the work centre where the line's earliest unfinished tanks sit
        for u in sorted([u for u in m.units if u.get("ORDER_LINE_ID") == lid], key=lambda u: u.get("ROUTE_STEP") or ""):
            if u.get("CURRENT_WORK_CENTER_ID") in V.CORE_WCS and u["CURRENT_WORK_CENTER_ID"] not in target_wcs:
                target_wcs.append(u["CURRENT_WORK_CENTER_ID"])
        target_wcs = target_wcs[:2]
        # -------- transfers
        transfers = []
        for wc in target_wcs:
            pool = []
            for w in m.workers:
                if w.get("WORKER_ROLE") != "PRODUCTION_OPERATOR" or w.get("ATTENDANCE_STATE") != "CLOCKED_IN":
                    continue
                frm = w.get("TEMP_WORK_CENTER_ID") or w.get("CURRENT_WORK_CENTER_ID") or w.get("PLANNED_WORK_CENTER_ID")
                if frm == wc:
                    continue
                if not any(cat.qualified(w["WORKER_ID"], s, m.now) for s in wc_skills(cat, wc)):
                    continue
                idle = w.get("ACTIVITY_STATE") in ("WAITING", "AVAILABLE")
                pool.append((0 if idle else 1, frm != V.release_wc(), w["WORKER_ID"], w))
            pool.sort(key=lambda x: x[:3])
            for _, _, wid, w in pool[: MAX_TRANSFER_CANDIDATES + 2]:
                ok, checks, reason, info = self.donor_check(w, wc)
                step = {"type": "TRANSFER", "workerId": wid, "workerName": w.get("DISPLAY_NAME"), "fromWorkCenterId": info["from"], "toWorkCenterId": wc,
                        "travelHandoverMin": info["travel"], "plannedArrivalAt": info["arrive"], "plannedReturnAt": w.get("PLANNED_END_AT")}
                ov = {"transfers": [{"workerId": wid, "toWorkCenterId": wc, "arriveAt": info["arrive"], "travelMin": info["travel"]}]}
                transfers.append({"family": "TRANSFER", "desc": "Transfer %s (%s) from %s to %s for the rest of the shift (%.0f min travel + handover)" % (w.get("DISPLAY_NAME"), wid, info["from"], wc, info["travel"]),
                                  "steps": [step], "ov": ov, "feasible": ok, "checks": checks, "reason": reason, "donor_wc": info["from"]})
        feasible_tr = [t for t in transfers if t["feasible"]][:MAX_TRANSFER_CANDIDATES]
        out += feasible_tr + [t for t in transfers if not t["feasible"]][:3]
        # -------- overtime for people at the constrained work centre
        ot_people = [w for w in m.workers if w.get("WORKER_ROLE") == "PRODUCTION_OPERATOR" and w.get("ATTENDANCE_STATE") == "CLOCKED_IN"
                     and (w.get("TEMP_WORK_CENTER_ID") or w.get("CURRENT_WORK_CENTER_ID") or w.get("PLANNED_WORK_CENTER_ID")) in target_wcs[:1]][:4]
        if ot_people:
            mins = 120
            steps = [{"type": "OVERTIME", "workerId": w["WORKER_ID"], "workerName": w.get("DISPLAY_NAME"), "minutes": mins} for w in ot_people]
            out.append({"family": "OVERTIME", "desc": "Approve %d min overtime for %d people at %s (does not move the customer due time)" % (mins, len(ot_people), target_wcs[0]),
                        "steps": steps, "ov": {"overtime": [{"workerId": s["workerId"], "minutes": mins} for s in steps]}, "feasible": True,
                        "checks": [{"check": "OVERTIME_APPROVAL", "ok": True, "detail": "requires supervisor approval; capped at 120 min per person in the demo policy"}], "reason": None})
        # -------- replacements for scrapped tanks without replacement
        scrapped = list(m.db.sim_units.find({"SESSION_ID": m.s["SESSION_ID"], "ORDER_LINE_ID": lid, "STATE": "SCRAPPED", "REPLACED_BY_UNIT_ID": None}, {"UNIT_ID": 1, "PRODUCT_ID": 1}))
        pending = {r.get("SCRAPPED_UNIT_ID") for r in m.db.sim_replacements.find({"SESSION_ID": m.s["SESSION_ID"], "STATUS": {"$in": ["REQUESTED", "APPROVED", "BLOCKED"]}})}
        scrapped = [s for s in scrapped if s["UNIT_ID"] not in pending]
        if scrapped:
            steps = [{"type": "REPLACEMENT", "scrappedUnitId": s["UNIT_ID"]} for s in scrapped[:3]]
            mat_ok = all(self._material_for(s["PRODUCT_ID"]) for s in scrapped[:3])
            out.append({"family": "REPLACEMENT", "desc": "Release %d replacement tank(s) with new UNIT_IDs for scrapped %s (satisfies existing demand, priority class 1)" % (len(steps), ", ".join(s["UNIT_ID"] for s in scrapped[:3])),
                        "steps": steps, "ov": {"replacements": [{"orderLineId": lid, "productId": s["PRODUCT_ID"]} for s in scrapped[:3]]}, "feasible": mat_ok,
                        "checks": [{"check": "MATERIAL_FOR_REPLACEMENT", "ok": mat_ok, "detail": "first-operation kit available" if mat_ok else "first-operation kit short - expedite first"}],
                        "reason": None if mat_ok else "Material for the replacement's first operation is short"})
        # -------- resequencing (raise this line's queued tanks to class 2 -> ahead of normal work)
        queued = [u for u in m.units if u.get("ORDER_LINE_ID") == lid and u.get("STATE") in ("QUEUED",) and (u.get("PRIORITY_CLASS") or 3) > 2]
        if queued:
            steps = [{"type": "RESEQUENCE", "unitId": u["UNIT_ID"], "priorityClass": 2} for u in queued[:6]]
            out.append({"family": "RESEQUENCE", "desc": "Resequence %d queued tank(s) of %s ahead of normal-priority work (DR-1.0 class 2)" % (len(steps), lid), "steps": steps,
                        "ov": {"priority": {s["unitId"]: 2 for s in steps}}, "feasible": True, "checks": [{"check": "PERMITTED_RESEQUENCING", "ok": True, "detail": "rework and replacements (class 1) keep precedence"}], "reason": None})
        # -------- material expedite
        if any(c["constraint"] == "MATERIAL" for c in cons):
            for r in cat.mat_reqs:
                if r["PRODUCT_ID"] == line.get("PRODUCT_ID"):
                    mm = m.materials.get(r["MATERIAL_ID"]) or {}
                    avail = float(mm.get("ON_HAND_QTY") or 0) - float(mm.get("HOLD_QTY") or 0) - float(mm.get("RESERVED_QTY") or 0)
                    if avail < float(r.get("QTY_PER_UNIT") or 0) * 2:
                        qty = float(r.get("QTY_PER_UNIT") or 1) * 4
                        out.append({"family": "MATERIAL_EXPEDITE", "desc": "Expedite %s x%s (promised in 30 min)" % (r["MATERIAL_ID"], qty),
                                    "steps": [{"type": "MATERIAL_EXPEDITE", "materialId": r["MATERIAL_ID"], "qty": qty, "needByMin": 30, "promisedMin": 30}],
                                    "ov": {"expedites": [{"materialId": r["MATERIAL_ID"], "qty": qty, "at": m.now + dt.timedelta(minutes=30)}]}, "feasible": True, "checks": [], "reason": None})
        # -------- maintenance expedite (advisory)
        for e in m.equipment.values():
            if e.get("STATUS") == "DOWN" and e.get("WORK_CENTER_ID") in target_wcs:
                at = m.now + dt.timedelta(minutes=30)
                out.append({"family": "MAINTENANCE", "desc": "Expedite repair of %s (advisory: assumes recovery in 30 min)" % e["EQUIPMENT_ID"], "steps": [{"type": "MAINTENANCE_EXPEDITE", "equipmentId": e["EQUIPMENT_ID"]}],
                            "ov": {"repairs": {e["EQUIPMENT_ID"]: at}}, "feasible": True, "advisory": True,
                            "checks": [{"check": "EXECUTABLE", "ok": False, "detail": "maintenance scheduling is outside the demo command set - record the decision; repair is confirmed by EQUIPMENT_REPAIRED"}], "reason": None})
        # -------- relief worker: a qualified person who is off shift (not absent, not human-controlled) is called in for the
        # constrained work centre; arrives after the call-in lead time and works until the current shift ends
        lead = float(RELIEF_LEAD_MIN)
        sh_end = max([w.get("PLANNED_END_AT") for w in m.workers if w.get("ATTENDANCE_STATE") == "CLOCKED_IN" and w.get("PLANNED_END_AT")] or [m.now + dt.timedelta(hours=4)])
        for wc in target_wcs[:1]:
            reliefs = []
            for w in m.workers:
                if w.get("WORKER_ROLE") != "PRODUCTION_OPERATOR" or w.get("ATTENDANCE_STATE") not in ("OFF_SHIFT", "NOT_CLOCKED_IN", "CLOCKED_OUT", "NOT_RECORDED"):
                    continue
                if (w.get("CONTROL") or {}).get("MODE", "AGENT") != "AGENT" or not any(cat.qualified(w["WORKER_ID"], sk, m.now) for sk in wc_skills(cat, wc)):
                    continue
                reliefs.append(w)
            reliefs.sort(key=lambda w: (0 if (w.get("HOME_WORK_CENTER_ID") == wc) else 1, w["WORKER_ID"]))
            for w in reliefs[:2]:
                arrive = m.now + dt.timedelta(minutes=lead)
                usable = minutes(arrive, sh_end)
                ok = usable >= 60
                step = {"type": "RELIEF_CALL_IN", "workerId": w["WORKER_ID"], "workerName": w.get("DISPLAY_NAME"), "toWorkCenterId": wc, "plannedArrivalAt": arrive, "until": sh_end}
                out.append({"family": "RELIEF_WORKER", "desc": "Call in %s (%s, off shift, qualified) as relief at %s from %s for %.0f min" % (w.get("DISPLAY_NAME"), w["WORKER_ID"], wc, to_local(arrive).strftime("%H:%M"), max(usable, 0)),
                            "steps": [step], "ov": {"reliefs": [{"workerId": w["WORKER_ID"], "toWorkCenterId": wc, "from": arrive, "until": sh_end}]}, "feasible": ok,
                            "checks": [{"check": "QUALIFIED", "ok": True, "detail": "valid qualification for %s" % wc}, {"check": "NOT_ABSENT_NOT_HUMAN_CONTROLLED", "ok": True, "detail": "off shift, agent-controlled"},
                                       {"check": "MINIMUM_USEFUL_DURATION", "ok": ok, "detail": "%.0f min usable after a %.0f min call-in lead (minimum 60)" % (max(usable, 0), lead)},
                                       {"check": "OVERTIME_POLICY", "ok": True, "detail": "paid as a call-in; needs supervisor approval"}],
                            "reason": None if ok else "Less than 60 min usable before the shift ends"})
        # -------- combinations
        singles = [c for c in out if c["feasible"] and not c.get("advisory")]
        best_tr = [c for c in singles if c["family"] == "TRANSFER"][:2]
        for a in [c for c in singles if c["family"] in ("REPLACEMENT", "OVERTIME", "RESEQUENCE")]:
            for b in best_tr:
                out.append(self._combine(a, b))
        if len(best_tr) == 2 and best_tr[0]["steps"][0]["workerId"] != best_tr[1]["steps"][0]["workerId"]:
            out.append(self._combine(best_tr[0], best_tr[1]))
        return out

    def _material_for(self, product):
        route = self.cat.route(product)
        if not route:
            return False
        first = route[0]
        for r in self.cat.mat_reqs:
            if r["PRODUCT_ID"] == product and r.get("CONSUMED_AT_OPERATION_ID") == first:
                mm = self.m.materials.get(r["MATERIAL_ID"]) or {}
                if float(mm.get("ON_HAND_QTY") or 0) - float(mm.get("HOLD_QTY") or 0) - float(mm.get("RESERVED_QTY") or 0) < float(r.get("QTY_PER_UNIT") or 0):
                    return False
        return True

    def _combine(self, a, b):
        ov = {}
        for x in (a["ov"], b["ov"]):
            for k, v in x.items():
                if isinstance(v, list):
                    ov.setdefault(k, []).extend(v)
                else:
                    ov.setdefault(k, {}).update(v)
        return {"family": a["family"] + "+" + b["family"], "desc": a["desc"] + "  +  " + b["desc"], "steps": a["steps"] + b["steps"], "ov": ov,
                "feasible": a["feasible"] and b["feasible"], "checks": a["checks"] + b["checks"], "reason": a["reason"] or b["reason"], "donor_wc": b.get("donor_wc") or a.get("donor_wc")}

    # ---------------------------------------------------------------- evaluation
    def evaluate(self, line):
        lid = line["ORDER_LINE_ID"]
        cands = self.candidates(line)
        options = []
        for i, c in enumerate(cands):
            opt = {"OPTION_ID": "OPT-%02d" % (i + 1), "ACTION_TYPE": c["family"], "DESCRIPTION": c["desc"], "STEPS": c["steps"], "FEASIBLE": c["feasible"],
                   "REJECTION_REASON": c["reason"], "CHECKS": c["checks"], "ADVISORY": bool(c.get("advisory")), "RESULT": None, "DONOR_IMPACT": [], "ASSUMPTIONS": [], "CONFIDENCE": None}
            if c["feasible"]:
                res = F.run_forecast(self.m, self.seed, c["ov"], reps=OPTION_REPS, buffer_min=self.buffer)
                by = {l["ORDER_LINE_ID"]: l for l in res["lines"]}
                opt["RESULT"] = _result(by.get(lid))
                for ol, bl in self.base_by_line.items():
                    if ol == lid or ol not in by:
                        continue
                    nl = by[ol]
                    worse_band = BAND_RANK.get(nl["BAND"], 3) > BAND_RANK.get(bl["BAND"], 3)
                    delay = minutes(bl["FORECAST_FINISH_AT"], nl["FORECAST_FINISH_AT"]) if (bl.get("FORECAST_FINISH_AT") and nl.get("FORECAST_FINISH_AT")) else 0
                    if worse_band or delay > 15 or (nl.get("FORECAST_GOOD_BY_DUE") or 0) < (bl.get("FORECAST_GOOD_BY_DUE") or 0):
                        opt["DONOR_IMPACT"].append({"orderLineId": ol, "bandBefore": bl["BAND"], "bandAfter": nl["BAND"], "finishDelayMin": round(delay), "goodByDueBefore": bl.get("FORECAST_GOOD_BY_DUE"), "goodByDueAfter": nl.get("FORECAST_GOOD_BY_DUE")})
                if any(d["bandAfter"] == "RED" and d["bandBefore"] != "RED" for d in opt["DONOR_IMPACT"]):
                    opt["FEASIBLE"] = False
                    opt["REJECTION_REASON"] = "Source-damaging: pushes %s to RED" % ", ".join(d["orderLineId"] for d in opt["DONOR_IMPACT"] if d["bandAfter"] == "RED")
                opt["ASSUMPTIONS"] = ["Transfer travel/handover from TRANSFER_RULES; qualification checked at arrival", "Crew elapsed from CREW_CAPACITY_RULES (non-linear)",
                                      "Gate failures drawn from first-attempt fail rates known at the fork (%d replications)" % OPTION_REPS] + (["Advisory: repair time assumed, not commanded"] if c.get("advisory") else [])
                rng = (opt["RESULT"] or {}).get("FORECAST_FINISH_RANGE")
                spread = minutes(rng[0], rng[1]) if rng else None
                opt["CONFIDENCE"] = "LOW" if spread is None else ("HIGH" if spread <= 30 else "MEDIUM" if spread <= 120 else "LOW")
            options.append(opt)
        base = _result(self.base_by_line.get(lid))

        def score(o):
            r = o.get("RESULT") or {}
            fin = r.get("FORECAST_FINISH_AT") or dt.datetime.max
            return (0 if o["FEASIBLE"] else 1, 1 if o["ADVISORY"] else 0, BAND_RANK.get(r.get("BAND"), 4), r.get("SHORTFALL") or 0, fin, len(o["DONOR_IMPACT"]), len(o["STEPS"]))
        options.sort(key=score)
        # the explicit no-action option: always present, feasible, and identical to the baseline, so "do nothing" is a recorded decision
        options.append({"OPTION_ID": "OPT-NA", "ACTION_TYPE": "NO_ACTION", "DESCRIPTION": "No action - continue as planned and monitor (baseline forecast)", "STEPS": [], "FEASIBLE": True,
                        "REJECTION_REASON": None, "CHECKS": [{"check": "BASELINE", "ok": True, "detail": "same simulation as the no-action baseline"}], "ADVISORY": False, "RESULT": base,
                        "DONOR_IMPACT": [], "ASSUMPTIONS": ["Nothing changes except recorded events"], "CONFIDENCE": None})
        for i, o in enumerate(options):
            o["RANK"] = i + 1
            r = o.get("RESULT") or {}
            if o["FEASIBLE"] and base:
                o["BENEFIT"] = {"bandChange": "%s -> %s" % (base.get("BAND"), r.get("BAND")),
                                "finishGainMin": round(minutes(r["FORECAST_FINISH_AT"], base["FORECAST_FINISH_AT"])) if (r.get("FORECAST_FINISH_AT") and base.get("FORECAST_FINISH_AT")) else None,
                                "goodByDueGain": (r.get("FORECAST_GOOD_BY_DUE") or 0) - (base.get("FORECAST_GOOD_BY_DUE") or 0)}
                o["IMPROVES"] = BAND_RANK.get(r.get("BAND"), 4) < BAND_RANK.get(base.get("BAND"), 4) or (o["BENEFIT"]["goodByDueGain"] or 0) > 0 or (o["BENEFIT"]["finishGainMin"] or 0) > 10
        return base, options


def build_doc(session, line_id, as_of, watermark, base, options, notes, engine_version, rule_version):
    key = "%s|%s|%s|%s" % (session["SESSION_ID"], line_id, as_of.isoformat(), watermark)
    real = [o for o in options if o["ACTION_TYPE"] != "NO_ACTION"]
    feas = [o for o in real if o["FEASIBLE"] and not o.get("ADVISORY")]
    why = sorted({o["REJECTION_REASON"] for o in real if o.get("REJECTION_REASON")})[:6]
    summary = ("%d feasible option(s) using existing people, stations, overtime and materials" % len(feas)) if feas else \
        ("No feasible option: " + ("; ".join(why) if why else "no qualified clocked-in person to transfer, no overtime candidate, no replacement material and no permitted resequencing beyond the current plan"))
    return {"FEASIBILITY_SUMMARY": summary, "FEASIBLE_COUNT": len(feas),
            "FORECAST_ID": "RFC-" + hashlib.sha1(key.encode()).hexdigest()[:12].upper(), "SESSION_ID": session["SESSION_ID"], "ORDER_LINE_ID": line_id, "AS_OF": as_of,
            "CREATED_AT": utcnow(), "KNOWN_AT": as_of, "BASELINE": base, "OPTIONS": options, "INPUT_WATERMARK": watermark, "ENGINE_VERSION": engine_version, "RULE_VERSION": rule_version,
            "NOTES": notes, "METHOD": "No-action baseline vs candidate actions through the same route DES (%d replications per option); donor work centres and other order lines re-forecast" % OPTION_REPS,
            "IMMUTABLE": True, "_origin": "APP"}
