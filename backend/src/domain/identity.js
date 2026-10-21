'use strict';
/*
 * Tank identities of the fresh factory. UNIT_ID and TANK_SERIAL_NO come from the session's atomic counters inside the command
 * transaction (sim_sessions.COUNTERS), so two concurrent releases can never produce the same identity; a unique index
 * (SESSION_ID, TANK_SERIAL_NO) is the second line of defence (scripts/factory-init.js).
 *   UNIT_ID         TNK-FACTORY-00001   (internal, never reused)
 *   TANK_SERIAL_NO  <SERIAL_PREFIX>-<YY>-00001   (shown to people; prefix from the factory settings)
 */
async function newTankIdentity(tx) {
  const unitId = await tx.nextId('TNK');
  const n = unitId.split('-').pop();
  const prefix = tx.session.SERIAL_PREFIX || 'TANK';
  const yy = String(new Date(tx.now).getUTCFullYear()).slice(-2);
  return { unitId, serial: `${prefix}-${yy}-${n}` };
}
module.exports = { newTankIdentity };
