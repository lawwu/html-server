// Small server-rendered charts for /stats: plain SVG and HTML, no libraries.
// Marks follow one spec: a single series colour (--series-1), thin bars with 4px
// rounded data ends anchored to the baseline, a 2px gap between bars, recessive
// gridlines, text in text colours (never the series colour). Every mark carries a
// data-tip for the hover tooltip (public/stats.js), and every chart has a table view.
import { escapeHtml as esc } from './text.js';

const fmt = (n) => n.toLocaleString('en-US');

/** "Nice" round gridline values covering 0..max, about `count` of them. */
function ticks(max, count = 3) {
  if (max <= 0) return [0, 1];
  const raw = max / count, pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out.at(-1) < max) out.push(out.at(-1) + step);
  return out;
}

/** A bar whose top corners are rounded (radius r) and whose base sits flat on the baseline. */
function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** A table view of a series, collapsed under the chart. */
function tableView(caption, cols, rows) {
  return `<details class="tview"><summary>Show as table</summary><div class="scroll"><table>
<caption>${esc(caption)}</caption><thead><tr>${cols.map((c, i) => `<th${i ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td${i ? ' class="num"' : ''}>${typeof v === 'number' ? fmt(v) : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div></details>`;
}

/**
 * Columns over time: points = [{ label, value, tip }]. `xLabels` picks which points
 * get an axis label (first, middle and last by default) so they never collide.
 */
export function columnChart(points, { title, unit, height = 180, caption = title } = {}) {
  const W = 640, H = height, top = 8, bottom = 24, left = 34, right = 6;
  const max = Math.max(...points.map((p) => p.value), 0);
  const t = ticks(max), yMax = t.at(-1);
  const plotW = W - left - right, plotH = H - top - bottom, slot = plotW / points.length, gap = 2;
  const y = (v) => top + plotH - (v / yMax) * plotH;
  const grid = t.map((v) => `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>`
    + `<text class="tick" x="${left - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`).join('');
  const marks = points.map((p, i) => {
    const x = left + i * slot + gap / 2, w = Math.max(slot - gap, 1), h = (p.value / yMax) * plotH;
    // The hit target is the whole column slot, taller than the mark itself.
    return `<g class="mark" data-tip="${esc(p.tip ?? `${p.label}: ${fmt(p.value)} ${unit}`)}">`
      + `<rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}"/>`
      + `${p.value ? `<path class="bar" d="${barPath(x, y(p.value), w, h, 4)}"/>` : ''}</g>`;
  }).join('');
  const labelAt = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const xl = labelAt.map((i) => `<text class="tick" x="${left + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${esc(points[i].short ?? points[i].label)}</text>`).join('');
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(caption)}">${grid}<line class="axis" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>${marks}${xl}</svg>
${tableView(caption, ['Period', unit[0].toUpperCase() + unit.slice(1)], points.map((p) => [p.label, p.value]))}</figure>`;
}

/** Ranked horizontal bars: rows = [{ label, value, href }]. Labels and values in text colours. */
export function barList(rows, { title, unit, empty = 'Nothing yet.' } = {}) {
  if (!rows.length) return `<figure class="chart"><figcaption>${esc(title)}</figcaption><p class="empty">${esc(empty)}</p></figure>`;
  const max = Math.max(...rows.map((r) => r.value));
  const items = rows.map((r) => `<li class="mark" data-tip="${esc(`${r.label}: ${fmt(r.value)} ${unit}`)}">
  <span class="bl-label">${r.href ? `<a href="${esc(r.href)}">${esc(r.label)}</a>` : esc(r.label)}</span>
  <span class="bl-track"><span class="bl-bar" style="width:${Math.max((r.value / max) * 100, 1.5).toFixed(1)}%"></span></span>
  <span class="bl-value">${fmt(r.value)}</span></li>`).join('');
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption><ol class="barlist">${items}</ol>
${tableView(title, ['Name', unit[0].toUpperCase() + unit.slice(1)], rows.map((r) => [r.label, r.value]))}</figure>`;
}

/** A headline number with its label. */
export const tile = (value, label, sub = '') => `<div class="tile"><b>${typeof value === 'number' ? fmt(value) : esc(value)}</b>`
  + `<span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
