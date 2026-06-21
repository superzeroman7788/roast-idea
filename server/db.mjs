// SQLite 落库层 —— 唯一会复利的资产(护城河数据集)。
// 用 Node 内置 node:sqlite(零依赖)。DB 文件本地存放、已被 .gitignore 排除。
// 隐私(P7):brief 为原始点子,默认本地落库;ROAST_PERSIST_BRIEF=0 可关闭存正文。
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_PATH =
  process.env.ROAST_DB_PATH ||
  path.join(process.env.ROAST_DATA_DIR || path.join(process.cwd(), "data"), "roast.db");

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_record (
      id            TEXT PRIMARY KEY,
      mode          TEXT NOT NULL,
      brief         TEXT,                 -- 可被 redacted(P7)
      evidence_pack TEXT,                 -- JSON: EvidencePack
      seats         TEXT NOT NULL,        -- JSON: CouncilSeat[]
      verdict       TEXT NOT NULL,        -- JSON: Verdict
      created_at    TEXT NOT NULL,        -- ISO
      outcome       TEXT                  -- JSON;未来回填"后来成没成"
    );
    CREATE TABLE IF NOT EXISTS evidence_cache (
      query     TEXT PRIMARY KEY,         -- 归一化检索词
      pack      TEXT NOT NULL,            -- JSON: EvidencePack(降成本降延迟)
      cached_at TEXT NOT NULL             -- ISO
    );
    -- 讨论式陪练(讨论重构):一场讨论 + 多方轮流发言
    CREATE TABLE IF NOT EXISTS discussions (
      id            TEXT PRIMARY KEY,
      mode          TEXT NOT NULL,            -- idea | copy
      title         TEXT NOT NULL,
      brief         TEXT,                     -- 原始点子/文案(P7 可 redact)
      status        TEXT NOT NULL DEFAULT 'open',  -- open | finalized
      conclusion    TEXT NOT NULL DEFAULT '', -- finalize 产出的方案(markdown)
      evidence_pack TEXT,                     -- JSON: 信息板快照(整场复用)
      roles         TEXT,                     -- JSON: 角色→provider 固定映射(host 跨轮稳定)
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discussion_turns (
      id            TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL,
      seq           INTEGER NOT NULL,         -- 全场顺序
      round         INTEGER NOT NULL DEFAULT 0,
      speaker       TEXT NOT NULL,            -- provider label | 'you' | 'system'
      role          TEXT NOT NULL DEFAULT '', -- host/builder/devils-advocate/...
      body          TEXT NOT NULL,
      citations     TEXT NOT NULL DEFAULT '[]', -- JSON: [{evidenceId, valid}]
      latency_ms    INTEGER,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_discussion ON discussion_turns(discussion_id, seq);
  `);
  return db;
}

// 落库一条 RunRecord(契约见 PRD §4)。失败抛出由调用方兜底,绝不静默伪装成功。
export function saveRunRecord(record) {
  const database = getDb();
  const persistBrief = process.env.ROAST_PERSIST_BRIEF !== "0";
  const stmt = database.prepare(`
    INSERT INTO run_record (id, mode, brief, evidence_pack, seats, verdict, created_at, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.mode,
    persistBrief ? record.brief : null,
    record.evidencePack ? JSON.stringify(record.evidencePack) : null,
    JSON.stringify(record.seats ?? []),
    JSON.stringify(record.verdict ?? {}),
    record.createdAt,
    record.outcome ? JSON.stringify(record.outcome) : null,
  );
  return record.id;
}

export function listRunRecords(limit = 50) {
  const database = getDb();
  const rows = database
    .prepare(`SELECT * FROM run_record ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
  return rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    brief: row.brief,
    evidencePack: row.evidence_pack ? JSON.parse(row.evidence_pack) : null,
    seats: JSON.parse(row.seats),
    verdict: JSON.parse(row.verdict),
    createdAt: row.created_at,
    outcome: row.outcome ? JSON.parse(row.outcome) : undefined,
  }));
}

export function countRunRecords() {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM run_record`).get().n;
}

// 证据缓存:同一检索词 24h 内复用,降成本降延迟(P2)。
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function getCachedPack(query, nowMs) {
  const row = getDb()
    .prepare(`SELECT pack, cached_at FROM evidence_cache WHERE query = ?`)
    .get(query);
  if (!row) return null;
  if (nowMs - Date.parse(row.cached_at) > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.pack);
  } catch {
    return null;
  }
}

export function setCachedPack(query, pack, nowIso) {
  getDb()
    .prepare(
      `INSERT INTO evidence_cache (query, pack, cached_at) VALUES (?, ?, ?)
       ON CONFLICT(query) DO UPDATE SET pack = excluded.pack, cached_at = excluded.cached_at`,
    )
    .run(query, JSON.stringify(pack), nowIso);
}

// ---- 讨论式陪练(讨论重构)----
const persistBrief = () => process.env.ROAST_PERSIST_BRIEF !== "0";

export function createDiscussion({ mode, title, brief, evidencePack, roles }) {
  const database = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO discussions (id, mode, title, brief, status, conclusion, evidence_pack, roles, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', '', ?, ?, ?, ?)`,
    )
    .run(
      id,
      mode,
      title,
      persistBrief() ? brief : null,
      evidencePack ? JSON.stringify(evidencePack) : null,
      roles ? JSON.stringify(roles) : null,
      now,
      now,
    );
  return id;
}

// 追加一条发言(seq 自增,更新讨论 updated_at)。失败不静默伪装。
export function addTurn({ discussionId, round, speaker, role, body, citations, latencyMs }) {
  const database = getDb();
  const exists = database.prepare(`SELECT 1 FROM discussions WHERE id = ?`).get(discussionId);
  if (!exists) throw new Error(`discussion ${discussionId} not found`);
  const id = randomUUID();
  const now = new Date().toISOString();
  const seq =
    (database.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM discussion_turns WHERE discussion_id = ?`).get(discussionId)?.m || 0) + 1;
  database
    .prepare(
      `INSERT INTO discussion_turns (id, discussion_id, seq, round, speaker, role, body, citations, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      discussionId,
      seq,
      round ?? 0,
      speaker,
      role || "",
      body,
      JSON.stringify(citations || []),
      latencyMs ?? null,
      now,
    );
  database.prepare(`UPDATE discussions SET updated_at = ? WHERE id = ?`).run(now, discussionId);
  return { id, seq, createdAt: now };
}

export function getDiscussion(id) {
  const database = getDb();
  const d = database.prepare(`SELECT * FROM discussions WHERE id = ?`).get(id);
  if (!d) return null;
  const turns = database
    .prepare(`SELECT * FROM discussion_turns WHERE discussion_id = ? ORDER BY seq ASC`)
    .all(id);
  return {
    id: d.id,
    mode: d.mode,
    title: d.title,
    brief: d.brief,
    status: d.status,
    conclusion: d.conclusion,
    evidencePack: d.evidence_pack ? JSON.parse(d.evidence_pack) : null,
    roles: d.roles ? JSON.parse(d.roles) : null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    turns: turns.map((t) => ({
      id: t.id,
      seq: t.seq,
      round: t.round,
      speaker: t.speaker,
      role: t.role,
      body: t.body,
      citations: JSON.parse(t.citations || "[]"),
      latencyMs: t.latency_ms,
      createdAt: t.created_at,
    })),
  };
}

export function finalizeDiscussion(id, conclusion) {
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE discussions SET status = 'finalized', conclusion = ?, updated_at = ? WHERE id = ?`)
    .run(conclusion, now, id);
  return now;
}

export function listDiscussions(limit = 50) {
  return getDb()
    .prepare(`SELECT id, mode, title, status, created_at, updated_at FROM discussions ORDER BY updated_at DESC LIMIT ?`)
    .all(limit);
}
