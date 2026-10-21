import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, usePoll, useRouter, useToast } from '../lib/hooks.jsx';
import { API_BASE, ApiError, api, command, newKey } from '../lib/api.js';
import { hhmm, human } from '../lib/fmt.js';
import { Banner, Busy, Card, ErrorState, Icon, Loading, Modal, Status } from '../components/ui.jsx';
import { TankLink } from '../components/PassportSections.jsx';
import { ScanButton } from '../components/Scan.jsx';

const draftKey = (id) => `gini_draft_${id}`;
const loadLocal = (id) => { try { return JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); } catch (e) { return null; } };
const saveLocal = (id, v) => { try { localStorage.setItem(draftKey(id), JSON.stringify(v)); } catch (e) { /* storage unavailable: server draft still saved */ } };
const clearLocal = (id) => { try { localStorage.removeItem(draftKey(id)); } catch (e) { /* ignore */ } };

/** client-side preview of a numeric reading against the synthetic limits (the server re-evaluates on submit) */
function judge(v, s) {
  if (v === '' || v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  const lo = s.lower, hi = s.upper;
  return (lo === null || lo === undefined || n >= lo) && (hi === null || hi === undefined || n <= hi) ? 'ok' : 'bad';
}

export default function Inspection({ id }) {
  const { session, user } = useApp();
  const { navigate } = useRouter();
  const toast = useToast();
  const sid = session && session.sessionId;
  const { data, error, loading, reload } = usePoll(sid ? `/sessions/${sid}/inspections/${encodeURIComponent(id)}` : null, { interval: 15000 });
  const [answers, setAnswers] = useState(null);
  const [comment, setComment] = useState('');
  const [evidence, setEvidence] = useState([]);     // [{evidenceId, checkId, status, previewUrl, supersedes}]
  const [sync, setSync] = useState('idle');         // idle | pending | saving | saved | conflict | offline
  const [conflict, setConflict] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [release, setRelease] = useState(true);
  const [camera, setCamera] = useState(null);
  const version = useRef(null);
  const saveTimer = useRef(null);

  // initialise from local pending draft (offline work) or the server draft
  useEffect(() => {
    if (!data || answers !== null) return;
    const ins = data.inspection;
    version.current = ins.version;
    const local = loadLocal(id);
    if (local && ins.status === 'DRAFT' && local.dirty) {
      setAnswers(local.answers || {}); setComment(local.comment || ''); setSync('pending');
      if (local.baseVersion !== ins.version) setConflict({ server: ins.draftAnswers || {}, serverVersion: ins.version });
    } else {
      setAnswers(ins.draftAnswers || ins.answers || {}); setComment(ins.comment || '');
    }
    setEvidence((data.evidence || []).filter(e => !e.supersededBy).map(e => ({ evidenceId: e.evidenceId, checkId: e.checkId, status: e.status, synthetic: e.synthetic })));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = !data || data.inspection.status !== 'DRAFT' || data.inspection.inspectorId !== user.workerId || (data.session && data.session.mode === 'REPLAY');

  const persist = useCallback(async (a, c, ev) => {
    if (readOnly) return;
    setSync('saving');
    try {
      const r = await command(sid, 'INSPECTION_SAVE_DRAFT', { inspectionId: id, answers: a, comment: c, evidenceIds: ev.filter(e => e.status === 'VERIFIED').map(e => e.evidenceId), expectedVersion: version.current }, newKey('draft'));
      version.current = r.result.inspection.VERSION;
      saveLocal(id, { answers: a, comment: c, baseVersion: version.current, dirty: false });
      setSync('saved');
    } catch (e) {
      if (e.code === 'VERSION_CONFLICT') { setConflict({ server: (e.details && e.details.serverAnswers) || {}, serverVersion: e.details && e.details.current }); setSync('conflict'); }
      else if (e.status === 0) setSync('offline');
      else { setSync('pending'); toast(e.message, 'bad'); }
    }
  }, [id, sid, readOnly, toast]);

  const change = (next, nextComment = comment, ev = evidence) => {
    setAnswers(next);
    saveLocal(id, { answers: next, comment: nextComment, baseVersion: version.current, dirty: true });
    setSync('pending');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(next, nextComment, ev), 1500);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  useEffect(() => {
    const on = () => { if (sync === 'offline' || sync === 'pending') persist(answers, comment, evidence); };
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [sync, answers, comment, evidence, persist]);

  const list = data ? data.checklist : [];
  const stats = useMemo(() => {
    if (!answers) return null;
    let answered = 0, fail = 0, missing = 0;
    for (const c of list) {
      const a = answers[c.checkId] || {};
      let failsHere = false;
      if (c.answerType === 'YES_NO') {
        if (a.answer) { answered++; if (a.answer === c.failureAnswer) { fail++; failsHere = true; } } else if (c.mandatory) missing++;
      } else {
        let all = true, anyBad = false;
        for (const s of c.specs) for (let i = 0; i < (s.readings || 1); i++) { const v = ((a.values || {})[s.position] || [])[i]; const j = judge(v, s); if (j === null) all = false; if (j === 'bad') anyBad = true; }
        if (all && c.specs.length) answered++; else if (c.mandatory) missing++;
        if (anyBad) { fail++; failsHere = true; }
      }
      const hasPhoto = evidence.some(e => e.checkId === c.checkId && e.status === 'VERIFIED');
      if (c.evidenceRequired === 'Y' && !hasPhoto) { missing++; }
      else if (c.photoOnFail && failsHere && !hasPhoto) { missing++; }
    }
    return { answered, fail, missing, total: list.length };
  }, [answers, list, evidence]);

  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const ins = data.inspection;
  const canRelease = (user.permissions || []).includes('release_gate') && ins.kind === 'INDEPENDENT';
  const pendingUploads = evidence.filter(e => e.status !== 'VERIFIED' && e.status !== 'FAILED');

  const submit = async () => {
    setSubmitting(true);
    try {
      clearTimeout(saveTimer.current);
      const r = await command(sid, 'INSPECTION_SUBMIT', { inspectionId: id, expectedVersion: version.current, answers, comment, evidenceIds: evidence.filter(e => e.status === 'VERIFIED').map(e => e.evidenceId), release: canRelease && release });
      clearLocal(id);
      setResult(r.result);
      toast(r.result.result === 'PASS' ? (r.result.release ? 'Passed and released to the next operation' : 'Passed - pending release') : r.result.result === 'FAIL' ? 'Failed - the tank is on quality hold' : 'Incomplete - not a failure; the tank cannot be released', r.result.result === 'FAIL' ? 'bad' : 'ok', 7000);
      reload();
    } catch (e) {
      if (e.code === 'VERSION_CONFLICT') setConflict({ server: (e.details && e.details.serverAnswers) || {}, serverVersion: e.details && e.details.current });
      toast(e.message, 'bad', 7000);
    } finally { setSubmitting(false); }
  };

  return (
    <div className="page">
      <div className="row between">
        <button className="btn ghost" onClick={() => navigate('/')}><Icon name="back" />Work</button>
        <SyncBadge sync={sync} readOnly={readOnly} />
      </div>
      <Card hero title={<span className="row" style={{ gap: 8 }}><Icon name="quality" />{ins.kind === 'SELF_CHECK' ? 'Post-task self-check' : 'Gate inspection'} {ins.gate}</span>} actions={<>{ins.status === 'DRAFT' && <ScanButton className="btn sm" label="Confirm tank" expect={{ unitId: ins.unitId, serial: ins.serial }} purpose="CONFIRM_INSPECTION" />}<Status value={ins.status} lg /></>}>
        <div className="grid two">
          <dl className="kv">
            <dt>Tank</dt><dd><TankLink id={ins.unitId}>{ins.serial || ins.unitId}</TankLink></dd>
            <dt>Attempt</dt><dd>#{ins.attemptNo || 1}{ins.reinspectionOf ? ` (reinspection of ${ins.reinspectionOf})` : ''}</dd>
            <dt>Inspector</dt><dd>{ins.inspector} ({ins.inspectorId})</dd>
            <dt>Checklist</dt><dd>version {ins.checklistVersion || '1.0'} · {list.length} checks</dd>
          </dl>
          {stats && <div className="stack">
            <div className="row between"><span className="muted small">Answered</span><b className="num">{stats.answered}/{stats.total}</b></div>
            <div className="bar ok"><i style={{ width: `${(stats.answered / Math.max(1, stats.total)) * 100}%` }} /></div>
            <div className="row">{stats.fail > 0 && <Status value="FAIL" label={`${stats.fail} out of limits / failure answer`} />}{stats.missing > 0 && <Status value="INCOMPLETE" label={`${stats.missing} mandatory missing`} />}</div>
          </div>}
        </div>
        <Banner tone="warn">{data.limitsNote}</Banner>
      </Card>

      {conflict && (
        <Banner tone="bad"><b>The inspection changed elsewhere</b> (another window or device). <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => { version.current = conflict.serverVersion; setConflict(null); persist(answers, comment, evidence); }}>Keep my answers</button> <button className="btn sm" onClick={() => { version.current = conflict.serverVersion; setAnswers(conflict.server); clearLocal(id); setConflict(null); setSync('saved'); }}>Use the saved version</button></Banner>
      )}
      {result && <ResultBanner r={result} />}
      {ins.status === 'SUBMITTED' && !result && <Banner tone={ins.result === 'FAIL' ? 'bad' : ins.result === 'PASS' ? 'ok' : 'warn'}>Submitted {ins.completedAt ? '' : ''}— result <b>{ins.result}</b>. Answers and photos are immutable.</Banner>}

      {list.map((c, idx) => (
        <CheckCard key={c.checkId} idx={idx} c={c} a={(answers || {})[c.checkId] || {}} ro={readOnly} evidence={evidence.filter(e => e.checkId === c.checkId)} sid={sid} ins={ins}
          onAnswer={(v) => change({ ...answers, [c.checkId]: { ...((answers || {})[c.checkId] || {}), ...v } })}
          onEvidence={(fn) => setEvidence(ev => { const next = fn(ev); if (next.some(e => e.status === 'VERIFIED')) persist(answers, comment, next); return next; })}
          openCamera={(onBlob) => setCamera({ onBlob })}
          checkResult={(ins.checkResults || []).find(r => r.CHECK_ID === c.checkId)} readings={(data.readings || []).filter(r => r.checkId === c.checkId)} />
      ))}

      <Card title="Comment">
        <textarea className="textarea" disabled={readOnly} value={comment} onChange={e => { setComment(e.target.value); change(answers, e.target.value); }} placeholder="Observations (optional)" />
      </Card>

      {!readOnly && (
        <Card className="flat">
          <div className="stack">
            {pendingUploads.length > 0 && <Banner tone="warn">{pendingUploads.length} photo(s) still uploading or being verified - submission waits for them.</Banner>}
            {canRelease && <label className="check"><input type="checkbox" checked={release} onChange={e => setRelease(e.target.checked)} /> Release to the next operation if every check passes (gate release authority)</label>}
            <div className="btn-row">
              <button className="btn lg" onClick={() => persist(answers, comment, evidence)}><Icon name="check" />Save draft</button>
              <Busy busy={submitting} className="btn primary lg" disabled={pendingUploads.length > 0} onClick={submit}><Icon name="flag" />Submit inspection</Busy>
            </div>
            <span className="hint">Missing mandatory answers make the inspection INCOMPLETE (not a fail) and it cannot release the tank. A failed reading puts the tank on quality hold; detection is not blame.</span>
          </div>
        </Card>
      )}
      {camera && <CameraModal onClose={() => setCamera(null)} onShot={(blob) => { camera.onBlob(blob, 'CAMERA'); setCamera(null); }} />}
    </div>
  );
}

function SyncBadge({ sync, readOnly }) {
  if (readOnly) return <span className="fresh ok">Read-only</span>;
  const m = { idle: ['ok', 'Saved'], saved: ['ok', 'Draft saved on the server'], saving: ['warn', 'Saving…'], pending: ['warn', 'Pending sync (kept on this device)'], offline: ['bad', 'Offline - pending sync'], conflict: ['bad', 'Conflict - choose a version'] }[sync] || ['ok', ''];
  return <span className={`fresh ${m[0]}`}><span className="dot" />{m[1]}</span>;
}

function ResultBanner({ r }) {
  if (r.result === 'PASS') return <Banner tone="ok"><b>PASS</b> — {r.release ? 'released to the next operation.' : (r.note || 'awaiting release by an authorised person.')}</Banner>;
  if (r.result === 'FAIL') return <Banner tone="bad"><b>FAIL</b> — the tank is on quality hold ({r.holdId}). Defects {(r.defectIds || []).join(', ')} were opened with cause UNKNOWN; a quality approver decides the disposition (repairable return, scrap or pending review).</Banner>;
  return <Banner tone="warn"><b>INCOMPLETE</b> — {r.note}</Banner>;
}

function CheckCard({ idx, c, a, ro, evidence, sid, ins, onAnswer, onEvidence, openCamera, checkResult, readings }) {
  const fileRef = useRef(null);
  const toast = useToast();
  const upload = async (blob, method, supersedes) => {
    const tmp = `tmp-${Math.random().toString(36).slice(2)}`;
    const preview = URL.createObjectURL(blob);
    onEvidence(ev => [...ev.filter(e => e.evidenceId !== supersedes), { evidenceId: tmp, checkId: c.checkId, status: 'SIGNING', previewUrl: preview, progress: 0 }]);
    try {
      const dims = await imageSize(blob);
      const signed = await api.post(`/sessions/${sid}/evidence/sign`, { inspectionId: ins.inspectionId, unitId: ins.unitId, checkId: c.checkId, mime: blob.type || 'image/jpeg', bytes: blob.size, width: dims.w, height: dims.h,
        capturedAt: new Date().toISOString(), captureMethod: method, deviceId: 'OPERATOR-APP', supersedesEvidenceId: supersedes || undefined }, { idempotencyKey: newKey('sign') });
      const id = signed.evidenceId;
      onEvidence(ev => ev.map(e => (e.evidenceId === tmp ? { ...e, evidenceId: id, status: 'UPLOADING' } : e)));
      await sendFile(signed.upload, blob, (p) => onEvidence(ev => ev.map(e => (e.evidenceId === id ? { ...e, progress: p } : e))));
      onEvidence(ev => ev.map(e => (e.evidenceId === id ? { ...e, status: 'VERIFYING' } : e)));
      const done = await api.post(`/sessions/${sid}/evidence/${id}/complete`, {}, { idempotencyKey: newKey('verify') });
      const st = (done.evidence && (done.evidence.status || done.evidence.UPLOAD_STATUS)) || 'FAILED';
      onEvidence(ev => ev.map(e => (e.evidenceId === id ? { ...e, status: st } : e)));
      if (st !== 'VERIFIED') toast(`Photo could not be verified (${st}) - retake it`, 'bad');
    } catch (e) {
      onEvidence(ev => ev.map(x => (x.evidenceId === tmp || (x.status !== 'VERIFIED' && x.previewUrl === preview) ? { ...x, status: 'FAILED', error: e.message } : x)));
      toast(`Upload failed: ${e.message}. Nothing was attached; retry or retake.`, 'bad', 7000);
    }
  };
  const res = checkResult && checkResult.RESULT;
  return (
    <Card className="flat" title={<span style={{ fontSize: 15 }}>{idx + 1}. {c.question}</span>} actions={<>{res && <Status value={res} />}{c.mandatory ? <span className="badge">mandatory</span> : <span className="badge info">optional</span>}{c.evidenceRequired === 'Y' && <span className="badge warn">photo required</span>}{c.evidenceRequired !== 'Y' && c.photoOnFail && <span className="badge">photo if it fails</span>}</>}>
      <div className="stack">
        <div className="small muted">{c.section}{c.group ? ` · ${c.group}` : ''} · {c.requirement}{c.instrument ? ` · instrument: ${c.instrument}` : ''}</div>
        {c.originalToleranceText && <div className="small">Original tolerance text: <i>{c.originalToleranceText}</i></div>}
        {c.answerType === 'YES_NO' ? (
          <div className="seg" role="group" aria-label={c.question}>
            {['Yes', 'No'].map(v => <button key={v} disabled={ro} aria-pressed={a.answer === v} className={a.answer === v ? (v === c.failureAnswer ? 'bad' : 'ok') : ''} onClick={() => onAnswer({ answer: v })}>{v}{v === c.failureAnswer ? ' (fail)' : ''}</button>)}
          </div>
        ) : (
          <div className="stack">
            {c.specs.map(s => (
              <div key={s.specId} className="row" style={{ alignItems: 'flex-end' }}>
                <div className="stack tight" style={{ minWidth: 180 }}><b>{human(s.position)}</b><span className="small muted">{s.lower ?? '−∞'} … {s.upper ?? '+∞'} {s.unit || ''} (nominal {s.nominal ?? '—'})</span></div>
                {Array.from({ length: s.readings || 1 }).map((_, i) => {
                  const v = ((a.values || {})[s.position] || [])[i] ?? '';
                  const j = judge(v, s);
                  return <input key={i} className={`input reading num ${j === 'bad' ? 'bad' : j === 'ok' ? 'ok' : ''}`} inputMode="decimal" aria-label={`${s.position} reading ${i + 1}`} disabled={ro} value={v}
                    onChange={e => { const vals = { ...(a.values || {}) }; const arr = [...(vals[s.position] || [])]; arr[i] = e.target.value === '' ? '' : e.target.value.replace(',', '.'); vals[s.position] = arr; onAnswer({ values: vals }); }} placeholder={`#${i + 1}`} />;
                })}
              </div>
            ))}
          </div>
        )}
        {readings.length > 0 && <div className="small muted">Recorded readings: {readings.map(r => `${r.position || ''}#${r.sampleNo} ${r.value ?? r.text ?? '—'} (${r.result})`).join(' · ')}</div>}
        <div className="photo-grid">
          {evidence.map(e => <Photo key={e.evidenceId} e={e} sid={sid} ro={ro} onRetake={() => fileRef.current && (fileRef.current.dataset.supersedes = e.evidenceId, fileRef.current.click())} />)}
          {!ro && <>
            <button className="photo clickable" onClick={() => openCamera((blob, m) => upload(blob, m))} aria-label="Take photo with the camera"><span><Icon name="camera" size={22} /><br />Camera</span></button>
            <button className="photo clickable" onClick={() => { if (fileRef.current) { delete fileRef.current.dataset.supersedes; fileRef.current.click(); } }} aria-label="Upload a photo file"><span><Icon name="plus" size={22} /><br />Upload</span></button>
          </>}
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" hidden onChange={e => { const f = e.target.files && e.target.files[0]; const sup = e.target.dataset.supersedes; e.target.value = ''; if (f) upload(f, 'FILE', sup); }} />
      </div>
    </Card>
  );
}

function Photo({ e, sid, ro, onRetake }) {
  const [src, setSrc] = useState(e.previewUrl || null);
  useEffect(() => {
    let url = null, alive = true;
    if (!e.previewUrl && e.status === 'VERIFIED' && !String(e.evidenceId).startsWith('tmp-')) {
      fetch(`${API_BASE}/sessions/${sid}/evidence/${e.evidenceId}/view`, { credentials: 'same-origin', headers: { 'X-App-Kind': 'operator' } }).then(async r => {
        if (!r.ok) return;
        if ((r.headers.get('content-type') || '').includes('json')) { const j = await r.json(); if (alive) setSrc(j.url); }
        else { url = URL.createObjectURL(await r.blob()); if (alive) setSrc(url); }
      }).catch(() => {});
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [e.evidenceId, e.status, e.previewUrl, sid]);
  const label = { SIGNING: 'Authorising…', UPLOADING: `Uploading ${Math.round((e.progress || 0) * 100)}%`, VERIFYING: 'Verifying…', VERIFIED: 'Verified', FAILED: 'Failed', PENDING_UPLOAD: 'Pending upload', UPLOADED_PENDING_VERIFICATION: 'Verifying…' }[e.status] || human(e.status);
  return (
    <div className="photo" title={e.error || label}>
      {src ? <img src={src} alt={`Evidence ${e.evidenceId}`} /> : <span>{e.evidenceId}</span>}
      <div className="st"><span className={`badge ${e.status === 'VERIFIED' ? 'ok' : e.status === 'FAILED' ? 'bad' : 'warn'}`}>{label}</span>{e.synthetic && <span className="badge info">synthetic</span>}</div>
      {!ro && e.status !== 'SIGNING' && e.status !== 'UPLOADING' && <button className="btn sm" style={{ position: 'absolute', top: 4, right: 4 }} onClick={onRetake}>Retake</button>}
    </div>
  );
}

function imageSize(blob) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      const u = URL.createObjectURL(blob);
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(u); };
      img.onerror = () => { resolve({ w: undefined, h: undefined }); URL.revokeObjectURL(u); };
      img.src = u;
    } catch (e) { resolve({}); }
  });
}

/** direct upload: Cloudinary signed POST (photos never pass through the API) or the local development adapter (PUT) */
function sendFile(up, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, 'UPLOAD_FAILED', `Upload rejected (${xhr.status})`)));
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Upload interrupted (network)'));
    if (up.mode === 'cloudinary') {
      const fd = new FormData();
      Object.entries(up.fields || {}).forEach(([k, v]) => fd.append(k, v));
      fd.append('file', blob);
      xhr.open('POST', up.uploadUrl);
      xhr.send(fd);
    } else {
      xhr.open('PUT', up.uploadUrl);
      xhr.setRequestHeader('Content-Type', blob.type || up.contentType || 'application/octet-stream');
      xhr.send(blob);
    }
  });
}

function CameraModal({ onClose, onShot }) {
  const video = useRef(null);
  const [err, setErr] = useState(null);
  const [stream, setStream] = useState(null);
  useEffect(() => {
    let s = null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setErr('This browser cannot open the camera here (camera needs HTTPS or localhost). Use "Upload" instead.'); return undefined; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(st => { s = st; setStream(st); if (video.current) { video.current.srcObject = st; video.current.play().catch(() => {}); } })
      .catch(e => setErr(e && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in the browser settings, or use "Upload".' : `Camera unavailable (${e && e.name}). Use "Upload" instead.`));
    return () => { if (s) s.getTracks().forEach(t => t.stop()); };
  }, []);
  const shoot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    cv.toBlob(b => b && onShot(b), 'image/jpeg', 0.9);
  };
  return (
    <Modal title="Take photo" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!stream} onClick={shoot}><Icon name="camera" />Capture</button></>}>
      {err ? <Banner tone="warn">{err}</Banner> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12, background: '#000', minHeight: 220 }} />}
      <span className="hint">You can review the photo after capture and retake it; submitted photos are never replaced (a retake links to the previous one).</span>
    </Modal>
  );
}
