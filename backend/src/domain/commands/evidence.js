'use strict';
/* Evidence records (photos). Upload authorisation and verification run through the command bus so they are evented and idempotent. */
const crypto = require('crypto');
const { register } = require('../executor');
const E = require('../../lib/errors');
const EV = require('../../services/evidence');
const { config } = require('../../config/env');

register('EVIDENCE_REQUEST_UPLOAD', {
  perm: ['perform_quality_inspection', 'submit_self_check', 'report_incoming_defect'], noRecalc: true, agentAllowed: false,
  handler: async (tx, p) => {
    EV.validateRequest(p);
    let ins = null;
    if (p.inspectionId) {
      ins = await tx.must('sim_inspections', { INSPECTION_ID: p.inspectionId }, 'Inspection');
      if (ins.STATUS !== 'DRAFT') throw E.conflict('INSPECTION_SUBMITTED', 'Evidence can only be added to a draft inspection; submitted evidence is immutable');
      if (tx.actor.workerId !== ins.INSPECTOR_ID) throw E.forbidden('Only the inspector of this draft can add photos');
      if (p.unitId && p.unitId !== ins.UNIT_ID) throw E.bad('EVIDENCE_TANK_MISMATCH', 'Photo must belong to the inspected tank');
      if (p.checkId && ins.CHECKLIST_SNAPSHOT && !ins.CHECKLIST_SNAPSHOT.some(x => x.check.CHECK_ID === p.checkId)) throw E.bad('INVALID_CHECK', 'Question is not in this inspection checklist');
    }
    if (p.supersedesEvidenceId) {
      const old = await tx.must('sim_evidence', { EVIDENCE_ID: p.supersedesEvidenceId }, 'Evidence to retake');
      if (old.INSPECTION_ID) throw E.conflict('SUBMITTED_EVIDENCE', 'Submitted evidence is never replaced; add a new photo instead');
    }
    const id = await tx.nextId('EVD');
    const sig = EV.signUpload(id, tx.sid, p.mime);
    const doc = await tx.insert('sim_evidence', { EVIDENCE_ID: id, UNIT_ID: p.unitId || (ins && ins.UNIT_ID) || null, DRAFT_INSPECTION_ID: p.inspectionId || null, INSPECTION_ID: null, CHECK_ID: p.checkId || null,
      DEFECT_ID: p.defectId || null, WORKER_ID: tx.actor.workerId, DEVICE_ID: p.deviceId || 'BROWSER', CAPTURED_AT: p.capturedAt ? new Date(p.capturedAt) : tx.received, SERVER_RECEIVED_AT: tx.received,
      SIM_CAPTURED_AT: tx.now, MIME: p.mime, DECLARED_BYTES: Number(p.bytes), STORAGE_MODE: sig.mode, PUBLIC_ID: sig.publicId, LOCAL_TOKEN_HASH: sig.token ? crypto.createHash('sha256').update(sig.token).digest('hex') : null,
      TOKEN_EXPIRES_AT: new Date(Date.now() + 15 * 60000), UPLOAD_STATUS: 'PENDING_UPLOAD', SUPERSEDES_EVIDENCE_ID: p.supersedesEvidenceId || null, CAPTURE_METHOD: p.captureMethod || 'FILE', SYNTHETIC_FIXTURE: !!p.syntheticFixture });
    if (p.supersedesEvidenceId) await tx.update('sim_evidence', { EVIDENCE_ID: p.supersedesEvidenceId }, { SUPERSEDED_BY: id, UPLOAD_STATUS_NOTE: 'Retaken - kept for traceability' });
    await tx.event('EVIDENCE_UPLOAD_AUTHORISED', 'EVIDENCE', id, { UNIT_ID: doc.UNIT_ID, INSPECTION_ID: p.inspectionId || null, MODE: sig.mode });
    const { token, ...pub } = sig;
    return { evidenceId: id, upload: { ...pub, ...(token ? { token } : {}) } };
  },
});

register('EVIDENCE_MARK_VERIFIED', {
  trustedOnly: true, noRecalc: true, agentAllowed: false, perm: ['perform_quality_inspection', 'submit_self_check', 'report_incoming_defect'],
  handler: async (tx, p) => {
    const ev = await tx.must('sim_evidence', { EVIDENCE_ID: p.evidenceId }, 'Evidence');
    if (ev.WORKER_ID !== tx.actor.workerId) throw E.forbidden('Not your upload');
    if (ev.UPLOAD_STATUS === 'VERIFIED') return { evidence: ev, alreadyVerified: true };
    const status = p.result.ok ? 'VERIFIED' : 'FAILED';
    const doc = await tx.update('sim_evidence', { EVIDENCE_ID: ev.EVIDENCE_ID }, { UPLOAD_STATUS: status, VERIFIED_AT: p.result.ok ? tx.received : null, FAILURE_REASON: p.result.ok ? null : p.result.reason, ...(p.result.meta || {}), UPLOADED_AT: tx.received });
    await tx.event(p.result.ok ? 'EVIDENCE_VERIFIED' : 'EVIDENCE_UPLOAD_FAILED', 'EVIDENCE', ev.EVIDENCE_ID, { UNIT_ID: ev.UNIT_ID, REASON: p.result.ok ? null : p.result.reason });
    return { evidence: { evidenceId: doc.EVIDENCE_ID, status: doc.UPLOAD_STATUS, reason: doc.FAILURE_REASON, bytes: doc.BYTES, width: doc.WIDTH, height: doc.HEIGHT } };
  },
});

module.exports = {};
