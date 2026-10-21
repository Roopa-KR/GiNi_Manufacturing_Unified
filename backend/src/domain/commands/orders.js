'use strict';
/*
 * ORDER_CREATE: validated entry of a new work order with its lines and production plan inside ONE session (the branch where it is
 * entered). Rows are written to the same collections the engines read (production_orders, order_lines, production_batches,
 * production_plan) tagged with SESSION_ID, so other sessions/branches never see them, plus sim_plan_releases so the batches release
 * through the normal BATCH_RELEASE flow. Products must be released with their own routing (masterData.orderable).
 */
const { register } = require('../executor');
const C = require('../catalog');
const M = require('../masterData');
const E = require('../../lib/errors');
const { config } = require('../../config/env');

register('ORDER_CREATE', {
  perm: ['operational_supervision', 'scenario_control'], agentAllowed: false,
  handler: async (tx, p) => {
    const cat = await C.catalog();          // warmed before the transaction; never reloaded inside it
    const ds0 = config().datasetId;
    // a product created moments ago may not be in this instance's cache yet: read it inside the transaction
    for (const pid of [...new Set((p.lines || []).map(l => l.productId).filter(Boolean))]) {
      if (cat.products[pid]) continue;
      const prod = await tx.db.collection('product_master').findOne({ dataset_id: ds0, PRODUCT_ID: pid }, { session: tx.s });
      if (prod) {
        const ops = await tx.db.collection('routing_operations').find({ dataset_id: ds0, PRODUCT_ID: pid }, { session: tx.s }).toArray();
        cat.products[pid] = prod; cat.routing.push(...ops);
        C.invalidate();
      }
    }
    const fresh = !!tx.session.FACTORY_SESSION;
    const { localToUtc } = require('../../lib/time');
    // a customer / work-order reference is unique per session (a second submission of the same order is refused); without one the
    // generated WO number is the reference and the Idempotency-Key protects against double submission. Due times may be plant-local.
    const ref = p.customerOrderRef ? String(p.customerOrderRef).trim().slice(0, 40) : null;
    if (ref && await tx.db.collection('production_orders').findOne({ SESSION_ID: tx.sid, CUSTOMER_ORDER_REF: ref }, { session: tx.s })) throw E.conflict('DUPLICATE_ORDER', `An order with reference ${ref} already exists`);
    for (const l of p.lines || []) {
      if (!l.dueAt && l.dueLocal && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(l.dueLocal)) l.dueAt = localToUtc(l.dueLocal.slice(0, 10), l.dueLocal.slice(11, 16)).toISOString();
      for (const b of l.batches || []) if (!b.plannedReleaseAt && b.plannedReleaseLocal && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b.plannedReleaseLocal)) b.plannedReleaseAt = localToUtc(b.plannedReleaseLocal.slice(0, 10), b.plannedReleaseLocal.slice(11, 16)).toISOString();
    }
    const lines = Array.isArray(p.lines) ? p.lines : [];
    if (!lines.length || lines.length > 20) throw E.bad('LINES_REQUIRED', 'An order needs 1-20 lines');
    const priority = p.priority || 'NORMAL';
    if (!['NORMAL', 'HIGH'].includes(priority)) throw E.bad('INVALID_PRIORITY', 'priority must be NORMAL or HIGH');
    const problems = [];
    const parsed = lines.map((l, i) => {
      const at = `line ${i + 1}`;
      const why = M.orderable(cat, l.productId);
      if (why) problems.push(`${at}: ${why}`);
      const qty = Number(l.requiredGoodQty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 200) problems.push(`${at}: requiredGoodQty must be a whole number 1-200`);
      if (fresh && lines.filter(x => x.productId === l.productId).length > 1) problems.push(`${at}: product ${l.productId} appears on more than one line - use one line per product`);
      const due = new Date(l.dueAt);
      if (!l.dueAt || isNaN(due)) problems.push(`${at}: dueAt must be an ISO date-time`);
      else if (due <= tx.now) problems.push(`${at}: dueAt must be after the current simulated time ${tx.now.toISOString()}`);
      const batches = (l.batches && l.batches.length ? l.batches : [{ qty }]).map(b => ({ qty: Number(b.qty), releaseAt: b.plannedReleaseAt ? new Date(b.plannedReleaseAt) : tx.now }));
      if (batches.some(b => !Number.isInteger(b.qty) || b.qty < 1)) problems.push(`${at}: batch quantities must be positive whole numbers`);
      if (batches.reduce((s, b) => s + b.qty, 0) !== qty) problems.push(`${at}: planned batch quantities must add up to requiredGoodQty (${qty})`);
      if (batches.some(b => isNaN(b.releaseAt) || b.releaseAt < tx.now || (!isNaN(due) && b.releaseAt >= due))) problems.push(`${at}: planned releases must be between now and the due time`);
      return { productId: l.productId, qty, due, batches, routeVersion: (cat.products[l.productId] || {}).ROUTE_VERSION || null };
    });
    if (problems.length) throw E.unprocessable('ORDER_INVALID', `Order rejected: ${problems.length} problem(s)`, { problems });
    const ds = config().datasetId;
    const n = (await tx.nextId('WO')).split('-').pop();
    const orderId = `WO-${tx.session.SHORT_ID}-${n}`;
    const tag = { SESSION_ID: tx.sid, RUN_ID: tx.session.SOURCE_RUN_ID, dataset_id: ds, ORIGIN: 'APP_INPUT', _origin: 'APP', KNOWN_AT: tx.now, CREATED_AT: tx.received, CREATED_SIM_AT: tx.now, CREATED_BY: tx.actor.loginId || tx.actor.workerId };
    const maxDue = new Date(Math.max(...parsed.map(l => l.due.getTime())));
    const s = { session: tx.s };
    await tx.db.collection('production_orders').insertOne({ ...tag, ORDER_ID: orderId, ORDER_TYPE: 'CUSTOMER_WORK_ORDER', CUSTOMER_ID: p.customerId || (fresh ? null : 'CUST-DEMO'), CUSTOMER_NAME: p.customerName || null,
      CUSTOMER_ORDER_REF: ref, SITE_ID: tx.session.SITE_ID || null, STATUS: 'OPEN', PRIORITY: priority, RELEASE_AT: tx.now, DUE_AT: maxDue,
      REQUIRED_GOOD_QTY: parsed.reduce((a, l) => a + l.qty, 0), ORDER_LINE_COUNT: parsed.length, NOTE: p.note || null }, s);
    const out = [];
    for (let i = 0; i < parsed.length; i++) {
      const l = parsed[i];
      const lineId = `${orderId}-L${i + 1}`;
      await tx.db.collection('order_lines').insertOne({ ...tag, ORDER_ID: orderId, ORDER_LINE_ID: lineId, LINE_NO: i + 1, PRODUCT_ID: l.productId, REQUIRED_GOOD_QTY: l.qty, RELEASE_AT: tx.now, DUE_AT: l.due, PLANNED_BATCH_COUNT: l.batches.length, ROUTE_VERSION: l.routeVersion,
        QUANTITY_BASIS: 'Required quantity = accepted good tanks (route complete), not manufacturing attempts' }, s);
      const bids = [];
      for (const b of l.batches) {
        const bid = `PB-${tx.session.SHORT_ID}-${(await tx.nextId('PB')).split('-').pop()}`;
        await tx.db.collection('production_batches').insertOne({ ...tag, BATCH_ID: bid, ORDER_ID: orderId, ORDER_LINE_ID: lineId, PRODUCT_ID: l.productId, PLANNED_QTY: b.qty, BATCH_STATUS: 'PLANNED', PARENT_BATCH_ID: null,
          BATCH_TYPE: 'PRODUCTION_BATCH (not a material lot, equipment load or shipment)', RELEASE_AT: b.releaseAt, TARGET_FINISH_AT: l.due }, s);
        await tx.db.collection('production_plan').insertOne({ ...tag, PLAN_ID: `PLN-${bid}`, BATCH_ID: bid, ORDER_LINE_ID: lineId, PLANNED_QTY: b.qty, PLANNED_START_AT: b.releaseAt, TARGET_FINISH_AT: l.due, PLAN_STATUS: 'PLANNED' }, s);
        await tx.insert('sim_plan_releases', { BATCH_ID: bid, ORDER_LINE_ID: lineId, ORDER_ID: orderId, PRODUCT_ID: l.productId, PLANNED_QTY: b.qty, PLANNED_RELEASE_AT: b.releaseAt, TARGET_FINISH_AT: l.due, RELEASED: false, ORIGIN: 'APP_INPUT' });
        bids.push(bid);
      }
      out.push({ orderLineId: lineId, productId: l.productId, requiredGoodQty: l.qty, dueAt: l.due, batches: bids });
    }
    await tx.event('ORDER_CREATED', 'ORDER', orderId, { LINES: out.map(l => ({ ORDER_LINE_ID: l.orderLineId, PRODUCT_ID: l.productId, QTY: l.requiredGoodQty, BATCHES: l.batches })) });
    return { orderId, customerOrderRef: ref, lines: out, note: 'Required quantity means accepted good tanks, not total manufacturing attempts.' };
  },
});
