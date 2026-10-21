"""Time-of-shift baselines from history known at the fork (EVENT_TIME/KNOWN_AT <= fork), over the configured number of days.
Used by comparable-baseline rules (backlog, surge, fail rate, material velocity, dwell). Never reads future records."""
import datetime as dt
from collections import defaultdict

from . import variance
from .timeutil import to_local, minutes

INVALID_QUEUE_NOTE = "queue rows whose recorded exit precedes entry (TIMING_NOTE) are excluded from duration baselines"


def compute(db, cat, run_id, fork, days=5):
    since = fork - dt.timedelta(days=days)
    product = {u["UNIT_ID"]: u.get("PRODUCT_ID") for u in db.unit_master.find({"RUN_ID": run_id}, {"UNIT_ID": 1, "PRODUCT_ID": 1})}
    q = list(db.workstation_queue_entries.find({"RUN_ID": run_id, "ENTERED_AT": {"$gte": since - dt.timedelta(days=1), "$lte": fork}, "KNOWN_AT": {"$lte": fork}},
                                                {"UNIT_ID": 1, "WORK_CENTER_ID": 1, "ENTERED_AT": 1, "EXITED_AT": 1, "EXIT_KNOWN_AT": 1, "TIMING_NOTE": 1, "OPERATION_ID": 1}))
    invalid = sum(1 for e in q if e.get("TIMING_NOTE"))

    def std_next(e):
        p = product.get(e["UNIT_ID"])
        op = e.get("OPERATION_ID")
        if not op:
            for r in cat.routing:
                if r["PRODUCT_ID"] == p and r["WORK_CENTER_ID"] == e["WORK_CENTER_ID"] and r.get("OPERATION_KIND") == "LABOR":
                    op = r["OPERATION_ID"]; break
        r = cat.op(p, op) or {}
        return float(r.get("STANDARD_LABOR_MIN") or 0)

    queue = defaultdict(lambda: defaultdict(list))
    release = defaultdict(list)
    day = since if q else fork          # no queue-entry history at all: no comparable baseline (never a zero baseline)
    while day < fork:
        for h in range(24):
            t = day.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=h)
            if t > fork or t < since:
                continue
            slot = to_local(t).hour
            per = defaultdict(float)
            for e in q:
                ex = e.get("EXITED_AT") if (e.get("EXIT_KNOWN_AT") and e["EXIT_KNOWN_AT"] <= fork) else None
                if e["ENTERED_AT"] <= t and (ex is None or ex > t or e.get("TIMING_NOTE")) and (ex is None or ex > t):
                    per[e["WORK_CENTER_ID"]] += std_next(e)
            for wc in variance.CORE_WCS:
                queue[wc][slot].append(per.get(wc, 0.0))
            rel = sum(std_next(e) for e in q if e["WORK_CENTER_ID"] == variance.release_wc() and t - dt.timedelta(minutes=120) < e["ENTERED_AT"] <= t)
            release[slot].append(rel)
        day += dt.timedelta(days=1)
    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    fails = defaultdict(lambda: [0, 0])
    for i in db.inspection_header.find({"RUN_ID": run_id, "COMPLETED_AT": {"$gte": since, "$lte": fork}, "KNOWN_AT": {"$lte": fork}}, {"GATE_OPERATION_ID": 1, "ATTEMPT_NO": 1, "RESULT": 1}):
        if (i.get("ATTEMPT_NO") or 1) == 1:
            fails[i["GATE_OPERATION_ID"]][0] += 1
            fails[i["GATE_OPERATION_ID"]][1] += 1 if i.get("RESULT") == "FAIL" else 0
    dwell = defaultdict(list)
    for o in db.operation_instances.find({"RUN_ID": run_id, "OPERATION_KIND": "LABOR", "FINISHED_AT": {"$gte": since, "$lte": fork}, "STARTED_AT": {"$ne": None}}, {"WORK_CENTER_ID": 1, "STARTED_AT": 1, "FINISHED_AT": 1}):
        dwell[o["WORK_CENTER_ID"]].append(minutes(o["STARTED_AT"], o["FINISHED_AT"]))
    issues = defaultdict(list)
    mats = list(db.material_events.find({"RUN_ID": run_id, "EVENT_TIME": {"$gte": since, "$lte": fork}, "KNOWN_AT": {"$lte": fork}, "QTY": {"$lt": 0}}, {"EVENT_TIME": 1, "MATERIAL_ID": 1, "QTY": 1}))
    use = defaultdict(float)
    for m in mats:
        issues[to_local(m["EVENT_TIME"]).hour].append(1)
        use[m["MATERIAL_ID"]] += -float(m.get("QTY") or 0)
    # productive labour hours over the same window (worker-hours of NORMAL/REWORK/CORRECTION segments) -> issues per productive hour
    prod_h = 0.0
    for sgm in db.labor_segments.find({"RUN_ID": run_id, "SEGMENT_PHASE": {"$in": ["NORMAL", "REWORK", "CORRECTION"]}, "SEGMENT_START": {"$lt": fork}, "SEGMENT_END": {"$gt": since}},
                                      {"SEGMENT_START": 1, "SEGMENT_END": 1}):
        prod_h += max(0.0, minutes(max(sgm["SEGMENT_START"], since), min(sgm["SEGMENT_END"], fork))) / 60.0
    days_n = max(1, days)
    return {
        "COMPUTED_FROM": "history known at fork", "DAYS": days, "FORK_AT": fork,
        "QUEUE_STD_MIN": {wc: {str(s): avg(v) for s, v in slots.items()} for wc, slots in queue.items()},
        "QUEUE_SAMPLE_DAYS": {wc: max((len(v) for v in slots.values()), default=0) for wc, slots in queue.items()},
        "WC1_RELEASE_STD_MIN_120": {str(s): avg(v) for s, v in release.items()},
        "FIRST_ATTEMPT_FAIL_RATE": {g: round(f / n, 4) if n else None for g, (n, f) in fails.items()},
        "FIRST_ATTEMPT_SAMPLES": {g: n for g, (n, f) in fails.items()},
        "DWELL_MEDIAN_MIN": {wc: round(sorted(v)[len(v) // 2], 1) for wc, v in dwell.items() if v},
        "MATERIAL_ISSUES_PER_HOUR_SLOT": {str(h): round(len(v) / days_n, 2) for h, v in issues.items()},
        "MATERIAL_ISSUES_PER_PRODUCTIVE_HOUR": round(len(mats) / prod_h, 4) if prod_h >= 1 else None,
        "PRODUCTIVE_LABOR_HOURS": round(prod_h, 1),
        "MATERIAL_DAILY_USE": {k: round(v / days_n, 3) for k, v in use.items()},
        "QUEUE_TIMING_EXCEPTIONS_EXCLUDED": invalid, "QUEUE_NOTE": INVALID_QUEUE_NOTE,
    }


def compute_factory(db, cat, session, now, days=5):
    """Learn from this factory's earlier recorded work; exclude the current 2h evaluation window.
    No imported demo baseline is used. Requires >=3 completed attempts for dwell and >=1 productive hour
    for material velocity. Known-at and completion cutoffs prevent current/future evidence leaking in.
    """
    import statistics
    sid = session['SESSION_ID']
    end = now - dt.timedelta(hours=2)
    start = end - dt.timedelta(days=days)
    scope = {'SESSION_ID': sid}
    dwell, fails = defaultdict(list), defaultdict(lambda: [0, 0])
    ops = list(db.sim_operations.find({**scope, 'OPERATION_KIND': 'LABOR', 'WORK_COMPLETED_AT': {'$gte': start, '$lte': end}}))
    for o in ops:
        if o.get('STARTED_AT') and o['STARTED_AT'] <= o['WORK_COMPLETED_AT']:
            dwell[o.get('WORK_CENTER_ID')].append(minutes(o['STARTED_AT'], o['WORK_COMPLETED_AT']))
    for i in db.sim_inspections.find({**scope, 'STATUS': 'SUBMITTED', 'INSPECTION_KIND': 'INDEPENDENT', 'COMPLETED_AT': {'$gte': start, '$lte': end}, 'KNOWN_AT': {'$lte': end}}):
        if i.get('ATTEMPT_NO', 1) == 1:
            n = fails[i.get('GATE_OPERATION_ID')]; n[0] += 1; n[1] += int(i.get('RESULT') == 'FAIL')
    events = list(db.sim_events.find({**scope, 'EVENT_TYPE': {'$in': ['MATERIAL_CONSUMED', 'MATERIAL_ISSUE_REVERSED']}, 'EVENT_TIME': {'$gte': start, '$lte': end}, 'KNOWN_AT': {'$lte': end}}))
    reversed_ids = {(e.get('PAYLOAD') or {}).get('REVERSES_EVENT_ID') for e in events if e['EVENT_TYPE'] == 'MATERIAL_ISSUE_REVERSED'}
    issues = sum(e['EVENT_TYPE'] == 'MATERIAL_CONSUMED' and e.get('EVENT_ID') not in reversed_ids for e in events)
    hours = sum(max(0, minutes(max(s['START_AT'], start), min(s['END_AT'], end))) / 60 for s in db.sim_participation.find({**scope, 'CATEGORY': {'$in': ['DIRECT', 'REWORK']}, 'START_AT': {'$lt': end}, 'END_AT': {'$gt': start, '$lte': end}}))
    by_slot = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    release = defaultdict(lambda: defaultdict(list))
    for row in db.factory_baseline_samples.find({**scope, 'AS_OF': {'$gte': start, '$lte': end}}):
        day = to_local(row['AS_OF']).date().isoformat(); hour = str(to_local(row['AS_OF']).hour)
        for w in row.get('WORK_CENTERS', []):
            by_slot[w['WORK_CENTER_ID']][hour][day].append(w.get('QUEUED_STD_MIN', 0))
        release[hour][day].append(row.get('RELEASED_STD_MIN_120', 0))
    return {'COMPUTED_FROM': 'recorded factory history excluding current 120-minute window', 'COMPUTED_AT': now,
            'WINDOW_START': start, 'WINDOW_END': end, 'DAYS': days,
            'DWELL_MEDIAN_MIN': {w: round(statistics.median(v), 2) for w, v in dwell.items() if len(v) >= 3},
            'DWELL_SAMPLES': {w: len(v) for w, v in dwell.items()},
            'MATERIAL_ISSUES_PER_PRODUCTIVE_HOUR': round(issues / hours, 4) if hours >= 1 else None,
            'PRODUCTIVE_LABOR_HOURS': round(hours, 3),
            'FIRST_ATTEMPT_FAIL_RATE': {g: f / n for g, (n, f) in fails.items() if n >= 3},
            'FIRST_ATTEMPT_SAMPLES': {g: n for g, (n, f) in fails.items()},
            'QUEUE_STD_MIN': {w: {h: statistics.mean(statistics.mean(v) for v in day.values()) for h, day in slots.items() if len(day) >= 3} for w, slots in by_slot.items()},
            'QUEUE_SAMPLE_DAYS': {w: max((len(day) for day in slots.values()), default=0) for w, slots in by_slot.items()},
            'WC1_RELEASE_STD_MIN_120': {h: statistics.mean(statistics.mean(v) for v in day.values()) for h, day in release.items() if len(day) >= 3}}
