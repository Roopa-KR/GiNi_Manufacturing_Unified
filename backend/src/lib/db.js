'use strict';
/* Cached MongoDB connection (one pool per serverless instance). */
const { MongoClient, ObjectId } = require('mongodb');
const { config } = require('../config/env');

let clientPromise = null;
let dbHandle = null;

async function getDb() {
  if (dbHandle) return dbHandle;
  const c = config();
  if (!c.mongoUri) { const e = new Error('MONGODB_URI is not configured'); e.status = 503; e.code = 'DB_NOT_CONFIGURED'; throw e; }
  if (!clientPromise) {
    const client = new MongoClient(c.mongoUri, { maxPoolSize: c.mongoPool, serverSelectionTimeoutMS: c.mongoTimeout, retryWrites: true });
    clientPromise = client.connect().catch(err => { clientPromise = null; throw err; });
  }
  const client = await clientPromise;
  dbHandle = client.db(c.mongoDb);
  dbHandle.__client = client;
  return dbHandle;
}

async function withTransaction(fn) {
  const db = await getDb();
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw require('./errors').unavailable('TRANSACTIONS_REQUIRED', 'MongoDB must run as a replica set. No nontransactional fallback is permitted.');
  const session = db.__client.startSession();
  try {
    // the callback may run more than once (MongoDB retries TransientTransactionError); keep the last attempt's result explicitly
    // instead of relying on the driver's withTransaction return value, which differs between driver versions
    let result;
    await session.withTransaction(async () => { result = await fn(session, db); }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return result;
  } finally {
    await session.endSession();
  }
}

/** what the connected server reports about itself (cached): a MongoDB server, or the docdb-wire TEST SUBSTITUTE used in the
    build workspace. Shown on /api/ready and Administration -> Integrations so a substitute is never mistaken for MongoDB. */
let identity = null;
async function serverIdentity() {
  if (identity) return identity;
  const db = await getDb();
  const bi = await db.admin().command({ buildInfo: 1 });
  const hello = await db.admin().command({ hello: 1 });
  const v = String(bi.version || '');
  identity = { version: v, replicaSet: hello.setName || null, kind: /docdb/.test(v) ? 'TEST SUBSTITUTE (docdb-wire) - not MongoDB' : 'MongoDB',
    driver: `mongodb ${require('mongodb/package.json').version}` };
  return identity;
}

module.exports = { getDb, withTransaction, ObjectId, serverIdentity };
