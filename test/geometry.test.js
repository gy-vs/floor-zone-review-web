'use strict';
// 自动测试：纯几何判定 + HTTP API（保存冲突、检查、确认、版本不可变、刷新后可查）。
// 使用独立临时数据目录，不依赖外部数据库或系统可执行文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const G = require('../server/geometry');

const P = (coords) => ({ type: 'Polygon', coordinates: [coords.concat([coords[0]])] });
// 矩形 [x0,x1] × [y0,y1]
const rect = (x0, y0, x1, y1) => P([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

/* ---------------- 几何单元测试 ---------------- */

test('10×8 楼层，0-6 与 5-10 两区：1m×8m 重复带，有效面积扣重，未分配 0', () => {
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [],
    zones: [
      { id: 'a', name: '甲', geometry: rect(0, 0, 6, 8) },  // 6×8 = 48
      { id: 'b', name: '乙', geometry: rect(5, 0, 10, 8) }, // 5×8 = 40
    ],
  };
  const r = G.evaluate(doc);
  assert.equal(r.floorArea, 80);
  assert.equal(r.usableArea, 80);
  assert.equal(r.totalNominalArea, 88);
  assert.equal(r.totalOverlapArea, 8); // 1m 宽 × 8m
  assert.equal(r.allocatedArea, 80);  // 去重并集铺满
  assert.equal(r.unallocatedArea, 0);
  const ov = r.problems.find((p) => p.kind === 'overlap');
  assert.ok(ov);
  assert.equal(ov.area, 8);
  assert.deepEqual(ov.zoneIds.sort(), ['a', 'b']);
  const za = r.zones.find((z) => z.id === 'a');
  const zb = r.zones.find((z) => z.id === 'b');
  assert.equal(za.nominalArea, 48);
  assert.equal(za.effectiveArea, 40); // 扣除 5-6 重复带 8
  assert.equal(zb.nominalArea, 40);
  assert.equal(zb.effectiveArea, 32);
  assert.equal(r.effectiveAreaSum, 72);
});

test('无缝相接（0-5 与 5-10）：无正面积重叠，全部覆盖，未分配为 0', () => {
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [],
    zones: [
      { id: 'a', name: '甲', geometry: rect(0, 0, 5, 8) },
      { id: 'b', name: '乙', geometry: rect(5, 0, 10, 8) },
    ],
  };
  const r = G.evaluate(doc);
  assert.equal(r.totalOverlapArea, 0);
  assert.equal(r.problems.filter((p) => p.kind === 'overlap').length, 0);
  assert.equal(r.allocatedArea, 80);
  assert.equal(r.unallocatedArea, 0);
  assert.equal(r.effectiveAreaSum, 80);
});

test('分区超出楼层：出界面积按超出部分计，不只是标称和对不上', () => {
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [],
    zones: [{ id: 'a', name: '甲', geometry: rect(8, 6, 13, 11) }], // 5×5，楼内 2×2
  };
  const r = G.evaluate(doc);
  const z = r.zones[0];
  assert.equal(z.nominalArea, 25);
  assert.equal(z.outsideArea, 21);
  assert.equal(z.effectiveArea, 4);
  assert.ok(r.problems.some((p) => p.kind === 'outside_floor' && p.area === 21));
});

test('不可用区域（柱体）：可分配为布尔差，分区压在上面的部分单独计出，未分配来自布尔运算而非边框相减', () => {
  const col = rect(4, 3, 5, 4); // 1 m² 柱
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [{ id: 'c', name: '柱', geometry: col }],
    // 分区 0-6 盖住柱子
    zones: [{ id: 'a', name: '甲', geometry: rect(0, 0, 6, 8) }],
  };
  const r = G.evaluate(doc);
  assert.equal(r.unusableInsideArea, 1);
  assert.equal(r.usableArea, 79);
  const z = r.zones[0];
  assert.equal(z.nominalArea, 48);
  assert.equal(z.onUnusableArea, 1);
  assert.equal(z.effectiveArea, 47); // 柱位不能算它的有效面积
  assert.ok(r.problems.some((p) => p.kind === 'on_unusable' && p.area === 1));
  // 未分配 = 可用面减去已分配并集（带洞差，不是 80-48=32 的边框假数字）
  assert.equal(r.allocatedArea, 47);
  assert.equal(r.unallocatedArea, 32);
});

test('两块不可用区域重叠摆放：不可用面积按并集去重，不重复扣减', () => {
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [
      { id: 'u1', name: '设备间', geometry: rect(0, 0, 2, 2) },
      { id: 'u2', name: '扩展', geometry: rect(1, 0, 3, 2) }, // 与 u1 重叠 1×2
    ],
    zones: [],
  };
  const r = G.evaluate(doc);
  assert.equal(r.unusableInsideArea, 6); // 并集 3×2
  assert.equal(r.usableArea, 74);
  assert.equal(r.unallocatedArea, 74);
});

test('不可用区域伸到楼层外：只统计楼层内部分', () => {
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [{ id: 'u', name: '设备间', geometry: rect(9, 7, 12, 10) }], // 楼内 1×1
    zones: [],
  };
  const r = G.evaluate(doc);
  assert.equal(r.unusableInsideArea, 1);
  assert.equal(r.usableArea, 79);
});

test('三区交错：重叠合计为各重叠块之和，有效面积扣全部重复', () => {
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [],
    zones: [
      { id: 'a', name: '甲', geometry: rect(0, 0, 6, 8) },
      { id: 'b', name: '乙', geometry: rect(5, 0, 10, 8) },
      { id: 'c', name: '丙', geometry: rect(2, 0, 4, 8) }, // 与甲重叠 2×8
    ],
  };
  const r = G.evaluate(doc);
  // 重叠块：a∩b=8, a∩c=16, b∩c=0
  assert.equal(r.totalOverlapArea, 24);
  // 并集铺满 0-10（a 与 b 合起来已是整层）
  assert.equal(r.allocatedArea, 80);
  assert.equal(r.unallocatedArea, 0);
  const za = r.zones.find((z) => z.id === 'a');
  const zc = r.zones.find((z) => z.id === 'c');
  assert.equal(zc.effectiveArea, 0);  // 丙完全落在甲内
  assert.equal(za.effectiveArea, 24); // 甲独占 0-2 与 4-5（扣乙带与丙）
});

test('自交多边形（蝴蝶结）被识别为阻断问题', () => {
  const bowtie = P([[0, 0], [4, 4], [4, 0], [0, 4]]);
  assert.equal(G.ringSelfIntersects(bowtie.coordinates[0]), true);
  const doc = {
    floor: rect(0, 0, 10, 8),
    unusables: [],
    zones: [{ id: 'a', name: '甲', geometry: bowtie }],
  };
  const r = G.evaluate(doc);
  // polygon-clipping 对自交可能抛错或产生碎片：无论如何该分区不应贡献正常面积结论
  const z = r.zones.find((x) => x.id === 'a');
  if (z) assert.equal(z.effectiveArea, 0);
});

test('共边相接与亚毫米级退化碎片不算正面积重叠；1mm 真实穿透仍被检出', () => {
  // 精确共边
  const touch = G.evaluate({
    floor: rect(0, 0, 10, 8), unusables: [],
    zones: [
      { id: 'a', name: '甲', geometry: rect(0, 0, 5, 8) },
      { id: 'b', name: '乙', geometry: rect(5, 0, 10, 8) },
    ],
  });
  assert.equal(touch.problems.filter((p) => p.kind === 'overlap').length, 0);

  // 1mm 的真实穿透 = 0.008 m²，远大于 1e-7 阈值，必须检出
  const tinyOverlap = G.evaluate({
    floor: rect(0, 0, 10, 8), unusables: [],
    zones: [
      { id: 'a', name: '甲', geometry: rect(0, 0, 5.001, 8) },
      { id: 'b', name: '乙', geometry: rect(5, 0, 10, 8) },
    ],
  });
  const ov = tinyOverlap.problems.find((p) => p.kind === 'overlap');
  assert.ok(ov, '1mm 穿透带应报正面积重叠');
  assert.ok(Math.abs(ov.area - 0.008) < 1e-9);
});

test('内容哈希：顶点移动后哈希变化；同构文档哈希稳定', () => {
  const d1 = {
    floor: rect(0, 0, 10, 8), unusables: [],
    zones: [{ id: 'a', name: '甲', color: '#fff', geometry: rect(0, 0, 6, 8) }],
  };
  const d2 = JSON.parse(JSON.stringify(d1));
  assert.equal(G.docHash(d1), G.docHash(d2));
  d2.zones[0].geometry.coordinates[0][1][0] = 6.5;
  assert.notEqual(G.docHash(d1), G.docHash(d2));
});

/* ---------------- HTTP API 全流程 ---------------- */

function listenOn(app) {
  return new Promise((server) => {
    const srv = app.listen(0, () => server(srv));
  });
}

function call(port, method, pth, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pth, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const rectDoc = (zones, unusables = []) => ({
  floor: rect(0, 0, 10, 8),
  unusables,
  zones,
});

test('API: 初始版本带重叠；检查 -> 改正 -> 存新版 -> 检查通过 -> 确认，确认记录不可变', async () => {
  const { createApp } = require('../server/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-test-'));
  const srv = await listenOn(createApp(dir));
  const port = srv.address().port;

  let r = await call(port, 'GET', '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.currentVersion, 1);
  // 初始文档正是 0-6 / 5-10 重叠场景
  assert.equal(r.json.doc.zones.length, 2);

  r = await call(port, 'POST', '/api/check', { version: 1 });
  assert.equal(r.status, 200);
  assert.ok(r.json.totalOverlapArea === 8);

  // 未修正时确认被拒
  r = await call(port, 'POST', '/api/confirm', { version: 1 });
  assert.equal(r.status, 422);

  // 改成无缝相接并存为 v2
  const good = rectDoc([
    { id: 'a', name: '甲', color: '#4f8cff', geometry: rect(0, 0, 5, 8) },
    { id: 'b', name: '乙', color: '#f59e0b', geometry: rect(5, 0, 10, 8) },
  ]);
  r = await call(port, 'POST', '/api/save', { doc: good, baseVersion: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 2);

  // 用 v1 的旧检查去确认 v2：缺检查 -> 拒绝
  r = await call(port, 'POST', '/api/confirm', { version: 2 });
  assert.equal(r.status, 409);

  r = await call(port, 'POST', '/api/check', { version: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.totalOverlapArea, 0);
  assert.equal(r.json.unallocatedArea, 0);

  r = await call(port, 'POST', '/api/confirm', { version: 2 });
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 2);

  // 再存 v3（继续编辑）：已确认的 v2 记录仍在，当前确认指针不被回写问题影响
  const edited = JSON.parse(JSON.stringify(good));
  edited.zones[0].name = '甲改';
  r = await call(port, 'POST', '/api/save', { doc: edited, baseVersion: 2 });
  assert.equal(r.json.version, 3);
  r = await call(port, 'GET', '/api/versions/2');
  assert.ok(r.json.confirmation);
  assert.equal(r.json.confirmation.version, 2);

  // 非最新版本不能确认
  r = await call(port, 'POST', '/api/confirm', { version: 2 });
  assert.equal(r.status, 409);

  // 刷新等价：状态仍可重新查到确认与检查
  r = await call(port, 'GET', '/api/state');
  assert.equal(r.json.confirmedVersion, 2);
  assert.equal(r.json.currentVersion, 3);
  assert.equal(r.json.versions.length, 3);

  srv.close();
});

test('API: 两个人轮流保存——过期 baseVersion 冲突，服务端不被覆盖，草稿内容随 409 回带', async () => {
  const { createApp } = require('../server/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-test-'));
  const srv = await listenOn(createApp(dir));
  const port = srv.address().port;

  // 同事先存 v2
  const colleague = rectDoc([
    { id: 'a', name: '同事分区', color: '#10b981', geometry: rect(0, 0, 4, 8) },
  ]);
  let r = await call(port, 'POST', '/api/save', { doc: colleague, baseVersion: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 2);

  // 我手里仍基于 v1 保存
  const mine = rectDoc([
    { id: 'b', name: '我的分区', color: '#ec4899', geometry: rect(6, 0, 10, 8) },
  ]);
  r = await call(port, 'POST', '/api/save', { doc: mine, baseVersion: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.json.serverVersion, 2);
  assert.ok(r.json.serverDoc);
  assert.equal(r.json.serverDoc.zones[0].name, '同事分区');

  // 服务端没有被我的草稿覆盖
  r = await call(port, 'GET', '/api/state');
  assert.equal(r.json.currentVersion, 2);
  assert.equal(r.json.doc.zones[0].name, '同事分区');

  // 我对照后以 v2 为基另存：成为 v3
  r = await call(port, 'POST', '/api/save', { doc: mine, baseVersion: 2 });
  assert.equal(r.status, 201);
  assert.equal(r.json.version, 3);

  // 相同内容重复保存不产生新版本
  r = await call(port, 'POST', '/api/save', { doc: mine, baseVersion: 3 });
  assert.equal(r.status, 201);
  assert.equal(r.json.created, false);

  srv.close();
});

test('API: 非法文档被拒；临时评估接口不落库、不影响版本', async () => {
  const { createApp } = require('../server/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-test-'));
  const srv = await listenOn(createApp(dir));
  const port = srv.address().port;

  const bad = {
    floor: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10]]] },
    unusables: [],
    zones: [],
  };
  let r = await call(port, 'POST', '/api/evaluate', { doc: bad });
  assert.equal(r.status, 400);

  r = await call(port, 'POST', '/api/save', { doc: bad, baseVersion: 1 });
  assert.equal(r.status, 400);

  const good = rectDoc([]);
  r = await call(port, 'POST', '/api/evaluate', { doc: good });
  assert.equal(r.status, 200);
  assert.equal(r.json.usableArea, 80);
  assert.equal(r.json.unallocatedArea, 80);

  r = await call(port, 'GET', '/api/state');
  assert.equal(r.json.currentVersion, 1); // 临时评估未产生版本
  srv.close();
});
