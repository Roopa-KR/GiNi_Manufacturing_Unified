"""AT12 continued: firing, non-firing, insufficient-data and boundary cases for M02, M03, M05, M07, M08, M12, M13, F2, F3 and F4,
on synthetic in-memory state with previously unseen IDs. Expected values are worked out by hand in the comments."""
import datetime as dt

from conftest import T
from test_variance import D, obs_for, completed_op

MIN = dt.timedelta(minutes=1)


def with_completed(d, n, std, labor):
    for i in range(n):
        o, s = completed_op(i, "WC1", std, labor, d.now)
        d.ops.append(o)
        d.segments.append(s)


def worker(wid, wc="WC1", state="AVAILABLE", end_in=100, since=None, now=T(15)):
    return {"WORKER_ID": wid, "ATTENDANCE_STATE": "CLOCKED_IN", "WORKER_ROLE": "PRODUCTION_OPERATOR", "CURRENT_WORK_CENTER_ID": wc, "ACTIVITY_STATE": state,
            "PLANNED_END_AT": now + dt.timedelta(minutes=end_in), "STATE_SINCE": since or now - 30 * MIN}


def queued(uid, wc="WC1", entered_min_ago=0, now=T(15)):
    return {"UNIT_ID": uid, "PRODUCT_ID": "PX", "ROUTE_STEP": "OPA", "STATE": "QUEUED", "CURRENT_WORK_CENTER_ID": wc, "QUEUE_ENTERED_AT": now - entered_min_ago * MIN}


# ------------------------------------------------------------------ M02 earned-work gap (>= 120 labour-min and >= 15 % of earned)
def test_m02_gap_fires_ok_insufficient_and_boundary():
    d = D(); with_completed(d, 3, 100, 150)            # earned 300, actual 450 -> gap 150 (50 %)
    o = obs_for(d, "M02", "WC1")[0]
    assert o["status"] == "BREACH" and o["actual"] == 150.0
    d = D(); with_completed(d, 3, 100, 110)            # gap 30
    assert obs_for(d, "M02", "WC1")[0]["status"] == "OK"
    d = D(); with_completed(d, 2, 100, 200)            # only 2 completed attempts
    assert obs_for(d, "M02", "WC1")[0]["status"] == "INSUFFICIENT_DATA"
    d = D(); with_completed(d, 3, 100, 140)            # gap exactly 120 (40 %) -> threshold is inclusive
    assert obs_for(d, "M02", "WC1")[0]["status"] == "BREACH"


# ------------------------------------------------------------------ M03 classification LOW < 85 <= ON_TARGET <= 110 < OVER_TARGET
def test_m03_classification_and_no_data():
    def cls(std, labor):
        d = D(); with_completed(d, 3, std, labor)
        return obs_for(d, "M03", "WC1")[0]["classification"]
    assert cls(100, 125) == "LOW"                      # 80 %
    assert cls(85, 100) == "ON_TARGET"                 # exactly 85 % is not LOW
    assert cls(100, 100) == "ON_TARGET"
    assert cls(100, 85) == "OVER_TARGET"               # 117.6 %
    o = obs_for(D(), "M03", "WC1")[0]
    assert o["status"] == "NO_DATA" and o["classification"] is None


# ------------------------------------------------------------------ M05 capacity gap (remaining std work - qualified available minutes >= 60)
def test_m05_capacity_gap_fires_ok_and_boundary():
    d = D()
    d.units = [queued("U-%d" % i) for i in range(4)]   # 4 x 100 = 400 std-min
    d.workers = [worker("NEW-1", end_in=100)]          # 100 qualified min -> gap 300; staffing gap 300/100 = 3.0 people -> HIGH
    o = obs_for(d, "M05", "WC1")[0]
    assert o["status"] == "BREACH" and o["actual"] == 300.0 and o["severity"] == "HIGH"
    d = D(); d.units = [queued("U-1")]; d.workers = [worker("NEW-1"), worker("NEW-2")]     # 100 vs 200 -> gap -100
    assert obs_for(d, "M05", "WC1")[0]["status"] == "OK"
    d = D(); d.units = [queued("U-1")]; d.workers = [worker("NEW-1", end_in=40)]           # gap exactly 60 -> BREACH, 1.5 people -> MEDIUM
    o = obs_for(d, "M05", "WC1")[0]
    assert o["status"] == "BREACH" and o["severity"] == "MEDIUM"
    d = D(); d.units = [queued("U-1")]; d.workers = [worker("NEW-3")]                      # present but not qualified for WC1 -> 0 capacity
    assert obs_for(d, "M05", "WC1")[0]["actual"] == 100.0


# ------------------------------------------------------------------ M07 productivity-quality conflict (efficiency +10 pp while fail rate +40 % relative)
def inspections(d, n, fails, gate="QG10"):
    d.inspections = [{"GATE_OPERATION_ID": gate, "INSPECTION_KIND": "INDEPENDENT", "ATTEMPT_NO": 1, "COMPLETED_AT": d.now - (10 + i) * MIN, "RESULT": "FAIL" if i < fails else "PASS"} for i in range(n)]


def test_m07_conflict_requires_two_windows_and_is_correlation():
    d = D(); with_completed(d, 3, 100, 100); inspections(d, 10, 2)       # efficiency 100 %, fail 20 %
    assert obs_for(d, "M07", "WC1")[0]["status"] == "INSUFFICIENT_DATA"  # no previous window
    prev = {("M07", "WC1"): {"sample": {"eff": 85.0, "fail": 10.0}}}     # +15 pp, +100 % relative
    o = obs_for(d, "M07", "WC1", prev=prev)[0]
    assert o["status"] == "BREACH" and "not blame" in o["message"]
    prev = {("M07", "WC1"): {"sample": {"eff": 95.0, "fail": 10.0}}}     # +5 pp only
    assert obs_for(d, "M07", "WC1", prev=prev)[0]["status"] == "OK"
    d2 = D(); with_completed(d2, 3, 100, 100); inspections(d2, 5, 2)     # 5 inspections < 6 minimum
    assert obs_for(d2, "M07", "WC1", prev={("M07", "WC1"): {"sample": {"eff": 80.0, "fail": 5.0}}})[0]["status"] == "INSUFFICIENT_DATA"


# ------------------------------------------------------------------ M08 workload surge (released std-min in 120 min vs slot baseline: +600 and +30 %)
def releases(d, n, minutes_ago=30):
    ids = ["REL-%02d" % i for i in range(n)]
    d.units += [{"UNIT_ID": u, "PRODUCT_ID": "PX", "ROUTE_STEP": "OPA", "STATE": "QUEUED", "CURRENT_WORK_CENTER_ID": "WC1"} for u in ids]
    d.events_window.append({"EVENT_TYPE": "BATCH_RELEASED", "ENTITY_ID": "PB-NEW", "EVENT_TIME": d.now - minutes_ago * MIN, "PAYLOAD": {"UNIT_IDS": ids}})
    return ids


def test_m08_counts_batch_releases_once_and_compares_with_slot():
    slot = {"WC1_RELEASE_STD_MIN_120": {"10": 200.0}}  # T(15) UTC = 10:00 plant time
    d = D(); ids = releases(d, 9)                      # 9 x 100 = 900 std-min vs 200 -> +700 (+350 %)
    d.events_window.append({"EVENT_TYPE": "QUEUE_ENTERED", "ENTITY_ID": ids[0], "EVENT_TIME": d.now - 29 * MIN, "PAYLOAD": {"WORK_CENTER_ID": "WC1"}})   # same tank: not double counted
    o = obs_for(d, "M08", baselines=slot)[0]
    assert o["status"] == "BREACH" and o["actual"] == 900.0
    d = D(); releases(d, 3)                            # 300 -> +100
    assert obs_for(d, "M08", baselines=slot)[0]["status"] == "OK"
    d = D(); releases(d, 9)
    assert obs_for(d, "M08")[0]["status"] == "INSUFFICIENT_DATA"          # no baseline for the slot
    d = D(); releases(d, 9)                            # 900 vs 300 -> exactly +600 and +200 % -> inclusive
    assert obs_for(d, "M08", baselines={"WC1_RELEASE_STD_MIN_120": {"10": 300.0}})[0]["status"] == "BREACH"
    d = D(); releases(d, 9, minutes_ago=130)           # outside the 120-min window
    assert obs_for(d, "M08", baselines=slot)[0]["actual"] == 0.0


# ------------------------------------------------------------------ M12 minimum crew (WC1 minimum crew 2)
def test_m12_minimum_crew():
    d = D(); d.units = [queued("U-1")]; d.workers = [worker("NEW-1")]
    o = obs_for(d, "M12", "WC1")[0]
    assert o["status"] == "BREACH" and (o["actual"], o["expected"]) == (1, 2)
    d.workers = [worker("NEW-1"), worker("NEW-2")]     # exactly the minimum crew -> OK
    assert obs_for(d, "M12", "WC1")[0]["status"] == "OK"
    d = D(); d.workers = [worker("NEW-1")]             # no ready work -> no staffing finding
    assert obs_for(d, "M12", "WC1")[0]["status"] == "OK"


# ------------------------------------------------------------------ M13 assignment delay (ready work + eligible waiting person + free station >= 20 min) and stale telemetry
def test_m13_assignment_delay_and_stale_device():
    d = D(); d.units = [queued("U-1", entered_min_ago=25)]; d.workers = [worker("NEW-1", state="WAITING")]
    assert obs_for(d, "M13", "WC1")[0]["status"] == "BREACH"
    d.units = [queued("U-1", entered_min_ago=19)]
    assert obs_for(d, "M13", "WC1")[0]["status"] == "OK"
    d.units = [queued("U-1", entered_min_ago=20)]      # boundary inclusive
    assert obs_for(d, "M13", "WC1")[0]["status"] == "BREACH"
    d.workers = [worker("NEW-3", state="WAITING")]     # waiting but not qualified -> not an assignment delay
    assert obs_for(d, "M13", "WC1")[0]["status"] == "OK"
    d = D(); w = worker("NEW-1", state="WORKING"); w.update(CURRENT_TASK_ID="TSK-NEW", DISPLAY_NAME="New One",
                                                          CONTROL={"MODE": "HUMAN", "LEASE_EXPIRES_AT": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(minutes=5)})
    d.workers = [w]
    st = [o for o in obs_for(d, "M13") if o["entity_id"] == "NEW-1"]
    assert st and st[0]["status"] == "NO_DATA" and "not idle" in st[0]["message"]


# ------------------------------------------------------------------ F2 regional imbalance (one area ratio > 1.3, another < 0.7, >= 2 transferable qualified people)
def test_f2_fires_only_with_transferable_qualified_people():
    d = D()
    d.units = [queued("U-%d" % i) for i in range(8)]   # AREA-FAB load 800 std-min
    d.workers = [worker("NEW-1", end_in=100)]          # FAB capacity 100 -> ratio 8.0
    d.cat.quals.update({"FIN-1": {"SK-WC3", "SK-X"}, "FIN-2": {"SK-WC3", "SK-X"}})
    d.workers += [worker("FIN-1", wc="WC3"), worker("FIN-2", wc="WC3")]  # FIN load 0 vs 200 -> ratio 0.0; both qualified for SK-X
    o = obs_for(d, "F2")[0]
    assert o["status"] == "BREACH" and o["actual"]["AREA-FAB"] == 8.0 and o["actual"]["AREA-FIN"] == 0.0
    d.cat.quals["FIN-2"] = {"SK-WC3"}                  # only one transferable person (< 2)
    assert obs_for(d, "F2")[0]["status"] == "OK"


# ------------------------------------------------------------------ F3 material velocity (issues per productive hour vs history: >= 50 % and >= 2 issues off)
def seg(d, minutes):
    d.segments.append({"WORKER_ID": "NEW-1", "CATEGORY": "DIRECT", "WORK_CENTER_ID": "WC1", "START_AT": d.now - minutes * MIN, "END_AT": d.now})


def issued(d, n):
    d.events_window += [{"EVENT_TYPE": "MATERIAL_CONSUMED", "ENTITY_ID": "MAT-NEW", "EVENT_TIME": d.now - (5 + i) * MIN} for i in range(n)]


def test_f3_material_velocity():
    base = {"MATERIAL_ISSUES_PER_PRODUCTIVE_HOUR": 2.0}
    d = D(); seg(d, 120); issued(d, 10)               # 2 productive hours, expected 4, observed 10 (5/h, +150 %)
    o = obs_for(d, "F3", baselines=base)[0]
    assert o["status"] == "BREACH" and o["entity_id"] == "PLANT" and o["actual"] == 5.0 and o["sample"]["expected_issues"] == 4.0
    d = D(); seg(d, 120); issued(d, 5)                # 2.5/h: +25 % and only 1 issue off
    assert obs_for(d, "F3", baselines=base)[0]["status"] == "OK"
    d = D(); seg(d, 30); issued(d, 10)                # 0.5 productive hours: zero/low demand is not a fault
    assert obs_for(d, "F3", baselines=base)[0]["status"] == "INSUFFICIENT_DATA"
    d = D(); seg(d, 120); issued(d, 10)
    assert obs_for(d, "F3")[0]["status"] == "INSUFFICIENT_DATA"            # no baseline


# ------------------------------------------------------------------ F4 location velocity (dwell >= median x 1.5 and >= +30 min)
def test_f4_dwell_vs_median():
    base = {"DWELL_MEDIAN_MIN": {"WC1": 100.0}}

    def unit(dwell):
        d = D()
        d.units = [{"UNIT_ID": "U-F4", "STATE": "WORKING", "CURRENT_WORKSTATION_ID": "WC1-S1", "CURRENT_WORK_CENTER_ID": "WC1", "STATE_SINCE": d.now - dwell * MIN, "CURRENT_OPERATION_INSTANCE_ID": "OPI-F4"}]
        d.ops = [{"OPERATION_INSTANCE_ID": "OPI-F4", "STARTED_AT": d.now - dwell * MIN}]
        return d
    o = obs_for(unit(200), "F4", baselines=base)[0]
    assert o["status"] == "BREACH" and "not lack of supply" in o["message"]
    assert obs_for(unit(150), "F4", baselines=base)[0]["status"] == "BREACH"   # exactly 1.5 x and +50 min
    assert obs_for(unit(120), "F4", baselines=base) == []                      # normal dwell: no finding (an open alert clears as "gone")
    assert obs_for(unit(400), "F4") == []                                      # no baseline: nothing claimed
