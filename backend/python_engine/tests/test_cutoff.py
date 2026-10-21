"""Cutoff classification (spec example: cutoff 14:30, buffer 10 -> 14:20 GREEN, 14:25 AMBER, 14:35 RED; missing forecast UNKNOWN)."""
import datetime as dt
from gini_engine.forecast import classify
from gini_engine.timeutil import local_to_utc
from conftest import T

CUT = T(14, 30)


def test_spec_example_bands():
    assert classify(T(14, 20), CUT, 10)["band"] == "GREEN"
    assert classify(T(14, 25), CUT, 10)["band"] == "AMBER"
    assert classify(T(14, 35), CUT, 10)["band"] == "RED"
    assert classify(None, CUT, 10, now=T(10))["band"] == "UNKNOWN"


def test_boundaries_and_seconds():
    assert classify(T(14, 20), CUT, 10)["band"] == "GREEN"          # equal to buffer deadline
    assert classify(T(14, 20, 1), CUT, 10)["band"] == "AMBER"       # one second inside the buffer
    assert classify(T(14, 30), CUT, 10)["band"] == "AMBER"          # equal to cutoff
    assert classify(T(14, 30, 1), CUT, 10)["band"] == "RED"         # one second late


def test_quantity_shortfall_is_red_even_with_an_early_finish():
    r = classify(T(12), CUT, 10, shortfall=2, now=T(10))
    assert r["band"] == "RED" and "shortfall" in r["reason"].lower()


def test_cutoff_elapsed_without_output_is_red_not_unknown():
    r = classify(None, CUT, 10, now=T(15))
    assert r["band"] == "RED" and r["cutoff_elapsed"]


def test_completed_output_keeps_its_actual_result():
    assert classify(None, CUT, 10, complete_at=T(14, 26))["actual_result"] == "AMBER"
    assert classify(None, CUT, 10, complete_at=T(14, 40))["actual_result"] == "RED"
    assert classify(None, CUT, 10, complete_at=T(9))["band"] == "COMPLETE"


def test_overnight_and_timezone():
    # plant cutoff 01:00 local on Oct 16 (America/Bogota, UTC-5) = 06:00 UTC; forecast 23:30 local Oct 15 = 04:30 UTC
    cut = local_to_utc("2026-10-16", "01:00")
    assert cut == dt.datetime(2026, 10, 16, 6, 0)
    assert classify(local_to_utc("2026-10-15", "23:30"), cut, 10)["band"] == "GREEN"
    assert classify(local_to_utc("2026-10-16", "00:55"), cut, 10)["band"] == "AMBER"
    assert classify(local_to_utc("2026-10-16", "01:00"), cut, 10)["band"] == "AMBER"


def test_no_cutoff_is_unknown():
    assert classify(T(10), None, 10)["band"] == "UNKNOWN"
