'use strict';
/*
 * TEST SUBSTITUTE SERVER - NOT MongoDB.
 *
 * MongoDB wire-protocol front end (OP_MSG + legacy OP_QUERY handshake) for the docdb test store, so that the REAL official
 * drivers (MongoDB Node.js driver, PyMongo) can be exercised end to end in an environment where no MongoDB server can be
 * installed. It reports itself as a one-member replica set "rs0" so the drivers use sessions, retryable writes and
 * multi-document transactions exactly as they would against Atlas.
 *
 * What it proves: the application's use of the real driver APIs (commands, cursors, sessions, transactions, error codes,
 * BSON types). What it does NOT prove: MongoDB server semantics, storage engine, concurrency control (docdb serialises
 * every transaction behind one global lock), index performance or Atlas networking. Those require a real MongoDB server.
 */
const net = require('net');
const BSON = require('bson');

const OP_REPLY = 1, OP_QUERY = 2004, OP_MSG = 2013;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

module.exports = function startWire(ctx, port, host = '127.0.0.1') {
  const { C, execute, coll, acquire, release, dbs } = ctx;
  const me = `${host}:${port}`;
  const electionId = new BSON.ObjectId();
  const startedAt = new Date();
  let connSeq = 0, cursorSeq = 0;
  const cursors = new Map();            // id -> { ns, docs, pos }
  const sessTxns = new Map();           // `${lsidHex}:${txnNumber}` -> docdb txn id
  const committed = new Set();          // recently committed txn keys (commit retries)

  // ------------------------------------------------------------------ value conversion bson <-> docdb
  function fromBson(v) {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (v instanceof Date || v instanceof RegExp) return v;
    if (Array.isArray(v)) return v.map(fromBson);
    switch (v._bsontype) {
      case 'ObjectId': return new C.ObjectId(v.toHexString());
      case 'Decimal128': return new C.Decimal128(v.toString());
      case 'Long': return v.toNumber();
      case 'Int32': case 'Double': return v.valueOf();
      case 'Binary': case 'Timestamp': case 'MinKey': case 'MaxKey': case 'Code': case 'BSONSymbol': return v;
      default: break;
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = fromBson(v[k]);
    return o;
  }
  function toBson(v) {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (v instanceof Date || v instanceof RegExp) return v;
    if (Array.isArray(v)) return v.map(toBson);
    if (v instanceof C.ObjectId) return BSON.ObjectId.createFromHexString(v.hex);
    if (v instanceof C.Decimal128) return BSON.Decimal128.fromString(v.value);
    if (v._bsontype) return v;
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = toBson(v[k]);
    return o;
  }

  // ------------------------------------------------------------------ errors
  const err = (e, extra = {}) => {
    const code = typeof e.code === 'number' ? e.code : (e.code === 'DUPLICATE_KEY' ? 11000 : 8000);
    const out = { ok: 0, errmsg: String(e.message || e), code, codeName: e.codeName || (code === 11000 ? 'DuplicateKey' : code === 251 ? 'NoSuchTransaction' : code === 40 ? 'ConflictingUpdateOperators' : code === 31254 ? 'Location31254' : 'InternalError'), ...extra };
    if (e.keyPattern) out.keyPattern = e.keyPattern;
    if (e.keyValue) out.keyValue = toBson(e.keyValue);
    if (e.errorLabels) out.errorLabels = e.errorLabels;
    return out;
  };
  const writeError = (e, index) => {
    const w = { index, code: typeof e.code === 'number' ? e.code : 8000, errmsg: String(e.message || e) };
    if (e.keyPattern) w.keyPattern = e.keyPattern;
    if (e.keyValue) w.keyValue = toBson(e.keyValue);
    return w;
  };

  // ------------------------------------------------------------------ cursors
  function cursorReply(ns, docs, batchSize, first, singleBatch) {
    let n = 0, bytes = 0;
    const out = [];
    const limit = batchSize && batchSize > 0 ? batchSize : Infinity;
    while (n < docs.length && out.length < limit) {
      const d = toBson(docs[n]);
      const sz = BSON.calculateObjectSize(d);
      if (out.length && bytes + sz > MAX_BATCH_BYTES) break;
      out.push(d); bytes += sz; n++;
    }
    let id = 0;
    if (n < docs.length && !singleBatch) {
      id = ++cursorSeq;
      cursors.set(id, { ns, docs: docs.slice(n), touched: Date.now() });
    }
    return { cursor: { [first ? 'firstBatch' : 'nextBatch']: out, id: BSON.Long.fromNumber(id), ns }, ok: 1 };
  }
  setInterval(() => { const t = Date.now() - 10 * 60000; for (const [id, c] of cursors) if (c.touched < t) cursors.delete(id); }, 60000).unref();

  // ------------------------------------------------------------------ transactions
  function txnKey(cmd) {
    if (!cmd.lsid || cmd.txnNumber === undefined || cmd.autocommit !== false) return null;
    const id = cmd.lsid.id && cmd.lsid.id.buffer ? Buffer.from(cmd.lsid.id.buffer).toString('hex') : JSON.stringify(cmd.lsid);
    return `${id}:${cmd.txnNumber}`;
  }

  // ------------------------------------------------------------------ command execution (inside the lock)
  function runCommand(name, cmd, db, seq, txn) {
    const a = (collName, extra) => ({ db, coll: collName, ...extra });
    switch (name) {
      case 'ping': return { ok: 1 };
      case 'buildinfo': case 'buildInfo': return { version: '7.0.0-docdb-wire-test-substitute', versionArray: [7, 0, 0, 0], gitVersion: 'docdb', bits: 64, maxBsonObjectSize: 16777216, ok: 1 };
      case 'endSessions': case 'killCursors': {
        for (const id of cmd.cursors || []) cursors.delete(Number(id));
        return { ok: 1, cursorsKilled: cmd.cursors || [] };
      }
      case 'getMore': {
        const id = Number(cmd.getMore);
        const c = cursors.get(id);
        if (!c) return err({ message: `cursor id ${id} not found`, code: 43, codeName: 'CursorNotFound' });
        cursors.delete(id);
        const r = cursorReply(c.ns, c.docs, cmd.batchSize, false, false);
        return r;
      }
      case 'listDatabases': return { databases: [...dbs.keys()].map(n => ({ name: n, sizeOnDisk: 0, empty: false })), ok: 1 };
      case 'listCollections': {
        let names = [...(dbs.get(db) || new Map()).keys()];
        const f = fromBson(cmd.filter || {});
        if (f.name !== undefined) names = names.filter(n => C.matches({ name: n }, { name: f.name }));
        return cursorReply(`${db}.$cmd.listCollections`, names.map(n => (cmd.nameOnly ? { name: n, type: 'collection' } : { name: n, type: 'collection', options: {}, info: { readOnly: false } })), cmd.cursor && cmd.cursor.batchSize, true, false);
      }
      case 'create': coll(db, cmd.create); return { ok: 1 };
      case 'drop': execute('drop', a(cmd.drop), txn); return { ok: 1, ns: `${db}.${cmd.drop}`, nIndexesWas: 1 };
      case 'dropDatabase': execute('dropDatabase', { db }, txn); return { ok: 1, dropped: db };
      case 'createIndexes': {
        const c = coll(db, cmd.createIndexes);
        const before = c.indexes.length;
        for (const ix of cmd.indexes || []) c.createIndex(Object.entries(ix.key), { name: ix.name, unique: ix.unique, partialFilterExpression: ix.partialFilterExpression ? fromBson(ix.partialFilterExpression) : undefined });
        return { numIndexesBefore: before, numIndexesAfter: c.indexes.length, createdCollectionAutomatically: false, ok: 1 };
      }
      case 'listIndexes': {
        const ix = execute('listIndexes', a(cmd.listIndexes), txn).map(i => ({ v: 2, key: i.key, name: i.name, ...(i.unique ? { unique: true } : {}), ...(i.partialFilterExpression ? { partialFilterExpression: i.partialFilterExpression } : {}) }));
        return cursorReply(`${db}.${cmd.listIndexes}`, ix, cmd.cursor && cmd.cursor.batchSize, true, false);
      }
      case 'dropIndexes': execute('dropIndexes', a(cmd.dropIndexes), txn); return { ok: 1 };
      case 'count': {
        const n = execute('count', a(cmd.count, { filter: fromBson(cmd.query || {}), skip: cmd.skip, limit: cmd.limit }), txn);
        return { n, ok: 1 };
      }
      case 'distinct': {
        const values = execute('distinct', a(cmd.distinct, { key: cmd.key, filter: fromBson(cmd.query || {}) }), txn);
        return { values: toBson(values), ok: 1 };
      }
      case 'find': {
        let limit = cmd.limit ? Math.abs(Number(cmd.limit)) : 0;
        const docs = execute('find', a(cmd.find, { filter: fromBson(cmd.filter || {}), sort: cmd.sort, projection: cmd.projection, skip: cmd.skip ? Number(cmd.skip) : 0, limit }), txn);
        return cursorReply(`${db}.${cmd.find}`, docs, cmd.batchSize, true, !!cmd.singleBatch || Number(cmd.limit) < 0);
      }
      case 'aggregate': {
        const pipe = fromBson(cmd.pipeline || []);
        // countDocuments(): [$match, ($skip), ($limit), $group {_id:1, n:{$sum:1}}] -> counted without materialising documents
        const g = pipe[pipe.length - 1];
        if (g && g.$group && g.$group._id === 1 && g.$group.n && g.$group.n.$sum === 1 && pipe.slice(0, -1).every(s => s.$match || s.$skip !== undefined || s.$limit !== undefined)) {
          const m = pipe.find(s => s.$match); const sk = pipe.find(s => s.$skip !== undefined); const li = pipe.find(s => s.$limit !== undefined);
          const n = execute('count', a(cmd.aggregate, { filter: (m && m.$match) || {}, skip: sk && sk.$skip, limit: li && li.$limit }), txn);
          return cursorReply(`${db}.${cmd.aggregate}`, n ? [{ _id: 1, n }] : [], 0, true, false);
        }
        const docs = execute('aggregate', a(cmd.aggregate, { pipeline: pipe }), txn);
        return cursorReply(`${db}.${cmd.aggregate}`, docs, cmd.cursor && cmd.cursor.batchSize, true, false);
      }
      case 'insert': {
        const docs = (cmd.documents || seq.documents || []).map(fromBson);
        let n = 0; const writeErrors = [];
        for (let i = 0; i < docs.length; i++) {
          try { execute('insertOne', a(cmd.insert, { doc: docs[i] }), txn); n++; } catch (e) { writeErrors.push(writeError(e, i)); if (cmd.ordered !== false) break; }
        }
        return { n, ok: 1, ...(writeErrors.length ? { writeErrors } : {}) };
      }
      case 'update': {
        const ups = cmd.updates || seq.updates || [];
        let n = 0, nModified = 0; const upserted = [], writeErrors = [];
        for (let i = 0; i < ups.length; i++) {
          const u = ups[i];
          try {
            if (Array.isArray(u.u)) throw Object.assign(new Error('docdb-wire: pipeline updates are not supported'), { code: 9 });
            const replacement = u.u && !Object.keys(u.u).some(k => k.startsWith('$'));
            const r = execute(u.multi ? 'updateMany' : (replacement ? 'replaceOne' : 'updateOne'), a(cmd.update, { filter: fromBson(u.q || {}), update: fromBson(u.u), options: { upsert: !!u.upsert } }), txn);
            n += r.matchedCount + (r.upsertedCount || 0); nModified += r.modifiedCount;
            if (r.upsertedCount) upserted.push({ index: i, _id: toBson(r.upsertedId) });
          } catch (e) { writeErrors.push(writeError(e, i)); if (cmd.ordered !== false) break; }
        }
        return { n, nModified, ok: 1, ...(upserted.length ? { upserted } : {}), ...(writeErrors.length ? { writeErrors } : {}) };
      }
      case 'delete': {
        const dels = cmd.deletes || seq.deletes || [];
        let n = 0; const writeErrors = [];
        for (let i = 0; i < dels.length; i++) {
          try { n += execute(Number(dels[i].limit) === 1 ? 'deleteOne' : 'deleteMany', a(cmd.delete, { filter: fromBson(dels[i].q || {}) }), txn).deletedCount; } catch (e) { writeErrors.push(writeError(e, i)); if (cmd.ordered !== false) break; }
        }
        return { n, ok: 1, ...(writeErrors.length ? { writeErrors } : {}) };
      }
      case 'findAndModify': case 'findandmodify': {
        const collName = cmd.findAndModify || cmd.findandmodify;
        const filter = fromBson(cmd.query || {});
        const projection = cmd.fields ? fromBson(cmd.fields) : undefined;
        if (cmd.remove) {
          const d = execute('findOneAndDelete', a(collName, { filter, options: { sort: cmd.sort } }), txn);
          return { lastErrorObject: { n: d ? 1 : 0 }, value: d ? toBson(C.project(d, projection)) : null, ok: 1 };
        }
        if (Array.isArray(cmd.update)) return err({ message: 'docdb-wire: pipeline updates are not supported', code: 9 });
        const update = fromBson(cmd.update);
        const replacement = update && !Object.keys(update).some(k => k.startsWith('$'));
        const existed = execute('count', a(collName, { filter, limit: 1 }), txn) > 0;
        const d = execute(replacement ? 'findOneAndReplace' : 'findOneAndUpdate', a(collName, { filter, update, options: { upsert: !!cmd.upsert, sort: cmd.sort, returnDocument: cmd.new ? 'after' : 'before', projection } }), txn);
        const leo = { n: existed || cmd.upsert ? 1 : 0, updatedExisting: existed };
        if (!existed && cmd.upsert) { const after = execute('find', a(collName, { filter, limit: 1 }), txn)[0]; if (after) leo.upserted = toBson(after._id); }
        return { lastErrorObject: leo, value: d ? toBson(d) : null, ok: 1 };
      }
      case 'serverStatus': return { host: me, version: '7.0.0-docdb-wire-test-substitute', process: 'docdb', uptime: (Date.now() - startedAt) / 1000, ok: 1 };
      case 'getParameter': return { ok: 1 };
      case 'docdbSnapshot': return { ok: 1, ...ctx.snapshot() };
      default:
        return err({ message: `no such command: '${name}' (docdb-wire test substitute)`, code: 59, codeName: 'CommandNotFound' });
    }
  }

  function hello(conn) {
    return {
      helloOk: true, ismaster: true, isWritablePrimary: true, secondary: false,
      setName: 'rs0', setVersion: 1, hosts: [me], primary: me, me, electionId,
      lastWrite: { opTime: { ts: new BSON.Timestamp({ t: Math.floor(Date.now() / 1000), i: 1 }), t: BSON.Long.fromNumber(1) }, lastWriteDate: new Date() },
      maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 100000, localTime: new Date(),
      logicalSessionTimeoutMinutes: 30, connectionId: conn, minWireVersion: 0, maxWireVersion: 21, readOnly: false, ok: 1,
    };
  }

  // ------------------------------------------------------------------ dispatch with locking / transactions
  async function dispatch(cmd, seq, conn) {
    const name = Object.keys(cmd)[0];
    const db = cmd.$db || 'admin';
    const lname = name.toLowerCase();
    if (lname === 'hello' || lname === 'ismaster') return hello(conn);
    if (lname === 'buildinfo' || lname === 'ping' || lname === 'getparameter') return runCommand(name, cmd, db, seq, null);
    const key = txnKey(cmd);
    if (lname === 'committransaction' || lname === 'aborttransaction') {
      const id = key && sessTxns.get(key);
      if (!id) {
        if (lname === 'committransaction' && committed.has(key)) return { ok: 1 };
        if (lname === 'aborttransaction') return { ok: 1 };
        return err({ message: 'Transaction not found or expired', code: 251, codeName: 'NoSuchTransaction', errorLabels: ['TransientTransactionError'] });
      }
      sessTxns.delete(key);
      if (lname === 'committransaction') {
        const ok = ctx.commitTxn(id);
        if (!ok) return err({ message: 'Transaction expired before commit', code: 251, codeName: 'NoSuchTransaction', errorLabels: ['TransientTransactionError'] });
        committed.add(key); if (committed.size > 5000) committed.delete(committed.values().next().value);
        return { ok: 1 };
      }
      ctx.abortTxn(id);
      return { ok: 1 };
    }
    if (key) {
      let id = sessTxns.get(key);
      if (cmd.startTransaction) {
        id = await ctx.startTxn();
        sessTxns.set(key, id);
      } else if (!id || !ctx.txnAlive(id)) {
        sessTxns.delete(key);
        return err({ message: 'Transaction not found or expired', code: 251, codeName: 'NoSuchTransaction', errorLabels: ['TransientTransactionError'] });
      }
      try { return runCommand(name, cmd, db, seq, ctx.txnObj(id)); } catch (e) { return err(e); }
    }
    const owner = 'wire:' + Math.random();
    await acquire(owner);
    try { return runCommand(name, cmd, db, seq, null); } catch (e) { return err(e); } finally { release(owner); }
  }

  // ------------------------------------------------------------------ framing
  function frame(responseTo, opCode, body) {
    const h = Buffer.alloc(16);
    h.writeInt32LE(16 + body.length, 0); h.writeInt32LE(0, 4); h.writeInt32LE(responseTo, 8); h.writeInt32LE(opCode, 12);
    return Buffer.concat([h, body]);
  }
  function opMsgReply(requestID, doc) {
    const flags = Buffer.alloc(4);
    const kind = Buffer.from([0]);
    return frame(requestID, OP_MSG, Buffer.concat([flags, kind, Buffer.from(BSON.serialize(doc, { ignoreUndefined: true }))]));
  }
  function opReply(requestID, doc) {
    const b = Buffer.alloc(20);
    b.writeInt32LE(8, 0);             // AwaitCapable
    b.writeBigInt64LE(0n, 4); b.writeInt32LE(0, 12); b.writeInt32LE(1, 16);
    return frame(requestID, OP_REPLY, Buffer.concat([b, Buffer.from(BSON.serialize(doc, { ignoreUndefined: true }))]));
  }
  const DOPTS = { promoteLongs: true, promoteValues: true, promoteBuffers: false, bsonRegExp: false };

  const server = net.createServer(sock => {
    const conn = ++connSeq;
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve();
    sock.setNoDelay(true);
    sock.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 16) {
        const len = buf.readInt32LE(0);
        if (buf.length < len) break;
        const msg = buf.subarray(0, len); buf = buf.subarray(len);
        chain = chain.then(() => handleMessage(msg)).catch(e => { console.error('[docdb-wire]', e); sock.destroy(); });
      }
    });
    sock.on('error', () => {});
    async function handleMessage(msg) {
      const requestID = msg.readInt32LE(4), opCode = msg.readInt32LE(12);
      if (opCode === OP_QUERY) {
        let p = 20;
        const nsEnd = msg.indexOf(0, p); p = nsEnd + 1 + 8;
        const qlen = msg.readInt32LE(p);
        let q = BSON.deserialize(msg.subarray(p, p + qlen), DOPTS);
        if (q.$query) q = q.$query;
        const out = await dispatch(q, {}, conn);
        if (!sock.destroyed) sock.write(opReply(requestID, out));
        return;
      }
      if (opCode !== OP_MSG) { sock.destroy(); return; }
      const flags = msg.readUInt32LE(16);
      const end = flags & 1 ? msg.length - 4 : msg.length;
      let p = 20, body = null; const seq = {};
      while (p < end) {
        const kind = msg[p]; p += 1;
        if (kind === 0) { const l = msg.readInt32LE(p); body = BSON.deserialize(msg.subarray(p, p + l), DOPTS); p += l; }
        else if (kind === 1) {
          const size = msg.readInt32LE(p); const sEnd = p + size; p += 4;
          const idEnd = msg.indexOf(0, p); const ident = msg.toString('utf8', p, idEnd); p = idEnd + 1;
          const docs = [];
          while (p < sEnd) { const l = msg.readInt32LE(p); docs.push(BSON.deserialize(msg.subarray(p, p + l), DOPTS)); p += l; }
          seq[ident] = docs;
        } else { sock.destroy(); return; }
      }
      const out = await dispatch(body, seq, conn);
      const moreToCome = flags & 2;     // fire-and-forget (w:0): no reply
      if (!moreToCome && !sock.destroyed) sock.write(opMsgReply(requestID, out));
    }
  });
  server.listen(port, host, () => console.log(`docdb-wire (TEST SUBSTITUTE, not MongoDB) speaking the MongoDB wire protocol on ${me} as replica set rs0`));
  return server;
};
