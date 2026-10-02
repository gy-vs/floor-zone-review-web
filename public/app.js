// 分区审阅工作台前端。
// 本地用同一套共享几何内核实时预览；保存后“是否可交付”只以服务端 /api/check 结论为准。
import { analyze, stableStringify, clone, ringArea } from '/shared/geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LS_DRAFT = 'fz.draft.v1';
const LS_WHO = 'fz.who.v1';
const ZONE_COLORS = ['#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#22d3ee', '#fb923c', '#4ade80'];

const $ = (sel) => document.querySelector(sel);
const el = (name, attrs = {}, children = []) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(c);
  return node;
};
const h = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};
const fmt = (x) => (Math.abs(x) < 1e-9 ? '0' : Number(x.toFixed(3)).toString());

/* ------------------------------- 服务端 API ------------------------------- */

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || data.error || `请求失败 ${res.status}`), { status: res.status, data });
  return data;
}

/* --------------------------------- 状态 ---------------------------------- */

const state = {
  view: 'draft',
  head: null, // {rev, seq, plan, savedBy, savedAt}
  headCheck: null,
  confirmation: null,
  confirmedData: null, // {revision, check}
  draftPlan: null,
  baseRev: null, // 草稿所依据的服务端 rev
  selected: null, // {kind:'zone'|'unusable'|'floor'|'issue', id, issueRev?}
  locate: null, // {kind, id, index} 顶点定位闪烁
  tool: 'select',
  drawing: null, // {kind:'floor'|'unusable'|'zone', points:[[x,y]...]}
  snap: 0.05,
  saving: false,
  pollTimer: null,
};

const viewPlan = () =>
  state.view === 'draft' ? state.draftPlan :
  state.view === 'saved' ? state.head?.plan :
  state.confirmedData?.revision?.plan;

function reportForView() {
  if (state.view === 'draft') {
    try {
      return { ok: true, report: analyze(state.draftPlan) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (state.view === 'saved') {
    if (!state.headCheck) return { ok: false, pending: true };
    if (state.headCheck.error) return { ok: false, error: state.headCheck.error };
    return { ok: true, report: state.headCheck.report, server: true };
  }
  const c = state.confirmedData?.check;
  if (!c) return { ok: false, pending: true };
  if (c.error) return { ok: false, error: c.error };
  return { ok: true, report: c.report, server: true };
}

const isDirty = () => !!state.head && !!state.draftPlan && stableStringify(state.draftPlan) !== stableStringify(state.head.plan);
const isStale = () => isDirty() && state.baseRev !== state.head.rev;

/* ------------------------------ 本地草稿持久化 ------------------------------ */

function persistDraft() {
  if (!state.draftPlan) return;
  localStorage.setItem(LS_DRAFT, JSON.stringify({ plan: state.draftPlan, baseRev: state.baseRev }));
}
function loadPersistedDraft() {
  try {
    const raw = localStorage.getItem(LS_DRAFT);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* -------------------------------- 初始化 --------------------------------- */

async function init() {
  $('#savedBy').value = localStorage.getItem(LS_WHO) || '';
  $('#savedBy').addEventListener('change', (e) => localStorage.setItem(LS_WHO, e.target.value.trim()));
  bindUI();
  await refreshFromServer(true);
  render();
}

async function refreshFromServer(initial = false) {
  const snap = await api('/api/state');
  state.head = snap.head;
  state.headCheck = snap.headCheck;
  state.confirmation = snap.confirmation;

  if (initial && state.view === 'draft' && (!state.draftPlan)) {
    const stored = loadPersistedDraft();
    if (stored && stored.plan && stored.baseRev) {
      state.draftPlan = stored.plan;
      state.baseRev = stored.baseRev;
      if (stored.baseRev !== state.head.rev && stableStringify(stored.plan) !== stableStringify(state.head.plan)) {
        showBanner('warn', `恢复的本地草稿基于旧版本 ${stored.baseRev.split('-')[0]}，服务端已更新到 #${state.head.seq}。草稿已保留，可对照后决定。`);
      } else if (stableStringify(stored.plan) === stableStringify(state.head.plan)) {
        state.draftPlan = clone(state.head.plan);
        state.baseRev = state.head.rev;
      }
    } else {
      state.draftPlan = clone(state.head.plan);
      state.baseRev = state.head.rev;
    }
  }

  if (state.view === 'confirmed' && state.confirmation) {
    state.confirmedData = await api(`/api/revision?rev=${encodeURIComponent(state.confirmation.rev)}`);
  }
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const wantPoll =
    (state.view !== 'confirmed' && state.headCheck?.status === 'pending') ||
    (state.view === 'confirmed' && state.confirmation && state.confirmedData?.check?.status !== 'done');
  if (!wantPoll) return;
  state.pollTimer = setTimeout(async () => {
    try {
      if (state.view === 'confirmed' && state.confirmation) {
        state.confirmedData = await api(`/api/revision?rev=${encodeURIComponent(state.confirmation.rev)}`);
      } else {
        const c = await api(`/api/check?rev=${encodeURIComponent(state.head.rev)}`);
        state.headCheck = c.check;
      }
    } finally {
      render();
      schedulePoll();
    }
  }, 350);
}

/* -------------------------------- UI 绑定 -------------------------------- */

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.id === `tool-${tool}`));
  const drawing = ['floor', 'unusable', 'zone'].includes(tool);
  $('#draw-actions').style.display = drawing ? '' : 'none';
  if (!drawing) state.drawing = null;
  $('#plan').style.cursor = drawing ? 'crosshair' : 'default';
  if (!drawing) render();
}

function bindUI() {
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', async () => {
      state.view = tab.dataset.view;
      state.selected = null;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.body.classList.toggle('view-readonly', state.view !== 'draft');
      if (state.view === 'confirmed' && state.confirmation) {
        try {
          state.confirmedData = await api(`/api/revision?rev=${encodeURIComponent(state.confirmation.rev)}`);
        } catch { /* 版本缺失时由面板提示 */ }
      }
      render();
      schedulePoll();
    })
  );

  $('#tool-select').addEventListener('click', () => setTool('select'));
  $('#tool-floor').addEventListener('click', () => startDraw('floor'));
  $('#tool-unusable').addEventListener('click', () => startDraw('unusable'));
  $('#tool-zone').addEventListener('click', () => startDraw('zone'));
  $('#draw-finish').addEventListener('click', finishDraw);
  $('#draw-cancel').addEventListener('click', () => setTool('select'));
  $('#snap').addEventListener('change', (e) => (state.snap = e.target.checked ? 0.05 : 0));
  $('#show-issues').addEventListener('change', () => render());
  $('#show-grid').addEventListener('change', () => render());
  $('#load-demo').addEventListener('click', loadDemo);

  $('#btn-save').addEventListener('click', saveDraft);
  $('#btn-confirm').addEventListener('click', confirmDelivery);
  $('#btn-discard').addEventListener('click', () => {
    state.draftPlan = clone(state.head.plan);
    state.baseRev = state.head.rev;
    state.selected = null;
    persistDraft();
    hideBanner();
    render();
  });
  $('#btn-refresh').addEventListener('click', async () => {
    await refreshFromServer();
    render();
  });

  bindCanvas();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 80);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.drawing) setTool('select');
      state.locate = null;
      render();
    }
    if ((e.key === 'Enter') && state.drawing && state.drawing.points.length >= 3) finishDraw();
  });
}

/* --------------------------------- 绘制 ---------------------------------- */

function startDraw(kind) {
  if (state.view !== 'draft') return;
  if (kind === 'floor' && viewPlan().floor.polygon.length &&
      !confirm('重绘楼层外轮廓将替换当前外轮廓（分区数据保留，越界会被标为问题）。继续？')) return;
  state.selected = null;
  state.drawing = { kind, points: [] };
  setTool(kind);
}

function finishDraw() {
  if (!state.drawing || state.drawing.points.length < 3) return;
  const { kind, points } = state.drawing;
  const p = state.draftPlan;
  if (kind === 'floor') {
    p.floor = { name: p.floor?.name || '一层', polygon: points };
  } else if (kind === 'unusable') {
    p.unusable.push({ id: `u${Date.now()}`, name: `设备间 ${p.unusable.length + 1}`, polygon: points });
  } else {
    const z = { id: `z${Date.now()}`, name: `分区 ${p.zones.length + 1}`, polygon: points };
    p.zones.push(z);
    state.selected = { kind: 'zone', id: z.id };
  }
  setTool('select');
  afterDraftChange();
}

function loadDemo() {
  state.draftPlan = {
    floor: { name: '一层 10m×8m', polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] },
    unusable: [],
    zones: [
      { id: 'demo-a', name: '区域 A（0–6m）', polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
      { id: 'demo-b', name: '区域 B（5–10m）', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
    ],
  };
  state.selected = null;
  afterDraftChange();
  showBanner('info', '已载入核对示例：A、B 在 x=5–6m 间有 1m 宽 × 8m = 8m² 重复带。把 A 的两个 x=6 顶点改到 x=5，重复带应消失（仅边界相接）。');
}

function afterDraftChange() {
  persistDraft();
  hideBanner();
  render();
}

/* ------------------------------ 坐标 / 投影 ------------------------------- */

function computeFrame(plan, report) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eatRing = (r) => r.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
  eatRing(plan.floor.polygon);
  (plan.zones || []).forEach((z) => eatRing(z.polygon));
  (plan.unusable || []).forEach((u) => eatRing(u.polygon));
  if (report?.issues) for (const iss of report.issues) (iss.multipolygon || []).forEach((poly) => poly.forEach(eatRing));
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 10; maxY = 8; }
  const padWorld = Math.max((maxX - minX), (maxY - minY)) * 0.08 || 1;
  minX -= padWorld; minY -= padWorld; maxX += padWorld; maxY += padWorld;

  const stage = $('#stage').getBoundingClientRect();
  const W = Math.max(320, stage.width), H = Math.max(240, stage.height);
  const M = 36;
  const s = Math.min((W - 2 * M) / (maxX - minX), (H - 2 * M) / (maxY - minY));
  const ox = (W - s * (maxX - minX)) / 2;
  const oy = (H - s * (maxY - minY)) / 2;
  return { minX, minY, maxX, maxY, s, ox, oy, W, H };
}
// 米坐标（y 向上）→ 屏幕（y 向下）
const projector = (f) => ({
  toScreen: ([x, y]) => [f.ox + (x - f.minX) * f.s, f.oy + (f.maxY - y) * f.s],
  toWorld: ([px, py]) => [f.minX + (px - f.ox) / f.s, f.maxY - (py - f.oy) / f.s],
});
function ringPath(ctx, ring) {
  const pts = ring.map(ctx.toScreen);
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('') + 'Z';
}
function mpPath(ctx, mp) {
  return mp.map((poly) => poly.map((ring) => ringPath(ctx, ring)).join(' ')).join(' ');
}
function centroid(ring) {
  let x = 0, y = 0;
  ring.forEach((p) => { x += p[0]; y += p[1]; });
  return [x / ring.length, y / ring.length];
}

/* -------------------------------- 渲染 ----------------------------------- */

const layers = () => ({
  grid: $('#layer-grid'), floor: $('#layer-floor'), unusable: $('#layer-unusable'),
  zones: $('#layer-zones'), issues: $('#layer-issues'), edits: $('#layer-edits'), labels: $('#layer-labels'),
});
const clearLayers = () => Object.values(layers()).forEach((g) => g.replaceChildren());

function render() {
  if (!state.head || !state.draftPlan) return;
  let plan = viewPlan();
  // 已确认视图尚无确认版本时，退回首层平面，仅用于显示空白提示。
  if (!plan) plan = state.head.plan;
  const r = viewPlan() ? reportForView() : { ok: false, pending: true };
  clearLayers();
  const svg = $('#plan');
  const frame = computeFrame(plan, r.ok ? r.report : null);
  svg.setAttribute('viewBox', `0 0 ${frame.W} ${frame.H}`);
  svg.setAttribute('width', frame.W);
  svg.setAttribute('height', frame.H);
  const ctx = projector(frame);
  const L = layers();
  const showIssues = $('#show-issues').checked;

  if ($('#show-grid').checked) drawGrid(L.grid, frame, ctx, plan);
  drawFloor(L, ctx, plan);
  drawUnusable(L, ctx, plan);
  drawZones(L, ctx, plan, r.report);
  if (showIssues && r.ok) drawIssues(L.issues, ctx, r.report);
  if (state.view === 'draft') drawEditing(L, ctx, plan);
  if (state.drawing) drawDrafting(L.edits, ctx);

  $('#scale-note').textContent =
    `坐标单位：米（y 向上）· 网格 1m · 楼层 ${fmt(ringArea(plan.floor.polygon))} m² · 视图比例仅影响显示，不改变坐标与面积`;

  renderStatus(r, plan);
  renderTotals(r);
  renderZoneList(plan, r);
  renderIssues(r);
  renderVertices(plan);
  renderButtons(r);
}

function drawGrid(g, f, ctx, plan) {
  const floor = plan.floor.polygon;
  const fx0 = Math.min(...floor.map((p) => p[0])), fx1 = Math.max(...floor.map((p) => p[0]));
  const fy0 = Math.min(...floor.map((p) => p[1])), fy1 = Math.max(...floor.map((p) => p[1]));
  for (let x = Math.ceil(f.minX); x <= f.maxX; x++) {
    const [sx1, sy1] = ctx.toScreen([x, f.minY]);
    const [, sy2] = ctx.toScreen([x, f.maxY]);
    g.appendChild(el('line', { x1: sx1, y1: sy1, x2: sx1, y2: sy2, stroke: x >= fx0 - 1e-9 && x <= fx1 + 1e-9 ? '#e2e8f0' : '#eef2f7', 'stroke-width': 1 }));
  }
  for (let y = Math.ceil(f.minY); y <= f.maxY; y++) {
    const [sx1, sy1] = ctx.toScreen([f.minX, y]);
    const [sx2] = ctx.toScreen([f.maxX, y]);
    g.appendChild(el('line', { x1: sx1, y1: sy1, x2: sx2, y2: sy1, stroke: y >= fy0 - 1e-9 && y <= fy1 + 1e-9 ? '#e2e8f0' : '#eef2f7', 'stroke-width': 1 }));
  }
  // 坐标轴标注（每米）。
  for (let x = Math.ceil(fx0); x <= fx1; x++) {
    const [sx, sy] = ctx.toScreen([x, fy0]);
    const t = el('text', { x: sx, y: sy + 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#94a3b8', text: String(x) });
    g.appendChild(t);
  }
  for (let y = Math.ceil(fy0); y <= fy1; y++) {
    const [sx, sy] = ctx.toScreen([fx0, y]);
    g.appendChild(el('text', { x: sx - 6, y: sy + 3, 'text-anchor': 'end', 'font-size': 10, fill: '#94a3b8', text: String(y) }));
  }
}

function drawFloor(L, ctx, plan) {
  const sel = state.selected?.kind === 'floor';
  L.floor.appendChild(el('path', {
    d: ringPath(ctx, plan.floor.polygon),
    fill: '#f8fafc', stroke: sel ? '#2563eb' : '#334155', 'stroke-width': sel ? 2.4 : 1.8,
    'data-pick': 'floor', style: 'cursor:pointer',
  }));
  const [cx, cy] = ctx.toScreen(centroid(plan.floor.polygon));
  L.floor.appendChild(el('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#475569', text: plan.floor.name || '楼层' }));
}

function drawUnusable(L, ctx, plan) {
  plan.unusable.forEach((u) => {
    const sel = state.selected?.kind === 'unusable' && state.selected.id === u.id;
    L.unusable.appendChild(el('path', {
      d: ringPath(ctx, u.polygon), fill: 'url(#hatch-unusable)',
      stroke: sel ? '#2563eb' : '#6b7280', 'stroke-width': sel ? 2.2 : 1.2,
      'data-pick': `unusable:${u.id}`, style: 'cursor:pointer', opacity: 0.9,
    }));
    const [cx, cy] = ctx.toScreen(centroid(u.polygon));
    L.labels.appendChild(el('text', { x: cx, y: cy + 3, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 600, fill: '#374151', text: u.name }));
  });
}

function drawZones(L, ctx, plan, report) {
  plan.zones.forEach((z, i) => {
    const sel = state.selected?.kind === 'zone' && state.selected.id === z.id;
    const involved = state.selected?.kind === 'issue' && report?.issues
      ?.find((iss) => iss.id === state.selected.id)?.zoneIds?.includes(z.id);
    const color = ZONE_COLORS[i % ZONE_COLORS.length];
    L.zones.appendChild(el('path', {
      d: ringPath(ctx, z.polygon), fill: color, 'fill-opacity': sel ? 0.28 : involved ? 0.22 : 0.14,
      stroke: color, 'stroke-width': sel ? 2.6 : involved ? 2.2 : 1.4,
      'stroke-dasharray': involved ? '6 3' : null,
      'data-pick': `zone:${z.id}`, style: 'cursor:pointer',
    }));
    const zr = report?.zones?.find((q) => q.id === z.id);
    const [cx, cy] = ctx.toScreen(centroid(z.polygon));
    L.labels.appendChild(el('text', {
      x: cx, y: cy, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#1e293b',
      text: z.name + (zr ? `  ${fmt(zr.effectiveArea)}m²` : ''),
    }));
  });
}

const ISSUE_STYLE = {
  outside: { fill: 'url(#hatch-outside)', stroke: '#dc2626' },
  unusable: { fill: 'url(#hatch-unusable)', stroke: '#b91c1c' },
  overlap: { fill: 'url(#hatch-overlap)', stroke: '#d97706' },
  gap: { fill: '#bfdbfe', stroke: '#2563eb' },
};

function drawIssues(g, ctx, report) {
  report.issues.forEach((iss) => {
    const st = ISSUE_STYLE[iss.kind] || { fill: '#fca5a5', stroke: '#991b1b' };
    const sel = state.selected?.kind === 'issue' && state.selected.id === iss.id;
    g.appendChild(el('path', {
      d: mpPath(ctx, iss.multipolygon),
      fill: st.fill, 'fill-opacity': iss.kind === 'gap' ? 0.45 : 0.8,
      stroke: sel ? '#111827' : st.stroke, 'stroke-width': sel ? 3 : 1.6,
      'stroke-dasharray': iss.kind === 'gap' ? '5 3' : null,
      'data-pick-issue': iss.id, style: 'cursor:pointer',
    }));
  });
}

function drawEditing(L, ctx, plan) {
  if (state.tool !== 'select') return;
  const sel = state.selected;
  if (!sel) return;
  let ring = null, kind = sel.kind;
  if (sel.kind === 'zone') ring = plan.zones.find((z) => z.id === sel.id)?.polygon;
  if (sel.kind === 'unusable') ring = plan.unusable.find((u) => u.id === sel.id)?.polygon;
  if (sel.kind === 'floor') ring = plan.floor.polygon;
  if (!ring) return;

  ring.forEach((p, i) => {
    const [sx, sy] = ctx.toScreen(p);
    const locating = state.locate && state.locate.kind === kind && state.locate.id === sel.id && state.locate.index === i;
    L.edits.appendChild(el('circle', {
      cx: sx, cy: sy, r: locating ? 7 : 5,
      fill: locating ? '#ef4444' : '#fff', stroke: '#2563eb', 'stroke-width': 2,
      class: 'handle', style: 'cursor:grab',
      'data-handle': `${kind}:${sel.id}:${i}`,
    }));
  });
  // 边中点：点击插入顶点。
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const [sx, sy] = ctx.toScreen([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    L.edits.appendChild(el('rect', {
      x: sx - 3.5, y: sy - 3.5, width: 7, height: 7,
      fill: '#2563eb', opacity: 0.35, style: 'cursor:copy',
      'data-mid': `${kind}:${sel.id}:${i}`,
    }));
  });
}

function drawDrafting(g, ctx) {
  const pts = state.drawing.points;
  if (!pts.length) return;
  const d = pts.map((p, i) => { const [sx, sy] = ctx.toScreen(p); return `${i ? 'L' : 'M'}${sx},${sy}`; }).join(' ');
  g.appendChild(el('path', { d, fill: 'none', stroke: '#2563eb', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
  pts.forEach((p, i) => {
    const [sx, sy] = ctx.toScreen(p);
    g.appendChild(el('circle', { cx: sx, cy: sy, r: i === 0 ? 6 : 4, fill: i === 0 ? '#2563eb' : '#fff', stroke: '#2563eb', 'stroke-width': 2 }));
  });
}

/* ------------------------------ 画布交互 --------------------------------- */

function bindCanvas() {
  const svg = $('#plan');

  svg.addEventListener('click', (e) => {
    // 绘制模式优先级最高：点击画布任意处都作为新顶点。
    if (state.drawing) {
      const [wx, wy] = pointerWorld(e);
      addDrawingPoint([wx, wy]);
      return;
    }
    const issueId = e.target.getAttribute?.('data-pick-issue');
    if (issueId) {
      state.selected = { kind: 'issue', id: issueId };
      render();
      $('#section-issues').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    const pick = e.target.getAttribute?.('data-pick');
    if (pick && state.tool === 'select' && state.view === 'draft') {
      if (pick === 'floor') state.selected = { kind: 'floor' };
      else {
        const [kind, id] = pick.split(':');
        state.selected = { kind, id };
      }
      render();
    }
  });

  svg.addEventListener('pointerdown', (e) => {
    const handle = e.target.getAttribute?.('data-handle');
    const mid = e.target.getAttribute?.('data-mid');
    if (mid) {
      const [kind, id, iStr] = mid.split(':');
      const i = Number(iStr);
      const ring = getRing(kind, id);
      const p = ring[i], q = ring[(i + 1) % ring.length];
      ring.splice(i + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      afterDraftChange();
      return;
    }
    if (handle) {
      const [kind, id, iStr] = handle.split(':');
      const i = Number(iStr);
      svg.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const [wx, wy] = pointerWorld(ev);
        const ring = getRing(kind, id);
        let x = wx, y = wy;
        if (state.snap > 0) { x = Math.round(x / state.snap) * state.snap; y = Math.round(y / state.snap) * state.snap; }
        ring[i] = [Number(x.toFixed(4)), Number(y.toFixed(4))];
        persistDraft();
        render();
      };
      const up = () => {
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        afterDraftChange();
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
    }
  });
}

function pointerWorld(e) {
  const svg = $('#plan');
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const px = (e.clientX - rect.left) * (vb.width / rect.width);
  const py = (e.clientY - rect.top) * (vb.height / rect.height);
  const plan = viewPlan();
  let report = null;
  try { report = analyze(plan); } catch { report = null; }
  const frame = computeFrame(plan, report);
  return projector(frame).toWorld([px, py]);
}

function getRing(kind, id) {
  const p = state.draftPlan;
  if (kind === 'floor') return p.floor.polygon;
  if (kind === 'unusable') return p.unusable.find((u) => u.id === id)?.polygon;
  return p.zones.find((z) => z.id === id)?.polygon;
}

function addDrawingPoint([x, y]) {
  const snap = state.snap;
  if (snap > 0) { x = Math.round(x / snap) * snap; y = Math.round(y / snap) * snap; }
  x = Number(x.toFixed(4)); y = Number(y.toFixed(4));
  const pts = state.drawing.points;
  // 点击接近第一个点 → 闭合完成。
  if (pts.length >= 3) {
    const [fx, fy] = pts[0];
    const frame = computeFrame(viewPlan(), (() => { try { return analyze(viewPlan()); } catch { return null; } })());
    const s = projector(frame);
    const [sx1, sy1] = s.toScreen([x, y]);
    const [sx2, sy2] = s.toScreen([fx, fy]);
    if (Math.hypot(sx1 - sx2, sy1 - sy2) < 12) { finishDraw(); return; }
  }
  pts.push([x, y]);
  render();
}

/* ------------------------------ 右侧面板 --------------------------------- */

function checkBadge(check, rev) {
  if (!check || check.status === 'pending') return h('span', { class: 'pill pending' }, '检查进行中…');
  if (check.error) return h('span', { class: 'pill done-bad', title: check.error }, '几何无效');
  if (check.rev && rev && check.rev !== rev) return h('span', { class: 'pill done-bad' }, '检查属于旧版本');
  return check.report.valid
    ? h('span', { class: 'pill done-ok' }, '检查通过：无阻断问题')
    : h('span', { class: 'pill done-bad' }, `检查未通过：${check.report.issues.filter((i) => i.severity === 'error').length} 个阻断问题`);
}

function renderStatus(r, plan) {
  const body = $('#status-body');
  body.replaceChildren();
  const kv = (k, v, title) => body.appendChild(h('div', { class: 'kv', title: title || '' }, [h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)]));

  if (state.view === 'draft') {
    kv('服务端最新版本', `#${state.head.seq}（${state.head.savedBy} · ${new Date(state.head.savedAt).toLocaleString()}）`);
    const checkLine = h('div', { class: 'kv' }, [h('span', { class: 'k' }, '该版本检查结果'), checkBadge(state.headCheck, state.head.rev)]);
    body.appendChild(checkLine);
    if (state.confirmation) {
      kv('已确认交付', `#${state.confirmation.seq}（${state.confirmation.confirmedBy}）`);
      const goto = h('a', { class: 'act', style: 'cursor:pointer;color:#2563eb', onclick: () => document.querySelector('[data-view="confirmed"]').click() }, '查看已确认版本');
      body.appendChild(h('div', { class: 'kv' }, [h('span', { class: 'k' }), goto]));
    } else {
      kv('已确认交付', '尚无');
    }
    const dirty = isDirty();
    const stale = isStale();
    const pill = stale
      ? h('span', { class: 'pill conflict' }, '本地草稿与服务端冲突')
      : dirty
        ? h('span', { class: 'pill dirty' }, '有未保存的本地改动')
        : h('span', { class: 'pill done-ok' }, '与服务端版本一致');
    body.appendChild(h('div', { class: 'kv' }, [h('span', { class: 'k' }, '本地草稿基线'), h('span', { class: 'v' }, `#${state.baseRev?.split('-')[0] || '?'}`)]));
    body.appendChild(h('div', { class: 'kv' }, [h('span', { class: 'k' }, '草稿状态'), pill]));
    if (stale) {
      body.appendChild(h('p', { class: 'muted', style: 'color:#9a3412' },
        '同事已保存新版本。保存不会静默覆盖；请先用上方标签对照，或放弃草稿以新版本为基础。'));
    }
    kv('当前预览', '本地实时计算（非正式结论）');
  } else if (state.view === 'saved') {
    kv('查看版本', `#${state.head.seq}（${state.head.savedBy}）`);
    body.appendChild(h('div', { class: 'kv' }, [h('span', { class: 'k' }, '服务端检查'), checkBadge(state.headCheck, state.head.rev)]));
    body.appendChild(h('p', { class: 'muted' }, '这是只读视图。要修改请回到“编辑草稿”标签。'));
  } else {
    if (!state.confirmation) {
      body.appendChild(h('p', { class: 'muted' }, '尚无已确认交付版本。'));
    } else {
      kv('已确认版本', `#${state.confirmation.seq}`);
      kv('确认人 / 时间', `${state.confirmation.confirmedBy} · ${new Date(state.confirmation.confirmedAt).toLocaleString()}`);
      const c = state.confirmedData?.check;
      body.appendChild(h('div', { class: 'kv' }, [h('span', { class: 'k' }, '确认时检查'), checkBadge(c, state.confirmation.rev)]));
      body.appendChild(h('p', { class: 'muted' }, '已确认版本只读保存；在“编辑草稿”中继续修改会产生新草稿，不影响此结论。'));
    }
  }
}

function renderTotals(r) {
  const body = $('#totals-body');
  body.replaceChildren();
  const line = (n, a, cls = '') => body.appendChild(h('div', { class: `tot-line ${cls}` }, [h('span', { class: 'n' }, n), h('span', { class: 'a' }, `${fmt(a)} m²`)]));

  if (!r.ok) {
    body.appendChild(h('p', { class: 'muted' }, r.pending ? '检查进行中，服务端汇总暂不可用。' : `无法计算：${r.error}`));
    return;
  }
  const rep = r.report;
  line('楼层外轮廓面积', rep.floorArea);
  line('不可用区域合计', rep.unusableArea);
  line('可分配面积（楼层 − 不可用）', rep.usableArea, 'sum');
  const outsideSum = rep.zones.reduce((s, z) => s + z.outsideArea, 0);
  const unusableSum = rep.zones.reduce((s, z) => s + z.unusableArea, 0);
  line('分区标称面积之和', rep.totals.nominalSum);
  line('其中：超出楼层部分', outsideSum, outsideSum > 1e-9 ? 'bad' : '');
  line('其中：压在不可用区域上', unusableSum, unusableSum > 1e-9 ? 'bad' : '');
  line('可用区内分区覆盖（含重复）', rep.totals.insideUsableSum);
  line('　└ 重复多计（重叠）', rep.totals.multiClaim, rep.totals.multiClaim > 1e-9 ? 'bad' : 'good');
  line('实际被占用（并集）', rep.totals.assignedUnion);
  line('未分配空缺', rep.totals.gapArea, rep.totals.gapArea > 1e-9 ? '' : 'good');
  line('独占有效面积合计', rep.totals.effectiveSum, 'sum');
  // 剖分恒等式：独占 + 重叠 + 空缺 = 可分配。
  const identityOk = Math.abs(rep.totals.effectiveSum + rep.totals.multiClaim + rep.totals.gapArea - rep.usableArea) < 1e-6;
  body.appendChild(h('div', { class: `tot-line ${identityOk ? 'good' : 'bad'}`, style: 'margin-top:6px' }, [
    h('span', { class: 'n' }, '校验：独占 + 重叠 + 空缺 = 可分配'),
    h('span', { class: 'a' }, identityOk ? '成立 ✓' : '不成立 ✗'),
  ]));
  if (r.server) body.appendChild(h('p', { class: 'muted', style: 'margin-top:4px' }, '以上为服务端独立判定结果。'));
}

function renderZoneList(plan, r) {
  const body = $('#zones-body');
  body.replaceChildren();

  const floorRep = r.ok ? r.report : null;
  const floorBox = h('div', { class: 'zone-item' }, [
    h('div', { class: 'top' }, [
      h('span', { class: 'swatch', style: 'background:#f8fafc;border-color:#334155' }),
      h('b', {}, plan.floor.name || '楼层外轮廓'),
      h('span', { class: 'muted' }, floorRep ? `${fmt(floorRep.floorArea)} m²` : ''),
    ]),
  ]);
  floorBox.addEventListener('click', () => { state.selected = { kind: 'floor' }; render(); });
  if (state.selected?.kind === 'floor') floorBox.classList.add('sel');
  body.appendChild(floorBox);

  if (plan.unusable.length) {
    body.appendChild(h('p', { class: 'muted', style: 'margin:6px 0 4px' }, '不可用区域（不参与分配）'));
    plan.unusable.forEach((u) => {
      const item = h('div', { class: 'zone-item' }, [
        h('div', { class: 'top' }, [
          h('span', { class: 'swatch', style: 'background:url(#hatch-unusable);background:#d1d5db' }),
          h('input', { class: 'name', value: u.name, disabled: state.view !== 'draft' }),
          h('span', { class: 'muted' }, `${fmt(ringArea(u.polygon))} m²`),
        ]),
      ]);
      item.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') { state.selected = { kind: 'unusable', id: u.id }; render(); }
      });
      item.querySelector('input.name').addEventListener('input', (e) => { u.name = e.target.value; persistDraft(); });
      if (state.view === 'draft') {
        item.appendChild(h('div', { class: 'ops' }, [h('button', { onclick: (e) => { e.stopPropagation(); if (confirm(`删除不可用区域「${u.name}」？`)) { state.draftPlan.unusable = state.draftPlan.unusable.filter((x) => x.id !== u.id); state.selected = null; afterDraftChange(); } } }, '删除')]));
      }
      if (state.selected?.kind === 'unusable' && state.selected.id === u.id) item.classList.add('sel');
      body.appendChild(item);
    });
  }

  body.appendChild(h('p', { class: 'muted', style: 'margin:8px 0 4px' }, '用途分区（有效面积 = 楼层内、不压不可用、不与任何分区重复）'));
  plan.zones.forEach((z, i) => {
    const zr = r.ok ? r.report.zones.find((q) => q.id === z.id) : null;
    const top = h('div', { class: 'top' }, [
      h('span', { class: 'swatch', style: `background:${ZONE_COLORS[i % ZONE_COLORS.length]}` }),
      h('input', { class: 'name', value: z.name, disabled: state.view !== 'draft' }),
      h('span', { class: 'muted' }, zr ? `${fmt(zr.effectiveArea)} m²` : ''),
    ]);
    const item = h('div', { class: 'zone-item' }, [top]);
    if (zr && (zr.outsideArea > 1e-9 || zr.unusableArea > 1e-9 || zr.overlapArea > 1e-9)) {
      item.appendChild(h('div', { class: 'meta' }, [
        h('span', {}, '标称 / 有效'), h('b', {}, `${fmt(zr.nominalArea)} / ${fmt(zr.effectiveArea)} m²`),
        zr.outsideArea > 1e-9 ? h('span', { class: 'area-warn' }, `越界 ${fmt(zr.outsideArea)} m²`) : h('span'),
        zr.outsideArea > 1e-9 ? h('b', { class: 'area-warn' }, '超出楼层') : h('b'),
        zr.unusableArea > 1e-9 ? h('span', { class: 'area-warn' }, `压占 ${fmt(zr.unusableArea)} m²`) : h('span'),
        zr.unusableArea > 1e-9 ? h('b', { class: 'area-warn' }, '不可用区域') : h('b'),
        zr.overlapArea > 1e-9 ? h('span', { class: 'area-warn' }, `重叠 ${fmt(zr.overlapArea)} m²`) : h('span'),
        zr.overlapArea > 1e-9 ? h('b', { class: 'area-warn' }, '被重复计入') : h('b'),
      ]));
    } else if (zr) {
      item.appendChild(h('div', { class: 'meta' }, [h('span', {}, '标称面积'), h('b', {}, `${fmt(zr.nominalArea)} m²`)]));
    }
    item.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') { state.selected = { kind: 'zone', id: z.id }; render(); }
    });
    item.querySelector('input.name').addEventListener('input', (e) => { z.name = e.target.value; persistDraft(); });
    item.querySelector('input.name').addEventListener('change', () => render());
    if (state.view === 'draft') {
      item.appendChild(h('div', { class: 'ops' }, [
        h('button', { onclick: (e) => { e.stopPropagation(); state.selected = { kind: 'zone', id: z.id }; render(); $('#section-vertices').scrollIntoView({ behavior: 'smooth' }); } }, '编辑顶点'),
        h('button', { class: 'danger', onclick: (e) => { e.stopPropagation(); if (confirm(`删除分区「${z.name}」？`)) { state.draftPlan.zones = state.draftPlan.zones.filter((x) => x.id !== z.id); state.selected = null; afterDraftChange(); } } }, '删除'),
      ]));
    }
    if (state.selected?.kind === 'zone' && state.selected.id === z.id) item.classList.add('sel');
    body.appendChild(item);
  });
}

function renderIssues(r) {
  const body = $('#issues-body');
  const counter = $('#issue-count');
  body.replaceChildren();
  if (!r.ok) {
    counter.textContent = '';
    counter.className = 'count';
    body.appendChild(h('p', { class: 'muted' }, r.pending ? '等待服务端检查完成…' : `几何无效：${r.error}`));
    return;
  }
  const issues = r.report.issues;
  const errors = issues.filter((i) => i.severity === 'error');
  counter.textContent = errors.length ? `${errors.length} 阻断 / ${issues.length} 总计` : issues.length ? `${issues.length} 提示` : '0';
  counter.className = `count ${errors.length ? '' : 'zero'}`;
  if (!issues.length) {
    body.appendChild(h('p', { class: 'muted', style: 'color:#166534' }, '没有问题区域：无越界、无压占、无正面积重叠。'));
    return;
  }
  for (const iss of issues) {
    const chips = iss.zoneIds.map((id) => {
      const z = viewPlan().zones.find((x) => x.id === id);
      const chip = h('span', { class: 'chip', title: '点击选中该分区并定位顶点' }, z ? z.name : id);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selected = { kind: 'zone', id };
        render();
        $('#section-vertices').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      return chip;
    });
    const detail = iss.kind === 'unusable' && iss.unusable
      ? `压到：${iss.unusable.map((u) => `「${u.name}」${fmt(u.area)}m²`).join('，')}`
      : iss.kind === 'gap' ? '该区域在楼层内且不属任何不可用区域，但没有分区覆盖'
      : iss.kind === 'overlap' ? '同一块可用地面被多个分区重复占用'
      : iss.kind === 'outside' ? '该部分落在楼层外轮廓之外' : '';
    const item = h('div', { class: `issue-item ${iss.severity}` }, [
      h('div', { class: 'it-title' }, [h('span', {}, iss.title), h('span', { class: 'it-area' }, `${fmt(iss.area)} m²`)]),
      h('div', { class: 'it-detail' }, detail),
      h('div', { class: 'it-zones' }, chips),
    ]);
    item.addEventListener('click', () => { state.selected = { kind: 'issue', id: iss.id }; render(); });
    if (state.selected?.kind === 'issue' && state.selected.id === iss.id) item.classList.add('sel');
    body.appendChild(item);
  }
}

function renderVertices(plan) {
  const body = $('#vertices-body');
  body.replaceChildren();
  if (state.view !== 'draft') {
    body.appendChild(h('p', { class: 'muted' }, '只读视图不可编辑顶点。'));
    return;
  }
  const sel = state.selected;
  if (!sel || sel.kind === 'issue') {
    body.appendChild(h('p', { class: 'muted' }, sel?.kind === 'issue' ? '已选中问题区域：点击上方分区标签可跳到对应分区的顶点。' : '在图上选中一个分区或不可用区域后逐点编辑。'));
    return;
  }
  const ring = getRing(sel.kind, sel.id);
  if (!ring) return;
  const name = sel.kind === 'floor' ? plan.floor.name || '楼层' : sel.kind === 'unusable' ? plan.unusable.find((u) => u.id === sel.id)?.name : plan.zones.find((z) => z.id === sel.id)?.name;
  body.appendChild(h('p', { class: 'muted', style: 'margin-top:0' }, `正在编辑：${name}（${ring.length} 个顶点，单位米；也可直接在图上拖动圆点、点击小方块插入顶点）`));
  ring.forEach((p, i) => {
    const locating = state.locate?.kind === sel.kind && state.locate?.id === sel.id && state.locate.index === i;
    const xIn = h('input', { value: fmt(p[0]), 'aria-label': `顶点 ${i + 1} X`, class: locating ? 'locate' : '' });
    const yIn = h('input', { value: fmt(p[1]), 'aria-label': `顶点 ${i + 1} Y`, class: locating ? 'locate' : '' });
    const commit = () => {
      const x = Number(xIn.value), y = Number(yIn.value);
      if (Number.isFinite(x) && Number.isFinite(y)) { ring[i] = [x, y]; afterDraftChange(); }
    };
    xIn.addEventListener('change', commit);
    yIn.addEventListener('change', commit);
    const row = h('div', { class: 'vert-row' }, [
      h('span', { class: 'idx' }, `#${i + 1}`), xIn, yIn,
      h('button', {
        title: '在图上定位该顶点',
        onclick: () => { state.locate = { kind: sel.kind, id: sel.id, index: i }; render(); setTimeout(() => { state.locate = null; render(); }, 1600); },
      }, '定位'),
    ]);
    body.appendChild(row);
  });
  if (ring.length > 3) {
    body.appendChild(h('button', { class: 'ghost', style: 'margin-top:4px', onclick: () => {
      const idx = Number(prompt('删除第几个顶点？（输入序号）', '1'));
      if (idx >= 1 && idx <= ring.length) { ring.splice(idx - 1, 1); afterDraftChange(); }
    } }, '删除一个顶点…'));
  }
}

function renderButtons(r) {
  const dirty = isDirty();
  const stale = isStale();
  $('#btn-save').disabled = state.view !== 'draft' || state.saving || !dirty;
  $('#btn-save').textContent = state.saving ? '保存中…' : stale ? '保存（与服务端冲突）' : '保存草稿到服务端';

  const headDone = state.headCheck?.status === 'done' && !state.headCheck.error && state.headCheck.rev === state.head.rev;
  const canConfirm = state.view === 'draft' && !dirty && headDone && state.headCheck.report.valid;
  $('#btn-confirm').disabled = !canConfirm;
  $('#btn-confirm').title = dirty
    ? '存在未保存改动，请先保存并等待该版本检查完成'
    : !headDone ? '服务端对当前版本的检查尚未完成'
    : !state.headCheck.report.valid ? '当前版本存在阻断问题' : '以当前确切保存版本为准确认交付';
  void r;
}

/* ----------------------------- 保存 / 确认 -------------------------------- */

let bannerActs = [];
function showBanner(kind, msg, acts = []) {
  const b = $('#banner');
  b.className = `banner ${kind}`;
  b.replaceChildren(document.createTextNode(msg + ' '));
  bannerActs = acts;
  acts.forEach((a) => b.appendChild(h('span', { class: 'act', onclick: a.fn }, a.label)));
}
const hideBanner = () => { $('#banner').className = 'banner hidden'; };

async function saveDraft() {
  if (state.saving) return;
  const stale = isStale();
  if (stale && !confirm('服务端已有同事保存的新版本。继续保存将以服务端当前版本为基线、用您的草稿覆盖为最新版本（同事的版本仍保留在服务端历史中，可对照取回）。确定？')) return;
  state.saving = true;
  renderButtons();
  try {
    // 明确覆盖冲突时，以当前 head 为乐观锁基线；本地草稿内容原样提交。
    const baseRev = stale ? state.head.rev : state.baseRev;
    const data = await api('/api/save', 'POST', {
      plan: state.draftPlan,
      baseRev,
      savedBy: $('#savedBy').value.trim() || '匿名',
      check: 'async',
    });
    state.draftPlan = clone(data.revision.plan);
    state.baseRev = data.revision.rev;
    state.head = data.revision;
    state.headCheck = data.check;
    persistDraft();
    showBanner('info', `已保存为版本 #${data.revision.seq}。服务端正在独立检查该确切版本，结论出来前不能确认交付。`);
    await refreshFromServer();
    render();
    schedulePoll();
  } catch (err) {
    if (err.status === 409) {
      // 冲突：本地草稿原样保留；拉取服务端新版本供“已保存版本”标签对照，绝不静默覆盖。
      await refreshFromServer();
      showBanner('error', '保存被拒绝：同事已更新楼层或分区（服务端为新版本）。您的草稿完整保留在本地，可切换“服务端已保存版本”对照后再决定。', [
        { label: '查看服务端版本', fn: () => document.querySelector('[data-view="saved"]').click() },
        {
          label: '放弃草稿，改用服务端版本',
          fn: () => {
            state.draftPlan = clone(state.head.plan);
            state.baseRev = state.head.rev;
            state.selected = null;
            persistDraft();
            hideBanner();
            render();
          },
        },
        { label: '留在我的草稿', fn: () => hideBanner() },
      ]);
    } else if (err.status === 400) {
      showBanner('error', `无法保存：${err.message}`);
    } else {
      showBanner('error', `保存失败：${err.message}`);
    }
    render();
  } finally {
    state.saving = false;
    render();
  }
}

async function confirmDelivery() {
  if (!state.headCheck || state.headCheck.status !== 'done') return;
  const rev = state.head.rev;
  if (!confirm(`将以保存版本 #${state.head.seq} 为准确认交付。确认前服务端会重新独立检查该版本；检查未通过或版本已变化都会被拒绝。继续？`)) return;
  try {
    const data = await api('/api/confirm', 'POST', { rev, confirmedBy: $('#savedBy').value.trim() || '匿名' });
    state.confirmation = data.confirmation;
    state.confirmedData = { revision: state.head, check: data.check };
    showBanner('ok', `版本 #${state.head.seq} 已确认交付。后续编辑只产生新草稿，不影响此已确认版本。`);
    document.querySelector('[data-view="confirmed"]').click();
  } catch (err) {
    await refreshFromServer();
    showBanner('error', `确认被拒绝：${err.message}`);
    render();
  }
}

init();
