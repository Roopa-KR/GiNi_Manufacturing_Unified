"""Exact points allocation fixtures from the specification (tests, not hard-coded live values)."""
from gini_engine.allocation import allocate, round_half_away
from gini_engine.points import tv1_split


def test_wo_award_equal_contributors():
    assert allocate(3.0, {"W1": 60, "W2": 60}) == {"W1": 1.5, "W2": 1.5}


def test_origin_award_75_25():
    assert allocate(2.0, {"W1": 75, "W2": 25}) == {"W1": 1.5, "W2": 0.5}


def test_sole_confirmed_downstream_deduction():
    assert allocate(-4.0, {"W1": 1.0}) == {"W1": -4.0}


def test_time_points_saved_and_exceeded():
    assert tv1_split(40, {"W1": 35}) == {"W1": 5.0}
    assert tv1_split(40, {"W1": 46}) == {"W1": -6.0}


def test_crew_shares_split_the_allowance_never_duplicate_it():
    s = tv1_split(90, {"W1": 30, "W2": 30, "W3": 30 - 6})   # actual 84 -> team +6
    assert sum(s.values()) == 6
    assert all(v <= 6 for v in s.values())


def test_reversal_nets_to_zero():
    d = allocate(-4.0, {"W1": 1.0})
    rev = {k: -v for k, v in d.items()}
    assert sum(d.values()) + sum(rev.values()) == 0
    assert rev == {"W1": 4.0}


def test_deterministic_residual_keeps_exact_totals():
    s = allocate(2.0, {"A": 1, "B": 1, "C": 1})
    assert round(sum(s.values()), 2) == 2.0
    assert sorted(s.values()) == [0.66, 0.67, 0.67]
    assert allocate(2.0, {"A": 1, "B": 1, "C": 1}) == s       # same input -> same allocation


def test_no_denominator_stays_pending():
    assert allocate(3.0, {}) is None
    assert allocate(3.0, {"A": 0}) is None
    assert tv1_split(40, {}) is None


def test_half_away_rounding():
    assert round_half_away(2.5) == 3.0 and round_half_away(-2.5) == -3.0 and round_half_away(0.125, 2) == 0.13


# ---- fractional TV1 (RULE_VERSION 2.0: two decimals, exact crew residual) ------------------------------------------------
def test_tv1_fractional_saved_and_exceeded():
    assert tv1_split(40, {"W1": 39.5}) == {"W1": 0.5}
    assert tv1_split(40, {"W1": 40.5}) == {"W1": -0.5}


def test_tv1_crew_total_is_exact_and_split():
    s = tv1_split(90, {"W1": 30, "W2": 30, "W3": 24})
    assert round(sum(s.values()), 2) == 6.00
    assert s == {"W1": 2.14, "W2": 2.14, "W3": 1.72}          # 6x30/84 = 2.1429, 6x24/84 = 1.7143; residual 0.01 to the largest remainder (W3)
    assert all(v < 6 for v in s.values()), "the allowance is shared, never granted to each member"


def test_tv1_three_equal_shares_residual():
    s = tv1_split(31, {"A": 10, "B": 10, "C": 10})          # +1.00 over three people
    assert sorted(s.values()) == [0.33, 0.33, 0.34] and round(sum(s.values()), 2) == 1.0
