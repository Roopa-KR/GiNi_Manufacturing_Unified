"""AT16: delayed calculation passes can never overwrite a newer projection, and a superseded pass removes only its own documents.
Expected outcomes are stated by hand from the fencing rule (publish only if no higher version and no newer input watermark)."""
from fakedb import FakeDB

from gini_engine import calc as CALC


def session(db, pv=0, wm=None):
    db.sim_sessions.insert_one({"SESSION_ID": "S-T", "PROJECTION_VERSION": pv, "ENGINE": {"WATERMARK_SEQ": wm}})
    return db.sim_sessions.find_one({"SESSION_ID": "S-T"})


def docs(pv, tag):
    return [{"SESSION_ID": "S-T", "PROJECTION_VERSION": pv, "KIND": "ORDER_FORECAST_SUMMARY", "ENTITY_ID": "L1", "TAG": tag}]


def test_concurrent_passes_get_distinct_versions():
    db = FakeDB()
    s = session(db, pv=4)
    a = CALC.allocate_version(db, s)
    b = CALC.allocate_version(db, s)          # second pass started from the same published version
    assert (a, b) == (5, 6)


def test_older_input_cannot_overwrite_newer_projection():
    db = FakeDB()
    s = session(db, pv=4, wm=10)
    slow = CALC.allocate_version(db, s)       # started first, input watermark 11
    fast = CALC.allocate_version(db, s)       # started second, input watermark 12, finishes first
    assert CALC.publish(db, "S-T", fast, 12, docs(fast, "fast")) is True
    assert CALC.publish(db, "S-T", slow, 11, docs(slow, "slow")) is False   # delayed job: superseded
    sess = db.sim_sessions.find_one({"SESSION_ID": "S-T"})
    assert sess["PROJECTION_VERSION"] == fast and sess["ENGINE"]["WATERMARK_SEQ"] == 12
    tags = [d["TAG"] for d in db.sim_projections.find({"SESSION_ID": "S-T"})]
    assert tags == ["fast"], "the winner's documents survive; only the loser's are removed"


def test_higher_version_with_stale_watermark_is_refused():
    db = FakeDB()
    s = session(db, pv=4, wm=20)
    v = CALC.allocate_version(db, s)
    assert CALC.publish(db, "S-T", v, 19, docs(v, "stale")) is False       # input older than what is already published
    assert db.sim_sessions.find_one({"SESSION_ID": "S-T"})["PROJECTION_VERSION"] == 4
    assert db.sim_projections.find({"SESSION_ID": "S-T"}) == []


def test_publish_keeps_three_versions():
    db = FakeDB()
    s = session(db, pv=0, wm=0)
    for wm in range(1, 6):
        v = CALC.allocate_version(db, db.sim_sessions.find_one({"SESSION_ID": "S-T"}))
        assert CALC.publish(db, "S-T", v, wm, docs(v, "v%d" % v))
    assert sorted(d["PROJECTION_VERSION"] for d in db.sim_projections.find({"SESSION_ID": "S-T"})) == [3, 4, 5]
