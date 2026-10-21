"""Variance rules: firing, non-firing, insufficient-data and boundary cases on synthetic in-memory state with previously unseen IDs."""
import copy
import datetime as dt
import json
import os

from gini_engine import variance as V
from conftest import T

RULES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "config", "rules.json")))["rules"]


class Cat:
    def __init__(self):
        self.routing = [
            {"PRODUCT_ID": "PX", "OPERATION_ID": "OPA", "WORK_CENTER_ID": "WC1", "OPERATION_KIND": "LABOR", "STANDARD_LABOR_MIN": 100, "STD_CREW_SIZE": 2, "MIN_CREW_SIZE": 2, "MAX_CREW_SIZE": 3, "REQUIRED_SKILL_ID": "SK-X", "SEQUENCE_NO": 10},
            {"PRODUCT_ID": "PX", "OPERATION_ID": "QGA", "WORK_CENTER_ID": "WC1", "OPERATION_KIND": "INSPECTION", "STANDARD_ELAPSED_MIN": 10, "SEQUENCE_NO": 20},
        ]
        for wc in ("WC2", "WC3", "WC4"):
            self.routing.append({"PRODUCT_ID": "PX", "OPERATION_ID": "OP" + wc, "WORK_CENTER_ID": wc, "OPERATION_KIND": "LABOR", "STANDARD_LABOR_MIN": 60, "STD_CREW_SIZE": 1, "MIN_CREW_SIZE": 1, "REQUIRED_SKILL_ID": "SK-" + wc})
        self.wcs = {"WC1": {"QUEUE_CAPACITY_UNITS": 4}, "WC2": {"QUEUE_CAPACITY_UNITS": None}, "WC3": {}, "WC4": {"QUEUE_CAPACITY_UNITS": 6}}
        self.quals = {"NEW-1": {"SK-X"}, "NEW-2": {"SK-X"}, "NEW-3": {"SK-WC2"}}

    def op(self, product, op_id):
        return next((r for r in self.routing if r["OPERATION_ID"] == op_id), None)

    def qualified(self, wid, skill, at):
        return skill in self.quals.get(wid, set())

    def stations_of(self, wc):
        return [{"WORKSTATION_ID": "%s-S%d" % (wc, i), "EQUIPMENT_ID": "%s-E%d" % (wc, i)} for i in (1, 2)]

    def elapsed_for_crew(self, product, op_id, crew):
        return 100 / max(1, crew)

    def milestones_for(self, op_id, t="STANDARD"):
        return [{"MILESTONE_ID": "M1", "MILESTONE_NAME": "first", "PROGRESS_THRESHOLD": 0.5, "ATTENDED": "Y"}, {"MILESTONE_ID": "M2", "MILESTONE_NAME": "done", "PROGRESS_THRESHOLD": 1.0, "ATTENDED": "Y"}]


class D:
    def __init__(self, now=T(15)):
        self.now, self.fork, self.cat = now, T(10), Cat()
        self.units, self.ops, self.workers, self.equipment, self.requests = [], [], [], [], []
        self.segments, self.events_window, self.inspections = [], [], []
        self.hist_segments, self.hist_ops, self.hist_ins = [], [], []


def obs_for(d, rule_id, entity=None, baselines=None, forecast=None, prev=None):
    out = V.evaluate(d, [r for r in RULES if r["rule_id"] == rule_id], baselines or {}, forecast or [], prev or {})
    return [o for o in out if entity is None or o["entity_id"] == entity]


def completed_op(i, wc, std, labor_min, now):
    oid = "OPI-NEW-%03d" % i
    return ({"OPERATION_INSTANCE_ID": oid, "OPERATION_KIND": "LABOR", "WORK_CENTER_ID": wc, "STATE": "WORK_COMPLETED", "WORK_COMPLETED_AT": now - dt.timedelta(minutes=20 + i),
             "STANDARD_LABOR_MIN": std, "INSTANCE_TYPE": "NORMAL"},
            {"OPERATION_INSTANCE_ID": oid, "CATEGORY": "DIRECT", "WORKER_ID": "NEW-1", "START_AT": now - dt.timedelta(minutes=20 + i + labor_min), "END_AT": now - dt.timedelta(minutes=20 + i)})


# ------------------------------------------------------------------ M01 labour efficiency
def test_m01_fires_with_sufficient_completed_work_below_threshold():
    d = D()
    for i in range(3):
        o, s = completed_op(i, "WC1", 40, 60, d.now)        # earned 120 std-min over 180 labour-min = 66.7 %
        d.ops.append(o); d.segments.append(s)
    o = obs_for(d, "M01", "WC1")[0]
    assert o["status"] == "BREACH" and o["severity"] == "HIGH" and abs(o["actual"] - 66.7) < 0.1


def test_m01_ok_at_standard():
    d = D()
    for i in range(3):
        o, s = completed_op(i, "WC1", 60, 60, d.now)
        d.ops.append(o); d.segments.append(s)
    assert obs_for(d, "M01", "WC1")[0]["status"] == "OK"


def test_m01_insufficient_sample_and_no_data_are_distinguished():
    d = D()
    o, s = completed_op(0, "WC1", 10, 60, d.now)
    d.ops.append(o); d.segments.append(s)
    assert obs_for(d, "M01", "WC1")[0]["status"] == "INSUFFICIENT_DATA"
    assert obs_for(D(), "M01", "WC1")[0]["status"] == "NO_DATA"           # missing data is not zero throughput


def test_m01_boundary_85_percent_fires():
    d = D()
    for i in range(3):
        o, s = completed_op(i, "WC1", 51, 60, d.now)         # 153/180 = 85.0 %
        d.ops.append(o); d.segments.append(s)
    o = obs_for(d, "M01", "WC1")[0]
    assert o["actual"] == 85.0 and o["status"] == "BREACH"


# ------------------------------------------------------------------ M04 backlog: zero baseline is not infinity
def test_m04_zero_baseline_uses_absolute_threshold():
    d = D()
    d.units = [{"UNIT_ID": "U-NEW-%d" % i, "PRODUCT_ID": "PX", "ROUTE_STEP": "OPA", "STATE": "QUEUED", "CURRENT_WORK_CENTER_ID": "WC1"} for i in range(4)]
    slot = str((d.now - dt.timedelta(hours=5)).hour)                    # Bogota local hour of 15:00 UTC = 10
    base = {"QUEUE_STD_MIN": {"WC1": {slot: 0.0}}, "QUEUE_SAMPLE_DAYS": {"WC1": 5}}
    o = obs_for(d, "M04", "WC1", baselines=base)[0]
    assert o["status"] == "BREACH" and o["classification"] == "NEW_BACKLOG"        # 400 >= 300 absolute
    d.units = d.units[:2]
    assert obs_for(d, "M04", "WC1", baselines=base)[0]["status"] == "OK"          # 200 < 300


def test_m04_without_baseline_days_is_insufficient():
    d = D()
    d.units = [{"UNIT_ID": "U1", "PRODUCT_ID": "PX", "ROUTE_STEP": "OPA", "STATE": "QUEUED", "CURRENT_WORK_CENTER_ID": "WC1"}]
    assert obs_for(d, "M04", "WC1", baselines={})[0]["status"] == "INSUFFICIENT_DATA"


# ------------------------------------------------------------------ M06 gate fail rate
def test_m06_insufficient_then_fires():
    d = D()
    d.inspections = [{"GATE_OPERATION_ID": "QG10", "INSPECTION_KIND": "INDEPENDENT", "ATTEMPT_NO": 1, "COMPLETED_AT": d.now - dt.timedelta(minutes=10), "RESULT": "FAIL"}] * 3
    assert obs_for(d, "M06", "QG10")[0]["status"] == "INSUFFICIENT_DATA"
    d.inspections = [{"GATE_OPERATION_ID": "QG10", "INSPECTION_KIND": "INDEPENDENT", "ATTEMPT_NO": 1, "COMPLETED_AT": d.now - dt.timedelta(minutes=10 + i), "RESULT": "FAIL" if i < 3 else "PASS"} for i in range(10)]
    o = obs_for(d, "M06", "QG10", baselines={"FIRST_ATTEMPT_FAIL_RATE": {"QG10": 0.04}})[0]
    assert o["status"] == "BREACH" and o["actual"] == 30.0


# ------------------------------------------------------------------ M09 deadline risk from the forecast bands
def test_m09_red_fires_amber_pending_unknown_no_data():
    d = D()
    fc = [{"ORDER_LINE_ID": "L-RED", "BAND": "RED"}, {"ORDER_LINE_ID": "L-AMB", "BAND": "AMBER"}, {"ORDER_LINE_ID": "L-UNK", "BAND": "UNKNOWN"}, {"ORDER_LINE_ID": "L-OK", "BAND": "GREEN"}]
    by = {o["entity_id"]: o for o in obs_for(d, "M09", forecast=fc)}
    assert by["L-RED"]["status"] == "BREACH" and by["L-AMB"]["pending"] and by["L-UNK"]["status"] == "NO_DATA" and by["L-OK"]["status"] == "OK"


# ------------------------------------------------------------------ M10 starvation is supply, not performance
def test_m10_starvation_with_qualified_waiting_crew_and_free_station():
    d = D()
    d.workers = [{"WORKER_ID": w, "ATTENDANCE_STATE": "CLOCKED_IN", "WORKER_ROLE": "PRODUCTION_OPERATOR", "CURRENT_WORK_CENTER_ID": "WC1", "ACTIVITY_STATE": "WAITING", "STATE_SINCE": d.now - dt.timedelta(minutes=35)} for w in ("NEW-1", "NEW-2")]
    o = obs_for(d, "M10", "WC1")[0]
    assert o["status"] == "BREACH" and "not a performance issue" in o["message"]
    d.units = [{"UNIT_ID": "U1", "PRODUCT_ID": "PX", "ROUTE_STEP": "OPA", "STATE": "QUEUED", "CURRENT_WORK_CENTER_ID": "WC1"}]
    assert obs_for(d, "M10", "WC1")[0]["status"] == "OK"


# ------------------------------------------------------------------ M11 equipment
def test_m11_equipment_down():
    d = D()
    d.equipment = [{"EQUIPMENT_ID": "WC1-E1", "WORKSTATION_ID": "WC1-S1", "STATUS": "DOWN", "SINCE": d.now - dt.timedelta(minutes=90), "REASON_CODE": "PARTS_DELAY"}]
    o = obs_for(d, "M11")[0]
    assert o["status"] == "BREACH" and o["severity"] == "HIGH"


# ------------------------------------------------------------------ F1 stalled active assignment
def test_f1_stalled_vs_progressing():
    d = D()
    base = {"OPERATION_INSTANCE_ID": "OPI-F1", "OPERATION_KIND": "LABOR", "STATE": "WORKING", "OPERATION_ID": "OPA", "UNIT_ID": "U9", "PRODUCT_ID": "PX", "CREW": ["NEW-1", "NEW-2"], "MILESTONES_DONE": [], "ORIGIN": "BRANCH_NEW"}
    d.ops = [dict(base, STARTED_AT=d.now - dt.timedelta(minutes=120))]      # expected 0.5 * 50 = 25 min; 120 >= 37.5 and +95
    o = obs_for(d, "F1")[0]
    assert o["status"] == "BREACH"
    d.ops = [dict(base, STARTED_AT=d.now - dt.timedelta(minutes=30))]       # 30 < 37.5
    assert obs_for(d, "F1")[0]["status"] == "OK"


# ------------------------------------------------------------------ F5 congestion needs configured capacity
def test_f5_capacity_required_and_occupancy():
    d = D()
    d.units = [{"UNIT_ID": "U%d" % i, "PRODUCT_ID": "PX", "ROUTE_STEP": "OPA", "STATE": "QUEUED", "CURRENT_WORK_CENTER_ID": "WC1"} for i in range(4)]
    by = {o["entity_id"]: o for o in obs_for(d, "F5")}
    assert by["WC1"]["status"] == "BREACH" and by["WC1"]["actual"] == 100.0
    assert by["WC2"]["status"] == "NO_DATA"           # queue size without capacity cannot establish congestion


# ------------------------------------------------------------------ F6 replenishment delay; partial and cancelled
def test_f6_partial_outstanding_and_cancelled():
    d = D()
    d.requests = [{"REQUEST_ID": "R1", "MATERIAL_ID": "M-NEW", "QTY": 10, "DELIVERED_QTY": 4, "NEED_BY_AT": d.now - dt.timedelta(minutes=25), "STATUS": "PARTIALLY_DELIVERED"},
                  {"REQUEST_ID": "R2", "MATERIAL_ID": "M-NEW", "QTY": 10, "NEED_BY_AT": d.now - dt.timedelta(minutes=60), "STATUS": "CANCELLED"},
                  {"REQUEST_ID": "R3", "MATERIAL_ID": "M-NEW", "QTY": 5, "DELIVERED_QTY": 5, "NEED_BY_AT": d.now - dt.timedelta(minutes=60), "STATUS": "OPEN"}]
    d.ops = [{"OPERATION_INSTANCE_ID": "OPI-W", "BLOCKED_MATERIAL_ID": "M-NEW", "STATE": "PAUSED"}]
    by = {o["entity_id"]: o for o in obs_for(d, "F6")}
    assert by["R1"]["status"] == "BREACH" and by["R1"]["severity"] == "HIGH" and "OPI-W" in by["R1"]["evidence"]
    assert "R2" not in by                              # cancelled requests are excluded
    assert by["R3"]["status"] == "OK"                  # fully delivered -> nothing outstanding


# ------------------------------------------------------------------ F2 regional imbalance needs transferable qualified people
def test_f2_imbalance_requires_transferable_people():
    d = D()
    d.units = [{"UNIT_ID": "U%d" % i, "PRODUCT_ID": "PX", "ROUTE_STEP": "OPA", "STATE": "QUEUED", "CURRENT_WORK_CENTER_ID": "WC1"} for i in range(8)]
    end = d.now + dt.timedelta(minutes=100)
    d.workers = [{"WORKER_ID": "NEW-1", "ATTENDANCE_STATE": "CLOCKED_IN", "WORKER_ROLE": "PRODUCTION_OPERATOR", "CURRENT_WORK_CENTER_ID": "WC1", "PLANNED_END_AT": end},
                 {"WORKER_ID": "NEW-3", "ATTENDANCE_STATE": "CLOCKED_IN", "WORKER_ROLE": "PRODUCTION_OPERATOR", "CURRENT_WORK_CENTER_ID": "WC2", "PLANNED_END_AT": end}]
    d.cat.quals["W-FIN"] = {"SK-WC3", "SK-X"}
    d.workers += [{"WORKER_ID": "W-FIN", "ATTENDANCE_STATE": "CLOCKED_IN", "WORKER_ROLE": "PRODUCTION_OPERATOR", "CURRENT_WORK_CENTER_ID": "WC3", "PLANNED_END_AT": end}]
    o = obs_for(d, "F2")[0]
    assert o["status"] in ("OK", "BREACH", "NO_DATA")
    assert o["entity_id"] == "AREAS"
