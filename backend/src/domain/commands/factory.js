'use strict';
/* Fresh-factory commands that have no synthetic equivalent: explicit stock receipts (inventory is never unlimited). */
const { register } = require('../executor');
const E = require('../../lib/errors');

register('MATERIAL_RECEIPT', {
  perm: ['material_movements', 'factory_configuration'], agentAllowed: false,
  handler: async (tx, p) => {
    if (!tx.session.FACTORY_SESSION) throw E.conflict('FACTORY_ONLY', 'Stock of the synthetic demo comes from its history; use MATERIAL_DELIVERY there');
    const m = await tx.must('sim_materials', { MATERIAL_ID: p.materialId }, 'Material (configure it first)');
    const qty = Number(p.qty);
    if (!(qty > 0) || qty > 1e6) throw E.bad('INVALID_QTY', 'Received quantity must be a positive number');
    const lot = p.lotId ? String(p.lotId).trim().slice(0, 40) : null;
    const master = await tx.db.collection('material_master').findOne({ dataset_id: tx.ds, MATERIAL_ID: m.MATERIAL_ID }, { session: tx.s });
    if (master && master.LOT_TRACKED === 'Y' && !lot) throw E.bad('LOT_REQUIRED', `${m.MATERIAL_ID} is lot-tracked: enter the lot number`);
    if (lot && (m.LOTS || []).some(l => l.LOT_ID === lot)) throw E.conflict('DUPLICATE_LOT', `Lot ${lot} of ${m.MATERIAL_ID} was already received`);
    const doc = await tx.update('sim_materials', { MATERIAL_ID: m.MATERIAL_ID }, { ON_HAND_QTY: Math.round((Number(m.ON_HAND_QTY || 0) + qty) * 1000) / 1000, LAST_RECEIPT_AT: tx.now },
      lot ? { push: { LOTS: { LOT_ID: lot, QTY: qty, RECEIVED_AT: tx.now, RECEIVED_BY: tx.actor.loginId || tx.actor.workerId } } } : {});
    await tx.event('MATERIAL_RECEIVED', 'MATERIAL', m.MATERIAL_ID, { QTY: qty, UOM: m.UOM || null, LOT_ID: lot, MOVEMENT_TYPE: p.initialStock ? 'INITIAL_STOCK' : 'RECEIPT', NOTE: p.note || null });
    return { material: doc };
  },
});
