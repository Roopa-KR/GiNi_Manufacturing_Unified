"""Deadline-aware scheduling: the next evaluation times are the band boundaries themselves, not a fixed 5-minute grid.
Cutoff 14:30, buffer 10 -> a line forecast GREEN must be re-evaluated at 14:20:01 (the first second strictly after the buffer
deadline 14:20:00, which is still GREEN) and at 14:30:01 (14:30:00 is still AMBER); a replenishment needed by 14:00 with F6
threshold 10 min breaches at 14:10:00 (inclusive). The engine evaluates at those instants, not at the next whole minute."""
import datetime as dt
from fakedb import FakeDB
from conftest import T

from gini_engine.calc import next_boundaries
from gini_engine.forecast import classify
from gini_engine.worker import plan_advance

S1 = dt.timedelta(seconds=1)


class Cat:
    shifts = {}


def test_boundaries_follow_deadlines_not_a_fixed_interval():
    db = FakeDB()
    db.sim_material_requests.insert_one({"SESSION_ID": "S", "REQUEST_ID": "MR-1", "STATUS": "OPEN", "NEED_BY_AT": T(14, 0)})
    db.sim_material_requests.insert_one({"SESSION_ID": "S", "REQUEST_ID": "MR-2", "STATUS": "DELIVERED", "NEED_BY_AT": T(13, 0)})
    lines = [{"ORDER_LINE_ID": "L1", "BAND": "GREEN", "BUFFER_DEADLINE_AT": T(14, 20), "DUE_AT": T(14, 30)},
             {"ORDER_LINE_ID": "L2", "BAND": "COMPLETE", "BUFFER_DEADLINE_AT": T(13, 50), "DUE_AT": T(14, 0)}]
    b = next_boundaries(db, Cat(), {"SESSION_ID": "S"}, T(13, 40), lines, {"F6": {"threshold": {"min_minutes": 10}}})
    assert [t for t, _ in b] == [T(14, 10), T(14, 20) + S1, T(14, 30) + S1]
    assert "MR-1" in b[0][1] and "buffer deadline" in b[1][1] and "cutoff" in b[2][1]


def test_passed_boundaries_are_not_rescheduled():
    db = FakeDB()
    lines = [{"ORDER_LINE_ID": "L1", "BAND": "AMBER", "BUFFER_DEADLINE_AT": T(14, 20), "DUE_AT": T(14, 30)}]
    assert [t for t, _ in next_boundaries(db, Cat(), {"SESSION_ID": "S"}, T(14, 25), lines, {})] == [T(14, 30) + S1]
    assert next_boundaries(db, Cat(), {"SESSION_ID": "S"}, T(14, 30) + S1, lines, {}) == []


def test_the_band_changes_exactly_at_the_scheduled_instant():
    """the scheduled instant is the first one with a different result (no event needed): 14:30:00 AMBER/not elapsed, 14:30:01 elapsed"""
    cutoff = T(14, 30)
    at = classify(None, cutoff, 10, now=cutoff)
    after = classify(None, cutoff, 10, now=cutoff + S1)
    assert at["band"] == "UNKNOWN" and not at["cutoff_elapsed"]
    assert after["band"] == "RED" and after["cutoff_elapsed"]
    assert classify(T(14, 20), cutoff, 10, now=T(14, 0))["band"] == "GREEN"
    assert classify(T(14, 20) + S1, cutoff, 10, now=T(14, 0))["band"] == "AMBER"
    assert classify(cutoff, cutoff, 10, now=T(14, 0))["band"] == "AMBER"
    assert classify(cutoff + S1, cutoff, 10, now=T(14, 0))["band"] == "RED"


def test_engine_stops_before_the_minute_that_would_pass_a_sub_minute_boundary():
    # applied up to 14:29, clock at 14:35, cutoff boundary 14:30:01 -> step to 14:30 only, then evaluate AT 14:30:01
    steps, hit = plan_advance(T(14, 29), T(14, 35), T(14, 30) + S1, 30)
    assert steps == [T(14, 30)] and hit == T(14, 30) + S1


def test_boundary_inside_the_current_partial_minute_is_evaluated_without_waiting_for_the_minute():
    # clock at 14:30:05 (x1: five seconds after the cutoff) -> evaluate at 14:30:01 now, not at 14:31
    steps, hit = plan_advance(T(14, 30), T(14, 30) + dt.timedelta(seconds=5), T(14, 30) + S1, 30)
    assert steps == [] and hit == T(14, 30) + S1
    # not reached yet: nothing to do
    assert plan_advance(T(14, 30), T(14, 30), T(14, 30) + S1, 30) == ([], None)


def test_on_minute_boundary_is_evaluated_after_that_minute_is_applied():
    # a shift end at 19:30:00: the 19:30 agent step (clock-outs) happens first, then the evaluation
    steps, hit = plan_advance(T(19, 28), T(19, 40), T(19, 30), 30)
    assert steps == [T(19, 29), T(19, 30)] and hit == T(19, 30)


def test_no_boundary_or_boundary_beyond_the_step_limit():
    steps, hit = plan_advance(T(10, 0), T(10, 5), None, 30)
    assert len(steps) == 5 and hit is None
    steps, hit = plan_advance(T(10, 0), T(12, 0), T(11, 0) + S1, 30)      # boundary beyond this tick's 30 minutes
    assert len(steps) == 30 and hit is None
