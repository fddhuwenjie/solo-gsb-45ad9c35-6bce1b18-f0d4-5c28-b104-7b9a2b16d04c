'use strict';

/* ================= 全局状态 ================= */
const PALETTE = ['#2f9e44', '#1971c2', '#e8590c', '#9c36b5', '#c2255c', '#0c8599', '#5f3dc4', '#b0891c'];
let nextId = 1;
const uid = () => 'id' + (nextId++);

const state = {
  mode: 'single',                // 'single' 单机选位 | 'blend' 多机拼接
  room: { width: 6.5, depth: 8.0, height: 2.8, margin: 0.3 },
  screen: { width: 2.2, height: 1.24, bottom: 0.9, cx: 3.25 },
  schemes: [],
  obstacles: [],
  selectedSchemeId: null,
  selectedObstacleId: null,
  point: { x: 3.25, y: 3.6 },     // 镜头安装点（顶视图坐标）
  lensHeight: 1.55,               // 镜头高度
  showAll: true,
  drawMode: false,
  // 多机拼接
  zones: [],                      // [{name, scheme_id, width, min_overlap, service_x, service_y}]
  selectedZone: 0,
  blendPos: [null, null, null],   // 每台当前安装点 {x,y}|null（与服务器返回同步）
  blendZ: [null, null, null],     // 每台镜头高度
  blendPinned: [false, false, false], // 被用户拖动固定的设备
};

let result = null;                // 最近一次服务器计算结果（单机）
let resultById = {};
let blendResult = null;           // 最近一次多机拼接结果
let drag = null;                  // 当前拖拽会话
let examples = [];

/* ================= 工具 ================= */
const SVGNS = 'http://www.w3.org/2000/svg';
const topSvg = document.getElementById('topView');
const sideSvg = document.getElementById('sideView');
const stripSvg = document.getElementById('stripView');

function el(name, attrs = {}, parent = null) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v, d = 2) => Number(v).toFixed(d);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function svgWorld(svg, e) {
  const pt = new DOMPoint(e.clientX, e.clientY);
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
function colorOf(id) {
  const i = state.schemes.findIndex(s => s.id === id);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}
function currentScheme() {
  return state.schemes.find(s => s.id === state.selectedSchemeId) || null;
}

/* ================= 数据清洗 ================= */
function sanitize() {
  const r = state.room, s = state.screen;
  r.width = clamp(r.width, 1, 30);
  r.depth = clamp(r.depth, 1, 40);
  r.height = clamp(r.height, 1.8, 10);
  r.margin = clamp(r.margin, 0, Math.min(r.width, r.depth) / 2 - 0.01);
  s.width = clamp(s.width, 0.5, r.width);
  s.height = clamp(s.height, 0.4, r.height);
  s.bottom = clamp(s.bottom, 0, r.height - s.height);
  s.cx = clamp(s.cx, s.width / 2, r.width - s.width / 2);
  for (const sch of state.schemes) {
    sch.tr_min = clamp(sch.tr_min, 0.1, 10);
    sch.tr_max = clamp(sch.tr_max, 0.1, 10);
    if (sch.tr_min > sch.tr_max) [sch.tr_min, sch.tr_max] = [sch.tr_max, sch.tr_min];
    sch.h_shift = clamp(sch.h_shift, 0, 1.5);
    sch.v_shift = clamp(sch.v_shift, 0, 1.5);
    sch.body_w = clamp(sch.body_w, 0.1, 2);
    sch.body_d = clamp(sch.body_d, 0.1, 2);
    sch.body_h = clamp(sch.body_h, 0.05, 1.5);
  }
  for (const ob of state.obstacles) {
    ob.w = clamp(ob.w, 0.1, r.width);
    ob.h = clamp(ob.h, 0.1, r.depth);
    ob.x = clamp(ob.x, 0, r.width - ob.w);
    ob.y = clamp(ob.y, 0, r.depth - ob.h);
  }
  for (const z of state.zones) {
    z.width = clamp(z.width, 0.1, s.width);
    z.min_overlap = clamp(z.min_overlap, 0, s.width);
    z.service_x = clamp(z.service_x, 0, 2);
    z.service_y = clamp(z.service_y, 0, 2);
  }
  state.point.x = clamp(state.point.x, 0, r.width);
  state.point.y = clamp(state.point.y, 0, r.depth);
  state.lensHeight = clamp(state.lensHeight, 0, r.height);
  // 镜头高度夹取到当前方案可行范围（依据最近一次计算）
  const sel = resultById[state.selectedSchemeId];
  if (state.mode !== 'blend' && sel && sel.ranges.z) {
    state.lensHeight = clamp(state.lensHeight, sel.ranges.z[0], sel.ranges.z[1]);
  }
  // 拼接模式：各台镜头高度夹取到各自可行范围（不强制夹，越界本身是诊断项，
  // 仅在已有结果且范围有效时夹，避免拖动后高度直接超出物理房间）
  if (state.mode === 'blend' && blendResult) {
    blendResult.zones.forEach((z, i) => {
      if (state.blendZ[i] == null) return;
      state.blendZ[i] = clamp(state.blendZ[i], 0, r.height);
    });
  }
}

/* ================= 多机拼接辅助 ================= */
const zoneColor = i => PALETTE[i % PALETTE.length];
const screenLeft = () => state.screen.cx - state.screen.width / 2;
const defaultLensZ = () => state.screen.bottom + state.screen.height / 2;

/* 前端排布：第 1 区间自幕布左缘起，后续按最小重叠与前一区间相接。
   返回 {lefts, rights, endRight}（相对幕布左缘的米数）。 */
function layoutZones() {
  let right = 0;
  const lefts = [], rights = [];
  for (let i = 0; i < state.zones.length; i++) {
    const left = i === 0 ? 0 : right - state.zones[i].min_overlap;
    lefts.push(left);
    right = left + state.zones[i].width;
    rights.push(right);
  }
  return { lefts, rights, endRight: right };
}

function ensureZones(n) {
  const init = state.zones.length === 0;
  while (state.zones.length < n) {
    const i = state.zones.length;
    const fallback = state.schemes[Math.min(i, state.schemes.length - 1)] || state.schemes[0];
    state.zones.push({
      name: `区间 ${i + 1}`,
      scheme_id: fallback ? fallback.id : (state.schemes[0] ? state.schemes[0].id : null),
      // 占位宽度，init 时随后用 balanceZones() 配平铺满整幅幕布
      width: +(state.screen.width / n).toFixed(2),
      min_overlap: i === 0 ? 0 : 0.3,
      service_x: 0.3, service_y: 0.3,
    });
  }
  if (state.zones.length > n) {
    state.zones.length = n;
    state.blendPos.length = n;
    state.blendZ.length = n;
    state.blendPinned.length = n;
  }
  for (const z of state.zones) {
    if (!state.schemes.some(s => s.id === z.scheme_id)) {
      z.scheme_id = state.schemes[0] ? state.schemes[0].id : null;
    }
  }
  state.selectedZone = clamp(state.selectedZone, 0, n - 1);
  if (init) {
    // 初始区间直接配平：按 0.3m 相邻重叠连续铺满整幅幕布
    state.zones.forEach(z => { z.width = state.screen.width / n; });
    balanceZones();
  }
}

/* 配平：保持第 1 区间左缘在 0、各相邻最小重叠不变，把幕宽按当前宽度比例分摊，
   使区间总宽（含重叠）恰好等于幕宽。 */
function balanceZones() {
  const n = state.zones.length;
  const overlapSum = state.zones.reduce((a, z) => a + z.min_overlap, 0);
  const target = state.screen.width + overlapSum;
  const cur = state.zones.reduce((a, z) => a + z.width, 0) || 1;
  for (const z of state.zones) z.width = clamp(z.width * target / cur, 0.1, state.screen.width);
  // 消除四舍五入残差到末区间
  const rest = state.zones.reduce((a, z) => a + z.width, 0) - overlapSum;
  state.zones[n - 1].width = +(state.zones[n - 1].width + state.screen.width - rest).toFixed(3);
  clearPins();
}

/* ================= 服务器计算 ================= */
let computeTimer = null, computeSeq = 0;
function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(doCompute, 40);
}
function clearPins() {
  state.blendPinned = state.zones.map(() => false);
  state.blendPos = state.zones.map(() => null);
  state.blendZ = state.zones.map(() => defaultLensZ());
}
async function doCompute() {
  const seq = ++computeSeq;
  try {
    if (state.mode === 'blend') {
      // 未固定设备发 null，由后端自由求解；已拖动设备带上固定点与镜头高度
      const points = state.zones.map((z, i) =>
        state.blendPinned[i] && state.blendPos[i]
          ? { x: state.blendPos[i].x, y: state.blendPos[i].y } : null);
      const lens_heights = state.zones.map((z, i) =>
        state.blendZ[i] == null ? defaultLensZ() : state.blendZ[i]);
      const payload = {
        room: state.room, screen: state.screen, schemes: state.schemes,
        obstacles: state.obstacles, zones: state.zones,
        points, lens_heights,
      };
      const res = await fetch('/api/blend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok || seq !== computeSeq) return;
      blendResult = await res.json();
      if (blendResult.error) { blendResult = null; return; }
      syncBlendPositions();
      render();
    } else {
      const payload = {
        room: state.room, screen: state.screen, schemes: state.schemes,
        obstacles: state.obstacles, point: state.point, lens_height: state.lensHeight,
      };
      const res = await fetch('/api/compute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok || seq !== computeSeq) return;
      result = await res.json();
      resultById = {};
      for (const s of result.schemes) resultById[s.id] = s;
      render();
    }
  } catch (err) { /* 网络异常时保留旧结果 */ }
}

/* 服务器返回后同步本地安装点：自由设备采纳后端解；固定设备保留用户点 */
function syncBlendPositions() {
  if (!blendResult) return;
  blendResult.zones.forEach((z, i) => {
    if (!z.point) return;
    if (state.blendPinned[i]) {
      // 固定点：仅同步 z（本地点是拖动源），x/y 保持本地
      if (z.point.z != null) state.blendZ[i] = z.point.z;
    } else {
      state.blendPos[i] = { x: z.point.x, y: z.point.y };
      if (z.point.z != null) state.blendZ[i] = z.point.z;
    }
  });
}
function onStateChange() {
  render();
  scheduleCompute();
}

/* ================= SVG 公共件 ================= */
function addDefs(svg, suffix) {
  const defs = el('defs', {}, svg);
  const mk = el('marker', {
    id: 'arrow' + suffix, viewBox: '0 0 10 10', refX: 8, refY: 5,
    markerWidth: 5, markerHeight: 5, markerUnits: 'strokeWidth',
    orient: 'auto-start-reverse',
  }, defs);
  el('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: '#868e96' }, mk);
  const pat = el('pattern', {
    id: 'hatch' + suffix, width: 0.14, height: 0.14,
    patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  }, defs);
  el('rect', { width: 0.14, height: 0.14, fill: 'rgba(224,49,49,0.10)' }, pat);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 0.14, stroke: 'rgba(224,49,49,0.55)', 'stroke-width': 0.035 }, pat);
}

function textAt(svg, x, y, str, size = 0.13, fill = '#495057', anchor = 'middle') {
  const t = el('text', {
    x, y, 'font-size': size, fill, 'text-anchor': anchor,
    'dominant-baseline': 'middle', class: 'halo',
  }, svg);
  t.textContent = str;
  return t;
}

/* 线性尺寸标注：测量 (x1,y1)-(x2,y2)，沿法向偏移 off 绘制 */
function drawDim(svg, x1, y1, x2, y2, off, label, suffix) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = -dy / len, ny = dx / len;
  const ax = x1 + nx * off, ay = y1 + ny * off;
  const bx = x2 + nx * off, by = y2 + ny * off;
  const g = el('g', { class: 'dim' }, svg);
  const c = '#868e96';
  el('line', { x1, y1, x2: ax, y2: ay, stroke: c, 'stroke-width': 0.012 }, g);
  el('line', { x1: x2, y1: y2, x2: bx, y2: by, stroke: c, 'stroke-width': 0.012 }, g);
  el('line', {
    x1: ax, y1: ay, x2: bx, y2: by, stroke: c, 'stroke-width': 0.015,
    'marker-start': `url(#arrow${suffix})`, 'marker-end': `url(#arrow${suffix})`,
  }, g);
  textAt(g, (ax + bx) / 2, (ay + by) / 2 - 0.02, label, 0.13, '#495057');
}

/* ================= 顶视图 ================= */
const TOP_PAD = { l: 1.15, t: 0.85, r: 1.05, b: 0.95 };

function renderTop() {
  const svg = topSvg;
  svg.innerHTML = '';
  const { width: W, depth: D, margin: m } = state.room;
  const s = state.screen;
  svg.setAttribute('viewBox', `${-TOP_PAD.l} ${-TOP_PAD.t} ${W + TOP_PAD.l + TOP_PAD.r} ${D + TOP_PAD.t + TOP_PAD.b}`);
  addDefs(svg, 'T');

  drawRoomTop(svg);

  if (state.mode === 'blend') {
    renderTopBlend(svg);
    return;
  }
  renderTopSingle(svg);
}

function drawRoomTop(svg) {
  const { width: W, depth: D, margin: m } = state.room;
  // 房间与 1m 网格
  el('rect', { x: 0, y: 0, width: W, height: D, fill: '#fbfcfd', stroke: '#343a40', 'stroke-width': 0.03 }, svg);
  for (let gx = 1; gx < W; gx++) el('line', { x1: gx, y1: 0, x2: gx, y2: D, stroke: '#eef1f3', 'stroke-width': 0.01 }, svg);
  for (let gy = 1; gy < D; gy++) el('line', { x1: 0, y1: gy, x2: W, y2: gy, stroke: '#eef1f3', 'stroke-width': 0.01 }, svg);
  // 墙面余量
  if (m > 0.001) {
    el('rect', {
      x: m, y: m, width: W - 2 * m, height: D - 2 * m, fill: 'none',
      stroke: '#adb5bd', 'stroke-width': 0.012, 'stroke-dasharray': '0.09 0.05',
    }, svg);
    textAt(svg, W - m - 0.06, m + 0.12, `墙面余量 ${fmt(m)}m`, 0.11, '#868e96', 'end');
  }
}

/* 顶视图公共件：禁装区、幕布 */
function drawObstaclesTop(svg) {
  for (const ob of state.obstacles) {
    const isSel = ob.id === state.selectedObstacleId;
    const g = el('g', {}, svg);
    const rect = el('rect', {
      x: ob.x, y: ob.y, width: ob.w, height: ob.h,
      fill: 'url(#hatchT)', stroke: '#e03131',
      'stroke-width': isSel ? 0.03 : 0.018, class: 'ob-rect',
    }, g);
    rect.addEventListener('pointerdown', e => {
      state.selectedObstacleId = ob.id;
      const w = svgWorld(svg, e);
      startDrag(e, { type: 'ob', id: ob.id, dx: w.x - ob.x, dy: w.y - ob.y });
      onStateChange();
    });
    textAt(g, ob.x + ob.w / 2, ob.y + ob.h / 2 - 0.08, ob.name, 0.12, '#c92a2a');
    textAt(g, ob.x + ob.w / 2, ob.y + ob.h / 2 + 0.08, `${fmt(ob.w)}×${fmt(ob.h)}m`, 0.1, '#c92a2a');
    if (isSel) {
      const h = el('circle', { cx: ob.x + ob.w, cy: ob.y + ob.h, r: 0.08, class: 'resize-handle' }, g);
      h.addEventListener('pointerdown', e => startDrag(e, { type: 'obresize', id: ob.id }));
    }
  }
  if (drag && drag.type === 'draw') {
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
    el('rect', {
      x, y, width: w, height: h, fill: 'rgba(224,49,49,0.15)',
      stroke: '#e03131', 'stroke-width': 0.02, 'stroke-dasharray': '0.08 0.05',
    }, svg);
    textAt(svg, x + w / 2, y + h / 2, `${fmt(w)}×${fmt(h)}m`, 0.12, '#c92a2a');
  }
}

function drawScreenTop(svg) {
  const s = state.screen;
  const scrHit = el('rect', {
    x: s.cx - s.width / 2, y: -0.14, width: s.width, height: 0.2,
    fill: '#1864ab', 'fill-opacity': 0.18, class: 'screen-hit',
  }, svg);
  scrHit.addEventListener('pointerdown', e => {
    const w = svgWorld(svg, e);
    startDrag(e, { type: 'screen', dx: w.x - s.cx });
  });
  el('rect', { x: s.cx - s.width / 2, y: -0.07, width: s.width, height: 0.07, fill: '#1864ab', class: 'screen-core' }, svg)
    .addEventListener('pointerdown', e => {
      const w = svgWorld(svg, e);
      startDrag(e, { type: 'screen', dx: w.x - s.cx });
    });
  textAt(svg, s.cx, -0.28, '幕布', 0.12, '#1864ab');
}

/* 可安装区域矩形/安装线段（单机方案与拼接区间共用） */
function drawDomain(svg, color, region, selected) {
  for (const r of region) {
    if (r[2] - r[0] <= 1e-6 && r[3] - r[1] > 1e-6) {
      el('line', {
        x1: r[0], y1: r[1], x2: r[2], y2: r[3],
        stroke: color, 'stroke-width': selected ? 0.07 : 0.05,
        'stroke-linecap': 'round', 'stroke-opacity': selected ? 0.95 : 0.5,
      }, svg);
      if (selected) {
        for (const yy of [r[1], r[3]]) {
          el('line', { x1: r[0] - 0.1, y1: yy, x2: r[0] + 0.1, y2: yy,
            stroke: color, 'stroke-width': 0.02, 'stroke-opacity': 0.9 }, svg);
        }
      }
    } else {
      el('rect', {
        x: r[0], y: r[1], width: Math.max(0, r[2] - r[0]), height: Math.max(0, r[3] - r[1]),
        fill: color, 'fill-opacity': selected ? 0.30 : 0.09,
        stroke: color, 'stroke-width': selected ? 0.02 : 0.01,
        'stroke-opacity': selected ? 0.95 : 0.4,
      }, svg);
    }
  }
}

function renderTopSingle(svg) {
  const { width: W, depth: D } = state.room;
  const s = state.screen;
  // 幕布中心线
  el('line', { x1: s.cx, y1: 0, x2: s.cx, y2: D, stroke: '#e9ecef', 'stroke-width': 0.012, 'stroke-dasharray': '0.1 0.06' }, svg);

  if (result) {
    const ordered = [...result.schemes].sort((a, b) => (a.id === state.selectedSchemeId ? 1 : 0) - (b.id === state.selectedSchemeId ? 1 : 0));
    for (const sr of ordered) {
      const isSel = sr.id === state.selectedSchemeId;
      if (!isSel && !state.showAll) continue;
      drawDomain(svg, colorOf(sr.id), sr.region, isSel);
    }
    const sel = resultById[state.selectedSchemeId];
    if (sel) {
      const color = colorOf(sel.id);
      if (sel.base_rect) {
        const b = sel.base_rect;
        el('rect', {
          x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1], fill: 'none',
          stroke: color, 'stroke-width': 0.018, 'stroke-dasharray': '0.1 0.05', 'stroke-opacity': 0.8,
        }, svg);
      }
      for (const [yy, lbl] of [[sel.derived.d_min, `最近投射 ${fmt(sel.derived.d_min)}m`],
                               [sel.derived.d_max, `最远投射 ${fmt(sel.derived.d_max)}m`]]) {
        if (yy > 0.01 && yy < D - 0.01) {
          el('line', { x1: 0, y1: yy, x2: W, y2: yy, stroke: color, 'stroke-width': 0.014, 'stroke-dasharray': '0.14 0.07', 'stroke-opacity': 0.7 }, svg);
          textAt(svg, 0.06, yy - 0.1, lbl, 0.11, color, 'start');
        }
      }
      if (sel.domain === 'line' && sel.line_length > 0 && sel.region.length) {
        const f = sel.region[0];
        textAt(svg, f[0] + 0.14, (f[1] + f[3]) / 2,
          `安装线可行长度 ${fmt(sel.line_length)} m`, 0.12, color, 'start');
      }
    }
  }

  const sch = currentScheme();
  const sel = resultById[state.selectedSchemeId];
  const p = state.point;
  if (sch && sel) {
    el('polygon', {
      points: `${p.x},${p.y} ${s.cx - s.width / 2},0 ${s.cx + s.width / 2},0`,
      fill: 'rgba(25,113,194,0.08)', stroke: '#1971c2',
      'stroke-width': 0.014, 'stroke-dasharray': '0.07 0.05',
    }, svg);
  }

  drawObstaclesTop(svg);
  drawScreenTop(svg);

  if (sch && sel) {
    const ok = sel.point && sel.point.ok;
    el('rect', {
      x: p.x - sch.body_w / 2, y: p.y, width: sch.body_w, height: sch.body_d,
      fill: ok ? 'rgba(47,158,68,0.45)' : 'rgba(224,49,49,0.45)',
      stroke: ok ? '#2b8a3e' : '#e03131', 'stroke-width': 0.02,
    }, svg);
    const g = el('g', { class: 'point-handle' }, svg);
    el('circle', { cx: p.x, cy: p.y, r: 0.09, fill: 'rgba(25,113,194,0.25)' }, g);
    el('circle', { cx: p.x, cy: p.y, r: 0.05, fill: '#fff', stroke: '#1971c2', 'stroke-width': 0.025 }, g);
    g.addEventListener('pointerdown', e => startDrag(e, { type: 'point' }));
    textAt(svg, p.x + 0.14, p.y - 0.12, '镜头', 0.11, '#1971c2', 'start');
    drawDim(svg, 0, p.y, p.x, p.y, -0.26, `x=${fmt(p.x)}m`, 'T');
    drawDim(svg, p.x, 0, p.x, p.y, 0.26, `L=${fmt(p.y)}m`, 'T');
  }

  drawDim(svg, 0, D, W, D, 0.42, `房间宽 ${fmt(W)} m`, 'T');
  drawDim(svg, W, 0, W, D, -0.42, `进深 ${fmt(D)} m`, 'T');
  drawDim(svg, s.cx - s.width / 2, 0, s.cx + s.width / 2, 0, -0.5, `幕宽 ${fmt(s.width)} m`, 'T');
}

/* ================= 多机拼接：顶视图 ================= */
function schemeOfZone(i) {
  const z = state.zones[i];
  return z ? state.schemes.find(s => s.id === z.scheme_id) : null;
}

function renderTopBlend(svg) {
  const { width: W, depth: D } = state.room;
  const s = state.screen;
  const br = blendResult;

  // 每台可安装域 + 基础交集 + 区间中心/边界虚线
  if (br) {
    br.zones.forEach((z, i) => {
      const isSel = i === state.selectedZone;
      const color = zoneColor(i);
      if (state.showAll || isSel) drawDomain(svg, color, z.region, isSel);
    });
    br.zones.forEach((z, i) => {
      const isSel = i === state.selectedZone;
      if (!isSel || !z.base_rect) return;
      const b = z.base_rect;
      el('rect', { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1], fill: 'none',
        stroke: zoneColor(i), 'stroke-width': 0.018, 'stroke-dasharray': '0.1 0.05', 'stroke-opacity': 0.8 }, svg);
    });
  }
  // 幕布分区边界（前墙处色块）与区间中心线
  const { lefts } = layoutZones();
  const x0 = screenLeft();
  state.zones.forEach((z, i) => {
    const color = zoneColor(i);
    const lx = x0 + lefts[i], rx = lx + z.width;
    el('line', { x1: (lx + rx) / 2, y1: 0, x2: (lx + rx) / 2, y2: D,
      stroke: color, 'stroke-width': 0.01, 'stroke-dasharray': '0.08 0.08', 'stroke-opacity': 0.45 }, svg);
    el('rect', { x: lx, y: -0.07, width: z.width, height: 0.07,
      fill: color, 'fill-opacity': i === state.selectedZone ? 0.95 : 0.55 }, svg);
  });

  // 投射包络（各台镜头 → 本台区间）
  if (br) {
    br.zones.forEach((z, i) => {
      const p = state.blendPos[i];
      if (!p || !z.width) return;
      const lx = x0 + (z.left ?? lefts[i]);
      el('polygon', {
        points: `${p.x},${p.y} ${lx},0 ${lx + z.width},0`,
        fill: zoneColor(i), 'fill-opacity': 0.06,
        stroke: zoneColor(i), 'stroke-width': 0.012, 'stroke-dasharray': '0.07 0.05', 'stroke-opacity': 0.7,
      }, svg);
    });
  }

  drawObstaclesTop(svg);
  drawScreenTop(svg);

  // 检修包络 + 机身 + 镜头点
  if (br) {
    br.zones.forEach((z, i) => {
      const sch = schemeOfZone(i);
      const p = state.blendPos[i];
      if (!sch || !p || !z.point) return;
      const isSel = i === state.selectedZone;
      const color = zoneColor(i);
      const valid = z.point.valid !== false;
      // 固定点处于拖动中时，本地位置可能与返回包络不完全一致：
      // 以本地镜头点与该机检修净距现算包络，保证拖动即时反馈
      const env = state.blendPinned[i]
        ? [p.x - sch.body_w / 2 - state.zones[i].service_x,
           p.y - state.zones[i].service_y,
           p.x + sch.body_w / 2 + state.zones[i].service_x,
           p.y + sch.body_d + state.zones[i].service_y]
        : z.point.envelope;
      el('rect', {
        x: env[0], y: env[1], width: Math.max(0, env[2] - env[0]), height: Math.max(0, env[3] - env[1]),
        fill: valid ? color : '#e03131', 'fill-opacity': isSel ? 0.14 : 0.07,
        stroke: valid ? color : '#e03131', 'stroke-width': isSel ? 0.02 : 0.012,
        'stroke-dasharray': '0.09 0.06',
      }, svg);
      el('rect', {
        x: p.x - sch.body_w / 2, y: p.y, width: sch.body_w, height: sch.body_d,
        fill: valid ? color : '#e03131', 'fill-opacity': 0.5,
        stroke: valid ? color : '#e03131', 'stroke-width': 0.018,
      }, svg);
      // 双击镜头点解除固定，恢复整组自由解
      const g = el('g', { class: 'point-handle' }, svg);
      el('circle', { cx: p.x, cy: p.y, r: isSel ? 0.1 : 0.075,
        fill: '#fff', stroke: valid ? color : '#e03131', 'stroke-width': isSel ? 0.03 : 0.02 }, g);
      el('text', { x: p.x, y: p.y, 'font-size': 0.09, fill: valid ? color : '#e03131',
        'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-weight': 700, class: 'halo' }, g).textContent = i + 1;
      g.addEventListener('pointerdown', e => {
        state.selectedZone = i;
        startDrag(e, { type: 'bpoint', zone: i });
        render();
      });
      g.addEventListener('dblclick', e => {
        e.stopPropagation();
        e.preventDefault();
        state.blendPinned[i] = false;
        state.blendPos[i] = null;
        onStateChange();
      });
      if (isSel) {
        textAt(svg, p.x + 0.14, p.y - 0.12,
          `${state.blendPinned[i] ? '固定点（双击解锁）' : '自动点'} #${i + 1} (${fmt(p.x)}, ${fmt(p.y)})`,
          0.11, color, 'start');
      }
    });
  }

  drawDim(svg, 0, D, W, D, 0.42, `房间宽 ${fmt(W)} m`, 'T');
  drawDim(svg, W, 0, W, D, -0.42, `进深 ${fmt(D)} m`, 'T');
  drawDim(svg, s.cx - s.width / 2, 0, s.cx + s.width / 2, 0, -0.5, `幕宽 ${fmt(s.width)} m`, 'T');
}

/* ================= 幕布条带 ================= */
const STRIP_PAD = { l: 0.8, t: 0.32, r: 0.6, b: 0.4 };

function renderStrip() {
  const svg = stripSvg;
  svg.innerHTML = '';
  const sw = state.screen.width;
  const H = 1.0;
  svg.setAttribute('viewBox', `${-STRIP_PAD.l} ${-STRIP_PAD.t} ${sw + STRIP_PAD.l + STRIP_PAD.r} ${H + STRIP_PAD.t + STRIP_PAD.b}`);
  addDefs(svg, 'P');
  const x0 = screenLeft();
  const bandY = 0.28, bandH = 0.44;
  const { lefts } = layoutZones();

  // 整幅幕布底条
  el('rect', { x: 0, y: bandY, width: sw, height: bandH, fill: '#eef4fb', stroke: '#1864ab', 'stroke-width': 0.012 }, svg);
  textAt(svg, -0.12, bandY + bandH / 2, '幕布墙', 0.1, '#868e96', 'end');

  const br = blendResult;
  state.zones.forEach((z, i) => {
    const lx = lefts[i], w = z.width;
    const color = zoneColor(i);
    const isSel = i === state.selectedZone;
    // 区间色块
    el('rect', { x: lx, y: bandY, width: w, height: bandH,
      fill: color, 'fill-opacity': isSel ? 0.4 : 0.22,
      stroke: color, 'stroke-width': isSel ? 0.02 : 0.012 }, svg);
    textAt(svg, lx + w / 2, bandY + bandH / 2,
      `#${i + 1} ${fmt(w)}m`, isSel ? 0.11 : 0.095, color);
    // 左边界（与幕布左缘对齐处不画）
    if (i > 0) {
      el('line', { x1: lx, y1: bandY - 0.07, x2: lx, y2: bandY + bandH + 0.07,
        stroke: color, 'stroke-width': 0.015, 'stroke-dasharray': '0.05 0.03' }, svg);
    }
  });

  // 邻接重叠标注（重叠区加深 + 双向尺寸）
  for (let i = 1; i < state.zones.length; i++) {
    const ovL = lefts[i], ovR = lefts[i - 1] + state.zones[i - 1].width;
    const ov = ovR - ovL;
    if (ov <= 0.001) {
      // 无重叠/离缝
      textAt(svg, (ovL + ovR) / 2, bandY - 0.13,
        ov < 0 ? `离缝 ${fmt(-ov)}m` : '相接', 0.085, '#c92a2a');
      continue;
    }
    el('rect', { x: ovL, y: bandY, width: ov, height: bandH,
      fill: '#000', 'fill-opacity': 0.08 }, svg);
    const okCov = !br || ov + 0.005 >= (state.zones[i].min_overlap);
    textAt(svg, (ovL + ovR) / 2, bandY - 0.13,
      `重叠 ${fmt(ov)}m ≥ ${fmt(state.zones[i].min_overlap)}m`,
      0.085, okCov ? '#2b8a3e' : '#c92a2a');
  }

  // 安装点投影（镜头 x 在条带上的投影，按区间序号着色）
  if (br) {
    br.zones.forEach((z, i) => {
      const p = state.blendPos[i];
      if (!p || !z.point) return;
      const px = p.x - x0;
      const valid = z.point.valid !== false;
      el('line', { x1: px, y1: bandY + bandH, x2: px, y2: bandY + bandH + 0.2,
        stroke: valid ? zoneColor(i) : '#e03131', 'stroke-width': 1.5,
        'vector-effect': 'non-scaling-stroke' }, svg);
      el('circle', { cx: px, cy: bandY + bandH + 0.2, r: 0.05,
        fill: '#fff', stroke: valid ? zoneColor(i) : '#e03131', 'stroke-width': 1.5,
        'vector-effect': 'non-scaling-stroke' }, svg);
      textAt(svg, px, bandY + bandH + 0.2, `${i + 1}`, 0.08, valid ? zoneColor(i) : '#e03131');
    });
  }

  // 覆盖缺口/超出提示
  const { endRight } = layoutZones();
  const gap = sw - endRight;
  if (Math.abs(gap) > 0.005) {
    if (gap > 0) {
      el('rect', { x: endRight, y: bandY, width: gap, height: bandH,
        fill: 'rgba(224,49,49,0.25)', stroke: '#e03131', 'stroke-width': 0.012, 'stroke-dasharray': '0.04 0.03' }, svg);
      textAt(svg, endRight + gap / 2, bandY + bandH / 2, `缺口 ${fmt(gap)}m`, 0.09, '#c92a2a');
    } else {
      textAt(svg, sw - 0.03, bandY - 0.13, `末区间超出幕右缘 ${fmt(-gap)}m`, 0.085, '#c92a2a', 'end');
    }
  }
  drawDim(svg, 0, bandY + bandH + 0.32, sw, bandY + bandH + 0.32, 0.22, `幕宽 ${fmt(sw)} m`, 'P');
}

/* ================= 侧视图 ================= */
const SIDE_PAD = { l: 1.15, t: 0.55, r: 1.05, b: 1.15 };

function renderSide() {
  const svg = sideSvg;
  svg.innerHTML = '';
  const { depth: D, height: H } = state.room;
  const s = state.screen;
  svg.setAttribute('viewBox', `${-SIDE_PAD.l} ${-SIDE_PAD.t} ${D + SIDE_PAD.l + SIDE_PAD.r} ${H + SIDE_PAD.t + SIDE_PAD.b}`);
  addDefs(svg, 'S');
  const Z = z => H - z;

  el('rect', { x: 0, y: 0, width: D, height: H, fill: '#fbfcfd', stroke: '#343a40', 'stroke-width': 0.03 }, svg);
  el('line', { x1: 0, y1: H, x2: D, y2: H, stroke: '#343a40', 'stroke-width': 0.045 }, svg);
  textAt(svg, 0.06, -0.16, '幕布墙', 0.12, '#868e96', 'start');
  textAt(svg, D - 0.06, -0.16, '后墙', 0.12, '#868e96', 'end');
  textAt(svg, D - 0.06, H - 0.12, '地面', 0.11, '#868e96', 'end');

  for (const ob of state.obstacles) {
    el('rect', {
      x: ob.y, y: 0, width: ob.h, height: H,
      fill: 'url(#hatchS)', stroke: '#e03131', 'stroke-width': 0.012, 'stroke-opacity': 0.6,
    }, svg);
    textAt(svg, ob.y + ob.h / 2, 0.14, ob.name, 0.1, '#c92a2a');
  }

  el('rect', { x: -0.06, y: Z(s.bottom + s.height), width: 0.06, height: s.height, fill: '#1864ab' }, svg);
  drawDim(svg, 0, Z(0), 0, Z(s.bottom), -0.3, `下沿 ${fmt(s.bottom)}m`, 'S');
  drawDim(svg, 0, Z(s.bottom), 0, Z(s.bottom + s.height), -0.3, `幕高 ${fmt(s.height)}m`, 'S');

  if (state.mode === 'blend') {
    renderSideBlend(svg, Z);
  } else {
    renderSideSingle(svg, Z);
  }

  drawDim(svg, 0, H, D, H, 0.78, `进深 ${fmt(D)} m`, 'S');
  drawDim(svg, D, 0, D, H, -0.42, `净高 ${fmt(H)} m`, 'S');
}

function renderSideSingle(svg, Z) {
  const { height: H } = state.room;
  const s = state.screen;
  if (result) {
    const ordered = [...result.schemes].sort((a, b) => (a.id === state.selectedSchemeId ? 1 : 0) - (b.id === state.selectedSchemeId ? 1 : 0));
    for (const sr of ordered) {
      const isSel = sr.id === state.selectedSchemeId;
      if (!isSel && !state.showAll) continue;
      if (!sr.ranges.y || !sr.ranges.z) continue;
      const color = colorOf(sr.id);
      const [y1, y2] = sr.ranges.y, [z1, z2] = sr.ranges.z;
      el('rect', {
        x: y1, y: Z(z2), width: Math.max(0, y2 - y1), height: Math.max(0, z2 - z1),
        fill: color, 'fill-opacity': isSel ? 0.26 : 0.09,
        stroke: color, 'stroke-width': isSel ? 0.018 : 0.01,
        'stroke-opacity': isSel ? 0.9 : 0.4,
      }, svg);
    }
  }

  const sch = currentScheme();
  const sel = resultById[state.selectedSchemeId];
  const p = state.point;
  const hz = state.lensHeight;
  if (sch && sel) {
    const ok = sel.point && sel.point.ok;
    el('line', { x1: p.y, y1: Z(hz), x2: 0, y2: Z(s.bottom + s.height), stroke: '#1971c2', 'stroke-width': 0.014, 'stroke-dasharray': '0.07 0.05' }, svg);
    el('line', { x1: p.y, y1: Z(hz), x2: 0, y2: Z(s.bottom), stroke: '#1971c2', 'stroke-width': 0.014, 'stroke-dasharray': '0.07 0.05' }, svg);
    const body = el('rect', {
      x: p.y, y: Z(hz + sch.body_h / 2), width: sch.body_d, height: sch.body_h,
      fill: ok ? 'rgba(47,158,68,0.45)' : 'rgba(224,49,49,0.45)',
      stroke: ok ? '#2b8a3e' : '#e03131', 'stroke-width': 0.02, class: 'side-body',
    }, svg);
    body.addEventListener('pointerdown', e => startDrag(e, { type: 'sidepoint' }));
    const lens = el('g', { class: 'point-handle' }, svg);
    el('circle', { cx: p.y, cy: Z(hz), r: 0.08, fill: 'rgba(25,113,194,0.3)' }, lens);
    el('circle', { cx: p.y, cy: Z(hz), r: 0.045, fill: '#fff', stroke: '#1971c2', 'stroke-width': 0.022 }, lens);
    lens.addEventListener('pointerdown', e => startDrag(e, { type: 'sidepoint' }));
    textAt(svg, p.y + 0.12, Z(hz) - 0.14, '镜头', 0.11, '#1971c2', 'start');
    drawDim(svg, p.y, Z(0), p.y, Z(hz), 0.3, `h=${fmt(hz)}m`, 'S');
    drawDim(svg, 0, H, p.y, H, 0.38, `L=${fmt(p.y)}m`, 'S');
  }
}

function renderSideBlend(svg, Z) {
  const { height: H } = state.room;
  const s = state.screen;
  const br = blendResult;
  if (br) {
    br.zones.forEach((z, i) => {
      const isSel = i === state.selectedZone;
      if (!state.showAll && !isSel) return;
      if (!z.ranges || !z.ranges.y || !z.ranges.z) return;
      const color = zoneColor(i);
      const [y1, y2] = z.ranges.y, [z1, z2] = z.ranges.z;
      el('rect', {
        x: y1, y: Z(z2), width: Math.max(0, y2 - y1), height: Math.max(0, z2 - z1),
        fill: color, 'fill-opacity': isSel ? 0.26 : 0.08,
        stroke: color, 'stroke-width': isSel ? 0.018 : 0.01,
        'stroke-opacity': isSel ? 0.9 : 0.35,
      }, svg);
    });
    br.zones.forEach((z, i) => {
      const sch = schemeOfZone(i);
      const p = state.blendPos[i];
      if (!sch || !p || !z.point) return;
      const isSel = i === state.selectedZone;
      if (!isSel && !state.showAll) return;
      const hz = state.blendZ[i] == null ? defaultLensZ() : state.blendZ[i];
      const color = zoneColor(i);
      const valid = z.point.valid !== false;
      if (isSel) {
        el('line', { x1: p.y, y1: Z(hz), x2: 0, y2: Z(s.bottom + s.height), stroke: color, 'stroke-width': 0.012, 'stroke-dasharray': '0.07 0.05', 'stroke-opacity': 0.8 }, svg);
        el('line', { x1: p.y, y1: Z(hz), x2: 0, y2: Z(s.bottom), stroke: color, 'stroke-width': 0.012, 'stroke-dasharray': '0.07 0.05', 'stroke-opacity': 0.8 }, svg);
      }
      el('rect', {
        x: p.y, y: Z(hz + sch.body_h / 2), width: sch.body_d, height: sch.body_h,
        fill: isSel ? (valid ? color : '#e03131') : color, 'fill-opacity': isSel ? 0.5 : 0.25,
        stroke: valid ? color : '#e03131', 'stroke-width': isSel ? 0.02 : 0.012, class: 'side-body',
      }, svg)
        .addEventListener('pointerdown', e => {
          state.selectedZone = i;
          startDrag(e, { type: 'bside', zone: i });
          render();
        });
      const lens = el('g', { class: 'point-handle' }, svg);
      el('circle', { cx: p.y, cy: Z(hz), r: isSel ? 0.085 : 0.06,
        fill: isSel ? 'rgba(25,113,194,0.25)' : '#fff',
        stroke: valid ? color : '#e03131', 'stroke-width': 0.02 }, lens);
      lens.addEventListener('pointerdown', e => {
        state.selectedZone = i;
        startDrag(e, { type: 'bside', zone: i });
        render();
      });
      if (isSel) {
        textAt(svg, p.y + 0.12, Z(hz) - 0.14,
          `#${i + 1} 镜头 h=${fmt(hz)} L=${fmt(p.y)}`, 0.11, color, 'start');
      }
    });
  }
}

/* ================= 面板动态区 ================= */
function renderSchemeList() {
  const ul = document.getElementById('schemeList');
  ul.innerHTML = '';
  const items = state.schemes.map(sch => ({ sch, r: resultById[sch.id] }));
  // 可行方案排在不可行前；可行方案内普通二维区域（按面积降序）在前、退化安装线（按可行长度降序）在后
  const rankOf = r => (!r || !r.feasible) ? 2 : (r.domain === 'line' ? 1 : 0);
  const metricOf = r => (!r || !r.feasible) ? 0 : (r.domain === 'line' ? r.line_length : r.area);
  items.sort((a, b) => {
    const ra = rankOf(a.r), rb = rankOf(b.r);
    if (ra !== rb) return ra - rb;
    return metricOf(b.r) - metricOf(a.r);
  });
  items.forEach(({ sch, r }, i) => {
    const li = document.createElement('li');
    li.className = 'scheme-item' + (sch.id === state.selectedSchemeId ? ' selected' : '');
    const feasible = r && r.feasible;
    let areaTxt;
    if (!r) areaTxt = '…';
    else if (feasible && r.domain === 'line') areaTxt = `安装线 ${fmt(r.line_length)} m`;
    else if (feasible) areaTxt = `${fmt(r.area)} m²`;
    else areaTxt = '不可行';
    li.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="chip" style="background:${colorOf(sch.id)}"></span>` +
      `<span class="name" title="${esc(sch.name)}">${esc(sch.name)}</span>` +
      `<span class="tr">TR ${sch.tr_min}–${sch.tr_max}</span>` +
      `<span class="area ${feasible ? '' : 'bad'}">${areaTxt}</span>`;
    if (r && !feasible && r.diagnostics.length) li.title = r.diagnostics.join('\n');
    li.addEventListener('click', () => { state.selectedSchemeId = sch.id; onStateChange(); });
    ul.appendChild(li);
  });
  document.getElementById('delSchemeBtn').disabled = state.schemes.length <= 1;
  document.getElementById('schemeEditorCard').style.display = currentScheme() ? '' : 'none';
}

function renderObstacleList() {
  const ul = document.getElementById('obstacleList');
  ul.innerHTML = '';
  for (const ob of state.obstacles) {
    const li = document.createElement('li');
    li.className = 'ob-item' + (ob.id === state.selectedObstacleId ? ' selected' : '');
    li.innerHTML = `<span class="ob-dot"></span><span>${esc(ob.name)}</span>` +
      `<span class="dim">${fmt(ob.w)}×${fmt(ob.h)}m @ (${fmt(ob.x)}, ${fmt(ob.y)})</span>`;
    li.addEventListener('click', () => { state.selectedObstacleId = ob.id; render(); });
    ul.appendChild(li);
  }
  if (!state.obstacles.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = '暂无禁装区';
    ul.appendChild(li);
  }
  document.getElementById('delObstacleBtn').disabled = !state.selectedObstacleId;
}

/* ================= 多机拼接面板 ================= */
function renderZoneList() {
  const ul = document.getElementById('zoneList');
  ul.innerHTML = '';
  const { lefts, endRight } = layoutZones();
  state.zones.forEach((z, i) => {
    const li = document.createElement('li');
    const zr = blendResult && blendResult.zones[i];
    const feasible = zr && zr.feasible;
    const bad = zr && !zr.feasible;
    li.className = 'zone-item' + (i === state.selectedZone ? ' selected' : '') + (bad ? ' bad' : '');
    let stat;
    if (!zr) stat = '…';
    else if (!feasible) stat = '不可行';
    else if (zr.domain === 'line') stat = `安装线 ${fmt(zr.line_length)} m`;
    else stat = `${fmt(zr.area)} m²`;
    const schOpts = state.schemes.map(s =>
      `<option value="${esc(s.id)}" ${s.id === z.scheme_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    const diagTxt = (zr && !zr.feasible && zr.diagnostics.length)
      ? `<div class="zone-vdiag">${zr.diagnostics.slice(0, 2).map(esc).join('<br>')}</div>` : '';
    const ovInfo = i > 0 && zr && blendResult.coverage[i]
      ? `<span class="${blendResult.coverage[i].overlap_prev + 0.005 >= z.min_overlap ? '' : 'cov-bad'}">` +
        `实际重叠 ${fmt(blendResult.coverage[i].overlap_prev)}m</span>` : '';
    li.innerHTML =
      `<div class="zone-head">` +
      `<span class="rank" style="background:${zoneColor(i)}">${i + 1}</span>` +
      `<span class="zname">${esc(z.name)}</span>` +
      `<span class="zstat ${feasible ? '' : 'bad'}">${stat}</span></div>` +
      `<div class="zone-grid">` +
      `<label class="span2">镜头方案<select data-z="${i}" data-k="scheme_id">${schOpts}</select></label>` +
      `<label>区间宽 (m)<input type="number" step="0.05" min="0.1" data-z="${i}" data-k="width" value="${fmt(z.width)}"></label>` +
      (i === 0
        ? `<label>自幕左缘 0m<input value="—" disabled></label>`
        : `<label>最小拼接重叠 (m)<input type="number" step="0.05" min="0" data-z="${i}" data-k="min_overlap" value="${fmt(z.min_overlap)}"></label>`) +
      `<label>横向检修净距 (m)<input type="number" step="0.05" min="0" data-z="${i}" data-k="service_x" value="${fmt(z.service_x)}"></label>` +
      `<label>纵深检修净距 (m)<input type="number" step="0.05" min="0" data-z="${i}" data-k="service_y" value="${fmt(z.service_y)}"></label>` +
      `</div>${ovInfo ? `<div class="hint" style="margin-top:3px">${ovInfo}</div>` : ''}${diagTxt}`;
    li.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
      state.selectedZone = i;
      render();
    });
    li.querySelectorAll('input[data-z]').forEach(inp => {
      inp.addEventListener('input', e => {
        const k = e.target.dataset.k;
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v)) {
          state.zones[i][k] = v;
          // 区间宽度/重叠/净距变化后旧固定点不再可信，回到整组自动布点
          clearPins();
          onStateChange();
        }
      });
      inp.addEventListener('pointerdown', e => e.stopPropagation());
    });
    li.querySelectorAll('select[data-z]').forEach(sel2 => {
      sel2.addEventListener('change', e => {
        state.zones[i][e.target.dataset.k] = e.target.value;
        clearPins();
        onStateChange();
      });
      sel2.addEventListener('pointerdown', e => e.stopPropagation());
    });
    ul.appendChild(li);
  });
}

function renderBlendInfo() {
  const box = document.getElementById('blendInfo');
  const br = blendResult;
  let html = '<h2>拼接联合状态</h2>';
  if (!br) {
    box.innerHTML = html + '<p class="hint">计算中…</p>';
    return;
  }
  const statusMap = {
    ok: ['✅ 联合方案可行', 'ok-box', '所有设备可安装域非空，覆盖区间从左到右连续铺满幕布，邻接重叠达标，检修包络彼此及与禁装区均不相交。'],
    pin_conflict: ['⚠ 当前拖动点冲突（未保存为方案）', 'diag-box', '自由解仍然可行；冲突仅来自被拖动固定的安装点，其余设备已按自由解放置。'],
    joint_conflict: ['❌ 联合约束冲突，不存在可行安装点组合', 'diag-box', '各台单独可行，但检修包络互斥约束无法同时满足。'],
    device_infeasible: ['❌ 存在设备无解，不保存部分方案', 'diag-box', '以下设备的可安装域为空，请按其区间诊断调整。'],
    structure_error: ['❌ 覆盖区间结构错误', 'diag-box', '区间未连续覆盖整幅幕布或重叠设置非法。'],
  };
  const [title, cls, sub] = statusMap[br.status] || statusMap.ok;
  html += `<div class="${cls}"><b>${title}</b><div class="hint" style="color:inherit;opacity:0.9">${sub}</div></div>`;

  // 覆盖连续性
  const { endRight } = layoutZones();
  const gap = state.screen.width - endRight;
  html += '<div class="blend-summary" style="margin-top:7px">';
  if (Math.abs(gap) <= 0.005) {
    html += `<div class="cov-ok">✓ 区间从左到右连续覆盖整幅幕布（末缘 ${fmt(endRight)}m ＝ 幕宽 ${fmt(state.screen.width)}m）</div>`;
  } else {
    html += `<div class="cov-bad">✗ ${gap > 0 ? '末缘距幕布右缘仍有缺口' : '末区间超出幕布右缘'} ${fmt(Math.abs(gap))}m</div>`;
  }
  for (let i = 1; i < state.zones.length; i++) {
    const cov = br.coverage[i];
    const ok = cov && cov.overlap_prev + 0.005 >= state.zones[i].min_overlap;
    html += `<div class="${ok ? 'cov-ok' : 'cov-bad'}">${ok ? '✓' : '✗'} 区间 ${i}/${i + 1} 邻接重叠 ${cov ? fmt(cov.overlap_prev) : '—'}m ` +
      `（要求 ≥ ${fmt(state.zones[i].min_overlap)}m）</div>`;
  }
  html += '</div>';

  // 每台一行：可安装域 + 当前点 + 冲突
  html += '<div style="margin-top:7px">';
  br.zones.forEach((z, i) => {
    const pos = state.blendPos[i];
    const pinned = state.blendPinned[i];
    html += `<div class="pair-row">` +
      `<span class="ico" style="color:${zoneColor(i)}">●</span>` +
      `<span style="font-weight:600">#${i + 1} ${esc(z.scheme_name || '未选方案')}</span>` +
      `<span class="hint" style="margin-left:auto;text-align:right">` +
      (pos ? `(${fmt(pos.x)}, ${fmt(pos.y)}) ${pinned ? '固定' : '自动'}` : '无安装点') +
      `</span></div>`;
    if (!z.feasible) {
      z.diagnostics.forEach(d => { html += `<div class="pair-row" style="color:#c92a2a"><span class="ico">✗</span><span>区间 ${i + 1}：${esc(d)}</span></div>`; });
    }
    (z.violations || []).forEach(v => { html += `<div class="pair-row" style="color:#c92a2a"><span class="ico">✗</span><span>区间 ${i + 1}：${esc(v)}</span></div>`; });
  });
  html += '</div>';

  if (br.diagnostics.length) {
    html += '<div class="diag-box" style="margin-top:7px"><b>诊断（设备 / 区间 / 冲突来源）：</b><ul>' +
      br.diagnostics.map(d => `<li>${esc(d)}</li>`).join('') + '</ul></div>';
  }
  if (br.status === 'pin_conflict') {
    html += '<p class="hint">点击「配平区间并自动布点」或双击安装点可解除固定、恢复整组自由解。</p>';
  }
  box.innerHTML = html;
}

function renderPointInfo() {
  const box = document.getElementById('pointInfo');
  const sch = currentScheme();
  const sel = resultById[state.selectedSchemeId];
  if (!sch || !sel) {
    box.innerHTML = '<h2>选点与约束</h2><p class="hint">请添加并选择镜头方案</p>';
    return;
  }
  let html = `<h2>选点与约束 — ${esc(sel.name)}</h2>`;
  if (sel.diagnostics.length) {
    html += `<div class="diag-box"><b>⚠ 可安装区域为空，冲突约束：</b><ul>` +
      sel.diagnostics.map(d => `<li>${esc(d)}</li>`).join('') + '</ul></div>';
  } else if (sel.feasible) {
    if (sel.domain === 'line') {
      html += `<div class="ok-box">✅ 水平位移为 0，退化为固定 x=<b>${fmt(sel.base_rect[0])}m</b> 的安装线，` +
        `扣除禁装区后可行纵深合计 <b>${fmt(sel.line_length)} m</b>（面积为 0 但仍可沿线安放）</div>`;
    } else {
      html += `<div class="ok-box">✅ 可安装区域面积 <b>${fmt(sel.area)} m²</b>（镜头位置）</div>`;
    }
  }
  const p = sel.point;
  if (p) {
    const zr = sel.ranges.z;
    const rows = [
      ['投射距离', p.checks.throw,
        `L=${fmt(p.throw_distance)}m → 投射比 ${fmt(p.throw_ratio)}（要求 ${sch.tr_min}–${sch.tr_max}）`],
      ['水平位移', p.checks.shift,
        `偏移 ${fmt(p.h_shift_used * state.screen.width)}m＝${fmt(p.h_shift_used * 100, 0)}% 幕宽（允许 ±${fmt(sch.h_shift * 100, 0)}%）`],
      ['墙面余量', p.checks.wall,
        p.checks.wall ? '机身与四墙余量满足' : '机身越出墙面余量边界'],
      ['机身避障', p.checks.obstacle,
        p.checks.obstacle ? '未触碰禁装区' : `与禁装区「${esc(p.obstacle_hit || '')}」相交`],
      ['镜头高度', p.checks.height,
        `h=${fmt(p.z)}m＝位移 ${fmt(p.v_shift_used * 100, 0)}% 幕高` +
        (zr ? `（允许 ${fmt(zr[0])}–${fmt(zr[1])}m）` : '（垂直方向无解）')],
    ];
    html += '<table class="checks">' + rows.map(([name, ok, txt]) =>
      `<tr><td class="ico">${ok ? '✅' : '❌'}</td><td class="cname">${name}</td><td>${txt}</td></tr>`).join('') +
      '</table>';
    html += p.ok
      ? '<div class="ok-box">✅ 当前选点可安装</div>'
      : '<div class="diag-box">❌ 当前选点不可安装（见上方 ✗ 项）</div>';
  }
  box.innerHTML = html;
}

/* ================= 输入绑定 ================= */
const numBindings = [];
function bindNum(id, get, set, digits = 2) {
  const input = document.getElementById(id);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) { set(v); onStateChange(); }
  });
  numBindings.push([input, get, digits]);
}

function syncInputs() {
  for (const [input, get, digits] of numBindings) {
    if (document.activeElement !== input) input.value = fmt(get(), digits);
  }
  const sch = currentScheme();
  document.getElementById('schName').value = sch ? sch.name : '';
  // 镜头高度滑块
  const slider = document.getElementById('lensHeight');
  if (state.mode === 'blend') {
    const zi = state.selectedZone;
    const zr = blendResult && blendResult.zones[zi];
    const lo = zr && zr.ranges && zr.ranges.z ? zr.ranges.z[0] : 0;
    const hi = zr && zr.ranges && zr.ranges.z ? zr.ranges.z[1] : state.room.height;
    slider.min = lo.toFixed(2);
    slider.max = hi.toFixed(2);
    const hz = state.blendZ[zi] == null ? defaultLensZ() : state.blendZ[zi];
    if (document.activeElement !== slider) slider.value = hz;
    document.getElementById('lensHeightVal').textContent = fmt(hz) + ' m';
    const hint = document.getElementById('lensHeightHint');
    if (zr && zr.ranges && zr.ranges.z) {
      hint.textContent = `区间 ${zi + 1} 允许 ${fmt(lo)}–${fmt(hi)} m（区间中心高 ${fmt(zr.derived.sc)}m）`;
      hint.className = 'hint';
    } else {
      hint.textContent = '⚠ 该区间设备垂直方向无可行高度';
      hint.className = 'hint warn';
    }
    return;
  }
  const sel = resultById[state.selectedSchemeId];
  const lo = sel && sel.ranges.z ? sel.ranges.z[0] : 0;
  const hi = sel && sel.ranges.z ? sel.ranges.z[1] : state.room.height;
  slider.min = lo.toFixed(2);
  slider.max = hi.toFixed(2);
  if (document.activeElement !== slider) slider.value = state.lensHeight;
  document.getElementById('lensHeightVal').textContent = fmt(state.lensHeight) + ' m';
  const hint = document.getElementById('lensHeightHint');
  if (sel && sel.ranges.z) {
    hint.textContent = `允许 ${fmt(lo)}–${fmt(hi)} m（幕布中心 ${fmt(sel.derived.sc)}m，垂直位移 ±${fmt(sch.v_shift * 100, 0)}%）`;
    hint.className = 'hint';
  } else if (sel) {
    hint.textContent = '⚠ 该方案垂直方向无可行高度';
    hint.className = 'hint warn';
  } else {
    hint.textContent = '';
  }
}

function bindAllInputs() {
  const R = () => state.room, S = () => state.screen;
  bindNum('roomWidth', () => R().width, v => R().width = v);
  bindNum('roomDepth', () => R().depth, v => R().depth = v);
  bindNum('roomHeight', () => R().height, v => R().height = v);
  bindNum('roomMargin', () => R().margin, v => R().margin = v);
  bindNum('screenWidth', () => S().width, v => {
    const old = S().width;
    S().width = v;
    if (state.mode === 'blend' && state.zones.length) {
      // 幕宽变化后按比例缩放各区间与重叠，保持覆盖结构尽量连续并重新自动布点
      const k = old > 0 ? v / old : 1;
      for (const z of state.zones) {
        z.width = clamp(z.width * k, 0.1, v);
        z.min_overlap = clamp(z.min_overlap * k, 0, v);
      }
      clearPins();
    }
  });
  bindNum('screenHeight', () => S().height, v => S().height = v);
  bindNum('screenBottom', () => S().bottom, v => S().bottom = v);
  bindNum('screenCx', () => S().cx, v => S().cx = v);
  bindNum('schTrMin', () => currentScheme()?.tr_min ?? 0, v => { const s = currentScheme(); if (s) s.tr_min = v; });
  bindNum('schTrMax', () => currentScheme()?.tr_max ?? 0, v => { const s = currentScheme(); if (s) s.tr_max = v; });
  bindNum('schHShift', () => (currentScheme()?.h_shift ?? 0) * 100, v => { const s = currentScheme(); if (s) s.h_shift = v / 100; }, 0);
  bindNum('schVShift', () => (currentScheme()?.v_shift ?? 0) * 100, v => { const s = currentScheme(); if (s) s.v_shift = v / 100; }, 0);
  bindNum('schBodyW', () => currentScheme()?.body_w ?? 0, v => { const s = currentScheme(); if (s) s.body_w = v; });
  bindNum('schBodyD', () => currentScheme()?.body_d ?? 0, v => { const s = currentScheme(); if (s) s.body_d = v; });
  bindNum('schBodyH', () => currentScheme()?.body_h ?? 0, v => { const s = currentScheme(); if (s) s.body_h = v; });

  document.getElementById('schName').addEventListener('input', e => {
    const s = currentScheme();
    if (s) { s.name = e.target.value; renderSchemeList(); scheduleCompute(); }
  });
  document.getElementById('lensHeight').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    if (state.mode === 'blend') {
      const i = state.selectedZone;
      state.blendZ[i] = v;
      state.blendPinned[i] = true;   // 侧视图调高度同样视为用户固定该台
    } else {
      state.lensHeight = v;
    }
    onStateChange();
  });
  document.getElementById('showAll').addEventListener('change', e => {
    state.showAll = e.target.checked;
    render();
  });
  document.getElementById('addSchemeBtn').addEventListener('click', () => {
    const s = {
      id: uid(), name: `方案 ${state.schemes.length + 1}`,
      tr_min: 1.2, tr_max: 1.9, h_shift: 0.25, v_shift: 0.4,
      body_w: 0.4, body_d: 0.32, body_h: 0.15,
    };
    state.schemes.push(s);
    state.selectedSchemeId = s.id;
    onStateChange();
  });
  document.getElementById('delSchemeBtn').addEventListener('click', () => {
    if (state.schemes.length <= 1) return;
    const gone = state.selectedSchemeId;
    state.schemes = state.schemes.filter(s => s.id !== gone);
    state.selectedSchemeId = state.schemes[0].id;
    // 拼接区间若引用了被删方案，回退到第一个方案并重新布点
    let reassign = false;
    for (const z of state.zones) {
      if (z.scheme_id === gone) { z.scheme_id = state.schemes[0].id; reassign = true; }
    }
    if (reassign) clearPins();
    onStateChange();
  });
  // ---- 模式切换 ----
  const btnSingle = document.getElementById('modeSingle');
  const btnBlend = document.getElementById('modeBlend');
  btnSingle.addEventListener('click', () => setMode('single'));
  btnBlend.addEventListener('click', () => setMode('blend'));
  // ---- 多机拼接控件 ----
  document.getElementById('zoneCount').addEventListener('change', e => {
    const growing = parseInt(e.target.value, 10) > state.zones.length;
    ensureZones(parseInt(e.target.value, 10));
    if (growing) balanceZones();   // 新增区间后自动配平铺满幕布
    clearPins();
    onStateChange();
  });
  document.getElementById('autoBlendBtn').addEventListener('click', () => {
    balanceZones();
    onStateChange();
  });
  const drawBtn = document.getElementById('drawBtn');
  drawBtn.addEventListener('click', () => {
    state.drawMode = !state.drawMode;
    drawBtn.classList.toggle('active', state.drawMode);
    topSvg.classList.toggle('drawing', state.drawMode);
  });
  document.getElementById('delObstacleBtn').addEventListener('click', deleteSelectedObstacle);
  window.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedObstacleId) {
      deleteSelectedObstacle();
    } else if (e.key === 'Escape') {
      state.drawMode = false;
      state.selectedObstacleId = null;
      drawBtn.classList.remove('active');
      topSvg.classList.remove('drawing');
      onStateChange();
    }
  });
}

function deleteSelectedObstacle() {
  if (!state.selectedObstacleId) return;
  state.obstacles = state.obstacles.filter(o => o.id !== state.selectedObstacleId);
  state.selectedObstacleId = null;
  onStateChange();
}

/* ================= 视图交互 ================= */
function setMode(mode) {
  if (state.mode === mode) return;
  // 离开当前模式时取消绘制禁装区状态
  state.drawMode = false;
  document.getElementById('drawBtn').classList.remove('active');
  topSvg.classList.remove('drawing');
  state.mode = mode;
  if (mode === 'blend') {
    if (!state.zones.length) {
      ensureZones(parseInt(document.getElementById('zoneCount').value, 10) || 2);
    }
    clearPins();
  }
  onStateChange();
}

function startDrag(e, info) {
  drag = info;
  e.stopPropagation();
  e.preventDefault();
}

function attachViewHandlers() {
  topSvg.addEventListener('pointerdown', e => {
    const p = svgWorld(topSvg, e);
    const W = state.room.width, D = state.room.depth;
    if (state.drawMode) {
      drag = { type: 'draw', x0: clamp(p.x, 0, W), y0: clamp(p.y, 0, D), x1: clamp(p.x, 0, W), y1: clamp(p.y, 0, D) };
      onStateChange();
    } else if (state.mode === 'single') {
      state.point.x = clamp(p.x, 0, W);
      state.point.y = clamp(p.y, 0, D);
      drag = { type: 'point' };
      onStateChange();
    }
    // 拼接模式：空白处不布置点，安装点只能拖动各自手柄
  });
  sideSvg.addEventListener('pointerdown', e => {
    if (state.mode !== 'single') return;
    const p = svgWorld(sideSvg, e);
    state.point.y = clamp(p.x, 0, state.room.depth);
    state.lensHeight = clamp(state.room.height - p.y, 0, state.room.height);
    drag = { type: 'sidepoint' };
    onStateChange();
  });

  window.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.type === 'sidepoint') {
      const p = svgWorld(sideSvg, e);
      state.point.y = clamp(p.x, 0, state.room.depth);
      state.lensHeight = clamp(state.room.height - p.y, 0, state.room.height);
    } else if (drag.type === 'bside') {
      const p = svgWorld(sideSvg, e);
      const i = drag.zone;
      if (!state.blendPos[i]) state.blendPos[i] = { x: state.screen.cx, y: p.x };
      state.blendPos[i].y = clamp(p.x, 0, state.room.depth);
      state.blendZ[i] = clamp(state.room.height - p.y, 0, state.room.height);
      state.blendPinned[i] = true;
    } else if (drag.type === 'bpoint') {
      const p = svgWorld(topSvg, e);
      const W = state.room.width, D = state.room.depth;
      const i = drag.zone;
      state.blendPos[i] = { x: clamp(p.x, 0, W), y: clamp(p.y, 0, D) };
      state.blendPinned[i] = true;
    } else {
      const p = svgWorld(topSvg, e);
      const W = state.room.width, D = state.room.depth;
      if (drag.type === 'point') {
        state.point.x = clamp(p.x, 0, W);
        state.point.y = clamp(p.y, 0, D);
      } else if (drag.type === 'screen') {
        state.screen.cx = clamp(p.x - drag.dx, state.screen.width / 2, W - state.screen.width / 2);
      } else if (drag.type === 'ob') {
        const ob = state.obstacles.find(o => o.id === drag.id);
        if (ob) {
          ob.x = clamp(p.x - drag.dx, 0, W - ob.w);
          ob.y = clamp(p.y - drag.dy, 0, D - ob.h);
        }
      } else if (drag.type === 'obresize') {
        const ob = state.obstacles.find(o => o.id === drag.id);
        if (ob) {
          ob.w = clamp(p.x - ob.x, 0.1, W - ob.x);
          ob.h = clamp(p.y - ob.y, 0.1, D - ob.y);
        }
      } else if (drag.type === 'draw') {
        drag.x1 = clamp(p.x, 0, W);
        drag.y1 = clamp(p.y, 0, D);
      }
    }
    onStateChange();
  });

  window.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.type === 'draw') {
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
      const w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
      if (w > 0.08 && h > 0.08) {
        const ob = { id: uid(), name: `禁装区${state.obstacles.length + 1}`, x, y, w, h };
        state.obstacles.push(ob);
        state.selectedObstacleId = ob.id;
      }
    }
    drag = null;
    onStateChange();
  });
}

/* ================= 渲染总入口 ================= */
function render() {
  sanitize();
  const blend = state.mode === 'blend';
  document.getElementById('views').classList.toggle('single-mode', !blend);
  document.getElementById('modeSingle').classList.toggle('active', !blend);
  document.getElementById('modeBlend').classList.toggle('active', blend);
  document.getElementById('blendPlannerCard').style.display = blend ? '' : 'none';
  document.getElementById('blendInfo').style.display = blend ? '' : 'none';
  document.getElementById('pointInfo').style.display = blend ? 'none' : '';
  document.getElementById('lensHeightCard').style.display = '';
  topSvg.style.cursor = blend ? 'default' : (state.drawMode ? 'copy' : 'crosshair');
  document.getElementById('zoneCount').value = String(state.zones.length || 2);

  renderTop();
  renderSide();
  if (blend) {
    renderStrip();
    renderZoneList();
    renderBlendInfo();
  }
  renderSchemeList();
  renderObstacleList();
  if (!blend) renderPointInfo();
  syncInputs();
}

/* ================= 示例 ================= */
function applyState(data) {
  state.room = { ...data.room };
  state.screen = { ...data.screen };
  state.schemes = data.schemes.map(s => ({ ...s, id: uid() }));
  state.obstacles = (data.obstacles || []).map(o => ({ ...o, id: uid() }));
  state.selectedSchemeId = state.schemes.length ? state.schemes[0].id : null;
  state.selectedObstacleId = null;
  const first = state.schemes[0];
  state.point = {
    x: state.screen.cx,
    y: first ? clamp((first.tr_min + first.tr_max) / 2 * state.screen.width, 0, state.room.depth) : state.room.depth / 2,
  };
  state.lensHeight = state.screen.bottom + state.screen.height / 2;
  result = null;
  resultById = {};
  blendResult = null;

  // 多机拼接示例：zones[i].scheme 为方案在 schemes 数组中的下标
  if (Array.isArray(data.zones) && data.zones.length >= 2) {
    state.mode = 'blend';
    state.zones = data.zones.map((z, i) => ({
      name: z.name || `区间 ${i + 1}`,
      scheme_id: state.schemes[z.scheme ?? i] ? state.schemes[z.scheme ?? i].id
        : (state.schemes[i] ? state.schemes[i].id : state.schemes[0]?.id ?? null),
      width: z.width,
      min_overlap: z.min_overlap ?? 0,
      service_x: z.service_x ?? z.service ?? 0.3,
      service_y: z.service_y ?? z.service ?? 0.3,
    }));
    state.selectedZone = 0;
    clearPins();
  } else {
    state.mode = 'single';
    state.zones = [];
  }
  onStateChange();
}

async function initExamples() {
  try {
    const res = await fetch('/api/examples');
    examples = await res.json();
  } catch (err) {
    examples = [];
  }
  const sel = document.getElementById('exampleSelect');
  sel.innerHTML = '<option value="">载入示例…</option>' +
    examples.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
  sel.addEventListener('change', () => {
    const ex = examples.find(x => x.id === sel.value);
    if (ex) applyState(ex.data);
    sel.value = '';
  });
  if (examples.length) applyState(examples[0].data);
}

/* ================= 启动 ================= */
bindAllInputs();
attachViewHandlers();
render();
initExamples();
