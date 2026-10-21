"""Calendar and roster continuation for branch futures (synthetic assumption ASM-APP-CAL-01, versioned).

The v3 dataset's SHIFT_CALENDAR / CALENDAR_INTERVALS / SHIFT_ROSTER end with the demo day, while PRODUCTION_PLAN releases and order
due dates continue for several days. An interactive branch needs a working calendar after the last recorded day, so this module
generates - in separate collections, never in the seeded ones - a deterministic continuation:

  * continuation_shift_calendar   Mon-Fri, the same shift codes and local start/end times as the last recorded day
  * continuation_calendar_intervals  the same planned-break windows per resource as the last recorded day's shift of that code
  * continuation_shift_roster     every rostered person keeps the shift code, planned work centre and planned role of their most
                                  recent SCHEDULED roster row; no absences, late arrivals or overtime are invented

All rows carry ORIGIN = SYNTHETIC_CONTINUATION and CONTINUATION_VERSION. Writes are idempotent upserts by business key.
"""
import datetime as dt

from .timeutil import local_to_utc, utcnow

VERSION = "1.0"
DAYS = 14


def ensure(db, dataset_id="GINI-SYN-TANKS", days=DAYS):
    shifts = list(db.shift_calendar.find({"dataset_id": dataset_id}, {"_seed": 0}))
    if not shifts:
        return {"skipped": "no shift calendar seeded"}
    last_date = max(s["SHIFT_DATE"] for s in shifts)
    last = {s["SHIFT_CODE"]: s for s in shifts if s["SHIFT_DATE"] == last_date}
    intervals = list(db.calendar_intervals.find({"dataset_id": dataset_id, "SHIFT_ID": {"$in": [s["SHIFT_ID"] for s in last.values()]}}, {"_seed": 0, "_id": 0}))
    made = {"shifts": 0, "intervals": 0, "roster": 0}
    new_shifts = []
    d = last_date
    while len({x["SHIFT_DATE"] for x in new_shifts}) < days:
        d = d + dt.timedelta(days=1)
        if d.weekday() >= 5:
            continue
        for code, s in sorted(last.items()):
            sid = "SH-%s-%s" % (d.strftime("%Y%m%d"), code)
            row = {"dataset_id": dataset_id, "SHIFT_ID": sid, "SHIFT_DATE": d, "SHIFT_CODE": code, "START_AT_LOCAL": s["START_AT_LOCAL"], "END_AT_LOCAL": s["END_AT_LOCAL"],
                   "TIMEZONE": s.get("TIMEZONE"), "DAY_TYPE": "CONTINUATION", "ORIGIN": "SYNTHETIC_CONTINUATION", "CONTINUATION_VERSION": VERSION, "ASSUMPTION_ID": "ASM-APP-CAL-01", "_origin": "APP"}
            r = db.continuation_shift_calendar.update_one({"dataset_id": dataset_id, "SHIFT_ID": sid}, {"$setOnInsert": row}, upsert=True)
            made["shifts"] += 1 if r.upserted_id is not None else 0
            new_shifts.append(row)
            for iv in intervals:
                if iv["SHIFT_ID"] != s["SHIFT_ID"]:
                    continue
                iid = iv["INTERVAL_ID"].replace(s["SHIFT_ID"], sid)
                x = dict(iv, INTERVAL_ID=iid, SHIFT_ID=sid, ORIGIN="SYNTHETIC_CONTINUATION", CONTINUATION_VERSION=VERSION, ASSUMPTION_ID="ASM-APP-CAL-01", _origin="APP")
                r = db.continuation_calendar_intervals.update_one({"dataset_id": dataset_id, "INTERVAL_ID": iid}, {"$setOnInsert": x}, upsert=True)
                made["intervals"] += 1 if r.upserted_id is not None else 0
    # roster continuation per person (most recent SCHEDULED row decides shift code / work centre / role)
    latest = {}
    for r in db.shift_roster.find({"dataset_id": dataset_id, "RUN_ID": "RUN-BASE", "ROSTER_STATUS": "SCHEDULED"}, {"WORKER_ID": 1, "SHIFT_ID": 1, "PLANNED_START_AT": 1, "PLANNED_WORK_CENTER_ID": 1, "PLANNED_ROLE": 1}):
        cur = latest.get(r["WORKER_ID"])
        if cur is None or r["PLANNED_START_AT"] > cur["PLANNED_START_AT"]:
            latest[r["WORKER_ID"]] = r
    for wid, r in latest.items():
        code = r["SHIFT_ID"].rsplit("-", 1)[-1]
        for s in new_shifts:
            if s["SHIFT_CODE"] != code:
                continue
            ds = s["SHIFT_DATE"].strftime("%Y-%m-%d")
            start = local_to_utc(ds, s["START_AT_LOCAL"])
            end = local_to_utc(ds, s["END_AT_LOCAL"])
            if end <= start:
                end += dt.timedelta(days=1)
            rid = "CRS-%s-%s" % (wid, s["SHIFT_ID"])
            row = {"dataset_id": dataset_id, "ROSTER_ID": rid, "RUN_ID": "CONTINUATION", "WORKER_ID": wid, "SHIFT_ID": s["SHIFT_ID"], "SHIFT_DATE": s["SHIFT_DATE"],
                   "PLANNED_WORK_CENTER_ID": r.get("PLANNED_WORK_CENTER_ID"), "PLANNED_ROLE": r.get("PLANNED_ROLE"), "PLANNED_START_AT": start, "PLANNED_END_AT": end,
                   "ROSTER_STATUS": "SCHEDULED", "ORIGIN": "SYNTHETIC_CONTINUATION", "CONTINUATION_VERSION": VERSION, "ASSUMPTION_ID": "ASM-APP-CAL-01", "_origin": "APP", "CREATED_AT": utcnow()}
            res = db.continuation_shift_roster.update_one({"dataset_id": dataset_id, "ROSTER_ID": rid}, {"$setOnInsert": row}, upsert=True)
            made["roster"] += 1 if res.upserted_id is not None else 0
    made["last_recorded_day"] = last_date.strftime("%Y-%m-%d")
    made["continued_to"] = new_shifts[-1]["SHIFT_DATE"].strftime("%Y-%m-%d") if new_shifts else None
    return made
