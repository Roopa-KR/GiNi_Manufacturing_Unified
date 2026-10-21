import React, { useState } from 'react';
import { useApp, usePoll } from '../lib/hooks.jsx';
import { human } from '../lib/fmt.js';
import { Banner, Busy, Card, ErrorState, Icon, Loading, Modal, Status, Empty } from '../components/ui.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { TankLink } from '../components/PassportSections.jsx';

/*
 * Dispatch & assign (fresh factory): every released tank with its next step, the crew it needs (minimum / standard / maximum),
 * the qualified people, free stations and - above all - WHY work cannot start yet. Assigning creates tasks for the chosen people;
 * they start the work themselves in the operator app after clocking in (assignment is not attendance and not a start).
 */
export default function Dispatch() {
  const { user } = useApp();
  const can = (user.permissions || []).includes('operational_supervision');
  const { data, error, loading, reload } = usePoll('/factory/readiness', { interval: 8000 });
  const [assign, setAssign] = useState(null);
  const [inspect, setInspect] = useState(null);
  const [filter, setFilter] = useState('open');
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const tanks = data.tanks.filter(t => filter === 'all' || !['ROUTE_COMPLETE', 'SCRAPPED'].includes(t.state));
  const needsCrew = tanks.filter(t => t.operationKind === 'LABOR' && !t.operationInstanceId && ['QUEUED', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION', 'READY'].includes(t.state));
  return (
    <div className="page">
      <div className="row between"><h1>Dispatch &amp; assign</h1>
        <div className="seg" role="group" aria-label="Filter">{[['open', 'Active tanks'], ['all', 'All']].map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}</div></div>
      <Banner tone="info">Queue order: rework and replacement tanks first, then high-priority orders, then by due time and time in queue. Assigning a crew creates their tasks; each person clocks in and starts the work in the operator app. Work below the minimum crew cannot progress.</Banner>
      {tanks.length === 0 && <Empty icon="tank">No released tanks yet. Create a work order and release a batch under Orders &amp; Batches - the tanks appear here.</Empty>}
      {needsCrew.length > 0 && <div className="section-title">Waiting for a crew ({needsCrew.length})</div>}
      <div className="grid two">
        {tanks.map(t => (
          <Card key={t.unitId} className="flat" title={<span><TankLink id={t.unitId}>{t.serial || t.unitId}</TankLink> <span className="small muted mono">{t.unitId}</span></span>} actions={<Status value={t.state} />}>
            <div className="small">{t.productId} · route v{t.routeVersion || '—'} · next step <b className="mono">{t.routeStep}</b> ({human(t.operationKind)}) at <b>{t.workCenterId}</b></div>
            <div className="small muted">Order {t.orderId || '—'} · batch {t.batchId || '—'} · due {t.dueAt ? new Date(t.dueAt).toLocaleString() : 'Not set'}<br />Step target: {t.standardElapsedMin ?? '—'} elapsed min / {t.standardLaborMin ?? '—'} labor min</div>
            {t.assignedInspectorId && <div className="small">Assigned inspector: {(t.qualifiedInspectors.find(w => w.workerId === t.assignedInspectorId) || {}).name || t.assignedInspectorId}</div>}
            {can && ['WORK_COMPLETED_AWAITING_INSPECTION', 'REWORK_COMPLETE_AWAITING_REINSPECTION', 'INCOMPLETE_INSPECTION_HOLD'].includes(t.state) && <button className="btn sm primary" onClick={() => setInspect(t)}>Assign inspector</button>}
            {t.operationKind === 'LABOR' && <div className="small muted">Skill {t.requiredSkill || 'none'} · crew min {t.minCrew} / std {t.stdCrew ?? '—'} / max {t.maxCrew ?? '—'}{t.workstationId ? ` · at ${t.workstationId}` : ''}</div>}
            {t.crew.length > 0 && <div className="small" style={{ marginTop: 4 }}>Crew: {t.crew.map(c => `${c.name || c.workerId} (${human(c.task)}${c.clockedIn ? '' : ', not clocked in'})`).join(' · ')}</div>}
            {t.blockers.length > 0 ? <div className="stack tight" style={{ marginTop: 6 }}>{t.blockers.map((b, i) => <span key={i} className="small" style={{ color: 'var(--warn)' }}>▲ {b.message}</span>)}</div>
              : t.operationState === 'WORKING' ? <span className="small" style={{ color: 'var(--ok)' }}>● In progress</span>
                : t.canStart ? <span className="small" style={{ color: 'var(--ok)' }}>● Ready - the crew can start</span> : null}
            {can && t.operationKind === 'LABOR' && ['QUEUED', 'QUEUED_FOR_REWORK', 'RECEIVED_AT_REWORK_STATION', 'READY', 'WORKING', 'PAUSED'].includes(t.state) && <div className="btn-row" style={{ marginTop: 8 }}>
              {!t.operationInstanceId ? <button className="btn sm primary" onClick={() => setAssign({ t, mode: 'new' })}><Icon name="users" size={14} />Assign crew</button>
                : <button className="btn sm" onClick={() => setAssign({ t, mode: 'add' })}><Icon name="plus" size={14} />Add person</button>}
            </div>}
          </Card>
        ))}
      </div>
      {inspect && <InspectorModal t={inspect} onClose={() => setInspect(null)} onDone={reload} />}
      {assign && <AssignModal t={assign.t} mode={assign.mode} onClose={() => setAssign(null)} onDone={reload} />}
    </div>
  );
}

function AssignModal({ t, mode, onClose, onDone }) {
  const { run, busy } = useCommand();
  const [ws, setWs] = useState(t.freeStations[0] || '');
  const [crew, setCrew] = useState([]);
  const toggle = id => setCrew(c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]));
  const already = new Set(t.crew.map(c => c.workerId));
  const people = t.qualifiedWorkers.filter(w => !already.has(w.workerId));
  const max = t.maxCrew || 99;
  const submit = async () => {
    if (mode === 'new') {
      const r = await run('OPERATION_START', { unitId: t.unitId, workstationId: ws, crew }, `Crew assigned to ${t.serial} at ${ws}`, onDone);
      if (r) onClose();
    } else {
      let ok = true;
      for (const w of crew) ok = !!(await run('TASK_ASSIGN', { operationInstanceId: t.operationInstanceId, workerId: w }, null)) && ok;
      if (ok) { onDone(); onClose(); }
    }
  };
  return (
    <Modal title={`${mode === 'new' ? 'Assign crew' : 'Add to crew'} · ${t.serial} · ${t.routeStep}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <Busy busy={!!busy} className="btn primary" disabled={!crew.length || (mode === 'new' && !ws) || crew.length + t.crew.length > max} onClick={submit}>Assign {crew.length || ''}</Busy></>}>
      <p className="small">Crew minimum <b>{t.minCrew}</b>, standard <b>{t.stdCrew ?? '—'}</b>, maximum <b>{t.maxCrew ?? '—'}</b>. Skill required: <b>{t.requiredSkill || 'none'}</b>.</p>
      {mode === 'new' && <div className="field"><label>Station</label>{t.freeStations.length ? <div className="seg">{t.freeStations.map(s => <button key={s} aria-pressed={ws === s} onClick={() => setWs(s)}>{s}</button>)}</div> : <Banner tone="warn">No free station in {t.workCenterId}.</Banner>}</div>}
      <div className="field"><label>Qualified people (only people with a valid {t.requiredSkill || ''} qualification are listed)</label>
        {people.length === 0 ? <Banner tone="warn">Nobody else is qualified. Add qualifications under Administration → Workers.</Banner>
          : <div className="stack tight">{people.map(w => <label key={w.workerId} className="check"><input type="checkbox" checked={crew.includes(w.workerId)} onChange={() => toggle(w.workerId)} />
            <span>{w.name} <span className="small muted mono">{w.workerId}</span> · {w.clockedIn ? 'clocked in' : 'not clocked in (can be assigned; starts after clocking in)'}{w.busy ? ' · currently working elsewhere' : ''}</span></label>)}</div>}
      </div>
      {crew.length + t.crew.length < t.minCrew && <Banner tone="warn">Below the minimum crew: the work can be assigned but cannot progress until {t.minCrew} people are working.</Banner>}
    </Modal>
  );
}

function InspectorModal({ t, onClose, onDone }) {
  const { run, busy } = useCommand();
  const [inspectorId, setId] = useState(t.assignedInspectorId || '');
  return <Modal title={`Assign inspector · ${t.serial}`} onClose={onClose} footer={<Busy busy={!!busy} className="btn primary" disabled={!inspectorId} onClick={async () => { if (await run('INSPECTION_ASSIGN', { unitId: t.unitId, inspectorId }, 'Inspector assigned', onDone)) onClose(); }}>Assign inspector</Busy>}>
    <p>The inspector sees this tank in their operator Work screen after signing in and clocking in. Assignment does not start the inspection.</p>
    <select className="select" value={inspectorId} onChange={e => setId(e.target.value)}><option value="">Select a qualified inspector</option>{t.qualifiedInspectors.map(w => <option key={w.workerId} value={w.workerId}>{w.name} · {w.workerId}</option>)}</select>
    <p className="small muted">The server also checks independence: nobody may approve their own production work.</p>
  </Modal>;
}
