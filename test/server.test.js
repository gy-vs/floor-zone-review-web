import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fzr-test-'));
process.env.FZR_DATA_DIR = dir;
// 全部动态导入：确保数据目录环境变量在服务端模块加载前生效。
const { createApp } = await import('../server/index.js');
const { Store, DEFAULT_PLAN, planHash } = await import('../server/store.js');

const store = new Store();
const server = createApp(store);
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

after(() => server.close());

const FLOOR = [[0, 0], [10, 0], [10, 8], [0, 8]];
const overlapPlan = () => ({
  floor: { name: 'F', polygon: FLOOR },
  unusable: [],
  zones: [
    { id: 'a', name: 'A', polygon: [[0, 0], [6, 0], [6, 8], [0, 8]] },
    { id: 'b', name: 'B', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
  ],
});
const touchPlan = () => ({
  floor: { name: 'F', polygon: FLOOR },
  unusable: [],
  zones: [
    { id: 'a', name: 'A', polygon: [[0, 0], [5, 0], [5, 8], [0, 8]] },
    { id: 'b', name: 'B', polygon: [[5, 0], [10, 0], [10, 8], [5, 8]] },
  ],
});

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}
async function post(path, payload) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollDone(rev) {
  for (let i = 0; i < 30; i++) {
    await wait(100);
    const c = (await get(`/api/check?rev=${encodeURIComponent(rev)}`)).body.check;
    if (c && c.status === 'done') return c;
  }
  throw new Error('检查在限定时间内未完成');
}

// 整个服务端流程是一个顺序测试：各步骤共享同一服务端状态并按时间演进。
test('服务端版本、检查、确认端到端流程', async () => {
  const rev1 = `${1}-${planHash(DEFAULT_PLAN)}`;

  // 1) 初始状态。
  {
    const { status, body } = await get('/api/state');
    assert.equal(status, 200);
    assert.deepEqual(body.head.plan, DEFAULT_PLAN);
    assert.equal(body.head.rev, rev1);
    assert.equal(body.confirmation, null);
  }

  // 2) 保存重叠计划：新版本 + 后台检查 pending → done 且未通过，确认被拒。
  let rev2;
  {
    const saved = await post('/api/save', { plan: overlapPlan(), baseRev: rev1, savedBy: '甲' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.saved, true);
    assert.equal(saved.body.check.status, 'pending');
    rev2 = saved.body.revision.rev;
    assert.notEqual(rev2, rev1);

    const check = await pollDone(rev2);
    assert.equal(check.report.valid, false);
    assert.ok(check.report.issues.some((i) => i.kind === 'overlap' && Math.abs(i.area - 8) < 1e-9));

    const cf = await post('/api/confirm', { rev: rev2, confirmedBy: '甲' });
    assert.equal(cf.status, 409);
    assert.equal(cf.body.error.code, 'check_failed');
  }

  // 3) 乐观锁：过期基线保存冲突，服务端不变。
  {
    const conflict = await post('/api/save', { plan: touchPlan(), baseRev: rev1, savedBy: '乙' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'rev_conflict');
    assert.equal(conflict.body.error.server.rev, rev2);
    const again = await get('/api/state');
    assert.equal(again.body.head.rev, rev2);
  }

  // 4) 相接计划保存 → 检查通过 → 确认；之后新草稿保存不影响已确认版本。
  let rev3;
  {
    const saved = await post('/api/save', { plan: touchPlan(), baseRev: rev2, savedBy: '乙' });
    assert.equal(saved.status, 200);
    rev3 = saved.body.revision.rev;
    const check = await pollDone(rev3);
    assert.equal(check.report.valid, true);

    const cf = await post('/api/confirm', { rev: rev3, confirmedBy: '乙' });
    assert.equal(cf.status, 200);
    assert.equal(cf.body.confirmation.rev, rev3);

    const saved4 = await post('/api/save', { plan: overlapPlan(), baseRev: rev3, savedBy: '甲' });
    assert.equal(saved4.status, 200);
    const snap = await get('/api/state');
    assert.equal(snap.body.head.rev, saved4.body.revision.rev);
    assert.equal(snap.body.confirmation.rev, rev3);
    assert.notEqual(snap.body.confirmation.rev, snap.body.head.rev);

    const old = await get(`/api/revision?rev=${encodeURIComponent(rev3)}`);
    assert.equal(old.status, 200);
    assert.equal(old.body.revision.rev, rev3);
    assert.equal(old.body.check.report.valid, true);
  }

  // 5) 未知 rev / 当前 head 检查未通过 → 确认被拒；旧结论不能挪用到新版本。
  {
    const snap = await get('/api/state');
    const headRev = snap.body.head.rev;
    const miss = await post('/api/confirm', { rev: '999-deadbeefdeadbeef' });
    assert.equal(miss.status, 404);
    await pollDone(headRev);
    const cf = await post('/api/confirm', { rev: headRev });
    assert.equal(cf.status, 409);
    assert.equal(cf.body.error.code, 'check_failed');
  }

  // 6) 几何无效的计划 400，服务端独立校验且不产生版本。
  {
    const snap = await get('/api/state');
    const bad = { floor: { polygon: [[0, 0], [10, 0]] }, unusable: [], zones: [] };
    const r = await post('/api/save', { plan: bad, baseRev: snap.body.head.rev });
    assert.equal(r.status, 400);
    assert.ok(/至少需要 3 个顶点/.test(r.body.error));
    const after = await get('/api/state');
    assert.equal(after.body.head.rev, snap.body.head.rev);
  }

  // 7) 幂等保存。
  {
    const snap = await get('/api/state');
    const r = await post('/api/save', { plan: snap.body.head.plan, baseRev: snap.body.head.rev, savedBy: '甲' });
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, false);
    assert.equal(r.body.revision.rev, snap.body.head.rev);
  }

  // 8) 刷新后状态仍可查（模拟重新打开页面）。
  {
    const snap = await get('/api/state');
    assert.ok(snap.body.head.rev.startsWith('4-'));
    assert.equal(snap.body.confirmation.rev, rev3);
    assert.equal(snap.body.headCheck.rev, snap.body.head.rev);
    assert.equal(snap.body.headCheck.report.valid, false);
  }
});

test('rev = 序号 + 内容哈希：键序不同但几何相同则 rev 相同', () => {
  const p1 = { floor: { polygon: FLOOR }, unusable: [], zones: [] };
  const p2 = { zones: [], unusable: [], floor: { polygon: FLOOR } };
  assert.equal(planHash(p1), planHash(p2));
});

test('Store 直接接口：未完成检查时确认被拒（不允许 pending 作为通过证明）', async () => {
  const { Store: S2 } = await import('../server/store.js');
  const file2 = join(dir, 'state2.json');
  const s2 = new S2(file2);
  const head = s2.head;
  const full = `${head.rev}-${planHash(head.plan)}`;
  delete s2.state.checks[head.rev]; // 模拟检查尚未开始
  const res = s2.confirm({ fullRev: full });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'check_pending');
});
