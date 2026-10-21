import React, { useEffect, useRef, useState } from 'react';
import { api, command } from '../lib/api.js';
import { useApp, useRouter } from '../lib/hooks.jsx';
import { Banner, Busy, Icon, Modal, Status } from './ui.jsx';

/* Scan a tank or station label. The tank label IS the tank serial (created when the batch was released); the station label is
   the station ID. Input: camera (BarcodeDetector, where the browser supports it), a handheld scanner (it types the code and
   presses Enter into the focused field) or typing. Every scan is saved by the server (SCAN_RECORD) and appears in the tank
   passport. A scan never moves the tank along its route - start / finish / inspection still do that. */

const norm = v => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
const cameraSupported = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

function Camera({ onCode, onError }) {
  const video = useRef(null);
  useEffect(() => {
    let stream = null, timer = null, alive = true;
    (async () => {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        const want = ['code_128', 'qr_code', 'code_39', 'data_matrix', 'ean_13'].filter(f => formats.includes(f));
        const detector = new window.BarcodeDetector(want.length ? { formats: want } : undefined);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!alive) return;
        video.current.srcObject = stream;
        await video.current.play();
        timer = setInterval(async () => {
          try {
            const found = await detector.detect(video.current);
            if (found && found.length && found[0].rawValue) { clearInterval(timer); onCode(found[0].rawValue, 'CAMERA'); }
          } catch (e) { /* frame not ready */ }
        }, 300);
      } catch (e) {
        onError(e && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera in the browser settings, or type the code.' : 'The camera could not be opened here (it needs HTTPS outside localhost). Type the code or use a handheld scanner.');
      }
    })();
    return () => { alive = false; if (timer) clearInterval(timer); if (stream) stream.getTracks().forEach(t => t.stop()); };
  }, []);
  return <video ref={video} muted playsInline style={{ width: '100%', maxHeight: 260, background: '#000', borderRadius: 10 }} aria-label="Camera preview for scanning" />;
}

/** one code field with camera / scanner / typing; calls onCode(code, method) */
function CodeInput({ id, label, placeholder, busy, onCode, autoFocus = true }) {
  const [code, setCode] = useState('');
  const [camera, setCamera] = useState(false);
  const [camError, setCamError] = useState(null);
  const input = useRef(null);
  useEffect(() => { if (autoFocus && input.current) input.current.focus(); }, []);
  const submit = (raw, method) => { setCamera(false); const c = norm(raw); setCode(c); onCode(c, method); };
  return (
    <div className="stack">
      <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={e => { e.preventDefault(); submit(code, 'SCANNER_OR_TYPED'); }}>
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label htmlFor={id}>{label}</label>
          <input id={id} ref={input} className="input lg mono" autoComplete="off" autoCapitalize="characters" spellCheck="false" value={code} onChange={e => setCode(e.target.value)} placeholder={placeholder} />
        </div>
        <Busy busy={busy} className="btn primary lg" type="submit">OK</Busy>
      </form>
      {cameraSupported()
        ? (camera ? <Camera onCode={submit} onError={m => { setCamera(false); setCamError(m); }} /> : <button className="btn" type="button" onClick={() => { setCamError(null); setCamera(true); }}><Icon name="scan" />Scan with camera</button>)
        : <span className="small muted">Camera scanning is not supported by this browser. A handheld barcode scanner works in the field above, or type the code.</span>}
      {camError && <Banner tone="warn">{camError}</Banner>}
    </div>
  );
}

/**
 * expect   - { unitId, serial } of the tank this person should be at (confirm mode); omitted = look-up / locate mode
 * purpose  - CONFIRM_TASK (with taskId) | CONFIRM_UNIT | CONFIRM_INSPECTION | LOOKUP
 * onMatch  - called after a matching scan was saved (e.g. start the inspection / join the crew)
 */
export function ScanDialog({ onClose, expect, purpose, taskId, onMatch, title }) {
  const { session } = useApp();
  const { navigate } = useRouter();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [located, setLocated] = useState(null);

  const record = async (code, method, extra = {}) => {
    if (code.length < 3) { setRes({ error: 'Enter at least 3 characters of the tank serial or station ID.' }); return null; }
    setBusy(true);
    try {
      const r = await command(session.sessionId, 'SCAN_RECORD', { code, method, purpose: expect ? (purpose || 'CONFIRM_UNIT') : (extra.stationCode ? 'LOCATE' : 'LOOKUP'),
        taskId: taskId || undefined, unitId: expect ? expect.unitId : undefined, device: navigator.userAgent.slice(0, 80), ...extra });
      return r.result;
    } catch (e) { setRes({ error: e.message }); return null; } finally { setBusy(false); }
  };

  const onCode = async (code, method) => {
    setLocated(null);
    const out = await record(code, method);
    if (!out) return;
    let stationTanks = [];
    if (out.station) { try { stationTanks = ((await api.get(`/sessions/${session.sessionId}/search?q=${encodeURIComponent(code)}`)).stations || []).find(s => s.workstationId === out.station.workstationId)?.tanks || []; } catch (e) { /* list only */ } }
    setRes({ ...out, stationTanks });
    if (expect && out.scan.result === 'MATCH' && onMatch) { onClose(); onMatch(out); }
  };
  const locate = async (stationCode, method) => {
    const out = await record(res.tank.serial || res.tank.unitId, method, { stationCode });
    if (out) setLocated(out);
  };

  const open = (unitId) => { onClose(); navigate(`/tanks/${encodeURIComponent(unitId)}`); };
  const r = res && !res.error ? res.scan.result : null;

  return (
    <Modal title={title || (expect ? `Confirm tank ${expect.serial || expect.unitId}` : 'Scan tank or station')} onClose={onClose}>
      <div className="stack">
        <CodeInput id="scan-code" label="Scan the label, or type the serial / station ID" placeholder="e.g. TT-26-00001" busy={busy} onCode={onCode} />
        {res && res.error && <Banner tone="warn">{res.error}</Banner>}

        {r === 'MATCH' && <Banner tone="ok"><b>Correct tank.</b> {res.tank.serial} is the right tank - confirmation saved.</Banner>}
        {r === 'WRONG_TANK' && <Banner tone="bad"><b>Wrong tank.</b> You scanned {res.tank.serial || res.tank.unitId}; this work is on {expect.serial || expect.unitId}. Do not start - check the tank and the station. (The scan was saved.)</Banner>}
        {r === 'STATION_NOT_TANK' && <Banner tone="info">That is station {res.station.workstationId}, not a tank label. Scan the label on the tank.</Banner>}
        {r === 'UNKNOWN' && <Banner tone="warn">No tank with the code {res.scan.code} in this factory. Check the label or type the serial.</Banner>}

        {!expect && r === 'FOUND' && <div className="card flat" style={{ padding: 12 }}>
          <div className="row between list-row clickable" onClick={() => open(res.tank.unitId)}><span><b>{res.tank.serial || res.tank.unitId}</b> <span className="small muted">{res.tank.unitId} · {res.tank.workCenterId || '—'} {res.tank.workstationId || ''}</span></span><Status value={res.tank.state} /></div>
          <div className="small muted" style={{ marginTop: 8 }}>Record where this tank is: scan the station label (saved in the tank history; the route step does not change).</div>
          {located ? <Banner tone="ok">Location saved: {located.tank.serial} at station {located.scan.stationId}.</Banner>
            : <CodeInput id="scan-station" label="Station label" placeholder="e.g. FAB-01" busy={busy} autoFocus={false} onCode={locate} />}
        </div>}
        {!expect && r === 'STATION' && <div className="card flat" style={{ padding: 12 }}>
          <b>Station {res.station.workstationId}</b>{res.station.name ? ` · ${res.station.name}` : ''} <span className="small muted">({res.station.workCenterId})</span>
          {res.stationTanks.length === 0 ? <div className="small muted">No tank is at this station now.</div>
            : res.stationTanks.map(u => <div key={u.unitId} className="row between list-row clickable" onClick={() => open(u.unitId)}><b>{u.serial || u.unitId}</b><Status value={u.state} /></div>)}
        </div>}
      </div>
    </Modal>
  );
}

export function ScanButton({ className = 'btn sm', label = 'Scan', expect, purpose, taskId, onMatch, title }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className={className} type="button" onClick={() => setOpen(true)} aria-label={expect ? 'Confirm the tank by scanning its label' : 'Scan a tank or station label'}><Icon name="scan" />{label}</button>
    {open && <ScanDialog expect={expect} purpose={purpose} taskId={taskId} onMatch={onMatch} title={title} onClose={() => setOpen(false)} />}
  </>;
}
