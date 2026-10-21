import { Bars, ProgressMeter } from '../components/Visuals.jsx';
import React from 'react';
import { useApp, usePoll, useRouter } from '../lib/hooks.jsx';
import { hhmm, human, mins, num, dayHhmm } from '../lib/fmt.js';
import { Card, ErrorState, Icon, Kind, Loading, Status, Banner, Empty } from '../components/ui.jsx';

export function useView(path, opts) {
  const { session } = useApp();
  const sid = session && session.sessionId;
  return usePoll(sid && session.status !== 'INITIALIZING' && path !== null ? `/sessions/${sid}${path}` : null, opts);
}

export default function Overview() {
  const { navigate } = useRouter();
  const { data, error, loading, reload } = useView('/overview');
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const p = data.people, pr = data.production;
  const fresh = !!data.session.factorySession;
  const kpis = [
    { label: 'Good output', value: pr.goodRouteCompleteSinceFork, unit: 'tanks', tone: 'ok', hint: fresh ? 'Accepted route-complete tanks (measured)' : 'Route-complete since checkpoint', onClick: () => navigate('/orders') },
    { label: 'Orders at risk', value: data.ordersAtRisk.length, unit: 'lines', tone: 'warn', hint: 'Amber/red or unknown forecast', onClick: () => navigate('/recovery') },
    { label: 'Workforce present', value: `${p.clockedIn}/${p.rostered}`, unit: 'people', tone: 'info', hint: 'Clocked in vs rostered', onClick: () => navigate('/workforce') },
    { label: 'Working now', value: p.working, unit: 'people', tone: 'brand', hint: 'Direct production activity', onClick: () => navigate('/workforce?state=WORKING') },
    { label: 'Quality holds', value: pr.onHold, unit: 'tanks', tone: 'bad', hint: 'Awaiting resolution or rework', onClick: () => navigate('/quality') },
    { label: 'Critical alerts', value: data.alerts.firing, unit: 'alerts', tone: 'bad', hint: 'Active firing conditions', onClick: () => navigate('/alerts') },
  ];

  return (
    <div className="page">
      <div className="focus-header card hero">
        <div className="row between">
          <div className="stack tight">
            <div className="row" style={{ gap: 8 }}>
              <span className="badge brand">GiNi control room</span>
              <Kind kind="OBSERVED" />
            </div>
            <h1>Shift overview</h1>
            <div className="muted small">{data.session.modeLabel} · {fresh ? `${data.session.factoryName || 'factory'} · real time` : `checkpoint ${data.session.checkpointId}`} · plant time {hhmm(data.session.simNowLocal)} {data.session.timezone}</div>
          </div>
          <div className="stack tight align-right">
            <div className="small muted">Session scope</div>
            <div className="row"><span className="badge info">{data.session.sessionId}</span></div>
            <div className="small muted">Data freshness: {data.freshness && data.freshness.analyticsStatus ? String(data.freshness.analyticsStatus).replace(/_/g, ' ').toLowerCase() : 'live'}</div>
          </div>
        </div>
      </div>

      {fresh && p.plantTotal === 0 && <Banner tone="info"><b>No workers added yet.</b> Create people and their logins under Administration → Workers (they start with zero history and are not clocked in).</Banner>}
      {fresh && data.workCenters.length === 0 && <Banner tone="info"><b>No work centre configured yet.</b> Start with Factory setup.</Banner>}
      {fresh && pr.wipActive === 0 && pr.goodRouteCompleteSinceFork === 0 && <Banner tone="info"><b>No tanks released yet.</b> Create a work order and release a batch under Orders &amp; Batches; the counts below are measured zeros, not missing data.</Banner>}
      <div className="grid four">
        {kpis.map(k => (
          <Card key={k.label} className="clickable flat focus-kpi" onClick={k.onClick}>
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div className="stack tight">
                <span className="small muted">{k.label}</span>
                <div className="stat"><b>{k.value}</b><span>{k.unit}</span></div>
              </div>
              <span className={`badge ${k.tone}`}>{k.tone === 'warn' ? 'At risk' : k.tone === 'ok' ? 'Healthy' : k.tone === 'bad' ? 'Action' : 'Live'}</span>
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>{k.hint}</div>
          </Card>
        ))}
      </div>

      <div className="grid two">
        <Card title="Production trend" icon="progress" actions={<Kind kind="OBSERVED" />}>
          <div className="stack">
            <div className="summary-row">
              <div className="summary-item ok">
                <span className="small muted">Observed good output</span>
                <strong>{pr.goodRouteCompleteSinceFork}</strong>
              </div>
              <div className="summary-item info">
                <span className="small muted">Active WIP</span>
                <strong>{pr.wipActive}</strong>
              </div>
            </div>
            <Bars title="Observed output and work in progress" note="Measured counts for this session only (accepted good, active WIP, scrap) - no placeholder or fabricated values." unit="tanks" rows={[
              { label: 'Accepted good', value: pr.goodRouteCompleteSinceFork, color: 'var(--ok)' },
              { label: 'Active WIP', value: pr.wipActive, color: 'var(--planned)' },
              { label: 'Scrapped', value: pr.scrappedSinceFork, color: 'var(--bad)' },
            ]} />
          </div>
        </Card>

        <Card title="Attention panel" icon="alert" actions={<button className="btn sm" onClick={() => navigate('/alerts')}>See all</button>}>
          {data.alerts.top.length === 0 ? <Empty icon="bell">No active alerts in this session.</Empty> : (
            <div className="stack compact-list">
              {data.alerts.top.map(a => (
                <div key={a.alertId} className="list-row clickable" onClick={() => navigate(`/alerts?alertId=${encodeURIComponent(a.alertId)}`)}>
                  <div className="stack tight">
                    <div className="row between"><b>{a.ruleName || a.ruleId}</b><Status value={a.evaluation} /></div>
                    <span className="small muted">{a.message}</span>
                    <span className="small muted">{a.entityId || 'Scope not recorded'} · {a.severity || 'unknown'} severity</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="section-title">Production flow</div>
      <div className="flow-grid">
        {data.workCenters.map(w => (
          <button className="flow-card clickable" key={w.workCenterId} onClick={() => navigate(`/work-centers/${w.workCenterId}`)}>
            <div className="row between">
              <div>
                <div className="small muted">{w.workCenterId}</div>
                <h3>{w.name}</h3>
              </div>
              <Status value={w.equipmentDown.length ? 'DOWN' : 'UP'} />
            </div>
            <div className="mini-stats">
              <span><b>{w.units.inProcess}</b> active</span>
              <span><b>{w.units.queued}</b> queued</span>
              <span><b>{w.workers.working}</b> working</span>
            </div>
            <div className="mini-foot">
              <span>{w.workers.waiting} waiting</span>
              <span>{w.units.onHold} hold</span>
            </div>
          </button>
        ))}
      </div>

      <div className="section-title">Work centre detail</div>
      <div className="grid two">
        {data.workCenters.map(wc => (
          <Card key={wc.workCenterId} className="clickable wc-card" onClick={() => navigate(`/work-centers/${wc.workCenterId}`)}>
            <div className="row between"><h2>{wc.workCenterId} · {wc.name}</h2>{wc.equipmentDown.length ? <Status value="DOWN" label={`${wc.equipmentDown.length} equipment down`} /> : <Status value="UP" label="Equipment up" />}</div>
            <div className="wc-meter">
              <div><b>{wc.workers.working}</b><span>working</span></div>
              <div><b>{wc.workers.waiting}</b><span>waiting</span></div>
              <div><b>{wc.workers.onBreak}</b><span>on break</span></div>
              <div><b>{wc.workers.present}</b><span>present</span></div>
            </div>
            <div className="wc-meter">
              <div><b>{wc.units.queued}</b><span>queued{wc.queueCapacity ? ` / ${wc.queueCapacity}` : ''}</span></div>
              <div><b>{wc.units.inProcess}</b><span>in process</span></div>
              <div><b>{wc.units.awaitingInspection}</b><span>await inspection</span></div>
              <div><b>{wc.units.onHold}</b><span>on hold</span></div>
            </div>
            {wc.queueOccupancyPct !== null && <div><div className="row between small"><span className="muted">Queue occupancy vs physical capacity</span><b>{wc.queueOccupancyPct}%</b></div><div className={`bar ${wc.queueOccupancyPct >= 85 ? '' : 'ok'}`}><i style={{ width: `${Math.min(100, wc.queueOccupancyPct)}%`, background: wc.queueOccupancyPct >= 85 ? 'var(--warn)' : undefined }} /></div></div>}
            <div className="small muted">Stations {wc.stations.occupied}/{wc.stations.total} occupied{wc.stations.down ? ` · ${wc.stations.down} down` : ''}{wc.equipmentDown.map(e => ` · ${e.equipmentId} ${human(e.reason)}`).join('')}</div>
            {wc.forecast && <div className="row" style={{ alignItems: 'flex-start' }}><Kind kind="FORECAST" /><span className="small">{human(wc.forecast.status)} · limiting: {human(wc.forecast.limitingConstraint)} · load {num(wc.forecast.loadStdMin)} std-min vs {num(wc.forecast.availableLaborMin)} qualified labour-min{wc.forecast.predictedNoWorkLocal ? ` · runs out of work ${dayHhmm(wc.forecast.predictedNoWorkLocal)}` : ''}</span></div>}
          </Card>
        ))}
      </div>

      <div className="grid two">
        <Card title="Orders at risk" icon="orders" actions={<Kind kind="FORECAST" />}>
          {data.ordersAtRisk.length === 0 ? <Empty icon="orders">No order line is AMBER, RED or UNKNOWN in the latest forecast.</Empty> : (
            <div className="stack compact-list">{data.ordersAtRisk.map(o => (
              <div key={o.ORDER_LINE_ID} className="list-row clickable" onClick={() => navigate(`/orders/${o.ORDER_LINE_ID}`)}>
                <div className="stack tight">
                  <div className="row between"><b>{o.ORDER_LINE_ID}</b><Status value={o.BAND} /></div>
                  <span className="small muted">{o.PRODUCT_ID} · {o.FORECAST_GOOD_BY_DUE}/{o.REQUIRED_GOOD_QTY} by {o.DUE_LOCAL}</span>
                </div>
              </div>
            ))}<button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/recovery')}><Icon name="route" size={14} />Open recovery</button></div>
          )}
        </Card>
        <Card title={`Alerts (${data.alerts.firing} firing / ${data.alerts.open} open)`} icon="bell" actions={<button className="btn sm" onClick={() => navigate('/alerts')}>All alerts</button>}>
          {data.alerts.top.length === 0 ? <Empty icon="bell">No open alert.</Empty> : (
            <div className="stack compact-list">{data.alerts.top.map(a => (
              <div key={a.alertId} className="list-row clickable" onClick={() => navigate(`/alerts?alertId=${encodeURIComponent(a.alertId)}`)}>
                <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <div className="stack tight">
                    <b>{a.ruleId} {a.ruleName}</b>
                    <span className="small muted">{a.message}</span>
                  </div>
                  <div className="stack tight align-right"><Status value={a.evaluation} /><Status value={a.severity} /></div>
                </div>
              </div>
            ))}</div>
          )}
        </Card>
      </div>
      <Banner tone="info">{data.note}</Banner>
    </div>
  );
}
