import { Bars, ActivityStrip } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { useRouter, queryParam, useWorkCenterIds } from '../lib/hooks.jsx';
import { human, mins, plantTime, hhmm, signed } from '../lib/fmt.js';
import { Busy, Card, ErrorState, Icon, KV, Loading, Modal, Status, Empty, Banner, Kind } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { TankLink } from '../components/PassportSections.jsx';

const STATES = ['', 'WORKING', 'WAITING', 'AVAILABLE', 'PAUSED', 'BREAK', 'INSPECTING', 'TRANSFER', 'INDIRECT', 'NOT_CLOCKED_IN', 'ABSENT', 'OFF_SHIFT'];

export default function Workforce() {
  const { navigate, path } = useRouter();
  const [q, setQ] = useState('');
  const [state, setState] = useState(queryParam(path, 'state') || '');
  const [wc, setWc] = useState('');
  const [role, setRole] = useState('');
  const [shiftOnly, setShiftOnly] = useState(false);
  const [page, setPage] = useState(1);
  const { ids: wcIds } = useWorkCenterIds();
  const qs = new URLSearchParams({ page: String(page), pageSize: '50', ...(q ? { q } : {}), ...(state ? { state } : {}), ...(wc ? { workCenterId: wc } : {}), ...(role ? { role } : {}), ...(shiftOnly ? { shiftOnly: '1' } : {}) });
  const { data, error, loading, reload } = useView(`/workforce?${qs}`, { interval: 8000, deps: [qs.toString()] });
  return (
    <div className="page">
      <h1>Workforce</h1>
      <div className="row">
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search name or ID" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} aria-label="Search workers" />
        <select className="select" style={{ maxWidth: 190 }} value={state} onChange={e => { setState(e.target.value); setPage(1); }} aria-label="State">{STATES.map(s => <option key={s} value={s}>{s ? human(s) : 'All states'}</option>)}</select>
        <select className="select" style={{ maxWidth: 150 }} value={wc} onChange={e => { setWc(e.target.value); setPage(1); }} aria-label="Work centre">{['', ...wcIds].map(s => <option key={s} value={s}>{s || 'All work centres'}</option>)}</select>
        <select className="select" style={{ maxWidth: 220 }} value={role} onChange={e => { setRole(e.target.value); setPage(1); }} aria-label="Role">{['', 'PRODUCTION_OPERATOR', 'QUALITY_INSPECTOR', 'QUALITY_SUPERVISOR', 'AREA_SUPERVISOR', 'SHIFT_MANAGER', 'MAINTENANCE_TECHNICIAN', 'MATERIAL_HANDLER'].map(s => <option key={s} value={s}>{s ? human(s) : 'All roles'}</option>)}</select>
        <label className="check"><input type="checkbox" checked={shiftOnly} onChange={e => { setShiftOnly(e.target.checked); setPage(1); }} /> rostered for current shift only</label>
      </div>
      {!data && loading ? <Loading lines={8} /> : !data ? <ErrorState error={error} onRetry={reload} /> : <>
        <div className="row"><span className="small muted">{data.scope} · {data.total} people</span>{Object.entries(data.stateCounts).map(([k, v]) => <button key={k} className="badge" style={{ cursor: 'pointer', border: 0 }} onClick={() => setState(k)}>{human(k)} {v}</button>)}</div>
        <Bars title="Worker states" note={data.scope + ' · counts returned by the server for this view'} unit="people" rows={Object.entries(data.stateCounts).map(([label,value])=>({label,value}))} />
        <div className="worker-cards">{data.workers.map(w=><button key={w.workerId} className="worker-tile" onClick={()=>navigate(`/workforce/${w.workerId}`)}><span className="row"><span className="avatar">{w.name.split(' ').map(x=>x[0]).join('').slice(0,2)}</span><span><strong>{w.name}</strong><small className="muted" style={{display:'block'}}>{w.workerId}</small></span></span><Status value={w.plantState}/><span>{w.workstationId||w.workCenterId||'Location not recorded'}</span><span className="small muted">{w.reason?human(w.reason):human(w.attendance)} · Open activity →</span></button>)}</div>
        <details className="more"><summary>Compare detailed roster records</summary><div className="table-wrap"><table className="table">
          <thead><tr><th>Person</th><th>Role</th><th>Shift</th><th>Attendance</th><th>State</th><th>Where</th><th>Since</th><th>Control</th></tr></thead>
          <tbody>{data.workers.map(w => (
            <tr key={w.workerId} className="clickable" onClick={() => navigate(`/workforce/${w.workerId}`)}>
              <td><b>{w.name}</b><div className="small muted mono">{w.workerId}</div></td><td className="small">{human(w.role)}</td>
              <td className="small">{w.shiftId || '—'}{w.plannedStartLocal ? <div className="muted">{hhmm(w.plannedStartLocal)}–{hhmm(w.plannedEndLocal)}</div> : null}</td>
              <td><Status value={w.attendance} /></td><td><Status value={w.plantState} />{w.reason && <div className="small muted">{human(w.reason)}</div>}</td>
              <td className="small">{w.workstationId || w.workCenterId || w.homeWorkCenterId || '—'}{w.tempWorkCenterId ? ` (temp ${w.tempWorkCenterId})` : ''}</td>
              <td className="small">{w.stateSince ? plantTime(w.stateSince, data.session.timezone) : '—'}</td>
              <td className="small">{w.control && w.control.MODE !== 'AGENT' ? <span className="badge brand">{human(w.control.MODE)}</span> : 'simulated'}</td>
            </tr>
          ))}</tbody>
        </table></div></details>
        <div className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button><span className="small">Page {page} of {Math.max(1, Math.ceil(data.total / 50))}</span><button className="btn sm" disabled={page * 50 >= data.total} onClick={() => setPage(p => p + 1)}>Next</button></div>
      </>}
    </div>
  );
}

export function WorkerDetail({ wid }) {
  const { navigate } = useRouter();
  const { data, error, loading, reload } = useView(`/workers/${encodeURIComponent(wid)}`, { interval: 8000 });
  const { run, busy } = useCommand();
  const [modal, setModal] = useState(null);
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const w = data.worker, tz = data.session.timezone;
  return (
    <div className="page">
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/workforce')}><Icon name="back" />Workforce</button>
      <Card hero title={<span className="row" style={{ gap: 10 }}><span className="avatar">{w.name.split(' ').map(x => x[0]).join('').slice(0, 2)}</span>{w.name} <span className="mono small muted">{w.workerId}</span></span>} actions={<><Status value={w.attendance} /><Status value={w.plantState} lg /></>}>
        <div className="grid two">
          <KV items={[['Role', human(w.role)], ['Home work centre', w.homeWorkCenterId], ['Shift', `${w.shiftId || '—'} ${w.plannedStartLocal ? `${hhmm(w.plannedStartLocal)}–${hhmm(w.plannedEndLocal)}` : ''}`], ['First clock-in', w.firstClockInLocal ? hhmm(w.firstClockInLocal) : '—'], ['Current task', w.currentTaskId || '—'], ['Location', `${w.workCenterId || '—'} ${w.workstationId || ''}`], ['Control', w.control && w.control.MODE !== 'AGENT' ? `${human(w.control.MODE)} (${w.control.LOGIN_ID})` : 'background simulation'], ['Next shift', w.nextShiftId ? `${w.nextShiftId} ${hhmm(w.nextPlannedStartLocal)}` : '—']]} />
          <div className="stack">
            <div className="row"><Kind kind="OBSERVED" /><span className="small">Points total {signed(((data.points || {}).total || {}).TOTAL || 0)} (quality {signed(((data.points || {}).total || {}).QUALITY || 0)}, time {signed(((data.points || {}).total || {}).TIME || 0, 0)})</span></div>
            {data.appSession && <div className="small">App sign-in: {data.appSession.signedIn ? `signed in (${data.appSession.apps.join(', ')})` : 'not signed in'} <span className="muted">- {data.appSession.note}</span></div>}
            {data.metrics && <div className="small">Session labour categories: {Object.entries(data.metrics.labor_categories_min || {}).map(([k, v]) => `${human(k)} ${mins(v)}`).join(' · ') || 'none yet'}</div>}
            <div className="btn-row">
              <button className="btn sm" onClick={() => setModal('transfer')}><Icon name="swap" size={14} />Transfer</button>
              <button className="btn sm" onClick={() => setModal('overtime')}><Icon name="clock" size={14} />Approve overtime</button>
              <button className="btn sm" onClick={() => setModal('absence')}><Icon name="alert" size={14} />Absence / exit</button>
              <button className="btn sm" onClick={() => setModal('correction')}><Icon name="settings" size={14} />Attendance correction</button>
            </div>
          </div>
        </div>
      </Card>
      <div className="grid two"><Bars title="How recorded time was spent" note="Session labour only. Waiting and breaks are not a performance ranking." unit="min" rows={Object.entries(data.metrics?.labor_categories_min||{}).map(([label,value])=>({label,value}))}/><Bars title="Points explained" note="Posted quality and time components. Investigations stay separate until confirmed." unit="points" signed rows={[{label:'Quality',value:data.points?.total?.QUALITY},{label:'Time',value:data.points?.total?.TIME}]} /></div>
      <ActivityStrip events={data.timeline} time={at=>plantTime(at,tz)} />
      <Banner tone="info">{data.fairness}</Banner>
      <div className="grid two">
        <Card title="Qualifications at simulated now" icon="quality">
          {data.qualifications.length === 0 ? <Empty>No qualifications recorded.</Empty> : data.qualifications.map(q => <div key={q.skillId + q.validFrom} className="row between small"><span>{q.skill || q.skillId} · {human(q.level)} {q.independent === 'N' ? '(supervised)' : ''}</span><span>{q.validNow ? <Status value="OK" label="valid now" /> : <Status value="UNKNOWN" label="not valid now" />} <span className="muted">{q.validTo ? `to ${String(q.validTo).slice(0, 10)}` : 'open-ended'}</span></span></div>)}
        </Card>
        <Card title="Tasks in this session" icon="queue">
          {data.tasks.length === 0 ? <Empty>No tasks.</Empty> : data.tasks.map(t => <div key={t.taskId} className="row between small"><TankLink id={t.unitId}>{t.unitId}</TankLink><span>{t.operationId}</span><Status value={t.status} /></div>)}
        </Card>
      </div>
      <Card title="Timeline (history up to the fork + this session)" icon="clock">
        {data.timeline.length === 0 ? <Empty>No events.</Empty> : <ul className="timeline">{data.timeline.slice(-120).map((e, k) => <li key={k} className={e.source === 'SESSION' ? 'session' : ''}><span className="t">{plantTime(e.at, tz)}</span><span className="d" /><span><b>{human(e.type)}</b> {e.state ? `→ ${human(e.state)}` : ''} {e.reason ? `(${human(e.reason)})` : ''} {e.workstationId || e.workCenterId || ''} {e.unitId ? <>· <TankLink id={e.unitId} /></> : ''}</span></li>)}</ul>}
      </Card>
      {data.participation.length > 0 && <Card title="Participation segments (non-overlapping labour intervals)" icon="progress">
        <div className="table-wrap"><table className="table"><thead><tr><th>Category</th><th>From</th><th>To</th><th>Reason</th><th>Tank</th></tr></thead>
          <tbody>{data.participation.map((s, k) => <tr key={k}><td>{human(s.category)}</td><td>{hhmm(s.startLocal)}</td><td>{s.endLocal ? hhmm(s.endLocal) : 'open'}</td><td>{human(s.reason)}</td><td className="mono">{s.unitId || '—'}</td></tr>)}</tbody></table></div>
      </Card>}
      {modal === 'transfer' && <TransferModal w={w} run={run} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'overtime' && <SimpleModal title={`Approve overtime for ${w.name}`} fields={[['minutes', 'Minutes', 'number', 60], ['reason', 'Reason', 'text', 'ORDER_RECOVERY']]} onClose={() => setModal(null)} submit={v => run('OVERTIME_APPROVE', { workerId: w.workerId, minutes: Number(v.minutes), reason: v.reason }, 'Overtime approved (the customer due date does not change)', reload)} />}
      {modal === 'absence' && <SimpleModal title={`Record absence / mid-shift exit for ${w.name}`} fields={[['reason', 'Reason', 'text', 'SICK'], ['midShiftExit', 'Mid-shift exit (person is clocked in)', 'checkbox', w.attendance === 'CLOCKED_IN']]} onClose={() => setModal(null)} submit={v => run('ABSENCE_CONFIRM', { workerId: w.workerId, reason: v.reason, midShiftExit: !!v.midShiftExit }, 'Recorded - active tasks paused, nothing completed', reload)} />}
      {modal === 'correction' && <SimpleModal title={`Attendance correction for ${w.name}`} fields={[['correctionType', 'Type', 'select', 'ADD_MISSING_CLOCK_IN', ['ADD_MISSING_CLOCK_IN', 'ADD_MISSING_CLOCK_OUT', 'VOID_PUNCH']], ['correctedTime', 'Corrected time (UTC ISO, ≤ now)', 'text', new Date(data.session.simNow).toISOString().slice(0, 16)], ['reason', 'Reason (required)', 'text', '']]} onClose={() => setModal(null)} submit={v => run('ATTENDANCE_CORRECTION', { workerId: w.workerId, correctionType: v.correctionType, correctedTime: new Date(v.correctedTime + (v.correctedTime.length <= 16 ? ':00Z' : '')).toISOString(), reason: v.reason }, 'Correction appended (original kept)', reload)} />}
    </div>
  );
}

function TransferModal({ w, run, onClose, onDone }) {
  const { ids } = useWorkCenterIds();
  const [pick, setTo] = useState(null);
  const to = pick || ids.find(x => x !== (w.workCenterId || w.homeWorkCenterId));
  const [allow, setAllow] = useState(false);
  return (
    <Modal title={`Transfer ${w.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => { const r = await run('WORKER_TRANSFER', { workerId: w.workerId, toWorkCenterId: to, reason: 'SUPERVISOR_DIRECTED_TRANSFER', allowSourceBelowMin: allow, plannedReturnAt: w.plannedEndAt }, 'Transfer started - travel and handover are recorded', onDone); if (r) onClose(); }}>Transfer</button></>}>
      <div className="field"><label>Destination work centre</label><div className="seg">{ids.map(x => <button key={x} aria-pressed={to === x} onClick={() => setTo(x)}>{x}</button>)}</div></div>
      <label className="check"><input type="checkbox" checked={allow} onChange={e => setAllow(e.target.checked)} /> Allow the donor operation to drop below its minimum crew (explicit override)</label>
      <span className="hint">Checked at the server: qualification at arrival, attendance, and donor minimum crew. The working task is paused with reason "supervisor-directed transfer" (no speed penalty) and remains traceable.</span>
    </Modal>
  );
}

export function SimpleModal({ title, fields, submit, onClose, confirmLabel = 'Save', tone = 'primary' }) {
  const [v, setV] = useState(Object.fromEntries(fields.map(f => [f[0], f[3]])));
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><Busy busy={busy} className={`btn ${tone}`} onClick={async () => { setBusy(true); const r = await submit(v); setBusy(false); if (r) onClose(); }}>{confirmLabel}</Busy></>}>
      {fields.map(([k, label, type, , opts]) => (
        <div key={k} className="field">
          {type === 'checkbox' ? <label className="check"><input type="checkbox" checked={!!v[k]} onChange={e => setV({ ...v, [k]: e.target.checked })} /> {label}</label> : <>
            <label htmlFor={`f-${k}`}>{label}</label>
            {type === 'select' ? <select id={`f-${k}`} className="select" value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })}>{opts.map(o => <option key={o} value={o}>{human(o)}</option>)}</select>
              : type === 'textarea' ? <textarea id={`f-${k}`} className="textarea" value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} />
                : <input id={`f-${k}`} className="input" type={type} value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} />}
          </>}
        </div>
      ))}
    </Modal>
  );
}
