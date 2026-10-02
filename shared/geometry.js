// 共享几何内核：浏览器与 Node 使用同一份实现。
// Node 端从 node_modules 解析 polygon-clipping；浏览器端由 import map 指向其 ESM 构建。
import polygonClipping from 'polygon-clipping';

// 小于该面积（平方米）的布尔运算残片视为零面积（共边相接产生的退化结果）。
export const EPS = 1e-9;

/* ------------------------------ 基础工具 ------------------------------ */

export function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function ringArea(ring) {
  return Math.abs(signedArea(ring));
}

// 去掉首尾重合点，返回开放环（polygon-clipping 接受开放环）。
export function cleanRing(points) {
  const pts = points.map((p) => [Number(p[0]), Number(p[1])]);
  while (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) pts.pop();
    else break;
  }
  return pts;
}

function validateRing(points, label) {
  if (!Array.isArray(points)) throw new Error(`${label}：坐标必须是点数组`);
  if (points.length < 3) throw new Error(`${label}：至少需要 3 个顶点（当前 ${points.length} 个）`);
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) {
      throw new Error(`${label}：存在不是米制数字坐标的顶点 ${JSON.stringify(p)}`);
    }
  }
  const ring = cleanRing(points);
  if (ring.length < 3) throw new Error(`${label}：去重后不足 3 个不同顶点`);
  if (ringArea(ring) <= EPS) throw new Error(`${label}：多边形面积为 0，顶点可能共线或重合`);
  return ring;
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('计划数据格式不正确');
  if (!plan.floor || !Array.isArray(plan.floor.polygon)) throw new Error('缺少楼层外轮廓 floor.polygon');
  const floor = validateRing(plan.floor.polygon, '楼层外轮廓');
  const unusable = [];
  for (const u of plan.unusable || []) {
    unusable.push({ id: String(u.id), name: String(u.name || u.id), polygon: validateRing(u.polygon, `不可用区域「${u.name || u.id}」`) });
  }
  const zones = [];
  for (const z of plan.zones || []) {
    zones.push({ id: String(z.id), name: String(z.name || z.id), color: z.color || null, polygon: validateRing(z.polygon, `用途分区「${z.name || z.id}」`) });
  }
  // 简单的自交检查：任意非相邻边不相交（含端点重合）。
  for (const item of [{ ring: floor, label: '楼层外轮廓' }, ...unusable.map((u) => ({ ring: u.polygon, label: `不可用区域「${u.name}」` })), ...zones.map((z) => ({ ring: z.polygon, label: `用途分区「${z.name}」` }))]) {
    assertSimpleRing(item.ring, item.label);
  }
  return { floor, unusable, zones };
}

function segIntersect(p, q, r, s) {
  const d1 = cross(r, s, p);
  const d2 = cross(r, s, q);
  const d3 = cross(p, q, r);
  const d4 = cross(p, q, s);
  const eps = 1e-10;
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  return false; // 端点相接属于合法邻接，不算自交
}
function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function assertSimpleRing(ring, label) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = (i + 1) % n === j || (j + 1) % n === i;
      if (adjacent) continue;
      if (segIntersect(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) {
        throw new Error(`${label}：第 ${i + 1} 条边与第 ${j + 1} 条边交叉，多边形存在自交`);
      }
    }
  }
}

/* --------------------------- MultiPolygon 封装 --------------------------- */
// polygon-clipping 的 MultiPolygon 形态：[ Polygon ]，Polygon = [ Ring, ...holes ]。

export const EMPTY_MP = [];

export function toMP(ring) {
  return [[cleanRing(ring)]];
}

// 带符号面积求和：外环减洞（库输出遵循 GeoJSON：首环为外环，其余为洞）。
export function mpArea(mp) {
  let area = 0;
  for (const poly of mp) {
    for (let i = 0; i < poly.length; i++) {
      area += i === 0 ? ringArea(poly[i]) : -ringArea(poly[i]);
    }
  }
  return area;
}

// 去除运算产生的零面积退化残片（共边相接不应留下正面积）。
function trim(mp) {
  const out = [];
  for (const poly of mp) {
    const rings = poly.filter((r) => ringArea(r) > EPS);
    if (rings.length && ringArea(rings[0]) > EPS) out.push(rings);
  }
  return out;
}

function safe(fn) {
  try {
    return trim(fn());
  } catch (err) {
    throw new Error(`几何运算失败：${err.message}`);
  }
}

export const intersectMP = (a, b) => (a.length && b.length ? safe(() => polygonClipping.intersection(a, b)) : EMPTY_MP);
export const subtractMP = (a, b) => (a.length ? safe(() => polygonClipping.difference(a, b)) : EMPTY_MP);
export const union2 = (a, b) => {
  if (!a.length) return b;
  if (!b.length) return a;
  return safe(() => polygonClipping.union(a, b));
};
export function unionAll(mps) {
  let acc = EMPTY_MP;
  for (const mp of mps) acc = union2(acc, mp);
  return acc;
}
export const isEmpty = (mp) => !mp || mp.length === 0 || mpArea(mp) <= EPS;

/* ------------------------------ 计划分析 ------------------------------ */

/**
 * 分析整份楼层计划。
 * 返回每个分区的标称/越界/压占/重叠/独占有效面积、问题区域（含涉及分区与几何）、
 * 以及可与楼层面积对齐的汇总数字。
 */
export function analyze(plan) {
  const { floor, unusable, zones } = validatePlan(plan);

  const floorMP = toMP(floor);
  const floorArea = mpArea(floorMP);

  // 不可用区域先裁进楼层，再求并（超出楼层的部分与可分配面积无关）。
  const unusableMPs = unusable.map((u) => intersectMP(toMP(u.polygon), floorMP));
  const unusableUnion = unionAll(unusableMPs);
  const unusableArea = mpArea(unusableUnion);
  const usableMP = subtractMP(floorMP, unusableUnion);
  const usableArea = mpArea(usableMP);

  const issues = [];
  const issue = (kind, severity, data) => {
    const it = { id: `${kind}-${issues.length + 1}`, kind, severity, ...data };
    issues.push(it);
    return it;
  };

  // 每分区：越界、压不可用、可用区内部分。
  const zoneData = zones.map((z) => {
    const raw = toMP(z.polygon);
    const nominalArea = mpArea(raw);
    const outsideMP = subtractMP(raw, floorMP);
    const onUnusableMP = intersectMP(raw, unusableUnion);
    const insideUsableMP = intersectMP(raw, usableMP);
    return { zone: z, raw, nominalArea, outsideMP, onUnusableMP, insideUsableMP, exclusiveMP: EMPTY_MP, overlapArea: 0 };
  });

  for (const d of zoneData) {
    if (!isEmpty(d.outsideMP)) {
      issue('outside', 'error', {
        title: `「${d.zone.name}」超出楼层外轮廓`,
        area: mpArea(d.outsideMP),
        zoneIds: [d.zone.id],
        multipolygon: d.outsideMP,
      });
    }
    if (!isEmpty(d.onUnusableMP)) {
      // 同时给出压到了哪些不可用区域。
      const hitUnusable = [];
      unusable.forEach((u, i) => {
        const part = intersectMP(d.raw, unusableMPs[i]);
        if (!isEmpty(part)) hitUnusable.push({ id: u.id, name: u.name, area: mpArea(part), multipolygon: part });
      });
      issue('unusable', 'error', {
        title: `「${d.zone.name}」压在不可用区域上`,
        area: mpArea(d.onUnusableMP),
        zoneIds: [d.zone.id],
        unusable: hitUnusable,
        multipolygon: d.onUnusableMP,
      });
    }
  }

  /*
   * 对“可用面积”做增量剖分：cells 始终构成 usableMP 的一个划分，
   * 每个 cell 记录覆盖它的分区集合。
   * 长度 0 → 空缺；1 → 该分区独占；>=2 → 多方重叠（且天然带涉及分区列表）。
   */
  let cells = usableMP.length ? [{ mp: usableMP, zoneIds: [] }] : [];
  for (const d of zoneData) {
    if (isEmpty(d.insideUsableMP)) continue;
    const zp = d.insideUsableMP;
    const next = [];
    for (const cell of cells) {
      const inter = intersectMP(cell.mp, zp);
      if (isEmpty(inter)) {
        next.push(cell);
      } else {
        const rest = subtractMP(cell.mp, zp);
        if (!isEmpty(rest)) next.push({ mp: rest, zoneIds: cell.zoneIds });
        next.push({ mp: inter, zoneIds: [...cell.zoneIds, d.zone.id] });
      }
    }
    cells = next;
  }

  const exclusiveByZone = new Map(zones.map((z) => [z.id, []]));
  const gapParts = [];
  for (const cell of cells) {
    if (cell.zoneIds.length === 0) {
      gapParts.push(cell.mp);
    } else if (cell.zoneIds.length === 1) {
      exclusiveByZone.get(cell.zoneIds[0]).push(cell.mp);
    } else {
      const names = cell.zoneIds.map((id) => zones.find((z) => z.id === id)?.name || id);
      issue('overlap', 'error', {
        title: `${names.join(' × ')} 重复占用`,
        area: mpArea(cell.mp),
        zoneIds: cell.zoneIds,
        multipolygon: cell.mp,
      });
    }
  }

  const zoneResults = zoneData.map((d) => {
    const exclusiveMP = unionAll(exclusiveByZone.get(d.zone.id));
    const exclusiveArea = mpArea(exclusiveMP);
    const insideUsableArea = mpArea(d.insideUsableMP);
    return {
      id: d.zone.id,
      name: d.zone.name,
      nominalArea: d.nominalArea,
      outsideArea: mpArea(d.outsideMP),
      unusableArea: mpArea(d.onUnusableMP),
      insideUsableArea,
      overlapArea: Math.max(0, insideUsableArea - exclusiveArea),
      effectiveArea: exclusiveArea, // 独占有效面积：在楼层内、不压不可用、不与任何分区重复
    };
  });

  const gapMP = unionAll(gapParts);
  const gapArea = mpArea(gapMP);
  if (gapArea > EPS) {
    issue('gap', 'info', {
      title: '可用地面尚无分区归属（空缺）',
      area: gapArea,
      zoneIds: [],
      multipolygon: gapMP,
    });
  }

  const nominalSum = zoneResults.reduce((s, z) => s + z.nominalArea, 0);
  const insideUsableSum = zoneResults.reduce((s, z) => s + z.insideUsableArea, 0);
  const effectiveSum = zoneResults.reduce((s, z) => s + z.effectiveArea, 0);
  const assignedUnion = usableArea - gapArea; // 剖分保证恒等
  const multiClaim = Math.max(0, insideUsableSum - assignedUnion); // 标称合计中被重复多计的部分

  const errors = issues.filter((i) => i.severity === 'error');

  return {
    valid: errors.length === 0,
    floorArea,
    unusableArea,
    usableArea,
    zones: zoneResults,
    issues,
    gapMP,
    totals: {
      nominalSum,
      insideUsableSum,
      effectiveSum,
      assignedUnion,
      multiClaim,
      gapArea,
    },
  };
}

/* ------------------------------ 规范化序列化 ------------------------------ */

export function stableValue(v) {
  if (Array.isArray(v)) return v.map(stableValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = stableValue(v[k]);
    return out;
  }
  return v;
}

export function stableStringify(v) {
  return JSON.stringify(stableValue(v));
}

export function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
