'use strict';
/*
 * Validated input path for NEW products (master data). A product is written only when its definition is complete:
 *   routing (ordered operations ending in an inspection gate, valid work centres / skills / crew limits),
 *   standards (positive labour and elapsed minutes per labour operation),
 *   inspection configuration (every gate has CTQ checks; every mandatory numeric check has a specification for this product),
 *   material requirement (existing material).
 * Nothing partial is inserted: validation runs first and the documents are written together in one transaction.
 * New orders/plans for a product are entered per session with the ORDER_CREATE command (commands/orders.js).
 */
const { getDb, withTransaction } = require('../lib/db');
const { config } = require('../config/env');
const C = require('./catalog');
const E = require('../lib/errors');

const ID = /^[A-Z][A-Z0-9-]{2,23}$/;
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

function buildDefinition(cat, body) {
  const tpl = body.templateProductId ? cat.routing.filter(r => r.PRODUCT_ID === body.templateProductId) : [];
  if (body.templateProductId && !tpl.length) throw E.bad('TEMPLATE_UNKNOWN', `Template product ${body.templateProductId} has no routing`);
  const overrides = Object.fromEntries((body.operations || []).map(o => [o.operationId, o]));
  const base = body.operations && body.operations.length && !body.templateProductId
    ? body.operations.map(o => ({ OPERATION_ID: o.operationId }))
    : tpl.map(r => ({ ...r }));
  const ops = base.map(r => {
    const o = overrides[r.OPERATION_ID] || {};
    return {
      OPERATION_ID: r.OPERATION_ID, OPERATION_NAME: o.operationName ?? r.OPERATION_NAME, OPERATION_KIND: o.kind ?? r.OPERATION_KIND, WORK_CENTER_ID: o.workCenterId ?? r.WORK_CENTER_ID,
      SEQUENCE_NO: num(o.sequenceNo ?? r.SEQUENCE_NO), STANDARD_LABOR_MIN: num(o.standardLaborMin ?? r.STANDARD_LABOR_MIN), STANDARD_ELAPSED_MIN: num(o.standardElapsedMin ?? r.STANDARD_ELAPSED_MIN),
      MIN_CREW_SIZE: num(o.minCrew ?? r.MIN_CREW_SIZE), STD_CREW_SIZE: num(o.stdCrew ?? r.STD_CREW_SIZE), MAX_CREW_SIZE: num(o.maxCrew ?? r.MAX_CREW_SIZE),
      REQUIRED_SKILL_ID: o.requiredSkillId ?? r.REQUIRED_SKILL_ID ?? null, GATE_OPERATION_ID: o.gateOperationId ?? r.GATE_OPERATION_ID ?? null, QUALITY_GATE_REQUIRED: o.qualityGateRequired ?? r.QUALITY_GATE_REQUIRED ?? 'N',
      EQUIPMENT_TYPE: o.equipmentType ?? r.EQUIPMENT_TYPE ?? null, SETUP_MIN: num(o.setupMin ?? r.SETUP_MIN ?? 0), PREEMPTIBLE_FLAG: r.PREEMPTIBLE_FLAG || 'Y', FIRST_STAGE_GATE_FLAG: r.FIRST_STAGE_GATE_FLAG || 'N',
      FAIL_DISPOSITION_DEFAULT: r.FAIL_DISPOSITION_DEFAULT || null,
    };
  }).sort((a, b) => a.SEQUENCE_NO - b.SEQUENCE_NO);
  const specs = body.specs ? body.specs.map(s => ({ CHECK_ID: s.checkId, ANSWER_TYPE: (cat.ctq[s.checkId] || {}).ANSWER_TYPE || null, AGGREGATION_RULE: s.aggregation || null, MEASUREMENT_POSITION: s.position || 'ANSWER', MEASUREMENT_UNIT: s.unit, NOMINAL_VALUE: num(s.nominal), LOWER_LIMIT: num(s.lower), UPPER_LIMIT: num(s.upper), REQUIRED_READING_COUNT: num(s.readings || 1), SPEC_SOURCE: s.source || 'APP_INPUT' }))
    : (body.specsFromProductId ? cat.specs.filter(s => s.PRODUCT_ID === body.specsFromProductId).map(s => ({ ...s, SPEC_SOURCE: `COPIED_FROM_${body.specsFromProductId} (${s.SPEC_SOURCE || 'unknown'})` })) : []);
  const materials = body.materials ? body.materials.map(m => ({ MATERIAL_ID: m.materialId, CONSUMED_AT_OPERATION_ID: m.consumedAtOperationId, QTY_PER_UNIT: num(m.qtyPerUnit), UOM: m.uom || 'EA' }))
    : (body.templateProductId ? cat.matReqs.filter(m => m.PRODUCT_ID === body.templateProductId).map(m => ({ MATERIAL_ID: m.MATERIAL_ID, CONSUMED_AT_OPERATION_ID: m.CONSUMED_AT_OPERATION_ID, QTY_PER_UNIT: m.QTY_PER_UNIT, UOM: m.UOM })) : []);
  return { product: { PRODUCT_ID: String(body.productId || '').trim().toUpperCase(), PRODUCT_NAME: body.productName, MODEL_VARIANT: body.modelVariant || null, COMPONENT_TYPE: body.componentType || 'TRANSFORMER_TANK',
    DRAWING_REF: body.drawingRef, DRAWING_REVISION: body.drawingRevision, ROUTE_ID: body.routeId || `RT-${String(body.productId || '').toUpperCase()}`, ROUTE_VERSION: body.routeVersion || '1.0' }, ops, specs, materials };
}

/** returns problems[] (empty = releasable) */
function validateDefinition(cat, def) {
  const p = [];
  const { product, ops, specs, materials } = def;
  if (!ID.test(product.PRODUCT_ID)) p.push('productId must be 3-24 characters: capital letters, digits and hyphens, starting with a letter');
  if (cat.products[product.PRODUCT_ID]) p.push(`product ${product.PRODUCT_ID} already exists`);
  if (!product.PRODUCT_NAME || String(product.PRODUCT_NAME).trim().length < 3) p.push('productName is required');
  if (!product.DRAWING_REF || !product.DRAWING_REVISION) p.push('drawingRef and drawingRevision are required');
  if (!ops.length) p.push('routing: at least one operation is required (operations[] or templateProductId)');
  const seen = new Set();
  ops.forEach((o, i) => {
    const at = `operation ${o.OPERATION_ID || `#${i + 1}`}`;
    if (!o.OPERATION_ID) p.push(`${at}: operationId is required`);
    if (seen.has(o.OPERATION_ID)) p.push(`${at}: duplicate operation`); seen.add(o.OPERATION_ID);
    if (!['LABOR', 'INSPECTION', 'PROCESS'].includes(o.OPERATION_KIND)) p.push(`${at}: kind must be LABOR, INSPECTION or PROCESS (unattended, e.g. cure)`);
    if (o.OPERATION_KIND === 'PROCESS' && !(o.STANDARD_ELAPSED_MIN > 0)) p.push(`${at}: a process step needs positive standard elapsed minutes`);
    if (!Number.isFinite(o.SEQUENCE_NO)) p.push(`${at}: sequenceNo is required`);
    if (!cat.wcs[o.WORK_CENTER_ID]) p.push(`${at}: unknown work centre ${o.WORK_CENTER_ID}`);
    if (o.OPERATION_KIND === 'LABOR') {
      if (!(o.STANDARD_LABOR_MIN > 0) || !(o.STANDARD_ELAPSED_MIN > 0)) p.push(`${at}: standard labour and elapsed minutes must be positive`);
      if (!(o.MIN_CREW_SIZE >= 1 && o.MIN_CREW_SIZE <= o.STD_CREW_SIZE && o.STD_CREW_SIZE <= o.MAX_CREW_SIZE)) p.push(`${at}: crew sizes must satisfy 1 <= min <= standard <= max`);
      if (o.REQUIRED_SKILL_ID && !cat.skills[o.REQUIRED_SKILL_ID]) p.push(`${at}: unknown skill ${o.REQUIRED_SKILL_ID}`);
      if (!C.milestonesFor(cat, o.OPERATION_ID).length) p.push(`${at}: no milestone definitions exist for this operation (progress could not be recorded)`);
      if (o.QUALITY_GATE_REQUIRED === 'Y' && !ops.some(g => g.OPERATION_ID === o.GATE_OPERATION_ID && g.OPERATION_KIND === 'INSPECTION' && g.SEQUENCE_NO > o.SEQUENCE_NO)) p.push(`${at}: its quality gate ${o.GATE_OPERATION_ID} is not a later inspection in this route`);
    }
    if (o.OPERATION_KIND === 'INSPECTION') {
      const checks = Object.values(cat.ctq).filter(c => c.OPERATION_ID === o.OPERATION_ID && c.ACTIVE_FLAG !== 'N');
      if (!checks.length) p.push(`${at}: no CTQ checklist exists for this gate`);
      for (const c of checks.filter(c => c.ANSWER_TYPE === 'NUMERIC' && (c.MANDATORY_FLAG || 'Y') === 'Y')) {
        if (!specs.some(s => s.CHECK_ID === c.CHECK_ID) && !(c.DEFAULT_SPECS || []).length) p.push(`${at}: mandatory numeric check ${c.CHECK_ID} has no specification for ${product.PRODUCT_ID} (specs[] or specsFromProductId)`);
      }
    }
  });
  for (const s of specs) {
    if (!cat.ctq[s.CHECK_ID]) p.push(`spec for unknown check ${s.CHECK_ID}`);
    else if ((s.ANSWER_TYPE || cat.ctq[s.CHECK_ID].ANSWER_TYPE) === 'NUMERIC' && !(Number.isFinite(num(s.LOWER_LIMIT)) || Number.isFinite(num(s.UPPER_LIMIT)))) p.push(`spec ${s.CHECK_ID}: a numeric check needs a lower or upper limit`);
    else if (Number.isFinite(num(s.LOWER_LIMIT)) && Number.isFinite(num(s.UPPER_LIMIT)) && num(s.LOWER_LIMIT) > num(s.UPPER_LIMIT)) p.push(`spec ${s.CHECK_ID}: lower limit above upper limit`);
  }
  if (ops.length && ops[ops.length - 1].OPERATION_KIND !== 'INSPECTION') p.push('routing must end with an inspection gate (final release needs acceptance)');
  if (!materials.length) p.push('at least one material requirement is required');
  for (const m of materials) {
    if (!cat.materials[m.MATERIAL_ID]) p.push(`unknown material ${m.MATERIAL_ID}`);
    if (!ops.some(o => o.OPERATION_ID === m.CONSUMED_AT_OPERATION_ID)) p.push(`material ${m.MATERIAL_ID} is consumed at ${m.CONSUMED_AT_OPERATION_ID}, which is not in the routing`);
    if (!(m.QTY_PER_UNIT > 0)) p.push(`material ${m.MATERIAL_ID}: quantity per unit must be positive`);
  }
  return p;
}

async function createProduct(body, actor, { dryRun = false } = {}) {
  const cat = await C.catalog(true);
  const def = buildDefinition(cat, body || {});
  const problems = validateDefinition(cat, def);
  const summary = { productId: def.product.PRODUCT_ID, operations: def.ops.map(o => `${o.SEQUENCE_NO} ${o.OPERATION_ID} ${o.OPERATION_KIND}`), specs: def.specs.length, materials: def.materials.length };
  if (problems.length) throw E.unprocessable('PRODUCT_INCOMPLETE', `Product cannot be released: ${problems.length} problem(s)`, { problems, summary });
  if (dryRun) return { ok: true, dryRun: true, releasable: true, summary };
  const db = await getDb();
  const ds = config().datasetId;
  const now = new Date();
  const meta = { dataset_id: ds, ORIGIN: 'APP_INPUT', _origin: 'APP', CREATED_AT: now, CREATED_BY: actor, VERSION: 1 };
  await withTransaction(async (s) => {
    if (await db.collection('product_master').findOne({ dataset_id: ds, PRODUCT_ID: def.product.PRODUCT_ID }, { session: s })) throw E.conflict('PRODUCT_EXISTS', 'Product already exists');
    await db.collection('product_master').insertOne({ ...def.product, ACTIVE_FLAG: 'Y', STATUS: 'RELEASED', READINESS: { routing: true, standards: true, inspection: true, materials: true, checkedAt: now }, ...meta }, { session: s });
    await db.collection('routing_operations').insertMany(def.ops.map(o => ({ ...o, PRODUCT_ID: def.product.PRODUCT_ID, ROUTE_ID: def.product.ROUTE_ID, ROUTE_VERSION: def.product.ROUTE_VERSION, ...meta })), { session: s });
    if (def.specs.length) await db.collection('ctq_specifications').insertMany(def.specs.map((x, i) => { const { _id, _seed, ...rest } = x; return { ...rest, SPEC_ID: `SPEC-${def.product.PRODUCT_ID}-${String(i + 1).padStart(3, '0')}`, PRODUCT_ID: def.product.PRODUCT_ID, ...meta }; }), { session: s });
    await db.collection('material_requirements').insertMany(def.materials.map(m => ({ ...m, PRODUCT_ID: def.product.PRODUCT_ID, ...meta })), { session: s });
    await db.collection('audit_log').insertOne({ AUDIT_ID: `AUD-${Date.now().toString(36).toUpperCase()}${require('crypto').randomBytes(3).toString('hex').toUpperCase()}`, AT: now, ACTOR: actor || 'SYSTEM', ACTION: 'PRODUCT_CREATED', TARGET: def.product.PRODUCT_ID, DETAILS: summary, _origin: 'APP' }, { session: s });
  });
  C.invalidate();
  return { ok: true, releasable: true, summary };
}

async function listProducts() {
  const cat = await C.catalog(true);
  return Object.values(cat.products).map(p => {
    const ops = cat.routing.filter(r => r.PRODUCT_ID === p.PRODUCT_ID);
    return { productId: p.PRODUCT_ID, name: p.PRODUCT_NAME, drawing: `${p.DRAWING_REF || ''} rev ${p.DRAWING_REVISION || ''}`, origin: p._origin === 'APP' ? 'APP_INPUT' : 'SEED', status: p.STATUS || (p.ACTIVE_FLAG === 'Y' ? 'RELEASED' : 'INACTIVE'),
      routingOperations: ops.length, gates: ops.filter(o => o.OPERATION_KIND === 'INSPECTION').map(o => o.OPERATION_ID) };
  });
}

/** used by ORDER_CREATE: a product is orderable only with its own routing (never the generic fallback) and released status */
function orderable(cat, productId) {
  const p = cat.products[productId];
  if (!p) return `unknown product ${productId}`;
  if ((p.STATUS && p.STATUS !== 'RELEASED') || p.ACTIVE_FLAG === 'N') return `product ${productId} is not released`;
  if (!cat.routing.some(r => r.PRODUCT_ID === productId)) return `product ${productId} has no routing`;
  return null;
}

module.exports = { createProduct, listProducts, validateDefinition, buildDefinition, orderable };
