"""Fresh-factory learning uses past database records, never the evaluation window or another factory."""
import datetime as dt
from gini_engine.baselines import compute_factory
from conftest import T


def test_empty_factory_has_no_invented_baseline(mdb):
    b = compute_factory(mdb, None, {'SESSION_ID': 'F'}, T(18))
    assert b['MATERIAL_ISSUES_PER_PRODUCTIVE_HOUR'] is None
    assert b['DWELL_MEDIAN_MIN'] == {}
    assert b['QUEUE_STD_MIN'] == {}


def test_completed_past_work_teaches_baseline_but_current_and_other_session_do_not(mdb):
    now = T(18)
    for i in range(3):
        mdb.sim_operations.insert_one({'SESSION_ID': 'F', 'OPERATION_KIND': 'LABOR', 'WORK_CENTER_ID': 'FAB', 'STARTED_AT': T(12, i), 'WORK_COMPLETED_AT': T(13, i)})
    mdb.sim_operations.insert_one({'SESSION_ID': 'OTHER', 'OPERATION_KIND': 'LABOR', 'WORK_CENTER_ID': 'FAB', 'STARTED_AT': T(1), 'WORK_COMPLETED_AT': T(14)})
    mdb.sim_operations.insert_one({'SESSION_ID': 'F', 'OPERATION_KIND': 'LABOR', 'WORK_CENTER_ID': 'FAB', 'STARTED_AT': T(1), 'WORK_COMPLETED_AT': T(17)})
    mdb.sim_participation.insert_one({'SESSION_ID': 'F', 'CATEGORY': 'DIRECT', 'START_AT': T(12), 'END_AT': T(14)})
    for i in range(4):
        mdb.sim_events.insert_one({'SESSION_ID': 'F', 'EVENT_ID': 'E'+str(i), 'EVENT_TYPE': 'MATERIAL_CONSUMED', 'EVENT_TIME': T(13,i), 'KNOWN_AT': T(13,i)})
    mdb.sim_events.insert_one({'SESSION_ID': 'F', 'EVENT_ID': 'NEW', 'EVENT_TYPE': 'MATERIAL_CONSUMED', 'EVENT_TIME': T(17), 'KNOWN_AT': T(17)})
    b = compute_factory(mdb, None, {'SESSION_ID': 'F'}, now)
    assert b['DWELL_MEDIAN_MIN']['FAB'] == 60
    assert b['DWELL_SAMPLES']['FAB'] == 3
    assert b['MATERIAL_ISSUES_PER_PRODUCTIVE_HOUR'] == 2
    assert b['WINDOW_END'] == T(16)
