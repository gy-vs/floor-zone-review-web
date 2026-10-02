// 本地 HTTP 服务：静态工作台页面 + 保存/检查/确认 API。
// 几何判定只在服务端独立完成（runCheck 调用共享内核），前端预览不能充当交付依据。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, planHash } from './store.js';
import { validatePlan } from '../shared/geometry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const ROOT_DIR = join(__dirname, '..');
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 });
  }
}

export function createApp(store = new Store()) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    try {
      if (path === '/api/state' && req.method === 'GET') {
        return sendJSON(res, 200, store.snapshot());
      }

      if (path === '/api/save' && req.method === 'POST') {
        const body = await readBody(req);
        const plan = body.plan;
        if (!plan) return sendJSON(res, 400, { error: '缺少 plan' });
        try {
          validatePlan(plan);
        } catch (err) {
          return sendJSON(res, 400, { error: err.message });
        }
        const result = store.save({ plan, baseRev: body.baseRev, savedBy: body.savedBy });
        if (!result.ok) {
          return sendJSON(res, result.status, {
            error: { code: result.code, message: '服务端已有更新版本，保存被拒绝；您的草稿保留在本地用于对照', server: result.head },
          });
        }
        const asyncMode = body.check !== 'sync';
        if (asyncMode) {
          // 后台运行检查，保存响应立即返回 pending；前端通过 GET /api/check 轮询。
          setImmediate(() => store.runCheck(result.revision.rev, {}));
          return sendJSON(res, 200, { saved: result.saved, revision: result.revision, check: { rev: result.revision.rev, status: 'pending' } });
        }
        const done = store.runCheck(result.revision.rev, {});
        return sendJSON(res, 200, { saved: result.saved, revision: result.revision, check: done.check });
      }

      if (path === '/api/check' && req.method === 'POST') {
        const body = await readBody(req);
        const result = store.runCheck(body.rev, { force: body.force === true });
        if (!result.ok) return sendJSON(res, result.status, { error: { code: result.code, message: '版本不存在' } });
        return sendJSON(res, 200, { check: result.check });
      }

      if (path === '/api/check' && req.method === 'GET') {
        const result = store.getCheck(url.searchParams.get('rev'));
        if (!result.ok) return sendJSON(res, result.status, { error: { code: result.code, message: '版本不存在' } });
        return sendJSON(res, 200, { check: result.check });
      }

      if (path === '/api/revision' && req.method === 'GET') {
        const record = store.getRevision(url.searchParams.get('rev'));
        if (!record) return sendJSON(res, 404, { error: { code: 'rev_not_found', message: '版本不存在' } });
        const check = store.getCheck(store.publicRevision(record).rev).check;
        return sendJSON(res, 200, { revision: store.publicRevision(record), check });
      }

      if (path === '/api/confirm' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.rev) return sendJSON(res, 400, { error: '缺少 rev' });
        // 确认前强制重新判定一次该确切版本，杜绝把旧结论挪用到新版本。
        const checked = store.runCheck(body.rev, { force: true });
        if (!checked.ok) return sendJSON(res, 404, { error: { code: checked.code, message: '版本不存在' } });
        const result = store.confirm({ fullRev: body.rev, confirmedBy: body.confirmedBy });
        if (!result.ok) return sendJSON(res, result.status, { error: { code: result.code, message: result.message } });
        return sendJSON(res, 200, { confirmation: result.confirmation, check: checked.check });
      }

      if (path.startsWith('/api/')) {
        return sendJSON(res, 404, { error: '未知接口' });
      }

      // 静态资源。
      const rel = path === '/' ? 'index.html' : path.slice(1);
      if (rel.startsWith('vendor/')) {
        // 第三方 ESM 构建（含 polygon-clipping 的两个传递依赖）。
        const NM = join(ROOT_DIR, 'node_modules');
        const vendorMap = {
          'vendor/polygon-clipping.esm.js': join(NM, 'polygon-clipping/dist/polygon-clipping.esm.js'),
          'vendor/splaytree.js': join(NM, 'splaytree/dist/splaytree.js'),
          'vendor/robust-predicates/orient2d.js': join(NM, 'robust-predicates/esm/orient2d.js'),
          'vendor/robust-predicates/util.js': join(NM, 'robust-predicates/esm/util.js'),
        };
        const vfile = vendorMap[rel];
        if (!vfile) return sendJSON(res, 404, { error: '未知 vendor 资源' });
        const data = await readFile(vfile);
        res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'public, max-age=3600' });
        return res.end(data);
      }
      if (rel.startsWith('shared/')) {
        const sfile = normalize(join(ROOT_DIR, rel));
        if (!sfile.startsWith(join(ROOT_DIR, 'shared'))) return sendJSON(res, 403, { error: 'forbidden' });
        const sdata = await readFile(sfile);
        res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
        return res.end(sdata);
      }
      const filePath = normalize(join(PUBLIC_DIR, rel));
      if (!filePath.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
      } catch {
        // 非资源路径回退到应用入口（便于直接打开任意路由）。
        const index = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(index);
      }
    } catch (err) {
      sendJSON(res, err.statusCode || 500, { error: err.message || '服务器错误' });
    }
  });
}

// 供测试引用，确保导出与实现一致。
export { planHash };

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createApp();
  server.listen(PORT, () => {
    console.log(`分区审阅工作台: http://localhost:${PORT}`);
  });
}
