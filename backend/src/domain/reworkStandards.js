'use strict';
/* Rework labour standards with explicit provenance.

   A number on an operation does not establish approval. A rework attempt is scored for time only against a standard that a named,
   authorised person APPROVED, with a version and an effective date (repair review finding). Records:
     rework_standards: STANDARD_ID, KEY (PRODUCT|OPERATION|REWORK_TYPE, '*' = any), LABOR_MIN, VERSION, STATUS
                       (APPROVED | SUPERSEDED | WITHDRAWN), APPROVED_BY, APPROVED_AT, APPROVAL_STATEMENT, EFFECTIVE_FROM, SOURCE
   Without an approved standard, a rework operation carries the configured planning value (forecast only) marked
     REWORK_STANDARD.STATUS = PROVISIONAL, SOURCE = SYNTHETIC_DEFAULT_PLANNING_VALUE
   and its time points stay PENDING (python_engine/gini_engine/points.py). Every change is one transaction with its audit record. */
const { getDb } = require('../lib/db');
const { config } = require('../config/env');
const C = require('./catalog');
const E = require('../lib/errors');
const A = require('../services/audit');
const SIMCFG = require('../../config/simulation.json');

const REWORK_TYPES = ['*', 'GATE_REWORK', 'DOWNSTREAM_REWORK', 'ORIGIN_CORRECTION'];          // the rework types the data and commands use
const keyOf = (productId, operationId, reworkType) => `${productId || '*'}|${operationId}|${reworkType || '*'}`;

/** most specific APPROVED standard effective at `at`: product+type, product+any, any+type, any+any */
async function approvedFor(db, { productId, operationId, reworkType, at, session }) {
  const keys = [keyOf(productId, operationId, reworkType), keyOf(productId, operationId, '*'), keyOf('*', operationId, reworkType), keyOf('*', operationId, '*')];
  const rows = await db.collection('rework_standards').find({ KEY: { $in: keys }, STATUS: 'APPROVED', EFFECTIVE_FROM: { $lte: at } }, session ? { session } : {}).toArray();
  rows.sort((a, b) => keys.indexOf(a.KEY) - keys.indexOf(b.KEY) || b.VERSION - a.VERSION);
  return rows[0] || null;
}

/** what an operation records about its rework standard (snapshot at operation start) */
async function provenanceFor(db, args) {
  const std = await approvedFor(db, args);
  if (std) {
    return { minutes: std.LABOR_MIN, provenance: { STATUS: 'APPROVED', SOURCE: 'APPROVED_REWORK_STANDARD', STANDARD_ID: std.STANDARD_ID, KEY: std.KEY, VERSION: std.VERSION,
      APPROVED_BY: std.APPROVED_BY, APPROVED_AT: std.APPROVED_AT, EFFECTIVE_FROM: std.EFFECTIVE_FROM } };
  }
  const planning = Number(SIMCFG.agent.default_rework_labor_min || 60);
  return { minutes: planning, provenance: { STATUS: 'PROVISIONAL', SOURCE: 'SYNTHETIC_DEFAULT_PLANNING_VALUE', STANDARD_ID: null, KEY: keyOf(args.productId, args.operationId, args.reworkType), VERSION: null,
    APPROVED_BY: null, APPROVED_AT: null, EFFECTIVE_FROM: null, NOTE: `Planning value ${planning} min from config/simulation.json for forecasting only - not an approved standard; no time points until one is approved` } };
}

async function list(q = {}) {
  const db = await getDb();
  const f = {};
  if (q.operationId) f.OPERATION_ID = q.operationId;
  if (q.status) f.STATUS = q.status;
  const rows = await db.collection('rework_standards').find(f, { projection: { _id: 0 } }).sort({ KEY: 1, VERSION: -1 }).limit(500).toArray();
  return { standards: rows, reworkTypes: REWORK_TYPES, planningDefaultMin: Number(SIMCFG.agent.default_rework_labor_min || 60) };
}

async function approve(body, actor, meta = {}) {
  const cat = await C.catalog();
  const p = [];
  const operationId = String(body.operationId || '');
  const productId = body.productId && body.productId !== '*' ? String(body.productId) : '*';
  const reworkType = body.reworkType || '*';
  const minutes = Number(body.laborMin);
  const defs = cat.routing.filter(r => r.OPERATION_ID === operationId && r.OPERATION_KIND === 'LABOR' && (productId === '*' || r.PRODUCT_ID === productId));
  if (!defs.length) p.push(`operationId ${operationId || '(missing)'} is not a labour operation${productId !== '*' ? ` of product ${productId}` : ''}`);
  if (productId !== '*' && !cat.products[productId]) p.push(`unknown product ${productId}`);
  if (!REWORK_TYPES.includes(reworkType)) p.push(`reworkType must be one of ${REWORK_TYPES.join(', ')}`);
  const maxStd = Math.max(0, ...defs.map(d => Number(d.STANDARD_LABOR_MIN || 0)));
  if (!(minutes > 0)) p.push('laborMin must be a positive number of labour minutes');
  else if (maxStd && minutes > maxStd * 3) p.push(`laborMin ${minutes} is more than 3x the original operation standard (${maxStd} min) - check the value`);
  const statement = String(body.approvalStatement || '').trim();
  if (statement.length < 10) p.push('approvalStatement is required: who measured or agreed the standard and on what basis (at least 10 characters)');
  const effective = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date('2026-09-01T00:00:00Z');
  if (isNaN(effective)) p.push('effectiveFrom is not a date');
  if (p.length) throw E.bad('INVALID_REWORK_STANDARD', p.join('; '), { problems: p });
  const key = keyOf(productId, operationId, reworkType);
  return A.adminTx({ actor, action: 'REWORK_STANDARD_APPROVED', target: key, idempotencyKey: meta.idempotencyKey, request: body, requestId: meta.requestId }, async (s, db) => {
    const prev = await db.collection('rework_standards').find({ KEY: key }, { session: s }).sort({ VERSION: -1 }).limit(1).toArray();
    const version = prev.length ? prev[0].VERSION + 1 : 1;
    const now = new Date();
    const doc = { STANDARD_ID: `RWS-${operationId}-${productId === '*' ? 'ANY' : productId}-${reworkType === '*' ? 'ANY' : reworkType}-V${version}`, KEY: key, PRODUCT_ID: productId, OPERATION_ID: operationId,
      REWORK_TYPE: reworkType, LABOR_MIN: minutes, VERSION: version, STATUS: 'APPROVED', APPROVED_BY: actor, APPROVED_AT: now, APPROVAL_STATEMENT: statement, EFFECTIVE_FROM: effective,
      SUPERSEDES: prev.length ? prev[0].STANDARD_ID : null, SOURCE: 'ADMIN_APPROVED', dataset_id: config().datasetId, _origin: 'APP' };
    await db.collection('rework_standards').updateMany({ KEY: key, STATUS: 'APPROVED' }, { $set: { STATUS: 'SUPERSEDED', SUPERSEDED_AT: now, SUPERSEDED_BY: doc.STANDARD_ID } }, { session: s });
    await db.collection('rework_standards').insertOne(doc, { session: s });
    const { _id, ...clean } = doc;
    return { target: doc.STANDARD_ID, before: prev.length ? { standardId: prev[0].STANDARD_ID, laborMin: prev[0].LABOR_MIN, status: prev[0].STATUS } : null, after: clean, details: { key, version }, result: { standard: clean } };
  });
}

async function withdraw(standardId, reason, actor, meta = {}) {
  if (!reason || String(reason).trim().length < 5) throw E.bad('REASON_REQUIRED', 'A withdrawal needs a reason');
  return A.adminTx({ actor, action: 'REWORK_STANDARD_WITHDRAWN', target: standardId, idempotencyKey: meta.idempotencyKey, request: { standardId, reason }, requestId: meta.requestId }, async (s, db) => {
    const d = await db.collection('rework_standards').findOne({ STANDARD_ID: standardId }, { session: s });
    if (!d) throw E.notFound('Rework standard');
    if (d.STATUS !== 'APPROVED') throw E.conflict('NOT_APPROVED', `Standard is ${d.STATUS}`);
    await db.collection('rework_standards').updateOne({ STANDARD_ID: standardId }, { $set: { STATUS: 'WITHDRAWN', WITHDRAWN_AT: new Date(), WITHDRAWN_BY: actor, WITHDRAW_REASON: reason } }, { session: s });
    return { before: { status: 'APPROVED' }, after: { status: 'WITHDRAWN', reason }, details: { reason }, result: { ok: true, note: 'Operations already scored keep their evaluation history; new attempts fall back to PROVISIONAL (no time points).' } };
  });
}

module.exports = { approvedFor, provenanceFor, list, approve, withdraw, keyOf, REWORK_TYPES };
