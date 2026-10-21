import { Bars } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { human, plantTime, hhmm } from '../lib/fmt.js';
import { Busy, Card, ErrorState, Loading, Status, Empty, Banner } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { SimpleModal } from './Workforce.jsx';
import { TankLink } from '../components/PassportSections.jsx';

export default function Materials() {
  const { data, error, loading, reload } = useView('/materials', { interval: 6000 });
  const { run, busy } = useCommand();
  const [modal, setModal] = useState(null);
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const tz = data.session.timezone;
  return (
    <div className="page">
      <Bars title="Equipment availability" unit="equipment" note="Current recorded equipment states. Open the records below for recovery times and reasons." rows={Object.entries(data.equipment.reduce((a,e)=>(a[e.status]=(a[e.status]||0)+1,a),{})).map(([label,value])=>({label,value}))}/>

      <h1>Materials &amp; equipment</h1>
      <Card title="Stock" icon="box">
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Material</th><th className="num">On hand</th><th className="num">Hold</th><th className="num">Reserved</th><th className="num">Available</th><th>Note</th><th /></tr></thead>
          <tbody>{data.materials.map(m => <tr key={m.materialId}><td><b>{m.name}</b><div className="small muted mono">{m.materialId}</div></td><td className="num">{m.onHand} {m.uom}</td><td className="num">{m.hold}</td><td className="num">{m.reserved}</td>
            <td className="num"><b style={{ color: m.available <= 1 ? 'var(--bad)' : undefined }}>{m.available}</b></td><td className="small">{m.shortageReason ? human(m.shortageReason) : ''}{m.supplyAvailableLocal && <div style={{ color: 'var(--warn)' }}>supplier can deliver from {m.supplyAvailableLocal.slice(5, 16).replace('T', ' ')}</div>}</td>
            <td><button className="btn sm" onClick={() => setModal({ kind: 'request', m })}>Request</button></td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card title="Replenishment requests" icon="route">
        {data.requests.length === 0 ? <Empty>No open request.</Empty> : <div className="table-wrap"><table className="table">
          <thead><tr><th>Request</th><th>Material</th><th className="num">Qty / outstanding</th><th>Need by</th><th>Promised</th><th>Status</th><th /></tr></thead>
          <tbody>{data.requests.map(r => <tr key={r.REQUEST_ID}><td className="mono small">{r.REQUEST_ID}</td><td>{r.MATERIAL_ID}</td><td className="num">{r.QTY} / {r.outstanding}</td>
            <td className="small">{r.needByLocal ? r.needByLocal.slice(5, 16).replace('T', ' ') : '—'}{r.late && <span className="badge bad" style={{ marginLeft: 4 }}>late</span>}</td><td className="small">{r.promisedLocal ? r.promisedLocal.slice(5, 16).replace('T', ' ') : '—'}</td><td><Status value={r.STATUS} /></td>
            <td><div className="row nowrap">{r.outstanding > 0 && !['DELIVERED', 'CANCELLED'].includes(r.STATUS) && <>
              <Busy busy={busy === 'MATERIAL_DELIVERY' + r.MATERIAL_ID} className="btn sm" onClick={() => run('MATERIAL_DELIVERY', { materialId: r.MATERIAL_ID, qty: r.outstanding, requestId: r.REQUEST_ID }, 'Delivery received', reload)}>Deliver</Busy>
              <button className="btn sm" onClick={() => setModal({ kind: 'partial', r })}>Partial</button>
              <button className="btn sm" onClick={() => run('MATERIAL_REQUEST_CANCEL', { requestId: r.REQUEST_ID, reason: 'NOT_NEEDED' }, 'Request cancelled', reload)}>Cancel</button></>}</div></td></tr>)}</tbody>
        </table></div>}
      </Card>
      <Card title="Equipment" icon="wrench">
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Equipment</th><th>Station</th><th>Status</th><th>Since</th><th>Reason</th><th>Estimated recovery</th><th /></tr></thead>
          <tbody>{data.equipment.map(e => <tr key={e.equipmentId}><td className="mono">{e.equipmentId}</td><td>{e.workstationId} · {e.workCenterId}</td><td><Status value={e.status} /></td><td className="small">{e.sinceLocal ? e.sinceLocal.slice(5, 16).replace('T', ' ') : '—'}</td><td className="small">{human(e.reason)}</td><td className="small">{e.estimatedRecoveryLocal ? hhmm(e.estimatedRecoveryLocal) : '—'}</td>
            <td>{e.status === 'DOWN' ? <Busy busy={busy === 'EQUIPMENT_REPAIRED' + e.equipmentId} className="btn sm ok" onClick={() => run('EQUIPMENT_REPAIRED', { equipmentId: e.equipmentId }, 'Repaired', reload)}>Repaired</Busy> : <button className="btn sm" onClick={() => setModal({ kind: 'breakdown', e })}>Breakdown</button>}</td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card title="Recent material movements" icon="box">
        {data.movements.length === 0 ? <Empty>None in this session.</Empty> : <ul className="timeline">{data.movements.map((m, k) => <li key={k} className="session"><span className="t">{plantTime(m.at, tz)}</span><span className="d" /><span><b>{human(m.type)}</b> {m.materialId} {m.payload && m.payload.QTY !== undefined ? `· ${m.payload.QTY}` : ''} {m.payload && m.payload.UNIT_ID ? <>· <TankLink id={m.payload.UNIT_ID} /></> : ''}</span></li>)}</ul>}
      </Card>
      <Banner tone="info">Deliveries and stock come from the session's material events. Replenishment by simulated handlers follows the documented continuation policy (reorder below 75% of a day's use).</Banner>
      {modal && modal.kind === 'request' && <SimpleModal title={`Request ${modal.m.name}`} fields={[['qty', 'Quantity', 'number', 4], ['needByMin', 'Needed in (min)', 'number', 60], ['promisedMin', 'Promised in (min)', 'number', 45], ['expedite', 'Expedite', 'checkbox', false]]} onClose={() => setModal(null)} submit={v => run('MATERIAL_REQUEST', { materialId: modal.m.materialId, qty: Number(v.qty), needByMin: Number(v.needByMin), promisedMin: Number(v.promisedMin), expedite: !!v.expedite }, 'Request recorded', reload)} />}
      {modal && modal.kind === 'partial' && <SimpleModal title={`Partial delivery for ${modal.r.REQUEST_ID}`} fields={[['qty', 'Delivered quantity', 'number', Math.max(1, Math.floor(modal.r.outstanding / 2))]]} onClose={() => setModal(null)} submit={v => run('MATERIAL_DELIVERY', { materialId: modal.r.MATERIAL_ID, qty: Number(v.qty), requestId: modal.r.REQUEST_ID }, 'Partial delivery recorded', reload)} />}
      {modal && modal.kind === 'breakdown' && <SimpleModal title={`Breakdown of ${modal.e.equipmentId}`} tone="danger" confirmLabel="Record breakdown" fields={[['reasonCode', 'Reason', 'select', 'RANDOM_FAILURE', ['RANDOM_FAILURE', 'PARTS_DELAY', 'POWER_LOSS', 'PREVENTIVE_MAINTENANCE']], ['estimatedRecoveryMin', 'Estimated recovery (min)', 'number', 60]]} onClose={() => setModal(null)} submit={v => run('EQUIPMENT_BREAKDOWN', { equipmentId: modal.e.equipmentId, reasonCode: v.reasonCode, estimatedRecoveryMin: Number(v.estimatedRecoveryMin) }, 'Breakdown recorded', reload)} />}
    </div>
  );
}
