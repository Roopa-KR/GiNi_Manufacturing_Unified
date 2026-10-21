import { useState } from 'react';
import { useApp, useToast } from './hooks.jsx';
import { command } from './api.js';

/** run a domain command through the shared command bus with toast feedback (returns the response or null) */
export function useCommand() {
  const { session } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const run = async (type, payload, okMsg, after) => {
    if (!session) return null;
    if (session.mode === 'REPLAY' && !['ALERT_WORKFLOW'].includes(type)) { toast('Synthetic live replay is read-only - switch to an interactive session to enter activity', 'bad'); return null; }
    setBusy(type + (payload && (payload.unitId || payload.workerId || payload.holdId || payload.actionId || payload.alertId || payload.equipmentId || payload.materialId || payload.requestId) || ''));
    try {
      const r = await command(session.sessionId, type, payload);
      const res = r.result || {};
      if (res.stale) { toast(res.message || `Stale: ${(res.changed || []).join(', ')} changed - recalculate first`, 'bad', 7000); }
      else if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
      if (after) await after(r);
      return r;
    } catch (e) {
      toast(e.message, 'bad', 7000);
      return null;
    } finally { setBusy(null); }
  };
  return { run, busy };
}
