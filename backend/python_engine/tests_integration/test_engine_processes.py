"""AT18 - process-level engine tests against the REAL API and shared database.

  * two engine worker processes run at once: only one holds the session lease at any time and the simulation advances once;
  * the lease holder is killed with SIGKILL (no clean release): the other takes over after lease expiry and continues from the
    persisted ENGINE.SIM_AT without gaps;
  * a fresh process started afterwards (restart) resumes without duplicating events, tasks or points;
  * job claims and lease renewals are fenced: a stale owner can neither complete a re-claimed job nor renew a lost lease.

Requirements: API running (API_URL), database (MONGODB_URI/MONGODB_DB_NAME), ADMIN_LOGIN/ADMIN_PASSWORD, INTERNAL_SERVICE_TOKEN,
NODE_API_INTERNAL_URL, and NO other engine worker running (the test owns the engine processes). Run:
    GINI_INTEGRATION=1 python -m pytest -q python_engine/tests_integration
"""
import datetime as dt
import http.cookiejar
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("GINI_INTEGRATION") != "1", reason="set GINI_INTEGRATION=1 with the API and database running")

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.dirname(HERE)
API = os.environ.get("API_URL", "http://localhost:5000").rstrip("/")
ADMIN_ORIGIN = os.environ.get("ADMIN_URL", "http://localhost:5174")


def db():
    from pymongo import MongoClient
    return MongoClient(os.environ["MONGODB_URI"])[os.environ["MONGODB_DB_NAME"]]


class Api:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def req(self, method, path, body=None, key=None):
        h = {"content-type": "application/json", "origin": ADMIN_ORIGIN, "x-app-kind": "admin"}
        if self.csrf and method != "GET":
            h["x-csrf-token"] = self.csrf
        if key:
            h["idempotency-key"] = key
        r = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(), method=method, headers=h)
        try:
            with self.op.open(r, timeout=60) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def login(self):
        st, d = self.req("POST", "/api/auth/login", {"loginId": os.environ.get("ADMIN_LOGIN", "admin"), "pin": os.environ["ADMIN_PASSWORD"]})
        assert st == 200, d
        self.csrf = d["csrfToken"]


def wait(fn, timeout=120, every=0.5, what="condition"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise AssertionError("timed out waiting for " + what)


def spawn(owner, lease_s=6):
    env = dict(os.environ, ENGINE_WORKER_ID=owner, ENGINE_JOB_LEASE_SECONDS=str(lease_s), ENGINE_TICK_SECONDS="1")
    log = open(os.path.join(HERE, ".%s.log" % owner), "w")
    return subprocess.Popen([sys.executable, "-u", "-m", "gini_engine"], cwd=ENGINE_DIR, env=env, stdout=log, stderr=subprocess.STDOUT)


@pytest.fixture(scope="module")
def store():
    d = db()
    fresh = [w["WORKER_ID"] for w in d.engine_workers.find({"STATUS": "RUNNING", "HEARTBEAT_AT": {"$gte": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(seconds=15)}})]
    if fresh:
        pytest.skip("another engine worker is running (%s); stop it so this test owns the engine processes" % ", ".join(fresh))
    return d


def test_session_lease_and_job_fencing_are_exclusive(store):
    from gini_engine import jobs as J
    sid = "S-LEASETEST-" + uuid.uuid4().hex[:6].upper()
    store.sim_sessions.insert_one({"SESSION_ID": sid, "STATUS": "ARCHIVED", "ENGINE": {"FENCE": 0}, "_origin": "TEST"})
    try:
        got = []
        barrier = threading.Barrier(8)

        def race(i):
            barrier.wait()
            r = J.lease_session(store, sid, "owner-%d" % i, 30)
            if r:
                got.append(r["ENGINE"]["LEASE_OWNER"])
        th = [threading.Thread(target=race, args=(i,)) for i in range(8)]
        [t.start() for t in th]
        [t.join() for t in th]
        assert len(got) == 1, "exactly one concurrent claimant obtains the session lease: %s" % got
        holder = store.sim_sessions.find_one({"SESSION_ID": sid})
        assert J.lease_session(store, sid, "intruder", 30) is None, "an unexpired lease cannot be taken"
        # expire it: the takeover increments the fence and the old holder can no longer renew
        store.sim_sessions.update_one({"SESSION_ID": sid}, {"$set": {"ENGINE.LEASE_EXPIRES_AT": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(seconds=1)}})
        new = J.lease_session(store, sid, "successor", 30)
        assert new and new["ENGINE"]["FENCE"] == holder["ENGINE"]["FENCE"] + 1
        assert not J.renew_session(store, holder, holder["ENGINE"]["LEASE_OWNER"], 30), "a stale holder cannot renew a lost lease"
        assert J.renew_session(store, new, "successor", 30)
        # jobs: concurrent claim of one job -> one winner; a stale owner cannot complete a re-claimed job
        jid = J.enqueue(store, sid, "TEST_NOOP", dedup_key="TEST_NOOP:" + sid)
        claims = []
        b2 = threading.Barrier(6)

        def claim(i):
            b2.wait()
            j = J.claim(store, "w-%d" % i, 30, types=["TEST_NOOP"])
            if j:
                claims.append(j)
        th = [threading.Thread(target=claim, args=(i,)) for i in range(6)]
        [t.start() for t in th]
        [t.join() for t in th]
        assert len(claims) == 1 and claims[0]["JOB_ID"] == jid
        first = claims[0]
        store.jobs.update_one({"JOB_ID": jid}, {"$set": {"LEASE_EXPIRES_AT": dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(seconds=1)}})
        second = J.claim(store, "w-late", 30, types=["TEST_NOOP"])
        assert second and second["FENCE"] == first["FENCE"] + 1
        assert not J.complete(store, first, first["LEASE_OWNER"], {"stale": True}), "fenced: the stale owner's completion is rejected"
        assert J.complete(store, second, "w-late", {"ok": True})
        assert store.jobs.find_one({"JOB_ID": jid})["RESULT"] == {"ok": True}
    finally:
        store.sim_sessions.delete_one({"SESSION_ID": sid})
        store.jobs.delete_many({"SESSION_ID": sid})


def test_two_engines_crash_takeover_and_restart_never_double_advance(store):
    api = Api()
    api.login()
    procs = {"eng-A": spawn("eng-A"), "eng-B": spawn("eng-B")}
    sid = None
    try:
        st, d = api.req("POST", "/api/sessions", {"mode": "INTERACTIVE", "checkpointId": "CK-20261015-1055", "name": "engine process test"})
        assert st == 201, d
        sid = d["session"]["sessionId"]
        wait(lambda: (api.req("GET", "/api/sessions/" + sid)[1]["session"]["status"] == "READY"), 180, what="session initialised by a spawned engine")
        assert api.req("POST", "/api/sessions/%s/clock" % sid, {"action": "SPEED", "speed": 120})[0] == 200
        assert api.req("POST", "/api/sessions/%s/clock" % sid, {"action": "PLAY"})[0] == 200

        samples = []

        def observe(seconds):
            t0 = time.time()
            while time.time() - t0 < seconds:
                s = store.sim_sessions.find_one({"SESSION_ID": sid}, {"ENGINE": 1})
                e = s.get("ENGINE") or {}
                samples.append((time.time(), e.get("LEASE_OWNER"), e.get("FENCE"), e.get("SIM_AT")))
                time.sleep(0.3)
        observe(15)
        owners = {o for _, o, _, _ in samples if o}
        assert len(owners) == 1, "with both engines healthy the lease never changes hands: %s" % owners
        holder = owners.pop()
        sim_before_crash = samples[-1][3]
        assert sim_before_crash is not None, "the healthy engine advanced the session"

        # crash the lease holder without a clean release
        procs[holder].send_signal(signal.SIGKILL)
        procs[holder].wait()
        other = "eng-B" if holder == "eng-A" else "eng-A"
        n0 = len(samples)
        wait(lambda: (store.sim_sessions.find_one({"SESSION_ID": sid})["ENGINE"].get("LEASE_OWNER") == other), 60, what="takeover after lease expiry")
        observe(10)
        after = samples[n0:]
        assert after[-1][3] > sim_before_crash, "the survivor continues advancing from the persisted SIM_AT"
        fences = [f for _, o, f, _ in samples if f is not None]
        assert fences == sorted(fences), "the fence only increases"

        # restart: a brand-new process joins (and the survivor is stopped cleanly); it resumes from persisted state
        procs[other].send_signal(signal.SIGTERM)
        procs[other].wait(timeout=30)
        procs["eng-C"] = spawn("eng-C")
        sim_before_restart = store.sim_sessions.find_one({"SESSION_ID": sid})["ENGINE"]["SIM_AT"]
        wait(lambda: (store.sim_sessions.find_one({"SESSION_ID": sid})["ENGINE"].get("LEASE_OWNER") == "eng-C"), 60, what="restarted engine takes the lease")
        wait(lambda: (store.sim_sessions.find_one({"SESSION_ID": sid})["ENGINE"]["SIM_AT"] > sim_before_restart), 60, what="restarted engine advances")
        sims = [x for _, _, _, x in samples if x]
        assert sims == sorted(sims), "simulated engine time never moves backwards across crash and restart"

        assert api.req("POST", "/api/sessions/%s/clock" % sid, {"action": "PAUSE"})[0] == 200
        wait(lambda: (lambda s: (s.get("EVENT_SEQ") or 0) == (s.get("ENGINE") or {}).get("WATERMARK_SEQ"))(store.sim_sessions.find_one({"SESSION_ID": sid})), 120, what="analytics caught up")

        # no duplicates anywhere
        ev = list(store.sim_events.find({"SESSION_ID": sid}, {"EVENT_SEQ": 1, "EVENT_ID": 1, "IDEMPOTENCY_KEY": 1, "ACTOR_TYPE": 1}))
        seqs = sorted(e["EVENT_SEQ"] for e in ev)
        assert len(set(seqs)) == len(seqs) and seqs[-1] - seqs[0] + 1 == len(seqs), "contiguous, unique event sequence"
        assert len({e["EVENT_ID"] for e in ev}) == len(ev)
        tasks = list(store.sim_tasks.find({"SESSION_ID": sid}, {"TASK_ID": 1, "WORKER_ID": 1, "STATUS": 1}))
        assert len({t["TASK_ID"] for t in tasks}) == len(tasks), "no duplicated tasks"
        working = {}
        for t in tasks:
            if t["STATUS"] == "WORKING":
                working[t["WORKER_ID"]] = working.get(t["WORKER_ID"], 0) + 1
        assert not [w for w, n in working.items() if n > 1], "no worker double-booked"
        pts = list(store.sim_points_ledger.find({"SESSION_ID": sid}, {"AWARD_KEY": 1, "WORKER_ID": 1, "POINTS_TRANSACTION_ID": 1}))
        keys = ["%s|%s" % (p["AWARD_KEY"], p["WORKER_ID"]) for p in pts]
        assert len({p["POINTS_TRANSACTION_ID"] for p in pts}) == len(pts)
        assert len(set(keys)) == len(keys), "no duplicated points"
        idem = [k["KEY"] for k in store.idempotency_keys.find({"SESSION_ID": sid}, {"KEY": 1})]
        assert len(set(idem)) == len(idem)
    finally:
        for p in procs.values():
            if p.poll() is None:
                p.send_signal(signal.SIGTERM)
                try:
                    p.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    p.kill()
        if sid:
            api.req("POST", "/api/sessions/%s/archive" % sid, {})
