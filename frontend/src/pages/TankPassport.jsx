import React from 'react';
import { useApp, usePoll } from '../lib/hooks.jsx';
import { Card, ErrorState, Icon, Loading, Status, Banner } from '../components/ui.jsx';
import PassportSections, { ScanHistory } from '../components/PassportSections.jsx';

/** operator view of a tank passport: role-limited by the server (attribution and other people's minutes/points are restricted) */
export default function TankPassport({ unitId }) {
  const { session } = useApp();
  const sid = session && session.sessionId;
  const { data, error, loading, reload } = usePoll(sid ? `/sessions/${sid}/units/${encodeURIComponent(unitId)}` : null, { interval: 15000 });
  if (!data && loading) return <div className="page"><Loading lines={8} /></div>;
  if (!data) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  const tz = data.session.timezone;
  return (
    <div className="page">
      <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => window.history.back()}><Icon name="back" />Back</button>
      <Card hero title={<span className="row" style={{ gap: 8 }}>Tank <span className="mono">{data.sections.identity.serial || unitId}</span></span>} actions={<Status value={data.sections.current.state} lg />}>
        <span className="small muted">{data.sections.identity.unitId} · {data.sections.identity.productId || 'product not recorded'} · {data.sections.identity.orderLineId || ''}</span>
      </Card>
      {data.sections.current.state === 'SCRAPPED' && <Banner tone="warn">This tank is scrapped and stays scrapped. Demand is met by a replacement with its own ID.</Banner>}
      <PassportSections s={data.sections} tz={tz} access={data.access} />
      <ScanHistory scans={data.scans} />
    </div>
  );
}
