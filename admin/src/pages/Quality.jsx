import { Bars } from '../components/Visuals.jsx';
import React, { useEffect, useState } from 'react';
import { useApp, useRouter, usePoll } from '../lib/hooks.jsx';
import { API_BASE } from '../lib/api.js';
import { human, plantTime } from '../lib/fmt.js';
import { Banner, Busy, Card, ErrorState, Icon, Loading, Modal, Status, Empty } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { TankLink } from '../components/PassportSections.jsx';

export default function Quality() {
  const { navigate } = useRouter();
  const { user } = useApp();
  const { data, error, loading, reload } = useView('/quality', { interval: 6000 });
  const { run, busy } = useCommand();
  const [decide, setDecide] = useState(null);
  const [inv, setInv] = useState(null);
  const [tab, setTab] = useState('holds');
  const ref = usePoll('/admin/reference', { interval: 600000 });
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const canApprove = (user.permissions || []).includes('quality_approval');
  const repl = data.dispositions.filter(d => d.DISPOSITION === 'SCRAP');
  return (
    <div className="page">
      <div className="row between"><h1>Quality &amp; rework</h1><span className="badge">Disposition policy {data.policyId}</span></div>
      <Bars title="Quality workload" note="Counts of records, not unique tanks. A tank can have both a hold and an investigation." unit="records" rows={[{label:'Open holds',value:data.holds.length,color:'var(--warn)'},{label:'Return and rework records',value:data.returns.length},{label:'Investigations',value:data.investigations.length},{label:'Inspection records',value:data.inspections.length}]}/>
      <Banner tone="info">{data.note}</Banner>
      <div className="tabs" role="tablist">
        {[['holds', `Holds (${data.holds.length})`], ['returns', `Return / rework board (${data.returns.length})`], ['investigations', `Investigations (${data.investigations.length})`], ['inspections', `Inspections (${data.inspections.length})`], ['scrap', `Scrap & replacement (${repl.length})`]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'holds' && (data.holds.length === 0 ? <Card><Empty icon="quality">No open quality hold.</Empty></Card> : data.holds.map(h => (
        <Card key={h.holdId} className="flat" title={<span className="row" style={{ gap: 8 }}><TankLink id={h.unitId}>{h.serial || h.unitId}</TankLink> · {human(h.type)} at {h.detectionPoint}</span>} actions={<><Status value={h.unitState} /><Status value={h.resolution} /></>}>
          <div className="grid two">
            <div className="stack tight small">
              <span>Hold {h.holdId} since {h.sinceLocal ? h.sinceLocal.slice(11, 16) : '—'} · {h.location} ({human(h.locationType)})</span>
              {h.defects.map(d => <span key={d.defectId}>Defect {d.defectId}: {human(d.code)} on {d.checkId} — {d.description}</span>)}
            </div>
            <div className="stack tight small">
              <span>Matrix suggestion: <b>{human(h.matrix.disposition)}</b>{h.matrix.destinationRule ? ` · destination ${human(h.matrix.destinationRule)}` : ''}{h.matrix.escalateAfter ? ` · escalate after ${h.matrix.escalateAfter} failed reinspections` : ''}</span>
              <span className="muted">{h.matrix.status ? `Matrix status: ${human(h.matrix.status)}` : h.matrix.note}</span>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn primary sm" disabled={!canApprove} title={canApprove ? '' : 'Requires quality approval permission'} onClick={() => setDecide(h)}>Decide disposition</button>
          </div>
        </Card>
      )))}
      {tab === 'returns' && (data.returns.length === 0 ? <Card><Empty icon="route">No return-for-rework loop in this session yet.</Empty></Card> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Return</th><th>Tank</th><th>Type</th><th>Origin → destination</th><th>Basis</th><th>Detected</th><th>Status</th><th /></tr></thead>
          <tbody>{data.returns.map(r => (
            <tr key={r.RETURN_ID}><td className="mono small">{r.RETURN_ID}</td><td><TankLink id={r.UNIT_ID}>{r.UNIT_ID}</TankLink></td><td>{human(r.REWORK_TYPE)}</td>
              <td className="small">{r.ORIGIN_OPERATION_ID} @ {r.ORIGIN_WORKSTATION_ID} → {r.AUTHORIZED_DESTINATION_WORKSTATION_ID || '—'}</td><td className="small">{human(r.DESTINATION_BASIS)}{r.ALTERNATE_REASON ? ` (${human(r.ALTERNATE_REASON)}, by ${r.ALTERNATE_APPROVED_BY})` : ''}</td>
              <td className="small">{r.detectedLocal ? r.detectedLocal.slice(11, 16) : '—'} at {r.DETECTED_AT_WORK_CENTER_ID}</td><td><Status value={r.LOOP_STATUS} /></td>
              <td>{r.LOOP_STATUS === 'RETURN_REQUESTED' && <Busy busy={busy === 'RETURN_DISPATCH' + r.UNIT_ID} className="btn sm" onClick={() => run('RETURN_DISPATCH', { unitId: r.UNIT_ID }, 'Return transport dispatched', reload)}>Dispatch</Busy>}
                {r.LOOP_STATUS === 'IN_RETURN_TRANSFER' && <Busy busy={busy === 'RETURN_ARRIVE' + r.UNIT_ID} className="btn sm" onClick={() => run('RETURN_ARRIVE', { unitId: r.UNIT_ID }, 'Arrival at rework station recorded', reload)}>Arrived</Busy>}</td></tr>
          ))}</tbody></table></div>
      ))}
      {tab === 'investigations' && (data.investigations.length === 0 ? <Card><Empty>No investigation.</Empty></Card> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Investigation</th><th>Defect</th><th>Tank</th><th>Status</th><th>Cause</th><th>Responsible (confirmed only)</th><th /></tr></thead>
          <tbody>{data.investigations.map(i => (
            <tr key={i.INVESTIGATION_ID}><td className="mono small">{i.INVESTIGATION_ID}</td><td className="small">{i.DEFECT_ID}{i.DOWNSTREAM_FLAG === 'Y' && <span className="badge warn" style={{ marginLeft: 4 }}>downstream</span>}</td><td><TankLink id={i.UNIT_ID} /></td><td><Status value={i.STATUS} /></td><td>{human(i.CAUSE_CATEGORY)}</td>
              <td className="small">{(i.RESPONSIBLE || []).map(r => `${r.PARTY_ID} ${(r.SHARE * 100).toFixed(0)}%`).join(', ') || '—'}</td>
              <td><button className="btn sm" disabled={!canApprove} onClick={() => setInv(i)}>Update</button></td></tr>
          ))}</tbody></table></div>
      ))}
      {tab === 'inspections' && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Inspection</th><th>Tank</th><th>Gate</th><th>Kind</th><th>Inspector</th><th>Status</th><th>Result</th><th>Entry lag</th></tr></thead>
          <tbody>{data.inspections.map(i => <tr key={i.inspectionId} className="clickable" onClick={() => navigate(`/inspections/${i.inspectionId}`)}><td className="mono small">{i.inspectionId}</td><td><TankLink id={i.unitId} /></td><td>{i.gate}</td><td>{human(i.kind)}</td><td>{i.inspector}</td><td><Status value={i.status} /></td><td>{i.result ? <Status value={i.result} /> : '—'}</td><td className="small">{i.entryLagMin ? `${i.entryLagMin} min (late entry)` : '—'}</td></tr>)}</tbody></table></div>
      )}
      {tab === 'scrap' && <ScrapTab data={data} run={run} reload={reload} navigate={navigate} />}
      {decide && <DecideModal h={decide} stations={((ref.data || {}).stations || [])} onClose={() => setDecide(null)} run={run} onDone={reload} />}
      {inv && <InvestigationModal i={inv} onClose={() => setInv(null)} run={run} onDone={reload} />}
    </div>
  );
}

function ScrapTab({ data, run, reload, navigate }) {
  const scrapped = data.dispositions.filter(d => d.DISPOSITION === 'SCRAP');
  const repl = data.replacements || [];
  return (
    <Card title="Scrapped tanks (permanent) and replacements" icon="tank">
      <Banner tone="info">Scrap is permanent and never returns. A replacement gets a new UNIT_ID with REPLACEMENT_FOR_UNIT_ID and satisfies the existing demand without increasing it.</Banner>
      {scrapped.length === 0 ? <Empty>No scrap in this session.</Empty> : scrapped.map(d => {
        const r = repl.find(x => x.SCRAPPED_UNIT_ID === d.UNIT_ID);
        return (
          <div key={d.DISPOSITION_ID} className="row between" style={{ padding: '8px 0', borderBottom: '1px dashed var(--line)' }}>
            <span><TankLink id={d.UNIT_ID}>{d.UNIT_ID}</TankLink> · scrapped {plantTime(d.DECIDED_AT)} by {d.DECIDED_BY} · {d.REASON_CODE || d.MATRIX_DISPOSITION}</span>
            <span className="row">
              {!r && <button className="btn sm" onClick={() => run('REPLACEMENT_REQUEST', { scrappedUnitId: d.UNIT_ID }, 'Replacement requested', reload)}>Request replacement</button>}
              {r && <Status value={r.STATUS} label={`${r.REQUEST_ID} ${human(r.STATUS)}${r.NEW_UNIT_ID ? ' → ' + r.NEW_UNIT_ID : ''}`} />}
              {r && ['REQUESTED', 'BLOCKED'].includes(r.STATUS) && <button className="btn sm primary" onClick={() => run('REPLACEMENT_APPROVE', { requestId: r.REQUEST_ID }, x => ((x.result || {}).blocked ? `Blocked: ${human(x.result.reason)} - expedite material first` : `Replacement ${((x.result || {}).newUnit || {}).UNIT_ID || ''} released at priority 1`), reload)}>Approve &amp; release</button>}
            </span>
          </div>
        );
      })}
    </Card>
  );
}

function DecideModal({ h, stations, onClose, run, onDone }) {
  const sugg = h.matrix.disposition === 'REPAIRABLE_RETURN' ? 'REWORK' : h.matrix.disposition === 'SCRAP' ? 'SCRAP' : 'PENDING_REVIEW';
  const [decision, setDecision] = useState(sugg);
  const [reason, setReason] = useState(h.matrix.disposition === 'NO_MATRIX_ENTRY' || h.matrix.disposition === 'PENDING_REVIEW' ? '' : 'PER_DISPOSITION_MATRIX');
  const [note, setNote] = useState('');
  const [alt, setAlt] = useState('');
  const [altReason, setAltReason] = useState('ORIGIN_EQUIPMENT_DOWN');
  const [busy, setBusy] = useState(false);
  const wcStations = stations.filter(s => s.type !== 'CURE_ZONE' && s.type !== 'HOLD_AREA');
  return (
    <Modal title={`Disposition for ${h.serial || h.unitId}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><Busy busy={busy} className={`btn ${decision === 'SCRAP' ? 'danger' : 'primary'}`} onClick={async () => {
      setBusy(true);
      const r = await run('DISPOSITION_DECIDE', { holdId: h.holdId, decision, reasonCode: reason || undefined, note: note || undefined, ...(decision === 'REWORK' && alt ? { alternateWorkstationId: alt, alternateReason: altReason } : {}) },
        decision === 'REWORK' ? 'Rework authorised - return to the correction station' : decision === 'SCRAP' ? 'Tank scrapped (permanent)' : 'Kept on hold for review', onDone);
      setBusy(false); if (r) onClose();
    }}>Confirm decision</Busy></>}>
      <div className="seg" role="group">{[['REWORK', 'Repairable return'], ['SCRAP', 'Scrap'], ['PENDING_REVIEW', 'Pending review']].map(([k, l]) => <button key={k} aria-pressed={decision === k} onClick={() => setDecision(k)}>{l}</button>)}</div>
      <div className="small muted">Matrix suggests {human(h.matrix.disposition)}. Unknown cases stay on hold unless you state a reason. Disposition is not blame.</div>
      <div className="field"><label>Reason code</label><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. PER_DISPOSITION_MATRIX, NON_REPAIRABLE_SEVERITY" /></div>
      <div className="field"><label>Note</label><input className="input" value={note} onChange={e => setNote(e.target.value)} /></div>
      {decision === 'REWORK' && <div className="stack">
        <div className="field"><label>Destination (default: the station that performed the operation - "same station again")</label>
          <select className="select" value={alt} onChange={e => setAlt(e.target.value)}><option value="">Origin station (default)</option>{wcStations.map(s => <option key={s.id} value={s.id}>{s.id} ({s.workCenterId})</option>)}</select></div>
        {alt && <div className="field"><label>Why not the origin station (recorded with your name)</label><select className="select" value={altReason} onChange={e => setAltReason(e.target.value)}>{['ORIGIN_EQUIPMENT_DOWN', 'ORIGIN_STATION_OCCUPIED', 'OTHER_APPROVED'].map(x => <option key={x} value={x}>{human(x)}</option>)}</select></div>}
      </div>}
    </Modal>
  );
}

function InvestigationModal({ i, onClose, run, onDone }) {
  const [status, setStatus] = useState(i.STATUS === 'OPEN_UNKNOWN' ? 'SUSPECTED' : i.STATUS);
  const [cause, setCause] = useState(i.CAUSE_CATEGORY || 'UNKNOWN');
  const [ev, setEv] = useState('');
  const [resp, setResp] = useState('');
  return (
    <Modal title={`Investigation ${i.INVESTIGATION_ID}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => {
      const responsible = resp.split(',').map(s => s.trim()).filter(Boolean).map(s => { const [id, sh] = s.split(':'); return { partyId: id.trim().toUpperCase(), share: Number(sh || 0) }; });
      if (responsible.length && responsible.every(r => !r.share)) responsible.forEach(r => { r.share = 1 / responsible.length; });
      const r = await run('INVESTIGATION_UPDATE', { investigationId: i.INVESTIGATION_ID, status, causeCategory: cause, evidenceNote: ev, responsible }, 'Investigation updated (points engine posts or reverses deductions accordingly)', onDone);
      if (r) onClose();
    }}>Save</button></>}>
      <div className="field"><label>Status</label><div className="seg">{['OPEN_UNKNOWN', 'SUSPECTED', 'CONFIRMED', 'CLOSED_UNRESOLVED'].map(s => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{human(s)}</button>)}</div></div>
      <div className="field"><label>Cause category</label><select className="select" value={cause} onChange={e => setCause(e.target.value)}>{['UNKNOWN', 'WORKER', 'EQUIPMENT', 'MATERIAL', 'SUPPLIER', 'PROCESS'].map(c => <option key={c} value={c}>{human(c)}</option>)}</select></div>
      <div className="field"><label>Evidence note (required to confirm)</label><textarea className="textarea" value={ev} onChange={e => setEv(e.target.value)} /></div>
      {status === 'CONFIRMED' && cause === 'WORKER' && <div className="field"><label>Confirmed responsible workers with shares (e.g. W0012:0.5, W0044:0.5)</label><input className="input mono" value={resp} onChange={e => setResp(e.target.value)} /></div>}
      <span className="hint">Pending investigations never deduct points. A −4 downstream deduction posts only for a confirmed worker cause; changing it later posts an inverse reversal.</span>
    </Modal>
  );
}

/** read-only inspection review with photos (role-restricted delivery) */
export function InspectionReview({ id }) {
  const { navigate } = useRouter();
  const { session } = useApp();
  const { data, error, loading, reload } = useView(`/inspections/${encodeURIComponent(id)}`, { interval: 15000 });
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const i = data.inspection;
  return (
    <div className="page">
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => window.history.back()}><Icon name="back" />Back</button>
      <Card hero title={`${human(i.kind)} ${i.gate} · ${i.serial || i.unitId}`} actions={<><Status value={i.status} /><Status value={i.result || 'DRAFT'} lg /></>}>
        <div className="small">{i.inspectionId} · {i.inspector} · attempt {i.attemptNo || 1} · checklist {i.checklistVersion || '1.0'} {i.comment ? `· “${i.comment}”` : ''}</div>
      </Card>
      <Banner tone="warn">{data.limitsNote}</Banner>
      {data.checklist.map(c => {
        const res = (i.checkResults || []).find(r => r.CHECK_ID === c.checkId);
        const rd = data.readings.filter(r => r.checkId === c.checkId);
        const ans = (i.answers || i.draftAnswers || {})[c.checkId] || {};
        return (
          <Card key={c.checkId} className="flat" title={<span style={{ fontSize: 14.5 }}>{c.question}</span>} actions={res ? <Status value={res.RESULT} /> : null}>
            <div className="small muted">{c.section} · {c.requirement}</div>
            <div className="small" style={{ marginTop: 6 }}>{rd.length ? rd.map((r, k) => <span key={k} className={`badge ${r.result === 'FAIL' ? 'bad' : r.result === 'PASS' ? 'ok' : ''}`} style={{ margin: 2 }}>{r.position || ''}#{r.sampleNo} {r.value ?? r.text ?? '—'}</span>) : (ans.answer || JSON.stringify(ans.values || {}))}</div>
            {res && res.REASON && <div className="small" style={{ color: 'var(--bad)' }}>{res.REASON}</div>}
          </Card>
        );
      })}
      <Card title="Photo evidence" icon="camera">
        {data.evidence.length === 0 ? <Empty icon="camera">No photos.</Empty> : <div className="photo-grid">{data.evidence.map(e => <EvidenceThumb key={e.evidenceId} e={e} sid={session.sessionId} />)}</div>}
      </Card>
    </div>
  );
}

function EvidenceThumb({ e, sid }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url = null, alive = true;
    if (e.status === 'VERIFIED') fetch(`${API_BASE}/sessions/${sid}/evidence/${e.evidenceId}/view`, { credentials: 'same-origin', headers: { 'X-App-Kind': 'admin' } }).then(async r => {
      if (!r.ok) return;
      if ((r.headers.get('content-type') || '').includes('json')) { const j = await r.json(); if (alive) setSrc(j.url); } else { url = URL.createObjectURL(await r.blob()); if (alive) setSrc(url); }
    }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [e.evidenceId, e.status, sid]);
  return <div className="photo" title={`${e.evidenceId} · ${e.status}`}>{src ? <img src={src} alt={e.evidenceId} /> : <span>{e.evidenceId}<br />{human(e.status)}</span>}<div className="st">{e.supersededBy && <span className="badge">retaken</span>}{e.synthetic && <span className="badge info">synthetic fixture</span>}</div></div>;
}
