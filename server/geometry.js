'use strict';
// 后端几何判定核心：所有面积、重叠、出界、压不可用、未分配结论只在这里产生。
// 坐标统一为米。布尔运算使用经过验证的 polygon-clipping，本模块不自行实现裁剪算法。
const crypto = require('crypto');
const pc = require('polygon-clipping');

// 小于该面积（平方米）的残留多边形视为退化（共边相接时布尔库可能产生的零宽碎片）。
const EPS_AREA = 1e-7;

/* ---------------- 基础几何工具 ---------------- */

// Shoelace 有向面积（环；末点与首点重复）
function ringArea(ring) {
  let a = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; // 环闭合：每条边都计入
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return a / 2;
}

// 多边形净面积。polygon-clipping 输出遵循外环 CCW（有向面积为正）、洞环 CW（为负），
// 因此按有向面积求和即可正确扣除孔洞；对退化方向也用绝对值兜底。
function polygonArea(poly) {
  const outer = Math.abs(ringArea(poly[0]));
  let holes = 0;
  for (let i = 1; i < poly.length; i++) holes += Math.abs(ringArea(poly[i]));
  return outer - holes;
}

// 多多边形（多外环）总面积。
function multiArea(multi) {
  return multi.reduce((s, p) => s + polygonArea(p), 0);
}

// GeoJSON 式 Feature 几何 -> polygon-clipping 内部的多多边形形式（外环/洞数组）。
// 支持 Polygon / MultiPolygon，保留洞。
function toMulti(featureGeo) {
  const t = featureGeo.type;
  if (t === 'Polygon') return [featureGeo.coordinates];
  if (t === 'MultiPolygon') return featureGeo.coordinates;
  throw new Error('unsupported geometry type: ' + t);
}

// 把 polygon-clipping 输出规范化回 Feature 几何，过滤退化碎片。
function fromMulti(multi) {
  const polys = (multi || []).filter((p) => polygonArea(p) >= EPS_AREA);
  if (polys.length === 0) return null;
  if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
  return { type: 'MultiPolygon', coordinates: polys };
}

function areaOf(featureGeo) {
  if (!featureGeo) return 0;
  return multiArea(toMulti(featureGeo));
}

// 并/交/差，输入为 Feature 几何数组；空结果统一返回 null。
function union(...features) {
  const valid = features.filter(Boolean);
  if (valid.length === 0) return null;
  try {
    return fromMulti(pc.union(...valid.map(toMulti)));
  } catch (e) {
    throw wrapGeomError(e);
  }
}

function intersectionOf(...features) {
  const valid = features.filter(Boolean);
  if (valid.length < 2) return null;
  try {
    const r = pc.intersection(...valid.map(toMulti));
    return fromMulti(r);
  } catch (e) {
    throw wrapGeomError(e);
  }
}

function difference(base, ...cuts) {
  const validCuts = cuts.filter(Boolean);
  if (!base) return null;
  try {
    const r = validCuts.length
      ? pc.difference(toMulti(base), ...validCuts.map(toMulti))
      : toMulti(base);
    return fromMulti(r);
  } catch (e) {
    throw wrapGeomError(e);
  }
}

function wrapGeomError(e) {
  const err = new Error('几何运算失败，可能存在自交或无效多边形：' + e.message);
  err.code = 'GEOM_INVALID';
  return err;
}

/* ---------------- 简单多边形有效性（自交检测） ---------------- */
// 只检测线段真正穿越的交叉；端点相接、共线重叠不算自交。
function segmentsCross(a, b, c, d) {
  const z = (p1, p2, p3) =>
    (p3[1] - p1[1]) * (p2[0] - p1[0]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
  const z1 = z(a, b, c), z2 = z(a, b, d), z3 = z(c, d, a), z4 = z(c, d, b);
  return (
    ((z1 > 0 && z2 < 0) || (z1 < 0 && z2 > 0)) &&
    ((z3 > 0 && z4 < 0) || (z3 < 0 && z4 > 0))
  );
}

function ringSelfIntersects(ring) {
  const n = ring.length - 1; // 末点与首点重复
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 相邻边（含首尾）共享端点，跳过
      if (Math.abs(i - j) === 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

/* ---------------- 文档内容哈希（版本身份） ---------------- */
function docHash(doc) {
  const canon = JSON.stringify({
    floor: doc.floor || null,
    unusables: (doc.unusables || []).map((u) => ({
      id: u.id, name: u.name, geometry: u.geometry,
    })),
    zones: (doc.zones || []).map((z) => ({
      id: z.id, name: z.name, color: z.color || '', geometry: z.geometry,
    })),
  });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

/* ---------------- 核心评估：对一份完整文档做独立几何判定 ---------------- */
// 返回 {
//   contentHash, status:'complete',
//   floorArea, unusableInsideArea, usableArea, allocatedArea, unallocatedArea,
//   totalNominalArea, totalOutsideArea, totalOnUnusableArea, totalOverlapArea,
//   effectiveAreaSum,
//   zones: [{id,name,nominalArea,outsideArea,onUnusableArea,overlapArea,effectiveArea,
//            usablePart, geometry}],
//   unallocated: Feature|null,
//   problems: [{id,kind,severity,message,zoneIds,area,geometry}],
// }
function evaluate(doc) {
  const problems = [];
  const hash = docHash(doc);
  const floor = doc.floor || null;

  const empty = (extra) => ({
    contentHash: hash,
    status: 'complete',
    floorArea: 0, unusableInsideArea: 0, usableArea: 0,
    allocatedArea: 0, unallocatedArea: 0,
    totalNominalArea: 0, totalOutsideArea: 0, totalOnUnusableArea: 0,
    totalOverlapArea: 0, effectiveAreaSum: 0,
    zones: [], unallocated: null, problems: [...(extra || [])],
  });

  if (!floor) {
    return empty([{
      id: 'no-floor', kind: 'no_floor', severity: 'blocking',
      message: '尚未建立楼层外轮廓，无法进行任何面积判定。',
      zoneIds: [], area: 0, geometry: null,
    }]);
  }

  // 先做简单多边形校验：自交楼层无法定义“楼内/楼外”，直接阻断。
  const floorRings = toMulti(floor);
  if (floorRings.some((poly) => poly.some((ring) => ringSelfIntersects(ring)))) {
    return empty([{
      id: 'floor-invalid', kind: 'invalid_floor', severity: 'blocking',
      message: '楼层外轮廓存在自交（边相互穿越），请修正顶点。',
      zoneIds: [], area: 0, geometry: null,
    }]);
  }

  let floorArea;
  try {
    floorArea = areaOf(floor);
  } catch (e) {
    return empty([{
      id: 'floor-invalid', kind: 'invalid_floor', severity: 'blocking',
      message: '楼层外轮廓几何无效（可能自交），请修正顶点。',
      zoneIds: [], area: 0, geometry: null,
    }]);
  }

  // 不可用区域：只统计落在楼层内的部分；超出楼层单独提示。
  const unusableInsideParts = [];
  (doc.unusables || []).forEach((u) => {
    if (toMulti(u.geometry).some((poly) => poly.some((ring) => ringSelfIntersects(ring)))) {
      problems.push({
        id: 'unusable-invalid:' + u.id, kind: 'invalid_unusable', severity: 'blocking',
        message: `不可用区域「${u.name}」存在自交，请修正顶点。`,
        zoneIds: [], area: 0, geometry: null,
      });
      return;
    }
    let inside;
    try {
      inside = intersectionOf(u.geometry, floor);
    } catch (e) {
      problems.push({
        id: 'unusable-invalid:' + u.id, kind: 'invalid_unusable', severity: 'blocking',
        message: `不可用区域「${u.name}」几何无效（可能自交）。`,
        zoneIds: [], area: 0, geometry: null,
      });
      return;
    }
    if (inside) unusableInsideParts.push(inside);
  });
  const unusableUnion = union(...unusableInsideParts);
  const unusableInsideArea = areaOf(unusableUnion);
  const usableGeom = difference(floor, unusableUnion); // 楼层减去全部不可用
  const usableArea = areaOf(usableGeom);

  // 每个分区的分解：出界 / 压不可用 / 落在可用面的部分
  const zoneRows = [];
  for (const z of doc.zones || []) {
    if (toMulti(z.geometry).some((poly) => poly.some((ring) => ringSelfIntersects(ring)))) {
      problems.push({
        id: 'zone-invalid:' + z.id, kind: 'invalid_zone', severity: 'blocking',
        message: `分区「${z.name}」存在自交（边相互穿越），请修正顶点。`,
        zoneIds: [z.id], area: 0, geometry: null,
      });
      zoneRows.push({
        id: z.id, name: z.name, nominalArea: 0, outsideArea: 0,
        onUnusableArea: 0, overlapArea: 0, effectiveArea: 0,
        usablePart: null, invalid: true,
      });
      continue;
    }
    let nominal = 0;
    try {
      nominal = areaOf(z.geometry);
    } catch (e) {
      problems.push({
        id: 'zone-invalid:' + z.id, kind: 'invalid_zone', severity: 'blocking',
        message: `分区「${z.name}」几何无效（可能自交）。`,
        zoneIds: [z.id], area: 0, geometry: null,
      });
      zoneRows.push({
        id: z.id, name: z.name, nominalArea: 0, outsideArea: 0,
        onUnusableArea: 0, overlapArea: 0, effectiveArea: 0,
        usablePart: null, invalid: true,
      });
      continue;
    }
    const insideFloor = safeIntersection(z.geometry, floor, problems, z, '楼层');
    const outsideGeom = safeDifference(z.geometry, floor, problems, z);
    const onUnusableGeom = unusableUnion && insideFloor
      ? safeIntersection(insideFloor, unusableUnion, problems, z, '不可用区域')
      : null;
    const usablePart = insideFloor && unusableUnion
      ? safeDifference(insideFloor, unusableUnion, problems, z)
      : insideFloor;

    const outsideArea = areaOf(outsideGeom);
    const onUnusableArea = areaOf(onUnusableGeom);
    zoneRows.push({
      id: z.id, name: z.name, nominalArea: nominal,
      outsideArea, onUnusableArea,
      overlapArea: 0, effectiveArea: areaOf(usablePart),
      usablePart,
      outsideGeom, onUnusableGeom,
      invalid: false,
    });

    if (outsideArea >= EPS_AREA) {
      problems.push({
        id: `outside:${z.id}`, kind: 'outside_floor', severity: 'blocking',
        message: `分区「${z.name}」有 ${fmt(outsideArea)} m² 超出楼层外轮廓。`,
        zoneIds: [z.id], area: outsideArea, geometry: outsideGeom,
      });
    }
    if (onUnusableArea >= EPS_AREA) {
      problems.push({
        id: `on-unusable:${z.id}`, kind: 'on_unusable', severity: 'blocking',
        message: `分区「${z.name}」有 ${fmt(onUnusableArea)} m² 压在不可用区域上。`,
        zoneIds: [z.id], area: onUnusableArea, geometry: onUnusableGeom,
      });
    }
  }

  // 两两重叠（只统计可用面上的正面积相交；无缝相接的退化结果被 EPS 过滤）。
  const validRows = zoneRows.filter((r) => !r.invalid);
  for (let i = 0; i < validRows.length; i++) {
    for (let j = i + 1; j < validRows.length; j++) {
      const a = validRows[i], b = validRows[j];
      if (!a.usablePart || !b.usablePart) continue;
      const ov = safeIntersection(a.usablePart, b.usablePart, null, null, null, true);
      const area = areaOf(ov);
      if (area >= EPS_AREA) {
        a.overlapArea += area;
        b.overlapArea += area;
        problems.push({
          id: `overlap:${a.id}|${b.id}`, kind: 'overlap', severity: 'blocking',
          message: `「${a.name}」与「${b.name}」重复占用 ${fmt(area)} m²。`,
          zoneIds: [a.id, b.id], area, geometry: ov,
        });
      }
    }
  }

  // 有效面积：落在可用面、并扣除与其他分区重复占用的部分。
  let effectiveAreaSum = 0;
  for (const r of validRows) {
    const own = usableAreaOwned(r, validRows);
    r.effectiveArea = areaOf(own);
    r.effectiveGeom = own;
    effectiveAreaSum += r.effectiveArea;
  }

  // 已分配（去重并集，落在可用面）与未分配
  const allocatedGeom = union(...validRows.map((r) => r.usablePart).filter(Boolean));
  const allocatedArea = areaOf(allocatedGeom);
  const unallocated = allocatedGeom ? difference(usableGeom, allocatedGeom) : usableGeom;
  const unallocatedArea = areaOf(unallocated);
  if (unallocatedArea >= EPS_AREA) {
    problems.push({
      id: 'unallocated', kind: 'unallocated', severity: 'info',
      message: `可用地面有 ${fmt(unallocatedArea)} m² 未归属任何用途分区。`,
      zoneIds: [], area: unallocatedArea, geometry: unallocated,
    });
  }

  return {
    contentHash: hash,
    status: 'complete',
    floorArea, unusableInsideArea, usableArea,
    allocatedArea, unallocatedArea,
    totalNominalArea: validRows.reduce((s, r) => s + r.nominalArea, 0),
    totalOutsideArea: validRows.reduce((s, r) => s + r.outsideArea, 0),
    totalOnUnusableArea: validRows.reduce((s, r) => s + r.onUnusableArea, 0),
    totalOverlapArea: problems
      .filter((p) => p.kind === 'overlap')
      .reduce((s, p) => s + p.area, 0),
    effectiveAreaSum,
    zones: zoneRows
      .filter((r) => r.id !== undefined)
      .map((r) => ({
        id: r.id, name: r.name,
        nominalArea: r.nominalArea,
        outsideArea: r.outsideArea,
        onUnusableArea: r.onUnusableArea,
        overlapArea: r.overlapArea,
        effectiveArea: r.effectiveArea,
        invalid: !!r.invalid,
      })),
    unallocated,
    problems,
  };
}

// 某分区在可用面上“独占”的部分（有效面积口径：扣掉与其他分区的重复）。
function usableAreaOwned(row, allRows) {
  const others = allRows
    .filter((r) => r !== row && r.usablePart)
    .map((r) => r.usablePart);
  return others.length ? difference(row.usablePart, ...others) : row.usablePart;
}

function safeIntersection(a, b, problems, zone, what, silent) {
  try {
    return intersectionOf(a, b);
  } catch (e) {
    if (!silent && problems) {
      problems.push({
        id: `op-fail:${zone ? zone.id : '?'}:${what || ''}`,
        kind: 'invalid_zone', severity: 'blocking',
        message: `分区「${zone ? zone.name : ''}」与${what || '其他区域'}求交失败，几何可能自交。`,
        zoneIds: zone ? [zone.id] : [], area: 0, geometry: null,
      });
    }
    return null;
  }
}

function safeDifference(a, b, problems, zone) {
  try {
    return difference(a, b);
  } catch (e) {
    if (problems && zone) {
      problems.push({
        id: `op-fail-d:${zone.id}`, kind: 'invalid_zone', severity: 'blocking',
        message: `分区「${zone.name}」几何运算失败，多边形可能自交。`,
        zoneIds: [zone.id], area: 0, geometry: null,
      });
    }
    return null;
  }
}

function fmt(v) {
  return (Math.round(v * 1000) / 1000).toString();
}

module.exports = {
  EPS_AREA,
  ringArea,
  ringSelfIntersects,
  areaOf,
  union,
  intersectionOf,
  difference,
  docHash,
  evaluate,
};
