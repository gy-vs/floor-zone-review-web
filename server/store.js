// 服务端持久化：无外部数据库，状态保存在 server/data/state.json。
// 草稿版本（revisions）、确认记录（confirmation）、检查记录（checks）分开保存，
// 已确认版本永远指向某个确切 rev，继续编辑只会产生新 rev，不回写旧结果。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { analyze, stableStringify, clone } from '../shared/geometry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FZR_DATA_DIR || join(__dirname, 'data');
const DATA_FILE = join(DATA_DIR, 'state.json');

export const DEFAULT_PLAN = {
  floor: { name: '一层', polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] },
  unusable: [],
  zones: [],
};

function initialState() {
  const seed = {
    rev: 1,
    plan: DEFAULT_PLAN,
    savedBy: 'seed',
    savedAt: new Date(0).toISOString(),
    hash: planHash(DEFAULT_PLAN),
  };
  // 初始空楼层立即给出独立判定：整层可用、全部为未分配空缺（非阻断）。
  const report = analyze(DEFAULT_PLAN);
  return {
    revisions: [seed],
    headRev: 1,
    confirmation: null, // { rev, confirmedBy, confirmedAt }
    checks: {
      1: { status: 'done', startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), report: serializeReport(report) },
    },
    saveSeq: 1,
  };
}

export function planHash(plan) {
  return createHash('sha256').update(stableStringify(plan)).digest('hex').slice(0, 16);
}

export function revId(seq, plan) {
  return `${seq}-${planHash(plan)}`;
}

export class Store {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.state = this.#load();
  }

  #load() {
    if (existsSync(this.file)) {
      try {
        return JSON.parse(readFileSync(this.file, 'utf8'));
      } catch {
        // 损坏的状态文件不应静默吞掉，备份后重建。
        writeFileSync(`${this.file}.corrupt-${Date.now()}`, readFileSync(this.file));
      }
    }
    const s = initialState();
    this.#persist(s);
    return s;
  }

  #persist(state = this.state) {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    writeFileSync(this.file, readFileSync(tmp));
  }

  get head() {
    return this.state.revisions.find((r) => r.rev === this.state.headRev);
  }
  getRevision(rev) {
    return this.state.revisions.find((r) => revId(r.rev, r.plan) === rev) || null;
  }
  get confirmation() {
    return this.state.confirmation;
  }

  /** 乐观锁保存：baseRev 必须等于当前 head，否则返回 conflict 且不修改服务端。 */
  save({ plan, baseRev, savedBy }) {
    const head = this.head;
    const headFullRev = revId(head.rev, head.plan);
    if (baseRev !== headFullRev) {
      return { ok: false, status: 409, code: 'rev_conflict', head: this.#publicRevision(head) };
    }
    // 内容与当前版本一致：幂等返回，不制造新版本。
    const hash = planHash(plan);
    if (hash === planHash(head.plan)) {
      return { ok: true, saved: false, revision: this.#publicRevision(head) };
    }
    this.state.saveSeq += 1;
    const record = {
      rev: this.state.saveSeq,
      plan,
      savedBy: String(savedBy || 'anonymous'),
      savedAt: new Date().toISOString(),
      hash,
    };
    this.state.revisions.push(record);
    this.state.headRev = record.rev;
    this.#persist();
    return { ok: true, saved: true, revision: this.#publicRevision(record) };
  }

  /** 为某个确切 rev 运行独立几何判定（幂等：已完成则直接返回）。 */
  runCheck(fullRev, { force = false } = {}) {
    const record = this.getRevision(fullRev);
    if (!record) return { ok: false, status: 404, code: 'rev_not_found' };
    const existing = this.state.checks[record.rev];
    if (existing && existing.status === 'done' && !force) {
      return { ok: true, check: this.#publicCheck(record, existing) };
    }
    let check;
    try {
      const report = analyze(record.plan);
      check = {
        status: 'done',
        startedAt: existing?.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        report: serializeReport(report),
      };
    } catch (err) {
      check = { status: 'done', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: err.message };
    }
    this.state.checks[record.rev] = check;
    this.#persist();
    return { ok: true, check: this.#publicCheck(record, check) };
  }

  getCheck(fullRev) {
    const record = this.getRevision(fullRev);
    if (!record) return { ok: false, status: 404, code: 'rev_not_found' };
    const check = this.state.checks[record.rev];
    if (!check) return { ok: true, check: null };
    return { ok: true, check: this.#publicCheck(record, check) };
  }

  /** 确认交付：只允许基于“该确切版本、已完成且无阻断问题”的检查。 */
  confirm({ fullRev, confirmedBy }) {
    const record = this.getRevision(fullRev);
    if (!record) return { ok: false, status: 404, code: 'rev_not_found', message: '该版本不存在' };
    const check = this.state.checks[record.rev];
    if (!check || check.status !== 'done') {
      return { ok: false, status: 409, code: 'check_pending', message: '该版本的检查尚未完成，不能确认交付' };
    }
    if (check.error || !check.report || !check.report.valid) {
      return { ok: false, status: 409, code: 'check_failed', message: '该版本存在重叠、越界或压占不可用区域，不能确认交付' };
    }
    this.state.confirmation = { rev: fullRev, seq: record.rev, confirmedBy: String(confirmedBy || 'anonymous'), confirmedAt: new Date().toISOString() };
    this.#persist();
    return { ok: true, confirmation: this.state.confirmation };
  }

  snapshot() {
    const head = this.head;
    return {
      head: this.#publicRevision(head),
      confirmation: this.state.confirmation ? { ...this.state.confirmation } : null,
      headCheck: this.getCheck(revId(head.rev, head.plan)).check,
    };
  }

  publicRevision(record) {
    return this.#publicRevision(record);
  }

  #publicRevision(record) {
    return {
      rev: revId(record.rev, record.plan),
      seq: record.rev,
      savedBy: record.savedBy,
      savedAt: record.savedAt,
      plan: clone(record.plan),
    };
  }

  #publicCheck(record, check) {
    return { rev: revId(record.rev, record.plan), ...clone(check) };
  }
}

// 报告中的几何（MultiPolygon）需要随检查结果持久化/下发，供前端直接画问题区域。
export function serializeReport(report) {
  return JSON.parse(JSON.stringify(report));
}
