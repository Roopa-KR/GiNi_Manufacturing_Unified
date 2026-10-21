"""Alert lifecycle: NORMAL -> PENDING -> FIRING -> RECOVERING -> RESOLVED, one notification per episode/transition, suppression rules."""
import datetime as dt
from gini_engine.alerts import AlertManager
from fakedb import FakeDB
from conftest import T

RULE = {"rule_id": "M05", "name": "Capacity gap", "persistence": 2, "recovery": 2, "notify": True, "cooldown_min": 60, "scope": "WORK_CENTER"}


def sess(mode="INTERACTIVE", speed=1):
    return {"SESSION_ID": "S-TEST", "MODE": mode, "CLOCK": {"SPEED": speed}, "PLANT_TIMEZONE": "America/Bogota"}


def run(db, s, now, status, initial=False):
    am = AlertManager(db, s, [RULE], "v9", now, initial=initial)
    am.apply([{"rule_id": "M05", "entity_type": "WORK_CENTER", "entity_id": "WC9", "status": status, "actual": 120, "message": "gap", "severity": "MEDIUM"}])
    return db.sim_alerts.find_one({"ALERT_ID": "AL-M05-WC9"})


def test_full_lifecycle_and_single_notifications():
    db, s = FakeDB(), sess()
    assert run(db, s, T(10, 0), "BREACH")["EVALUATION_STATE"] == "PENDING"
    a = run(db, s, T(10, 5), "BREACH")
    assert a["EVALUATION_STATE"] == "FIRING" and a["WORKFLOW_STATE"] == "UNACKNOWLEDGED"
    ep = a["EPISODE_ID"]
    assert run(db, s, T(10, 10), "BREACH")["EVALUATION_STATE"] == "FIRING"       # repeated ticks: no new episode
    assert run(db, s, T(10, 15), "OK")["EVALUATION_STATE"] == "RECOVERING"
    a = run(db, s, T(10, 20), "OK")
    assert a["EVALUATION_STATE"] == "RESOLVED" and a["EPISODE_ID"] == ep
    n = db.notifications.find({})
    assert [x["TRANSITION"] for x in n] == ["FIRING", "RESOLVED"]
    assert len({x["DEDUP_KEY"] for x in n}) == 2
    tr = [(x["FROM_STATE"], x["TO_STATE"]) for x in db.sim_alert_transitions.find({})]
    assert tr == [("NORMAL", "PENDING"), ("PENDING", "FIRING"), ("FIRING", "RECOVERING"), ("RECOVERING", "RESOLVED")]


def test_pending_blip_never_fires_or_emails():
    db, s = FakeDB(), sess()
    run(db, s, T(10), "BREACH")
    assert run(db, s, T(10, 5), "OK")["EVALUATION_STATE"] == "NORMAL"
    assert db.notifications.find({}) == []


def test_no_data_does_not_resolve_or_breach():
    db, s = FakeDB(), sess()
    run(db, s, T(10), "BREACH"); run(db, s, T(10, 5), "BREACH")
    assert run(db, s, T(10, 10), "INSUFFICIENT_DATA")["EVALUATION_STATE"] == "NO_DATA"
    assert run(db, s, T(10, 15), "BREACH")["EVALUATION_STATE"] == "FIRING"


def test_reopen_creates_a_new_episode():
    db, s = FakeDB(), sess()
    for i, st in enumerate(["BREACH", "BREACH", "OK", "OK"]):
        a = run(db, s, T(10, 5 * i), st)
    ep1 = a["EPISODE_ID"]
    run(db, s, T(13, 0), "BREACH")
    a = run(db, s, T(13, 5), "BREACH")
    assert a["EVALUATION_STATE"] == "FIRING" and a["EPISODE_ID"] != ep1


def test_suppression_in_replay_accelerated_and_initial_state():
    for s, initial in ((sess("REPLAY"), False), (sess(speed=60), False), (sess(), True)):
        db = FakeDB()
        run(db, s, T(10), "BREACH", initial); run(db, s, T(10, 5), "BREACH", initial)
        n = db.notifications.find({})
        assert len(n) == 1 and n[0]["STATUS"] == "SUPPRESSED" and n[0]["SUPPRESSED_REASON"]
