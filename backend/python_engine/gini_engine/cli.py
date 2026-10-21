"""Operator CLI for the engine (one-shot maintenance; the worker does all of this continuously).

    python -m gini_engine.cli check                 config + database + seed presence
    python -m gini_engine.cli indexes               create indexes from contracts/indexes.json
    python -m gini_engine.cli init <SESSION_ID>     run INIT_SESSION now
    python -m gini_engine.cli calc <SESSION_ID>     run one calculation pass now
    python -m gini_engine.cli recovery <SESSION_ID> [ORDER_LINE_ID]
    python -m gini_engine.cli reduce [RUN_ID] [ISO_UTC]   print the reduced state summary (default checkpoint)
"""
import datetime as dt
import json
import sys

from . import config as CFG
from .worker import Engine, ensure_indexes, log
from .timeutil import sim_now


def main(argv):
    st = CFG.load()
    eng = Engine(st)
    cmd = argv[0] if argv else "check"
    if cmd == "check":
        p = st.problems()
        print(json.dumps({"config_problems": p, "mongo_db": st.mongo_db, "api": st.api_internal_url}, indent=2))
        eng.connect()
        print(json.dumps({c: eng.db[c].estimated_document_count() for c in ("worker_master", "routing_operations", "production_events", "sim_sessions", "jobs")}, indent=2))
        return 0
    eng.connect()
    if cmd == "indexes":
        print("indexes ensured:", ensure_indexes(eng.db, st))
    elif cmd == "init":
        s = eng.db.sim_sessions.find_one({"SESSION_ID": argv[1]})
        eng.run_job({"JOB_ID": "CLI", "TYPE": "INIT_SESSION", "SESSION_ID": s["SESSION_ID"], "FENCE": 0, "ATTEMPTS": 1})
    elif cmd == "calc":
        s = eng.db.sim_sessions.find_one({"SESSION_ID": argv[1]})
        print(json.dumps(eng._calc(s, sim_now(s)), default=str, indent=2))
    elif cmd == "recovery":
        s = eng.db.sim_sessions.find_one({"SESSION_ID": argv[1]})
        print(json.dumps(eng.recovery(s, argv[2] if len(argv) > 2 else None), default=str, indent=2))
    elif cmd == "reduce":
        from .reduce import reduce_state, summary
        run = argv[1] if len(argv) > 1 else "RUN-BASE"
        T = dt.datetime.fromisoformat(argv[2]) if len(argv) > 2 else dt.datetime(2026, 10, 15, 15, 55)
        print(json.dumps(summary(reduce_state(eng.db, eng.cat, run, T)), indent=2))
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
