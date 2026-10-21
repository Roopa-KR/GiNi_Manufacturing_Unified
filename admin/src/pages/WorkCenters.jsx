import { Bars, ProgressMeter } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { useRouter, useWorkCenterIds } from '../lib/hooks.jsx';
import { hhmm, human, mins, num } from '../lib/fmt.js';
import { Busy, Card, ErrorState, Icon, Kind, Loading, Modal, Status, Empty, Banner } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { TankLink } from '../components/PassportSections.jsx';

export default function WorkCenters({ wc: wcProp }) {
  const { navigate } = useRouter();
  const { ids, loading: idsLoading } = useWorkCenterIds();
  const wc = wcProp || ids[0] || null;
  const { data, error, loading, reload } = useView(wc ? `/work-centers/${wc}` : null);
  const { run, busy } = useCommand();
  const [dispatch, setDispatch] = useState(null);
  const [assign, setAssign] = useState(null);
  const [breakdown, setBreakdown] = useState(null);
  return (
    <div className="page">
      <div className="row between">
        <h1>Work centres</h1>
        <div className="tabs" role="tablist">{ids.map(w => <button key={w} role="tab" aria-selected={wc === w} onClick={() => navigate(`/work-centers/${w}`)}>{w}</button>)}</div>
      </div>
      {!wc && ids.length === 0 && !idsLoading ? <Empty icon="factory">No work centre is configured yet. Add work centres and stations under Factory setup → Work centres.</Empty> : null}
      {!wc ? null : !data && loading ? <Loading lines={8} /> : !data ? <ErrorState error={error} onRetry={reload} /> : <>
        <div className="row between"><h2>{data.workCenterId} · {data.name}</h2><span className="small muted">queue capacity {data.queueCapacity ?? 'not configured'}</span></div>
        {data.forecast && <Card className="flat" title="Forecast for this work centre" actions={<Kind kind="FORECAST" />}>
          <div className="grid four">
            <div className="stat"><b>{human(data.forecast.STATUS)}</b><span>status</span></div>
            <div className="stat"><b>{human(data.forecast.LIMITING_CONSTRAINT)}</b><span>limiting constraint</span></div>
            <div className="stat"><b>{num(data.forecast.LOAD_STD_MIN)}</b><span>remaining standard labour-min</span></div>
            <div className="stat"><b>{num(data.forecast.AVAILABLE_LABOR_MIN)}</b><span>qualified labour-min to shift end ({data.forecast.QUALIFIED_PEOPLE} people)</span></div>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>Unit-minutes waiting by cause: {Object.entries(data.forecast.WAIT_UNIT_MIN || {}).map(([k, v]) => `${human(k)} ${v}`).join(' · ') || 'none'} · {data.forecast.EFFICIENCY_BASIS}</div>
        </Card>}
        <div className="grid two"><Bars title="People at this work centre" unit="people" rows={Object.entries(data.workers.reduce((a,w)=>(a[w.plantState]=(a[w.plantState]||0)+1,a),{})).map(([label,value])=>({label,value}))}/><Bars title="Forecast workload and available labour" note="Standard work demand compared with qualified labour remaining. This is a forecast, not measured output." unit="min" rows={[{label:'Remaining standard work',value:data.forecast?.LOAD_STD_MIN},{label:'Available qualified labour',value:data.forecast?.AVAILABLE_LABOR_MIN,color:'var(--planned)'}]}/></div>
        <div className="section-title">Workstations</div>
        <div className="grid three">
          {data.stations.map(s => (
            <Card key={s.workstationId} className="flat">
              <div className="row between"><b>{s.workstationId}</b>{s.equipmentId && <Status value={s.equipmentStatus || 'UP'} label={`${s.equipmentId} ${s.equipmentStatus === 'DOWN' ? 'down' : 'up'}`} />}</div>
              <div className="small muted">{s.name} · {human(s.type)}</div>
              {s.unit ? <div className="stack tight" style={{ marginTop: 8 }}>
                <TankLink id={s.unit.unitId}>{s.unit.serial}</TankLink>
                <Status value={s.unit.state} />
                {s.operation && <span className="small">{s.operation.operationId} · progress {Math.round((s.operation.progressFraction || 0) * 100)}% (engine labour progress) · crew {s.crewNames.join(', ') || 'none'}</span>}
              </div> : <div className="small muted" style={{ marginTop: 8 }}>Free</div>}
              {s.operation && <ProgressMeter label="Engine labour progress" value={s.operation.progressFraction == null ? null : s.operation.progressFraction*100} total={100} note="Work estimate only; inspection and release remain separate." />}
              <div className="btn-row" style={{ marginTop: 8 }}>
                {s.operation && ['CREATED', 'WORKING', 'PAUSED', 'BELOW_MIN_CREW'].includes(s.operation.state) && <button className="btn sm" onClick={() => setAssign(s.operation)}><Icon name="users" size={14} />Assign</button>}
                {s.equipmentId && s.equipmentStatus !== 'DOWN' && <button className="btn sm" onClick={() => setBreakdown(s.equipmentId)}><Icon name="wrench" size={14} />Breakdown</button>}
                {s.equipmentId && s.equipmentStatus === 'DOWN' && <Busy busy={busy === 'EQUIPMENT_REPAIRED' + s.equipmentId} className="btn sm ok" onClick={() => run('EQUIPMENT_REPAIRED', { equipmentId: s.equipmentId }, `${s.equipmentId} repaired`, reload)}>Mark repaired</Busy>}
              </div>
            </Card>
          ))}
        </div>
        <div className="grid two">
          <Card title={`Queue (${data.queue.length})`} icon="queue">
            {data.queue.length === 0 ? <Empty>No tank queued.</Empty> : <div className="table-wrap"><table className="table">
              <thead><tr><th>#</th><th>Tank</th><th>State</th><th>Priority</th><th className="num">Waiting</th><th /></tr></thead>
              <tbody>{data.queue.map(u => <tr key={u.unitId}><td>{u.rank}</td><td><TankLink id={u.unitId}>{u.serial}</TankLink></td><td><Status value={u.state} /></td><td>{u.priorityClass}</td><td className="num">{mins(u.waitedMin)}</td>
                <td><button className="btn sm primary" onClick={() => setDispatch(u)}>Dispatch</button></td></tr>)}</tbody></table></div>}
          </Card>
          <Card title={`People here (${data.workers.length})`} icon="users">
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Name</th><th>State</th><th>Station</th><th>Qualified</th></tr></thead>
              <tbody>{data.workers.map(w => <tr key={w.workerId} className="clickable" onClick={() => navigate(`/workforce/${w.workerId}`)}><td>{w.name}<div className="small muted mono">{w.workerId}</div></td><td><Status value={w.plantState} />{w.reason && <div className="small muted">{human(w.reason)}</div>}</td><td>{w.workstationId || '—'}</td><td>{w.qualifiedHere ? <Status value="OK" label="yes" /> : <Status value="UNKNOWN" label="no" />}</td></tr>)}</tbody></table></div>
          </Card>
        </div>
        {(data.awaitingInspection.length > 0 || data.holds.length > 0) && <Card title="Awaiting inspection / on hold">
          {[...data.awaitingInspection, ...data.holds].map(u => <div key={u.unitId} className="row between"><TankLink id={u.unitId}>{u.serial}</TankLink><Status value={u.state} /></div>)}
        </Card>}
        {dispatch && <DispatchModal u={dispatch} wc={data} onClose={() => setDispatch(null)} onDone={reload} run={run} />}
        {assign && <AssignModal op={assign} wc={data} onClose={() => setAssign(null)} onDone={reload} run={run} />}
        {breakdown && <BreakdownModal eq={breakdown} onClose={() => setBreakdown(null)} onDone={reload} run={run} />}
      </>}
    </div>
  );
}

function DispatchModal({ u, wc, onClose, onDone, run }) {
  const free = wc.stations.filter(s => !s.unit && s.equipmentStatus !== 'DOWN').map(s => s.workstationId);
  const [ws, setWs] = useState(free[0] || '');
  const people = wc.workers.filter(w => w.qualifiedHere && w.attendance === 'CLOCKED_IN' && ['WAITING', 'AVAILABLE', 'PAUSED'].includes(w.activity));
  const [crew, setCrew] = useState([]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Dispatch ${u.serial} to a workstation`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><Busy busy={busy} className="btn primary" disabled={!ws || !crew.length} onClick={async () => { setBusy(true); const r = await run('OPERATION_START', { unitId: u.unitId, workstationId: ws, crew, autoStart: true }, 'Operation started', onDone); setBusy(false); if (r) onClose(); }}>Start operation</Busy></>}>
      {free.length === 0 ? <Banner tone="warn">No free workstation with working equipment.</Banner> : <div className="field"><label>Workstation</label><div className="seg">{free.map(f => <button key={f} aria-pressed={ws === f} onClick={() => setWs(f)}>{f}</button>)}</div></div>}
      <div className="field"><label>Crew (qualified, clocked in, not working)</label>
        {people.length === 0 ? <span className="muted">Nobody qualified is free here - consider a transfer (Workforce) or Recovery options.</span> :
          <div className="stack tight">{people.map(w => <label key={w.workerId} className="check"><input type="checkbox" checked={crew.includes(w.workerId)} onChange={e => setCrew(c => e.target.checked ? [...c, w.workerId] : c.filter(x => x !== w.workerId))} />{w.name} <span className="muted small">{w.workerId} · {human(w.activity)}</span></label>)}</div>}
      </div>
      <span className="hint">The command validates qualification at the current simulated time, attendance, minimum crew and station state; it starts only with at least the minimum crew.</span>
    </Modal>
  );
}

function AssignModal({ op, wc, onClose, onDone, run }) {
  const people = wc.workers.filter(w => w.qualifiedHere && w.attendance === 'CLOCKED_IN' && !(op.crew || []).includes(w.workerId));
  const [wid, setWid] = useState('');
  return (
    <Modal title={`Assign a person to ${op.operationId} at ${op.workstationId}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!wid} onClick={async () => { const r = await run('TASK_ASSIGN', { operationInstanceId: op.operationInstanceId, workerId: wid, role: 'CREW', autoStart: false }, 'Task assigned - the person accepts/starts it', onDone); if (r) onClose(); }}>Assign</button></>}>
      <span className="small muted">Crew {op.crew.length} · min {op.minCrew} · std {op.stdCrew} · max {op.maxCrew}</span>
      <select className="select" value={wid} onChange={e => setWid(e.target.value)}><option value="">Choose a qualified person…</option>{people.map(w => <option key={w.workerId} value={w.workerId}>{w.name} ({w.workerId}) · {human(w.activity)}</option>)}</select>
    </Modal>
  );
}

function BreakdownModal({ eq, onClose, onDone, run }) {
  const [min, setMin] = useState(60);
  const [reason, setReason] = useState('RANDOM_FAILURE');
  return (
    <Modal title={`Record breakdown of ${eq}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" onClick={async () => { const r = await run('EQUIPMENT_BREAKDOWN', { equipmentId: eq, estimatedRecoveryMin: Number(min), reasonCode: reason }, `${eq} down - running work paused with an external reason`, onDone); if (r) onClose(); }}>Record breakdown</button></>}>
      <div className="field"><label>Reason</label><select className="select" value={reason} onChange={e => setReason(e.target.value)}>{['RANDOM_FAILURE', 'PARTS_DELAY', 'POWER_LOSS', 'PREVENTIVE_MAINTENANCE'].map(r => <option key={r} value={r}>{human(r)}</option>)}</select></div>
      <div className="field"><label>Estimated recovery (minutes)</label><input className="input" type="number" min="5" value={min} onChange={e => setMin(e.target.value)} /></div>
      <span className="hint">Affected crews wait with reason EQUIPMENT_DOWN; that waiting never counts against them.</span>
    </Modal>
  );
}
