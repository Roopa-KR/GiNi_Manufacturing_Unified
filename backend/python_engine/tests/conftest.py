"""Engine unit tests: pure calculation modules with in-memory fakes (no database), plus ledger tests on a disposable database
(GINI_TEST_MONGODB_URI; skipped and reported as skipped when it is not set). Expected values are computed by hand in the
tests (independently of the implementation). Run:  cd backend/python_engine && python -m pytest -q tests"""
import datetime as dt
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import pymongo  # noqa: F401,E402  (the real driver: pip install -r requirements.txt)


def T(h, m=0, s=0, day=15):
    """UTC datetime on 2026-10-<day>"""
    return dt.datetime(2026, 10, day, h, m, s)


import pytest  # noqa: E402


@pytest.fixture
def mdb():
    """a disposable database on GINI_TEST_MONGODB_URI (real MongoDB replica set, or the docdb-wire test substitute - the report says which)"""
    uri = os.environ.get("GINI_TEST_MONGODB_URI")
    if not uri:
        pytest.skip("GINI_TEST_MONGODB_URI not set - ledger tests need a disposable replica-set database")
    import uuid
    from pymongo import MongoClient
    cli = MongoClient(uri, tz_aware=False, serverSelectionTimeoutMS=5000)
    name = "gini_test_%s" % uuid.uuid4().hex[:10]
    db = cli[name]
    db.sim_points_ledger.create_index([("SESSION_ID", 1), ("AWARD_KEY", 1), ("WORKER_ID", 1)], unique=True)
    db.sim_points_ledger.create_index([("SESSION_ID", 1), ("POINTS_TRANSACTION_ID", 1)], unique=True)
    db.sim_points_evaluations.create_index([("SESSION_ID", 1), ("SUBJECT_KEY", 1)], unique=True)
    yield db
    cli.drop_database(name)
    cli.close()
