"""Verification of approved recovery actions: immutable before/after forecasts vs observed results.

For each started/completed action: planned vs actual travel/handover per transfer, forecast finish/good-by-due before and after
the action vs the line's observed result (when the due time has passed or the line completed) or the latest forecast (labelled
PROVISIONAL while the outcome is still open), forecast error in minutes, and lessons proposed as versioned estimate updates.
Lessons are proposals for a named owner; they never silently change standards.
"""
import datetime as dt

from .timeutil import minutes, utcnow


def verify_action(a, transfers, line_now, good_now, line_doc, now):
    before, after = a.get("BEFORE_FORECAST") or {}, a.get("AFTER_FORECAST") or {}
    due = (line_doc or {}).get("DUE_AT") or before.get("DUE_AT")
    req = int((line_doc or {}).get("REQUIRED_GOOD_QTY") or 0)
    closed = bool(due and now >= due) or (req and good_now >= req)
    obs = {"goodNow": good_now, "required": req, "dueAt": due, "outcomeFinal": closed}
    if closed:
        obs["goodByDue"] = good_now if (due and now >= due) else None
        obs["metTarget"] = good_now >= req if req else None
    actual_finish = (line_now or {}).get("COMPLETE_AT")
    fe = None
    if after.get("FORECAST_FINISH_AT") and actual_finish:
        fe = round(minutes(after["FORECAST_FINISH_AT"], actual_finish), 1)
    trs = []
    lessons, proposals = [], []
    for t in transfers:
        planned = float(t.get("PLANNED_TRAVEL_MIN") or 0) + float(t.get("PLANNED_HANDOVER_MIN") or 0)
        actual = t.get("ACTUAL_TRAVEL_AND_HANDOVER_MIN")
        trs.append({"transferId": t["TRANSFER_ID"], "workerId": t["WORKER_ID"], "from": t.get("FROM_WORK_CENTER_ID"), "to": t.get("TO_WORK_CENTER_ID"), "plannedMin": planned, "actualMin": actual,
                    "errorMin": round(actual - planned, 1) if actual is not None else None, "status": t.get("STATUS")})
        if actual is not None and planned and abs(actual - planned) >= max(3, 0.3 * planned):
            lessons.append("Transfer %s->%s took %.0f min vs %.0f planned" % (t.get("FROM_WORK_CENTER_ID"), t.get("TO_WORK_CENTER_ID"), actual, planned))
            proposals.append({"estimate": "TRANSFER_RULES.TRAVEL_MIN+HANDOVER_MIN", "scope": "%s->%s" % (t.get("FROM_WORK_CENTER_ID"), t.get("TO_WORK_CENTER_ID")), "current": planned,
                              "observed": actual, "status": "PROPOSED_FOR_OWNER_REVIEW", "sampleSize": 1, "note": "single observation - do not adopt without more samples"})
    current = {k: (line_now or {}).get(k) for k in ("BAND", "FORECAST_FINISH_AT", "FORECAST_GOOD_BY_DUE", "SHORTFALL")}
    if not closed and after.get("FORECAST_FINISH_AT") and current.get("FORECAST_FINISH_AT"):
        drift = round(minutes(after["FORECAST_FINISH_AT"], current["FORECAST_FINISH_AT"]), 1)
        if abs(drift) >= 20:
            lessons.append("Latest forecast differs from the action's after-forecast by %+.0f min (provisional; outcome still open)" % drift)
    else:
        drift = None
    if closed and req:
        exp = after.get("FORECAST_GOOD_BY_DUE")
        if exp is not None and obs.get("goodByDue") is not None and exp != obs["goodByDue"]:
            lessons.append("Good by due: forecast %s, observed %s" % (exp, obs["goodByDue"]))
    return {"actionId": a["ACTION_ID"], "status": a.get("STATUS"), "orderLineId": a.get("ORDER_LINE_ID"), "approvedBy": a.get("APPROVED_BY"), "approvedAt": a.get("APPROVED_AT"),
            "before": before, "after": after, "current": current, "observed": obs, "forecastErrorMin": fe, "afterForecastDriftMin": drift, "transfers": trs,
            "lessons": lessons, "proposedEstimateUpdates": proposals, "outcome": "FINAL" if closed else "PROVISIONAL", "verifiedAt": utcnow(), "simAt": now,
            "note": "Before/after forecasts are the immutable values captured at proposal; observed values come from operational records."}


def run(db, session, now, lines_forecast, good_by_line, line_docs):
    sid = session["SESSION_ID"]
    out = []
    for a in db.sim_actions.find({"SESSION_ID": sid, "STATUS": {"$in": ["STARTED", "COMPLETED"]}}):
        trs = list(db.sim_transfers.find({"SESSION_ID": sid, "ACTION_ID": a["ACTION_ID"]}))
        lid = a.get("ORDER_LINE_ID")
        out.append(verify_action(a, trs, lines_forecast.get(lid), good_by_line.get(lid, 0), line_docs.get(lid), now))
    return out
