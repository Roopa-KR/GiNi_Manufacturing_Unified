"""Points rules on the append-only session ledger (sim_points_ledger), re-evaluated subject by subject.

Rules (RULE_VERSION 2.0; the source workbook's history rows keep their own RULE_VERSION 1.0 and whole-point TV1 values):
  PTS-TV1  STANDARD_ALLOWANCE - ACTUAL_ELIGIBLE_MINUTES per released labour attempt, to 2 decimals. A crew shares ONE allowance by
           eligible-minute shares (the allowance is split, never granted to each member); exact residual allocation keeps the crew
           total equal to the attempt total (90 std / 84 actual -> +6.00 in total). Eligible minutes exclude breaks, external blocking,
           material/equipment waits, transfers/handovers and curing. Inspection attempts are never time-scored (no incentive to rush an
           inspection). Rework attempts are scored only against an APPROVED rework standard (named approver, version, effective
           date: rework_standards); a planning value is never treated as approved - without an approved standard the attempt stays
           PENDING. Two attempt adjustments beyond the client formula exist ONLY as versioned points-policy switches that are OFF
           until a named person confirms a policy version (points_policy_versions):
             withdraw_positive_time_on_confirmed_workmanship_defect, waive_negative_time_on_confirmed_equipment_cause.
  PTS-NR3  +3 per completed WO with no rework / scrap / FAIL hold / downstream defect on any of its tanks.
  PTS-OF2  +2 per completed WO with a defect caught and corrected at its origin station, no downstream defect, no scrap.
           Mutually exclusive with NR3.
  PTS-DD4  -4 per distinct downstream defect (exact DEFECT_ID), only after a named reviewer CONFIRMED a WORKER cause; split by the
           confirmed shares. Unknown / suspected / non-worker / closed-unresolved causes book nothing.

Re-evaluation (subject = TV1|<attempt>, WO|<order>, DD4|<defect>):
  * every pass re-evaluates subjects that are new, still PENDING, or whose tank was touched by an event since the last pass
    (and everything after an engine restart). The evaluation and its evidence are stored in sim_points_evaluations.
  * the desired allocation is compared with what is currently booked for the subject (history ledger before the fork + session
    ledger). Unchanged evidence posts nothing. A change posts, per affected worker, a REVERSAL row that names the transaction(s) it
    reverses plus a new revision row; nothing is ever edited or deleted.
  * a revision is written in one transaction with deterministic IDs (AWARD_KEY = SUBJECT|R<n> / SUBJECT|X<n>,
    POINTS_TRANSACTION_ID = hash(AWARD_KEY, worker)), so a retry, a restart or a second engine can never post it twice.
"""
import hashlib
import json
import os
from collections import defaultdict

from .allocation import allocate
from .timeutil import utcnow

RULE_VERSION = "2.0"
TV1_PRECISION = 2
WO_RULES = ("PTS-NR3", "PTS-OF2")
_POLICY_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "config", "points_policy.json")


def load_policy(db):
    """the effective points policy: the newest confirmed version in points_policy_versions whose EFFECTIVE_FROM has passed
    (application time, like rule settings), else the shipped config/points_policy.json (client formula, adjustments OFF).
    Returns (policy dict, key, meta)."""
    rows = []
    try:
        rows = list(db.points_policy_versions.find({"EFFECTIVE_FROM": {"$lte": utcnow()}, "STATUS": {"$ne": "WITHDRAWN"}}).sort([("VERSION_NO", -1)]).limit(1))
    except Exception:
        rows = []
    if rows and rows[0].get("POLICY"):
        r = rows[0]
        return r["POLICY"], "P%s" % r["VERSION_NO"], {"version": r["VERSION_NO"], "confirmedBy": r.get("CONFIRMED_BY"), "confirmedAt": r.get("CONFIRMED_AT"), "hash": r.get("POLICY_HASH")}
    with open(_POLICY_FILE) as f:
        pol = json.load(f)
    return pol, "config-%s" % pol.get("version"), {"version": None, "confirmedBy": None, "confirmedAt": None, "hash": None}


def adjustments(policy):
    a = (policy or {}).get("attempt_adjustments") or {}
    return {"withdraw_positive": bool(a.get("withdraw_positive_time_on_confirmed_workmanship_defect")),
            "waive_negative": bool(a.get("waive_negative_time_on_confirmed_equipment_cause"))}


def tv1_split(allowance_min, eligible_by_worker, precision=TV1_PRECISION):
    """{worker: points} for one attempt: crew total = allowance - actual eligible minutes, split by eligible-minute shares with exact
    residual allocation. None when there are no eligible minutes (stays pending)."""
    elig = {w: float(m) for w, m in (eligible_by_worker or {}).items() if m and float(m) > 0}
    actual = sum(elig.values())
    if actual <= 0:
        return None
    total = float(allowance_min) - actual
    if round(total, precision) == 0:
        return {w: 0.0 for w in elig}
    return allocate(total, elig, precision=precision)


def txn_id(short, award_key, worker):
    return "PTS-%s-%s" % (short, hashlib.sha1(("%s|%s" % (award_key, worker)).encode()).hexdigest()[:12].upper())


def _is_dup(e):
    return getattr(e, "code", None) == 11000 or "E11000" in str(e) or "uplicate" in str(e)


class PointsEngine:
    def __init__(self, db, cat, session, calc_id=None):
        self.db, self.cat, self.s = db, cat, session
        self.sid, self.src, self.fork = session["SESSION_ID"], session["SOURCE_RUN_ID"], session["FORK_AT"]
        self.short = session.get("SHORT_ID") or self.sid[-6:]
        self.calc_id = calc_id or "PTSCALC-%s-%s" % (self.short, utcnow().strftime("%Y%m%dT%H%M%S%f"))
        self.stats = defaultdict(int)
        self.policy, self.policy_key, self.policy_meta = load_policy(db)
        self.adj = adjustments(self.policy)

    # ================================================================ ledger reconciliation
    def booked(self, subject, hist_filter):
        """active (not yet reversed) rows for the subject: history rows known at the fork + session rows"""
        rows = []
        if hist_filter:
            for r in self.db.points_ledger.find(dict({"RUN_ID": self.src, "KNOWN_AT": {"$lte": self.fork}}, **hist_filter)):
                rows.append(dict(r, _SRC="HISTORY"))
        rows += [dict(r, _SRC="SESSION") for r in self.db.sim_points_ledger.find({"SESSION_ID": self.sid, "SUBJECT_KEY": subject})]
        reversed_ids = set()
        for r in rows:
            reversed_ids.update(r.get("REVERSES_TRANSACTION_IDS") or [])
            if r.get("REVERSAL_OF_ID"):
                reversed_ids.add(r["REVERSAL_OF_ID"])
        active = [r for r in rows if r["POINTS_TRANSACTION_ID"] not in reversed_ids and not r.get("REVERSES_TRANSACTION_IDS") and not r.get("REVERSAL_OF_ID")
                  and r.get("POINTS_DELTA")]
        revision = max([int(r.get("REVISION") or 0) for r in rows if r["_SRC"] == "SESSION"] or [0])
        return active, revision

    @staticmethod
    def net(active):
        out = defaultdict(lambda: {"points": 0.0, "rules": set(), "ids": []})
        for r in sorted(active, key=lambda r: (r.get("KNOWN_AT") or r.get("CREATED_AT"), r["POINTS_TRANSACTION_ID"])):
            o = out[r["WORKER_ID"]]
            o["points"] = round(o["points"] + float(r["POINTS_DELTA"]), 2)
            o["rules"].add(r.get("RULE_ID"))
            o["ids"].append(r["POINTS_TRANSACTION_ID"])
        return out

    def reconcile(self, subject, hist_filter, want, rule, now, event_time, refs, status_label, note, evidence_ref):
        """want: {worker: points} for `rule` (None = leave whatever is booked). Posts the minimal reversal + revision rows."""
        active, revision = self.booked(subject, hist_filter)
        cur = self.net(active)
        if want is None:
            return {w: v["points"] for w, v in cur.items()}, 0
        want = {w: round(float(p), 2) for w, p in want.items() if round(float(p), 2) != 0}
        changed = sorted(w for w in set(cur) | set(want)
                         if round(cur[w]["points"] if w in cur else 0.0, 2) != want.get(w, 0.0) or (w in want and w in cur and cur[w]["rules"] != {rule}))
        if not changed:
            return {w: v["points"] for w, v in cur.items() if v["points"]}, 0
        n = revision + 1
        base = {"SESSION_ID": self.sid, "RUN_ID": self.s["RUN_ID"], "DATASET_ID": self.s["DATASET_ID"], "SUBJECT_KEY": subject, "REVISION": n, "RULE_VERSION": RULE_VERSION,
                "CALCULATION_ID": self.calc_id, "KNOWN_AT": now, "CREATED_AT": utcnow(), "ALLOCATION_POLICY": self.policy_key,
                "ALLOCATION_POLICY_STATUS": "CONFIRMED" if self.policy_meta.get("confirmedBy") else "SHIPPED_DEFAULT_NOT_CONFIRMED", "_origin": "APP"}
        base.update(refs)
        rows = []
        for w in changed:
            if w in cur and cur[w]["points"]:
                key = "%s|X%d" % (subject, n)
                rows.append(dict(base, AWARD_KEY=key, WORKER_ID=w, POINTS_TRANSACTION_ID=txn_id(self.short, key, w), ENTRY_TYPE="REVERSAL",
                                 RULE_ID=sorted(r for r in cur[w]["rules"] if r)[0] if any(cur[w]["rules"]) else rule, POINTS_CATEGORY=refs.get("POINTS_CATEGORY"),
                                 POINTS_DELTA=-cur[w]["points"], EVENT_TIME=now, ATTRIBUTION_STATUS="REVERSED_CORRECTED_EVIDENCE",
                                 REVERSES_TRANSACTION_IDS=cur[w]["ids"], REVERSAL_OF_ID=cur[w]["ids"][-1],
                                 CALCULATION_NOTE="Reverses %s after re-evaluation (%s); the original rows are kept" % (", ".join(cur[w]["ids"]), note),
                                 EVIDENCE_REFERENCE=evidence_ref))
            if want.get(w):
                key = "%s|R%d" % (subject, n)
                rows.append(dict(base, AWARD_KEY=key, WORKER_ID=w, POINTS_TRANSACTION_ID=txn_id(self.short, key, w), ENTRY_TYPE="AWARD" if want[w] > 0 else "DEDUCTION",
                                 RULE_ID=rule, POINTS_DELTA=want[w], EVENT_TIME=event_time, ATTRIBUTION_STATUS=status_label, REVERSES_TRANSACTION_IDS=None, REVERSAL_OF_ID=None,
                                 SUPERSEDES_TRANSACTION_IDS=cur[w]["ids"] if w in cur else [], CALCULATION_NOTE=note, EVIDENCE_REFERENCE=evidence_ref))
        posted = self._insert_atomic(rows)
        if posted:
            self.stats["revisions"] += 1
            self.stats["reversals"] += sum(1 for r in rows if r["ENTRY_TYPE"] == "REVERSAL")
        return want, posted

    def _insert_atomic(self, rows):
        """one revision = one transaction; a duplicate revision (retry / second engine) aborts the whole revision"""
        client = getattr(self.db, "client", None)
        try:
            if client is not None and hasattr(client, "start_session"):
                with client.start_session() as s:
                    s.with_transaction(lambda ss: self.db.sim_points_ledger.insert_many(rows, ordered=True, session=ss))
            else:
                self.db.sim_points_ledger.insert_many(rows, ordered=True)
            return len(rows)
        except Exception as e:
            if _is_dup(e):
                self.stats["duplicate_revisions_skipped"] += 1
                return 0
            raise

    def save_evaluation(self, subject, family, status, rule, want, booked, evidence, refs, reason, now):
        h = hashlib.sha256(json.dumps({"s": status, "r": rule, "w": want, "e": evidence}, sort_keys=True, default=str).encode()).hexdigest()
        doc = {"SESSION_ID": self.sid, "RUN_ID": self.s["RUN_ID"], "DATASET_ID": self.s["DATASET_ID"], "SUBJECT_KEY": subject, "RULE_FAMILY": family, "STATUS": status,
               "RULE_ID": rule, "RULE_VERSION": RULE_VERSION, "REASON": reason, "DESIRED_ALLOCATION": want, "BOOKED_NET": booked, "EVIDENCE": evidence, "EVIDENCE_HASH": h,
               "CALCULATION_ID": self.calc_id, "AS_OF": now, "COMPUTED_AT": utcnow(), "POLICY_KEY": self.policy_key, "POLICY": self.policy_meta, "_origin": "APP"}
        doc.update(refs)
        self.db.sim_points_evaluations.update_one({"SESSION_ID": self.sid, "SUBJECT_KEY": subject},
                                                  {"$set": doc, "$setOnInsert": {"FIRST_EVALUATED_AT": utcnow()}, "$inc": {"EVALUATION_COUNT": 1}}, upsert=True)
        self.stats[family + "_" + status] += 1

    # ================================================================ dirty set
    def _state(self):
        return self.db.sim_points_evaluations.find_one({"SESSION_ID": self.sid, "SUBJECT_KEY": "__STATE__"}) or {}

    def dirty_units(self, since_seq, upto_seq):
        units, invs = set(), set()
        for e in self.db.sim_events.find({"SESSION_ID": self.sid, "EVENT_SEQ": {"$gt": since_seq, "$lte": upto_seq}}, {"ENTITY_TYPE": 1, "ENTITY_ID": 1, "PAYLOAD.UNIT_ID": 1}):
            if e.get("ENTITY_TYPE") == "UNIT":
                units.add(e["ENTITY_ID"])
            elif e.get("ENTITY_TYPE") == "INVESTIGATION":
                invs.add(e["ENTITY_ID"])
            u = (e.get("PAYLOAD") or {}).get("UNIT_ID")
            if u:
                units.add(u)
        if invs:
            units |= set(self.db.sim_investigations.distinct("UNIT_ID", {"SESSION_ID": self.sid, "INVESTIGATION_ID": {"$in": sorted(invs)}}))
        return units

    def pending_subjects(self, family):
        return {d["SUBJECT_KEY"] for d in self.db.sim_points_evaluations.find({"SESSION_ID": self.sid, "RULE_FAMILY": family, "STATUS": "PENDING"}, {"SUBJECT_KEY": 1})}

    def evaluated(self, family):
        return {d["SUBJECT_KEY"] for d in self.db.sim_points_evaluations.find({"SESSION_ID": self.sid, "RULE_FAMILY": family}, {"SUBJECT_KEY": 1})}

    # ================================================================ eligible minutes
    def eligible_minutes(self, op_id):
        out = defaultdict(float)
        for s in self.db.labor_segments.find({"RUN_ID": self.src, "OPERATION_INSTANCE_ID": op_id, "SEGMENT_START": {"$lt": self.fork}},
                                             {"WORKER_ID": 1, "SEGMENT_START": 1, "SEGMENT_END": 1, "SEGMENT_PHASE": 1, "TIME_POINTS_ELIGIBLE_SEGMENT": 1}):
            if s.get("TIME_POINTS_ELIGIBLE_SEGMENT") in ("N", False) or s.get("SEGMENT_PHASE") not in ("NORMAL", "REWORK", "CORRECTION"):
                continue
            end = min(s["SEGMENT_END"], self.fork)
            out[s["WORKER_ID"]] += max(0.0, (end - s["SEGMENT_START"]).total_seconds() / 60)
        excluded = defaultdict(float)
        for s in self.db.sim_participation.find({"SESSION_ID": self.sid, "OPERATION_INSTANCE_ID": op_id}):
            if s.get("END_AT") is None:
                continue
            m = max(0.0, (s["END_AT"] - s["START_AT"]).total_seconds() / 60)
            if s.get("CATEGORY") in ("DIRECT", "REWORK") and not s.get("REASON"):
                out[s["WORKER_ID"]] += m
            else:
                excluded[s.get("REASON") or s.get("CATEGORY") or "OTHER"] += m
        return {k: round(v, 3) for k, v in out.items() if v > 0}, {k: round(v, 1) for k, v in excluded.items()}

    def rework_standard(self, o, u):
        """the APPROVED rework standard for an attempt: the snapshot taken at operation start when it was approved then; otherwise
        the most specific standard approved later but effective at the attempt's start (product+type > product > type > any)."""
        prov = o.get("REWORK_STANDARD") or {}
        if prov.get("STATUS") == "APPROVED" and o.get("REWORK_STANDARD_LABOR_MIN"):
            return {"STANDARD_ID": prov.get("STANDARD_ID"), "VERSION": prov.get("VERSION"), "APPROVED_BY": prov.get("APPROVED_BY"), "APPROVED_AT": prov.get("APPROVED_AT"), "LABOR_MIN": o["REWORK_STANDARD_LABOR_MIN"]}
        at = o.get("STARTED_AT") or o.get("CREATED_AT")
        rtype = str(o.get("INSTANCE_TYPE") or "*")
        keys = ["%s|%s|%s" % (u.get("PRODUCT_ID"), o["OPERATION_ID"], rtype), "%s|%s|*" % (u.get("PRODUCT_ID"), o["OPERATION_ID"]), "*|%s|%s" % (o["OPERATION_ID"], rtype), "*|%s|*" % o["OPERATION_ID"]]
        q = {"KEY": {"$in": keys}, "STATUS": {"$in": ["APPROVED", "SUPERSEDED"]}}
        if at:
            q["EFFECTIVE_FROM"] = {"$lte": at}
        rows = list(self.db.rework_standards.find(q))
        # a standard superseded only AFTER the attempt started still governed it; withdrawn ones never count
        rows = [r for r in rows if r["STATUS"] == "APPROVED" or (at and r.get("SUPERSEDED_AT") and r["SUPERSEDED_AT"] > at)]
        if not rows:
            return None
        rows.sort(key=lambda r: (keys.index(r["KEY"]), -int(r.get("VERSION") or 0)))
        return rows[0]

    def _gate_after(self, product, op_id):
        seq = self.cat.route(product)
        if op_id not in seq:
            return None
        for x in seq[seq.index(op_id) + 1:]:
            d = self.cat.op(product, x)
            if d and d.get("OPERATION_KIND") == "INSPECTION":
                return x
        return None

    # ================================================================ PTS-TV1
    def evaluate_tv1(self, o, now):
        subject = "TV1|%s" % o["OPERATION_INSTANCE_ID"]
        refs = {"OPERATION_INSTANCE_ID": o["OPERATION_INSTANCE_ID"], "UNIT_ID": o.get("UNIT_ID"), "POINTS_CATEGORY": "TIME"}
        hist = {"RULE_ID": "PTS-TV1", "OPERATION_INSTANCE_ID": o["OPERATION_INSTANCE_ID"]}
        u = self.db.sim_units.find_one({"SESSION_ID": self.sid, "UNIT_ID": o["UNIT_ID"]})
        if not u:
            return self.save_evaluation(subject, "TV1", "PENDING", "PTS-TV1", None, None, {}, refs, "Tank record not found in this session", now)
        refs.update(ORDER_ID=u.get("ORDER_ID"), ORDER_LINE_ID=u.get("ORDER_LINE_ID"), BATCH_ID=u.get("BATCH_ID"))
        gate = self._gate_after(u["PRODUCT_ID"], o["OPERATION_ID"])
        rework = str(o.get("INSTANCE_TYPE", "")).endswith("REWORK") or str(o.get("INSTANCE_TYPE", "")) == "ORIGIN_CORRECTION"
        std = self.rework_standard(o, u) if rework else None
        allowance = (float(std["LABOR_MIN"]) if std else None) if rework else float(o.get("STANDARD_LABOR_MIN") or 0)
        elig, excluded = self.eligible_minutes(o["OPERATION_INSTANCE_ID"])
        evidence = {"gate": gate, "gatePassed": bool(gate and gate in (u.get("PASSED_GATES") or [])), "unitState": u.get("STATE"), "allowanceMin": allowance,
                    "allowanceBasis": ("approved rework standard %s v%s (approved by %s)" % (std["STANDARD_ID"], std["VERSION"], std["APPROVED_BY"]) if std else "no approved rework standard") if rework else "operation standard labour minutes",
                    "reworkStandard": ({"standardId": std["STANDARD_ID"], "version": std["VERSION"], "approvedBy": std["APPROVED_BY"], "approvedAt": std.get("APPROVED_AT"), "status": "APPROVED"} if std else
                                       {"status": (o.get("REWORK_STANDARD") or {}).get("STATUS") or "PROVISIONAL", "source": (o.get("REWORK_STANDARD") or {}).get("SOURCE") or "UNKNOWN", "planningValueMin": o.get("REWORK_STANDARD_LABOR_MIN")}) if rework else None,
                    "eligibleMinByWorker": elig, "actualEligibleMin": round(sum(elig.values()), 2), "excludedMinByReason": excluded}
        if rework and not std:
            # a populated planning number is not an approval: no time points until an approved standard covers this attempt;
            # anything booked earlier against an unapproved value is reversed
            booked, _ = self.reconcile(subject, hist, {}, "PTS-TV1", now, now, refs, "PENDING_APPROVED_REWORK_STANDARD", "No approved rework standard for this attempt", "sim_operations:%s" % o["OPERATION_INSTANCE_ID"])
            return self.save_evaluation(subject, "TV1", "PENDING", "PTS-TV1", None, booked, evidence, refs,
                                        "Rework attempt: waiting for an approved rework standard for %s (the %s-min planning value is not an approved standard)" % (o["OPERATION_ID"], o.get("REWORK_STANDARD_LABOR_MIN")), now)
        released = evidence["gatePassed"] or u.get("STATE") == "ROUTE_COMPLETE"
        if not released:
            if u.get("STATE") == "SCRAPPED":
                booked, _ = self.reconcile(subject, hist, {}, "PTS-TV1", now, now, refs, "NOT_ELIGIBLE_SCRAPPED", "Tank scrapped before its quality gate - no speed points", "sim_units:%s" % u["UNIT_ID"])
                return self.save_evaluation(subject, "TV1", "NOT_ELIGIBLE", "PTS-TV1", {}, booked, evidence, refs, "Tank scrapped - quality gate never satisfied", now)
            booked, _ = self.reconcile(subject, hist, None, "PTS-TV1", now, now, refs, "", "", "")
            return self.save_evaluation(subject, "TV1", "PENDING", "PTS-TV1", None, booked, evidence, refs, "Waiting for quality gate %s - speed points are only allocated after the gate passes" % gate, now)
        split = tv1_split(allowance, elig)
        if split is None:
            booked, _ = self.reconcile(subject, hist, None, "PTS-TV1", now, now, refs, "", "", "")
            return self.save_evaluation(subject, "TV1", "PENDING", "PTS-TV1", None, booked, evidence, refs, "No eligible labour minutes recorded for this attempt", now)
        label, reason = "ELIGIBLE_GATE_RELEASED", "Attempt allowance split by eligible-minute shares"
        confirmed = list(self.db.sim_investigations.find({"SESSION_ID": self.sid, "SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID": o["OPERATION_INSTANCE_ID"], "STATUS": "CONFIRMED"}))
        causes = sorted({c.get("CAUSE_CATEGORY") for c in confirmed})
        evidence["confirmedCauses"] = causes
        evidence["policy"] = {"key": self.policy_key, "withdrawPositiveOnWorkmanship": self.adj["withdraw_positive"], "waiveNegativeOnEquipment": self.adj["waive_negative"]}
        # attempt adjustments beyond the client's formula: applied ONLY when a confirmed policy version switches them on
        if "WORKER" in causes and self.adj["withdraw_positive"]:
            split = {w: (p if p < 0 else 0.0) for w, p in split.items()}
            label, reason = "REVERSED_CONFIRMED_WORKMANSHIP_DEFECT", "Positive speed points withdrawn: a reviewer confirmed a workmanship defect on this attempt (policy %s)" % self.policy_key
        elif "EQUIPMENT" in causes and self.adj["waive_negative"]:
            split = {w: (p if p > 0 else 0.0) for w, p in split.items()}
            label, reason = "NOT_CHARGED_CONFIRMED_EQUIPMENT_DEGRADATION", "Overrun not charged: a reviewer confirmed an equipment cause on this attempt (policy %s)" % self.policy_key
        rel = self.db.sim_events.find_one({"SESSION_ID": self.sid, "ENTITY_ID": u["UNIT_ID"], "EVENT_TYPE": "UNIT_STATE_CHANGED", "PAYLOAD.TO_STATE": {"$in": ["RELEASED_TO_NEXT_OPERATION", "ROUTE_COMPLETE"]}}, sort=[("EVENT_SEQ", -1)])
        refs2 = dict(refs, BASIS_VALUE=round(allowance - sum(elig.values()), 2), BASIS_UNIT="min (standard - actual eligible)", STANDARD_ALLOWANCE_MIN=allowance,
                     ACTUAL_ELIGIBLE_MIN=round(sum(elig.values()), 2), CREW_ELIGIBLE_MIN=elig, PROVISIONAL_STANDARD=False,
                     REWORK_STANDARD_ID=std["STANDARD_ID"] if std else None, REWORK_STANDARD_VERSION=std["VERSION"] if std else None)
        note = reason + ((" - approved rework standard %s v%s, %.1f min" % (std["STANDARD_ID"], std["VERSION"], allowance)) if std else "")
        booked, _ = self.reconcile(subject, hist, split, "PTS-TV1", now, (rel or {}).get("EVENT_TIME") or now, refs2, label, note,
                                   "gate %s released; eligible minutes exclude breaks, external blocks, waits, transfers, cure" % gate)
        status = "AWARDED" if any(v for v in split.values()) else "NOT_ELIGIBLE"
        return self.save_evaluation(subject, "TV1", status, "PTS-TV1", split, booked, evidence, refs, note, now)

    def time_points(self, now, dirty, full):
        q = {"SESSION_ID": self.sid, "OPERATION_KIND": "LABOR", "STATE": "WORK_COMPLETED"}
        if not full:
            seen = self.evaluated("TV1")
            pend = self.pending_subjects("TV1")
            ops = []
            for o in self.db.sim_operations.find(q):
                k = "TV1|%s" % o["OPERATION_INSTANCE_ID"]
                if k not in seen or k in pend or o.get("UNIT_ID") in dirty:
                    ops.append(o)
        else:
            ops = list(self.db.sim_operations.find(q))
        for o in ops:
            self.evaluate_tv1(o, now)
        return len(ops)

    # ================================================================ PTS-NR3 / PTS-OF2
    def evaluate_wo(self, oid, now):
        subject = "WO|%s" % oid
        refs = {"ORDER_ID": oid, "POINTS_CATEGORY": "QUALITY"}
        hist = {"RULE_ID": {"$in": list(WO_RULES)}, "ORDER_ID": oid}
        good_at_fork = (self.s.get("INIT") or {}).get("GOOD_BY_LINE_AT_FORK") or {}
        lines = list(self.db.order_lines.find({"RUN_ID": self.src, "ORDER_ID": oid, "SESSION_ID": {"$in": [None, self.sid]}}))
        complete, complete_at_fork, last_done, short = bool(lines), bool(lines), None, []
        for l in lines:
            good_s = list(self.db.sim_units.find({"SESSION_ID": self.sid, "ORDER_LINE_ID": l["ORDER_LINE_ID"], "STATE": "ROUTE_COMPLETE",
                                                  "$or": [{"TERMINAL_IN_SESSION": True}, {"ROUTE_COMPLETED_AT": {"$gt": self.fork}}]}, {"ROUTE_COMPLETED_AT": 1}))
            req = l.get("REQUIRED_GOOD_QTY") or 0
            have = good_at_fork.get(l["ORDER_LINE_ID"], 0) + len(good_s)
            if good_at_fork.get(l["ORDER_LINE_ID"], 0) < req:
                complete_at_fork = False
            if have < req:
                complete = False
                short.append({"line": l["ORDER_LINE_ID"], "good": have, "required": req})
            if good_s:
                m = max(x["ROUTE_COMPLETED_AT"] for x in good_s)
                last_done = m if not last_done or m > last_done else last_done
        units = sorted(set(self.db.unit_master.distinct("UNIT_ID", {"RUN_ID": self.src, "ORDER_ID": oid, "KNOWN_AT": {"$lte": self.fork}}))
                       | set(self.db.sim_units.distinct("UNIT_ID", {"SESSION_ID": self.sid, "ORDER_ID": oid})))
        hist_c = lambda c, f: self.db[c].count_documents(dict({"RUN_ID": self.src, "UNIT_ID": {"$in": units}, "KNOWN_AT": {"$lte": self.fork}}, **f))
        # session evidence = records that became known after the fork (rows copied from history at initialisation are history)
        new = {"KNOWN_AT": {"$gt": self.fork}}
        sess_c = lambda c, f: self.db[c].count_documents(dict({"SESSION_ID": self.sid, "UNIT_ID": {"$in": units}}, **f))
        session_ev = {"rework": sess_c("sim_returns", new) + self.db.sim_operations.count_documents({"SESSION_ID": self.sid, "UNIT_ID": {"$in": units}, "INSTANCE_TYPE": {"$in": ["GATE_REWORK", "DOWNSTREAM_REWORK"]}, "CREATED_SIM_AT": {"$gt": self.fork}}),
                      "scrap": sess_c("sim_units", {"STATE": "SCRAPPED", "$or": [{"TERMINAL_IN_SESSION": True}, {"SCRAPPED_AT": {"$gt": self.fork}}]}),
                      "failHolds": sess_c("sim_dispositions", dict(new, DISPOSITION="HOLD", RESULT="FAIL")),
                      "downstreamDefects": sess_c("sim_defects", dict(new, DOWNSTREAM_FLAG="Y"))}
        hist_ev = {"rework": hist_c("rework_tasks", {}), "scrap": hist_c("production_events", {"EVENT_TYPE": "UNIT_SCRAPPED"}),
                   "failHolds": hist_c("quality_dispositions", {"DISPOSITION": "HOLD", "RESULT": "FAIL"}), "downstreamDefects": hist_c("defect_records", {"DOWNSTREAM_FLAG": "Y"})}
        origin_fix = self.db.sim_returns.count_documents({"SESSION_ID": self.sid, "UNIT_ID": {"$in": units}, "DESTINATION_BASIS": "SAME_STATION", "REWORK_TYPE": "GATE_REWORK", "LOOP_STATUS": "RELEASED_ROUTE_RESUMED"}) \
            + self.db.rework_tasks.count_documents({"RUN_ID": self.src, "UNIT_ID": {"$in": units}, "REWORK_TYPE": {"$in": ["IN_STATION_CORRECTION", "ORIGIN_CORRECTION"]}, "KNOWN_AT": {"$lte": self.fork}})
        tot = {k: hist_ev[k] + session_ev[k] for k in hist_ev}
        evidence = {"units": len(units), "history": hist_ev, "session": session_ev, "originCorrections": origin_fix, "completedAt": last_done, "shortLines": short, "completeAtFork": complete_at_fork}
        if not complete:
            booked, _ = self.reconcile(subject, hist, None, None, now, now, refs, "", "", "")
            return self.save_evaluation(subject, "WO", "PENDING", None, None, booked, evidence, refs, "Work order not complete yet", now)
        if complete_at_fork and not any(session_ev.values()):
            booked, _ = self.reconcile(subject, hist, None, None, now, now, refs, "", "", "")
            return self.save_evaluation(subject, "WO", "HISTORY_FINAL", None, None, booked, evidence, refs, "Completed before the session started; the source ledger decision stands", now)
        rule = None
        if tot["rework"] == 0 and tot["scrap"] == 0 and tot["failHolds"] == 0 and tot["downstreamDefects"] == 0:
            rule, pts, why = "PTS-NR3", 3.0, "No rework, scrap, FAIL hold or downstream defect on any tank of the WO"
        elif origin_fix > 0 and tot["downstreamDefects"] == 0 and tot["scrap"] == 0:
            rule, pts, why = "PTS-OF2", 2.0, "Defect caught and corrected at its origin station; no downstream defect, no scrap"
        if rule is None:
            booked, _ = self.reconcile(subject, hist, {}, "PTS-NR3", now, now, refs, "NOT_ELIGIBLE", "WO no longer qualifies for NR3/OF2", "evidence %s" % json.dumps(tot))
            return self.save_evaluation(subject, "WO", "NOT_ELIGIBLE", None, {}, booked, evidence, refs, "Rework, scrap, FAIL hold or downstream defect present", now)
        # same rule already booked from history: keep the history allocation (no re-split of an unchanged decision)
        active, _ = self.booked(subject, hist)
        if active and {r.get("RULE_ID") for r in active} == {rule}:
            booked, _ = self.reconcile(subject, hist, None, rule, now, now, refs, "", "", "")
            return self.save_evaluation(subject, "WO", "AWARDED", rule, booked, booked, evidence, refs, why + " (allocation as already booked)", now)
        weights = defaultdict(float)
        for s in self.db.labor_segments.find({"RUN_ID": self.src, "UNIT_ID": {"$in": units}, "SEGMENT_START": {"$lt": self.fork}}, {"WORKER_ID": 1, "SEGMENT_START": 1, "SEGMENT_END": 1}):
            weights[s["WORKER_ID"]] += max(0.0, (min(s["SEGMENT_END"], self.fork) - s["SEGMENT_START"]).total_seconds() / 60)
        for s in self.db.sim_participation.find({"SESSION_ID": self.sid, "UNIT_ID": {"$in": units}, "CATEGORY": {"$in": ["DIRECT", "REWORK"]}}):
            weights[s["WORKER_ID"]] += max(0.0, ((s.get("END_AT") or now) - s["START_AT"]).total_seconds() / 60)
        split = allocate(pts, weights, precision=2)
        evidence["contributionMin"] = {k: round(v, 1) for k, v in weights.items()}
        if split is None:
            booked, _ = self.reconcile(subject, hist, None, rule, now, now, refs, "", "", "")
            return self.save_evaluation(subject, "WO", "PENDING", rule, None, booked, evidence, refs, "Eligible, but no recorded labour to allocate the award", now)
        refs2 = dict(refs, BASIS_VALUE=pts, BASIS_UNIT="points per WO", CONTRIBUTION_MIN=evidence["contributionMin"])
        booked, _ = self.reconcile(subject, hist, split, rule, now, last_done or now, refs2, "WO_AWARD_ALLOCATED", "WO award split by recorded labour minutes (provisional allocation policy)", why)
        return self.save_evaluation(subject, "WO", "AWARDED", rule, split, booked, evidence, refs, why, now)

    def wo_awards(self, now, dirty, full):
        orders = set(self.db.sim_units.distinct("ORDER_ID", {"SESSION_ID": self.sid, "STATE": "ROUTE_COMPLETE", "$or": [{"TERMINAL_IN_SESSION": True}, {"ROUTE_COMPLETED_AT": {"$gt": self.fork}}]}))
        if dirty:
            orders |= set(self.db.sim_units.distinct("ORDER_ID", {"SESSION_ID": self.sid, "UNIT_ID": {"$in": sorted(dirty)}}))
        if full:      # after a restart: also every order whose tanks carry session quality evidence (it may invalidate a history award)
            new = {"SESSION_ID": self.sid, "KNOWN_AT": {"$gt": self.fork}}
            touched = set(self.db.sim_defects.distinct("UNIT_ID", new)) | set(self.db.sim_returns.distinct("UNIT_ID", new)) | set(self.db.sim_dispositions.distinct("UNIT_ID", new)) \
                | set(self.db.sim_units.distinct("UNIT_ID", {"SESSION_ID": self.sid, "STATE": "SCRAPPED", "$or": [{"TERMINAL_IN_SESSION": True}, {"SCRAPPED_AT": {"$gt": self.fork}}]}))
            if touched:
                orders |= set(self.db.sim_units.distinct("ORDER_ID", {"SESSION_ID": self.sid, "UNIT_ID": {"$in": sorted(touched)}}))
        if not full:
            seen = self.evaluated("WO")
            pend = self.pending_subjects("WO")
            dirty_orders = set(self.db.sim_units.distinct("ORDER_ID", {"SESSION_ID": self.sid, "UNIT_ID": {"$in": sorted(dirty)}})) if dirty else set()
            orders = {o for o in orders if "WO|%s" % o not in seen or "WO|%s" % o in pend or o in dirty_orders}
        for oid in sorted(x for x in orders if x):
            self.evaluate_wo(oid, now)
        return len(orders)

    # ================================================================ PTS-DD4
    def evaluate_dd4(self, inv, now):
        subject = "DD4|%s" % inv["DEFECT_ID"]                 # exact defect: DD4|D-1 never matches DD4|D-10
        refs = {"DEFECT_ID": inv["DEFECT_ID"], "UNIT_ID": inv.get("UNIT_ID"), "INVESTIGATION_ID": inv["INVESTIGATION_ID"], "POINTS_CATEGORY": "QUALITY"}
        hist = {"RULE_ID": "PTS-DD4", "DEFECT_ID": inv["DEFECT_ID"]}
        status, cause = inv.get("STATUS"), inv.get("CAUSE_CATEGORY")
        evidence = {"investigationStatus": status, "cause": cause, "responsible": inv.get("RESPONSIBLE") or [], "reviewedBy": inv.get("REVIEWED_BY"), "confirmedAt": inv.get("CONFIRMED_AT"),
                    "suspected": inv.get("SUSPECTED_PARTIES") or []}
        ev_ref = "Investigation %s: %s/%s reviewed by %s" % (inv["INVESTIGATION_ID"], status, cause, inv.get("REVIEWED_BY"))
        if status == "CONFIRMED" and cause == "WORKER" and inv.get("RESPONSIBLE"):
            shares = {r["PARTY_ID"]: float(r["SHARE"]) for r in inv["RESPONSIBLE"] if r.get("PARTY_TYPE") == "WORKER"}
            want = allocate(-4.0, shares, precision=2)
            label = "CONFIRMED_WORKER" if len(shares) == 1 else "CONFIRMED_CREW"
            refs2 = dict(refs, BASIS_VALUE=-4, BASIS_UNIT="points per distinct downstream defect", RESPONSIBILITY_SHARES=shares, REVIEWED_BY=inv.get("REVIEWED_BY"))
            booked, _ = self.reconcile(subject, hist, want, "PTS-DD4", now, inv.get("CONFIRMED_AT") or now, refs2, label,
                                       "Deduction only after a named reviewer confirmed a worker cause; split by confirmed responsibility shares", ev_ref)
            return self.save_evaluation(subject, "DD4", "DEDUCTED", "PTS-DD4", want, booked, evidence, refs, "Confirmed worker cause", now)
        if status == "CONFIRMED":
            st, reason = "NO_DEDUCTION", "Confirmed %s cause - no worker deduction" % (cause or "non-worker").lower()
        elif status == "CLOSED_UNRESOLVED":
            st, reason = "NO_DEDUCTION", "Closed unresolved - no attribution"
        else:
            st, reason = "PENDING", "Cause %s - no deduction until a reviewer confirms a worker cause" % ("suspected" if status == "SUSPECTED" else "unknown")
        booked, _ = self.reconcile(subject, hist, {}, "PTS-DD4", now, now, refs, "PENDING_INVESTIGATION_NO_WORKER_ATTRIBUTION" if st == "PENDING" else "CONFIRMED_NON_WORKER", reason, ev_ref)
        return self.save_evaluation(subject, "DD4", st, "PTS-DD4", {}, booked, evidence, refs, reason, now)

    def downstream_deductions(self, now, dirty, full):
        q = {"SESSION_ID": self.sid, "DOWNSTREAM_FLAG": "Y"}
        invs = list(self.db.sim_investigations.find(q))
        if not full:
            seen = self.evaluated("DD4")
            pend = self.pending_subjects("DD4")
            invs = [i for i in invs if "DD4|%s" % i["DEFECT_ID"] not in seen or "DD4|%s" % i["DEFECT_ID"] in pend or i.get("UNIT_ID") in dirty]
        for inv in invs:
            self.evaluate_dd4(inv, now)
        return len(invs)

    # ================================================================ pass
    def run(self, now):
        st = self._state()
        upto = int((self.db.sim_sessions.find_one({"SESSION_ID": self.sid}, {"EVENT_SEQ": 1}) or {}).get("EVENT_SEQ") or 0)
        full = not st or st.get("RULE_VERSION") != RULE_VERSION or st.get("POLICY_KEY") != self.policy_key or _ENGINE_START not in (st.get("ENGINE_STARTS") or [])
        dirty = set() if full else self.dirty_units(int(st.get("LAST_EVENT_SEQ") or 0), upto)
        out = {"tv1": self.time_points(now, dirty, full), "wo": self.wo_awards(now, dirty, full), "dd4": self.downstream_deductions(now, dirty, full)}
        self.db.sim_points_evaluations.update_one({"SESSION_ID": self.sid, "SUBJECT_KEY": "__STATE__"},
                                                  {"$set": {"RULE_FAMILY": "__STATE__", "STATUS": "STATE", "LAST_EVENT_SEQ": upto, "RULE_VERSION": RULE_VERSION, "POLICY_KEY": self.policy_key,
                                                            "CALCULATION_ID": self.calc_id, "AS_OF": now, "COMPUTED_AT": utcnow()}, "$addToSet": {"ENGINE_STARTS": _ENGINE_START}}, upsert=True)
        out.update(evaluated=out["tv1"] + out["wo"] + out["dd4"], full=full, **dict(self.stats))
        return out


_ENGINE_START = utcnow().isoformat()        # a restarted engine re-evaluates every subject once
