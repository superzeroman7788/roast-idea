// SQLite 落库层 —— 唯一会复利的资产(护城河数据集)。
// 用 Node 内置 node:sqlite(零依赖)。DB 文件本地存放、已被 .gitignore 排除。
// 隐私(P7):brief 为原始点子,默认本地落库;ROAST_PERSIST_BRIEF=0 可关闭存正文。
import { DatabaseSync } from "node:sqlite";
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
