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
      conclusion    TEXT NOT NULL DEFAULT '', -- finalize/收敛 产出的方案(markdown,喂下游产出层/导出)
      converged     TEXT,                     -- JSON: ConvergedOutput(人-steered 白箱收敛)
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
    -- 产出层(交付物):把方案变成文案/PRD/设计文档/代码草稿/配图;支持比稿(同 type 多候选)+ 改稿(parent 谱系)
    CREATE TABLE IF NOT EXISTS artifacts (
      id            TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL,
      type          TEXT NOT NULL,                     -- copy | prd | design_doc | code_sketch | image
      provider      TEXT NOT NULL,                     -- 出品厂商 label
      content       TEXT,                              -- 文字交付物正文(markdown/代码);图为空
      image_path    TEXT,                              -- 图片相对路径(相对 data/);文字为空
      parent_id     TEXT,                              -- 改稿:指向上一版 artifact id(谱系)
      mode          TEXT NOT NULL DEFAULT 'draft',     -- draft | refine
      instruction   TEXT,                              -- 改稿指令/用户备注
      status        TEXT NOT NULL DEFAULT 'candidate', -- candidate | chosen
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_discussion ON artifacts(discussion_id, type);
    -- 审议引擎(白箱):结构化署名观点 + Fusion 式审议综述
    CREATE TABLE IF NOT EXISTS viewpoints (
      id              TEXT PRIMARY KEY,
      discussion_id   TEXT NOT NULL,
      seat            TEXT NOT NULL,                 -- 出品厂商 label
      role_angle      TEXT NOT NULL,                 -- organizer | demand | feasibility | devils-advocate
      stance          TEXT,                          -- Ship | Fix | Pause | Kill(结构字段,非裁决)
      text            TEXT NOT NULL,
      evidence_ids    TEXT NOT NULL DEFAULT '[]',     -- JSON: ["E1",...](经引用校验)
      is_hardest_kill INTEGER NOT NULL DEFAULT 0,     -- 强制反方的最强 kill,收敛时不可静音
      round           INTEGER NOT NULL DEFAULT 2,     -- 1=立靶 2=独立开火 3=交叉
      verification    TEXT,                            -- JSON: {verdict,note}(Verifier 事实核查)
      latency_ms      INTEGER,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_viewpoints_discussion ON viewpoints(discussion_id, round);
    CREATE TABLE IF NOT EXISTS deliberations (
      id              TEXT PRIMARY KEY,
      discussion_id   TEXT NOT NULL,
      consensus       TEXT NOT NULL DEFAULT '[]',
      contradictions  TEXT NOT NULL DEFAULT '[]',
      partial_coverage TEXT NOT NULL DEFAULT '[]',
      unique_insights TEXT NOT NULL DEFAULT '[]',     -- JSON: [{seat,text}]
      blind_spots     TEXT NOT NULL DEFAULT '[]',
      simulated       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );
    -- 人策展信号(append-only 偏好日志 = 护城河):对每条观点 认领/搁置/钉死/反驳
    CREATE TABLE IF NOT EXISTS human_signals (
      id            TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL,
      viewpoint_id  TEXT NOT NULL,
      action        TEXT NOT NULL,            -- endorse | setAside | pin | reply | clear
      note          TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_discussion ON human_signals(discussion_id);
    -- 选角配置持久化(按模式;无用户概念时即应用级默认)
    CREATE TABLE IF NOT EXISTS run_configs (
      mode       TEXT PRIMARY KEY,   -- idea | copy
      config     TEXT NOT NULL,      -- JSON: RunConfig
      updated_at TEXT NOT NULL
    );
  `);
  // 幂等迁移:给已存在的表补新列(列已存在则吞掉)。
  try { db.exec(`ALTER TABLE viewpoints ADD COLUMN verification TEXT`); } catch {}
  try { db.exec(`ALTER TABLE discussions ADD COLUMN converged TEXT`); } catch {}
  try { db.exec(`ALTER TABLE discussions ADD COLUMN clarify TEXT`); } catch {} // 想清楚(clarify)结构化产出
  try { db.exec(`ALTER TABLE discussions ADD COLUMN relay TEXT`); } catch {} // 跨模型接力(hops + 方向卡)
  try { db.exec(`ALTER TABLE discussion_turns ADD COLUMN pinned INTEGER DEFAULT 0`); } catch {} // 对话点赞:用户重视的发言
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

// 对话点赞:标记/取消某条发言为"用户重视"
export function setTurnPinned(turnId, pinned) {
  const database = getDb();
  const row = database.prepare(`SELECT discussion_id FROM discussion_turns WHERE id = ?`).get(turnId);
  if (!row) return false;
  database.prepare(`UPDATE discussion_turns SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, turnId);
  return true;
}

// 取某讨论"用户重视(pinned)"的发言正文(喂主脑/合成优先照顾)
export function listPinnedTurns(discussionId) {
  const database = getDb();
  return database
    .prepare(`SELECT speaker, role, body FROM discussion_turns WHERE discussion_id = ? AND pinned = 1 ORDER BY seq ASC`)
    .all(discussionId)
    .map((t) => ({ speaker: t.speaker, role: t.role, body: t.body }));
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
    converged: d.converged ? JSON.parse(d.converged) : null,
    clarify: d.clarify ? JSON.parse(d.clarify) : null,
    relay: d.relay ? JSON.parse(d.relay) : null,
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
      pinned: !!t.pinned,
      createdAt: t.created_at,
    })),
    artifacts: listArtifacts(id),
    viewpoints: listViewpoints(id),
    deliberation: getDeliberation(id),
    humanSignals: listSignals(id),
  };
}

// 想清楚(clarify)产出落库(可重跑覆盖)
export function saveClarify(id, clarify) {
  getDb()
    .prepare(`UPDATE discussions SET clarify = ?, updated_at = ? WHERE id = ?`)
    .run(clarify ? JSON.stringify(clarify) : null, new Date().toISOString(), id);
}

// 跨模型接力产出落库(hops + 方向卡;可重跑覆盖)
export function saveRelay(id, relay) {
  getDb()
    .prepare(`UPDATE discussions SET relay = ?, updated_at = ? WHERE id = ?`)
    .run(relay ? JSON.stringify(relay) : null, new Date().toISOString(), id);
}

export function finalizeDiscussion(id, conclusion, converged) {
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE discussions SET status = 'finalized', conclusion = ?, converged = ?, updated_at = ? WHERE id = ?`)
    .run(conclusion, converged ? JSON.stringify(converged) : null, now, id);
  return now;
}

export function listDiscussions(limit = 100) {
  return getDb()
    .prepare(`SELECT id, mode, title, status, created_at, updated_at FROM discussions ORDER BY updated_at DESC LIMIT ?`)
    .all(limit);
}

// 删除一场讨论及其全部发言(本地数据,用户主动清理)。
export function deleteDiscussion(id) {
  const database = getDb();
  database.prepare(`DELETE FROM discussion_turns WHERE discussion_id = ?`).run(id);
  database.prepare(`DELETE FROM artifacts WHERE discussion_id = ?`).run(id);
  database.prepare(`DELETE FROM viewpoints WHERE discussion_id = ?`).run(id);
  database.prepare(`DELETE FROM deliberations WHERE discussion_id = ?`).run(id);
  database.prepare(`DELETE FROM human_signals WHERE discussion_id = ?`).run(id);
  const info = database.prepare(`DELETE FROM discussions WHERE id = ?`).run(id);
  return info.changes > 0;
}

// ---- 审议引擎(白箱)----
function rowToViewpoint(row) {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    seat: row.seat,
    roleAngle: row.role_angle,
    stance: row.stance || null,
    text: row.text,
    evidenceIds: JSON.parse(row.evidence_ids || "[]"),
    isHardestKill: Boolean(row.is_hardest_kill),
    round: row.round,
    verification: row.verification ? JSON.parse(row.verification) : null,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

export function saveViewpoint({ discussionId, seat, roleAngle, stance, text, evidenceIds, isHardestKill, round, latencyMs }) {
  const database = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO viewpoints (id, discussion_id, seat, role_angle, stance, text, evidence_ids, is_hardest_kill, round, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      discussionId,
      seat,
      roleAngle,
      stance ?? null,
      text,
      JSON.stringify(evidenceIds || []),
      isHardestKill ? 1 : 0,
      round ?? 2,
      latencyMs ?? null,
      now,
    );
  return rowToViewpoint(database.prepare(`SELECT * FROM viewpoints WHERE id = ?`).get(id));
}

export function listViewpoints(discussionId) {
  return getDb()
    .prepare(`SELECT * FROM viewpoints WHERE discussion_id = ? ORDER BY round ASC, created_at ASC`)
    .all(discussionId)
    .map(rowToViewpoint);
}

// Verifier 核查结论回写
export function updateViewpointVerification(id, verification) {
  getDb().prepare(`UPDATE viewpoints SET verification = ? WHERE id = ?`).run(JSON.stringify(verification || null), id);
}

// 一场讨论最多保留一份最新综述(重跑覆盖)。
export function saveDeliberation({ discussionId, consensus, contradictions, partialCoverage, uniqueInsights, blindSpots, simulated }) {
  const database = getDb();
  database.prepare(`DELETE FROM deliberations WHERE discussion_id = ?`).run(discussionId);
  const id = randomUUID();
  const now = new Date().toISOString();
  const J = (v) => JSON.stringify(v || []);
  database
    .prepare(
      `INSERT INTO deliberations (id, discussion_id, consensus, contradictions, partial_coverage, unique_insights, blind_spots, simulated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, discussionId, J(consensus), J(contradictions), J(partialCoverage), J(uniqueInsights), J(blindSpots), simulated ? 1 : 0, now);
  return getDeliberation(discussionId);
}

export function getDeliberation(discussionId) {
  const row = getDb().prepare(`SELECT * FROM deliberations WHERE discussion_id = ?`).get(discussionId);
  if (!row) return null;
  return {
    consensus: JSON.parse(row.consensus || "[]"),
    contradictions: JSON.parse(row.contradictions || "[]"),
    partialCoverage: JSON.parse(row.partial_coverage || "[]"),
    uniqueInsights: JSON.parse(row.unique_insights || "[]"),
    blindSpots: JSON.parse(row.blind_spots || "[]"),
    simulated: Boolean(row.simulated),
    createdAt: row.created_at,
  };
}

// 清空一场讨论的旧审议(重跑前调用):观点 id 会变,连带清旧策展信号
export function clearViewpoints(discussionId) {
  getDb().prepare(`DELETE FROM viewpoints WHERE discussion_id = ?`).run(discussionId);
  getDb().prepare(`DELETE FROM human_signals WHERE discussion_id = ?`).run(discussionId);
}

// ---- 人策展信号(偏好数据,append-only)----
export function saveSignal({ discussionId, viewpointId, action, note }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(`INSERT INTO human_signals (id, discussion_id, viewpoint_id, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, discussionId, viewpointId, action, note ?? null, now);
  return { id, createdAt: now };
}

export function listSignals(discussionId) {
  return getDb()
    .prepare(`SELECT * FROM human_signals WHERE discussion_id = ? ORDER BY created_at ASC`)
    .all(discussionId)
    .map((r) => ({ id: r.id, viewpointId: r.viewpoint_id, action: r.action, note: r.note || "", createdAt: r.created_at }));
}

// ---- 选角配置持久化 ----
export function getRunConfig(mode) {
  const row = getDb().prepare(`SELECT config FROM run_configs WHERE mode = ?`).get(mode);
  if (!row) return null;
  try { return JSON.parse(row.config); } catch { return null; }
}

export function saveRunConfig(mode, config) {
  getDb()
    .prepare(`INSERT INTO run_configs (mode, config, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(mode) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`)
    .run(mode, JSON.stringify(config || {}), new Date().toISOString());
  return getRunConfig(mode);
}

// ---- 产出层(交付物)----
function rowToArtifact(row) {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    type: row.type,
    provider: row.provider,
    content: row.content || "",
    imagePath: row.image_path || null,
    parentId: row.parent_id || null,
    mode: row.mode,
    instruction: row.instruction || "",
    status: row.status,
    createdAt: row.created_at,
  };
}

// 落一条交付物(文字存 content / 图片存 imagePath)。返回完整对象供 SSE 推。
export function saveArtifact({ discussionId, type, provider, content, imagePath, parentId, mode, instruction }) {
  const database = getDb();
  const exists = database.prepare(`SELECT 1 FROM discussions WHERE id = ?`).get(discussionId);
  if (!exists) throw new Error(`discussion ${discussionId} not found`);
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO artifacts (id, discussion_id, type, provider, content, image_path, parent_id, mode, instruction, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`,
    )
    .run(
      id,
      discussionId,
      type,
      provider,
      content ?? null,
      imagePath ?? null,
      parentId ?? null,
      mode || "draft",
      instruction ?? null,
      now,
    );
  return rowToArtifact(database.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id));
}

export function listArtifacts(discussionId) {
  return getDb()
    .prepare(`SELECT * FROM artifacts WHERE discussion_id = ? ORDER BY created_at ASC`)
    .all(discussionId)
    .map(rowToArtifact);
}

export function getArtifact(id) {
  const row = getDb().prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id);
  return row ? rowToArtifact(row) : null;
}

// 采用:同一 discussion 同一 type 内,把这条置 chosen、其余回 candidate(单选)。
export function chooseArtifact(id) {
  const database = getDb();
  const a = database.prepare(`SELECT discussion_id, type FROM artifacts WHERE id = ?`).get(id);
  if (!a) return null;
  database
    .prepare(`UPDATE artifacts SET status = 'candidate' WHERE discussion_id = ? AND type = ?`)
    .run(a.discussion_id, a.type);
  database.prepare(`UPDATE artifacts SET status = 'chosen' WHERE id = ?`).run(id);
  return getArtifact(id);
}

// 删一条候选;返回它的 image_path 供调用方删盘。
export function deleteArtifact(id) {
  const database = getDb();
  const a = database.prepare(`SELECT image_path FROM artifacts WHERE id = ?`).get(id);
  if (!a) return { deleted: false, imagePath: null };
  database.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
  return { deleted: true, imagePath: a.image_path || null };
}
