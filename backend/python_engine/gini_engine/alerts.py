"""Alert lifecycle from rule observations.

Evaluation state  NORMAL -> PENDING -> FIRING -> RECOVERING -> RESOLVED  (plus NO_DATA while a live episode has no data)
Workflow state    UNACKNOWLEDGED -> ACKNOWLEDGED -> IN_PROGRESS -> CLOSED   (changed only by people through ALERT_WORKFLOW)

Acknowledging never resolves; only the condition clearing for `recovery` consecutive evaluations resolves. ALERT_ID is stable per
rule and entity (AL-<rule>-<entity>); each new breach after resolution starts a new EPISODE_ID. Every evaluation-state change is
recorded in sim_alert_transitions. FIRING / ESCALATED / RESOLVED of notifying rules enqueue one outbox item each (unique DEDUP_KEY
<session>|<alert>|<episode>|<transition>), suppressed in replay, at accelerated speed and inside the cooldown.
"""
import datetime as dt
import hashlib
import re

from pymongo.errors import DuplicateKeyError

from .timeutil import minutes, plant_tz, to_local, utcnow

OPEN_STATES = ("PENDING", "FIRING", "RECOVERING", "NO_DATA")
ESCALATE_AFTER_MIN = 30


def alert_id(rule_id, entity):
    return "AL-%s-%s" % (rule_id, re.sub(r"[^A-Za-z0-9-]", "-", str(entity)))


def _clean(v):
    if isinstance(v, float):
        return round(v, 3)
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


class AlertManager:
    def __init__(self, db, session, rules, rule_version, now, shift_start=None, initial=False):
        self.db, self.s, self.now = db, session, now
        self.sid = session["SESSION_ID"]
        self.rules = {r["rule_id"]: r for r in rules}
        self.rule_version = rule_version
        self.shift_start = shift_start
        self.initial = initial
        self.existing = {a["ALERT_ID"]: a for a in db.sim_alerts.find({"SESSION_ID": self.sid})}
        self.stats = {"transitions": 0, "notifications": 0, "suppressed": 0}

    # ------------------------------------------------------------------
    def apply(self, observations):
        seen = set()
        for o in observations:
            r = self.rules.get(o["rule_id"])
            if not r or r.get("alert") is False:
                continue
            aid = alert_id(o["rule_id"], o["entity_id"])
            seen.add(aid)
            self._one(aid, r, o)
        # entities no longer evaluated (e.g. operation finished, request delivered) clear like an OK evaluation
        for aid, a in self.existing.items():
            if aid not in seen and a.get("EVALUATION_STATE") in OPEN_STATES:
                r = self.rules.get(a["RULE_ID"])
                if r:
                    self._one(aid, r, {"rule_id": a["RULE_ID"], "entity_id": a["ENTITY_ID"], "entity_type": a.get("SCOPE"), "status": "OK", "message": "Condition no longer present (entity closed)", "gone": True})
        self._escalations()
        return self.stats

    def _one(self, aid, r, o):
        a = self.existing.get(aid)
        cur = (a or {}).get("EVALUATION_STATE") or "NORMAL"
        st = o["status"]
        persistence, recovery = int(r.get("persistence", 1)), int(r.get("recovery", 1))
        in_warmup = bool(r.get("warmup_min") and self.shift_start and minutes(self.shift_start, self.now) < float(r["warmup_min"]))
        breach = st == "BREACH"
        pending_only = bool(o.get("pending")) and not breach
        nxt, upd, new_episode = cur, {}, False
        if breach:
            streak = ((a or {}).get("BREACH_STREAK") or 0) + 1 if cur in ("PENDING", "FIRING", "RECOVERING", "NO_DATA") else 1
            upd.update(BREACH_STREAK=streak, OK_STREAK=0)
            if cur in ("NORMAL", "RESOLVED"):
                new_episode = True
                nxt = "PENDING"
            if cur in ("PENDING", "NORMAL", "RESOLVED") and streak >= persistence and not in_warmup and not self._cooldown(a, r, new_episode):
                nxt = "FIRING"
            elif cur in ("RECOVERING", "NO_DATA"):
                nxt = "FIRING"
        elif pending_only:
            if cur in ("NORMAL", "RESOLVED"):
                new_episode, nxt = True, "PENDING"
            upd.update(OK_STREAK=0)
        elif st == "OK":
            ok = ((a or {}).get("OK_STREAK") or 0) + 1
            upd.update(OK_STREAK=ok, BREACH_STREAK=0)
            if cur == "PENDING":
                nxt = "NORMAL"
            elif cur in ("FIRING", "NO_DATA"):
                nxt = "RESOLVED" if (recovery <= 1 or o.get("gone")) else "RECOVERING"
            elif cur == "RECOVERING" and (ok >= recovery or o.get("gone")):
                nxt = "RESOLVED"
        else:  # NO_DATA / INSUFFICIENT_DATA: never a breach, never on time
            if cur in ("FIRING", "RECOVERING"):
                nxt = "NO_DATA"
            elif cur == "PENDING":
                nxt = "NORMAL"
            elif o.get("stale") and cur in ("NORMAL", "RESOLVED"):
                new_episode, nxt = True, "NO_DATA"
            upd.update(DATA_STATUS=st)
        if a is None and nxt == "NORMAL":
            return                                          # nothing to record for an entity that never breached
        if a is None and not breach and not pending_only and not (o.get("stale") and nxt == "NO_DATA"):
            return
        episode = (a or {}).get("EPISODE_ID")
        if new_episode:
            episode = "%s-E%s" % (aid, self.now.strftime("%Y%m%d%H%M"))
        sev = o.get("severity") or "MEDIUM"
        doc = {
            "SESSION_ID": self.sid, "ALERT_ID": aid, "EPISODE_ID": episode, "RULE_ID": r["rule_id"], "RULE_NAME": r.get("name"), "RULE_VERSION": self.rule_version,
            "SCOPE": o.get("entity_type") or r.get("scope"), "ENTITY_ID": o["entity_id"], "EVALUATION_STATE": nxt, "SEVERITY": sev,
            "ACTUAL": _clean(o.get("actual")), "EXPECTED": _clean(o.get("expected")), "DELTA": _clean(o.get("delta")), "THRESHOLD": _clean(o.get("threshold")), "WINDOW": o.get("window"),
            "MESSAGE": o.get("message"), "RECOMMENDED": o.get("recommended"), "EVIDENCE": [e for e in (o.get("evidence") or []) if e][:20], "SAMPLE": _clean(o.get("sample")),
            "LAST_EVALUATED_AT": self.now, "LEGACY_MAPPING": r.get("legacy"), "UPDATED_AT": utcnow(), "KNOWN_AT": self.now, "_origin": "APP",
        }
        doc.update(upd)
        if new_episode or a is None:
            doc.update(FIRST_DETECTED_AT=self.now, WORKFLOW_STATE="UNACKNOWLEDGED", FIRING_AT=None, RESOLVED_AT=None, ESCALATED_AT=None, OWNER_ID=None, BREACH_STREAK=upd.get("BREACH_STREAK", 1))
        if nxt == "FIRING" and cur != "FIRING":
            doc["FIRING_AT"] = (a or {}).get("FIRING_AT") if cur in ("RECOVERING", "NO_DATA") and not new_episode else self.now
        if nxt == "RESOLVED":
            doc["RESOLVED_AT"] = self.now
        if nxt == "NORMAL" and a is not None and cur == "PENDING" and not a.get("FIRING_AT"):
            doc["RESOLVED_AT"] = self.now                   # a pending blip that never fired
        if a is None:
            doc["VERSION"] = 1
            doc["CREATED_AT"] = utcnow()
            self.db.sim_alerts.update_one({"SESSION_ID": self.sid, "ALERT_ID": aid}, {"$setOnInsert": doc}, upsert=True)
        else:
            self.db.sim_alerts.update_one({"SESSION_ID": self.sid, "ALERT_ID": aid}, {"$set": doc, "$inc": {"VERSION": 1}})
        self.existing[aid] = dict(a or {}, **doc)
        if nxt != cur or new_episode:
            self._transition(aid, episode, cur if not new_episode else "NORMAL", nxt, o)
            if nxt in ("FIRING", "RESOLVED") and r.get("notify") and not (nxt == "RESOLVED" and not (a or {}).get("FIRING_AT")):
                self._notify(self.existing[aid], nxt, r)

    def _cooldown(self, a, r, new_episode):
        if not a or not new_episode or not a.get("RESOLVED_AT") or not r.get("cooldown_min"):
            return False
        return minutes(a["RESOLVED_AT"], self.now) < float(r["cooldown_min"]) and bool(a.get("FIRING_AT"))

    def _transition(self, aid, episode, frm, to, o):
        self.db.sim_alert_transitions.insert_one({"SESSION_ID": self.sid, "ALERT_ID": aid, "EPISODE_ID": episode, "KIND": "EVALUATION", "FROM_STATE": frm, "TO_STATE": to,
                                                  "AT": self.now, "ACTUAL": _clean(o.get("actual")), "MESSAGE": o.get("message"), "ACTOR": "ENGINE", "_origin": "APP", "CREATED_AT": utcnow()})
        self.stats["transitions"] += 1

    def _escalations(self):
        for aid, a in self.existing.items():
            if a.get("EVALUATION_STATE") == "FIRING" and a.get("WORKFLOW_STATE") == "UNACKNOWLEDGED" and not a.get("ESCALATED_AT") and a.get("FIRING_AT") and a.get("SEVERITY") == "HIGH":
                if minutes(a["FIRING_AT"], self.now) >= ESCALATE_AFTER_MIN:
                    self.db.sim_alerts.update_one({"SESSION_ID": self.sid, "ALERT_ID": aid}, {"$set": {"ESCALATED_AT": self.now}, "$inc": {"VERSION": 1}})
                    a["ESCALATED_AT"] = self.now
                    self._transition(aid, a.get("EPISODE_ID"), "FIRING", "FIRING", {"message": "Escalated: HIGH severity unacknowledged for %d sim-min" % ESCALATE_AFTER_MIN})
                    r = self.rules.get(a["RULE_ID"])
                    if r and r.get("notify"):
                        self._notify(a, "ESCALATED", r)

    # ------------------------------------------------------------------ outbox
    def _notify(self, a, transition, r):
        key = "%s|%s|%s|%s" % (self.sid, a["ALERT_ID"], a.get("EPISODE_ID"), transition)
        clock = self.s.get("CLOCK") or {}
        notif_cfg = (self.s.get("NOTIFY") or {})
        speed = float(clock.get("SPEED") or 1)
        reason = None
        if self.s.get("MODE") == "REPLAY":
            reason = "Synthetic live replay - historical alerts are not emailed"
        elif self.initial:
            reason = "Condition already present at the fork/checkpoint - shown on the alert board, not emailed"
        elif speed >= float(notif_cfg.get("SUPPRESS_SPEED", 30)):
            reason = "Accelerated simulation (x%g) - suppressed to avoid floods" % speed
        else:
            last = self.db.notifications.find_one({"SESSION_ID": self.sid, "ALERT_ID": a["ALERT_ID"], "TRANSITION": transition, "STATUS": {"$nin": ["SUPPRESSED"]}}, sort=[("CREATED_AT", -1)])
            if last and (utcnow() - last["CREATED_AT"]).total_seconds() < float(notif_cfg.get("COOLDOWN_SECONDS", 900)):
                reason = "Inside the notification cooldown for this alert"
        tz = self.s.get("PLANT_TIMEZONE") or plant_tz()
        local = to_local(self.now, tz)
        factory = bool(self.s.get("FACTORY_SESSION"))
        subject = ("[GiNi factory team test] " if factory else "[GiNi synthetic demo] ") + "%s %s - %s %s" % (transition, a["RULE_ID"], a.get("SCOPE"), a["ENTITY_ID"])
        body = "\n".join([
            ("FRESH FACTORY TEAM TEST (%s) - real-time test environment, not a production system." % (self.s.get("FACTORY_NAME") or "factory")) if factory else "SYNTHETIC DEMONSTRATION DATA - not a real plant event.",
            "Session: %s (%s)" % (self.sid, self.s.get("OPERATING_MODE") or self.s.get("MODE")), "%s: %s %s" % ("Time" if factory else "Simulated time", local.strftime("%Y-%m-%d %H:%M"), tz),
            "Rule: %s %s (version %s)" % (a["RULE_ID"], a.get("RULE_NAME"), self.rule_version), "Entity: %s %s" % (a.get("SCOPE"), a["ENTITY_ID"]),
            "Transition: %s   Severity: %s" % (transition, a.get("SEVERITY")), "", str(a.get("MESSAGE") or ""), "",
            "Recommended: %s" % (a.get("RECOMMENDED") or "Review in the GiNi admin console (Alerts)."),
            "Alert %s, episode %s" % (a["ALERT_ID"], a.get("EPISODE_ID")),
        ])
        doc = {"NOTIFICATION_ID": "NTF-" + hashlib.sha1(key.encode()).hexdigest()[:16].upper(), "DEDUP_KEY": key, "SESSION_ID": self.sid, "ALERT_ID": a["ALERT_ID"],
               "EPISODE_ID": a.get("EPISODE_ID"), "TRANSITION": transition, "RULE_ID": a["RULE_ID"], "SEVERITY": a.get("SEVERITY"), "SUBJECT": subject, "BODY": body,
               "MESSAGE_ID": "<%s@gini-demo.local>" % hashlib.sha1(key.encode()).hexdigest(), "RECIPIENTS": "configured allowlisted recipients (roles: %s)" % ", ".join(r.get("notify_roles") or ["AREA_SUPERVISOR", "SHIFT_MANAGER"]),
               "STATUS": "SUPPRESSED" if reason else "PENDING", "SUPPRESSED_REASON": reason, "ATTEMPTS": 0, "NEXT_ATTEMPT_AT": utcnow(), "SIM_AT": self.now,
               "CREATED_AT": utcnow(), "UPDATED_AT": utcnow(), "_origin": "APP"}
        try:
            self.db.notifications.insert_one(doc)
            self.stats["suppressed" if reason else "notifications"] += 1
        except DuplicateKeyError:
            pass
