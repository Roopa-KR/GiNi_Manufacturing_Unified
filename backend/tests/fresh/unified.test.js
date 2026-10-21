'use strict';
// Run after scenario.test.js on its disposable database. No substitute database.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Client, API } = require('../integration/helpers');
const SID = 'S-FACTORY', key = () => `unified-${crypto.randomUUID()}`;
const ok = (r, s = 201) => { assert.equal(r.status, s, JSON.stringify(r.data)); return r.data; };
test('unified factory regression: identity, administration, inspector allocation and evidence', async t => {
 const mc = new MongoClient(process.env.MONGODB_URI); await mc.connect(); t.after(() => mc.close());
 const db = mc.db(process.env.MONGODB_DB_NAME), admin = new Client('admin'); await admin.login(process.env.ADMIN_LOGIN || 'admin', process.env.ADMIN_PASSWORD);
 const cmd = (c, type, p) => c.cmd(SID, type, p, key());
 await t.test('five demanded tanks generate five different immutable physical units in two batches', async () => {
  const o = ok(await cmd(admin, 'ORDER_CREATE', { customerOrderRef: 'UNIFIED-FIVE', lines: [{ productId: 'TANK-A', requiredGoodQty: 5, dueAt: new Date(Date.now()+86400000).toISOString(), batches: [{qty:2},{qty:3}] }] })).result;
  for(const batchId of o.lines[0].batches) ok(await cmd(admin,'BATCH_RELEASE',{batchId}));
  const units = await db.collection('sim_units').find({SESSION_ID:SID,ORDER_ID:o.orderId}).toArray();
  assert.equal(units.length,5);assert.equal(new Set(units.map(u=>u.UNIT_ID)).size,5);assert.equal(new Set(units.map(u=>u.TANK_SERIAL_NO)).size,5);
  assert.equal(new Set(units.map(u=>u.BATCH_ID)).size,2);
 });
 await t.test('unused worker deletion removes account and projections; retries are idempotent', async () => {
  const w = ok(await admin.post('/api/admin/workers',{firstName:'Emily',lastName:'Carter',workerRole:'PRODUCTION_OPERATOR',homeWorkCenterId:'FAB',shiftCode:'D',initialPin:'654321',loginId:'emily.unused',qualifications:[]},key()));
  const k=key(),url=`/api/admin/workers/${w.workerId}/delete`,body={confirmWorkerId:w.workerId};
  ok(await admin.post(url,body,k),200);assert.equal(ok(await admin.post(url,body,k),200).replayed,true);
  assert.equal(await db.collection('worker_master').countDocuments({WORKER_ID:w.workerId}),0);assert.equal(await db.collection('accounts').countDocuments({worker_id:w.workerId}),0);assert.equal(await db.collection('sim_workers').countDocuments({WORKER_ID:w.workerId}),0);
 });
 const ana=await db.collection('worker_master').findOne({FIRST_NAME:'Ana'}), caraAcct=await db.collection('accounts').findOne({login_id:'cara.test'});
 await t.test('used worker deletion is blocked and invalid home station rejected',async()=>{
  const acct=await db.collection('accounts').findOne({login_id:'ana.test'});
  ok(await admin.post(`/api/admin/workers/${acct.worker_id}/delete`,{confirmWorkerId:acct.worker_id},key()),409);
  ok(await admin.req('PATCH',`/api/admin/workers/${acct.worker_id}`,{homeWorkCenterId:'NOT-A-STATION'},{'idempotency-key':key()}),400);
 });
 await t.test('inspector allocation persists, is visible, and unauthorized inspector cannot start',async()=>{
  const tank=await db.collection('sim_units').findOne({SESSION_ID:SID,STATE:'WORK_COMPLETED_AWAITING_INSPECTION'});assert.ok(tank,'scenario must leave a replacement awaiting inspection');
  const w=ok(await admin.post('/api/admin/workers',{firstName:'Jacob',lastName:'Scott',workerRole:'QUALITY_INSPECTOR',homeWorkCenterId:'FIN',shiftCode:'D',initialPin:'765432',loginId:'jacob.quality',qualifications:[{skillId:'SK-QC'}]},key()));
  ok(await cmd(admin,'INSPECTION_ASSIGN',{unitId:tank.UNIT_ID,inspectorId:w.workerId}));
  const jacob=new Client('operator');await jacob.login('jacob.quality','765432');ok(await cmd(jacob,'CLOCK_IN',{}));
  const home=ok(await jacob.get(`/api/sessions/${SID}/me/home`),200);assert.ok(home.nextActions.some(a=>a.unitId===tank.UNIT_ID));
  const cara=new Client('operator');await cara.login('cara.test','864202');ok(await cmd(cara,'INSPECTION_START',{unitId:tank.UNIT_ID}),409);
  // Create a new checklist version requiring evidence; preserve prior attempts.
  ok(await admin.req('PUT','/api/factory/checklists/QG10',{version:'2.0',checks:[{checkId:'QG10-PHOTO',question:'Weld acceptable?',inputType:'YES_NO',failureAnswer:'No',mandatory:true,photoRequired:true}]},{'idempotency-key':key()}),200);
  const ins=ok(await cmd(jacob,'INSPECTION_START',{unitId:tank.UNIT_ID})).result.inspection;
  assert.equal(ins.INSPECTOR_ID,w.workerId);assert.equal(ins.CHECKLIST_VERSION,'2.0');
  const result=await cmd(jacob,'INSPECTION_SUBMIT',{inspectionId:ins.INSPECTION_ID,answers:{'QG10-PHOTO':{answer:'Yes'}},release:true});
  ok(result,409);assert.equal(result.data.error.code,'EVIDENCE_REQUIRED');
  assert.equal((await db.collection('sim_inspections').findOne({INSPECTION_ID:ins.INSPECTION_ID})).STATUS,'DRAFT');
  ok(await cmd(jacob,'INSPECTION_SUBMIT',{inspectionId:ins.INSPECTION_ID,answers:{'QG10-PHOTO':{answer:'Yes'}},evidenceIds:['NONEXISTENT'],release:true}),400);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const signed=ok(await jacob.post(`/api/sessions/${SID}/evidence/sign`,{inspectionId:ins.INSPECTION_ID,unitId:tank.UNIT_ID,checkId:'QG10-PHOTO',mime:'image/png',bytes:png.length,width:1,height:1},key()));
  const upload=signed.upload;
  assert.ok(upload && upload.uploadUrl,JSON.stringify(signed));
  const up=await fetch(API+upload.uploadUrl,{method:'PUT',headers:{'content-type':'image/png',origin:process.env.FRONTEND_URL},body:png});
  assert.equal(up.status,200,await up.text());
  const evidenceId=signed.evidenceId;
  ok(await jacob.post(`/api/sessions/${SID}/evidence/${evidenceId}/complete`,{},key()),200);
  ok(await cmd(jacob,'INSPECTION_SUBMIT',{inspectionId:ins.INSPECTION_ID,answers:{'QG10-PHOTO':{answer:'Yes'}},evidenceIds:[evidenceId],release:true}));
  const evidence=await db.collection('sim_evidence').findOne({EVIDENCE_ID:evidenceId});
  assert.equal(evidence.INSPECTION_ID,ins.INSPECTION_ID);assert.equal(evidence.UPLOAD_STATUS,'VERIFIED');
  assert.equal((await db.collection('sim_units').findOne({UNIT_ID:tank.UNIT_ID})).STATE,'QUEUED');

 });
});
