import { ProgressMeter, Steps } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { useApp, usePoll, useRouter, useToast } from '../lib/hooks.jsx';
import { command } from '../lib/api.js';
import { hhmm, mins, human, dateLong } from '../lib/fmt.js';
import { Banner, Busy, Card, Empty, ErrorState, Freshness, Icon, Kind, KV, Loading, Modal, Status, Connection } from '../components/ui.jsx';
import { ScanButton } from '../components/Scan.jsx';
import { TankLink } from '../components/PassportSections.jsx';

export const PAUSE_REASONS = [
  ['PLANNED_BREAK', 'Planned break'], ['UNPLANNED_BREAK_PERSONAL', 'Personal break'], ['MATERIAL_SHORTAGE', 'Material shortage'], ['EQUIPMENT_DOWN', 'Equipment down'],
  ['WAITING_FOR_INSTRUCTION', 'Waiting for instruction'], ['HELP_REQUESTED', 'Waiting for help'], ['OTHER', 'Other'],
];

/** run a domain command with toast feedback; returns the result or null */
export function useCommand() {
  const { session } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const run = async (type, payload, okMsg, after) => {
    if (!session) return null;
    if (session.mode === 'REPLAY') { toast('Synthetic live replay is read-only - choose an interactive session to enter activity', 'bad'); return null; }
    setBusy(type);
    try {
      const r = await command(session.sessionId, type, payload);
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
      if (after) await after(r);
      return r;
    } catch (e) {
      toast(e.code === 'VERSION_CONFLICT' ? 'Someone else changed this just now - the screen was refreshed; check and retry' : e.message, 'bad', 6500);
      if (after && e.code === 'VERSION_CONFLICT') await after(null);
      return null;
    } finally { setBusy(null); }
  };
  return { run, busy };
}

export default function Work() {
  const { session, user } = useApp();
  const { navigate } = useRouter();
  const sid = session && session.sessionId;
  const { data, error, loading, reload, at } = usePoll(sid && session.status !== 'INITIALIZING' ? `/sessions/${sid}/me/home` : null);
  const { run, busy } = useCommand();
  const [pause, setPause] = useState(null);
  const [help, setHelp] = useState(false);
  const [handover, setHandover] = useState(null);
  if (!data && loading) return <div className="page"><Loading lines={6} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const { worker: w, shift, currentTask: ct, nextActions, draftInspections } = data;
  const ro = data.session.readOnly;
  const me = { workerId: w.workerId };
  const clockedIn = shift.attendance === 'CLOCKED_IN';
  const onBreak = w.activity === 'BREAK';
  return (
    <div className="page">
      <div className="focus-header card hero operator-hero">
        <div className="row between">
          <div className="stack tight">
            <div className="row" style={{ gap: 8 }}>
              <span className="badge brand">Operator home</span>
              <Status value={shift.attendance} />
            </div>
            <h1>Hello, {w.name.split(' ')[0]}</h1>
            <div className="muted small">{dateLong(data.session.simNowLocal)} · plant time {hhmm(data.session.simNowLocal)} ({data.session.timezone})</div>
          </div>
          <div className="stack tight align-right">
            <div className="small muted">Current station</div>
            <div className="row"><b>{w.workstationId ? `${w.workstationId} (${w.workCenterId})` : '—'}</b></div>
            <div className="row"><Connection error={error} /><Freshness freshness={data.freshness} at={at} /></div>
          </div>
        </div>
      </div>
      {ro && <Banner tone="info"><b>Synthetic live replay</b> — read-only recorded history. Actions are disabled.</Banner>}
      {w.control && w.control.MODE === 'HUMAN_PAUSED' && <Banner tone="warn">Your work was kept paused for handover when you signed out. Resume when ready.</Banner>}

      <div className="grid two">
        <Card title="Current task" icon="tank" actions={<Status value={ct ? ct.task.status : 'NO_ACTIVE_TASK'} />}>
          {ct ? (
            <div className="stack">
              <div className="row between"><b>{ct.unit.serial || ct.unit.unitId}</b><span className="small muted">{ct.operation.operationId}</span></div>
              <div className="small muted">{ct.order.orderId} / {ct.batch.batchId}</div>
              <ProgressMeter label="Milestone progress" value={ct.milestones.completed} total={ct.milestones.total} note={ct.milestones.progressBasis} />
              <div className="mini-stats compact">
                <span><b>{mins(ct.time.eligibleElapsedMin)}</b> elapsed</span>
                <span><b>{mins(ct.time.targetElapsedMinForCrew)}</b> target</span>
                <span><b>{ct.crew.length}</b> crew</span>
              </div>
            </div>
          ) : <Empty icon="queue">No current task assigned.</Empty>}
        </Card>

        <Card title="Next action" icon="flag">
          {nextActions && nextActions.length > 0 ? (
            <div className="stack compact-list">{nextActions.map((a, i) => <NextAction key={i} a={a} run={run} busy={busy} ro={ro} reload={reload} navigate={navigate} me={me} />)}</div>
          ) : <Empty icon="check">No immediate follow-up required.</Empty>}
        </Card>
      </div>

      {/* ---------------------------------------------------------------- shift */}
      <Card title="My shift" icon="clock" actions={<Status value={shift.attendance} />}>
        <div className="grid two">
          <KV items={[
            ['Planned', shift.plannedStartLocal ? `${hhmm(shift.plannedStartLocal)}–${hhmm(shift.plannedEndLocal)} (shift ${shift.shiftCode || '?'})` : 'Not rostered now'],
            ['Clocked in', shift.firstClockInLocal ? hhmm(shift.firstClockInLocal) : clockedIn ? 'yes' : 'not yet'],
            ['Activity', <Status key="a" value={w.activity} />],
            ['Station', w.workstationId ? `${w.workstationId} (${w.workCenterId})` : '—'],
            shift.overtimeUntil ? ['Overtime', 'approved'] : null,
          ]} />
          <div className="stack">
            {shift.plannedStartLocal && <div><div className="row between small"><span className="muted">Shift elapsed</span><span className="num">{mins(shift.elapsedShiftMin)} · {mins(shift.remainingShiftMin)} left</span></div>
              <div className="bar" aria-hidden><i style={{ width: `${Math.min(100, (shift.elapsedShiftMin || 0) / Math.max(1, (shift.elapsedShiftMin || 0) + (shift.remainingShiftMin || 0)) * 100)}%` }} /></div></div>}
            <div className="btn-row">
              {!clockedIn && <Busy busy={busy === 'CLOCK_IN'} className="btn primary lg" disabled={ro} onClick={() => run('CLOCK_IN', { ...me, deviceId: 'OPERATOR-APP' }, 'Clocked in', reload)}><Icon name="clock" />Clock in</Busy>}
              {clockedIn && !onBreak && <Busy busy={busy === 'BREAK_START'} className="btn lg" disabled={ro} onClick={() => run('BREAK_START', { ...me, planned: false }, 'Break started - your working task is paused with reason "break"', reload)}><Icon name="pause" />Start break</Busy>}
              {clockedIn && onBreak && <Busy busy={busy === 'BREAK_END'} className="btn primary lg" disabled={ro} onClick={() => run('BREAK_END', { ...me, resume: true }, 'Break ended', reload)}><Icon name="play" />End break</Busy>}
              {clockedIn && <Busy busy={busy === 'CLOCK_OUT'} className="btn lg" disabled={ro} onClick={() => { if (window.confirm('Clock out now? Working tasks are paused (not completed).')) run('CLOCK_OUT', { ...me, pauseActiveTasks: true, deviceId: 'OPERATOR-APP' }, 'Clocked out', reload); }}><Icon name="logout" />Clock out</Busy>}
            </div>
            {!clockedIn && <span className="hint">Signing in to the app is not attendance - clock in to start work.</span>}
          </div>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- alerts about my own work area */}
      {(data.alerts || []).length > 0 && (
        <Card title="Alerts for your work area" icon="bell">
          <div className="stack">{data.alerts.map(a => <Banner key={a.alertId} tone={a.evaluation === 'FIRING' ? 'warn' : 'info'}><b>{a.ruleName || a.ruleId}</b> · {a.message} <span className="small muted">({String(a.evaluation).toLowerCase()}{a.workflow === 'ACKNOWLEDGED' ? ', a supervisor is on it' : ''})</span></Banner>)}</div>
          <span className="hint">{data.alerts[0].note}</span>
        </Card>
      )}

      {/* ---------------------------------------------------------------- current task */}
      {ct ? <TaskCard ct={ct} data={data} run={run} busy={busy} ro={ro} reload={reload} onPause={setPause} onHelp={() => setHelp(true)} onHandover={setHandover} navigate={navigate} />
        : <Card title="My current task" icon="work"><Empty icon="queue">No active task. {clockedIn ? 'Open the queue to accept or join eligible work.' : 'Clock in, then open the queue.'}<div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => navigate('/queue')}><Icon name="queue" />Open queue</button></div></Empty></Card>}

      {data.otherActiveTasks && data.otherActiveTasks.length > 0 && (
        <Card title="Other tasks assigned to me" icon="queue">
          <div className="stack">{data.otherActiveTasks.map(t => <div key={t.taskId} className="row between"><span><b><TankLink id={t.unitId} /></b> · {t.operationId}</span><span className="row"><Status value={t.status} /><button className="btn sm" onClick={() => navigate(`/task/${t.taskId}`)}>Open</button></span></div>)}</div>
        </Card>
      )}

      {draftInspections && draftInspections.length > 0 && (
        <Card title="Draft inspections" icon="quality">
          <div className="stack">{draftInspections.map(d => <div key={d.inspectionId} className="row between"><span><b><TankLink id={d.unitId} /></b> · {d.gate} · {human(d.kind)} · {d.answered} answered</span><button className="btn sm primary" onClick={() => navigate(`/inspection/${d.inspectionId}`)}>Continue</button></div>)}</div>
        </Card>
      )}

      <Card title="Points" icon="progress" actions={<button className="btn sm" onClick={() => navigate('/progress')}>Ledger</button>}>
        <div className="row between"><div className="stat"><b className="num">{Number((data.points.total || {}).TOTAL || 0).toFixed(2)}</b><span>as known at {hhmm(data.session.simNowLocal)}</span></div><span className="small muted" style={{ maxWidth: 360 }}>{data.points.pendingNote}</span></div>
      </Card>

      {pause && <PauseModal task={pause} onClose={() => setPause(null)} onPause={async (reason, note) => { await run('TASK_PAUSE', { taskId: pause.taskId, reason, note }, 'Task paused', reload); setPause(null); }} />}
      {help && <HelpModal onClose={() => setHelp(false)} onSend={async (requestType, note) => { await run('HELP_REQUEST', { ...me, requestType, note, taskId: ct && ct.task.taskId }, 'Help requested - a supervisor sees it now', reload); setHelp(false); }} />}
      {handover && <HandoverModal ct={handover} onClose={() => setHandover(null)} onSend={async (toWorkerId, note) => { await run('TASK_HANDOVER', { taskId: handover.task.taskId, toWorkerId, note }, 'Handover recorded', reload); setHandover(null); }} />}
    </div>
  );
}

function NextAction({ a, run, busy, ro, reload, navigate, me }) {
  const { session } = useApp();
  const scanForInspection = !!(session && session.scanRequired && session.scanRequired.inspection) && !ro;
  const icon = { POST_TASK_INSPECTION: 'quality', GATE_INSPECTION: 'quality', RELEASE: 'check', REWORK_RETURN: 'wrench', SUPPORT_OPEN: 'help', TRANSFER_ARRIVE: 'swap' }[a.type] || 'flag';
  let btn = null;
  if (a.type === 'POST_TASK_INSPECTION') btn = a.selfCheckId ? <button className="btn sm" onClick={() => navigate(`/inspection/${a.selfCheckId}`)}>Open</button>
    : a.canStartSelfCheck ? <Busy busy={busy === 'INSPECTION_START'} className="btn sm primary" disabled={ro} onClick={() => run('INSPECTION_START', { kind: 'SELF_CHECK', unitId: a.unitId }, null, r => r && navigate(`/inspection/${r.result.inspection.INSPECTION_ID}`))}>Start self-check</Busy> : null;
  const startInspection = () => run('INSPECTION_START', { unitId: a.unitId, inspectorId: me.workerId }, null, r => r && navigate(`/inspection/${r.result.inspection.INSPECTION_ID}`));
  if (a.type === 'GATE_INSPECTION') btn = scanForInspection
    ? <ScanButton className="btn sm primary" label="Scan & inspect" title={`Scan tank ${a.serial || a.unitId} to start the inspection`} expect={{ unitId: a.unitId, serial: a.serial }} purpose="CONFIRM_INSPECTION" onMatch={startInspection} />
    : <Busy busy={busy === 'INSPECTION_START'} className="btn sm primary" disabled={ro} onClick={startInspection}>Inspect</Busy>;
  if (a.type === 'RELEASE') btn = <Busy busy={busy === 'UNIT_RELEASE'} className="btn sm ok" disabled={ro} onClick={() => run('UNIT_RELEASE', { unitId: a.unitId }, 'Tank released to the next operation', reload)}>Release</Busy>;
  if (a.type === 'REWORK_RETURN') btn = <button className="btn sm" onClick={() => navigate('/queue')}>Open queue</button>;
  if (a.type === 'TRANSFER_ARRIVE') btn = <Busy busy={busy === 'TRANSFER_ARRIVE'} className="btn sm primary" disabled={ro} onClick={() => run('TRANSFER_ARRIVE', { ...me }, 'Arrival confirmed', reload)}>I have arrived</Busy>;
  return <div className="row between nowrap" style={{ alignItems: 'flex-start' }}><div className="row nowrap" style={{ alignItems: 'flex-start' }}><Icon name={icon} /><span>{a.text}</span></div>{btn}</div>;
}

function TaskCard({ ct, data, run, busy, ro, reload, onPause, onHelp, onHandover, navigate }) {
  const t = ct.task, op = ct.operation, u = ct.unit, ms = ct.milestones;
  const next = ms.milestones.find(m => !m.done && m.attended && !m.final);
  const finalM = ms.milestones.find(m => m.final);
  const allButFinal = ms.milestones.filter(m => !m.final).every(m => m.done || !m.attended);
  const blocked = ct.cannotStartReasons && ct.cannotStartReasons.length > 0;
  const needScan = !!(ct.scan && ct.scan.required && !ct.scan.confirmed);
  const over = ct.time.targetElapsedMinForCrew && ct.time.eligibleElapsedMin > ct.time.targetElapsedMinForCrew;
  return (
    <Card hero title={<span className="row" style={{ gap: 8 }}><Icon name="tank" />Tank <TankLink id={u.unitId}>{u.serial || u.unitId}</TankLink></span>} actions={<><Status value={t.status} lg />{op.instanceType && op.instanceType !== 'NORMAL' && <span className="badge warn">Rework attempt</span>}</>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="grid two">
          <KV items={[
            ['Operation', `${op.operationId} · ${op.name || ''}`],
            ['Attempt', `#${op.attemptNo || 1} (${op.operationInstanceId})`],
            ['Station', `${op.workstationId || '—'} · ${op.workCenterId}`],
            ['Order', `${ct.order.orderId} / ${ct.order.orderLineId}`],
            ['Batch', ct.batch.batchId],
            ['Due', ct.order.dueLocal ? `${hhmm(ct.order.dueLocal)} ${ct.order.dueLocal.slice(0, 10)}` : '—'],
          ]} />
          <div className="stack">
            <div className="row between"><span className="muted small">Eligible time on this attempt (yours)</span><Kind kind="OBSERVED" /></div>
            <div className="row" style={{ alignItems: 'baseline', gap: 6 }}><b style={{ fontSize: 28 }} className="num">{mins(ct.time.eligibleElapsedMin)}</b><span className="muted">of {mins(ct.time.targetElapsedMinForCrew)} target for crew of {ct.time.crewCountForTarget}</span></div>
            {over && <Banner tone="warn">Above the crew-size target. If something is blocking you, pause with a reason or request help - waiting for a cause outside your control is not counted against you.</Banner>}
            <span className="hint">{ct.time.basis}</span>
            {ct.forecast && <div className="row"><Kind kind="FORECAST" /><span className="small">Projected finish {hhmm(ct.forecast.finishLocal)} · {ct.forecast.basis}</span></div>}
          </div>
        </div>

        <ProgressMeter label="This task: milestones recorded" value={ms.completed} total={ms.total} note={ms.progressBasis} />
        <Steps title="Work → inspection → release" steps={[{label:'Perform work',detail:human(ct.states.workPerformed),done:ct.states.workPerformed==='WORK_COMPLETE',current:t.status==='WORKING'},{label:'Inspection',detail:human(ct.states.inspection),done:ct.states.inspection==='PASS'},{label:'Release',detail:human(ct.states.released),done:ct.states.released==='RELEASED'}]} />
        <div className="grid three">
          <div className="card flat" style={{ padding: 12 }}><div className="muted small">Work performed</div><Status value={ct.states.workPerformed} /></div>
          <div className="card flat" style={{ padding: 12 }}><div className="muted small">Inspection</div><Status value={ct.states.inspection} /></div>
          <div className="card flat" style={{ padding: 12 }}><div className="muted small">Released</div><Status value={ct.states.released} /></div>
        </div>

        {needScan && ['ASSIGNED', 'ACCEPTED', 'PAUSED'].includes(t.status) && <Banner tone="info"><b>Scan the tank first.</b> This factory requires a scan of the tank label before work starts: press <b>Confirm tank</b> and scan {u.serial} (or type it).</Banner>}
        {blocked && <Banner tone="warn"><b>Cannot start yet:</b> {ct.cannotStartReasons.join(' · ')}</Banner>}
        {ct.holds && ct.holds.length > 0 && <Banner tone="bad">On hold: {ct.holds.map(h => `${human(h.type)} (${h.holdId})`).join(', ')}</Banner>}

        <div className="btn-row">
          {ct.scan && ct.scan.confirmed ? <span className="badge ok" style={{ alignSelf: 'center' }} title={`Scan saved ${ct.scan.confirmedLocal || ''}`}><Icon name="check" size={14} />Tank confirmed {ct.scan.confirmedLocal ? hhmm(ct.scan.confirmedLocal) : ''}</span>
            : <ScanButton className={`btn lg${ct.scan && ct.scan.required ? ' primary' : ''}`} label="Confirm tank" expect={{ unitId: u.unitId, serial: u.serial }} purpose="CONFIRM_TASK" taskId={t.taskId} onMatch={() => reload()} />}
          {t.status === 'ASSIGNED' && <Busy busy={busy === 'TASK_ACCEPT'} className="btn lg" disabled={ro} onClick={() => run('TASK_ACCEPT', { taskId: t.taskId, expectedVersion: t.version }, 'Task accepted', reload)}><Icon name="check" />Accept</Busy>}
          {['ASSIGNED', 'ACCEPTED'].includes(t.status) && <Busy busy={busy === 'TASK_START'} className="btn primary lg" title={needScan ? 'Scan the tank label first (Confirm tank)' : ''} disabled={ro || blocked || needScan} onClick={() => run('TASK_START', { taskId: t.taskId, expectedVersion: t.version }, 'Work started', reload)}><Icon name="play" />Start work</Busy>}
          {t.status === 'PAUSED' && <Busy busy={busy === 'TASK_RESUME'} className="btn primary lg" disabled={ro || blocked || needScan} onClick={() => run('TASK_RESUME', { taskId: t.taskId }, 'Work resumed', reload)}><Icon name="play" />Resume</Busy>}
          {t.status === 'WORKING' && next && <Busy busy={busy === 'MILESTONE_COMPLETE'} className="btn primary lg" disabled={ro} onClick={() => run('MILESTONE_COMPLETE', { operationInstanceId: op.operationInstanceId, milestoneId: next.milestoneId }, `Milestone recorded: ${next.name}`, reload)}><Icon name="check" />Done: {next.name}</Busy>}
          {t.status === 'WORKING' && <Busy busy={busy === 'TASK_FINISH'} className="btn ok lg" disabled={ro || !allButFinal} title={allButFinal ? '' : 'Record the remaining milestones first'} onClick={() => { if (window.confirm(`Finish work on ${u.serial}? The tank then needs its post-task inspection; finishing is not a pass or a release.`)) run('TASK_FINISH', { taskId: t.taskId }, 'Work complete - inspection required next', reload); }}><Icon name="stop" />Finish work{finalM ? '' : ''}</Busy>}
          {t.status === 'WORKING' && <button className="btn lg" disabled={ro} onClick={() => onPause(t)}><Icon name="pause" />Pause</button>}
        </div>
        <div className="btn-row">
          <button className="btn" disabled={ro} onClick={onHelp}><Icon name="help" />Request help</button>
          {['WORKING', 'PAUSED', 'ACCEPTED'].includes(t.status) && <button className="btn" disabled={ro} onClick={() => onHandover(ct)}><Icon name="swap" />Hand over</button>}
          <button className="btn" onClick={() => navigate(`/defect/${u.unitId}`)} disabled={ro}><Icon name="alert" />Report incoming defect</button>
          <button className="btn ghost" onClick={() => navigate(`/task/${t.taskId}`)}>Details<Icon name="chevron" /></button>
        </div>

        <div className="grid two">
          <div className="stack">
            <div className="row between"><h3>Milestones</h3><span className="small muted">{ms.completed}/{ms.total} · {ms.progressPct ?? 0}%</span></div>
            <div className="bar ok" aria-label={`${ms.progressPct}% of milestones`}><i style={{ width: `${ms.progressPct || 0}%` }} /></div>
            <ul className="milestones">
              {ms.milestones.map(m => (
                <li key={m.milestoneId}>
                  <span className={`ms-icon ${m.done ? 'done' : next && next.milestoneId === m.milestoneId ? 'next' : ''}`} aria-hidden>{m.done ? '✓' : m.seq}</span>
                  <div className="stack tight" style={{ flex: 1 }}>
                    <span style={{ fontWeight: 600 }}>{m.name}{!m.attended && <span className="badge info" style={{ marginLeft: 6 }}>unattended</span>}</span>
                    <span className="small muted">{m.done ? `Recorded ${hhmm(m.doneLocal)} · ${human(m.basis)}` : m.final ? 'Recorded by "Finish work"' : 'Not yet'}</span>
                  </div>
                </li>
              ))}
            </ul>
            <span className="hint">{ms.progressBasis}</span>
          </div>
          <div className="stack">
            <h3>Crew ({ct.crew.length})</h3>
            <div className="stack tight">{ct.crew.map(c => <div key={c.workerId} className="row between"><span className="row nowrap"><span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{c.name.split(' ').map(x => x[0]).join('').slice(0, 2)}</span>{c.name}{c.isMe && <span className="badge brand">you</span>}</span><Status value={c.taskStatus} /></div>)}</div>
            <div className="divider" />
            <h3>Material</h3>
            {ct.material.length ? ct.material.map(m => <div key={m.materialId} className="row between small"><span>{m.name || m.materialId} · {m.qtyPerUnit} {m.uom}</span><Status value={m.status} /></div>) : <span className="muted small">No material consumed at this operation</span>}
            {ct.equipment && <><div className="divider" /><div className="row between small"><span>Equipment {ct.equipment.equipmentId}</span><Status value={ct.equipment.status} /></div></>}
          </div>
        </div>

        {ct.instruction && (
          <details className="more">
            <summary>Work instruction {ct.instruction.versionId} · rev {ct.instruction.revision} · drawing rev {ct.instruction.drawingRevision || '—'}</summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <Banner tone="warn">Illustrative synthetic instruction ({human(ct.instruction.contentStatus)}, {human(ct.instruction.approvalStatus)}) - not a Siemens work instruction.</Banner>
              {ct.instruction.tools && <div className="small"><b>Tools:</b> {ct.instruction.tools}</div>}
              {ct.instruction.ppe && <div className="small"><b>PPE:</b> {ct.instruction.ppe}</div>}
              <ol style={{ margin: 0, paddingLeft: 20 }}>{ct.instruction.steps.map(s => <li key={s.stepNo} style={{ marginBottom: 6 }}>{s.text}{s.ctq && <span className="badge info" style={{ marginLeft: 6 }}>CTQ {s.ctq}</span>}</li>)}</ol>
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

export function PauseModal({ task, onClose, onPause }) {
  const [reason, setReason] = useState('PLANNED_BREAK');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Pause work" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><Busy busy={busy} className="btn primary" onClick={async () => { setBusy(true); await onPause(reason, note); setBusy(false); }}>Pause</Busy></>}>
      <div className="field"><label>Reason</label>
        <div className="stack tight">{PAUSE_REASONS.map(([k, l]) => <label key={k} className="check"><input type="radio" name="reason" checked={reason === k} onChange={() => setReason(k)} /> {l}</label>)}</div>
      </div>
      <div className="field"><label htmlFor="pn">Note (optional)</label><input id="pn" className="input" value={note} onChange={e => setNote(e.target.value)} /></div>
      <span className="hint">Breaks, material/equipment waits and waiting for help are excluded from your speed points.</span>
    </Modal>
  );
}

function HelpModal({ onClose, onSend }) {
  const [type, setType] = useState('SUPERVISOR_SUPPORT');
  const [note, setNote] = useState('');
  return (
    <Modal title="Request help" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSend(type, note)}>Send request</button></>}>
      <div className="seg" role="group" aria-label="Help type">
        {[['SUPERVISOR_SUPPORT', 'Supervisor'], ['QUALITY_SUPPORT', 'Quality'], ['MAINTENANCE', 'Maintenance'], ['MATERIAL', 'Material']].map(([k, l]) => <button key={k} aria-pressed={type === k} onClick={() => setType(k)}>{l}</button>)}
      </div>
      <div className="field"><label htmlFor="hn">What do you need?</label><textarea id="hn" className="textarea" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. fixture clamp not closing" /></div>
    </Modal>
  );
}

function HandoverModal({ ct, onClose, onSend }) {
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const others = ct.crew.filter(c => !c.isMe);
  return (
    <Modal title="Hand over this task" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!to.trim()} onClick={() => onSend(to.trim().toUpperCase(), note)}>Hand over</button></>}>
      <div className="field"><label htmlFor="to">To employee ID</label><input id="to" className="input mono" value={to} onChange={e => setTo(e.target.value)} placeholder="W0123" list="crewlist" />
        <datalist id="crewlist">{others.map(c => <option key={c.workerId} value={c.workerId}>{c.name}</option>)}</datalist></div>
      <div className="field"><label htmlFor="hn2">Handover note</label><textarea id="hn2" className="textarea" value={note} onChange={e => setNote(e.target.value)} placeholder="Where you stopped, open points" /></div>
      <span className="hint">The receiving person must be qualified and clocked in. Your participation ends; the task stays traceable.</span>
    </Modal>
  );
}
