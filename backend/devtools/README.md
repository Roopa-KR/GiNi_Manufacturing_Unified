# devtools — test substitute database (NOT MongoDB, not part of the supported workflow)

The supported workflow uses a **real MongoDB replica set** (Atlas, or `docker compose up -d mongo`) and the real npm/PyPI
packages (QUICKSTART.md). This folder exists because the build workspace could reach neither a MongoDB server nor a package
registry. It is isolated here and never used unless you start it yourself.

| Path | What |
|---|---|
| `docdb/server.js`, `docdb/core.js` | A small in-process document store: queries, updates, indexes, and a global lock per transaction with undo-on-abort. It rejects the shapes MongoDB rejects that this code can hit (conflicting update paths, mixed projections). |
| `docdb/wire.js` | Speaks the **MongoDB wire protocol** (OP_MSG and the legacy OP_QUERY handshake) for the **real** drivers (mongodb 6.x, pymongo 4.x). It reports `version 7.0.0-docdb-wire-test-substitute` and replica set `rs0`. The app shows it as "TEST SUBSTITUTE (docdb-wire) - not MongoDB" on `/api/ready` and in Administration → Integrations. |
| `docdb/docdb.sh` | `start / stop / status / snapshot [http-port] [wire-port] [datadir]` |

The earlier library stand-ins (`shims/` for express, mongodb, nodemailer and pymongo) were **removed**. Tests now always use the
real libraries.

What a pass on this substitute does and does not prove:

- It **does** prove the application logic and the use of the real drivers: the commands, transactions as the driver issues them,
  idempotency, the engines, and the UI.
- It does **not** prove MongoDB server behaviour: the storage engine, real snapshot isolation, write-conflict retries under load,
  Atlas networking, or performance.

Results obtained with it are labelled in TEST_RESULTS.md, and the real-MongoDB gate is listed as BLOCKED until it is run.

```bash
cd backend
bash devtools/docdb/docdb.sh start 27021 27022 ../.local/docdb
export MONGODB_URI="mongodb://127.0.0.1:27022/?replicaSet=rs0" MONGODB_DB_NAME=gini_demo
```
