import { Bars } from '../components/Visuals.jsx';
import React, { useState } from 'react';
import { useApp, useRouter, useToast } from '../lib/hooks.jsx';
import { api } from '../lib/api.js';
import { human, dayHhmm, plantTime, mins } from '../lib/fmt.js';
import { Banner, Busy, Card, ErrorState, Icon, Kind, Loading, Status, Empty } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';

export default function Recovery() {
  const { session } = useApp();
  const { navigate } = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useView('/forecasts', { interval: 5000 });
  const { run, busy } = useCommand();
  const [sel, setSel] = useState(null);
  const [queued, setQueued] = useState({});
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const tz = data.session.timezone;
  const lines = data.orders.filter(o => o.BAND !== 'COMPLETE');
  const simulate = async (lineId) => {
    try { await api.post(`/sessions/${session.sessionId}/recalculate`, { kind: 'RECOVERY', orderLineId: lineId }); setQueued(q => ({ ...q, [lineId]: Date.now() })); toast(`Simulating recovery options for ${lineId} - results appear here in a few seconds`, 'ok'); } catch (e) { toast(e.message, 'bad'); }
  };
  const rec = sel ? data.recovery.filter(r => r.orderLineId === sel) : data.recovery;
  return (
    <div className="page">
      <div className="row between"><h1>Predict &amp; prescribe</h1><div className="legend"><Kind kind="FORECAST" /><span className="small">{data.method}</span></div></div>
      <Bars title="Forecast shortfall by order line" note="Required good quantity minus forecast good output by due, floored at zero. Missing forecasts remain unknown." unit="tanks" rows={lines.map(o=>({label:o.ORDER_LINE_ID,value:o.FORECAST_GOOD_BY_DUE == null ? null : Math.max(0,o.REQUIRED_GOOD_QTY-o.FORECAST_GOOD_BY_DUE),color:'var(--warn)'}))}/>
      <Card title="Good output by deadline and cutoff band" icon="orders" actions={<span className="small muted">computed {plantTime(data.ordersComputedAt)} · as of {plantTime(data.ordersAsOf, tz, true)}</span>}>
        <div className="legend" style={{ marginBottom: 8 }}><span>GREEN: ready ≤ cutoff − buffer</span><span>AMBER: inside the buffer</span><span>RED: after cutoff or quantity shortfall</span><span>UNKNOWN: not estimable</span></div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Order line</th><th>Due (cutoff)</th><th className="num">Good / required</th><th>Forecast ready (range)</th><th className="num">Good by due (range)</th><th className="num">Slack</th><th>Band</th><th>Limiting constraints</th><th /></tr></thead>
          <tbody>{lines.map(o => (
            <tr key={o.ORDER_LINE_ID} style={sel === o.ORDER_LINE_ID ? { outline: '2px solid var(--brand)' } : undefined}>
              <td style={{ whiteSpace: 'nowrap' }}><b className="clickable" onClick={() => navigate(`/orders/${o.ORDER_LINE_ID}`)}>{o.ORDER_LINE_ID}</b><div className="small muted">{o.PRODUCT_ID} · {o.ACTIVE_UNITS} active · {o.PLANNED_UNITS} planned</div></td>
              <td className="small">{o.DUE_LOCAL}<div className="muted">buffer {o.BUFFER_MIN} min</div></td>
              <td className="num">{o.GOOD_SO_FAR} / {o.REQUIRED_GOOD_QTY}</td>
              <td className="small">{o.FORECAST_FINISH_AT ? plantTime(o.FORECAST_FINISH_AT, tz, true) : '—'}{o.FORECAST_FINISH_RANGE && <div className="muted">{plantTime(o.FORECAST_FINISH_RANGE[0], tz)}–{plantTime(o.FORECAST_FINISH_RANGE[1], tz)}</div>}</td>
              <td className="num">{o.FORECAST_GOOD_BY_DUE}{o.GOOD_BY_DUE_RANGE && <div className="small muted">{o.GOOD_BY_DUE_RANGE[0]}–{o.GOOD_BY_DUE_RANGE[1]}</div>}</td>
              <td className="num">{o.SLACK_MIN === null || o.SLACK_MIN === undefined ? '—' : mins(o.SLACK_MIN)}</td>
              <td title={o.BAND_REASON}><Status value={o.BAND} />{o.CUTOFF_ELAPSED && <div className="small muted">cutoff elapsed</div>}{o.BAND !== 'GREEN' && <div className="small muted" style={{ maxWidth: 180 }}>{o.BAND_REASON}</div>}</td>
              <td className="small">{(o.LIMITING_CONSTRAINTS || []).map(c => `${human(c.constraint)} @ ${c.at}`).join(' · ') || '—'}</td>
              <td><div className="stack tight"><button className="btn sm primary" onClick={() => { setSel(o.ORDER_LINE_ID); simulate(o.ORDER_LINE_ID); }}>{queued[o.ORDER_LINE_ID] ? 'Re-run' : 'Simulate'}</button>{data.recovery.some(r => r.orderLineId === o.ORDER_LINE_ID) && <button className="btn sm" onClick={() => setSel(o.ORDER_LINE_ID)}>Show options</button>}</div></td>
            </tr>
          ))}</tbody></table></div>
        {lines.length === 0 && <Empty>No open order line in the forecast horizon.</Empty>}
      </Card>

      <div className="row between"><h2>Recovery options{sel ? ` for ${sel}` : ''}</h2>{sel && <button className="btn sm" onClick={() => setSel(null)}>Show all</button>}</div>
      {rec.length === 0 ? <Card><Empty icon="route">No recovery simulation yet. Choose “Simulate options” on an order line (AMBER/RED lines first).</Empty></Card> : rec.map(r => (
        <Card key={r.forecastId} title={`${r.orderLineId} · forecast ${r.forecastId}`} icon="route" actions={<>{r.stale ? <Status value="STALE" label="Stale - newer events exist" /> : <Status value="OK" label="Current" />}<span className="small muted">as of {plantTime(r.asOf, tz, true)}</span></>}>
          {r.stale && <Banner tone="warn">Events happened after this simulation. Proposals revalidate on approval; re-simulate for current numbers.</Banner>}
          {r.baseline && <div className="row" style={{ marginBottom: 10 }}><b>No-action baseline:</b><Status value={r.baseline.BAND} /><span className="small">ready {plantTime(r.baseline.FORECAST_FINISH_AT, tz, true)} · {r.baseline.FORECAST_GOOD_BY_DUE} good by due · shortfall {r.baseline.SHORTFALL ?? '—'}</span></div>}
          <div className="table-wrap"><table className="table">
            <thead><tr><th>#</th><th>Option</th><th>Feasibility &amp; checks</th><th>Result</th><th>Donor impact</th><th>Confidence</th><th /></tr></thead>
            <tbody>{(r.options || []).map(o => (
              <tr key={o.OPTION_ID} style={!o.FEASIBLE ? { opacity: 0.75 } : undefined}>
                <td>{o.RANK}</td>
                <td style={{ maxWidth: 360 }}><span className="badge">{human(o.ACTION_TYPE)}</span><div className="small">{o.DESCRIPTION}</div></td>
                <td className="small">{o.FEASIBLE ? <Status value="OK" label="Feasible" /> : <Status value="REJECTED" label="Rejected" />}{o.REJECTION_REASON && <div style={{ color: 'var(--bad)' }}>{o.REJECTION_REASON}</div>}
                  <details className="more"><summary>{(o.CHECKS || []).length} checks</summary>{(o.CHECKS || []).map((c, k) => <div key={k}>{c.ok ? '✓' : '✗'} {human(c.check)}: {c.detail}</div>)}</details></td>
                <td className="small">{o.RESULT ? <><Status value={o.RESULT.BAND} /> ready {plantTime(o.RESULT.FORECAST_FINISH_AT, tz, true)} · {o.RESULT.FORECAST_GOOD_BY_DUE} good by due{o.BENEFIT && <div className="muted">{o.BENEFIT.bandChange}{o.BENEFIT.finishGainMin ? ` · ${mins(o.BENEFIT.finishGainMin)} earlier` : ''}{o.BENEFIT.goodByDueGain ? ` · +${o.BENEFIT.goodByDueGain} good` : ''}</div>}</> : '—'}</td>
                <td className="small">{(o.DONOR_IMPACT || []).length === 0 ? (o.FEASIBLE ? 'none detected' : '—') : o.DONOR_IMPACT.map(d => <div key={d.orderLineId}>{d.orderLineId}: {d.bandBefore}→{d.bandAfter}{d.finishDelayMin ? `, +${d.finishDelayMin} min` : ''}</div>)}</td>
                <td>{o.CONFIDENCE ? <Status value={o.CONFIDENCE === 'HIGH' ? 'OK' : o.CONFIDENCE === 'MEDIUM' ? 'MEDIUM' : 'LOW'} label={human(o.CONFIDENCE)} /> : '—'}</td>
                <td>{o.FEASIBLE && !o.ADVISORY ? <Busy busy={busy === 'ACTION_PROPOSE'} className="btn sm primary" onClick={() => run('ACTION_PROPOSE', { forecastId: r.forecastId, optionId: o.OPTION_ID }, 'Proposed - approve and execute it under Verify', () => navigate('/verify'))}>Propose</Busy> : o.ADVISORY ? <span className="small muted">advisory</span> : null}</td>
              </tr>
            ))}</tbody></table></div>
          <div className="small muted" style={{ marginTop: 6 }}>{r.method}</div>
        </Card>
      ))}
    </div>
  );
}
