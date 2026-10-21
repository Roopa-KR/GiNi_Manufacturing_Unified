import { Bars } from '../components/Visuals.jsx';
import React from 'react';
import { human, plantTime, mins } from '../lib/fmt.js';
import { Banner, Busy, Card, ErrorState, Loading, Status, Empty, Kind } from '../components/ui.jsx';
import { useView } from './Overview.jsx';
import { useCommand } from '../lib/cmd.jsx';
import { TankLink } from '../components/PassportSections.jsx';

function F({ f, tz }) {
  if (!f) return <span className="muted">—</span>;
  return <span><Status value={f.BAND} /> ready {plantTime(f.FORECAST_FINISH_AT, tz, true)} · {f.FORECAST_GOOD_BY_DUE ?? '—'} good by due</span>;
}

export default function Verify() {
  const { data, error, loading, reload } = useView('/actions', { interval: 6000 });
  const { run, busy } = useCommand();
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const tz = data.session.timezone;
  return (
    <div className="page">
      <h1>Decisions &amp; verification</h1>
      <Banner tone="info">{data.note}</Banner>
      {data.actions.length === 0 ? <Card><Empty icon="verify">No action proposed yet. Propose a feasible option from Recovery.</Empty></Card> : data.actions.map(a => {
        const v = a.verification;
        return (
          <Card key={a.ACTION_ID} title={`${a.ACTION_ID} · ${human(a.ACTION_TYPE)} · ${a.ORDER_LINE_ID}`} icon="verify" actions={<Status value={a.STATUS} lg />}>
            <div className="small" style={{ marginBottom: 8 }}>{a.DESCRIPTION}</div>
            <Bars title="Good tanks by due: prediction vs outcome" unit="tanks" note="Before and after are saved forecasts. Observed is shown only when reported; missing is not zero." rows={[{label:'Before action · forecast',value:a.BEFORE_FORECAST?.FORECAST_GOOD_BY_DUE,color:'var(--forecast)'},{label:'After action · forecast',value:a.AFTER_FORECAST?.FORECAST_GOOD_BY_DUE,color:'var(--planned)'},{label:'Observed by due',value:v?.observed?.goodByDue,color:'var(--ok)'}]}/>

            <div className="grid two">
              <div className="stack tight small">
                <div><Kind kind="FORECAST" /> <b>Before (immutable):</b> <F f={a.BEFORE_FORECAST} tz={tz} /></div>
                <div><Kind kind="FORECAST" /> <b>After if executed (immutable):</b> <F f={a.AFTER_FORECAST} tz={tz} /></div>
                {v && <div><Kind kind="FORECAST" /> <b>Latest forecast:</b> <F f={v.current} tz={tz} /></div>}
              </div>
              <div className="stack tight small">
                <span>Proposed {plantTime(a.PROPOSED_AT, tz, true)} by {a.PROPOSED_BY}{a.APPROVED_BY ? ` · approved by ${a.APPROVED_BY}` : ''}{a.STARTED_BY ? ` · started by ${a.STARTED_BY}` : ''}{a.COMPLETED_BY ? ` · completed by ${a.COMPLETED_BY}` : ''}</span>
                {a.STALE_REASON && <span style={{ color: 'var(--warn)' }}>{a.STALE_REASON}</span>}
                {(a.STEPS || []).map((s, k) => <span key={k}>• {human(s.type)} {s.workerName || s.workerId || ((s.unitId || s.scrappedUnitId) ? <TankLink id={s.unitId || s.scrappedUnitId} /> : null) || s.materialId || s.equipmentId || ''} {s.toWorkCenterId ? `→ ${s.toWorkCenterId}` : ''}{s.minutes ? ` ${s.minutes} min` : ''}</span>)}
                {(a.EXECUTION || []).length > 0 && <span className="muted">Executed: {a.EXECUTION.map(e => `${human(e.type)} ${e.ok ? '✓' : '✗'} ${e.ref || ''}`).join(' · ')}</span>}
              </div>
            </div>
            {v && <div className="card flat" style={{ marginTop: 10, padding: 12 }}>
              <div className="row between"><b>Verification</b><Status value={v.outcome === 'FINAL' ? 'COMPLETE' : 'PENDING'} label={v.outcome === 'FINAL' ? 'Outcome final' : 'Provisional - outcome still open'} /></div>
              <div className="small">Observed: {v.observed.goodNow} good of {v.observed.required}{v.observed.goodByDue !== undefined && v.observed.goodByDue !== null ? ` · ${v.observed.goodByDue} by due` : ''}{v.forecastErrorMin !== null ? ` · forecast error ${mins(v.forecastErrorMin)}` : ''}{v.afterForecastDriftMin !== null && v.afterForecastDriftMin !== undefined ? ` · drift vs after-forecast ${mins(v.afterForecastDriftMin)}` : ''}</div>
              {v.transfers.length > 0 && <div className="small">Transfers: {v.transfers.map(t => `${t.workerId} ${t.from}→${t.to} planned ${t.plannedMin} min, actual ${t.actualMin ?? 'in progress'}${t.errorMin !== null && t.errorMin !== undefined ? ` (${t.errorMin > 0 ? '+' : ''}${t.errorMin})` : ''}`).join(' · ')}</div>}
              {v.lessons.length > 0 && <div className="small"><b>Lessons:</b> {v.lessons.join(' · ')}</div>}
              {v.proposedEstimateUpdates.length > 0 && <div className="small muted">Proposed estimate updates (for owner review, not applied): {v.proposedEstimateUpdates.map(p => `${p.estimate} ${p.scope}: ${p.current} → ${p.observed}`).join(' · ')}</div>}
            </div>}
            <div className="btn-row" style={{ marginTop: 10 }}>
              {a.STATUS === 'PROPOSED' && <Busy busy={busy === 'ACTION_APPROVE' + a.ACTION_ID} className="btn primary" onClick={() => run('ACTION_APPROVE', { actionId: a.ACTION_ID }, 'Approved (current versions revalidated)', reload)}>Approve</Busy>}
              {a.STATUS === 'APPROVED' && <Busy busy={busy === 'ACTION_START' + a.ACTION_ID} className="btn primary" onClick={() => run('ACTION_START', { actionId: a.ACTION_ID }, 'Executed through the same command services', reload)}>Execute</Busy>}
              {a.STATUS === 'STARTED' && <Busy busy={busy === 'ACTION_COMPLETE' + a.ACTION_ID} className="btn ok" onClick={() => run('ACTION_COMPLETE', { actionId: a.ACTION_ID }, 'Completed - actual travel/handover recorded', reload)}>Mark complete</Busy>}
              {['PROPOSED', 'APPROVED'].includes(a.STATUS) && <button className="btn" onClick={() => run('ACTION_REJECT', { actionId: a.ACTION_ID, note: 'Rejected by supervisor' }, 'Rejected', reload)}>Reject</button>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
