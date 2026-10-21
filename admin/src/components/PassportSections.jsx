import { Steps, ProgressMeter } from './Visuals.jsx';
import React from 'react';
import { Link } from '../lib/hooks.jsx';
import { human, plantTime, dayHhmm } from '../lib/fmt.js';
import { Card, KV, Status } from './ui.jsx';

/* Renders the passport sections returned by GET /sessions/:sid/units/:unitId (TANK_PASSPORT_FIELD_MAP.md).
   null / empty -> "Not recorded" (nothing is estimated); "RESTRICTED" -> needs supervisor or quality permission. */
const UNIT_BASE = '/units';
export const NR = () => <span className="muted">Not recorded</span>;
const RESTRICTED = () => <span className="badge" title="Needs supervisor or quality permission">Restricted</span>;
export function TankLink({ id, children }) {
  if (!id) return <NR />;
  return <Link to={`${UNIT_BASE}/${encodeURIComponent(id)}`} className="mono tank-link" onClick={e => e.stopPropagation()} title={`Open the passport of ${id}`}>{children || id}</Link>;
}
function v(x, tz) {
  if (x === 'RESTRICTED') return <RESTRICTED />;
  if (x === null || x === undefined || x === '' || (Array.isArray(x) && x.length === 0)) return <NR />;
  if (typeof x === 'boolean') return x ? 'Yes' : 'No';
  if (typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x)) return plantTime(x, tz, true);
  if (typeof x === 'object' && !Array.isArray(x)) return Object.entries(x).map(([k, y]) => `${human(k)} ${y}`).join(' · ');
  return String(x);
}
const people = (list) => (list === 'RESTRICTED' ? <RESTRICTED /> : (list || []).length ? list.map(p => p.name || p.workerId).join(', ') : <NR />);

export default function PassportSections({ s, tz, access }) {
  if (!s) return null;
  const id = s.identity, cur = s.current, pr = s.progress, pe = s.people, q = s.quality, tr = s.traceability;
  return (
    <div className="stack">
      {access && access.level !== 'SUPERVISOR' && <div className="small muted">{access.note}</div>}
      <div className="grid two">
        <Card title="Identity" className="flat">
          <KV items={[['Unit ID', <span className="mono" key="u">{id.unitId}</span>], ['Serial', v(id.serial)], ['Product / model', v(id.productName ? `${id.productId} - ${id.productName}` : id.productId)],
            ['Drawing / revision', v(id.drawing ? `${id.drawing} rev ${id.drawingRevision || '?'}` : id.drawingRevision)], ['Route', v(id.routeId ? `${id.routeId} v${id.routeVersion || '?'}` : null)],
            ['Work order / line', v(id.orderId ? `${id.orderId} / ${id.orderLineId}` : null)], ['Production batch', v(id.batchId)],
            ['Replacement for', id.replacementForUnitId ? <TankLink id={id.replacementForUnitId} key="rf" /> : <NR key="rf" />], ['Replaced by', id.replacedByUnitId ? <TankLink id={id.replacedByUnitId} key="rb" /> : <NR key="rb" />],
            ['Created', v(id.createdAt, tz)]]} />
          <div className="small" style={{ marginTop: 6 }}><b>Batch membership history</b>{id.batchHistory.length === 0 ? <> - <NR /></> : id.batchHistory.map((b, k) => <div key={k}>{b.batchId} {b.parentBatchId ? `(split from ${b.parentBatchId}) ` : ''}{plantTime(b.from, tz, true)} → {b.to ? plantTime(b.to, tz, true) : 'current'} · {human(b.reason)} <span className="badge">{b.source}</span></div>)}</div>
        </Card>
        <Card title="Current state" className="flat" actions={<Status value={cur.state} />}>
          <KV items={[['Physical location', v(cur.physicalWorkCenterId ? `${cur.physicalWorkCenterId} ${cur.physicalWorkstationId || ''}` : null)],
            ['In transit', cur.inTransit ? `${cur.inTransit.from || '?'} → ${cur.inTransit.to || '?'} (arrives ${plantTime(cur.inTransit.arriveAt, tz, true)})` : <NR key="t" />],
            ['Proposed rework destination', cur.proposedReworkDestination ? `${cur.proposedReworkDestination.workCenterId} ${cur.proposedReworkDestination.workstationId || ''} (${cur.proposedReworkDestination.returnId})` : <NR key="d" />],
            ['Current attempt', cur.currentAttempt ? `${cur.currentAttempt.operationId} #${cur.currentAttempt.attemptNo || 1} ${human(cur.currentAttempt.state)}` : <NR key="a" />],
            ['Hold', cur.hold ? `${cur.hold.holdId} ${human(cur.hold.type)} at ${cur.hold.location || '?'}` : <NR key="h" />], ['Blocker', v(cur.blocker && human(cur.blocker))],
            ['Assigned crew', people(cur.assignedCrew)], ['Productive now', people(cur.productiveCrew)],
            ['Last recorded event', cur.lastEvent ? `${human(cur.lastEvent.type)} ${plantTime(cur.lastEvent.at, tz, true)} (${cur.lastEvent.source.toLowerCase()})` : <NR key="e" />],
            ['Data freshness', `${human(cur.freshness.analyticsStatus)} · operational as of ${plantTime(cur.freshness.operationalAsOf, tz, true)}`]]} />
        </Card>
      </div>
      <Card title="Progress" className="flat">
        <Steps title="Tank route and current position" steps={pr.routeSteps.map(r=>({id:r.operationId,label:r.name||r.operationId,detail:`${r.operationId} · ${human(r.status)} · ${r.attempts} attempt(s)`,done:['COMPLETED','PASSED'].includes(r.status),current:r.status==='CURRENT'}))}/>
        <ProgressMeter label="Current attempt milestones" value={pr.milestones.current} total={pr.milestones.defined} note="Milestones describe work progress. A tank still needs its inspection and release." />
        <KV items={[['Expected next action', v(pr.expectedNextAction)], ['Work completed (last labour)', v(pr.workCompletedAt, tz)], ['Inspection passed (last gate PASS)', v(pr.inspectionPassedAt, tz)],
          ['Final release', v(pr.finalReleaseAt, tz)], ['Rework loops', pr.reworkLoops], ['Milestones (current attempt)', pr.milestones.current === null ? <NR key="m" /> : `${pr.milestones.current} of ${pr.milestones.defined ?? '?'}`],
          ['Forecast next movement', <span key="f">{v(pr.forecast.nextMovementAt, tz)} <span className="badge forecast">◇ Forecast</span></span>], ['Forecast line completion', <span key="l">{v(pr.forecast.lineCompletionAt, tz)} {pr.forecast.lineBand && <Status value={pr.forecast.lineBand} />}</span>]]} />
      </Card>
      <Card title="People and labour" className="flat">
        {pe.attempts.length === 0 ? <NR /> : <div className="table-wrap"><table className="table"><thead><tr><th>Attempt</th><th>Worker</th><th>Joined</th><th>Left</th><th>Minutes by category</th><th className="num">Labour min</th><th className="num">Elapsed min</th></tr></thead>
          <tbody>{pe.attempts.flatMap(a => (a.labour.length ? a.labour : [{ workerId: null }]).map((l, k) => <tr key={`${a.operationInstanceId}-${k}`}>
            <td className="mono small">{k === 0 ? `${a.operationId} ${a.operationInstanceId}` : ''}</td><td>{l.workerId ? (l.name || l.workerId) : <NR />}</td><td className="small">{v(l.joinedAt, tz)}</td><td className="small">{l.workerId ? (l.leftAt ? plantTime(l.leftAt, tz, true) : 'still on it') : ''}</td>
            <td className="small">{l.workerId ? v(l.minutesByCategory) : ''}</td><td className="num">{l.laborMin ?? (l.workerId ? '—' : '')}</td><td className="num">{k === 0 ? (a.elapsedMin ?? '—') : ''}</td></tr>))}</tbody></table></div>}
        <KV items={[['Inspectors', people(pe.inspectors)], ['Reviewers', people(pe.reviewers)], ['Disposition approvers', people(pe.dispositionApprovers)], ['Action owners', people(pe.actionOwners)]]} />
      </Card>
      <Card title="Quality" className="flat">
        <div className="small"><b>Defects</b> (detected-at/by is not cause){q.defects.length === 0 ? <> - <NR /></> : q.defects.map(d => <div key={d.defectId}>{d.defectId} {d.code} · detected {plantTime(d.detectedAt, tz, true)} by {d.detectedBy || 'not recorded'} at {d.detectedAtWorkCenter || d.detectionStage || 'not recorded'} · suspected origin {d.suspectedOriginOperation || 'not recorded'} <span className="badge">{d.source}</span></div>)}</div>
        <div className="small" style={{ marginTop: 6 }}><b>Investigations</b>{q.investigations.length === 0 ? <> - <NR /></> : q.investigations.map(i => <div key={i.investigationId}>{i.investigationId} · {human(i.status)} · cause {human(i.cause)} · responsible {i.responsible === 'RESTRICTED' ? <RESTRICTED /> : (i.responsible.length ? i.responsible.map(r => `${r.partyId || r.partyType}${r.share ? ` (${r.share})` : ''}`).join(', ') : 'none confirmed')} · reviewer {i.reviewedBy || 'not recorded'} <span className="badge">{i.source}</span></div>)}</div>
        <div className="small" style={{ marginTop: 6 }}><b>Returns / reinspection</b>{q.returns.length === 0 ? <> - <NR /></> : q.returns.map((r, k) => <div key={k}>{r.returnId} · {human(r.reworkType)} → {r.destination || 'pending'} ({human(r.basis)}){r.alternateApprovedBy ? ` · alternate approved by ${r.alternateApprovedBy}` : ''} · {human(r.loopStatus)} <span className="badge">{r.source}</span></div>)}</div>
        <div className="small" style={{ marginTop: 6 }}><b>Dispositions</b>{q.dispositions.length === 0 ? <> - <NR /></> : q.dispositions.map((d, k) => <div key={k}>{human(d.decision)} {d.result ? `(${d.result})` : ''} by {d.decidedBy || 'not recorded'} {plantTime(d.decidedAt, tz, true)} <span className="badge">{d.source}</span></div>)}</div>
      </Card>
      <Card title="Traceability" className="flat">
        <KV items={[['Material lot', v(tr.materialLotId)], ['Equipment used', v(tr.equipment.join(', '))], ['Material events', tr.materialEvents.length ? tr.materialEvents.map(m => `${human(m.type)} ${m.materialId} ${m.lot || ''} ×${m.qty}`).join('; ') : <NR key="m" />],
          ['Late records (event time vs known-at)', tr.lateRecords.length ? tr.lateRecords.slice(0, 8).map(l => `${human(l.type)} +${l.lateMin} min`).join('; ') : <NR key="l" />],
          ['Related alerts', tr.alerts.length ? tr.alerts.map(a => `${a.ruleId} ${human(a.evaluation)}`).join('; ') : <NR key="a" />], ['Recovery actions', tr.recoveryActions.length ? tr.recoveryActions.map(a => `${a.actionId} ${human(a.status)}`).join('; ') : <NR key="r" />],
          ['Replacement records', tr.replacement.length ? tr.replacement.map(r => <span key={r.requestId}>{r.requestId}: <TankLink id={r.scrappedUnitId} /> → {r.newUnitId ? <TankLink id={r.newUnitId} /> : 'not released'} ({human(r.status)}) </span>) : <NR key="p" />]]} />
        <div className="small" style={{ marginTop: 6 }}><b>Points evidence</b> {tr.points.length === 0 ? <NR /> : <div className="table-wrap"><table className="table"><thead><tr><th>Transaction</th><th>Worker</th><th>Rule</th><th className="num">Points</th><th>Status</th><th>Known at</th></tr></thead>
          <tbody>{tr.points.map(p => <tr key={p.transactionId}><td className="mono small">{p.transactionId}{p.reverses ? <div className="muted">reverses {p.reverses}</div> : null}</td><td>{p.workerId}</td><td>{p.rule}</td><td className="num">{Number(p.delta).toFixed(2)}</td><td className="small">{human(p.status)}</td><td className="small">{plantTime(p.knownAt, tz, true)} <span className="badge">{p.scope}</span></td></tr>)}</tbody></table></div>}</div>
      </Card>
    </div>
  );
}

/** label scans of this tank (barcode / camera / typed serial): who confirmed which tank, where and when */
const SCAN_PURPOSE = { CONFIRM_TASK: 'Confirm before work', CONFIRM_UNIT: 'Confirm before joining', CONFIRM_INSPECTION: 'Confirm before inspection', LOCATE: 'Location', LOOKUP: 'Look-up' };
const SCAN_RESULT = { MATCH: ['ok', 'Correct tank'], FOUND: ['info', 'Found'], WRONG_TANK: ['bad', 'Wrong tank'], STATION_NOT_TANK: ['warn', 'Station label, not a tank'], UNKNOWN: ['warn', 'Unknown code'], STATION: ['info', 'Station'] };
export function ScanHistory({ scans }) {
  if (!scans) return null;
  const rows = scans.rows || [];
  return (
    <Card title={`Label scans (${rows.length})`} icon="scan">
      {scans.lastLocation && <p className="small"><b>Last scanned location:</b> station {scans.lastLocation.stationId}{scans.lastLocation.workCenterId ? ` (${scans.lastLocation.workCenterId})` : ''} · {dayHhmm(scans.lastLocation.atLocal)}</p>}
      {rows.length === 0 ? <p className="small muted">No label scan recorded for this tank yet.</p> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Purpose</th><th>Result</th><th>Station</th><th>Method</th></tr></thead>
          <tbody>{rows.map(r => { const [tone, label] = SCAN_RESULT[r.result] || ['info', human(r.result)]; return (
            <tr key={r.scanId}><td className="small">{dayHhmm(r.atLocal)}</td><td>{r.name || r.workerId || '—'}</td><td className="small">{SCAN_PURPOSE[r.purpose] || human(r.purpose)}</td>
              <td><span className={`badge ${tone}`}>{label}</span>{r.result === 'WRONG_TANK' && r.scannedUnitId ? <span className="small muted"> scanned {r.code}</span> : null}</td>
              <td className="mono small">{r.stationId || '—'}</td><td className="small">{r.method === 'CAMERA' ? 'Camera' : 'Scanner / typed'}</td></tr>); })}</tbody>
        </table></div>)}
      <p className="hint">{scans.note}</p>
    </Card>
  );
}
