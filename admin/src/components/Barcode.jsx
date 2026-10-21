import React from 'react';

/* Code 128 (subset B) barcode as SVG - no external library. Readable by handheld scanners and by the operator app's camera
   scanner (BarcodeDetector code_128). Used for printable tank and station labels. */

// bar/space module widths of the 107 Code 128 symbols (values 0-105; 106 = stop)
const P = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 ' +
  '111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 ' +
  '141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 ' +
  '124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 ' +
  '311141 411131 211412 211214 211232 2331112').split(' ');

export function code128Widths(text) {
  const s = String(text).replace(/[^\x20-\x7e]/g, '');
  const vals = [104];                                   // start B
  for (const ch of s) vals.push(ch.charCodeAt(0) - 32);
  let sum = 104;
  vals.slice(1).forEach((v, i) => { sum += v * (i + 1); });
  vals.push(sum % 103, 106);                            // checksum, stop
  return vals.map(v => P[v]).join('');
}

export function Barcode({ value, height = 60, module = 2, label = true }) {
  const widths = code128Widths(value);
  const quiet = 10 * module;
  let x = quiet;
  const bars = [];
  [...widths].forEach((w, i) => { const wd = Number(w) * module; if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={wd} height={height} fill="#000" />); x += wd; });
  const total = x + quiet;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={total} height={height + (label ? 22 : 0)} viewBox={`0 0 ${total} ${height + (label ? 22 : 0)}`} role="img" aria-label={`Barcode ${value}`} style={{ background: '#fff' }}>
      <rect x={0} y={0} width={total} height={height + (label ? 22 : 0)} fill="#fff" />
      {bars}
      {label && <text x={total / 2} y={height + 17} textAnchor="middle" fontFamily="monospace" fontSize="15" fill="#000">{value}</text>}
    </svg>
  );
}

function labelSvg(code) {
  const widths = code128Widths(code);
  const module = 2, height = 70, quiet = 20;
  let x = quiet, rects = '';
  [...widths].forEach((w, i) => { const wd = Number(w) * module; if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${wd}" height="${height}"/>`; x += wd; });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x + quiet}" height="${height}" viewBox="0 0 ${x + quiet} ${height}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

/** opens one print window with one or more labels ({ title, code, lines }) */
export function printLabels(labels) {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const w = window.open('', '_blank', 'width=560,height=480');
  if (!w) return false;
  const body = labels.map(l => `<div class="label"><h1>${esc(l.title)}</h1>${labelSvg(l.code)}<div class="code">${esc(l.code)}</div>${(l.lines || []).filter(Boolean).map(x => `<div class="l">${esc(x)}</div>`).join('')}</div>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(labels.length === 1 ? labels[0].title : `${labels.length} labels`)}</title><style>
    body{font-family:system-ui,sans-serif;margin:16px} .label{border:1px dashed #999;padding:12px 16px;display:inline-block;margin:0 12px 12px 0;break-inside:avoid}
    h1{font-size:16px;margin:0 0 8px} .code{font:600 20px monospace;margin:6px 0} .l{font-size:12px;color:#333}
    @media print{.label{border:none} .noprint{display:none}}</style></head><body>${body}
    <p class="noprint"><button onclick="window.print()">Print</button></p></body></html>`);
  w.document.close();
  return true;
}

export function printLabel(label) { return printLabels([label]); }
