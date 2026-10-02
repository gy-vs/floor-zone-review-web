'use strict';
// 本地分区审阅服务：静态前端 + JSON API。
// 几何判定只在服务端进行；浏览器负责编辑、渲染与呈现服务端结论。
const path = require('path');
const express = require('express');
const { Store } = require('./store');
const { validateDoc } = require('./validation');
const { evaluate, docHash } = require('./geometry');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function createApp(dataDir = DATA_DIR) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // 允许测试注入独立 store
  const store = app.locals.store = new Store(dataDir);

  app.get('/api/state', (req, res) => {
    res.json(store.getState());
  });

  app.get('/api/versions/:version', (req, res) => {
    const v = store.getVersion(Number(req.params.version));
    if (!v) return res.status(404).json({ error: '版本不存在' });
    res.json(v);
  });

  // 保存草稿（乐观并发）。冲突时 409，并回带服务端版本；服务端不会修改任何数据。
  app.post('/api/save', (req, res) => {
    const { doc, baseVersion } = req.body || {};
    if (!Number.isInteger(baseVersion)) {
      return res.status(400).json({ error: '缺少 baseVersion' });
    }
    const errors = validateDoc(doc);
    if (errors.length) return res.status(400).json({ error: '文档结构无效', details: errors });
    try {
      const result = store.save(doc, baseVersion);
      res.status(201).json(result);
    } catch (e) {
      if (e.code === 'CONFLICT') {
        return res.status(409).json({
          error: e.message,
          serverVersion: e.serverVersion,
          serverDoc: e.serverDoc,
        });
      }
      throw e;
    }
  });

  // 编辑中的临时判定：不落库、不产生版本，仅返回几何结论，供前端实时呈现。
  // 任何“已确认/已保存”结论都不会引用这里的结果。
  app.post('/api/evaluate', (req, res) => {
    const { doc } = req.body || {};
    const errors = validateDoc(doc);
    if (errors.length) return res.status(400).json({ error: '文档结构无效', details: errors });
    try {
      res.json({ ...evaluate(doc), checkedAt: new Date().toISOString(), version: null });
    } catch (e) {
      res.status(422).json({ error: e.message });
    }
  });

  // 对某个已保存版本执行几何检查（独立判定，结果按内容哈希缓存）。
  app.post('/api/check', (req, res) => {    const version = req.body && Number(req.body.version);
    if (!Number.isInteger(version)) return res.status(400).json({ error: '缺少 version' });
    try {
      const check = store.runCheck(version);
      res.json(check);
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
      throw e;
    }
  });

  // 确认交付最新版本（检查必须新鲜通过）。确认记录不可变。
  app.post('/api/confirm', (req, res) => {
    const version = req.body && Number(req.body.version);
    if (!Number.isInteger(version)) return res.status(400).json({ error: '缺少 version' });
    try {
      const record = store.confirm(version);
      res.status(201).json(record);
    } catch (e) {
      const status = {
        STALE_VERSION: 409,
        CHECK_MISSING: 409,
        BLOCKING_PROBLEMS: 422,
      }[e.code] || 500;
      return res.status(status).json({
        error: e.message,
        code: e.code,
        problems: e.problems || undefined,
      });
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`分区审阅工作台: http://localhost:${PORT}`);
    console.log(`数据文件: ${DATA_DIR}/state.json`);
  });
}

module.exports = { createApp };
