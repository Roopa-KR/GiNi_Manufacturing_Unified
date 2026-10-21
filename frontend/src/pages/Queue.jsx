import { Steps } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { useApp, usePoll, useRouter } from '../lib/hooks.jsx';
import { hhmm, mins, human } from '../lib/fmt.js';
import { Banner, Busy, Card, Empty, ErrorState, Icon, Kind, Loading, Modal, Status } from '../components/ui.jsx';
import { useCommand } from './Work.jsx';
import { ScanButton } from '../components/Scan.jsx';
import { TankLink } from '../components/PassportSections.jsx';

export default function Queue() {
  const { session } = useApp();
  const { navigate } = useRouter();
  const sid = session && session.sessionId;
  const { data, error, loading, reload } = usePoll(sid && session.status !== 'INITIALIZING' ? `/sessions/${sid}/me/queue` : null);
  const { run, busy } = useCommand();
  const [start, setStart] = useState(null);
  if (!data && loading) return <div className="page"><Loading lines={6} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const ro = data.session.readOnly;
  const me = data.worker.workerId;
  const scanToStart = !!(session.scanRequired && session.scanRequired.startWork);
  return (
    <div className="page">
      <div className="row between"><h1>My next tasks</h1><button className="btn sm" onClick={reload}><Icon name="refresh" size={14} />Refresh</button></div>
      <span className="hint">{data.ordering}</span>
      {ro && <Banner tone="info">Synthetic live replay is read-only.</Banner>}

      <Steps title="Assigned work at a glance" steps={data.assigned.slice(0,6).map(t=>({id:t.taskId,label:t.serial||t.unitId,detail:`${t.operationId} · ${human(t.status)} · ${t.workstationId||'Station pending'}`,current:t.status==='WORKING',done:t.status==='COMPLETED'}))}/>
      <div className="section-title">Assigned to me ({data.assigned.length})</div>
      {data.assigned.length === 0 ? <Card><Empty icon="queue">Nothing assigned to you right now.</Empty></Card> : data.assigned.map(t => (
        <Card key={t.taskId} className="flat">
          <div className="row between">
            <div className="stack tight"><b><TankLink id={t.unitId}>{t.serial || t.unitId}</TankLink> · {t.operationId}</b><span className="small muted">{t.workstationId} · task {t.taskId}{t.dueAt ? ` · priority ${t.priorityClass}` : ''}</span></div>
            <div className="row"><Status value={t.status} />{t.ready ? <Status value="READY" label="Ready" /> : <Status value="BLOCKED" label="Blocked" />}</div>
          </div>
          {t.blockedReasons.length > 0 && <div className="small" style={{ marginTop: 8, color: 'var(--warn)' }}>Why it cannot start: {t.blockedReasons.join(' · ')}</div>}
          <div className="btn-row" style={{ marginTop: 10 }}>
            {t.status === 'ASSIGNED' && <Busy busy={busy === 'TASK_ACCEPT'} className="btn" disabled={ro} onClick={() => run('TASK_ACCEPT', { taskId: t.taskId, expectedVersion: t.version }, 'Accepted', reload)}>Accept</Busy>}
            {['ASSIGNED', 'ACCEPTED'].includes(t.status) && <Busy busy={busy === 'TASK_START'} className="btn primary" disabled={ro || !t.ready} onClick={() => run('TASK_START', { taskId: t.taskId, expectedVersion: t.version }, 'Work started', () => navigate('/'))}>Start</Busy>}
            {t.status === 'PAUSED' && <Busy busy={busy === 'TASK_RESUME'} className="btn primary" disabled={ro || !t.ready} onClick={() => run('TASK_RESUME', { taskId: t.taskId }, 'Resumed', () => navigate('/'))}>Resume</Busy>}
            <button className="btn ghost" onClick={() => navigate(`/task/${t.taskId}`)}>Details<Icon name="chevron" /></button>
          </div>
        </Card>
      ))}

      <div className="section-title">Join a crew at my work centre ({data.joinable.length})</div>
      {data.joinable.length === 0 ? <Card className="flat"><Empty icon="users">No running operation at your work centre needs another qualified person.</Empty></Card> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Tank</th><th>Operation</th><th>Station</th><th>State</th><th className="num">Crew</th><th /></tr></thead>
          <tbody>{data.joinable.map(j => (
            <tr key={j.operationInstanceId}><td><TankLink id={j.unitId} /></td><td>{j.operationId}</td><td>{j.workstationId}</td><td><Status value={j.state} /></td>
              <td className="num">{j.crew} / std {j.stdCrew} (min {j.minCrew})</td>
              <td>{scanToStart && !ro
                ? <ScanButton className="btn sm primary" label="Scan & join" title={`Scan tank ${j.serial || j.unitId} to join the crew`} expect={{ unitId: j.unitId, serial: j.serial }} purpose="CONFIRM_UNIT" onMatch={() => run('TASK_JOIN', { workerId: me, operationInstanceId: j.operationInstanceId, start: true }, 'Joined the crew', () => navigate('/'))} />
                : <Busy busy={busy === 'TASK_JOIN'} className="btn sm primary" disabled={ro} onClick={() => run('TASK_JOIN', { workerId: me, operationInstanceId: j.operationInstanceId, start: true }, 'Joined the crew', () => navigate('/'))}>Join</Busy>}</td></tr>
          ))}</tbody></table></div>
      )}

      <div className="section-title">Eligible queue (qualified for the next operation)</div>
      {data.eligibleQueue.length === 0 ? <Card className="flat"><Empty>No queued tank needs a skill you are qualified for.</Empty></Card> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Tank</th><th>Next operation</th><th>Priority</th><th>Due</th><th className="num">Waiting</th><th>Readiness</th><th /></tr></thead>
          <tbody>{data.eligibleQueue.map(q => (
            <tr key={q.unitId}>
              <td><TankLink id={q.unitId}>{q.serial || q.unitId}</TankLink>{q.rework && <span className="badge warn" style={{ marginLeft: 6 }}>rework</span>}</td>
              <td>{q.operationId} · {q.workCenterId}</td>
              <td>{q.priorityClass === 1 ? '1 · rework/replacement' : q.priorityClass === 2 ? '2 · high' : '3 · normal'}</td>
              <td>{q.dueLocal ? `${q.dueLocal.slice(5, 10)} ${hhmm(q.dueLocal)}` : '—'}</td>
              <td className="num">{q.waitedMin === null ? '—' : mins(q.waitedMin)}{q.timingNote && <span title={q.timingNote} className="badge info" style={{ marginLeft: 4 }}>data note</span>}</td>
              <td>{q.ready ? <Status value="READY" label={`Ready · ${q.freeWorkstations.length} free station(s)`} /> : <span className="small" style={{ color: 'var(--warn)' }}>{q.blockedReasons.join(' · ')}</span>}</td>
              <td><button className="btn sm primary" disabled={ro || !q.ready} onClick={() => setStart(q)}>Start here</button></td>
            </tr>
          ))}</tbody></table></div>
      )}

      {!(data.session && data.session.factorySession) && <div className="section-title">Planned for me (checkpoint dispatch plan)</div>}
      {data.session && data.session.factorySession ? null : data.planned.length === 0 ? <Card className="flat"><Empty icon="clock">No forward plan rows for you.</Empty></Card> : (
        <div className="stack">{data.planned.map(p => (
          <Card key={p.planId} className="flat">
            <div className="row between"><div className="stack tight"><b><TankLink id={p.unitId} /> · {p.operationId}</b><span className="small muted">{p.workstationId} · {hhmm(p.plannedStartLocal)}–{hhmm(p.plannedEndLocal)} · sequence {p.sequence}</span></div><Kind kind="PLANNED" /></div>
            <div className="small muted" style={{ marginTop: 6 }}>{p.note}</div>
          </Card>
        ))}</div>
      )}

      {start && <StartModal q={start} onClose={() => setStart(null)} onStart={async (ws) => { const r = await run('OPERATION_START', { unitId: start.unitId, workstationId: ws, crew: [me] }, `Operation created at ${ws} - qualified colleagues can join`); setStart(null); if (r) navigate('/'); }} />}
    </div>
  );
}

function StartModal({ q, onClose, onStart }) {
  const [ws, setWs] = useState(q.freeWorkstations[0]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Start ${q.operationId} on ${q.serial || q.unitId}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><Busy busy={busy} className="btn primary" onClick={async () => { setBusy(true); await onStart(ws); setBusy(false); }}>Create operation</Busy></>}>
      <div className="field"><label>Workstation</label>
        <div className="seg" role="group">{q.freeWorkstations.map(w => <button key={w} aria-pressed={ws === w} onClick={() => setWs(w)}>{w}</button>)}</div>
      </div>
      {q.rework && <Banner tone="warn">Authorised rework returns to the same station by default; an alternate station needs a named quality approver.</Banner>}
      <span className="hint">Minimum crew {q.minCrew}. You are assigned now; the work starts when the minimum qualified crew is present (others can join from their queue).</span>
    </Modal>
  );
}
