'use strict';
// 保存内容的结构校验：保证服务端拿到的是可计算的米坐标多边形文档。
// 不做“是否重叠”的判定——那是 geometry.evaluate 的职责。

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function validateRing(ring, label, errors) {
  if (!Array.isArray(ring) || ring.length < 4) {
    errors.push(`${label}：环至少需要 4 个点（含闭合点）`);
    return;
  }
  ring.forEach((p, i) => {
    if (!Array.isArray(p) || p.length < 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
      errors.push(`${label}：第 ${i + 1} 个点不是有效的米坐标 [x, y]`);
    }
  });
  const first = ring[0], last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    errors.push(`${label}：环必须闭合（末点与首点相同）`);
  }
}

function validateGeometry(g, label, errors) {
  if (!g || typeof g !== 'object') {
    errors.push(`${label}：缺少 geometry`);
    return;
  }
  if (g.type === 'Polygon') {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) {
      errors.push(`${label}：Polygon 缺少 coordinates`);
      return;
    }
    g.coordinates.forEach((ring, i) => validateRing(ring, `${label} 环${i + 1}`, errors));
  } else if (g.type === 'MultiPolygon') {
    if (!Array.isArray(g.coordinates)) {
      errors.push(`${label}：MultiPolygon 缺少 coordinates`);
      return;
    }
    g.coordinates.forEach((poly, pi) => {
      if (!Array.isArray(poly)) {
        errors.push(`${label}：第 ${pi + 1} 个多边形无效`);
        return;
      }
      poly.forEach((ring, ri) => validateRing(ring, `${label} 多边形${pi + 1}环${ri + 1}`, errors));
    });
  } else {
    errors.push(`${label}：geometry.type 仅支持 Polygon / MultiPolygon`);
  }
}

function validateDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return ['请求体必须是文档对象 {floor, unusables, zones}'];
  }
  if (doc.floor !== null && doc.floor !== undefined) {
    validateGeometry(doc.floor, '楼层外轮廓', errors);
  }
  for (const key of ['unusables', 'zones']) {
    if (!Array.isArray(doc[key])) {
      errors.push(`${key} 必须是数组`);
      continue;
    }
    doc[key].forEach((item, i) => {
      const label = `${key}[${i}]`;
      if (!item || typeof item !== 'object') {
        errors.push(`${label} 不是对象`);
        return;
      }
      if (typeof item.id !== 'string' || !item.id) errors.push(`${label} 缺少 id`);
      if (typeof item.name !== 'string') errors.push(`${label} 缺少 name`);
      validateGeometry(item.geometry, `${label}（${item.name || '未命名'}）`, errors);
    });
  }
  // id 唯一性
  const ids = [];
  (doc.unusables || []).forEach((u) => ids.push(u.id));
  (doc.zones || []).forEach((z) => ids.push(z.id));
  if (new Set(ids).size !== ids.length) errors.push('不可用区域与分区的 id 必须唯一');
  return errors;
}

module.exports = { validateDoc };
