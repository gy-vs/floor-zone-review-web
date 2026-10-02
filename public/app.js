'use strict';
/* 楼层分区核对工作台（前端）
 * 职责：米坐标平面编辑/渲染、呈现服务端几何结论、版本保存与确认交互。
 * 所有面积与布尔判定来自后端 /api/evaluate（草稿实时）与 /api/check（保存版本），
 * 前端绝不自行计算面积或重叠，避免“图上看着对、数字另算”。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const ZONE_COLORS = ['#4f8cff', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#64748b'];

/* ---------------- 全局状态 ---------------- */
const S = {
  // 服务端当前保存版本
  serverVersion: null,
  serverDoc: null,
  savedCheck: null,
  confirmation: null,
  versions: [],
  // 工作区
  doc: null,
  liveCheck: null,
  liveSeq: 0,
  liveTimer: null,
  // 视图（米 -> SVG 像素）
  view: { cx: 5, cy: 4, scale: 40 },
  // 交互
  tool: 'select',
  selection: null, // {kind:'floor'|'unusable'|'zone', id, vi?}
  activeProblemId: null,
  draw: null,
  cursor: null,
  // 模式
  readOnly: false,
  viewingVersion: null,
  conflict: null,
};

/* ---------------- 小工具 ---------------- */
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function fmt3(v) {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}
function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || ('HTTP ' + res.status));
    e.status = res.status; e.data = data; throw e;
  }
  return data;
}
function ringsOf(geom) {
  if (!geom) return [];
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
}
function ringD(ring) {
  return 'M' + ring.map((p) => `${r3(p[0])},${r3(p[1])}`).join('L') + 'Z';
}
function r3(n) { return Math.round(n * 1000) / 1000; }
function ringCenter(ring) {
  let x = 0, y = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}
function bboxOfDoc(doc) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (g) => ringsOf(g).forEach((poly) => poly.forEach((ring) => ring.forEach((p) => {
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
  })));
  if (doc.floor) eat(doc.floor);
  (doc.unusables || []).forEach((u) => eat(u.geometry));
  (doc.zones || []).forEach((z) => eat(z.geometry));
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 10, maxY: 8 };
  return { minX, minY, maxX, maxY };
}

/* ---------------- 坐标换算（同一组米坐标） ---------------- */
function svgSize() {
  const svg = $('plan');
  return { w: svg.clientWidth, h: svg.clientHeight };
}
function mToS(x, y) {
  const { w, h } = svgSize();
  return [(x - S.view.cx) * S.view.scale + w / 2, h / 2 - (y - S.view.cy) * S.view.scale];
}
function sToM(px, py) {
  const { w, h } = svgSize();
  return [S.view.cx + (px - w / 2) / S.view.scale, S.view.cy - (py - h / 2) / S.view.scale];
}
function fitView(bbox, pad = 1.2) {
  const { w, h } = svgSize();
  const bw = Math.max(bbox.maxX - bbox.minX, 0.001);
  const bh = Math.max(bbox.maxY - bbox.minY, 0.001);
  S.view.scale = Math.min((w - 60) / (bw + pad * 2), (h - 60) / (bh + pad * 2));
  S.view.cx = (bbox.minX + bbox.maxX) / 2;
  S.view.cy = (bbox.minY + bbox.maxY) / 2;
}

/* =========================================================
 * 渲染
 * ========================================================= */
function el(name, attrs = {}, listeners = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const [ev, fn] of Object.entries(listeners)) node.addEventListener(ev, fn);
  return node;
}

function render() {
  renderSvg();
  renderPanels();
  renderSelectionCard();
  renderBanners();
}

// 右侧面板（不含左侧选中卡，保证改名输入不丢焦点）
function renderPanelsMeta() {
  renderPanels();
  renderBanners();
}

function renderSvg() {
  const svg = $('plan');
  svg.innerHTML = '';
  const doc = S.doc;
  if (!doc) return;

  const defs = el('defs');
  defs.innerHTML = `
    <pattern id="hatchGray" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="7" height="7" fill="#374151" fill-opacity="0.85"/>
      <line x1="0" y1="0" x2="0" y2="7" stroke="#9ca3af" stroke-width="2.5"/>
    </pattern>
    <pattern id="hatchRed" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="rgba(220,38,38,0.08)"/>
      <line x1="0" y1="0" x2="0" y2="8" stroke="#dc2626" stroke-width="3"/>
    </pattern>
    <pattern id="hatchPurple" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
      <rect width="8" height="8" fill="rgba(126,34,206,0.08)"/>
      <line x1="0" y1="0" x2="0" y2="8" stroke="#7e22ce" stroke-width="3"/>
    </pattern>
    <pattern id="stippleYellow" width="9" height="9" patternUnits="userSpaceOnUse">
      <rect width="9" height="9" fill="rgba(217,119,6,0.10)"/>
      <circle cx="2.5" cy="2.5" r="1.4" fill="#d97706" fill-opacity="0.7"/>
    </pattern>`;
  svg.appendChild(defs);

  const gRoot = el('g');
  // 米坐标 -> 像素：统一变换，所有图层、读数共用
  const [ox, oy] = mToS(0, 0);
  gRoot.setAttribute('transform', `translate(${ox},${oy}) scale(${S.view.scale},${-S.view.scale})`);
  svg.appendChild(gRoot);

  // L0 楼层外轮廓
  if (doc.floor) {
    ringsOf(doc.floor).forEach((poly) => poly.forEach((ring, ri) => {
      const selected = S.selection && S.selection.kind === 'floor';
      gRoot.appendChild(el('path', {
        d: ringD(ring),
        fill: ri === 0 ? 'rgba(37,99,235,0.05)' : '#fff',
        stroke: selected ? '#2563eb' : '#1f2937',
        'stroke-width': (selected ? 3 : 2.2) / S.view.scale,
        'data-kind': 'floor',
        style: 'cursor:pointer',
      }, { click: (e) => { e.stopPropagation(); selectObject('floor'); } }));
    }));
  }

  // L1 不可用区域
  (doc.unusables || []).forEach((u) => {
    const selected = S.selection && S.selection.kind === 'unusable' && S.selection.id === u.id;
    ringsOf(u.geometry).forEach((poly) => poly.forEach((ring) => {
      gRoot.appendChild(el('path', {
        d: ringD(ring), fill: 'url(#hatchGray)',
        stroke: selected ? '#2563eb' : '#374151',
        'stroke-width': (selected ? 2.6 : 1.4) / S.view.scale,
        'data-kind': 'unusable', 'data-id': u.id, style: 'cursor:pointer',
      }, {
        click: (e) => { e.stopPropagation(); selectObject('unusable', u.id); },
        dblclick: (e) => e.stopPropagation(),
        pointerdown: (e) => startBodyDrag(e, 'unusable', u.id),
      }));
    }));
    addLabel(gRoot, u.geometry, '▞ ' + u.name, '#111827');
  });

  // L2 分区
  (doc.zones || []).forEach((z) => {
    const selected = S.selection && S.selection.kind === 'zone' && S.selection.id === z.id;
    ringsOf(z.geometry).forEach((poly) => poly.forEach((ring) => {
      gRoot.appendChild(el('path', {
        d: ringD(ring),
        fill: z.color || '#4f8cff', 'fill-opacity': selected ? 0.42 : 0.22,
        stroke: selected ? '#1d4ed8' : (z.color || '#4f8cff'),
        'stroke-width': (selected ? 2.6 : 1.6) / S.view.scale,
        'data-kind': 'zone', 'data-id': z.id, style: 'cursor:pointer',
      }, {
        click: (e) => { e.stopPropagation(); selectObject('zone', z.id); },
        dblclick: (e) => e.stopPropagation(),
        pointerdown: (e) => startBodyDrag(e, 'zone', z.id),
      }));
    }));
    addLabel(gRoot, z.geometry, z.name, '#111827');
  });

  // L3 未归属可用地面（信息提示，不是错误色块）
  const check = activeCheck();
  if (check && check.unallocated) {
    ringsOf(check.unallocated).forEach((poly) => poly.forEach((ring) => {
      gRoot.appendChild(el('path', {
        d: ringD(ring), fill: 'url(#stippleYellow)', stroke: '#d97706',
        'stroke-width': 0.8 / S.view.scale, 'stroke-dasharray': `${3 / S.view.scale} ${2 / S.view.scale}`,
        'data-problem': 'unallocated',
        style: 'pointer-events:none',
      }));
    }));
  }

  // L4 问题区域叠加（几何由后端给出，图上可直接点选）
  if (check) {
    for (const p of check.problems) {
      if (!p.geometry) continue;
      const isActive = S.activeProblemId === p.id;
      const fill = p.kind === 'overlap' ? 'rgba(220,38,38,0.28)'
        : p.kind === 'outside_floor' ? 'url(#hatchRed)'
        : p.kind === 'on_unusable' ? 'url(#hatchPurple)' : 'none';
      const stroke = p.kind === 'overlap' ? '#b91c1c'
        : p.kind === 'outside_floor' ? '#dc2626'
        : p.kind === 'on_unusable' ? '#7e22ce' : 'none';
      ringsOf(p.geometry).forEach((poly) => poly.forEach((ring) => {
        // 面不拦截事件（避免挡住下面的分区/顶点），只有描边可点选；
        // 整块定位也可以从右侧问题列表进入。
        gRoot.appendChild(el('path', {
          d: ringD(ring), fill, stroke,
          'stroke-width': (isActive ? 2.4 : 1.1) / S.view.scale,
          'fill-opacity': p.kind === 'overlap' ? (isActive ? 0.5 : 0.3) : 1,
          'data-problem': p.id,
          style: 'cursor:pointer;pointer-events:stroke',
        }, {
          click: (e) => { e.stopPropagation(); focusProblem(p.id); },
        }));
      }));
    }
  }

  // L5 绘制预览
  if (S.draw && S.draw.points.length) {
    const pts = S.draw.points;
    let d = 'M' + pts.map((p) => `${r3(p[0])},${r3(p[1])}`).join('L');
    if (S.cursor) d += `L${r3(S.cursor[0])},${r3(S.cursor[1])}`;
    gRoot.appendChild(el('path', {
      d, fill: 'none', stroke: '#2563eb',
      'stroke-width': 1.6 / S.view.scale, 'stroke-dasharray': `${4 / S.view.scale} ${3 / S.view.scale}`,
      style: 'pointer-events:none',
    }));
    pts.forEach((p, i) => addHandle(gRoot, p, i === 0 ? '#16a34a' : '#2563eb', 5));
  }

  // L6 选中对象的顶点（恒定屏幕大小，不随缩放变形）
  if (S.selection && !S.readOnly) {
    const ring = selectedRing();
    if (ring) {
      // 加宽的隐形边，用于双击插入顶点
      ring.slice(0, -1).forEach((p, i) => {
        const q = ring[i + 1];
        gRoot.appendChild(el('line', {
          x1: p[0], y1: p[1], x2: q[0], y2: q[1],
          stroke: 'transparent', 'stroke-width': 12 / S.view.scale,
          style: 'cursor:copy',
        }, { dblclick: (e) => { e.stopPropagation(); insertVertexAt(i); } }));
      });
      ring.slice(0, -1).forEach((p, i) => {
        addHandle(gRoot, p, '#2563eb', 6, {
          pointerdown: (e) => startVertexDrag(e, i),
          click: (e) => e.stopPropagation(),
        });
      });
    }
  }
}

function addHandle(parent, m, color, screenR, listeners = {}) {
  const [cx, cy] = mToS(m[0], m[1]);
  // 手柄挂在 svg 根下（屏幕坐标），半径不随缩放变化
  const svg = $('plan');
  const h = el('circle', {
    cx, cy, r: screenR, fill: '#fff', stroke: color, 'stroke-width': 2,
    style: 'cursor:' + (listeners.pointerdown ? 'grab' : 'pointer'),
  }, listeners);
  svg.appendChild(h);
}

function addLabel(parent, geom, text, color) {
  const outer = ringsOf(geom)[0][0];
  const [mx, my] = ringCenter(outer);
  const [x, y] = mToS(mx, my);
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('font-size', 12);
  t.setAttribute('fill', color);
  t.setAttribute('paint-order', 'stroke');
  t.setAttribute('stroke', '#fff');
  t.setAttribute('stroke-width', 3);
  t.setAttribute('style', 'pointer-events:none;user-select:none');
  t.textContent = text;
  $('plan').appendChild(t);
}

/* ---------------- 当前应显示哪份检查 ---------------- */
function activeCheck() {
  if (S.readOnly) return S.savedCheck; // 历史版本：只看该版本检查
  return isDirty() ? S.liveCheck : S.savedCheck;
}
function isDirty() {
  return S.doc && S.serverDoc && JSON.stringify(S.doc) !== JSON.stringify(S.serverDoc);
}

/* =========================================================
 * 右侧/左侧面板
 * ========================================================= */
function renderPanels() {
  const check = activeCheck();
  // 面积总账
  const rows = check ? [
    ['楼层外轮廓面积', check.floorArea],
    ['其中不可用（柱/设备间等）', check.unusableInsideArea],
    ['可分配面积（布尔差）', check.usableArea, 'strong'],
    ['已分配（去重并集）', check.allocatedArea],
    ['未分配（可用面 − 已分配并集）', check.unallocatedArea, check.unallocatedArea > 0 ? 'warn' : ''],
    ['分区标称面积之和', check.totalNominalArea],
    ['— 超出楼层合计', check.totalOutsideArea, check.totalOutsideArea ? 'bad' : ''],
    ['— 压不可用合计', check.totalOnUnusableArea, check.totalOnUnusableArea ? 'bad' : ''],
    ['— 两两重复占用合计', check.totalOverlapArea, check.totalOverlapArea ? 'bad' : ''],
    ['有效面积合计（独占口径）', check.effectiveAreaSum, 'strong'],
  ] : [];
  $('metricsTable').querySelector('tbody').innerHTML = rows.map(([label, val, cls]) =>
    `<tr${cls === 'strong' ? ' style="font-weight:600;background:#f8fafc"' : ''}>
       <td>${label}</td>
       <td class="${cls === 'bad' ? 'num-bad' : cls === 'warn' ? 'num-warn' : ''}">${fmt3(val)}</td>
     </tr>`).join('');

  // 分区表
  const zt = $('zoneTable').querySelector('tbody');
  if (!check || !check.zones.length) {
    zt.innerHTML = '<tr><td colspan="6" class="hint">尚无可计算的分区</td></tr>';
  } else {
    zt.innerHTML = check.zones.map((z) => {
      const sel = S.selection && S.selection.kind === 'zone' && S.selection.id === z.id;
      return `<tr data-id="${z.id}" class="${sel ? 'selected' : ''}" style="cursor:pointer">
        <td>${z.invalid ? '⛔ ' : ''}${escapeHtml(z.name)}</td>
        <td>${z.invalid ? '无效' : fmt3(z.nominalArea)}</td>
        <td class="${z.outsideArea ? 'num-bad' : ''}">${fmt3(z.outsideArea)}</td>
        <td class="${z.onUnusableArea ? 'num-bad' : ''}">${fmt3(z.onUnusableArea)}</td>
        <td class="${z.overlapArea ? 'num-bad' : ''}">${fmt3(z.overlapArea)}</td>
        <td>${fmt3(z.effectiveArea)}</td>
      </tr>`;
    }).join('');
    zt.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', () => selectObject('zone', tr.dataset.id)));
  }

  // 问题列表
  const pl = $('problemList');
  if (!check) {
    pl.innerHTML = '<div class="hint">等待服务端几何判定…</div>';
  } else if (!check.problems.length) {
    pl.innerHTML = '<div class="tag-ok">✓ 无出界、无压不可用、无正面积重叠，且可用面已全部分配。</div>';
  } else {
    pl.innerHTML = check.problems.map((p) => `
      <div class="problem ${p.severity} ${S.activeProblemId === p.id ? 'active' : ''}" data-id="${p.id}">
        <div class="pmsg">${p.severity === 'blocking' ? '⛔ ' : '◇ '}${escapeHtml(p.message)}</div>
        <div class="pmeta">${problemKindLabel(p.kind)} · 涉及：${p.zoneIds.length
          ? p.zoneIds.map(zoneNameOf).join('、')
          : (p.kind === 'unallocated' ? '无分区' : '—')} · 点击图上定位并回到顶点</div>
      </div>`).join('');
    pl.querySelectorAll('.problem').forEach((d) =>
      d.addEventListener('click', () => focusProblem(d.dataset.id)));
  }

  renderVersionPane();
  updateSourceTag();
  updateButtons();
}

function problemKindLabel(k) {
  return ({
    overlap: '正面积重叠',
    outside_floor: '超出楼层',
    on_unusable: '压不可用区域',
    unallocated: '未分配可用面',
    invalid_zone: '无效分区几何',
    invalid_unusable: '无效不可用区域',
    invalid_floor: '无效楼层',
    no_floor: '缺楼层',
  })[k] || k;
}
function zoneNameOf(id) {
  const z = (S.doc.zones || []).find((x) => x.id === id);
  return z ? z.name : id;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------------- 选中对象卡 ---------------- */
function selectedObject() {
  if (!S.selection) return null;
  const { kind, id } = S.selection;
  if (kind === 'floor') return { kind, obj: { name: '楼层外轮廓' } };
  const list = kind === 'zone' ? S.doc.zones : S.doc.unusables;
  const obj = list.find((x) => x.id === id);
  return obj ? { kind, obj } : null;
}
function selectedRing() {
  const so = selectedObject();
  if (!so) return null;
  const g = so.kind === 'floor' ? S.doc.floor : so.obj.geometry;
  return ringsOf(g)[0][0]; // 只编辑外环
}

function renderSelectionCard() {
  const body = $('selectionBody');
  const so = selectedObject();
  if (!so || S.readOnly) {
    body.innerHTML = S.readOnly
      ? '历史版本只读，不能编辑顶点。'
      : '未选中。在图上点击分区、不可用区域或楼层边界。';
    return;
  }
  const { kind, obj } = so;
  const ring = selectedRing();
  const check = activeCheck();
  const zoneRow = kind === 'zone' && check
    ? check.zones.find((z) => z.id === obj.id) : null;
  body.innerHTML = `
    <label class="hint">名称</label>
    <input class="name-input" id="selName" value="${escapeHtml(obj.name)}" />
    ${kind === 'zone' ? `<label class="hint" style="display:block;margin-top:6px">颜色
      <input type="color" id="selColor" value="${obj.color || '#4f8cff'}" /></label>` : ''}
    ${zoneRow ? `<div class="hint" style="margin-top:6px">
      标称 ${fmt3(zoneRow.nominalArea)} · 出界 ${fmt3(zoneRow.outsideArea)} ·
      压不可用 ${fmt3(zoneRow.onUnusableArea)} · 重复 ${fmt3(zoneRow.overlapArea)} ·
      <strong>有效 ${fmt3(zoneRow.effectiveArea)}</strong></div>` : ''}
    <div class="vertex-list" id="vertexList"></div>
    <div class="sel-actions">
      <button class="btn btn-sm" id="btnAddVertex">在最后一条边插入顶点</button>
      ${kind !== 'floor' ? `<button class="btn btn-sm" id="btnDeleteObj">删除${kind === 'zone' ? '分区' : '不可用区域'}</button>` : ''}
    </div>`;

  const vl = $('vertexList');
  ring.slice(0, -1).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'vrow2';
    row.innerHTML = `<span>P${i + 1}: ${fmt3(p[0])}, ${fmt3(p[1])}</span>`;
    if (ring.length > 4) {
      const b = document.createElement('button');
      b.textContent = '删除';
      b.addEventListener('click', () => deleteVertex(i));
      row.appendChild(b);
    }
    vl.appendChild(row);
  });

  $('selName').addEventListener('input', (e) => {
    obj.name = e.target.value;
    afterDocMutated('metadata');
  });
  if (kind === 'zone') {
    $('selColor').addEventListener('input', (e) => {
      obj.color = e.target.value;
      afterDocMutated('metadata');
    });
  }
  $('btnAddVertex').addEventListener('click', () => insertVertexAt(ring.length - 2));
  const del = $('btnDeleteObj');
  if (del) del.addEventListener('click', () => deleteSelected());
}

/* ---------------- 版本面板 ---------------- */
function renderVersionPane() {
  // 当前保存版本
  const sc = S.savedCheck;
  $('savedInfo').innerHTML = S.serverDoc ? `
    <div>保存版本 <strong>v${S.serverVersion}</strong></div>
    <div id="savedCheckLine">${checkChip(sc)}</div>` : '尚未加载';

  // 已确认交付
  const c = S.confirmation;
  $('confirmedInfo').innerHTML = c ? `
    <div>已确认版本 <strong>v${c.version}</strong></div>
    <div class="hint">确认时间 ${new Date(c.confirmedAt).toLocaleString('zh-CN')}</div>
    <div class="hint">可分配 ${fmt3(c.summary.usableArea)} · 有效合计 ${fmt3(c.summary.effectiveAreaSum)}
      · 未分配 ${fmt3(c.summary.unallocatedArea)} · 阻断问题 ${c.summary.blockingCount}</div>
    <div class="row"><button class="btn btn-sm" id="btnViewConfirmed">查看该版本</button></div>`
    : '<span class="tag-none">还没有已确认交付的版本。确认后旧版本结论永久保留，继续编辑不会回写它。</span>';
  const vc = $('btnViewConfirmed');
  if (vc) vc.addEventListener('click', () => openVersion(c.version));

  // 历史
  $('versionList').innerHTML = S.versions.map((v) => {
    const chip = v.check
      ? (v.check.blockingCount ? `<span class="tag-bad">${v.check.blockingCount} 阻断</span>`
        : v.check.infoCount ? `<span class="tag-info">${v.check.infoCount} 提示</span>`
        : '<span class="tag-ok">通过</span>')
      : '<span class="tag-none">未检查</span>';
    const cur = v.version === S.serverVersion;
    return `<div class="vrow ${cur ? 'current' : ''}">
      <div>
        <div>v${v.version}${cur ? '（当前）' : ''} ${chip}</div>
        <div class="vmeta">${new Date(v.createdAt).toLocaleString('zh-CN')} ·
          分区 ${v.zoneNames.length} · 不可用 ${v.unusableCount}</div>
      </div>
      <div class="vicons">
        ${v.check ? '' : '<button class="btn btn-sm btn-check-v" data-check="' + v.version + '">运行检查</button>'}
        <button class="btn btn-sm" data-v="${v.version}">查看</button>
      </div>
    </div>`;
  }).join('');
  $('versionList').querySelectorAll('button[data-v]').forEach((b) =>
    b.addEventListener('click', () => openVersion(Number(b.dataset.v))));
  $('versionList').querySelectorAll('button[data-check]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ver = Number(b.dataset.check);
      b.disabled = true; b.textContent = '检查中…';
      await api('/api/check', { method: 'POST', body: { version: ver } });
      if (S.readOnly && S.viewingVersion === ver) {
        const v = await api('/api/versions/' + ver);
        S.savedCheck = v.check;
      }
      await reloadState();
      render();
    }));
}

function checkChip(check) {
  if (!check) return '<span class="tag-none">该版本尚未运行服务端检查</span>';
  const blocking = check.problems.filter((p) => p.severity === 'blocking');
  if (blocking.length) return `<span class="tag-bad">${blocking.length} 个阻断问题</span>`;
  const info = check.problems.filter((p) => p.severity === 'info');
  return info.length
    ? `<span class="tag-info">无阻断；${info.length} 条提示（未分配 ${fmt3(check.unallocatedArea)} m²）</span>`
    : '<span class="tag-ok">检查通过：无重叠/出界/压不可用，且已全部分配</span>';
}

function updateSourceTag() {
  const tag = $('checkSourceTag');
  if (S.readOnly) {
    tag.className = 'source-tag hist';
    tag.textContent = `历史版本 v${S.viewingVersion} 的已保存检查结果（只读）`;
    return;
  }
  if (isDirty()) {
    tag.className = 'source-tag live';
    tag.textContent = S.liveCheck
      ? `实时判定：未保存草稿 @ ${new Date(S.liveCheck.checkedAt).toLocaleTimeString('zh-CN')}（不是已保存/已确认结论）`
      : '正在对未保存草稿进行服务端判定…';
  } else {
    tag.className = 'source-tag saved';
    tag.textContent = S.savedCheck
      ? `保存版本 v${S.serverVersion} 的服务端检查 @ ${new Date(S.savedCheck.checkedAt).toLocaleTimeString('zh-CN')}`
      : '保存版本尚无检查结果';
  }
}

function updateButtons() {
  $('btnSave').disabled = S.readOnly || !isDirty();
  const clean = !isDirty() && S.serverDoc;
  const sc = S.savedCheck;
  const blocking = sc ? sc.problems.filter((p) => p.severity === 'blocking').length : 0;
  $('btnConfirm').disabled = S.readOnly || !clean || !sc || blocking > 0;
  $('btnCheckSaved').disabled = S.readOnly;
  document.querySelectorAll('input[name="tool"]').forEach((r) => { r.disabled = S.readOnly; });
}

function renderBanners() {
  const dirty = isDirty();
  $('dirtyBadge').style.display = dirty ? '' : 'none';
  $('versionBadge').textContent = S.readOnly
    ? `只读：历史 v${S.viewingVersion}`
    : `保存版本 v${S.serverVersion}${dirty ? '（草稿已修改）' : ''}`;
  $('versionBadge').className = 'badge ' + (S.readOnly ? 'badge-confirmed' : dirty ? 'badge-live' : 'badge-saved');

  $('drawControls').style.display = S.draw ? '' : 'none';
  $('drawHint').style.display = S.draw ? 'none' : '';
  if (S.draw) {
    $('drawStatus').textContent =
      `正在画${S.draw.kind === 'floor' ? '楼层外轮廓' : S.draw.kind === 'unusable' ? '不可用区域' : '用途分区'}：已放 ${S.draw.points.length} 个点（至少 3 个）。`;
  }
}

/* =========================================================
 * 交互：选择 / 顶点拖拽 / 整体拖拽 / 绘制
 * ========================================================= */
function selectObject(kind, id) {
  if (S.readOnly) return;
  S.selection = { kind, id: id || null };
  S.activeProblemId = null;
  render();
}

function afterDocMutated(scope = 'geometry') {
  scheduleLiveCheck();
  persistLocalDraft();
  if (scope === 'metadata') {
    // 改名/改色不影响几何：重画图与右侧面板，选中卡不重建，输入焦点不丢
    renderSvg();
    renderPanels();
    renderBanners();
  } else {
    render();
  }
}

function mutateSelectedRing(fn) {
  const so = selectedObject();
  if (!so) return;
  const g = so.kind === 'floor' ? S.doc.floor : so.obj.geometry;
  const ring = ringsOf(g)[0][0];
  fn(ring);
  afterDocMutated();
}

function startVertexDrag(e, vi) {
  if (S.readOnly) return;
  e.stopPropagation();
  e.preventDefault();
  const ring = selectedRing();
  if (!ring) return;
  const target = e.target;
  target.setAttribute('r', 8);
  const move = (ev) => {
    const m = pointerMeters(ev);
    ring[vi] = [m[0], m[1]];
    if (vi === 0) ring[ring.length - 1] = [m[0], m[1]];
    if (vi === ring.length - 1) ring[0] = [m[0], m[1]];
    afterDocMutated();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startBodyDrag(e, kind, id) {
  if (S.readOnly || S.tool !== 'select' || e.button !== 0) return;
  // 顶点手柄会先 stopPropagation，走到这里说明按在面上
  if (e.target.tagName === 'circle') return;
  e.preventDefault();
  const start = pointerMeters(e);
  let last = start;
  let armed = false; // 位移超过阈值才算拖动，避免点击选择时误移多边形
  const obj = (kind === 'zone' ? S.doc.zones : S.doc.unusables).find((x) => x.id === id);
  if (!obj) return;
  const rings = ringsOf(obj.geometry);
  const move = (ev) => {
    const m = pointerMeters(ev);
    if (!armed && Math.hypot(m[0] - start[0], m[1] - start[1]) < 6 / S.view.scale) return;
    armed = true;
    const dx = m[0] - last[0], dy = m[1] - last[1];
    rings.forEach((poly) => poly.forEach((ring) => ring.forEach((p) => {
      p[0] += dx; p[1] += dy;
    })));
    last = m;
    afterDocMutated();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function insertVertexAt(edgeIndex) {
  mutateSelectedRing((ring) => {
    const a = ring[edgeIndex], b = ring[edgeIndex + 1];
    ring.splice(edgeIndex + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  });
}
function deleteVertex(vi) {
  mutateSelectedRing((ring) => {
    if (ring.length <= 4) return;
    ring.splice(vi, 1);
    if (vi === 0) ring[ring.length - 1] = ring[0];
  });
}
function deleteSelected() {
  const so = selectedObject();
  if (!so || so.kind === 'floor') return;
  const list = so.kind === 'zone' ? S.doc.zones : S.doc.unusables;
  const i = list.findIndex((x) => x.id === so.obj.id);
  if (i >= 0) list.splice(i, 1);
  S.selection = null;
  afterDocMutated();
}

function pointerMeters(e) {
  const rect = $('plan').getBoundingClientRect();
  return sToM(e.clientX - rect.left, e.clientY - rect.top);
}

/* ---------------- 绘制模式 ---------------- */
function setTool(tool) {
  S.tool = tool;
  S.draw = null;
  S.selection = null;
  document.querySelector(`input[name="tool"][value="${tool}"]`).checked = true;
  render();
}

function beginDraw(kind) {
  if (S.readOnly) return;
  S.draw = { kind, points: [] };
  S.selection = null;
  render();
}
function addDrawPoint(m) {
  const pt = [r3(m[0]), r3(m[1])];
  const first = S.draw.points[0];
  // 点击靠近首点（屏幕约 8px 范围）视为闭合，避免双击先产生两个近乎重合的顶点
  if (first && Math.hypot(pt[0] - first[0], pt[1] - first[1]) < 8 / S.view.scale) {
    finishDraw();
    return;
  }
  S.draw.points.push(pt);
  render();
}
function undoDrawPoint() {
  if (!S.draw) return;
  S.draw.points.pop();
  render();
}
function cancelDraw() {
  S.draw = null;
  setTool('select');
}
function finishDraw() {
  if (!S.draw || S.draw.points.length < 3) return;
  const { kind, points } = S.draw;
  const closed = points.concat([[...points[0]]]);
  const geom = { type: 'Polygon', coordinates: [closed] };
  let obj;
  if (kind === 'floor') {
    S.doc.floor = geom;
    obj = null;
  } else if (kind === 'unusable') {
    obj = { id: genId('u'), name: nextName('不可用', (S.doc.unusables || []).map((x) => x.name)), geometry: geom };
    S.doc.unusables = S.doc.unusables || [];
    S.doc.unusables.push(obj);
  } else {
    const used = (S.doc.zones || []).map((z) => z.color);
    obj = {
      id: genId('z'),
      name: nextName('用途区', (S.doc.zones || []).map((x) => x.name)),
      color: ZONE_COLORS.find((c) => !used.includes(c)) || ZONE_COLORS[S.doc.zones.length % ZONE_COLORS.length],
      geometry: geom,
    };
    S.doc.zones = S.doc.zones || [];
    S.doc.zones.push(obj);
  }
  S.draw = null;
  setTool('select');
  if (obj) S.selection = { kind, id: obj.id }; else S.selection = { kind: 'floor' };
  afterDocMutated();
  fitView(bboxOfDoc(S.doc), 1.2);
  render();
}
function nextName(prefix, names) {
  let i = names.length + 1;
  while (names.includes(`${prefix} ${i}`)) i++;
  return `${prefix} ${i}`;
}

/* =========================================================
 * 服务端：实时判定 / 保存 / 检查 / 确认
 * ========================================================= */
function scheduleLiveCheck() {
  clearTimeout(S.liveTimer);
  const seq = ++S.liveSeq;
  S.liveTimer = setTimeout(async () => {
    try {
      const check = await api('/api/evaluate', { method: 'POST', body: { doc: S.doc } });
      if (seq !== S.liveSeq) return; // 已有更新的编辑
      S.liveCheck = check;
    } catch (e) {
      if (seq !== S.liveSeq) return;
      S.liveCheck = {
        status: 'error', floorArea: 0, unusableInsideArea: 0, usableArea: 0,
        allocatedArea: 0, unallocatedArea: 0, totalNominalArea: 0,
        totalOutsideArea: 0, totalOnUnusableArea: 0, totalOverlapArea: 0,
        effectiveAreaSum: 0, zones: [], unallocated: null,
        problems: [{
          id: 'eval-error', kind: 'invalid_zone', severity: 'blocking',
          message: '服务端无法判定当前草稿：' + (e.data && e.data.details ? e.data.details.join('；') : e.message),
          zoneIds: [], area: 0, geometry: null,
        }],
      };
    }
    render();
  }, 300);
}

async function saveDraft() {
  if (!isDirty()) return;
  const myDoc = clone(S.doc);
  try {
    const r = await api('/api/save', {
      method: 'POST',
      body: { doc: myDoc, baseVersion: S.serverVersion },
    });
    await reloadState();
    S.doc = clone(S.serverDoc);
    clearLocalDraft();
    if (r.created || !S.savedCheck) await runSavedCheck(false);
    S.liveCheck = null;
    render();
    flashTop('已保存为 v' + r.version + '，等待检查完成前不会把它当作通过版本。');
  } catch (e) {
    if (e.status === 409) {
      S.conflict = {
        myDoc,
        baseVersion: S.serverVersion,
        serverVersion: e.data.serverVersion,
        serverDoc: e.data.serverDoc,
        showing: 'mine',
      };
      persistConflict();
      showConflictBanner();
    } else {
      alert('保存被拒绝：' + e.message + (e.data && e.data.details ? '\n' + e.data.details.join('\n') : ''));
    }
  }
}

async function runSavedCheck(userInitiated = true) {
  try {
    S.savedCheck = await api('/api/check', {
      method: 'POST', body: { version: S.serverVersion },
    });
    render();
    if (userInitiated) {
      const b = S.savedCheck.problems.filter((p) => p.severity === 'blocking').length;
      flashTop(b ? `检查完成：${b} 个阻断问题，不能确认交付。` : '检查完成：无阻断问题，可以进入确认流程。');
    }
  } catch (e) {
    alert('检查失败：' + e.message);
  }
}

async function confirmDelivery() {
  // 先强制取一份针对确切保存版本的新鲜检查：旧页面/旧结论不能冒充新版本通过证明。
  let check;
  try {
    check = await api('/api/check', { method: 'POST', body: { version: S.serverVersion } });
  } catch (e) { return alert('检查尚未完成：' + e.message); }
  S.savedCheck = check;
  const blocking = check.problems.filter((p) => p.severity === 'blocking');
  const info = check.problems.filter((p) => p.severity === 'info');
  if (blocking.length) { render(); return alert('仍有阻断问题，无法确认。'); }

  openConfirmModal(check, info);
}

function openConfirmModal(check, info) {
  const ackNeeded = info.length > 0;
  $('modalTitle').textContent = `确认交付保存版本 v${S.serverVersion}`;
  $('modalBody').innerHTML = `
    <div class="kv">
      <span class="k">依据版本</span><span>v${S.serverVersion}（内容指纹 <code>${check.contentHash}</code>）</span>
      <span class="k">检查时间</span><span>${new Date(check.checkedAt).toLocaleString('zh-CN')}</span>
      <span class="k">楼层面积</span><span>${fmt3(check.floorArea)} m²</span>
      <span class="k">可分配面积</span><span>${fmt3(check.usableArea)} m²</span>
      <span class="k">有效面积合计</span><span>${fmt3(check.effectiveAreaSum)} m²</span>
      <span class="k">出界 / 压不可用 / 重叠</span>
      <span>${fmt3(check.totalOutsideArea)} / ${fmt3(check.totalOnUnusableArea)} / ${fmt3(check.totalOverlapArea)} m²</span>
    </div>
    ${ackNeeded ? `<div class="ack">
      <strong>以下提示将随交付记录在案（不阻断确认）：</strong>
      ${info.map((p) => `<div class="checkline">◇ ${escapeHtml(p.message)}</div>`).join('')}
      <label><input type="checkbox" id="ackUnalloc" /> 我已知晓上述未分配等提示，仍确认交付该确切版本。</label>
    </div>` : '<div class="tag-ok">无任何阻断问题与提示。</div>'}
    <div class="hint" style="margin-top:8px">确认只绑定当前版本指纹；之后继续编辑会形成新草稿，不会改动这条交付结论。</div>`;
  showModal(async () => {
    if (ackNeeded && !$('ackUnalloc').checked) { alert('请先勾选知晓提示。'); return false; }
    try {
      const rec = await api('/api/confirm', { method: 'POST', body: { version: S.serverVersion } });
      await reloadState();
      render();
      flashTop(`已确认交付 v${rec.version}（${rec.confirmedAt}）。`);
      return true;
    } catch (e) {
      // 版本在操作期间被同事推进：旧检查结论不能用于新版本
      alert('确认被拒绝：' + e.message);
      await reloadState();
      render();
      return false;
    }
  });
}

/* ---------------- 冲突处理 ---------------- */
function showConflictBanner() {
  const c = S.conflict;
  $('conflictText').textContent =
    `你的草稿基于 v${c.baseVersion}，同事已保存 v${c.serverVersion}。`;
  $('conflictBanner').style.display = '';
}
function hideConflictBanner() {
  $('conflictBanner').style.display = 'none';
  S.conflict = null;
  localStorage.removeItem('zr-conflict');
}

async function conflictShowMine() {
  if (!S.conflict) return;
  S.conflict.showing = 'mine';
  S.doc = clone(S.conflict.myDoc);
  S.selection = null;
  render();
  scheduleLiveCheck();
}
async function conflictShowServer() {
  if (!S.conflict) return;
  S.conflict.showing = 'server';
  await reloadState(); // 拉最新
  S.doc = clone(S.serverDoc);
  // 仍保留我的草稿于 S.conflict 以便切回
  render();
}
async function conflictResave() {
  if (!S.conflict) return;
  // 用户已对照，明确把自己的草稿接到最新版本之后另存（不覆盖任何东西）
  const myDoc = clone(S.conflict.myDoc);
  const serverVersion = S.conflict.serverVersion;
  hideConflictBanner();
  S.doc = myDoc;
  S.serverVersion = serverVersion;
  await saveDraft();
}
async function conflictDiscard() {
  if (!S.conflict) return;
  hideConflictBanner();
  await reloadState();
  S.doc = clone(S.serverDoc);
  clearLocalDraft();
  render();
}

/* ---------------- 历史版本只读 ---------------- */
async function openVersion(version) {
  const v = await api('/api/versions/' + version);
  S.readOnly = true;
  S.viewingVersion = version;
  S.doc = v.doc;
  S.savedCheck = v.check;
  S.selection = null;
  $('historyVersionNo').textContent = 'v' + version;
  $('historyBanner').style.display = '';
  fitView(bboxOfDoc(v.doc));
  render();
}
async function exitHistory() {
  S.readOnly = false;
  S.viewingVersion = null;
  $('historyBanner').style.display = 'none';
  await reloadState();
  S.doc = clone(S.serverDoc);
  render();
}

/* ---------------- 问题定位 ---------------- */
function focusProblem(id) {
  const check = activeCheck();
  if (!check) return;
  const p = check.problems.find((x) => x.id === id);
  if (!p) return;
  S.activeProblemId = id;
  // 涉及的第一个分区：选中后顶点直接可改
  if (p.zoneIds && p.zoneIds.length) {
    const zid = p.zoneIds[0];
    if ((S.doc.zones || []).some((z) => z.id === zid)) selectObject('zone', zid);
    else { S.selection = null; render(); }
  } else {
    S.selection = null;
    render();
    return;
  }
  if (p.geometry) {
    const bb = bboxOfDoc({ floor: null, unusables: [], zones: [{ geometry: p.geometry }] });
    fitView({ minX: bb.minX - 0.5, minY: bb.minY - 0.5, maxX: bb.maxX + 0.5, maxY: bb.maxY + 0.5 });
  }
  render();
}

/* =========================================================
 * 本地草稿 / 状态加载
 * ========================================================= */
function persistLocalDraft() {
  if (!isDirty()) return localStorage.removeItem('zr-draft');
  localStorage.setItem('zr-draft', JSON.stringify({
    baseVersion: S.serverVersion, doc: S.doc, at: new Date().toISOString(),
  }));
}
function clearLocalDraft() { localStorage.removeItem('zr-draft'); $('localDraftBanner').style.display = 'none'; }
function persistConflict() {
  localStorage.setItem('zr-conflict', JSON.stringify(S.conflict));
}

async function reloadState() {
  const st = await api('/api/state');
  S.serverVersion = st.currentVersion;
  S.serverDoc = st.doc;
  S.confirmation = st.confirmation;
  S.versions = st.versions;
  S.savedCheck = st.currentCheck;
  return st;
}

async function init() {
  const st = await reloadState();
  S.doc = clone(S.serverDoc);
  fitView(bboxOfDoc(S.doc));
  render();

  // 自动对当前保存版本跑一次检查（已跑过则后端返回缓存），让“最近一次检查结果”可见
  runSavedCheck(false).catch(() => {});

  // 刷新后恢复未保存草稿提示（它绝不显示为已交付）
  const rawDraft = localStorage.getItem('zr-draft');
  if (rawDraft) {
    try {
      const d = JSON.parse(rawDraft);
      $('localDraftBase').textContent = 'v' + d.baseVersion;
      $('localDraftBanner').style.display = '';
    } catch (e) { clearLocalDraft(); }
  }
  const rawConflict = localStorage.getItem('zr-conflict');
  if (rawConflict) {
    try {
      S.conflict = JSON.parse(rawConflict);
      // 冲突是否仍存在：当前服务端版本比冲突时记录的更新（或一致且非我的基版本）
      if (S.serverVersion >= S.conflict.serverVersion) {
        showConflictBanner();
      } else {
        localStorage.removeItem('zr-conflict');
      }
    } catch (e) { localStorage.removeItem('zr-conflict'); }
  }
}

/* ---------------- 顶部小提示条 ---------------- */
let flashTimer = null;
function flashTop(msg) {
  let bar = document.getElementById('flashBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'flashBar';
    bar.style.cssText = 'position:fixed;top:52px;left:50%;transform:translateX(-50%);background:#111827;color:#e5e7eb;padding:7px 16px;border-radius:7px;font-size:12px;z-index:60;box-shadow:0 4px 14px rgba(0,0,0,.25)';
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
  bar.style.display = '';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { bar.style.display = 'none'; }, 4200);
}

/* ---------------- 通用模态 ---------------- */
function showModal(onOk) {
  $('modal').style.display = '';
  const ok = $('modalOk'), cancel = $('modalCancel');
  const close = () => { $('modal').style.display = 'none'; };
  ok.onclick = async () => { if ((await onOk()) !== false) close(); };
  cancel.onclick = close;
}

/* =========================================================
 * 事件绑定
 * ========================================================= */
function bindEvents() {
  // 工具
  document.querySelectorAll('input[name="tool"]').forEach((r) =>
    r.addEventListener('change', () => (r.value === 'select' ? setTool('select') : beginDraw(r.value))));

  // SVG 指针
  const svg = $('plan');
  let panning = null;
  svg.addEventListener('pointerdown', (e) => {
    if (S.draw) return; // 绘制点击另处理
    // 只有点在画布空白处才平移；点中任何图形/顶点都交给它自己的处理器
    if (e.target === svg && S.tool === 'select') {
      panning = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy };
      svg.setPointerCapture(e.pointerId);
    }
  });
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const m = sToM(e.clientX - rect.left, e.clientY - rect.top);
    S.cursor = m;
    $('coordReadout').textContent = `x ${fmt3(m[0])} m, y ${fmt3(m[1])} m`;
    if (panning) {
      const dx = (e.clientX - panning.x) / S.view.scale;
      const dy = (e.clientY - panning.y) / S.view.scale;
      S.view.cx = panning.cx - dx;
      S.view.cy = panning.cy + dy;
      renderSvg();
    } else if (S.draw) {
      renderSvg();
    }
  });
  svg.addEventListener('pointerup', () => { panning = null; });
  svg.addEventListener('pointerleave', () => { S.cursor = null; renderSvg(); });

  svg.addEventListener('click', (e) => {
    if (!S.draw) {
      if (e.target === svg) { S.selection = null; S.activeProblemId = null; render(); }
      return;
    }
    addDrawPoint(pointerMeters(e));
  });
  svg.addEventListener('dblclick', (e) => {
    if (S.draw) { e.preventDefault(); finishDraw(); }
  });

  // 滚轮：以光标处米坐标为锚缩放（只改视图，不改任何数据/读数）
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const before = sToM(e.clientX - rect.left, e.clientY - rect.top);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    S.view.scale = Math.min(4000, Math.max(2, S.view.scale * factor));
    const { w, h } = svgSize();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    S.view.cx = before[0] - (px - w / 2) / S.view.scale;
    S.view.cy = before[1] + (py - h / 2) / S.view.scale;
    renderSvg();
  }, { passive: false });

  window.addEventListener('resize', renderSvg);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (S.draw && e.key === 'Enter') { e.preventDefault(); finishDraw(); }
    if (S.draw && e.key === 'Escape') { cancelDraw(); }
    if (S.draw && e.key === 'Backspace') { e.preventDefault(); undoDrawPoint(); }
    if (!S.draw && e.key === 'Escape') {
      S.selection = null; S.activeProblemId = null; render();
    }
  });

  $('btnFinishDraw').addEventListener('click', finishDraw);
  $('btnUndoPoint').addEventListener('click', undoDrawPoint);
  $('btnCancelDraw').addEventListener('click', cancelDraw);

  $('btnZoomIn').addEventListener('click', () => { S.view.scale *= 1.25; renderSvg(); });
  $('btnZoomOut').addEventListener('click', () => { S.view.scale /= 1.25; renderSvg(); });
  $('btnZoomFit').addEventListener('click', () => { fitView(bboxOfDoc(S.doc)); renderSvg(); });

  $('btnSave').addEventListener('click', saveDraft);
  $('btnCheckSaved').addEventListener('click', () => runSavedCheck(true));
  $('btnConfirm').addEventListener('click', confirmDelivery);
  $('btnHistory').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="versions"]').click();
  });
  $('btnHistoryExit').addEventListener('click', exitHistory);

  $('btnConflictShowServer').addEventListener('click', conflictShowServer);
  $('btnConflictShowMine').addEventListener('click', conflictShowMine);
  $('btnConflictResave').addEventListener('click', conflictResave);
  $('btnConflictDiscard').addEventListener('click', conflictDiscard);

  $('btnRestoreDraft').addEventListener('click', () => {
    const d = JSON.parse(localStorage.getItem('zr-draft'));
    if (!d) return;
    if (d.baseVersion === S.serverVersion) {
      S.doc = d.doc;
      $('localDraftBanner').style.display = 'none';
      scheduleLiveCheck();
      render();
    } else {
      // 草稿基于的版本已被推进：进入与冲突相同的对照流程，不静默覆盖
      S.conflict = {
        myDoc: d.doc, baseVersion: d.baseVersion,
        serverVersion: S.serverVersion, serverDoc: clone(S.serverDoc), showing: 'server',
      };
      $('localDraftBanner').style.display = 'none';
      persistConflict();
      showConflictBanner();
    }
  });
  $('btnDropDraft').addEventListener('click', clearLocalDraft);

  // tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('pane-metrics').style.display = t.dataset.tab === 'metrics' ? '' : 'none';
    $('pane-versions').style.display = t.dataset.tab === 'versions' ? '' : 'none';
  }));
}

bindEvents();
init();
