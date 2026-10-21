import React, { useState } from 'react';
import { useRouter } from '../lib/hooks.jsx';
import { human, dayHhmm, plantTime } from '../lib/fmt.js';
import { Card, ErrorState, Icon, KV, Loading, Status, Banner, Empty } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import PassportSections, { TankLink, ScanHistory } from '../components/PassportSections.jsx';
import { printLabel } from '../components/Barcode.jsx';

/** tank passport: immutable identity through every attempt, inspection, hold, return, rework and release */
export default function Passport({ unitId }) {
  const { navigate } = useRouter();
  const { data, error, loading, reload } = useView(`/units/${encodeURIComponent(unitId)}`, { interval: 15000 });
  const [tab, setTab] = useState('passport');
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const u = data.unit, id = data.identity;
  const tz = data.session.timezone;
  return (
    <div className="page">
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => window.history.back()}><Icon name="back" />Back</button>
      <Card hero title={<span className="row" style={{ gap: 8 }}><Icon name="tank" />Tank passport <span className="mono">{id.serial}</span></span>} actions={<><button className="btn sm" title="Printable label with a Code 128 barcode for the operator scanner" onClick={() => printLabel({ title: `Tank ${id.serial || id.unitId}`, code: id.serial || id.unitId, lines: [`Unit ${id.unitId}`, `Product ${u.productId}`, `Order ${u.orderId} / ${u.orderLineId}`, `Batch ${u.batchId}`] })}><Icon name="tank" />Print label</button><Status value={u.state} lg /></>}>
        <div className="grid two">
          <KV items={[['Unit ID', <span className="mono" key="u">{id.unitId}</span>], ['Product', u.productId], ['Order / line', `${u.orderId} / ${u.orderLineId}`], ['Batch', u.batchId], ['Drawing', id.drawing || '—'], ['Material lot', id.materialLot || '—']]} />
          <KV items={[['Route step', u.routeStep || '—'], ['Location', `${u.workCenterId || '—'} ${u.workstationId || ''}`], ['Priority class', u.priorityClass], ['Replacement for', id.replacementFor ? <TankLink id={id.replacementFor} key="rf" /> : 'Not recorded'], ['Replaced by', id.replacedBy ? <TankLink id={id.replacedBy} key="rb" /> : 'Not recorded'], ['Hold', u.holdId || '—']]} />
        </div>
      </Card>
      <Banner tone="info">{data.note}</Banner>
      <div className="tabs" role="tablist">
        {[['passport', 'Passport'], ['attempts', `Operation attempts (${data.attempts.length})`], ['inspections', `Inspections (${data.inspections.length})`], ['quality', `Holds, defects & returns (${data.holds.length + data.defects.length + data.returns.length})`], ['events', `Events (${data.events.length})`]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'passport' && <PassportSections s={data.sections} tz={tz} access={data.access} />}
      {tab === 'passport' && <ScanHistory scans={data.scans} />}
      {tab === 'attempts' && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Attempt</th><th>Operation</th><th>Type</th><th>Station</th><th>Started</th><th>Finished</th><th>Crew</th><th>Source</th></tr></thead>
          <tbody>{data.attempts.map(a => <tr key={a.operationInstanceId}>
            <td className="mono small">{a.operationInstanceId}<div>#{a.attemptNo || 1}</div></td><td>{a.operationId} <span className="small muted">{human(a.kind)}</span></td>
            <td>{a.instanceType && a.instanceType !== 'NORMAL' ? <span className="badge warn">{human(a.instanceType)}</span> : 'normal'}{a.reworkOf && <div className="small muted">rework of {a.reworkOf}</div>}{a.reworkStandard && <div className="small muted">{a.reworkStandard.STATUS === 'APPROVED' ? `standard ${a.reworkStandard.minutes} min · ${a.reworkStandard.STANDARD_ID} v${a.reworkStandard.VERSION} · approved by ${a.reworkStandard.APPROVED_BY}` : `standard PROVISIONAL (${a.reworkStandard.minutes} min planning value) - no time points until approved`}</div>}</td>
            <td>{a.workstationId || '—'}</td><td className="small">{plantTime(a.startedAt, tz, true)}</td><td className="small">{a.finishedAt ? plantTime(a.finishedAt, tz, true) : (a.state ? <Status value={a.state} /> : '—')}</td>
            <td className="small">{(a.crew || []).map(c => c.name).join(', ') || '—'}</td><td><span className="badge">{a.source}</span></td>
          </tr>)}</tbody></table></div>
      )}
      {tab === 'inspections' && (data.inspections.length === 0 ? <Empty icon="quality">No inspection known yet.</Empty> : data.inspections.map(i => (
        <Card key={i.inspectionId} className="flat" title={`${i.gate} · ${i.kind ? human(i.kind) : 'gate inspection'} · attempt ${i.attemptNo || 1}`} actions={<><Status value={i.result || i.status} /><span className="badge">{i.source}</span>{i.source === 'SESSION' && <button className="btn sm" onClick={() => navigate(`/inspections/${i.inspectionId}`)}>Review</button>}</>}>
          <div className="small muted">{i.inspectionId} · {i.inspector} · completed {plantTime(i.completedAt, tz, true)}{i.entryLagMin ? ` · entered ${i.entryLagMin} min later (known-at preserved)` : ''}{i.reinspectionOf ? ` · reinspection of ${i.reinspectionOf}` : ''}</div>
          {i.readings && i.readings.length > 0 && <div className="small" style={{ marginTop: 6 }}>{i.readings.map((r, k) => <span key={k} className={`badge ${r.result === 'FAIL' ? 'bad' : r.result === 'PASS' ? 'ok' : ''}`} style={{ margin: 2 }}>{r.checkId} {r.position || ''} {r.value ?? r.text ?? ''}{r.unit ? ` ${r.unit}` : ''}</span>)}</div>}
          {i.evidence && i.evidence.length > 0 && <div className="small muted">Photos: {i.evidence.map(e => `${e.evidenceId} (${human(e.status)}${e.supersedes ? `, retake of ${e.supersedes}` : ''})`).join(', ')}</div>}
        </Card>
      )))}
      {tab === 'quality' && (
        <div className="stack">
          <Card title="Holds" className="flat">{data.holds.length === 0 ? <span className="muted">None</span> : data.holds.map((h, k) => <div key={k} className="row between small"><span>{h.HOLD_ID} · {human(h.HOLD_TYPE)} · {h.HOLD_LOCATION || ''}</span><span><Status value={h.RESOLUTION || h.DECISION || 'OPEN'} /> <span className="badge">{h.source}</span></span></div>)}</Card>
          <Card title="Defects (detection is not blame)" className="flat">{data.defects.length === 0 ? <span className="muted">None</span> : data.defects.map((d, k) => <div key={k} className="small">{d.DEFECT_ID} · {d.DEFECT_CODE} · {d.DESCRIPTION || ''} · detected at {d.DETECTED_AT_WORK_CENTER_ID || d.DETECTION_STAGE || ''} · suspected origin {d.SUSPECTED_ORIGIN_OPERATION_ID || d.ORIGIN_OPERATION_ID || 'unknown'} <span className="badge">{d.source}</span></div>)}</Card>
          <Card title="Return / rework loops" className="flat">{data.returns.length === 0 ? <span className="muted">None</span> : data.returns.map((r, k) => <div key={k} className="small">{r.RETURN_ID} · {human(r.REWORK_TYPE)} · origin {r.ORIGIN_OPERATION_ID} at {r.ORIGIN_WORKSTATION_ID} → {r.AUTHORIZED_DESTINATION_WORKSTATION_ID || 'pending'} ({human(r.DESTINATION_BASIS)}) · {human(r.LOOP_STATUS)} <span className="badge">{r.source}</span></div>)}</Card>
          <Card title="Investigations" className="flat">{data.investigations.length === 0 ? <span className="muted">None</span> : data.investigations.map(i => <div key={i.INVESTIGATION_ID} className="small">{i.INVESTIGATION_ID} · {human(i.STATUS)} · cause {human(i.CAUSE_CATEGORY)}</div>)}</Card>
        </div>
      )}
      {tab === 'events' && (
        <Card className="flat"><ul className="timeline">{data.events.map((e, k) => <li key={k} className={e.source === 'SESSION' ? 'session' : ''}><span className="t">{plantTime(e.at, tz, true)}</span><span className="d" /><span><b>{human(e.type)}</b> {e.state ? `→ ${human(e.state)}` : ''} {e.workstationId || e.workCenterId || ''} {e.actor ? `· ${e.actor}` : ''} <span className="badge">{e.source}</span></span></li>)}</ul></Card>
      )}
    </div>
  );
}
