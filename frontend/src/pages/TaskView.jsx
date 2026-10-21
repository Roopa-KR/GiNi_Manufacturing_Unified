import React from 'react';
import { useApp, usePoll, useRouter } from '../lib/hooks.jsx';
import { hhmm, mins, human } from '../lib/fmt.js';
import { Card, ErrorState, Icon, KV, Kind, Loading, Status, Banner } from '../components/ui.jsx';
import { TankLink } from '../components/PassportSections.jsx';

/** read-only detail of one of my tasks (instruction, milestones, crew, material, time) */
export default function TaskView({ taskId }) {
  const { session } = useApp();
  const { navigate } = useRouter();
  const sid = session && session.sessionId;
  const { data, error, loading, reload } = usePoll(sid ? `/sessions/${sid}/me/tasks/${encodeURIComponent(taskId)}` : null, { interval: 10000 });
  if (!data && loading) return <div className="page"><Loading lines={6} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const { task: t, operation: op, unit: u, milestones: ms } = data;
  return (
    <div className="page">
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/')}><Icon name="back" />Work</button>
      <Card hero title={<span className="row" style={{ gap: 8 }}><Icon name="tank" /><TankLink id={u.unitId}>{u.serial || u.unitId}</TankLink> · {op.operationId}</span>} actions={<Status value={t.status} lg />}>
        <div className="grid two">
          <KV items={[['Task', t.taskId], ['Role', human(t.role)], ['Assigned', t.assignedAt ? String(t.assignedAt).slice(11, 16) + ' UTC' : '—'], ['Attempt', `#${op.attemptNo} (${op.instanceType})`], ...(op.reworkStandard ? [['Rework standard', op.reworkStandard.status === 'APPROVED' ? `${op.reworkStandard.minutes} min - approved ${op.reworkStandard.standardId} v${op.reworkStandard.version} by ${op.reworkStandard.approvedBy}` : `PROVISIONAL - ${op.reworkStandard.minutes} min synthetic planning value; time points pending an approved standard`]] : []), ['Station', op.workstationId], ['Order line', data.order.orderLineId], ['Batch', data.batch.batchId], ['Drawing rev', u.drawingRevision || (data.instruction && data.instruction.drawingRevision) || '—']]} />
          <div className="stack">
            <div className="row between"><span className="muted small">My eligible time</span><Kind kind="OBSERVED" /></div>
            <b style={{ fontSize: 24 }}>{mins(data.time.eligibleElapsedMin)}</b>
            <span className="small muted">Target for crew of {data.time.crewCountForTarget}: {mins(data.time.targetElapsedMinForCrew)}</span>
            {data.forecast && <div className="row"><Kind kind="FORECAST" /><span className="small">finish {hhmm(data.forecast.finishLocal)}</span></div>}
          </div>
        </div>
      </Card>
      <Card title={`Milestones ${ms.completed}/${ms.total}`} icon="check">
        <ul className="milestones">{ms.milestones.map(m => <li key={m.milestoneId}><span className={`ms-icon ${m.done ? 'done' : ''}`}>{m.done ? '✓' : m.seq}</span><div className="stack tight"><b>{m.name}</b><span className="small muted">{m.done ? `Recorded ${hhmm(m.doneLocal)}` : 'Open'} · {human(m.provenance)}</span></div></li>)}</ul>
      </Card>
      {data.instruction && <Card title={`Instruction ${data.instruction.versionId} (rev ${data.instruction.revision})`} icon="orders">
        <Banner tone="warn">Synthetic illustrative instruction - {human(data.instruction.contentStatus)}.</Banner>
        <ol style={{ paddingLeft: 20 }}>{data.instruction.steps.map(s => <li key={s.stepNo} style={{ marginBottom: 6 }}>{s.text}</li>)}</ol>
      </Card>}
      <Card title="Crew" icon="users">{data.crew.map(c => <div key={c.workerId} className="row between"><span>{c.name} <span className="muted mono small">{c.workerId}</span></span><Status value={c.taskStatus} /></div>)}</Card>
    </div>
  );
}
