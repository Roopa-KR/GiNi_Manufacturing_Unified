import { ProgressMeter } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { useRouter, useApp, usePoll, useEnv } from '../lib/hooks.jsx';
import { newKey } from '../lib/api.js';
import { hhmm, human, dayHhmm } from '../lib/fmt.js';
import { Card, ErrorState, Icon, Kind, Loading, Status, Banner, Empty, Modal, Busy, KV } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { TankLink } from '../components/PassportSections.jsx';
import { printLabels } from '../components/Barcode.jsx';

const BUCKETS = [['QUEUED', 'Queued'], ['IN_PROCESS', 'In process'], ['AWAITING_INSPECTION', 'Awaiting inspection'], ['QUALITY_HOLD', 'Quality hold'], ['IN_TRANSFER', 'In transfer']];

export default function Orders() {
  const { navigate } = useRouter();
  const { user } = useApp();
  const env = useEnv();
  const fresh = !!(env && env.freshFactory);
  const canPlan = (user.permissions || []).some(p => ['operational_supervision', 'scenario_control'].includes(p));
  const { data, error, loading, reload } = useView('/orders', { interval: 10000 });
  const { run, busy } = useCommand();
  const [q, setQ] = useState('');
  const [band, setBand] = useState('');
  const [wizard, setWizard] = useState(false);
  const [released, setReleased] = useState(null);
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const rows = data.lines.filter(l => (!q || `${l.orderLineId} ${l.productId} ${l.customerOrderRef || ''}`.toLowerCase().includes(q.toLowerCase())) && (!band || (l.forecast && l.forecast.band) === band));
  const release = async (batchId) => { const r = await run('BATCH_RELEASE', { batchId }, null, reload); if (r) setReleased({ batchId, ...(r.result || {}) }); };
  return (
    <div className="page">
      <div className="row between"><h1>Orders &amp; batches</h1><div className="row">{canPlan && <button className="btn primary" onClick={() => setWizard(true)}><Icon name="plus" size={16} />New work order</button>}<div className="legend"><Kind kind="OBSERVED" /><Kind kind="FORECAST" /></div></div></div>
      <Banner tone="info">{data.counting}</Banner>
      {fresh && data.lines.length === 0 && <Empty icon="orders">No work orders yet. {canPlan ? 'Create the first one with “New work order” (products must be released in Factory setup first).' : 'A supervisor creates them.'}</Empty>}
      {fresh && rows.some(l => (l.plannedBatches || []).some(b => !b.released)) && <Card title="Planned batches waiting for release" icon="box">
        <p className="hint">A planned batch is not a physical tank. Releasing a batch creates its tanks (new unit IDs and serials) in one step; releasing twice never creates duplicates.</p>
        <div className="table-wrap"><table className="table"><thead><tr><th>Order</th><th>Line</th><th>Batch</th><th className="num">Tanks</th><th>Planned release</th><th /></tr></thead>
          <tbody>{rows.flatMap(l => (l.plannedBatches || []).filter(b => !b.released).map(b => <tr key={b.batchId}><td>{l.customerOrderRef || l.orderId}</td><td>{l.orderLineId} · {l.productId}</td><td className="mono">{b.batchId}</td><td className="num">{b.qty}</td><td className="small">{dayHhmm(b.plannedReleaseLocal)}</td>
            <td>{canPlan && <Busy busy={busy === 'BATCH_RELEASE'} className="btn sm primary" onClick={() => release(b.batchId)}>Release batch</Busy>}</td></tr>))}</tbody></table></div>
      </Card>}
      <div className="row">
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search order line / product" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
        <div className="seg" role="group" aria-label="Band filter">{['', 'GREEN', 'AMBER', 'RED', 'UNKNOWN', 'COMPLETE'].map(b => <button key={b || 'all'} aria-pressed={band === b} onClick={() => setBand(b)}>{b || 'All'}</button>)}</div>
      </div>
      <div className="grid two">{rows.map(l=><Card key={l.orderLineId} title={<button className="btn ghost" onClick={()=>navigate(`/orders/${l.orderLineId}`)}>{l.customerOrderRef ? `${l.customerOrderRef} · ` : ''}{l.orderLineId} →</button>} actions={l.complete ? <Status value="COMPLETE" label="Order line complete" /> : l.forecast?<Status value={l.forecast.band}/>:null}><ProgressMeter label="Accepted good tanks" value={l.goodCompleted} total={l.requiredGoodQty} note={`Due ${dayHhmm(l.dueLocal)} · ${l.scrapped||0} scrapped (not good output)`}/><p className="small muted">Forecast by due: {l.forecast?.forecastGoodByDue??'Not calculated'} · observed output is shown in the bar.{l.plannedBatches && l.plannedBatches.length ? ` · batches: ${l.plannedBatches.filter(b => b.released).length} of ${l.plannedBatches.length} released` : ''}</p>{l.forecast && l.forecast.basis && /STANDARD-BASED/.test(l.forecast.basis) && <p className="hint">Standard-based estimate (no history yet)</p>}</Card>)}</div>
      <details className="more"><summary>Compare order and batch figures</summary><div className="table-wrap"><table className="table">
        <thead><tr><th>Order line</th><th>Product</th><th>Due (plant)</th><th className="num">Required</th><th className="num">Good</th><th className="num">Scrap</th><th>Current WIP buckets</th><th className="num">Not yet released</th><th>Forecast band</th><th>Forecast good by due</th></tr></thead>
        <tbody>{rows.map(l => (
          <tr key={l.orderLineId} className="clickable" onClick={() => navigate(`/orders/${l.orderLineId}`)}>
            <td><b>{l.orderLineId}</b><div className="small muted">{l.orderId}</div></td><td>{l.productId}</td><td>{dayHhmm(l.dueLocal)}</td>
            <td className="num">{l.requiredGoodQty}</td><td className="num"><b>{l.goodCompleted}</b></td><td className="num">{l.scrapped || 0}</td>
            <td className="small">{BUCKETS.filter(([k]) => l.buckets[k]).map(([k, n]) => `${n} ${l.buckets[k]}`).join(' · ') || '—'}{l.replacementPending ? ` · replacement pending ${l.replacementPending}` : ''}</td>
            <td className="num">{l.notYetReleased}</td>
            <td>{l.forecast ? <Status value={l.forecast.band} /> : <span className="muted small">not computed</span>}</td>
            <td className="small">{l.forecast ? `${l.forecast.forecastGoodByDue ?? '—'} / ${l.requiredGoodQty}${l.forecast.finishLocal ? ` · ready ${dayHhmm(l.forecast.finishLocal)}` : ''}` : '—'}</td>
          </tr>
        ))}</tbody>
      </table></div></details>
      {rows.length === 0 && data.lines.length > 0 && <Empty icon="orders">No order line matches.</Empty>}
      {wizard && <OrderWizard onClose={() => setWizard(false)} onDone={reload} />}
      {released && <Modal title={`Batch ${released.batchId} released`} onClose={() => setReleased(null)} footer={<><button className="btn" onClick={() => printLabels((released.tanks || (released.units || []).map(u => ({ unitId: u }))).map(t => ({ title: `Tank ${t.serial || t.unitId}`, code: t.serial || t.unitId, lines: [`Unit ${t.unitId}`, `Batch ${released.batchId}`] })))}>Print tank labels</button><button className="btn primary" onClick={() => setReleased(null)}>Done</button></>}>
        {released.alreadyReleased ? <Banner tone="info">This batch was already released - no tank was created twice.</Banner> : <Banner tone="ok">{(released.tanks || released.units || []).length} tank(s) created and queued at {released.workCenterId || 'the first work centre'} (first step {released.firstOperation || '—'}, route version {released.routeVersion || '—'}).</Banner>}
        <div className="table-wrap"><table className="table"><thead><tr><th>Serial</th><th>Unit ID</th></tr></thead><tbody>{(released.tanks || (released.units || []).map(u => ({ unitId: u }))).map(t => <tr key={t.unitId}><td><b>{t.serial || '—'}</b></td><td><TankLink id={t.unitId} /></td></tr>)}</tbody></table></div>
        <p className="hint">Next: assign a crew under Dispatch &amp; assign.</p>
      </Modal>}
    </div>
  );
}

/** work-order wizard: required quantity = accepted GOOD tanks; batches must add up to it; due time in plant time */
function OrderWizard({ onClose, onDone }) {
  const { run, busy } = useCommand();
  const env = useEnv();
  const ref = usePoll('/admin/reference', { interval: 600000 });
  const products = ((ref.data || {}).products || []).filter(p => p.status === 'RELEASED');
  const tz = (env && env.timezone) || (ref.data && ref.data.timezone) || 'plant time';
  const today = (env && env.operationalDate) || new Date().toISOString().slice(0, 10);
  const plus = n => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const [key] = useState(() => newKey('order'));
  const [f, setF] = useState({ customerOrderRef: '', customerName: '', priority: 'NORMAL', note: '' });
  const [lines, setLines] = useState([{ productId: '', qty: 2, dueDate: plus(3), dueTime: '14:00', batches: '1,1', releaseDate: '', releaseTime: '' }]);
  const [done, setDone] = useState(null);
  const set = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const batchSum = l => String(l.batches || '').split(',').map(x => Number(x.trim())).filter(x => x > 0);
  const problems = lines.flatMap((l, i) => [!l.productId && `line ${i + 1}: choose a product`, !(Number.isInteger(Number(l.qty)) && Number(l.qty) > 0) && `line ${i + 1}: quantity must be a positive whole number`,
    batchSum(l).reduce((a, b) => a + b, 0) !== Number(l.qty) && `line ${i + 1}: batches ${batchSum(l).join('+') || '—'} must add up to ${l.qty}`,
    (l.releaseDate || l.releaseTime) && !(l.releaseDate && l.releaseTime) && `line ${i + 1}: give both the planned release date and time (or neither)`,
    l.releaseDate && l.releaseTime && `${l.releaseDate}T${l.releaseTime}` > `${l.dueDate}T${l.dueTime}` && `line ${i + 1}: planned release is after the due time`].filter(Boolean));
  const submit = async () => {
    const payload = { ...f, customerOrderRef: f.customerOrderRef || undefined, customerName: f.customerName || undefined, note: f.note || undefined,
      lines: lines.map(l => ({ productId: l.productId, requiredGoodQty: Number(l.qty), dueLocal: `${l.dueDate}T${l.dueTime}`, batches: batchSum(l).map(q => ({ qty: q, ...(l.releaseDate && l.releaseTime ? { plannedReleaseLocal: `${l.releaseDate}T${l.releaseTime}` } : {}) })) })) };
    const r = await run('ORDER_CREATE', payload, null, onDone);
    if (r) setDone(r.result);
  };
  void key;
  if (done) return (
    <Modal title={`Work order ${done.customerOrderRef || done.orderId} created`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <Banner tone="ok">{done.note}</Banner>
      <KV items={done.lines.map(l => [l.orderLineId, `${l.productId} · ${l.requiredGoodQty} good tank(s) · ${l.batches.length} planned batch(es): ${l.batches.join(', ')}`])} />
      <p className="hint">The batches are planned, not released: no physical tank exists yet. Release them on this page when the work should start.</p>
    </Modal>
  );
  return (
    <Modal wide title="New work order" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><Busy busy={busy === 'ORDER_CREATE'} className="btn primary" disabled={problems.length > 0} onClick={submit}>Create order</Busy></>}>
      <Banner tone="info"><b>Required quantity means accepted good tanks, not total manufacturing attempts.</b> Scrapped tanks never count; a scrapped tank is replaced through the replacement flow without increasing the demand.</Banner>
      {products.length === 0 && <Banner tone="warn">No released product yet - finish Factory setup → Products &amp; routes (with inspection checklists) first.</Banner>}
      <div className="grid four">
        <div className="field"><label>Work-order / customer reference</label><input className="input mono" value={f.customerOrderRef} onChange={e => setF({ ...f, customerOrderRef: e.target.value })} placeholder="generated when empty" /></div>
        <div className="field"><label>Customer</label><input className="input" value={f.customerName} onChange={e => setF({ ...f, customerName: e.target.value })} /></div>
        <div className="field"><label>Priority</label><select className="select" value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })}><option value="NORMAL">Normal</option><option value="HIGH">High</option></select></div>
        <div className="field"><label>Site</label><input className="input" disabled value={(env && env.factory && env.factory.siteId) || '—'} /></div>
      </div>
      {lines.map((l, i) => { const p = products.find(x => x.id === l.productId); return (
        <div key={i} className="card flat" style={{ marginTop: 8 }}>
          <div className="row between"><b>Line {i + 1}</b>{lines.length > 1 && <button className="btn sm ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Icon name="x" size={14} /></button>}</div>
          <div className="grid four">
            <div className="field"><label>Product *</label><select className="select" value={l.productId} onChange={e => set(i, 'productId', e.target.value)}><option value="">choose…</option>{products.map(p2 => <option key={p2.id} value={p2.id}>{p2.id} · {p2.name}{p2.illustrative ? ' (illustrative)' : ''}</option>)}</select>{p && <span className="hint">route version {p.routeVersion}</span>}</div>
            <div className="field"><label>Required GOOD tanks *</label><input className="input" type="number" min="1" step="1" value={l.qty} onChange={e => set(i, 'qty', e.target.value)} /></div>
            <div className="field"><label>Due date ({tz}) *</label><input className="input" type="date" value={l.dueDate} onChange={e => set(i, 'dueDate', e.target.value)} /></div>
            <div className="field"><label>Due time ({tz}) *</label><input className="input" type="time" value={l.dueTime} onChange={e => set(i, 'dueTime', e.target.value)} /></div>
            <div className="field"><label>Planned release date ({tz})</label><input className="input" type="date" value={l.releaseDate} onChange={e => set(i, 'releaseDate', e.target.value)} /><span className="hint">optional, for planning and forecasts - tanks are created only when someone presses Release batch</span></div>
            <div className="field"><label>Planned release time ({tz})</label><input className="input" type="time" value={l.releaseTime} onChange={e => set(i, 'releaseTime', e.target.value)} /></div>
            <div className="field"><label>Production batches (tanks per batch, comma separated)</label><input className="input mono" value={l.batches} onChange={e => set(i, 'batches', e.target.value)} placeholder="5,5" /><span className="hint">{batchSum(l).length} batch(es), {batchSum(l).reduce((a, b) => a + b, 0)} tank(s) planned</span></div>
          </div>
        </div>); })}
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setLines([...lines, { productId: '', qty: 1, dueDate: plus(3), dueTime: '14:00', batches: '1', releaseDate: '', releaseTime: '' }])}><Icon name="plus" size={14} />Add line</button>
      {problems.length > 0 && <Banner tone="warn">{problems.join(' · ')}</Banner>}
    </Modal>
  );
}

function AddBatch({ line, batches, onDone }) {
  const { run, busy } = useCommand();
  const [qty, setQty] = useState(1);
  const planned = batches.filter(b => !b.PARENT_BATCH_ID).reduce((a, b) => a + Number(b.PLANNED_QTY || 0), 0);
  const left = Math.max(0, line.REQUIRED_GOOD_QTY - planned);
  if (!left) return null;
  return (
    <Card className="flat" title="Plan another batch" icon="plus">
      <div className="row"><span className="small">{left} of {line.REQUIRED_GOOD_QTY} required tank(s) are not in a batch yet.</span>
        <input className="input" type="number" min="1" max={left} style={{ maxWidth: 90 }} value={qty} onChange={e => setQty(e.target.value)} aria-label="Tanks in the new batch" />
        <button className="btn sm primary" disabled={!!busy || !(Number(qty) >= 1 && Number(qty) <= left)} onClick={() => run('BATCH_CREATE', { orderLineId: line.ORDER_LINE_ID, qty: Number(qty) }, 'Batch planned', onDone)}>Create batch</button></div>
    </Card>
  );
}

export function OrderLine({ lineId }) {
  const { navigate } = useRouter();
  const { data, error, loading, reload } = useView(`/orders/${encodeURIComponent(lineId)}`, { interval: 15000 });
  const orders = useView('/orders', { interval: 30000 });
  const { run, busy } = useCommand();
  const [sel, setSel] = useState({});
  const [reason, setReason] = useState('');
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const toggle = (b, u) => setSel(s => ({ ...s, [b]: { ...(s[b] || {}), [u]: !(s[b] || {})[u] } }));
  const picked = b => Object.entries(sel[b] || {}).filter(([, v]) => v).map(([k]) => k);
  const summary = orders.data && orders.data.lines.find(l => l.orderLineId === lineId);
  const l = data.line;
  return (
    <div className="page">
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/orders')}><Icon name="back" />Orders</button>
      <Card hero title={`${l.ORDER_LINE_ID} · ${l.PRODUCT_ID}`} actions={summary && summary.forecast ? <Status value={summary.forecast.band} lg /> : null}>
        <div className="grid four">
          <div className="stat"><b>{l.REQUIRED_GOOD_QTY}</b><span>required good tanks</span></div>
          <div className="stat"><b>{summary ? summary.goodCompleted : '—'}</b><span>good (unique tanks route-complete)</span></div>
          <div className="stat"><b>{summary ? summary.wip : '—'}</b><span>active WIP</span></div>
          <div className="stat"><b>{summary ? summary.scrapped : '—'}</b><span>scrapped (never counted as good)</span></div>
        </div>
        {summary && <div className="small muted" style={{ marginTop: 10 }}>{summary.reconciliation}</div>}
        {summary && summary.forecast && <div className="row" style={{ marginTop: 10 }}><Kind kind="FORECAST" /><span className="small">{summary.forecast.forecastGoodByDue}/{l.REQUIRED_GOOD_QTY} good by due {dayHhmm(summary.dueLocal)} · ready {dayHhmm(summary.forecast.finishLocal)} · buffer deadline {dayHhmm(summary.forecast.bufferDeadlineLocal)} · {summary.forecast.basis}</span></div>}
      </Card>
      {data.line.SESSION_ID === 'S-FACTORY' && <AddBatch line={data.line} batches={data.batches} onDone={reload} />}
      {data.batches.map(b => (
        <Card key={b.BATCH_ID} title={`Batch ${b.BATCH_ID}`} icon="box" actions={<span className="row nowrap"><span className="small muted">planned {b.PLANNED_QTY}{b.PARENT_BATCH_ID ? ` · split from ${b.PARENT_BATCH_ID}` : ''} · {Object.entries(b.counts).map(([k, v]) => `${human(k)} ${v}`).join(' · ') || 'no tanks yet'}</span>
          {b.BATCH_STATUS === 'PLANNED' && <button className="btn sm primary" disabled={!!busy} onClick={() => run('BATCH_RELEASE', { batchId: b.BATCH_ID }, r => `${((r.result || {}).tanks || []).length} tank(s) created: ${((r.result || {}).tanks || []).map(t => t.serial).join(', ')}`, reload)}>Release batch</button>}</span>}>
          {b.summary && <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}><span className="badge ok">Good {b.summary.goodQty}{b.summary.demandQty !== null ? ` / ${b.summary.demandQty}` : ''}</span>{b.summary.scrappedQty > 0 && <span className="badge bad">Scrapped {b.summary.scrappedQty}</span>}{b.summary.activeQty > 0 && <span className="badge">Active {b.summary.activeQty}</span>}{b.summary.mixedStates && <span className="badge warn">Mixed states</span>}<span className="small muted">{b.summary.explanation}</span></div>}
          {picked(b.BATCH_ID).length > 0 && <div className="row" style={{ gap: 6, marginBottom: 8 }}>
            <input className="input" style={{ maxWidth: 320 }} placeholder="Reason for the split (required)" value={reason} onChange={e => setReason(e.target.value)} aria-label="Split reason" />
            <button className="btn sm primary" disabled={!!busy || reason.trim().length < 3} onClick={() => run('BATCH_SPLIT', { batchId: b.BATCH_ID, unitIds: picked(b.BATCH_ID), reason }, `Split ${picked(b.BATCH_ID).length} tank(s) from ${b.BATCH_ID}`, () => { setSel({}); setReason(''); reload(); })}>Split {picked(b.BATCH_ID).length} tank(s) into a new batch</button>
          </div>}
          <div className="table-wrap"><table className="table">
            <thead><tr><th aria-label="Select" /><th>Tank</th><th>State</th><th>Bucket</th><th>Route step</th><th>Work centre</th><th>Lineage</th><th /></tr></thead>
            <tbody>{b.tanks.map(t => (
              <tr key={t.unitId}>
                <td>{!['ROUTE_COMPLETE', 'SCRAPPED', 'RELEASED_BEFORE_WINDOW'].includes(t.state) && <input type="checkbox" aria-label={`Select ${t.unitId} for a batch split`} checked={!!(sel[b.BATCH_ID] || {})[t.unitId]} onChange={() => toggle(b.BATCH_ID, t.unitId)} />}</td>
                <td><TankLink id={t.unitId}>{t.serial || t.unitId}</TankLink></td><td><Status value={t.state} /></td><td>{human(t.bucket)}</td><td>{t.routeStep || '—'}</td><td>{t.workCenterId || '—'}</td>
                <td className="small">{t.replacementFor ? `replaces ${t.replacementFor}` : ''}{t.replacedBy ? `replaced by ${t.replacedBy}` : ''}</td>
                <td>{t.state === 'SCRAPPED' && !t.replacedBy && <button className="btn sm" disabled={!!busy} onClick={() => run('REPLACEMENT_REQUEST', { scrappedUnitId: t.unitId }, 'Replacement requested - approve it under Quality & Rework', reload)}>Request replacement</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      ))}
      {(data.membershipHistory || []).length > 0 && <Card title="Batch membership history (this session)" icon="box"><div className="small">{data.membershipHistory.map((m, k) => <div key={k}><TankLink id={m.unitId} /> · {m.batchId}{m.parentBatchId ? ` (from ${m.parentBatchId})` : ''} · {human(m.reason)} · {m.to ? 'closed' : 'current'}</div>)}</div></Card>}
      {data.extraTanks.length > 0 && <Card title="Tanks outside the planned batches (e.g. replacements)">{data.extraTanks.map(t => <div key={t.unitId} className="row between"><TankLink id={t.unitId}>{t.serial || t.unitId}</TankLink><Status value={t.state} /></div>)}</Card>}
    </div>
  );
}
