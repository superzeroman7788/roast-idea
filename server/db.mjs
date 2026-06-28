// 落库层 —— 唯一会复利的资产(护城河数据集)。
// 用 libSQL/Turso:本地 TURSO_DATABASE_URL 未设 → file:(同 SQLite,持久在磁盘);
// 线上设 TURSO_DATABASE_URL=libsql://…turso… + TURSO_AUTH_TOKEN → 持久云端,Render 免费层重启也不丢。
// 隐私(P7):brief 为原始点子,默认落库;ROAST_PERSIST_BRIEF=0 可关闭存正文。
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_PATH =
  process.env.ROAST_DB_PATH ||
  path.join(process.env.ROAST_DATA_DIR || path.join(process.cwd(), "data"), "roast.db");
const DB_URL = process.env.TURSO_DATABASE_URL || `file:${DB_PATH}`;

if (DB_URL.startsWith("file:")) {
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}
}
const client = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// DB 模式自检(不泄密钥):turso=云端持久 / file=本地临时盘(免费层重启会清)
const IS_TURSO = !DB_URL.startsWith("file:");
let dbHost = "local-file";
try { if (IS_TURSO) dbHost = new URL(DB_URL.replace(/^libsql:/, "https:")).host; } catch {}
export function dbInfo() {
  return { driver: IS_TURSO ? "turso" : "file", persistent: IS_TURSO, host: dbHost, hasAuthToken: Boolean(process.env.TURSO_AUTH_TOKEN) };
}
console.log(`[roast-db] driver=${IS_TURSO ? "turso(持久)" : "file(临时盘)"} host=${dbHost} authToken=${process.env.TURSO_AUTH_TOKEN ? "yes" : "no"}`);

// 建表 + 幂等迁移,只跑一次(并发安全:缓存同一 promise)
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) readyPromise = migrate();
  return readyPromise;
}
async function migrate() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS run_record (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, brief TEXT, evidence_pack TEXT,
      seats TEXT NOT NULL, verdict TEXT NOT NULL, created_at TEXT NOT NULL, outcome TEXT
    );
    CREATE TABLE IF NOT EXISTS evidence_cache (
      query TEXT PRIMARY KEY, pack TEXT NOT NULL, cached_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discussions (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, brief TEXT,
      status TEXT NOT NULL DEFAULT 'open', conclusion TEXT NOT NULL DEFAULT '',
      converged TEXT, evidence_pack TEXT, roles TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discussion_turns (
      id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL, seq INTEGER NOT NULL,
      round INTEGER NOT NULL DEFAULT 0, speaker TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, citations TEXT NOT NULL DEFAULT '[]', latency_ms INTEGER, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_discussion ON discussion_turns(discussion_id, seq);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL, type TEXT NOT NULL, provider TEXT NOT NULL,
      content TEXT, image_path TEXT, parent_id TEXT, mode TEXT NOT NULL DEFAULT 'draft',
      instruction TEXT, status TEXT NOT NULL DEFAULT 'candidate', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_discussion ON artifacts(discussion_id, type);
    CREATE TABLE IF NOT EXISTS viewpoints (
      id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL, seat TEXT NOT NULL, role_angle TEXT NOT NULL,
      stance TEXT, text TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]',
      is_hardest_kill INTEGER NOT NULL DEFAULT 0, round INTEGER NOT NULL DEFAULT 2,
      verification TEXT, latency_ms INTEGER, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_viewpoints_discussion ON viewpoints(discussion_id, round);
    CREATE TABLE IF NOT EXISTS deliberations (
      id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL, consensus TEXT NOT NULL DEFAULT '[]',
      contradictions TEXT NOT NULL DEFAULT '[]', partial_coverage TEXT NOT NULL DEFAULT '[]',
      unique_insights TEXT NOT NULL DEFAULT '[]', blind_spots TEXT NOT NULL DEFAULT '[]',
      simulated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS human_signals (
      id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL, viewpoint_id TEXT NOT NULL,
      action TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_discussion ON human_signals(discussion_id);
    CREATE TABLE IF NOT EXISTS run_configs (
      mode TEXT PRIMARY KEY, config TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT NOT NULL, last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
  `);
  // 幂等迁移:给已存在的表补新列(列已存在则吞掉)
  for (const stmt of [
    `ALTER TABLE viewpoints ADD COLUMN verification TEXT`,
    `ALTER TABLE discussions ADD COLUMN converged TEXT`,
    `ALTER TABLE discussions ADD COLUMN clarify TEXT`,
    `ALTER TABLE discussions ADD COLUMN relay TEXT`,
    `ALTER TABLE discussion_turns ADD COLUMN pinned INTEGER DEFAULT 0`,
    `ALTER TABLE discussion_turns ADD COLUMN corrected INTEGER DEFAULT 0`, // 陪练纠偏:用户判定这条跑偏
    `ALTER TABLE discussion_turns ADD COLUMN correction TEXT`,             // 纠偏说明(原方向 + 用户纠正),广播给后续
    `ALTER TABLE discussions ADD COLUMN user_id TEXT`, // 用户体系:讨论归属(NULL=历史遗留,启动时迁给站长)
    `ALTER TABLE discussions ADD COLUMN solution_doc TEXT`, // 方案文档:主脑收口的厚方案,交下游精修
    `ALTER TABLE discussions ADD COLUMN auto_run TEXT`,     // 自动档 Auto-Pilot:整条 run 状态(rounds/md/收敛史)
  ]) {
    try { await client.execute(stmt); } catch {}
  }
}

// ---- 用户体系(邮箱魔法链接 + 邀请制)----
// 邮箱登录即建/取用户;魔法 token 只存哈希(明文随邮件发出,DB 不留)。
export async function upsertUser(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const now = new Date().toISOString();
  const existing = await get(`SELECT id, email FROM users WHERE email = ?`, [e]);
  if (existing) { await run(`UPDATE users SET last_login = ? WHERE id = ?`, [now, existing.id]); return { id: existing.id, email: existing.email }; }
  const id = randomUUID();
  await run(`INSERT INTO users (id, email, created_at, last_login) VALUES (?, ?, ?, ?)`, [id, e, now, now]);
  return { id, email: e };
}
export async function getUserById(id) {
  const u = await get(`SELECT id, email FROM users WHERE id = ?`, [id]);
  return u ? { id: u.id, email: u.email } : null;
}
export async function createMagicToken(email, tokenHash, expiresAtIso) {
  await run(`INSERT INTO magic_tokens (token_hash, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)`,
    [tokenHash, String(email).trim().toLowerCase(), expiresAtIso, new Date().toISOString()]);
}
// 消费一次性 token:存在 + 未用 + 未过期 → 标记已用 + 返回 email;否则 null
export async function consumeMagicToken(tokenHash) {
  const row = await get(`SELECT token_hash, email, expires_at, used FROM magic_tokens WHERE token_hash = ?`, [tokenHash]);
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) return null;
  await run(`UPDATE magic_tokens SET used = 1 WHERE token_hash = ?`, [tokenHash]);
  return row.email;
}
// 启动迁移:把无主(历史遗留)讨论一次性归给站长账号
export async function assignOrphanDiscussions(userId) {
  const r = await run(`UPDATE discussions SET user_id = ? WHERE user_id IS NULL`, [userId]);
  return r?.rowsAffected ?? 0;
}

// 查询封装(libSQL 异步)
async function all(sql, args = []) { await ensureReady(); return (await client.execute({ sql, args })).rows; }
async function get(sql, args = []) { await ensureReady(); return (await client.execute({ sql, args })).rows[0] || null; }
async function run(sql, args = []) { await ensureReady(); return client.execute({ sql, args }); }

// 启动期可显式预热(可选);兼容旧调用名
export async function getDb() { await ensureReady(); return client; }

const persistBrief = () => process.env.ROAST_PERSIST_BRIEF !== "0";

// ---- RunRecord(旧议会裁决落库)----
export async function saveRunRecord(record) {
  await run(
    `INSERT INTO run_record (id, mode, brief, evidence_pack, seats, verdict, created_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, record.mode, persistBrief() ? record.brief : null,
      record.evidencePack ? JSON.stringify(record.evidencePack) : null,
      JSON.stringify(record.seats ?? []), JSON.stringify(record.verdict ?? {}),
      record.createdAt, record.outcome ? JSON.stringify(record.outcome) : null,
    ],
  );
  return record.id;
}

export async function listRunRecords(limit = 50) {
  const rows = await all(`SELECT * FROM run_record ORDER BY created_at DESC LIMIT ?`, [limit]);
  return rows.map((row) => ({
    id: row.id, mode: row.mode, brief: row.brief,
    evidencePack: row.evidence_pack ? JSON.parse(row.evidence_pack) : null,
    seats: JSON.parse(row.seats), verdict: JSON.parse(row.verdict),
    createdAt: row.created_at, outcome: row.outcome ? JSON.parse(row.outcome) : undefined,
  }));
}

export async function countRunRecords() {
  return (await get(`SELECT COUNT(*) AS n FROM run_record`)).n;
}

// ---- 证据缓存(24h)----
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export async function getCachedPack(query, nowMs) {
  const row = await get(`SELECT pack, cached_at FROM evidence_cache WHERE query = ?`, [query]);
  if (!row) return null;
  if (nowMs - Date.parse(row.cached_at) > CACHE_TTL_MS) return null;
  try { return JSON.parse(row.pack); } catch { return null; }
}
export async function setCachedPack(query, pack, nowIso) {
  await run(
    `INSERT INTO evidence_cache (query, pack, cached_at) VALUES (?, ?, ?)
     ON CONFLICT(query) DO UPDATE SET pack = excluded.pack, cached_at = excluded.cached_at`,
    [query, JSON.stringify(pack), nowIso],
  );
}

// ---- 讨论式陪练 ----
export async function createDiscussion({ mode, title, brief, evidencePack, roles, userId }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO discussions (id, mode, title, brief, status, conclusion, evidence_pack, roles, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', '', ?, ?, ?, ?, ?)`,
    [id, mode, title, persistBrief() ? brief : null, evidencePack ? JSON.stringify(evidencePack) : null, roles ? JSON.stringify(roles) : null, userId || null, now, now],
  );
  return id;
}

// 给已有讨论补/更新证据包(陪练惰性起手后,在「搜索」站把证据补进同一工作台,不新建讨论、不丢对话)
// brief 传入则一并更新(搜索站改了点子重检索 → 讨论 brief 也跟上,否则下游议会/产出读旧点子)
export async function updateDiscussionPack(id, evidencePack, brief) {
  const now = new Date().toISOString();
  if (brief != null && persistBrief()) {
    await run(`UPDATE discussions SET evidence_pack = ?, brief = ?, updated_at = ? WHERE id = ?`, [evidencePack ? JSON.stringify(evidencePack) : null, String(brief), now, id]);
  } else {
    await run(`UPDATE discussions SET evidence_pack = ?, updated_at = ? WHERE id = ?`, [evidencePack ? JSON.stringify(evidencePack) : null, now, id]);
  }
}

// 追加一条发言(seq 自增,更新讨论 updated_at)。失败不静默伪装。
export async function addTurn({ discussionId, round, speaker, role, body, citations, latencyMs }) {
  const exists = await get(`SELECT 1 FROM discussions WHERE id = ?`, [discussionId]);
  if (!exists) throw new Error(`discussion ${discussionId} not found`);
  const id = randomUUID();
  const now = new Date().toISOString();
  const seq = ((await get(`SELECT COALESCE(MAX(seq), 0) AS m FROM discussion_turns WHERE discussion_id = ?`, [discussionId]))?.m || 0) + 1;
  await run(
    `INSERT INTO discussion_turns (id, discussion_id, seq, round, speaker, role, body, citations, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, discussionId, seq, round ?? 0, speaker, role || "", body, JSON.stringify(citations || []), latencyMs ?? null, now],
  );
  await run(`UPDATE discussions SET updated_at = ? WHERE id = ?`, [now, discussionId]);
  return { id, seq, createdAt: now };
}

// 对话点赞:标记/取消某条发言为"用户重视"
export async function setTurnPinned(turnId, pinned) {
  const row = await get(`SELECT discussion_id FROM discussion_turns WHERE id = ?`, [turnId]);
  if (!row) return false;
  await run(`UPDATE discussion_turns SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, turnId]);
  return true;
}

// 取某讨论"用户重视(pinned)"的发言正文(喂主脑/合成优先照顾)
export async function listPinnedTurns(discussionId) {
  const rows = await all(`SELECT speaker, role, body FROM discussion_turns WHERE discussion_id = ? AND pinned = 1 ORDER BY seq ASC`, [discussionId]);
  return rows.map((t) => ({ speaker: t.speaker, role: t.role, body: t.body }));
}

// 纠偏:把某条 AI 发言标为"用户判定跑偏",correction 存合成后的纠偏说明(原方向 + 用户纠正),供广播+重答
export async function setTurnCorrected(turnId, corrected, correction) {
  const row = await get(`SELECT discussion_id FROM discussion_turns WHERE id = ?`, [turnId]);
  if (!row) return false;
  await run(`UPDATE discussion_turns SET corrected = ?, correction = ? WHERE id = ?`, [corrected ? 1 : 0, corrected ? (correction || "") : null, turnId]);
  return true;
}
// 取某讨论被纠偏的发言(广播给后续每个脑 + 出方向卡时当"已排除方向")
export async function listCorrectedTurns(discussionId) {
  const rows = await all(`SELECT speaker, correction FROM discussion_turns WHERE discussion_id = ? AND corrected = 1 AND correction IS NOT NULL ORDER BY seq ASC`, [discussionId]);
  return rows.map((t) => ({ speaker: t.speaker, correction: t.correction }));
}
// 重答:就地替换某条发言正文(单脑带纠偏重答用)
export async function updateTurnBody(turnId, body) {
  const row = await get(`SELECT discussion_id FROM discussion_turns WHERE id = ?`, [turnId]);
  if (!row) return null;
  await run(`UPDATE discussion_turns SET body = ? WHERE id = ?`, [body, turnId]);
  return row.discussion_id;
}

// userId 传入 → 只取归属该用户的(分租/防越权);不传 → 不限(内部调用)
export async function getDiscussion(id, userId) {
  const d = userId
    ? await get(`SELECT * FROM discussions WHERE id = ? AND user_id = ?`, [id, userId])
    : await get(`SELECT * FROM discussions WHERE id = ?`, [id]);
  if (!d) return null;
  const turns = await all(`SELECT * FROM discussion_turns WHERE discussion_id = ? ORDER BY seq ASC`, [id]);
  return {
    id: d.id, userId: d.user_id, mode: d.mode, title: d.title, brief: d.brief, status: d.status, conclusion: d.conclusion,
    converged: d.converged ? JSON.parse(d.converged) : null,
    clarify: d.clarify ? JSON.parse(d.clarify) : null,
    relay: d.relay ? JSON.parse(d.relay) : null,
    solutionDoc: d.solution_doc || null,
    autoRun: d.auto_run ? JSON.parse(d.auto_run) : null,
    evidencePack: d.evidence_pack ? JSON.parse(d.evidence_pack) : null,
    roles: d.roles ? JSON.parse(d.roles) : null,
    createdAt: d.created_at, updatedAt: d.updated_at,
    turns: turns.map((t) => ({
      id: t.id, seq: t.seq, round: t.round, speaker: t.speaker, role: t.role, body: t.body,
      citations: JSON.parse(t.citations || "[]"), latencyMs: t.latency_ms, pinned: !!t.pinned, corrected: !!t.corrected, correction: t.correction || null, createdAt: t.created_at,
    })),
    artifacts: await listArtifacts(id),
    viewpoints: await listViewpoints(id),
    deliberation: await getDeliberation(id),
    humanSignals: await listSignals(id),
  };
}

export async function saveClarify(id, clarify) {
  await run(`UPDATE discussions SET clarify = ?, updated_at = ? WHERE id = ?`, [clarify ? JSON.stringify(clarify) : null, new Date().toISOString(), id]);
}
export async function saveRelay(id, relay) {
  await run(`UPDATE discussions SET relay = ?, updated_at = ? WHERE id = ?`, [relay ? JSON.stringify(relay) : null, new Date().toISOString(), id]);
}
export async function setSolutionDoc(id, md) {
  await run(`UPDATE discussions SET solution_doc = ?, updated_at = ? WHERE id = ?`, [md || null, new Date().toISOString(), id]);
}

// 自动档:整条 run 状态(JSON)
export async function setAutoRun(id, state) {
  await run(`UPDATE discussions SET auto_run = ?, updated_at = ? WHERE id = ?`, [state ? JSON.stringify(state) : null, new Date().toISOString(), id]);
}
export async function finalizeDiscussion(id, conclusion, converged) {
  const now = new Date().toISOString();
  await run(`UPDATE discussions SET status = 'finalized', conclusion = ?, converged = ?, updated_at = ? WHERE id = ?`,
    [conclusion, converged ? JSON.stringify(converged) : null, now, id]);
  return now;
}
// userId 传入 → 只列该用户的历史(分租);不传 → 全部(内部/迁移)
export async function listDiscussions(userId, limit = 100) {
  return userId
    ? all(`SELECT id, mode, title, status, created_at, updated_at FROM discussions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`, [userId, limit])
    : all(`SELECT id, mode, title, status, created_at, updated_at FROM discussions ORDER BY updated_at DESC LIMIT ?`, [limit]);
}
export async function deleteDiscussion(id, userId) {
  if (userId) { const owned = await get(`SELECT 1 FROM discussions WHERE id = ? AND user_id = ?`, [id, userId]); if (!owned) return false; }
  await run(`DELETE FROM discussion_turns WHERE discussion_id = ?`, [id]);
  await run(`DELETE FROM artifacts WHERE discussion_id = ?`, [id]);
  await run(`DELETE FROM viewpoints WHERE discussion_id = ?`, [id]);
  await run(`DELETE FROM deliberations WHERE discussion_id = ?`, [id]);
  await run(`DELETE FROM human_signals WHERE discussion_id = ?`, [id]);
  const info = await run(`DELETE FROM discussions WHERE id = ?`, [id]);
  return Number(info.rowsAffected || 0) > 0;
}

// ---- 审议引擎(白箱)----
function rowToViewpoint(row) {
  return {
    id: row.id, discussionId: row.discussion_id, seat: row.seat, roleAngle: row.role_angle,
    stance: row.stance || null, text: row.text, evidenceIds: JSON.parse(row.evidence_ids || "[]"),
    isHardestKill: Boolean(row.is_hardest_kill), round: row.round,
    verification: row.verification ? JSON.parse(row.verification) : null,
    latencyMs: row.latency_ms, createdAt: row.created_at,
  };
}
export async function saveViewpoint({ discussionId, seat, roleAngle, stance, text, evidenceIds, isHardestKill, round, latencyMs }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO viewpoints (id, discussion_id, seat, role_angle, stance, text, evidence_ids, is_hardest_kill, round, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, discussionId, seat, roleAngle, stance ?? null, text, JSON.stringify(evidenceIds || []), isHardestKill ? 1 : 0, round ?? 2, latencyMs ?? null, now],
  );
  return rowToViewpoint(await get(`SELECT * FROM viewpoints WHERE id = ?`, [id]));
}
export async function listViewpoints(discussionId) {
  return (await all(`SELECT * FROM viewpoints WHERE discussion_id = ? ORDER BY round ASC, created_at ASC`, [discussionId])).map(rowToViewpoint);
}
export async function updateViewpointVerification(id, verification) {
  await run(`UPDATE viewpoints SET verification = ? WHERE id = ?`, [JSON.stringify(verification || null), id]);
}
export async function saveDeliberation({ discussionId, consensus, contradictions, partialCoverage, uniqueInsights, blindSpots, simulated }) {
  await run(`DELETE FROM deliberations WHERE discussion_id = ?`, [discussionId]);
  const id = randomUUID();
  const now = new Date().toISOString();
  const J = (v) => JSON.stringify(v || []);
  await run(
    `INSERT INTO deliberations (id, discussion_id, consensus, contradictions, partial_coverage, unique_insights, blind_spots, simulated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, discussionId, J(consensus), J(contradictions), J(partialCoverage), J(uniqueInsights), J(blindSpots), simulated ? 1 : 0, now],
  );
  return getDeliberation(discussionId);
}
export async function getDeliberation(discussionId) {
  const row = await get(`SELECT * FROM deliberations WHERE discussion_id = ?`, [discussionId]);
  if (!row) return null;
  return {
    consensus: JSON.parse(row.consensus || "[]"), contradictions: JSON.parse(row.contradictions || "[]"),
    partialCoverage: JSON.parse(row.partial_coverage || "[]"), uniqueInsights: JSON.parse(row.unique_insights || "[]"),
    blindSpots: JSON.parse(row.blind_spots || "[]"), simulated: Boolean(row.simulated), createdAt: row.created_at,
  };
}
// 重跑前清旧审议(观点 id 会变,连带清旧策展信号)
export async function clearViewpoints(discussionId) {
  await run(`DELETE FROM viewpoints WHERE discussion_id = ?`, [discussionId]);
  await run(`DELETE FROM human_signals WHERE discussion_id = ?`, [discussionId]);
}

// ---- 人策展信号(偏好数据,append-only)----
export async function saveSignal({ discussionId, viewpointId, action, note }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(`INSERT INTO human_signals (id, discussion_id, viewpoint_id, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, discussionId, viewpointId, action, note ?? null, now]);
  return { id, createdAt: now };
}
export async function listSignals(discussionId) {
  return (await all(`SELECT * FROM human_signals WHERE discussion_id = ? ORDER BY created_at ASC`, [discussionId]))
    .map((r) => ({ id: r.id, viewpointId: r.viewpoint_id, action: r.action, note: r.note || "", createdAt: r.created_at }));
}

// ---- 选角配置持久化 ----
export async function getRunConfig(mode) {
  const row = await get(`SELECT config FROM run_configs WHERE mode = ?`, [mode]);
  if (!row) return null;
  try { return JSON.parse(row.config); } catch { return null; }
}
export async function saveRunConfig(mode, config) {
  await run(`INSERT INTO run_configs (mode, config, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(mode) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    [mode, JSON.stringify(config || {}), new Date().toISOString()]);
  return getRunConfig(mode);
}

// ---- 产出层(交付物)----
function rowToArtifact(row) {
  return {
    id: row.id, discussionId: row.discussion_id, type: row.type, provider: row.provider,
    content: row.content || "", imagePath: row.image_path || null, parentId: row.parent_id || null,
    mode: row.mode, instruction: row.instruction || "", status: row.status, createdAt: row.created_at,
  };
}
export async function saveArtifact({ discussionId, type, provider, content, imagePath, parentId, mode, instruction }) {
  const exists = await get(`SELECT 1 FROM discussions WHERE id = ?`, [discussionId]);
  if (!exists) throw new Error(`discussion ${discussionId} not found`);
  const id = randomUUID();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO artifacts (id, discussion_id, type, provider, content, image_path, parent_id, mode, instruction, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`,
    [id, discussionId, type, provider, content ?? null, imagePath ?? null, parentId ?? null, mode || "draft", instruction ?? null, now],
  );
  return rowToArtifact(await get(`SELECT * FROM artifacts WHERE id = ?`, [id]));
}
// 全局交付物库:某用户所有讨论下的产物(跨点子汇总,按时间倒序)。join discussions 拿标题 + 校验归属。
export async function listAllArtifacts(userId, limit = 300) {
  const rows = await all(
    `SELECT a.id, a.discussion_id, a.type, a.provider, a.content, a.image_path, a.status, a.created_at, d.title AS dtitle
     FROM artifacts a JOIN discussions d ON a.discussion_id = d.id
     WHERE d.user_id = ? ORDER BY a.created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({ id: r.id, discussionId: r.discussion_id, discussionTitle: r.dtitle, type: r.type, provider: r.provider, content: r.content, imagePath: r.image_path, status: r.status, createdAt: r.created_at }));
}
export async function listArtifacts(discussionId) {
  return (await all(`SELECT * FROM artifacts WHERE discussion_id = ? ORDER BY created_at ASC`, [discussionId])).map(rowToArtifact);
}
export async function getArtifact(id) {
  const row = await get(`SELECT * FROM artifacts WHERE id = ?`, [id]);
  return row ? rowToArtifact(row) : null;
}
// 采用:同 discussion 同 type 内,把这条置 chosen、其余回 candidate(单选)。
export async function chooseArtifact(id) {
  const a = await get(`SELECT discussion_id, type FROM artifacts WHERE id = ?`, [id]);
  if (!a) return null;
  await run(`UPDATE artifacts SET status = 'candidate' WHERE discussion_id = ? AND type = ?`, [a.discussion_id, a.type]);
  await run(`UPDATE artifacts SET status = 'chosen' WHERE id = ?`, [id]);
  return getArtifact(id);
}
// 删一条候选;返回它的 image_path 供调用方删盘。
export async function deleteArtifact(id) {
  const a = await get(`SELECT image_path FROM artifacts WHERE id = ?`, [id]);
  if (!a) return { deleted: false, imagePath: null };
  await run(`DELETE FROM artifacts WHERE id = ?`, [id]);
  return { deleted: true, imagePath: a.image_path || null };
}
