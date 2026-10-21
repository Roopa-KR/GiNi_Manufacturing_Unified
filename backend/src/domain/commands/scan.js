'use strict';
/* Barcode / QR / typed scans of tank and station labels. The tank label is the permanent tank serial (TANK_SERIAL_NO, created
   when the batch is released); the station label is the WORKSTATION_ID. Every scan is stored (sim_scans + a TANK_SCANNED /
   STATION_SCANNED event), so it is part of the tank's traceability. A scan never moves a tank along its route: route
   progress still comes only from start / finish / inspection / release commands. */
const { register } = require('../executor');
const C = require('../catalog');
const E = require('../../lib/errors');

const PURPOSES = ['CONFIRM_TASK', 'CONFIRM_UNIT', 'CONFIRM_INSPECTION', 'LOCATE', 'LOOKUP'];
const METHODS = ['CAMERA', 'SCANNER_OR_TYPED'];
const CONFIRM_VALID_MIN = 60;          // a matching confirmation scan opens an inspection for this long
const norm = v => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 64);

async function resolveTank(tx, code) {
  if (!code) return null;
  return (await tx.one('sim_units', { TANK_SERIAL_NO: code })) || (await tx.one('sim_units', { UNIT_ID: code }));
}

register('SCAN_RECORD', {
  perm: ['operate_own_tasks', 'perform_quality_inspection', 'submit_self_check', 'operational_supervision', 'material_movements'],
  agentAllowed: false,
  handler: async (tx, p) => {
    const purpose = PURPOSES.includes(p.purpose) ? p.purpose : 'LOOKUP';
    const method = METHODS.includes(p.method) ? p.method : 'SCANNER_OR_TYPED';
    const code = norm(p.code);
    if (code.length < 3) throw E.bad('INVALID_CODE', 'Scan the label or type at least 3 characters of the serial / station ID');
    const cat = await C.catalog();
    const stationCode = norm(p.stationCode);
    const tank = await resolveTank(tx, code);
    const station = !tank && cat.stations[code] ? cat.stations[code] : null;
    const atStation = stationCode ? cat.stations[stationCode] || null : null;
    if (stationCode && !atStation) throw E.bad('UNKNOWN_STATION', `No station ${stationCode} - scan the station label`);

    let expected = null, task = null;
    if (purpose === 'CONFIRM_TASK') {
      task = await tx.must('sim_tasks', { TASK_ID: p.taskId }, 'Task');
      if (tx.actor.workerId && task.WORKER_ID !== tx.actor.workerId) throw E.forbidden('You can only confirm your own task');
      expected = await tx.must('sim_units', { UNIT_ID: task.UNIT_ID }, 'Tank');
    } else if (purpose === 'CONFIRM_INSPECTION' || purpose === 'CONFIRM_UNIT') {
      expected = await tx.must('sim_units', { UNIT_ID: p.unitId }, 'Tank');
    }
    const result = expected ? (tank ? (tank.UNIT_ID === expected.UNIT_ID ? 'MATCH' : 'WRONG_TANK') : (station ? 'STATION_NOT_TANK' : 'UNKNOWN'))
      : (tank ? 'FOUND' : station ? 'STATION' : 'UNKNOWN');
    if (purpose === 'LOCATE' && !tank) throw E.bad('TANK_REQUIRED', 'Scan the tank label first, then the station label');

    const scanId = await tx.nextId('SCN');
    const workerId = tx.actor.workerId || null;
    const doc = await tx.insert('sim_scans', {
      SCAN_ID: scanId, SCANNED_AT: tx.now, KNOWN_AT: tx.now, WORKER_ID: workerId, LOGIN_ID: tx.actor.loginId || null, METHOD: method, PURPOSE: purpose,
      CODE: code, RESULT: result, UNIT_ID: tank ? tank.UNIT_ID : null, TANK_SERIAL_NO: tank ? tank.TANK_SERIAL_NO || null : null,
      STATION_ID: station ? station.WORKSTATION_ID : (atStation ? atStation.WORKSTATION_ID : null), WORK_CENTER_ID: (station || atStation || {}).WORK_CENTER_ID || (tank ? tank.CURRENT_WORK_CENTER_ID || null : null),
      EXPECTED_UNIT_ID: expected ? expected.UNIT_ID : null, TASK_ID: task ? task.TASK_ID : null, DEVICE: p.device ? String(p.device).slice(0, 80) : null,
    });
    if (tank) {
      await tx.event('TANK_SCANNED', 'UNIT', tank.UNIT_ID, { SCAN_ID: scanId, PURPOSE: purpose, RESULT: result, METHOD: method, STATION_ID: doc.STATION_ID, WORKER_ID: workerId, EXPECTED_UNIT_ID: doc.EXPECTED_UNIT_ID });
      const set = { LAST_SCAN_ID: scanId, LAST_SCANNED_AT: tx.now, LAST_SCANNED_BY: workerId || tx.actor.loginId || null };
      // location recorded by scanning (shown separately from the route location; it does not move the tank on its route)
      if (purpose === 'LOCATE' && atStation) Object.assign(set, { LAST_SCANNED_STATION_ID: atStation.WORKSTATION_ID, LAST_SCANNED_WORK_CENTER_ID: atStation.WORK_CENTER_ID || null, LAST_SCANNED_STATION_AT: tx.now });
      await tx.update('sim_units', { UNIT_ID: tank.UNIT_ID }, set);
    } else if (station) {
      await tx.event('STATION_SCANNED', 'STATION', station.WORKSTATION_ID, { SCAN_ID: scanId, PURPOSE: purpose, RESULT: result, METHOD: method, WORKER_ID: workerId });
    } else if (expected) {
      await tx.event('TANK_SCAN_MISMATCH', 'UNIT', expected.UNIT_ID, { SCAN_ID: scanId, PURPOSE: purpose, RESULT: result, CODE: code, WORKER_ID: workerId });
    }
    if (expected && result !== 'MATCH' && tank) await tx.event('TANK_SCAN_MISMATCH', 'UNIT', expected.UNIT_ID, { SCAN_ID: scanId, PURPOSE: purpose, RESULT: result, SCANNED_UNIT_ID: tank.UNIT_ID, WORKER_ID: workerId });
    return {
      scan: { scanId, result, purpose, code, unitId: doc.UNIT_ID, serial: doc.TANK_SERIAL_NO, stationId: doc.STATION_ID, expectedUnitId: doc.EXPECTED_UNIT_ID, at: tx.now },
      tank: tank ? { unitId: tank.UNIT_ID, serial: tank.TANK_SERIAL_NO, state: tank.STATE, workCenterId: tank.CURRENT_WORK_CENTER_ID || null, workstationId: tank.CURRENT_WORKSTATION_ID || null } : null,
      station: station ? { workstationId: station.WORKSTATION_ID, name: station.WORKSTATION_NAME || null, workCenterId: station.WORK_CENTER_ID || null } : null,
    };
  },
});

/** fresh factory, "scan required" switched on: humans need a matching scan before starting work / an inspection (agents never scan) */
function scanRequired(tx, what) {
  const r = tx.session.FACTORY_SESSION && tx.session.SCAN_REQUIRED;
  return !!(r && r[what]) && tx.actor.kind === 'HUMAN';
}
/** before work starts: the person starting their own work needs a matching scan of that tank (for this task, or of the tank
    within the last hour - e.g. before joining a crew). Work started for someone by a supervisor is not blocked. */
async function assertTaskScanned(tx, task, worker) {
  if (!scanRequired(tx, 'START_WORK')) return;
  if (tx.actor.workerId && worker && tx.actor.workerId !== worker.WORKER_ID) return;
  const since = new Date(tx.now.getTime() - CONFIRM_VALID_MIN * 60000);
  const ok = (await tx.one('sim_scans', { TASK_ID: task.TASK_ID, PURPOSE: 'CONFIRM_TASK', RESULT: 'MATCH' }))
    || (await tx.one('sim_scans', { EXPECTED_UNIT_ID: task.UNIT_ID, WORKER_ID: task.WORKER_ID, RESULT: 'MATCH', SCANNED_AT: { $gte: since } }));
  if (!ok) throw E.conflict('SCAN_REQUIRED', 'Scan the tank label first (Confirm tank) - this factory requires a scan before work starts', { taskId: task.TASK_ID, unitId: task.UNIT_ID });
}
/** before an inspection starts: a matching scan of the tank by the inspector within the last hour */
async function assertInspectionScanned(tx, unitId, inspectorId) {
  if (!scanRequired(tx, 'INSPECTION')) return;
  if (tx.actor.workerId && tx.actor.workerId !== inspectorId) return;
  const since = new Date(tx.now.getTime() - CONFIRM_VALID_MIN * 60000);
  const ok = await tx.one('sim_scans', { EXPECTED_UNIT_ID: unitId, WORKER_ID: inspectorId, RESULT: 'MATCH', SCANNED_AT: { $gte: since } });
  if (!ok) throw E.conflict('SCAN_REQUIRED', 'Scan the tank label first - this factory requires a scan before an inspection starts', { unitId });
}

module.exports = { assertTaskScanned, assertInspectionScanned, CONFIRM_VALID_MIN };
