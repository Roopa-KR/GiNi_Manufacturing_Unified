#!/usr/bin/env node
'use strict';
/*
 * LOCAL TEST STAND-IN - NOT USED IN DEPLOYMENT.
 * HTTP server exposing the docdb store to several processes (Node API, Python engine, seed tools) so local tests can
 * exercise the real multi-process architecture without a MongoDB server. Wire format: POST /op with Extended JSON.
 *
 *   node devtools/docdb/server.js --port 27018 --data ./.docdb      (snapshot dir optional)
 *
 * Transactions: one transaction at a time holds a global lock (all other operations wait), with an undo log for abort
 * and a 20 s timeout. This gives serializable semantics for the small local workload; it is NOT a model of MongoDB's
 * snapshot isolation and must not be used as evidence of real MongoDB behaviour.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('./core');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(opt('port', process.env.DOCDB_PORT || 27018));
const DATA = opt('data', process.env.DOCDB_DATA || '');
const TXN_TIMEOUT_MS = 20000;

const dbs = new Map();
function coll(db, name) {
  if (!dbs.has(db)) dbs.set(db, new Map());
  const m = dbs.get(db);
  if (!m.has(name)) m.set(name, new C.Collection(name));
  return m.get(name);
}

// ------------------------------------------------------------------ global lock + transactions
const lock = { owner: null, queue: [] };
function acquire(owner) {
  if (lock.owner === null || lock.owner === owner) { lock.owner = owner; return Promise.resolve(); }
  return new Promise(res => lock.queue.push({ owner, res }));
}
function release(owner) {
  if (lock.owner !== owner) return;
  lock.owner = null;
  const next = lock.queue.shift();
  if (next) { lock.owner = next.owner; next.res(); }
}
const txns = new Map();   // id -> {undo: [], timer}
let txnSeq = 0;
function abortTxn(id) {
  const t = txns.get(id);
  if (!t) return false;
  for (let i = t.undo.length - 1; i >= 0; i--) t.undo[i]();
  clearTimeout(t.timer);
  txns.delete(id);
  release('txn:' + id);
  return true;
}

// ------------------------------------------------------------------ operations
function recordUndo(txn, fn) { if (txn) txn.undo.push(fn); }

function doInsert(c, doc, txn) {
  const d = C.clone(doc);
  const id = c.insert(d);
  recordUndo(txn, () => c.remove(id));
  return d._id;
}
function doUpdate(c, filter, update, opts, txn, many) {
  let hits = c.find(filter);
  if (opts.sort) hits = C.sortDocs(hits.map(h => h[1]), opts.sort).map(d => [C.idKey(d._id), d]);
  if (!many) hits = hits.slice(0, 1);
  const res = { matchedCount: hits.length, modifiedCount: 0, upsertedId: null, upsertedCount: 0, before: null, after: null };
  if (!hits.length && opts.upsert) {
    const d = C.upsertSeed(filter);
    C.applyUpdate(d, update, true);
    const id = doInsert(c, d, txn);
    res.upsertedId = id; res.upsertedCount = 1; res.after = c.docs.get(C.idKey(id));
    return res;
  }
  // validate all first (unique constraints) to keep the operation atomic per document
  for (const [id, old] of hits) {
    const next = C.clone(old);
    C.applyUpdate(next, update, false);
    if (next._id !== undefined && C.idKey(next._id) !== id) throw new Error('docdb: _id is immutable');
    const changed = JSON.stringify(C.toEJSON(next)) !== JSON.stringify(C.toEJSON(old));
    if (!many) res.before = old;
    if (changed) {
      c.replaceStored(id, old, next);
      recordUndo(txn, () => c.replaceStored(id, next, old));
      res.modifiedCount++;
    }
    if (!many) res.after = c.docs.get(id);
  }
  return res;
}
function doDelete(c, filter, txn, many) {
  let hits = c.find(filter);
  if (!many) hits = hits.slice(0, 1);
  for (const [id, d] of hits) { c.remove(id); recordUndo(txn, () => { c.docs.set(id, d); c.addToIndexes(id, d); }); }
  return hits.length;
}

function execute(op, a, txn) {
  const c = coll(a.db, a.coll || '_');
  switch (op) {
    case 'find': {
      let docs = c.find(a.filter || {}).map(h => h[1]);
      if (a.sort) docs = C.sortDocs(docs, a.sort);
      if (a.skip) docs = docs.slice(a.skip);
      if (a.limit) docs = docs.slice(0, a.limit);
      // no clone without projection: the result is serialised synchronously right after execute()
      return a.projection ? docs.map(d => C.project(d, a.projection)) : docs;
    }
    case 'count': {
      let n = c.find(a.filter || {}).length;
      if (a.skip) n = Math.max(0, n - a.skip);
      if (a.limit) n = Math.min(n, a.limit);
      return n;
    }
    case 'distinct': {
      const seen = new Map();
      for (const [, d] of c.find(a.filter || {})) {
        const v = C.getOne(d, a.key);
        for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) seen.set(JSON.stringify(C.toEJSON(x)), x);
      }
      return [...seen.values()];
    }
    case 'aggregate': return C.aggregate(c.find({}).map(h => h[1]), a.pipeline || []);
    case 'insertOne': return { insertedId: doInsert(c, a.doc, txn) };
    case 'insertMany': {
      const ids = []; const errors = [];
      a.docs.forEach((d, i) => {
        try { ids.push(doInsert(c, d, txn)); } catch (e) { if (a.ordered !== false) throw Object.assign(e, { insertedIds: ids }); errors.push({ index: i, code: e.code, errmsg: e.message }); }
      });
      if (errors.length) { const e = new Error('docdb: bulk write errors'); e.code = errors[0].code; e.writeErrors = errors; e.insertedIds = ids; throw e; }
      return { insertedIds: ids, insertedCount: ids.length };
    }
    case 'updateOne': case 'updateMany': case 'replaceOne': {
      const r = doUpdate(c, a.filter || {}, a.update, a.options || {}, txn, op === 'updateMany');
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, upsertedId: r.upsertedId, upsertedCount: r.upsertedCount };
    }
    case 'findOneAndUpdate': case 'findOneAndReplace': {
      const o = a.options || {};
      const r = doUpdate(c, a.filter || {}, a.update, o, txn, false);
      const d = o.returnDocument === 'after' ? r.after : r.before;
      return d ? C.project(d, o.projection) : null;
    }
    case 'findOneAndDelete': {
      let hits = c.find(a.filter || {});
      if (a.options && a.options.sort) hits = C.sortDocs(hits.map(h => h[1]), a.options.sort).map(d => [C.idKey(d._id), d]);
      if (!hits.length) return null;
      const [id, d] = hits[0];
      c.remove(id); recordUndo(txn, () => { c.docs.set(id, d); c.addToIndexes(id, d); });
      return d;
    }
    case 'deleteOne': return { deletedCount: doDelete(c, a.filter || {}, txn, false) };
    case 'deleteMany': return { deletedCount: doDelete(c, a.filter || {}, txn, true) };
    case 'bulkWrite': {
      const res = { insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0, upsertedIds: {} };
      const errors = [];
      a.ops.forEach((w, i) => {
        try {
          const [kind] = Object.keys(w); const s = w[kind];
          if (kind === 'insertOne') { doInsert(c, s.document, txn); res.insertedCount++; }
          else if (kind === 'updateOne' || kind === 'updateMany' || kind === 'replaceOne') {
            const r = doUpdate(c, s.filter, s.update || s.replacement, { upsert: s.upsert }, txn, kind === 'updateMany');
            res.matchedCount += r.matchedCount; res.modifiedCount += r.modifiedCount;
            if (r.upsertedCount) { res.upsertedCount++; res.upsertedIds[i] = r.upsertedId; }
          } else if (kind === 'deleteOne' || kind === 'deleteMany') res.deletedCount += doDelete(c, s.filter, txn, kind === 'deleteMany');
          else throw new Error('docdb: unsupported bulk op ' + kind);
        } catch (e) {
          if (a.ordered !== false) throw e;
          errors.push({ index: i, code: e.code, errmsg: e.message });
        }
      });
      if (errors.length) { const e = new Error('docdb: bulk write errors'); e.code = errors[0].code; e.writeErrors = errors; e.result = res; throw e; }
      return res;
    }
    case 'createIndex': return c.createIndex(a.keys, a.options || {});
    case 'listIndexes': return c.indexes.map(i => ({ name: i.name, key: Object.fromEntries(i.keys), unique: i.unique, partialFilterExpression: i.partial || undefined }));
    case 'dropIndexes': c.dropIndexes(); return true;
    case 'drop': { const m = dbs.get(a.db); return m ? m.delete(a.coll) : false; }
    case 'dropDatabase': return dbs.delete(a.db);
    case 'listCollections': return [...(dbs.get(a.db) || new Map()).keys()].map(name => ({ name }));
    case 'stats': {
      const m = dbs.get(a.db) || new Map();
      return { collections: m.size, documents: [...m.values()].reduce((s, x) => s + x.docs.size, 0) };
    }
    case 'ping': return { ok: 1 };
    default: throw new Error('docdb: unsupported op ' + op);
  }
}

// ------------------------------------------------------------------ snapshots
function snapshot() {
  if (!DATA) return { saved: false };
  fs.mkdirSync(DATA, { recursive: true });
  let n = 0;
  for (const [db, m] of dbs) {
    const dir = path.join(DATA, db); fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    for (const [name, c] of m) {
      const lines = [JSON.stringify({ __indexes: c.indexes.slice(1).map(i => ({ keys: i.keys, unique: i.unique, partial: C.toEJSON(i.partial), name: i.name })) })];
      for (const d of c.docs.values()) { lines.push(JSON.stringify(C.toEJSON(d))); n++; }
      fs.writeFileSync(path.join(dir, encodeURIComponent(name) + '.ndjson.gz'), zlib.gzipSync(lines.join('\n')));
    }
  }
  return { saved: true, documents: n };
}
function loadSnapshot() {
  if (!DATA || !fs.existsSync(DATA)) return 0;
  let n = 0;
  for (const db of fs.readdirSync(DATA)) {
    const dir = path.join(DATA, db);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ndjson.gz')) continue;
      const name = decodeURIComponent(f.replace('.ndjson.gz', ''));
      const c = coll(db, name);
      const lines = zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString('utf8').split('\n');
      const meta = JSON.parse(lines[0]);
      for (let i = 1; i < lines.length; i++) if (lines[i]) { const d = C.intern(C.fromEJSON(JSON.parse(lines[i]))); const id = C.idKey(d._id); c.docs.set(id, d); n++; }
      c.indexes[0].map = new Map();
      for (const [id, d] of c.docs) { const e = c.indexEntry(c.indexes[0], d); c.indexes[0].map.set(e.key, new Set([id])); }
      for (const ix of meta.__indexes || []) c.createIndex(ix.keys, { unique: ix.unique, name: ix.name, partialFilterExpression: C.fromEJSON(ix.partial) || undefined });
    }
  }
  return n;
}

// ------------------------------------------------------------------ HTTP
const stats = { ops: 0, started: new Date() };
async function handle(body) {
  const { op, args: a = {}, txn: txnId } = body;
  if (op === 'txnStart') {
    const id = String(++txnSeq);
    await acquire('txn:' + id);
    const timer = setTimeout(() => abortTxn(id), TXN_TIMEOUT_MS);
    txns.set(id, { undo: [], timer });
    return { txn: id };
  }
  if (op === 'txnCommit') {
    const t = txns.get(txnId);
    if (!t) { const e = new Error('docdb: transaction not found or expired (aborted)'); e.code = 251; e.codeName = 'NoSuchTransaction'; throw e; }
    clearTimeout(t.timer); txns.delete(txnId); release('txn:' + txnId);
    return { committed: true };
  }
  if (op === 'txnAbort') return { aborted: abortTxn(txnId) };
  if (op === 'snapshot') return snapshot();
  if (op === 'serverStatus') return { ...stats, uptimeSec: (Date.now() - stats.started) / 1000, lockOwner: lock.owner, waiting: lock.queue.length, txns: txns.size, storage: 'docdb-local-test-stand-in' };
  const owner = txnId ? 'txn:' + txnId : 'op:' + Math.random();
  if (txnId && !txns.has(txnId)) { const e = new Error('docdb: transaction not found or expired (aborted)'); e.code = 251; e.codeName = 'NoSuchTransaction'; throw e; }
  const waitWarn = !txnId && lock.owner && String(lock.owner).startsWith('txn:') ? setTimeout(() => console.warn(`[docdb] ${op} ${a.coll || ''} waiting >5 s behind ${lock.owner} - a non-transactional read inside a transaction deadlocks here`), 5000) : null;
  await acquire(owner);
  if (waitWarn) clearTimeout(waitWarn);
  try {
    stats.ops++;
    return execute(op, C.fromEJSON(a), txnId ? txns.get(txnId) : null);
  } finally {
    if (!txnId) release(owner);
  }
}

// ------------------------------------------------------------------ MongoDB wire-protocol front end (real drivers -> this test store)
async function startTxn() {
  const id = String(++txnSeq);
  await acquire('txn:' + id);
  const timer = setTimeout(() => abortTxn(id), TXN_TIMEOUT_MS);
  txns.set(id, { undo: [], timer });
  return id;
}
function commitTxn(id) {
  const t = txns.get(id);
  if (!t) return false;
  clearTimeout(t.timer); txns.delete(id); release('txn:' + id);
  return true;
}
const WIRE_PORT = Number(opt('wire-port', process.env.DOCDB_WIRE_PORT || 0));
if (WIRE_PORT) {
  require('./wire')({ C, execute, coll, acquire, release, dbs, startTxn, commitTxn, abortTxn, txnAlive: id => txns.has(id), txnObj: id => txns.get(id), snapshot }, WIRE_PORT);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, storage: 'docdb-local-test-stand-in' })); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let out;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const r = await handle(body);
      out = { ok: 1, result: C.toEJSON(r === undefined ? null : r) };
    } catch (e) {
      out = { ok: 0, error: { message: e.message, code: e.code, codeName: e.codeName, keyPattern: e.keyPattern, keyValue: C.toEJSON(e.keyValue), writeErrors: e.writeErrors } };
    }
    const s = JSON.stringify(out);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  });
});
server.keepAliveTimeout = 60000;
const loaded = loadSnapshot();
server.listen(PORT, '127.0.0.1', () => console.log(`docdb (LOCAL TEST STAND-IN, not MongoDB) listening on 127.0.0.1:${PORT}; loaded ${loaded} documents${DATA ? ' from ' + DATA : ''}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (process.env.DOCDB_SNAPSHOT_ON_EXIT === '1') console.log('snapshot', snapshot()); process.exit(0); });
