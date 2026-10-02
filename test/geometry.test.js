import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, validatePlan, ringArea, stableStringify } from '../shared/geometry.js';

const FLOOR = [[0, 0], [10, 0], [10, 8], [0, 8]];
const plan = (zones, unusable = [], floor = FLOOR) => ({
  floor: { name: 'F', polygon: floor },
  unusable: unusable.map((u, i) => ({ id: `u${i}`, name: u.name || `U${i}`, polygon: u.polygon })),
  zones: zones.map((z, i) => ({ id: `z${i}`, name: z.name || `Z${i}`, polygon: z.polygon })),
});
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('10×8 楼层：0–6 与 5–10 两区间存在 1m×8m 重叠带', () => {
  const r = analyze(plan([
    { name: 'A', polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
    { name: 'B', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
  ]));
  const overlaps = r.issues.filter((i) => i.kind === 'overlap');
  assert.equal(overlaps.length, 1);
  close(overlaps[0].area, 8);
  assert.deepEqual(overlaps[0].zoneIds, ['z0', 'z1']);
  close(r.floorArea, 80);
  close(r.usableArea, 80);
  close(r.totals.multiClaim, 8);
  close(r.totals.nominalSum, 88);
  close(r.totals.assignedUnion, 80);
  close(r.totals.effectiveSum, 72);
  // 剖分恒等式：独占 + 重叠 + 空缺 = 可分配面积。
  close(r.totals.effectiveSum + r.totals.multiClaim + r.totals.gapArea, r.usableArea);
  assert.equal(r.valid, false);
});

test('0–5 与 5–10 仅边界相接：不得产生正面积重叠，且视为无问题', () => {
  const r = analyze(plan([
    { name: 'A', polygon: [[0, 0], [5, 0], [5, 8], [0, 8]] },
    { name: 'B', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
  ]));
  assert.deepEqual(r.issues, []);
  close(r.totals.multiClaim, 0);
  close(r.totals.effectiveSum, 80);
  close(r.totals.gapArea, 0);
  assert.equal(r.valid, true);
});

test('分区超出楼层：越界面积独立计量，不能被标称合计掩盖', () => {
  const r = analyze(plan([{ name: 'A', polygon: [[0, 0], [12, 0], [12, 8], [0, 8]] }]));
  const outside = r.issues.filter((i) => i.kind === 'outside');
  assert.equal(outside.length, 1);
  close(outside[0].area, 16);
  const z = r.zones[0];
  close(z.nominalArea, 96);
  close(z.outsideArea, 16);
  close(z.insideUsableArea, 80);
  close(z.effectiveArea, 80);
  assert.equal(r.valid, false);
});

test('不可用区域：可分配面积与空缺按真实布尔差计算，不是边框相减', () => {
  // 设备间 4≤x≤6, 3≤y≤5（4m²）；分区 A 覆盖 0≤x≤5 的整条带（40m²）。
  const r = analyze(
    plan(
      [{ name: 'A', polygon: [[0, 0], [5, 0], [5, 8], [0, 8]] }],
      [{ name: '设备间', polygon: [[4, 3], [6, 3], [6, 5], [4, 5]] }]
    )
  );
  close(r.floorArea, 80);
  close(r.unusableArea, 4);
  close(r.usableArea, 76); // 80 − 4
  const z = r.zones[0];
  close(z.nominalArea, 40);
  close(z.unusableArea, 2); // 设备间只有 x 4–5 的 1m×2m 与 A 相交
  close(z.effectiveArea, 38);
  close(r.totals.gapArea, 38); // 76 可分配 − 38 独占
  const unus = r.issues.find((i) => i.kind === 'unusable');
  assert.ok(unus && unus.zoneIds.includes('z0'));
  close(unus.area, 2);
  const gap = r.issues.find((i) => i.kind === 'gap');
  close(gap.area, 38);
  close(r.totals.effectiveSum + r.totals.multiClaim + r.totals.gapArea, r.usableArea);
});

test('重叠区域必须报告涉及的全部分区（三方重叠）', () => {
  const r = analyze(plan([
    { name: 'A', polygon: [[0, 0], [8, 0], [8, 8], [0, 8]] },
    { name: 'B', polygon: [[2, 0], [10, 0], [10, 8], [2, 8]] },
    { name: 'C', polygon: [[4, 0], [6, 0], [6, 8], [4, 8]] },
  ]));
  const triple = r.issues.filter((i) => i.kind === 'overlap').find((i) => i.zoneIds.length === 3);
  assert.ok(triple, '应有一个三方重叠单元');
  close(triple.area, 16); // 2m × 8m
  const double = r.issues.filter((i) => i.kind === 'overlap').filter((i) => i.zoneIds.length === 2);
  // A×B 但不含 C：两侧各 2m 宽 → 32
  close(double.reduce((s, i) => s + i.area, 0), 32);
});

test('L 形分区面积与凹多边形处理正确', () => {
  const L = [[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]];
  close(ringArea(L), 8 * 3 + 3 * 5); // 24 + 15 = 39
  const r = analyze(plan([{ name: 'L', polygon: L }]));
  close(r.zones[0].effectiveArea, 39);
  close(r.totals.gapArea, 41);
  assert.equal(r.valid, true);
});

test('无效输入被拒绝：共线零面积、自交、不足三个顶点、非数字坐标', () => {
  assert.throws(() => validatePlan(plan([{ polygon: [[0, 0], [1, 0], [2, 0]] }])), /面积为 0/);
  assert.throws(() => validatePlan(plan([{ polygon: [[0, 0], [2, 0]] }])), /至少需要 3 个/);
  assert.throws(
    () => validatePlan(plan([{ polygon: [[0, 0], [2, 0], [2, 0]] }])),
    /不足 3 个不同顶点|面积为 0/
  );
  assert.throws(
    () => validatePlan(plan([{ polygon: [[0, 0], [1, 0], [1, 'x'], [0, 1]] }])),
    /米制数字坐标/
  );
  // 自交四边形：两条非相邻边在边内部相交（区别于合法的端点相接），面积非零。
  assert.throws(
    () => validatePlan(plan([{ polygon: [[0, 1], [4, 0], [1, 3], [4, 4]] }])),
    /自交/
  );
});

test('坐标以米为单位：面积与缩放无关（同一几何，单位读数恒定）', () => {
  const r1 = analyze(plan([{ polygon: [[0, 0], [3, 0], [3, 4], [0, 4]] }]));
  close(r1.zones[0].effectiveArea, 12);
  const r2 = analyze(plan([{ polygon: [[0, 0], [3.0, 0], [3.0, 4.0], [0, 4.0]] }]));
  close(r2.zones[0].effectiveArea, 12);
});

test('stableStringify 对键顺序不敏感（版本哈希一致性）', () => {
  assert.equal(
    stableStringify({ a: 1, b: [1, 2] }),
    stableStringify({ b: [1, 2], a: 1 })
  );
  assert.notEqual(
    stableStringify({ a: 1 }),
    stableStringify({ a: 2 })
  );
});

test('空缺与重叠并存：两类问题分别报告且面积对账成立', () => {
  const r = analyze(plan([
    { name: 'A', polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] }, // 占左下 24
    { name: 'B', polygon: [[4, 0], [8, 0], [8, 4], [4, 4]] }, // 与 A 重叠 8
  ]));
  close(r.totals.multiClaim, 8);
  close(r.totals.assignedUnion, 32); // 24+16−8
  close(r.totals.gapArea, 48); // 80 − 32
  close(r.totals.effectiveSum, 24);
  close(r.totals.effectiveSum + r.totals.multiClaim + r.totals.gapArea, r.usableArea);
  assert.ok(r.issues.some((i) => i.kind === 'overlap'));
  assert.ok(r.issues.some((i) => i.kind === 'gap'));
});
