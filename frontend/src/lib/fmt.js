// Formatting helpers. The API returns plant-local ISO strings in *Local fields (plant timezone, not the browser's).
export const hhmm = (local) => (local ? String(local).slice(11, 16) : '—');
export const dayHhmm = (local) => {
  if (!local) return '—';
  const d = new Date(String(local).slice(0, 19));
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${String(local).slice(11, 16)}`;
};
export const dateLong = (local) => {
  if (!local) return '—';
  const d = new Date(String(local).slice(0, 19));
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
};
export const mins = (m) => {
  if (m === null || m === undefined || Number.isNaN(Number(m))) return '—';
  const v = Math.round(Number(m));
  const s = v < 0 ? '−' : '';
  const a = Math.abs(v);
  return a >= 60 ? `${s}${Math.floor(a / 60)} h ${String(a % 60).padStart(2, '0')} min` : `${s}${a} min`;
};
export const pct = (v, d = 0) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(d)}%`);
export const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
export const signed = (v, d = 2) => (v === null || v === undefined ? '—' : `${Number(v) > 0 ? '+' : Number(v) < 0 ? '−' : ''}${Math.abs(Number(v)).toFixed(d)}`);
export const human = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()) : '—');
export const initials = (name) => String(name || '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
/** UTC instant -> plant-local "HH:MM" using the plant timezone (fallback when the API gave no *Local field) */
export function plantTime(iso, tz = 'America/Bogota', withDay = false) {
  if (!iso) return '—';
  try {
    const o = { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false };
    if (withDay) Object.assign(o, { weekday: 'short', month: 'short', day: 'numeric' });
    return new Date(iso).toLocaleString('en-US', o);
  } catch (e) { return String(iso).slice(11, 16); }
}
export const sinceMin = (iso, nowIso) => (iso && nowIso ? Math.max(0, Math.round((new Date(nowIso) - new Date(iso)) / 60000)) : null);
