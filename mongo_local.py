"""Local MongoDB helper for the GiNi Windows scripts (no secrets involved: the local server has no password).
   py -3.13 mongo_local.py status   -> is MongoDB running, and is it a replica set?
   py -3.13 mongo_local.py init     -> turn the running server into the one-member replica set rs0 (once)
Exit codes: 0 ok, 2 MongoDB not reachable, 3 replica-set mode not switched on in mongod.cfg, 4 other problem."""
import sys
import time

try:
    import pymongo
    from pymongo.errors import OperationFailure
except ImportError:
    print("pymongo is not installed yet: run  py -3.13 -m pip install pymongo==4.10.1 dnspython==2.7.0")
    sys.exit(4)

DIRECT = "mongodb://localhost:27017/?directConnection=true"
RS = "mongodb://localhost:27017/?replicaSet=rs0"
mode = sys.argv[1] if len(sys.argv) > 1 else "status"

try:
    c = pymongo.MongoClient(DIRECT, serverSelectionTimeoutMS=5000)
    hello = c.admin.command("hello")
except Exception as e:
    print("MongoDB is NOT reachable on localhost:27017 (%s)" % type(e).__name__)
    print("-> Is it installed and is the 'MongoDB' Windows service running?  Get-Service MongoDB")
    sys.exit(2)

version = c.server_info().get("version")
print("MongoDB %s is running on localhost:27017" % version)

if not hello.get("setName"):
    if mode != "init":
        print("Replica set: not initialised yet")
        sys.exit(3)
    try:
        c.admin.command("replSetInitiate", {"_id": "rs0", "members": [{"_id": 0, "host": "localhost:27017"}]})
        print("Replica set rs0 initiated")
    except OperationFailure as e:
        if e.code == 76 or "replSet" in str(e) and "not running" in str(e):
            print("Replica-set mode is NOT switched on in mongod.cfg.")
            print("-> Run gini-1-enable-replica-set.ps1 (it asks for administrator permission), then run this setup again.")
            sys.exit(3)
        if e.code != 23:          # 23 = already initialised
            print("Could not initiate the replica set: %s" % e)
            sys.exit(4)

# wait until this member is PRIMARY (writable)
for _ in range(60):
    h = pymongo.MongoClient(DIRECT, serverSelectionTimeoutMS=5000).admin.command("hello")
    if h.get("isWritablePrimary"):
        break
    time.sleep(1)
else:
    print("The replica set did not become PRIMARY within 60 s")
    sys.exit(4)

h = pymongo.MongoClient(RS, serverSelectionTimeoutMS=8000).admin.command("hello")
print("Replica set: %s   primary: %s   -> connection string for the app: %s" % (h.get("setName"), h.get("isWritablePrimary"), RS))
sys.exit(0 if h.get("setName") == "rs0" and h.get("isWritablePrimary") else 4)
