"""Row-level evidence for the checkpoint task reconciliation exception (DATA_IMPORT_REPORT.md).

REF_CHECKPOINT_WORKER_STATE (CK-20261015-1055) names a CURRENT_TASK_ID for 158 people; the application reconstructs 62 active
assignments. For every other referenced task this lists, from the imported Final data and only records KNOWN_AT <= the checkpoint:
the task's status and last task event (and how long before the checkpoint), the operation's finish, the tank's state.
The application is NOT changed to match the reference sheet; this file is the evidence for each excluded row.

    python seed/tools/checkpoint_task_exceptions.py --out docs/test-results/import/checkpoint_task_exceptions.csv
Env: MONGODB_URI, MONGODB_DB_NAME (read-only queries)."""
import argparse
import csv
import os
import sys

from pymongo import MongoClient

CK = "CK-20261015-1055"
RUN = "RUN-BASE"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--checkpoint", default=CK)
    ap.add_argument("--session", default=None, help="an interactive session forked at the checkpoint (default: the default session) - its inherited tasks are the app's result")
    a = ap.parse_args()
    db = MongoClient(os.environ["MONGODB_URI"], tz_aware=False)[os.environ["MONGODB_DB_NAME"]]
    refs = list(db.ref_checkpoint_worker_state.find({"CHECKPOINT_ID": a.checkpoint, "CURRENT_TASK_ID": {"$nin": [None, ""]}}))
    if not refs:
        sys.exit("no reference rows for %s" % a.checkpoint)
    asof = refs[0]["AS_OF_AT"]
    sess = db.sim_sessions.find_one({"SESSION_ID": a.session} if a.session else {"DEFAULT_FLAG": True, "CHECKPOINT_ID": a.checkpoint})
    if not sess or sess.get("FORK_AT") != asof:
        sys.exit("no interactive session forked at %s (pass --session)" % asof)
    app_tasks = {t["TASK_ID"]: t for t in db.sim_tasks.find({"SESSION_ID": sess["SESSION_ID"], "ORIGIN": "INHERITED_AT_FORK"})}
    rows = []
    for r in sorted(refs, key=lambda x: x["WORKER_ID"]):
        tid = r["CURRENT_TASK_ID"]
        t = db.task_assignments.find_one({"RUN_ID": RUN, "TASK_ID": tid}) or {}
        # only what was KNOWN at the checkpoint (the terminal TASK_STATUS column is derived at the end of the dataset and is not used)
        evs = list(db.task_events.find({"RUN_ID": RUN, "TASK_ID": tid, "KNOWN_AT": {"$lte": asof}}).sort([("EVENT_TIME", 1)]))
        last = evs[-1] if evs else {}
        oid = t.get("OPERATION_INSTANCE_ID") or r.get("OPERATION_INSTANCE_ID")
        uid = t.get("UNIT_ID") or r.get("UNIT_ID")
        fin = db.production_events.find_one({"RUN_ID": RUN, "OPERATION_INSTANCE_ID": oid, "EVENT_TYPE": {"$in": ["OPERATION_FINISHED", "PROCESS_FINISHED"]}, "KNOWN_AT": {"$lte": asof}})
        rc = db.production_events.find_one({"RUN_ID": RUN, "UNIT_ID": uid, "EVENT_TYPE": "ROUTE_COMPLETED", "KNOWN_AT": {"$lte": asof}})
        last_type = last.get("EVENT_TYPE")
        hours = round((asof - last["EVENT_TIME"]).total_seconds() / 3600, 1) if last.get("EVENT_TIME") else None
        reasons = []
        if fin:
            reasons.append("operation finished %s (before the checkpoint)" % fin["EVENT_TIME"].isoformat(timespec="minutes"))
        if rc:
            reasons.append("tank route-complete %s" % rc["EVENT_TIME"].isoformat(timespec="minutes"))
        if last_type in ("COMPLETED", "CANCELLED", "REASSIGNED"):
            reasons.append("last task event %s" % last_type)
        app = app_tasks.get(tid)
        rows.append({"WORKER_ID": r["WORKER_ID"], "CURRENT_TASK_ID": tid, "REF_TASK_STATE": r.get("TASK_STATE_AT_CHECKPOINT"), "REF_WORK_PERFORMED_STATE": r.get("WORK_PERFORMED_STATE"),
                     "REF_PLANT_STATE": r.get("PLANT_STATE"), "LAST_TASK_EVENT_KNOWN": last_type, "LAST_TASK_EVENT_AT": last.get("EVENT_TIME"), "HOURS_BEFORE_CHECKPOINT": hours,
                     "OPERATION_INSTANCE_ID": oid, "OPERATION_FINISHED_AT": fin["EVENT_TIME"] if fin else None, "UNIT_ID": uid, "UNIT_ROUTE_COMPLETED_AT": rc["EVENT_TIME"] if rc else None,
                     "TASK_STATUS_AT_DATASET_END_NOT_USED": t.get("TASK_STATUS"),
                     "APP_RESULT": ("ACTIVE %s" % app["STATUS"]) if app else "NOT ACTIVE",
                     "EVIDENCE": "; ".join(reasons) if reasons else ("task still open and its operation not finished" if app else "NO EVIDENCE FOUND - review"),
                     "CONSISTENT": "YES" if (bool(app) == (not reasons)) else "NO"})
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    act = [x for x in rows if x["APP_RESULT"].startswith("ACTIVE")]
    ended = [x for x in rows if not x["APP_RESULT"].startswith("ACTIVE")]
    bad = [x for x in rows if x["CONSISTENT"] == "NO"]
    print("checkpoint %s (%s, session %s): %d reference rows name a CURRENT_TASK_ID; app keeps %d active (%d working, %d paused); %d not active; %d rows inconsistent with the as-of-checkpoint evidence"
          % (a.checkpoint, asof.isoformat(), sess["SESSION_ID"], len(rows), len(act), sum(1 for x in act if "WORKING" in x["APP_RESULT"]), sum(1 for x in act if "PAUSED" in x["APP_RESULT"]), len(ended), len(bad)))
    fin_n = sum(1 for x in ended if x["OPERATION_FINISHED_AT"])
    rc_n = sum(1 for x in ended if x["UNIT_ROUTE_COMPLETED_AT"])
    hrs = [x["HOURS_BEFORE_CHECKPOINT"] for x in ended if x["HOURS_BEFORE_CHECKPOINT"] is not None]
    print("  not active: %d with the operation finished before the checkpoint, %d of them on route-complete tanks; last task event %s, %.1f-%.1f h before"
          % (fin_n, rc_n, ",".join(sorted({x["LAST_TASK_EVENT_KNOWN"] or "-" for x in ended})), min(hrs) if hrs else 0, max(hrs) if hrs else 0))
    for x in bad:
        print("  INCONSISTENT:", x["WORKER_ID"], x["CURRENT_TASK_ID"], x["APP_RESULT"], x["EVIDENCE"])
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
