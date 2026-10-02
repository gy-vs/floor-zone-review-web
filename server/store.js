'use strict';
// JSON 文件持久化：保存版本链、按内容哈希缓存的检查结果、不可变的确认记录。
// 不使用外部数据库。单进程同步写，保证测试与本地运行的一致性。
const fs = require('fs');
const path = require('path');
const { evaluate, docHash } = require('./geometry');

const DEFAULT_DOC = {
  floor: {
    type: 'Polygon',
    coordinates: [[[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]],
  },
  unusables: [
    // 初始留空，便于用 10×8 矩形核对重叠；后续可在界面内添加柱体/设备间。
  ],
  zones: [
    {
      id: 'z-a', name: '区域甲', color: '#4f8cff',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [6, 0], [6, 8], [0, 8], [0, 0]]] },
    },
    {
      id: 'z-b', name: '区域乙', color: '#f59e0b',
      geometry: { type: 'Polygon', coordinates: [[[5, 0], [10, 0], [10, 8], [5, 8], [5, 0]]] },
    },
  ],
};

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.state = {
        version: 1,
        doc: DEFAULT_DOC,
        contentHash: docHash(DEFAULT_DOC),
        updatedAt: new Date().toISOString(),
        versions: [
          {
            version: 1,
            doc: DEFAULT_DOC,
            contentHash: docHash(DEFAULT_DOC),
            createdAt: new Date().toISOString(),
          },
        ],
        checks: {}, // contentHash -> 检查结果（同一内容只判定一次）
        confirmedVersion: null,
        confirmations: [],
      };
      this.persist();
    }
  }

  persist() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  getState() {
    const check = this.state.checks[this.state.contentHash] || null;
    const confirmed = this.state.confirmedVersion
      ? this.state.confirmations.find((c) => c.version === this.state.confirmedVersion) || null
      : null;
    return {
      currentVersion: this.state.version,
      contentHash: this.state.contentHash,
      doc: this.state.doc,
      updatedAt: this.state.updatedAt,
      currentCheck: check,
      confirmedVersion: this.state.confirmedVersion,
      confirmation: confirmed,
      versions: this.state.versions.map((v) => ({
        version: v.version,
        contentHash: v.contentHash,
        createdAt: v.createdAt,
        zoneNames: (v.doc.zones || []).map((z) => z.name),
        unusableCount: (v.doc.unusables || []).length,
        check: this.state.checks[v.contentHash]
          ? summarizeCheck(this.state.checks[v.contentHash])
          : null,
      })),
    };
  }

  getVersion(version) {
    const v = this.state.versions.find((x) => x.version === version);
    if (!v) return null;
    return {
      version: v.version,
      contentHash: v.contentHash,
      createdAt: v.createdAt,
      doc: v.doc,
      check: this.state.checks[v.contentHash] || null,
      confirmation: this.state.confirmations.find((c) => c.version === v.version) || null,
    };
  }

  // 保存草稿。baseVersion 过期且内容确已变化时抛 CONFLICT，调用方原样保留草稿。
  save(doc, baseVersion) {
    const h = docHash(doc);
    if (baseVersion !== this.state.version) {
      // 即使内容相同也告知客户端版本已前进，由其决定是否采纳服务端。
      if (h !== this.state.contentHash || baseVersion !== this.state.version) {
        const err = new Error('版本冲突：服务端已存在更新的保存版本');
        err.code = 'CONFLICT';
        err.serverVersion = this.state.version;
        err.serverDoc = this.state.doc;
        throw err;
      }
    }
    if (h === this.state.contentHash) {
      return {
        version: this.state.version,
        contentHash: h,
        created: false,
        check: this.state.checks[h] || null,
      };
    }
    const nextVersion = this.state.version + 1;
    const record = {
      version: nextVersion,
      doc,
      contentHash: h,
      createdAt: new Date().toISOString(),
      basedOn: baseVersion,
    };
    this.state.versions.push(record);
    this.state.version = nextVersion;
    this.state.doc = doc;
    this.state.contentHash = h;
    this.state.updatedAt = record.createdAt;
    this.persist();
    return { version: nextVersion, contentHash: h, created: true, check: null };
  }

  // 运行/取回检查。检查只与内容哈希绑定；保存版本后内容相同则结论可复用。
  runCheck(version) {
    const v = this.state.versions.find((x) => x.version === version);
    if (!v) {
      const err = new Error('版本不存在');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const h = v.contentHash;
    if (!this.state.checks[h]) {
      this.state.checks[h] = {
        ...evaluate(v.doc),
        checkedAt: new Date().toISOString(),
        version,
      };
      this.persist();
    }
    return this.state.checks[h];
  }

  // 确认交付：必须是最新版本，且该版本的检查新鲜（哈希匹配）、无阻断问题。
  confirm(version) {
    if (version !== this.state.version) {
      const err = new Error('只能确认当前最新的保存版本');
      err.code = 'STALE_VERSION';
      throw err;
    }
    const v = this.state.versions.find((x) => x.version === version);
    const check = this.state.checks[v.contentHash];
    if (!check || check.contentHash !== v.contentHash) {
      const err = new Error('该版本尚未完成检查，不能凭旧结论确认');
      err.code = 'CHECK_MISSING';
      throw err;
    }
    const blocking = check.problems.filter((p) => p.severity === 'blocking');
    if (blocking.length > 0) {
      const err = new Error('仍存在阻断问题（出界/压不可用/重叠/无效几何），不能确认');
      err.code = 'BLOCKING_PROBLEMS';
      err.problems = blocking;
      throw err;
    }
    const record = {
      version,
      contentHash: v.contentHash,
      confirmedAt: new Date().toISOString(),
      summary: summarizeCheck(check),
    };
    this.state.confirmations.push(record);
    this.state.confirmedVersion = version;
    this.persist();
    return record;
  }
}

function summarizeCheck(check) {
  return {
    contentHash: check.contentHash,
    checkedAt: check.checkedAt,
    status: check.status,
    usableArea: check.usableArea,
    allocatedArea: check.allocatedArea,
    unallocatedArea: check.unallocatedArea,
    effectiveAreaSum: check.effectiveAreaSum,
    blockingCount: check.problems.filter((p) => p.severity === 'blocking').length,
    infoCount: check.problems.filter((p) => p.severity === 'info').length,
  };
}

module.exports = { Store, DEFAULT_DOC, summarizeCheck };
