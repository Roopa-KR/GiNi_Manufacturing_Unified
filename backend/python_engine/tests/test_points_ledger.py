"""Points ledger re-evaluation on a disposable database through the real pymongo driver (fixture `mdb`).

Expected values are worked out by hand from the rules in ENGINE_RULES.md:
  TV1 attempt: standard 40 min, crew W1 20 + W2 19.5 eligible min -> +0.50 total split 20:19.5 = 0.2532 : 0.2468 -> 25 + 24 hundredths, residual 0.01 to the larger remainder (W2) -> 0.25 each
  DD4: -4 per distinct downstream defect, by confirmed shares; corrected shares reverse and re-post; equipment cause books nothing
  NR3 +3 / OF2 +2 per completed WO, mutually exclusive, split by labour minutes
"""
import datetime as dt
import threading
from collections import defaultdict

from gini_engine.points import PointsEngine, txn_id

FORK = dt.datetime(2026, 10, 15, 14, 0)
SID = "S-PTS"


def T(m):
    return FORK + dt.timedelta(minutes=m)


class Cat:
    ROUTE = ["OP10", "OP20", "OP30"]
    OPS = {"OP10": {"OPERATION_KIND": "LABOR"}, "OP20": {"OPERATION_KIND": "INSPECTION"}, "OP30": {"OPERATION_KIND": "LABOR"}}

    def route(self, product):
        return self.ROUTE

    def op(self, product, op_id):
        return self.OPS.get(op_id)


def seed(db, seq=0):
    db.sim_sessions.insert_one({"SESSION_ID": SID, "SOURCE_RUN_ID": "RUN-BASE", "RUN_ID": "RUN-S", "DATASET_ID": "DS", "SHORT_ID": "T1", "FORK_AT": FORK,
                                "EVENT_SEQ": seq, "MODE": "INTERACTIVE", "INIT": {"GOOD_BY_LINE_AT_FORK": {}}})
    for w in ("W1", "W2", "W3"):
        db.sim_workers.insert_one({"SESSION_ID": SID, "WORKER_ID": w})


def session(db):
    return db.sim_sessions.find_one({"SESSION_ID": SID})


def bump(db, entity_type, entity_id, unit=None):
    s = db.sim_sessions.find_one_and_update({"SESSION_ID": SID}, {"$inc": {"EVENT_SEQ": 1}}, return_document=True)
    db.sim_events.insert_one({"SESSION_ID": SID, "EVENT_SEQ": s["EVENT_SEQ"], "EVENT_TYPE": "TEST", "ENTITY_TYPE": entity_type, "ENTITY_ID": entity_id, "PAYLOAD": {"UNIT_ID": unit}})


def tank(db, unit="TNK-1", order="WO-1", line="WO-1-L1", state="RELEASED_TO_NEXT_OPERATION", gates=("OP20",)):
    db.sim_units.insert_one({"SESSION_ID": SID, "UNIT_ID": unit, "ORDER_ID": order, "ORDER_LINE_ID": line, "BATCH_ID": "B1", "PRODUCT_ID": "P", "STATE": state, "PASSED_GATES": list(gates)})


def attempt(db, op="OPI-1", unit="TNK-1", std=40, crew=(("W1", 20), ("W2", 19.5)), breaks=0):
    db.sim_operations.insert_one({"SESSION_ID": SID, "OPERATION_INSTANCE_ID": op, "UNIT_ID": unit, "OPERATION_ID": "OP10", "OPERATION_KIND": "LABOR", "STATE": "WORK_COMPLETED",
                                  "INSTANCE_TYPE": "NORMAL", "STANDARD_LABOR_MIN": std})
    for w, m in crew:
        db.sim_participation.insert_one({"SESSION_ID": SID, "OPERATION_INSTANCE_ID": op, "UNIT_ID": unit, "WORKER_ID": w, "CATEGORY": "DIRECT", "START_AT": T(0), "END_AT": T(m)})
    if breaks:      # a planned break during the attempt: not eligible time
        db.sim_participation.insert_one({"SESSION_ID": SID, "OPERATION_INSTANCE_ID": op, "UNIT_ID": unit, "WORKER_ID": "W1", "CATEGORY": "WAITING", "REASON": "PLANNED_BREAK", "START_AT": T(20), "END_AT": T(20 + breaks)})


def run(db, now=None):
    return PointsEngine(db, Cat(), session(db)).run(now or T(60))


def net(db, subject=None):
    out = defaultdict(float)
    for r in db.sim_points_ledger.find({"SESSION_ID": SID, **({"SUBJECT_KEY": subject} if subject else {})}):
        out[r["WORKER_ID"]] = round(out[r["WORKER_ID"]] + r["POINTS_DELTA"], 2)
    return {k: v for k, v in out.items() if v}


def investigation(db, defect, status="OPEN_UNKNOWN", cause="UNKNOWN", responsible=(), unit="TNK-1", origin="OPI-1"):
    db.sim_investigations.update_one({"SESSION_ID": SID, "DEFECT_ID": defect},
                                     {"$set": {"INVESTIGATION_ID": "INV-" + defect, "UNIT_ID": unit, "DOWNSTREAM_FLAG": "Y", "STATUS": status, "CAUSE_CATEGORY": cause, "REVIEWED_BY": "Q-REVIEWER",
                                               "RESPONSIBLE": [{"PARTY_TYPE": "WORKER", "PARTY_ID": w, "SHARE": s} for w, s in responsible], "SUSPECTED_ORIGIN_OPERATION_INSTANCE_ID": origin,
                                               "CONFIRMED_AT": T(50) if status == "CONFIRMED" else None}}, upsert=True)
    bump(db, "INVESTIGATION", "INV-" + defect)


# --------------------------------------------------------------------------------------------------------------------------
def test_fractional_tv1_posted_once_and_unchanged_evidence_posts_nothing(mdb):
    seed(mdb); tank(mdb); attempt(mdb, breaks=15)
    run(mdb)
    assert net(mdb, "TV1|OPI-1") == {"W1": 0.25, "W2": 0.25}           # +0.50 crew total; the 15-min break is not eligible time
    rows = list(mdb.sim_points_ledger.find({"SESSION_ID": SID}))
    assert {r["POINTS_TRANSACTION_ID"] for r in rows} == {txn_id("T1", "TV1|OPI-1|R1", "W1"), txn_id("T1", "TV1|OPI-1|R1", "W2")}
    ev = mdb.sim_points_evaluations.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "TV1|OPI-1"})
    assert ev["STATUS"] == "AWARDED" and ev["EVIDENCE"]["excludedMinByReason"] == {"PLANNED_BREAK": 15.0} and ev["CALCULATION_ID"]
    for _ in range(3):
        run(mdb)                                                        # repeated passes and an engine restart (module state kept)
    assert mdb.sim_points_ledger.count_documents({"SESSION_ID": SID}) == 2


def test_overrun_is_negative_fraction(mdb):
    seed(mdb); tank(mdb); attempt(mdb, crew=(("W1", 40.5),))
    run(mdb)
    assert net(mdb) == {"W1": -0.5}


def test_pending_until_gate_then_allocated(mdb):
    seed(mdb); tank(mdb, state="QUEUED_FOR_INSPECTION", gates=()); attempt(mdb)
    run(mdb)
    assert net(mdb) == {}
    assert mdb.sim_points_evaluations.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "TV1|OPI-1"})["STATUS"] == "PENDING"
    mdb.sim_units.update_one({"SESSION_ID": SID, "UNIT_ID": "TNK-1"}, {"$set": {"STATE": "RELEASED_TO_NEXT_OPERATION", "PASSED_GATES": ["OP20"]}})
    bump(mdb, "UNIT", "TNK-1")
    run(mdb)
    assert net(mdb) == {"W1": 0.25, "W2": 0.25}


def confirm_policy(db, version=2, withdraw=False, waive=False, by="quality.owner"):
    """a confirmed points-policy version (what Administration -> Points policy saves)"""
    db.points_policy_versions.insert_one({"VERSION_NO": version, "STATUS": "CONFIRMED", "EFFECTIVE_FROM": dt.datetime(2020, 1, 1), "CONFIRMED_BY": by, "CONFIRMED_AT": dt.datetime(2026, 10, 1),
                                          "POLICY": {"version": "test", "attempt_adjustments": {"withdraw_positive_time_on_confirmed_workmanship_defect": withdraw,
                                                                                                "waive_negative_time_on_confirmed_equipment_cause": waive}}})


def test_default_policy_keeps_the_client_formula_when_a_workmanship_defect_is_confirmed(mdb):
    """the shipped policy has the attempt adjustments OFF: speed points stand; the defect is charged by DD4 only"""
    seed(mdb); tank(mdb); attempt(mdb)
    run(mdb)
    investigation(mdb, "D-1", "CONFIRMED", "WORKER", [("W1", 1.0)])
    run(mdb)
    assert net(mdb, "TV1|OPI-1") == {"W1": 0.25, "W2": 0.25}
    assert net(mdb, "DD4|D-1") == {"W1": -4.0}
    ev = mdb.sim_points_evaluations.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "TV1|OPI-1"})
    assert ev["POLICY_KEY"].startswith("config-") and ev["EVIDENCE"]["policy"]["withdrawPositiveOnWorkmanship"] is False
    assert all(r["ALLOCATION_POLICY_STATUS"] == "SHIPPED_DEFAULT_NOT_CONFIRMED" for r in mdb.sim_points_ledger.find({"SESSION_ID": SID}))


def test_confirmed_policy_version_withdraws_speed_points_with_links(mdb):
    """only after a named person confirms a policy version that switches the adjustment on are the speed points withdrawn -
    by linked reversal rows, and the change of policy alone re-evaluates every subject"""
    seed(mdb); tank(mdb); attempt(mdb)
    run(mdb)
    investigation(mdb, "D-1", "CONFIRMED", "WORKER", [("W1", 1.0)])
    run(mdb)
    assert net(mdb, "TV1|OPI-1") == {"W1": 0.25, "W2": 0.25}
    confirm_policy(mdb, withdraw=True)
    run(mdb)                                                            # no new event: the policy change alone triggers re-evaluation
    assert net(mdb, "TV1|OPI-1") == {}
    rev = list(mdb.sim_points_ledger.find({"SESSION_ID": SID, "SUBJECT_KEY": "TV1|OPI-1", "ENTRY_TYPE": "REVERSAL"}))
    orig = {r["WORKER_ID"]: r["POINTS_TRANSACTION_ID"] for r in mdb.sim_points_ledger.find({"SESSION_ID": SID, "SUBJECT_KEY": "TV1|OPI-1", "REVISION": 1})}
    assert len(rev) == 2 and all(r["REVERSAL_OF_ID"] == orig[r["WORKER_ID"]] and r["REVERSES_TRANSACTION_IDS"] == [orig[r["WORKER_ID"]]] for r in rev)
    assert all(r["ALLOCATION_POLICY"] == "P2" and r["ALLOCATION_POLICY_STATUS"] == "CONFIRMED" for r in rev)
    assert net(mdb, "DD4|D-1") == {"W1": -4.0}


def test_equipment_waiver_only_under_a_confirmed_policy(mdb):
    seed(mdb); tank(mdb); attempt(mdb, crew=(("W1", 50),))               # 40 std, 50 actual -> -10
    investigation(mdb, "D-2", "CONFIRMED", "EQUIPMENT")
    run(mdb)
    assert net(mdb, "TV1|OPI-1") == {"W1": -10.0}, "default: the overrun is charged by the formula"
    confirm_policy(mdb, waive=True)
    run(mdb)
    assert net(mdb, "TV1|OPI-1") == {}, "confirmed waiver: the overrun is not charged"


def rework_attempt(db, op="OPI-RW", unit="TNK-1", provenance=None, planning=60, crew=(("W1", 30),)):
    db.sim_operations.insert_one({"SESSION_ID": SID, "OPERATION_INSTANCE_ID": op, "UNIT_ID": unit, "OPERATION_ID": "OP10", "OPERATION_KIND": "LABOR", "STATE": "WORK_COMPLETED",
                                  "INSTANCE_TYPE": "GATE_REWORK", "STANDARD_LABOR_MIN": planning, "REWORK_STANDARD_LABOR_MIN": planning, "STARTED_AT": T(0),
                                  "REWORK_STANDARD": provenance or {"STATUS": "PROVISIONAL", "SOURCE": "SYNTHETIC_DEFAULT_PLANNING_VALUE"}})
    for w, m in crew:
        db.sim_participation.insert_one({"SESSION_ID": SID, "OPERATION_INSTANCE_ID": op, "UNIT_ID": unit, "WORKER_ID": w, "CATEGORY": "REWORK", "START_AT": T(0), "END_AT": T(m)})


def test_a_populated_rework_planning_value_is_not_an_approval(mdb):
    """REWORK_STANDARD_LABOR_MIN = 60 from the synthetic default: no time points (PENDING), never +30"""
    seed(mdb); tank(mdb); rework_attempt(mdb)
    run(mdb)
    assert net(mdb, "TV1|OPI-RW") == {}
    ev = mdb.sim_points_evaluations.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "TV1|OPI-RW"})
    assert ev["STATUS"] == "PENDING" and "approved rework standard" in ev["REASON"]
    assert ev["EVIDENCE"]["reworkStandard"]["status"] == "PROVISIONAL" and ev["EVIDENCE"]["reworkStandard"]["source"] == "SYNTHETIC_DEFAULT_PLANNING_VALUE"


def test_an_approved_rework_standard_effective_at_the_attempt_releases_the_points(mdb):
    seed(mdb); tank(mdb); rework_attempt(mdb)
    run(mdb)
    assert net(mdb, "TV1|OPI-RW") == {}
    # approved later, effective before the attempt started; the most specific key (product + operation) wins over the generic one
    mdb.rework_standards.insert_one({"STANDARD_ID": "RWS-ANY", "KEY": "*|OP10|*", "LABOR_MIN": 50, "VERSION": 1, "STATUS": "APPROVED", "APPROVED_BY": "ie.lead", "EFFECTIVE_FROM": T(-600)})
    mdb.rework_standards.insert_one({"STANDARD_ID": "RWS-P", "KEY": "P|OP10|*", "LABOR_MIN": 35, "VERSION": 2, "STATUS": "APPROVED", "APPROVED_BY": "ie.lead", "EFFECTIVE_FROM": T(-600)})
    mdb.rework_standards.insert_one({"STANDARD_ID": "RWS-FUTURE", "KEY": "P|OP10|GATE_REWORK", "LABOR_MIN": 99, "VERSION": 1, "STATUS": "APPROVED", "APPROVED_BY": "ie.lead", "EFFECTIVE_FROM": T(30)})
    run(mdb)                                                            # PENDING subjects are re-evaluated every pass
    assert net(mdb, "TV1|OPI-RW") == {"W1": 5.0}                        # 35 approved - 30 eligible
    row = mdb.sim_points_ledger.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "TV1|OPI-RW"})
    assert row["REWORK_STANDARD_ID"] == "RWS-P" and row["REWORK_STANDARD_VERSION"] == 2 and row["PROVISIONAL_STANDARD"] is False


def test_approved_snapshot_at_operation_start_is_used(mdb):
    seed(mdb); tank(mdb)
    rework_attempt(mdb, planning=45, provenance={"STATUS": "APPROVED", "SOURCE": "APPROVED_REWORK_STANDARD", "STANDARD_ID": "RWS-X", "VERSION": 3, "APPROVED_BY": "ie.lead"})
    run(mdb)
    assert net(mdb, "TV1|OPI-RW") == {"W1": 15.0}


def test_exact_defect_association_and_corrected_responsibility(mdb):
    seed(mdb); tank(mdb)
    investigation(mdb, "D-1")
    investigation(mdb, "D-10", "CONFIRMED", "WORKER", [("W1", 1.0)])
    run(mdb)
    assert net(mdb, "DD4|D-10") == {"W1": -4.0} and net(mdb, "DD4|D-1") == {}
    investigation(mdb, "D-10", "CONFIRMED", "WORKER", [("W1", 0.5), ("W2", 0.5)])      # reviewer corrects the shares
    run(mdb)
    assert net(mdb, "DD4|D-10") == {"W1": -2.0, "W2": -2.0}
    rows = list(mdb.sim_points_ledger.find({"SESSION_ID": SID, "SUBJECT_KEY": "DD4|D-10"}).sort("AWARD_KEY", 1))
    assert [(r["AWARD_KEY"], r["WORKER_ID"], r["POINTS_DELTA"]) for r in rows] == [
        ("DD4|D-10|R1", "W1", -4.0), ("DD4|D-10|R2", "W1", -2.0), ("DD4|D-10|R2", "W2", -2.0), ("DD4|D-10|X2", "W1", 4.0)]
    assert net(mdb, "DD4|D-1") == {}, "D-1 is never touched by D-10's postings"


def test_equipment_and_unknown_causes_book_nothing_and_reverse_a_prior_deduction(mdb):
    seed(mdb); tank(mdb)
    investigation(mdb, "D-2", "SUSPECTED", "WORKER")
    run(mdb)
    assert net(mdb) == {} and mdb.sim_points_evaluations.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "DD4|D-2"})["STATUS"] == "PENDING"
    investigation(mdb, "D-2", "CONFIRMED", "WORKER", [("W3", 1.0)])
    run(mdb)
    assert net(mdb) == {"W3": -4.0}
    investigation(mdb, "D-2", "CONFIRMED", "EQUIPMENT")
    run(mdb)
    assert net(mdb) == {}
    assert mdb.sim_points_evaluations.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "DD4|D-2"})["STATUS"] == "NO_DEDUCTION"
    assert mdb.sim_points_ledger.count_documents({"SESSION_ID": SID}) == 2      # the deduction and its linked reversal; nothing edited


def _complete_wo(db, origin_fix=False):
    db.order_lines.insert_one({"RUN_ID": "RUN-BASE", "ORDER_ID": "WO-1", "ORDER_LINE_ID": "WO-1-L1", "REQUIRED_GOOD_QTY": 1})
    tank(db, state="ROUTE_COMPLETE", gates=("OP20",))
    db.sim_units.update_one({"SESSION_ID": SID, "UNIT_ID": "TNK-1"}, {"$set": {"ROUTE_COMPLETED_AT": T(55), "TERMINAL_IN_SESSION": True}})
    attempt(db, crew=(("W1", 30), ("W2", 10)))
    if origin_fix:
        db.sim_returns.insert_one({"SESSION_ID": SID, "UNIT_ID": "TNK-1", "DESTINATION_BASIS": "SAME_STATION", "REWORK_TYPE": "GATE_REWORK", "LOOP_STATUS": "RELEASED_ROUTE_RESUMED", "KNOWN_AT": T(20)})


def test_wo_no_rework_award_and_exclusivity(mdb):
    seed(mdb); _complete_wo(mdb)
    run(mdb)
    assert net(mdb, "WO|WO-1") == {"W1": 2.25, "W2": 0.75}             # +3 split 30:10
    assert {r["RULE_ID"] for r in mdb.sim_points_ledger.find({"SESSION_ID": SID, "SUBJECT_KEY": "WO|WO-1"})} == {"PTS-NR3"}


def test_wo_origin_fix_gets_of2_not_nr3(mdb):
    seed(mdb); _complete_wo(mdb, origin_fix=True)
    run(mdb)
    assert net(mdb, "WO|WO-1") == {"W1": 1.5, "W2": 0.5}
    assert {r["RULE_ID"] for r in mdb.sim_points_ledger.find({"SESSION_ID": SID, "SUBJECT_KEY": "WO|WO-1"})} == {"PTS-OF2"}


def test_history_award_reversed_by_session_downstream_defect(mdb):
    seed(mdb)
    mdb.sim_sessions.update_one({"SESSION_ID": SID}, {"$set": {"INIT.GOOD_BY_LINE_AT_FORK": {"WO-1-L1": 1}}})
    mdb.order_lines.insert_one({"RUN_ID": "RUN-BASE", "ORDER_ID": "WO-1", "ORDER_LINE_ID": "WO-1-L1", "REQUIRED_GOOD_QTY": 1})
    mdb.unit_master.insert_one({"RUN_ID": "RUN-BASE", "UNIT_ID": "TNK-1", "ORDER_ID": "WO-1", "KNOWN_AT": T(-600)})
    mdb.points_ledger.insert_one({"RUN_ID": "RUN-BASE", "POINTS_TRANSACTION_ID": "PTX-B-000777", "ORDER_ID": "WO-1", "RULE_ID": "PTS-NR3", "WORKER_ID": "W1", "POINTS_DELTA": 3.0, "KNOWN_AT": T(-300)})
    tank(mdb, state="ROUTE_COMPLETE")
    mdb.sim_defects.insert_one({"SESSION_ID": SID, "DEFECT_ID": "D-9", "UNIT_ID": "TNK-1", "DOWNSTREAM_FLAG": "Y", "KNOWN_AT": T(30)})
    bump(mdb, "UNIT", "TNK-1")
    st = PointsEngine(mdb, Cat(), session(mdb)).run(T(60))
    rev = mdb.sim_points_ledger.find_one({"SESSION_ID": SID, "SUBJECT_KEY": "WO|WO-1"})
    assert rev["ENTRY_TYPE"] == "REVERSAL" and rev["POINTS_DELTA"] == -3.0 and rev["REVERSAL_OF_ID"] == "PTX-B-000777", st
    run(mdb)
    assert mdb.sim_points_ledger.count_documents({"SESSION_ID": SID}) == 1


def test_concurrent_engines_never_double_post(mdb):
    seed(mdb); tank(mdb); attempt(mdb)
    investigation(mdb, "D-5", "CONFIRMED", "WORKER", [("W1", 0.25), ("W2", 0.75)])
    errors = []

    def go():
        try:
            PointsEngine(mdb, Cat(), session(mdb)).run(T(60))
        except Exception as e:      # pragma: no cover - reported by the assertion
            errors.append(e)
    ts = [threading.Thread(target=go) for _ in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errors
    assert net(mdb, "DD4|D-5") == {"W1": -1.0, "W2": -3.0}
    assert mdb.sim_points_ledger.count_documents({"SESSION_ID": SID, "SUBJECT_KEY": "DD4|D-5"}) == 2


def test_ledger_totals_equal_evaluations(mdb):
    seed(mdb); _complete_wo(mdb)
    investigation(mdb, "D-7", "CONFIRMED", "WORKER", [("W2", 1.0)], origin="OPI-X")
    run(mdb)
    booked = defaultdict(float)
    for e in mdb.sim_points_evaluations.find({"SESSION_ID": SID, "SUBJECT_KEY": {"$ne": "__STATE__"}}):
        for w, p in (e.get("BOOKED_NET") or {}).items():
            booked[w] = round(booked[w] + p, 2)
    assert {k: v for k, v in booked.items() if v} == net(mdb)
