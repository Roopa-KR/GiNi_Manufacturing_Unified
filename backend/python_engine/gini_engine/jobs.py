"""Durable MongoDB job queue: atomic claim with lease expiry, heartbeat, fencing, retries with exponential backoff, dead letter.

Collection `jobs`: JOB_ID, SESSION_ID, TYPE, STATUS (PENDING|LEASED|DONE|FAILED|DEAD), PRIORITY, AVAILABLE_AT, ATTEMPTS,
MAX_ATTEMPTS, LEASE_OWNER, LEASE_EXPIRES_AT, FENCE, DEDUP_KEY, PAYLOAD, RESULT, ERROR, CREATED_AT, UPDATED_AT.
Session advancement uses a separate lease on the sim_sessions document (ENGINE.LEASE_OWNER / LEASE_EXPIRES_AT / FENCE), so two
worker processes can never advance the same simulation concurrently.
"""
import datetime as dt
import traceback
import uuid

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from .timeutil import utcnow


def enqueue(db, session_id, jtype, payload=None, dedup_key=None, priority=5, delay_s=0, max_attempts=5):
    now = utcnow()
    doc = {"JOB_ID": "JOB-" + uuid.uuid4().hex[:16].upper(), "SESSION_ID": session_id, "TYPE": jtype, "STATUS": "PENDING", "PRIORITY": priority,
           "AVAILABLE_AT": now + dt.timedelta(seconds=delay_s), "ATTEMPTS": 0, "MAX_ATTEMPTS": max_attempts, "FENCE": 0, "PAYLOAD": payload or {},
           "CREATED_AT": now, "UPDATED_AT": now, "_origin": "APP"}
    if dedup_key:
        doc["DEDUP_KEY"] = dedup_key
        doc["DEDUP_OPEN"] = True                     # unique partial index (DEDUP_KEY, DEDUP_OPEN) while pending
    try:
        db.jobs.insert_one(doc)
        return doc["JOB_ID"]
    except DuplicateKeyError:
        return None


def claim(db, owner, lease_s, types=None):
    now = utcnow()
    flt = {"$or": [{"STATUS": "PENDING", "AVAILABLE_AT": {"$lte": now}}, {"STATUS": "LEASED", "LEASE_EXPIRES_AT": {"$lte": now}}]}
    if types:
        flt["TYPE"] = {"$in": types}
    return db.jobs.find_one_and_update(
        flt,
        {"$set": {"STATUS": "LEASED", "LEASE_OWNER": owner, "LEASE_EXPIRES_AT": now + dt.timedelta(seconds=lease_s), "UPDATED_AT": now},
         "$inc": {"ATTEMPTS": 1, "FENCE": 1}, "$unset": {"DEDUP_OPEN": ""}},
        sort=[("PRIORITY", 1), ("AVAILABLE_AT", 1)], return_document=ReturnDocument.AFTER)


def heartbeat(db, job, owner, lease_s):
    r = db.jobs.update_one({"JOB_ID": job["JOB_ID"], "LEASE_OWNER": owner, "FENCE": job["FENCE"], "STATUS": "LEASED"},
                           {"$set": {"LEASE_EXPIRES_AT": utcnow() + dt.timedelta(seconds=lease_s)}})
    return r.matched_count == 1


def complete(db, job, owner, result=None):
    r = db.jobs.update_one({"JOB_ID": job["JOB_ID"], "LEASE_OWNER": owner, "FENCE": job["FENCE"], "STATUS": "LEASED"},
                           {"$set": {"STATUS": "DONE", "RESULT": result, "UPDATED_AT": utcnow(), "FINISHED_AT": utcnow()}, "$unset": {"LEASE_OWNER": ""}})
    return r.matched_count == 1


def fail(db, job, owner, err, max_retries=None):
    attempts = job.get("ATTEMPTS", 1)
    limit = max_retries or job.get("MAX_ATTEMPTS", 5)
    dead = attempts >= limit
    backoff = min(300, 2 ** attempts)
    db.jobs.update_one({"JOB_ID": job["JOB_ID"], "LEASE_OWNER": owner, "FENCE": job["FENCE"]},
                       {"$set": {"STATUS": "DEAD" if dead else "PENDING", "ERROR": str(err)[:2000], "ERROR_TRACE": traceback.format_exc()[-4000:],
                                 "AVAILABLE_AT": utcnow() + dt.timedelta(seconds=backoff), "UPDATED_AT": utcnow()}, "$unset": {"LEASE_OWNER": ""}})
    return dead


# ---------------------------------------------------------------- session leases (single advancer per simulation)
def lease_session(db, session_id, owner, lease_s):
    now = utcnow()
    return db.sim_sessions.find_one_and_update(
        {"SESSION_ID": session_id, "$or": [{"ENGINE.LEASE_OWNER": owner}, {"ENGINE.LEASE_EXPIRES_AT": {"$lte": now}}, {"ENGINE.LEASE_OWNER": None}, {"ENGINE.LEASE_OWNER": {"$exists": False}}]},
        {"$set": {"ENGINE.LEASE_OWNER": owner, "ENGINE.LEASE_EXPIRES_AT": now + dt.timedelta(seconds=lease_s), "ENGINE.HEARTBEAT_AT": now}, "$inc": {"ENGINE.FENCE": 1}},
        return_document=ReturnDocument.AFTER)


def renew_session(db, session, owner, lease_s, fields=None):
    upd = {"ENGINE.LEASE_EXPIRES_AT": utcnow() + dt.timedelta(seconds=lease_s), "ENGINE.HEARTBEAT_AT": utcnow()}
    upd.update(fields or {})
    r = db.sim_sessions.update_one({"SESSION_ID": session["SESSION_ID"], "ENGINE.LEASE_OWNER": owner, "ENGINE.FENCE": session["ENGINE"]["FENCE"]}, {"$set": upd})
    return r.matched_count == 1


def release_session(db, session, owner):
    db.sim_sessions.update_one({"SESSION_ID": session["SESSION_ID"], "ENGINE.LEASE_OWNER": owner}, {"$set": {"ENGINE.LEASE_OWNER": None, "ENGINE.LEASE_EXPIRES_AT": utcnow()}})
