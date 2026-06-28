import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import { loadEnv } from "./env.mjs";
import { listSkills, loadSkill, loadSkillRef, routeSkill, saveSkill } from "./skills.mjs";
import {
  getProviderStatus,
  runDiscussionRound,
  runFinalize,
  assignDiscussionSeats,
  buildAttachmentContext,
  runProduce,
  listProduceProviders,
  runDeliberation,
  runClarify,
  runRelay,
  runClarifyCard,
  synthesizeEvidenceBrief,
  runConverge,
  listPersonas,
  reanswerTurn,
  runSolutionDoc,
  runAutoRound,
  runAgentTask,
  runReflection,
} from "./providers.mjs";
import { buildEvidencePack } from "./evidence.mjs";
import {
  countRunRecords,
  createDiscussion,
  updateDiscussionPack,
  getDb,
  addTurn,
  getDiscussion,
  finalizeDiscussion,
  listDiscussions,
  deleteDiscussion,
  saveArtifact,
  listAllArtifacts,
  getArtifact,
  chooseArtifact,
  deleteArtifact,
  saveViewpoint,
  saveDeliberation,
  saveClarify,
  saveRelay,
  clearViewpoints,
  updateViewpointVerification,
  saveSignal,
  setTurnPinned,
  listPinnedTurns,
  setTurnCorrected,
  listCorrectedTurns,
  updateTurnBody,
  setSolutionDoc,
  setAutoRun,
  getRunConfig,
  saveRunConfig,
  upsertUser,
  createMagicToken,
  consumeMagicToken,
  assignOrphanDiscussions,
  dbInfo,
  getMemories,
  saveMemories,
  deleteMemory,
  getSkillProposals,
  saveSkillProposals,
  updateSkillProposalStatus,
} from "./db.mjs";

loadEnv();

// PORT 优先(Render/Fly/Railway 等平台注入动态端口);本地回落 ROAST_API_PORT / 8787
const port = Number(process.env.PORT || process.env.ROAST_API_PORT || 8787);
// 图片落盘根目录(与 db.mjs 的默认 data 目录一致)
const DATA_DIR = process.env.ROAST_DATA_DIR || path.join(process.cwd(), "data");
// 生产:vite build 静态产物目录(单进程托管前端)
const STATIC_DIR = process.env.ROAST_STATIC_DIR || path.join(process.cwd(), "dist");

// ============ 用户体系:邮箱魔法链接 + 邀请制(无密码,httpOnly 签名会话)============
const SESSION_SECRET = process.env.ROAST_JWT_SECRET || process.env.ROAST_ACCESS_PASSWORD || "roast-dev-secret-change-me";
const OWNER_EMAIL = (process.env.ROAST_OWNER_EMAIL || "ln5423696@gmail.com").trim().toLowerCase();
const SESSION_DAYS = 30;
// 极简签名会话(零依赖):base64url(payload).hmac;payload = {id,email,exp}
function signSession(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, email: user.email, exp: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expect = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  try { if (!sig || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null; } catch { return null; }
  try { const p = JSON.parse(Buffer.from(payload, "base64url").toString()); return (p.exp && p.exp > Date.now()) ? p : null; } catch { return null; }
}
function parseCookies(req) {
  const out = {}; for (const part of (req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i < 0) continue; out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out;
}
const userFromReq = (req) => verifySession(parseCookies(req)["roast_session"]);
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `roast_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${secure}`);
}
const clearSessionCookie = (res) => res.setHeader("Set-Cookie", `roast_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
// 邀请白名单:站长 + 硬编码兜底名单 ALLOWED_EXTRA + env ROAST_ALLOWED_EMAILS(逗号分隔,两者合并)
const ALLOWED_EXTRA = ["5423696@qq.com"]; // 站长 QQ 备用邮箱
function isInvited(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (e === OWNER_EMAIL) return true;
  const list = [...ALLOWED_EXTRA, ...(process.env.ROAST_ALLOWED_EMAILS || "").split(",")].map((x) => x.trim().toLowerCase()).filter(Boolean);
  return list.includes(e);
}
// 登录密码:白名单邮箱之外再加一道密码(初期全员默认 123456,线上可设 ROAST_LOGIN_PASSWORD 覆盖)。
// 后续要"每人独立密码"再扩成 users 表存哈希,这里先用共享密码满足"也需要录入密码"。
const LOGIN_PASSWORD = process.env.ROAST_LOGIN_PASSWORD || "123456";
function passwordOk(input) {
  const a = Buffer.from(String(input ?? ""), "utf8");
  const b = Buffer.from(LOGIN_PASSWORD, "utf8");
  return a.length === b.length && timingSafeEqual(a, b); // 等长才比,常量时间
}
const tokenHashOf = (t) => createHash("sha256").update(t).digest("hex");
// 发魔法链接:配了 RESEND_API_KEY 就发真邮件;否则打到日志(站长手动转发,邀请制够用)
async function sendMagicLink(email, link) {
  if (!process.env.RESEND_API_KEY) { console.log(`\n[roast-auth] 🔑 魔法登录链接(发给 ${email}):\n${link}\n`); return "log"; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.ROAST_MAIL_FROM || "ROAST <onboarding@resend.dev>", to: email, subject: "登录 ROAST · 点子陪练", html: `<p>点击登录(15 分钟内有效):</p><p><a href="${link}">${link}</a></p>` }),
    });
    if (!r.ok) { console.error("[roast-auth] resend failed:", r.status, await r.text().catch(() => "")); console.log(`[roast-auth] 链接回退日志: ${link}`); return "log"; }
    return "email";
  } catch (e) { console.error("[roast-auth] resend error:", e?.message || e); console.log(`[roast-auth] 链接回退日志: ${link}`); return "log"; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      const providers = getProviderStatus();
      return json(res, 200, {
        ok: providers.some((provider) => provider.configured),
        providers,
        runs: await safeCount(),
        authRequired: Boolean(process.env.ROAST_ACCESS_PASSWORD),
        db: dbInfo(),
      });
    }

    // ============ 用户体系端点(公开,不需登录态)============
    // 请求魔法链接:邮箱在邀请名单 → 发一次性登录链接(15min 有效)
    if (req.method === "POST" && url.pathname === "/api/auth/request") {
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!email.includes("@")) return json(res, 400, { ok: false, error: "请填写有效邮箱" });
      // 直登(默认,小圈子内测):名单里的邮箱输完即登,不绕邮件/日志。
      // 大范围内测时设 ROAST_DIRECT_LOGIN=0 → 切回魔法链接验证(代码保留在下方分支)。
      const directLogin = process.env.ROAST_DIRECT_LOGIN !== "0";
      if (!isInvited(email)) {
        if (directLogin) return json(res, 403, { ok: false, error: "该邮箱不在名单内 —— 找站长把你加进来" });
        return json(res, 200, { ok: true, via: "log" }); // 魔法模式:不透露是否在名单(防探测)
      }
      if (directLogin) {
        // 白名单之外再验密码(初期默认 123456)。先查名单(上面已查)再查密码。
        if (!passwordOk(body.password)) return json(res, 403, { ok: false, error: "密码错误", needPassword: true });
        const user = await upsertUser(email);
        setSessionCookie(res, signSession(user));
        return json(res, 200, { ok: true, via: "direct", user: { email: user.email } });
      }
      // 魔法链接模式(保留,大范围内测再开):发一次性登录链接
      const token = randomBytes(32).toString("base64url");
      try { await createMagicToken(email, tokenHashOf(token), new Date(Date.now() + 15 * 60 * 1000).toISOString()); }
      catch (e) { return json(res, 500, { ok: false, error: "发起失败" }); }
      const base = (process.env.ROAST_PUBLIC_URL || `http://${req.headers.host}`).replace(/\/$/, "");
      const via = await sendMagicLink(email, `${base}/api/auth/verify?token=${token}`);
      return json(res, 200, { ok: true, via }); // via: "email" | "log"
    }
    // 校验魔法链接 → 建/取用户 → 下发会话 cookie → 302 跳回 App
    if (req.method === "GET" && url.pathname === "/api/auth/verify") {
      const token = url.searchParams.get("token") || "";
      const email = token ? await consumeMagicToken(tokenHashOf(token)) : null;
      if (!email) { res.writeHead(302, { location: "/?auth=expired" }); return res.end(); }
      const user = await upsertUser(email);
      setSessionCookie(res, signSession(user));
      const dest = (process.env.ROAST_PUBLIC_URL || "").replace(/\/$/, "");
      res.writeHead(302, { location: `${dest}/?welcome=1` }); // ?welcome=1 → 前端登录后播一次 JARVIS 欢迎
      return res.end();
    }
    // 当前登录态(前端启动判断)
    if (req.method === "GET" && url.pathname === "/api/me") {
      const u = userFromReq(req);
      return json(res, 200, { ok: true, user: u ? { email: u.email } : null });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    // HTML 原型的内嵌生成图:公开读(文件名是随机 UUID,等于能力令牌;且 sandbox iframe 是 opaque origin 不带 cookie,故不能放鉴权门后)
    // 仅放行 proto-<uuid>.png(原型专用前缀)—— 不暴露同目录下的「配图」产物文件(<uuid>.png,仍走鉴权的 /api/artifact/:id/image)
    const protoAsset = url.pathname.match(/^\/api\/proto-asset\/([0-9a-f-]{36})\/(proto-[0-9a-f-]{36}\.png)$/);
    if (req.method === "GET" && protoAsset) {
      const fp = path.join(DATA_DIR, "artifacts", protoAsset[1], protoAsset[2]);
      if (!fp.startsWith(path.join(DATA_DIR, "artifacts")) || !fs.existsSync(fp)) return json(res, 404, { ok: false, error: "not found" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    // ============ 鉴权门:除上面公开端点(status/auth/me/proto-asset),所有 /api/* 都需登录 ============
    if (url.pathname.startsWith("/api/")) {
      const u = userFromReq(req);
      if (!u) return json(res, 401, { ok: false, error: "需要登录" });
      req.userId = u.id; req.userEmail = u.email;
    }

    // ============ 讨论式陪练(讨论重构)============
    // 开场:建讨论 + 拉信息板 + 跑开场一轮(SSE 逐 agent 推)
    if (req.method === "POST" && url.pathname === "/api/discussion/start") {
      const body = await readJson(req);
      const mode = body.mode === "copy" ? "copy" : "idea";
      const brief = String(body.brief || "").trim();
      if (!brief) return json(res, 400, { ok: false, error: "brief is required" });
      if (brief.length > 12000) return json(res, 400, { ok: false, error: "brief is too long" });
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const redacted = Boolean(body.redacted);
      const seats = assignDiscussionSeats(byoKeys);
      if (!seats.length) {
        return json(res, 400, { ok: false, error: "no configured providers (add keys to .env.local)" });
      }

      sseHead(res);
      try {
        let pack = {
          mode,
          items: [],
          byCategory: { competitor: [], oss: [], demand: [], pricing: [], pain: [] },
          sources: [],
          redacted: true,
          failures: [],
        };
        if (!redacted) {
          const now = new Date();
          pack = await buildEvidencePack({ brief, mode, redacted: false, nowIso: now.toISOString(), nowMs: now.getTime(), byoKeys });
          // 侦察简报:读全部证据 → 关键结论 + 整体可信度 + 建议(搜索站右栏;对冲 ~10s)
          if (pack.items?.length) {
            try { applyEvidenceBrief(pack, await synthesizeEvidenceBrief({ brief, items: pack.items, mode, byoKeys })); }
            catch (e) { console.error("[roast-api] evidence brief failed:", e?.message || e); }
          }
        }
        // 用户排除的证据 id 列表(前端传来,不进议会)
        const excludedIds = new Set(Array.isArray(body.excludedIds) ? body.excludedIds : []);
        const evidenceForAgents = (pack.items || []).filter((it) => !excludedIds.has(it.id));
        sseSend(res, "board", { pack });

        // 附件:图片→视觉转文字 / 文本文件→正文,注入点子(供整场讨论参考)
        const attachCtx = await buildAttachmentContext(body.attachments, byoKeys);
        const fullBrief = brief + attachCtx;

        const title = brief.split("\n")[0].slice(0, 60);
        const discussionId = await createDiscussion({ mode, title, brief: fullBrief, evidencePack: pack, roles: seats, userId: req.userId });
        sseSend(res, "discussion", { id: discussionId, mode, title, seats });

        // skipOpening:议会主屏(白箱审议为主)只建讨论+board,开场轮由前端接着调 /deliberate
        if (!body.skipOpening) {
          // solo:只让主大脑(host)开场;否则全议会
          const solo = Boolean(body.solo);
          const roundSeats = solo ? seats.filter((s) => s.role === "host") : seats;
          await runDiscussionRound(
            { mode, brief: fullBrief, evidence: evidenceForAgents, transcript: "", userTurn: "", seats: roundSeats, byoKeys, round: 1 },
            (turn) => emitTurn(res, discussionId, turn, pack),
          );
        }
        sseSend(res, "round-done", { discussionId, round: 1 });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "start failed" });
      }
      res.end();
      return;
    }

    // 给已有讨论补检索:陪练惰性起手(不带证据)后,用户在「搜索」站把证据补进同一工作台(不新建、不丢对话)
    const retrieve = url.pathname.match(/^\/api\/discussion\/([^/]+)\/retrieve$/);
    if (req.method === "POST" && retrieve) {
      const did = retrieve[1];
      const body = await readJson(req);
      const existing = await getDiscussion(did, req.userId);
      if (!existing) return json(res, 404, { ok: false, error: "discussion not found" });
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const brief = String(body.brief || existing.brief || existing.title || "").trim();
      sseHead(res);
      try {
        const now = new Date();
        const pack = await buildEvidencePack({ brief, mode: existing.mode, redacted: false, nowIso: now.toISOString(), nowMs: now.getTime(), byoKeys });
        if (pack.items?.length) {
          try { applyEvidenceBrief(pack, await synthesizeEvidenceBrief({ brief, items: pack.items, mode: existing.mode, byoKeys })); }
          catch (e) { console.error("[roast-api] evidence brief failed:", e?.message || e); }
        }
        await updateDiscussionPack(did, pack, body.brief ? brief : undefined); // 改了点子重检索 → 讨论 brief 跟上
        sseSend(res, "board", { pack });
        sseSend(res, "round-done", { discussionId: did });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "retrieve failed" });
      }
      res.end();
      return;
    }

    // 历史列表:过往讨论(标题/模式/状态/时间),供前端「历史」面板浏览
    if (req.method === "GET" && url.pathname === "/api/discussions") {
      return json(res, 200, { ok: true, discussions: await listDiscussions(req.userId, 100) });
    }

    // 全局交付物库:本用户所有产物(跨点子汇总)
    if (req.method === "GET" && url.pathname === "/api/artifacts") {
      return json(res, 200, { ok: true, artifacts: await listAllArtifacts(req.userId, 300) });
    }

    // 恢复会话
    const detail = url.pathname.match(/^\/api\/discussion\/([^/]+)$/);
    if (req.method === "GET" && detail) {
      const d = await getDiscussion(detail[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      return json(res, 200, { ok: true, discussion: d });
    }

    // 删除一场讨论(本地数据,用户主动清理)
    if (req.method === "DELETE" && detail) {
      const ok = await deleteDiscussion(detail[1], req.userId);
      if (ok) {
        // 删完 DB 行,顺手清这条点子的整个图目录(配图 + 原型 proto-*.png),否则磁盘只增不减
        const dir = path.join(DATA_DIR, "artifacts", detail[1]);
        if (dir.startsWith(path.join(DATA_DIR, "artifacts") + path.sep)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
      }
      return json(res, ok ? 200 : 404, { ok });
    }

    // 用户插话(userTurn 为空 = "再辩一轮")→ 跑一轮 agent 回应
    const respond = url.pathname.match(/^\/api\/discussion\/([^/]+)\/respond$/);
    if (req.method === "POST" && respond) {
      const d = await getDiscussion(respond[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      if (d.status === "finalized") return json(res, 400, { ok: false, error: "discussion finalized" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const userTurn = String(body.userTurn || "").trim();
      // clarify(想清楚):N 个协同搭子(host/builder,非对抗);solo:只主脑;否则全议会
      const clarify = Boolean(body.clarify);
      const participants = Math.max(1, Math.min(5, Number(body.participants) || 1));
      const solo = Boolean(body.solo);
      const allSeats = d.roles?.length ? d.roles : assignDiscussionSeats(byoKeys);
      const CLARIFY_ROLES = ["host", "builder", "builder", "builder", "builder"];
      // 陪练对话固定脑序:主脑 Claude → 副脑 OpenAI → DeepSeek → Qwen → 智谱;缺谁用其它已配置席补位
      const CLARIFY_BRAINS = ["claude", "openai", "deepseek", "qwen", "zhipu"];
      const CLARIFY_MAX = 5;
      const seatById = new Map(allSeats.map((s) => [s.id, s]));
      const clarifyPicks = [];
      for (const id of CLARIFY_BRAINS) { const s = seatById.get(id); if (s && !clarifyPicks.includes(s)) clarifyPicks.push(s); }
      for (const s of allSeats) { if (clarifyPicks.length >= CLARIFY_MAX) break; if (!clarifyPicks.includes(s)) clarifyPicks.push(s); }
      const seats = clarify
        ? clarifyPicks.slice(0, participants).map((s, i) => ({ ...s, role: CLARIFY_ROLES[i] || "builder" }))
        : solo ? allSeats.filter((s) => s.role === "host") : allSeats;
      // 陪练兜底:某脑过载/掉线 → 用其它已配置席补上(council 不传,失败照常降级不伪造)
      const fallback = clarify ? allSeats.filter((s) => !seats.some((seat) => seat.id === s.id)) : [];
      const round = Math.max(0, ...d.turns.map((t) => t.round)) + 1;

      sseHead(res);
      try {
        // 附件注入:UI 时间线只存用户原话,喂给 agent 的带附件内容
        const attachCtx = await buildAttachmentContext(body.attachments, byoKeys);
        const effUserTurn = (userTurn + attachCtx).trim();
        if (userTurn || attachCtx) {
          const savedUser = await addTurn({ discussionId: d.id, round, speaker: "you", role: "user", body: userTurn || "(已附附件)", citations: [] });
          // 回推带 id 的用户发言,前端替换乐观条 → 可被点赞
          sseSend(res, "turn", { id: savedUser.id, seq: savedUser.seq, round, speaker: "you", role: "user", body: userTurn || "(已附附件)", citations: [], pinned: false });
        }
        const priorTurns = userTurn || attachCtx ? [...d.turns, { speaker: "you", role: "user", body: effUserTurn }] : d.turns;
        const transcript = buildTranscript(priorTurns);
        const roundBrief = clarify ? d.brief + await pinnedBlock(d.id) + await correctionBlock(d.id) : d.brief; // 点赞(优先照顾)+ 纠偏(别再跑偏)都广播给本轮每个脑
        await runDiscussionRound(
          { mode: d.mode, brief: roundBrief, evidence: d.evidencePack?.items || [], transcript, userTurn: effUserTurn, seats, byoKeys, round, fallback },
          (turn) => emitTurn(res, d.id, turn, d.evidencePack),
        );
        sseSend(res, "round-done", { discussionId: d.id, round });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "respond failed" });
      }
      res.end();
      return;
    }

    // 收敛:synthesizer 出方案
    const finalize = url.pathname.match(/^\/api\/discussion\/([^/]+)\/finalize$/);
    if (req.method === "POST" && finalize) {
      const d = await getDiscussion(finalize[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;

      sseHead(res);
      try {
        const transcript = buildTranscript(d.turns, 40);
        const { conclusion } = await runFinalize({
          mode: d.mode,
          brief: d.brief,
          evidence: d.evidencePack?.items || [],
          transcript,
          byoKeys,
        });
        await finalizeDiscussion(d.id, conclusion);
        sseSend(res, "conclusion", { discussionId: d.id, conclusion });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "finalize failed" });
      }
      res.end();
      return;
    }

    // 人-steered 收敛(D):只吃人策展集合,反共识硬规则,输出重定义。落 conclusion(派生 md)+ converged。
    const converge = url.pathname.match(/^\/api\/discussion\/([^/]+)\/converge$/);
    if (req.method === "POST" && converge) {
      const d = await getDiscussion(converge[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      sseHead(res);
      try {
        const { converged, conclusion } = await runConverge({
          brief: d.brief,
          evidence: d.evidencePack?.items || [],
          viewpoints: d.viewpoints || [],
          signals: d.humanSignals || [],
          byoKeys,
        });
        await finalizeDiscussion(d.id, conclusion, converged);
        sseSend(res, "converged", { discussionId: d.id, converged, conclusion });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "converge failed" });
      }
      res.end();
      return;
    }

    // ============ 审议引擎(白箱):结构化观点 + 审议综述 ============
    const deliberate = url.pathname.match(/^\/api\/discussion\/([^/]+)\/deliberate$/);
    if (req.method === "POST" && deliberate) {
      const d = await getDiscussion(deliberate[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;

      sseHead(res);
      try {
        // 事实侦察雷达页排除的证据(excludedIds)在此过滤,不喂给席位;校验仍只认进场的证据 id
        const excluded = new Set(Array.isArray(body.excludedIds) ? body.excludedIds : []);
        const evidenceForAgents = (d.evidencePack?.items || []).filter((it) => !excluded.has(it.id));
        const validIds = new Set(evidenceForAgents.map((i) => i.id));
        const round2Ids = []; // R2 观点的发出顺序 → 与 Verifier 的 index 对齐
        const runConfig = body.runConfig && typeof body.runConfig === "object" ? body.runConfig : undefined;
        const posture = body.posture || runConfig?.posture || "roast";
        sseSend(res, "deliberate-start", { discussionId: d.id, posture });
        // 想清楚阶段的完整对话(用户 + 协同搭子)= 理解这个项目的根基,折进 brief 喂给本站;再加上游交接的方案文档。
        const handoffDoc = typeof body.handoff === "string" ? body.handoff.trim().slice(0, 8000) : "";
        const deliberSkillName = body.skillName ? String(body.skillName) : "";
        const deliberSkill = deliberSkillName ? loadSkill(deliberSkillName) : null;
        const convo = buildTranscript(d.turns || [], 40);
        let effBrief = deliberSkill ? `[Skill: ${deliberSkill.name}]\n${deliberSkill.body}\n\n---\n\n${d.brief}` : d.brief;
        if (convo) effBrief += `\n\n想清楚阶段的完整对话(理解这个项目的根基,优先于初稿):\n${convo}`;
        effBrief += await pinnedBlock(d.id); // 用户点赞的点 → 方案优先纳入
        effBrief += await correctionBlock(d.id); // 用户纠偏的方向 → 方向卡当"已排除方向",不再 building
        if (handoffDoc) effBrief += `\n\n上一站交接来的方案文档(请基于它推进):\n${handoffDoc}`;
        if (posture === "clarify") {
          // 想清楚:单脑收口(Claude → OpenAI 兜底)读整段对话 → 方向卡。不召反方/不裁决。
          // (原 6 棒跨模型接力太慢/太费,2026-06 用户改回单脑收口;runRelay 仍保留备用。)
          const relayRes = await runClarifyCard(
            { mode: d.mode, brief: effBrief, evidence: evidenceForAgents, byoKeys },
            (ev, data) => {
              if (ev === "relay-hop") sseSend(res, "relay-hop", data);
              else if (ev === "relay-card") sseSend(res, "relay-card", data);
              else if (ev === "seat-failed") sseSend(res, "seat-failed", data);
              else if (ev === "error") sseSend(res, "error", data);
            },
          );
          try { await saveRelay(d.id, relayRes); } catch (e) { console.error("[roast-api] saveRelay failed:", e?.message || e); }
        } else {
        await clearViewpoints(d.id); // 仅议会重跑(roast/council)才覆盖旧观点;clarify 出方向卡不动议会观点+策展
        await runDeliberation(
          { mode: d.mode, brief: effBrief, evidence: evidenceForAgents, byoKeys, runConfig, posture },
          async (ev, data) => {
            if (ev === "viewpoint") {
              // 引用校验:丢弃不存在于信息板的证据 id(不编造)
              const evidenceIds = (data.evidenceIds || []).filter((id) => validIds.has(id));
              let saved = null;
              try { saved = await saveViewpoint({ discussionId: d.id, ...data, evidenceIds }); }
              catch (e) { console.error("[roast-api] saveViewpoint failed:", e?.message || e); }
              if (data.round === 2) round2Ids.push(saved?.id || null);
              sseSend(res, "viewpoint", saved || { ...data, evidenceIds });
            } else if (ev === "verification") {
              const id = round2Ids[data.index];
              if (id) {
                try { await updateViewpointVerification(id, data.verification); }
                catch (e) { console.error("[roast-api] updateViewpointVerification failed:", e?.message || e); }
                sseSend(res, "verification", { id, verification: data.verification });
              }
            } else if (ev === "deliberation") {
              let saved = null;
              try { saved = await saveDeliberation({ discussionId: d.id, ...data }); }
              catch (e) { console.error("[roast-api] saveDeliberation failed:", e?.message || e); }
              sseSend(res, "deliberation", saved || data);
            } else if (ev === "seat-failed") {
              sseSend(res, "seat-failed", data);
            }
          },
        );
        }
        sseSend(res, "round-done", { discussionId: d.id });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "deliberate failed" });
      }
      res.end();
      return;
    }

    // 人策展:对一条观点 认领/搁置/钉死/反驳(append-only 落库 = 偏好数据)
    const signal = url.pathname.match(/^\/api\/discussion\/([^/]+)\/signal$/);
    if (req.method === "POST" && signal) {
      const d = await getDiscussion(signal[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const viewpointId = String(body.viewpointId || "");
      const action = String(body.action || "");
      const note = body.note ? String(body.note).slice(0, 1000) : "";
      if (!viewpointId || !["endorse", "setAside", "pin", "reject", "reply", "clear"].includes(action)) {
        return json(res, 400, { ok: false, error: "bad signal" });
      }
      const saved = await saveSignal({ discussionId: d.id, viewpointId, action, note });
      return json(res, 200, { ok: true, signal: { ...saved, viewpointId, action, note } });
    }

    // 对话点赞:标记/取消某条发言为"用户重视"(主脑回应 + 出卡都会优先照顾)
    const pinTurn = url.pathname.match(/^\/api\/discussion\/([^/]+)\/turn\/([^/]+)\/pin$/);
    if (req.method === "POST" && pinTurn) {
      const d = await getDiscussion(pinTurn[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const ok = await setTurnPinned(pinTurn[2], Boolean(body.pinned));
      return json(res, ok ? 200 : 404, { ok, pinned: Boolean(body.pinned) });
    }

    // 陪练纠偏:某条 AI 发言跑偏 → 记纠偏信号(广播给后续 + 方向卡)+ 让这条脑带纠正立刻重答
    const correctTurn = url.pathname.match(/^\/api\/discussion\/([^/]+)\/turn\/([^/]+)\/correct$/);
    if (req.method === "POST" && correctTurn) {
      const d = await getDiscussion(correctTurn[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const turn = (d.turns || []).find((t) => t.id === correctTurn[2]);
      if (!turn) return json(res, 404, { ok: false, error: "turn not found" });
      if (body.corrected === false) { // 取消纠偏
        await setTurnCorrected(turn.id, false, null);
        return json(res, 200, { ok: true, corrected: false });
      }
      const userFix = String(body.correction || "").trim();
      // 合成纠偏说明(原方向 + 用户纠正);存下来当稳定信号,后续重答替换正文也不受影响
      const note = `${turn.speaker} 原来说:「${String(turn.body || "").slice(0, 180)}」 —— ${userFix ? "用户纠正:" + userFix : "用户判定跑偏,请换个方向重想"}`;
      await setTurnCorrected(turn.id, true, note);
      // 立刻让这条脑带纠正重答,就地替换正文
      let newBody = null, reError = null;
      try {
        const priorTurns = (d.turns || []).filter((t) => t.seq < turn.seq); // 这条之前的上下文
        const r = await reanswerTurn({
          mode: d.mode, brief: d.brief, evidence: d.evidencePack?.items || [],
          transcript: buildTranscript(priorTurns), speaker: turn.speaker, role: turn.role,
          correctionNote: note, byoKeys,
        });
        newBody = r.body;
        if (newBody) await updateTurnBody(turn.id, newBody);
      } catch (e) { reError = String(e?.message || e).slice(0, 200); }
      return json(res, 200, { ok: true, corrected: true, correction: note, newBody, reanswerError: reError });
    }

    // 方案文档:主脑读整段对话 + 方向卡 + 赞/纠偏 → 收口成厚的固定分节方案文档(交下游精修)
    const soldoc = url.pathname.match(/^\/api\/discussion\/([^/]+)\/solution-doc$/);
    if (req.method === "POST" && soldoc) {
      const d = await getDiscussion(soldoc[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      if (!(d.turns || []).some((t) => t.role !== "user" && t.role !== "system")) return json(res, 400, { ok: false, error: "先在陪练聊几句,再出方案文档" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      try {
        const transcript = buildTranscript(d.turns || [], 60);
        const effBrief = d.brief + (await pinnedBlock(d.id)) + (await correctionBlock(d.id));
        const c = d.relay?.card;
        const cardText = c ? [c.oneLine && "内核:" + c.oneLine, c.clear?.length && "已稳定:" + c.clear.join("; "), c.assumptions?.length && "关键假设:" + c.assumptions.join("; "), c.firstNarrowing && "先收窄:" + c.firstNarrowing, (c.dontBuildYet || []).length && "先别建:" + c.dontBuildYet.join("; ")].filter(Boolean).join("\n") : "";
        const out = await runSolutionDoc({ mode: d.mode, brief: effBrief, transcript, card: cardText, byoKeys });
        await setSolutionDoc(d.id, out.md);
        return json(res, 200, { ok: true, md: out.md, by: out.by });
      } catch (e) {
        return json(res, 500, { ok: false, error: e?.message || "方案文档生成失败" });
      }
    }

    // ============ 自动档 Auto-Pilot ============
    // 跑一轮(SSE 流式):导演任务单 → 3 产出 agent 并行 → 合并字段 → 收敛判定 → 评估。吃 humanNote(轮间插话)。
    const autoRound = url.pathname.match(/^\/api\/discussion\/([^/]+)\/autopilot\/round$/);
    if (req.method === "POST" && autoRound) {
      const d = await getDiscussion(autoRound[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const humanNote = body.humanNote ? String(body.humanNote).slice(0, 600) : "";
      const autoSkillName = body.skillName ? String(body.skillName) : "";
      const autoSkill = autoSkillName ? loadSkill(autoSkillName) : null;
      const autoBrief = autoSkill ? `[Skill: ${autoSkill.name}]\n${autoSkill.body}\n\n---\n\n${d.brief}` : d.brief;
      // roundOffset:用户点"继续"时传当前轮数作为本次 session 起点,让 cap 按 session 内轮数算
      const roundOffset = typeof body.roundOffset === "number" ? Math.max(0, body.roundOffset) : 0;
      const prevState = d.autoRun || { rounds: [], md: null };
      const roundIndex = (prevState.rounds?.length || 0) + 1;
      const MAX_ROUNDS = Number(process.env.AUTO_MAX_ROUNDS || 10); // 硬截断层(轮次,先松,用户后期评估)
      const roundsInSession = roundIndex - roundOffset;
      sseHead(res);
      if (roundsInSession > MAX_ROUNDS) { sseSend(res, "capped", { roundIndex, maxRounds: MAX_ROUNDS }); res.end(); return; }
      try {
        const evidence = d.evidencePack?.items || [];
        const round = await runAutoRound({ discId: d.id, brief: autoBrief, roundIndex, prevState, humanNote, evidence, byoKeys }, (ev, data) => sseSend(res, ev, data));
        const rounds = [...(prevState.rounds || []), round];
        const md = { brief_original: d.brief, ...round.fields };
        let best = 0, bestScore = -1;
        rounds.forEach((r, i) => { const s = Object.values(r.eval?.schema_completeness || {}).filter(Boolean).length; if (s >= bestScore) { bestScore = s; best = i; } }); // 强字段最齐者(平手取最新)
        const fourFilled = !!(round.fields.direction && round.fields.open_questions?.length && round.fields.artifacts_hint?.length);
        await setAutoRun(d.id, { rounds, md, bestRoundIndex: best, status: "paused", updatedAt: new Date().toISOString() });
        sseSend(res, "round-done", {
          roundIndex, fields: round.fields, convergence: round.convergence, eval: round.eval,
          canStop: fourFilled,                                              // 规则层:四强字段全非空,可注入
          stopRecommended: fourFilled && !!round.eval?.stop_recommendation, // LLM 层:导演也建议停
          repeatFlagged: !!round.convergence?.consecutive,                  // 反熵:连续 2 轮复读才提示插话(不自动停)
          maxRounds: MAX_ROUNDS,
        });
      } catch (e) { sseSend(res, "error", { error: String(e?.message || e).slice(0, 200) }); }
      res.end(); return;
    }

    // 注入(先快照后覆写):自动档草稿 → 建一张 relay.card(四站通用交接物)写进讨论,前端再跳目标站
    const autoInject = url.pathname.match(/^\/api\/discussion\/([^/]+)\/autopilot\/inject$/);
    if (req.method === "POST" && autoInject) {
      const d = await getDiscussion(autoInject[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const target = ["relay", "council", "produce"].includes(body.target) ? body.target : "relay";
      const md = d.autoRun?.md;
      if (!md) return json(res, 400, { ok: false, error: "还没有自动档草稿可注入" });
      const missing = [];
      if (!md.direction) missing.push("direction(方向)");
      if (target === "council" && !(md.open_questions?.length)) missing.push("open_questions(待拍板≥1)");
      if (missing.length) return json(res, 400, { ok: false, missing });
      // 从全部轮次蒸出"成果":各轮署名观点 / 盲点 / 方向演进 —— 不是只带 direction 一句话
      const rounds = d.autoRun?.rounds || [];
      const uniq = (arr) => [...new Set(arr.filter((x) => x && String(x).trim()))];
      const viewpoints = uniq(rounds.map((r) => r.viewpoint?.text));
      const dissents = uniq(rounds.map((r) => r.viewpoint?.dissent));
      const blindSpots = uniq(rounds.flatMap((r) => r.eval?.blind_spots || []));
      const openIssues = uniq(rounds.flatMap((r) => r.eval?.open_issues || []));
      const angles = uniq(rounds.map((r) => r.lens?.name && r.fields?.direction ? `透镜「${r.lens.name}」→ ${r.fields.direction}` : null));
      // 厚交接文档(写进 solutionDoc:四站读的持久上游源 `ho = pendingHandoff || solutionDoc`)
      const H = [];
      H.push(`# 自动档粗稿 · ${(d.brief || "").split("\n")[0].slice(0, 50)}`);
      H.push("", `> 自动档跑了 ${rounds.length} 轮(导演调度 + Claude/OpenAI/DeepSeek 三脑并行 + 反熵防复读)蒸出的结构化粗稿,请基于它继续推进,别从零开始。`, "");
      H.push("## 一句话方向", md.direction || "(无)", "");
      if (md.open_questions?.length) { H.push("## 待拍板(需要你/议会定的关键决策)"); md.open_questions.forEach((q) => H.push("- " + q)); H.push(""); }
      if (md.artifacts_hint?.length) { H.push("## 建议产出物", md.artifacts_hint.join("、"), ""); }
      if (viewpoints.length) { H.push("## 各轮署名观点(讨论出来的实质)"); viewpoints.forEach((v) => H.push("- " + v)); H.push(""); }
      if (dissents.length) { H.push("## 分歧 / 反对意见"); dissents.forEach((v) => H.push("- " + v)); H.push(""); }
      if (blindSpots.length || openIssues.length) { H.push("## 盲点 / 未解问题"); uniq([...blindSpots, ...openIssues]).forEach((v) => H.push("- " + v)); H.push(""); }
      if (angles.length) { H.push("## 方向演进脉络"); angles.forEach((a) => H.push("- " + a)); H.push(""); }
      H.push("## 原始点子", md.brief_original || d.brief || "");
      const handoff = H.join("\n");
      // 厚方向卡(陪练直接看到的,不再只一句话)
      const card = { oneLine: md.direction, clear: viewpoints.slice(0, 6), expandedAngles: angles.slice(0, 6), assumptions: dissents.slice(0, 6), firstNarrowing: md.artifacts_hint?.length ? "建议先产出:" + md.artifacts_hint.join("、") : "", decisionsForYou: md.open_questions || [], inviteYourInput: "", dontBuildYet: uniq([...blindSpots, ...openIssues]).slice(0, 6) };
      const relay = { card, hops: [{ order: 1, seat: "自动档", role: "auto", lens: null, added: [], framing: null, failed: false, latencyMs: 0 }], auto: true, artifactsHint: md.artifacts_hint || [] };
      try {
        const state = { ...d.autoRun, injectBackup: { relay: d.relay || null, solutionDoc: d.solutionDoc || null, at: new Date().toISOString(), target, roundIndex: rounds.length } };
        await setAutoRun(d.id, state); // 先快照(快照失败下面 catch,绝不裸覆写)
        await setSolutionDoc(d.id, handoff); // 厚成果写进持久上游源 → 议会/产出/陪练都读得到
        await saveRelay(d.id, relay);  // 方向卡覆写
        return json(res, 200, { ok: true, target, card, hasBackup: true });
      } catch (e) {
        return json(res, 500, { ok: false, error: "注入失败: " + String(e?.message || e).slice(0, 120) });
      }
    }

    // 还原(一键):把注入前的 relay 快照写回
    const autoRestore = url.pathname.match(/^\/api\/discussion\/([^/]+)\/autopilot\/restore$/);
    if (req.method === "POST" && autoRestore) {
      const d = await getDiscussion(autoRestore[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const bk = d.autoRun?.injectBackup;
      if (!bk) return json(res, 400, { ok: false, error: "没有可还原的快照" });
      await saveRelay(d.id, bk.relay || null);
      await setSolutionDoc(d.id, bk.solutionDoc || null);
      const state = { ...d.autoRun }; delete state.injectBackup;
      await setAutoRun(d.id, state);
      return json(res, 200, { ok: true });
    }

    // 重置自动档 run
    const autoReset = url.pathname.match(/^\/api\/discussion\/([^/]+)\/autopilot\/reset$/);
    if (req.method === "POST" && autoReset) {
      const d = await getDiscussion(autoReset[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      await setAutoRun(d.id, null);
      return json(res, 200, { ok: true });
    }

    // 撤最后一轮(回退)
    const autoUndo = url.pathname.match(/^\/api\/discussion\/([^/]+)\/autopilot\/undo$/);
    if (req.method === "POST" && autoUndo) {
      const d = await getDiscussion(autoUndo[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const prev = d.autoRun;
      if (!prev?.rounds?.length) return json(res, 400, { ok: false, error: "no rounds to undo" });
      const rounds = prev.rounds.slice(0, -1);
      const md = rounds.length ? { brief_original: prev.md?.brief_original || d.brief, ...rounds[rounds.length - 1].fields } : null;
      await setAutoRun(d.id, { ...prev, rounds, md, bestRoundIndex: Math.min(prev.bestRoundIndex || 0, rounds.length - 1) });
      return json(res, 200, { ok: true, roundsLeft: rounds.length });
    }

    // ============ Skill 系统 ============
    // GET /api/skills[?station=produce] → L1 索引
    if (req.method === "GET" && url.pathname === "/api/skills") {
      const station = url.searchParams.get("station") || "";
      return json(res, 200, { ok: true, skills: listSkills(station) });
    }
    // GET /api/skills/:name → L2 正文 + refs 列表
    const skillLoad = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (req.method === "GET" && skillLoad) {
      const sk = loadSkill(skillLoad[1]);
      if (!sk) return json(res, 404, { ok: false, error: "skill not found" });
      return json(res, 200, { ok: true, skill: sk });
    }
    // GET /api/skills/:name/ref/:file → L3 参考文件
    const skillRef = url.pathname.match(/^\/api\/skills\/([^/]+)\/ref\/(.+)$/);
    if (req.method === "GET" && skillRef) {
      const content = loadSkillRef(skillRef[1], skillRef[2]);
      if (!content) return json(res, 404, { ok: false, error: "ref not found" });
      return json(res, 200, { ok: true, content });
    }
    // POST /api/skills → 保存(自动提炼)
    if (req.method === "POST" && url.pathname === "/api/skills") {
      const body = await readJson(req);
      const name = String(body.name || "").trim().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
      const description = String(body.description || "").trim().slice(0, 500);
      const station = String(body.station || "produce");
      const skillBody = String(body.body || "").trim().slice(0, 20000);
      if (!name || !skillBody) return json(res, 400, { ok: false, error: "name and body required" });
      const saved = saveSkill({ name, description, station, body: skillBody });
      return json(res, 200, { ok: true, skill: saved });
    }
    // GET /api/skills/suggest?brief=...&station=... → 自动推荐
    if (req.method === "GET" && url.pathname === "/api/skills/suggest") {
      const brief = url.searchParams.get("brief") || "";
      const station = url.searchParams.get("station") || "";
      const match = routeSkill(brief, station || undefined);
      return json(res, 200, { ok: true, suggestion: match || null });
    }

    // ============ Memory 层 ============
    // GET /api/memories → 当前用户的记忆列表
    if (req.method === "GET" && url.pathname === "/api/memories") {
      if (!userId) return json(res, 401, { ok: false, error: "未登录" });
      const mems = await getMemories(userId, 50);
      return json(res, 200, { ok: true, memories: mems });
    }
    // DELETE /api/memories/:id
    const memDel = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (req.method === "DELETE" && memDel) {
      if (!userId) return json(res, 401, { ok: false, error: "未登录" });
      await deleteMemory(memDel[1], userId);
      return json(res, 200, { ok: true });
    }

    // ============ Skill Proposals ============
    // GET /api/skill-proposals[?status=pending]
    if (req.method === "GET" && url.pathname === "/api/skill-proposals") {
      if (!userId) return json(res, 401, { ok: false, error: "未登录" });
      const status = url.searchParams.get("status") || "pending";
      const proposals = await getSkillProposals(userId, status);
      return json(res, 200, { ok: true, proposals });
    }
    // POST /api/skill-proposals/:id/approve → 审核通过,追加规则到对应 skill
    const propApprove = url.pathname.match(/^\/api\/skill-proposals\/([^/]+)\/approve$/);
    if (req.method === "POST" && propApprove) {
      if (!userId) return json(res, 401, { ok: false, error: "未登录" });
      const proposals = await getSkillProposals(userId, "pending");
      const prop = proposals.find((p) => p.id === propApprove[1]);
      if (!prop) return json(res, 404, { ok: false, error: "proposal not found" });
      // 追加规则到对应 skill
      const existing = loadSkill(prop.skill_name);
      if (existing) {
        const appendedBody = existing.body.trimEnd() + `\n\n### Learned Rule (${new Date().toISOString().slice(0, 10)})\n${prop.rule}`;
        saveSkill({ name: prop.skill_name, description: existing.meta?.description || "", station: existing.meta?.station || "global", body: appendedBody });
      }
      await updateSkillProposalStatus(prop.id, userId, "approved");
      return json(res, 200, { ok: true });
    }
    // POST /api/skill-proposals/:id/reject
    const propReject = url.pathname.match(/^\/api\/skill-proposals\/([^/]+)\/reject$/);
    if (req.method === "POST" && propReject) {
      if (!userId) return json(res, 401, { ok: false, error: "未登录" });
      await updateSkillProposalStatus(propReject[1], userId, "rejected");
      return json(res, 200, { ok: true });
    }

    // POST /api/discussion/:id/reflect → 生成 Reflection,存 memories + proposals
    const reflectMatch = url.pathname.match(/^\/api\/discussion\/([^/]+)\/reflect$/);
    if (req.method === "POST" && reflectMatch) {
      if (!userId) return json(res, 401, { ok: false, error: "未登录" });
      const d = await getDiscussion(reflectMatch[1]);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const autoRun = d.auto_run ? JSON.parse(d.auto_run) : null;
      const corrections = await listCorrectedTurns(d.id).then((turns) => turns.map((t) => t.correction).filter(Boolean)).catch(() => []);
      const byoKeys = parseByo(req);
      const result = await runReflection({
        brief: d.brief,
        rounds: autoRun?.rounds || [],
        corrections,
        byoKeys,
      });
      const mems = [
        ...(result.user_preferences || []).map((c) => ({ category: "preference", content: c })),
        ...(result.product_judgments || []).map((c) => ({ category: "product_judgment", content: c })),
      ];
      await saveMemories(userId, mems, d.id);
      await saveSkillProposals(userId, result.skill_candidates || [], d.id);
      return json(res, 200, { ok: true, memories: mems.length, proposals: (result.skill_candidates || []).length, raw: result });
    }

    // ============ 产出层(交付物)============
    // 可用产出厂商(含是否支持生图),供前端「换一家/改稿」下拉
    if (req.method === "GET" && url.pathname === "/api/produce-providers") {
      return json(res, 200, { ok: true, providers: listProduceProviders() });
    }

    // 角色库 + provider 列表(供选角配置 UI)
    if (req.method === "GET" && url.pathname === "/api/personas") {
      return json(res, 200, { ok: true, ...listPersonas(), providers: listProduceProviders().map((p) => ({ id: p.id, label: p.label })) });
    }

    // 选角配置持久化(按模式)
    if (req.method === "GET" && url.pathname === "/api/run-config") {
      const mode = url.searchParams.get("mode") === "copy" ? "copy" : "idea";
      return json(res, 200, { ok: true, runConfig: await getRunConfig(mode) });
    }
    if (req.method === "POST" && url.pathname === "/api/run-config") {
      const body = await readJson(req);
      const mode = body.mode === "copy" ? "copy" : "idea";
      if (!body.runConfig || typeof body.runConfig !== "object") return json(res, 400, { ok: false, error: "runConfig required" });
      return json(res, 200, { ok: true, runConfig: await saveRunConfig(mode, body.runConfig) });
    }

    // 产出一版交付物(SSE):draft / refine(fromArtifactId) / image
    const produce = url.pathname.match(/^\/api\/discussion\/([^/]+)\/produce$/);
    if (req.method === "POST" && produce) {
      const d = await getDiscussion(produce[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const type = String(body.type || "");
      const providerId = String(body.provider || "");
      const fromArtifactId = body.fromArtifactId ? String(body.fromArtifactId) : null;
      const rawInstruction = body.instruction ? String(body.instruction).slice(0, 2000) : "";
      const skillName = body.skillName ? String(body.skillName) : "";
      const loadedSkill = skillName ? loadSkill(skillName) : null;
      const instruction = loadedSkill
        ? `[Skill: ${loadedSkill.name}]\n${loadedSkill.body}\n\n---\n\n${rawInstruction}`
        : rawInstruction;
      // 交接来的方案文档(MD,如 方向卡/收敛方案 → 产出):优先作为产出的"方案源"
      const handoffDoc = typeof body.handoff === "string" ? body.handoff.trim().slice(0, 8000) : "";
      const validTypes = ["copy", "prd", "design_doc", "code_sketch", "image", "ppt", "html_proto", "critique"];
      if (!validTypes.includes(type)) return json(res, 400, { ok: false, error: "invalid type" });
      if (!providerId) return json(res, 400, { ok: false, error: "provider required" });

      sseHead(res);
      try {
        let sourceContent = "";
        let mode = "draft";
        if (fromArtifactId) {
          const src = await getArtifact(fromArtifactId);
          if (src) {
            sourceContent = src.content || "";
            mode = "refine";
          }
        }
        const convoCtx = buildTranscript(d.turns || [], 30);
        // 产出附件:用户在产出站直接附的图片/文档(让产出能当独立功能用 —— 仿参考图、改写素材)
        const attachCtx = await buildAttachmentContext(body.attachments, byoKeys);
        const baseBrief = convoCtx ? `${d.brief}\n\n想清楚阶段对话(理解项目的根基):\n${convoCtx}` : d.brief;
        // HTML 原型「配真图」开关(默认开):关掉则不生图,保留模型出的 picsum 占位(省额度/更快)
        const wantRealImg = body.realImg !== false;
        // 真图落成磁盘文件并以 URL 引用(不内联 base64 —— 否则 artifact content 几 MB,拖垮 getDiscussion)
        const saveProtoImage = wantRealImg
          ? async (b64) => {
              const dir = path.join(DATA_DIR, "artifacts", d.id);
              fs.mkdirSync(dir, { recursive: true });
              const fname = `proto-${randomUUID()}.png`;
              fs.writeFileSync(path.join(dir, fname), Buffer.from(b64, "base64"));
              return `/api/proto-asset/${d.id}/${fname}`;
            }
          : null;
        const out = await runProduce({
          type,
          mode,
          brief: baseBrief + attachCtx,
          conclusion: handoffDoc || d.conclusion,
          evidence: d.evidencePack?.items || [],
          sourceContent,
          instruction,
          providerId,
          byoKeys,
          saveProtoImage,
        });
        let saved;
        if (out.kind === "image") {
          const dir = path.join(DATA_DIR, "artifacts", d.id);
          fs.mkdirSync(dir, { recursive: true });
          const fname = `${randomUUID()}.png`;
          fs.writeFileSync(path.join(dir, fname), Buffer.from(out.b64, "base64"));
          const imagePath = path.join("artifacts", d.id, fname);
          saved = await saveArtifact({ discussionId: d.id, type, provider: out.provider, imagePath, parentId: fromArtifactId, mode, instruction });
        } else {
          saved = await saveArtifact({ discussionId: d.id, type, provider: out.provider, content: out.content, parentId: fromArtifactId, mode, instruction });
        }
        sseSend(res, "artifact", { ...saved, latencyMs: out.latencyMs });
        sseSend(res, "produce-done", { discussionId: d.id });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "produce failed" });
      }
      res.end();
      return;
    }

    // 马仔 Agent 执行任务(OpenAI Responses API + code_interpreter)
    const agentRun = url.pathname.match(/^\/api\/discussion\/([^/]+)\/agent$/);
    if (req.method === "POST" && agentRun) {
      const d = await getDiscussion(agentRun[1], req.userId);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const task = String(body.task || "").trim().slice(0, 2000);
      if (!task) return json(res, 400, { ok: false, error: "task required" });
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const agentSkillName = body.skillName ? String(body.skillName) : "";
      const agentLoadedSkill = agentSkillName ? loadSkill(agentSkillName) : null;
      const agentSkillText = agentLoadedSkill ? agentLoadedSkill.body : "";

      sseHead(res);
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      try {
        const convoCtx = buildTranscript(d.turns || [], 20);
        const brief = d.conclusion
          ? `${d.brief}\n\n## 方案结论\n${d.conclusion}`
          : convoCtx ? `${d.brief}\n\n## 讨论摘要\n${convoCtx}` : d.brief;
        await runAgentTask({
          brief,
          task,
          skillText: agentSkillText,
          byoKeys,
          signal: ctrl.signal,
          onEvent: (type, data) => sseSend(res, `agent-${type}`, data),
        });
        sseSend(res, "agent-done", {});
      } catch (err) {
        sseSend(res, "error", { error: err?.message || "agent failed" });
      }
      res.end();
      return;
    }

    // 采用某一版(同 type 内单选)
    const choose = url.pathname.match(/^\/api\/artifact\/([^/]+)\/choose$/);
    if (req.method === "POST" && choose) {
      const a = await chooseArtifact(choose[1]);
      return json(res, a ? 200 : 404, { ok: Boolean(a), artifact: a });
    }

    // 取交付物图片(本服务器首个二进制端点)
    const artImg = url.pathname.match(/^\/api\/artifact\/([^/]+)\/image$/);
    if (req.method === "GET" && artImg) {
      const a = await getArtifact(artImg[1]);
      if (!a || !a.imagePath) return json(res, 404, { ok: false, error: "not found" });
      try {
        const buf = fs.readFileSync(path.join(DATA_DIR, a.imagePath));
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(buf);
      } catch {
        return json(res, 404, { ok: false, error: "image missing" });
      }
      return;
    }

    // 删一条候选交付物(+ 删图文件)
    const artDel = url.pathname.match(/^\/api\/artifact\/([^/]+)$/);
    if (req.method === "DELETE" && artDel) {
      const art = await getArtifact(artDel[1]); // 先读内容,以便清 html_proto 内嵌的 proto-asset 图文件
      const { deleted, imagePath } = await deleteArtifact(artDel[1]);
      if (deleted) {
        if (imagePath) { try { fs.unlinkSync(path.join(DATA_DIR, imagePath)); } catch {} }
        // html_proto:真图是 /api/proto-asset/<did>/proto-*.png(URL 引用,藏在 content 里),逐个删
        if (art?.type === "html_proto" && art.content) {
          for (const mm of String(art.content).matchAll(/\/api\/proto-asset\/([0-9a-f-]{36})\/(proto-[0-9a-f-]{36}\.png)/g)) {
            const fp = path.join(DATA_DIR, "artifacts", mm[1], mm[2]);
            if (fp.startsWith(path.join(DATA_DIR, "artifacts") + path.sep)) { try { fs.unlinkSync(fp); } catch {} }
          }
        }
      }
      return json(res, deleted ? 200 : 404, { ok: deleted });
    }

    // 阶段 A:事实侦察 —— 先返回证据包,前端先得到价值(两段式)
    if (req.method === "POST" && url.pathname === "/api/evidence") {
      const body = await readJson(req);
      const brief = String(body.brief || "").trim();
      if (!brief) return json(res, 400, { ok: false, error: "brief is required" });
      const redacted = Boolean(body.redacted); // P7:用户可关检索
      const now = new Date();
      const pack = await buildEvidencePack({
        brief,
        mode: body.mode === "copy" ? "copy" : "idea", // 类别按模式(idea:竞品/开源/需求/定价/痛点;copy:viral/userVoice/...)
        redacted,
        nowIso: now.toISOString(),
        nowMs: now.getTime(),
      });
      return json(res, 200, { ok: true, pack });
    }

    // 生产:单进程托管 vite build 的静态前端(dist/);dev 下 dist 不存在 → 落到 404,由 vite 接管。
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const served = serveStatic(res, url.pathname);
      if (served) return;
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error?.message || "internal server error",
    });
  }
});

server.listen(port, () => {
  console.log(`[roast-api] listening on http://localhost:${port}`);
  const configured = getProviderStatus()
    .filter((provider) => provider.configured)
    .map((provider) => provider.label);
  console.log(
    `[roast-api] direct providers: ${configured.length ? configured.join(", ") : "none (add keys to .env.local)"}`,
  );
  // 启动即预热数据库:把 libSQL/Turso 的连接 + migrate(远程往返)挪到进程启动期,
  // 而不是压在冷启动后第一个用户请求上(否则首次点击会多等这部分)。
  getDb()
    .then(async () => {
      console.log("[roast-api] db ready (warmed)");
      // 用户体系启动迁移:确保站长账号存在,把历史遗留(无主)讨论一次性归给站长
      try {
        const owner = await upsertUser(OWNER_EMAIL);
        const n = await assignOrphanDiscussions(owner.id);
        if (n > 0) console.log(`[roast-api] 迁移 ${n} 条历史讨论给站长(${OWNER_EMAIL})`);
      } catch (e) { console.error("[roast-api] owner bootstrap failed:", e?.message || e); }
    })
    .catch((e) => console.error("[roast-api] db warmup failed:", e?.message || e));
});

async function safeCount() {
  try {
    return await countRunRecords();
  } catch {
    return 0;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};

// 托管 dist/ 静态资源 + SPA 回退 index.html。返回 true=已响应。dist 不存在(dev)→ false。
function serveStatic(res, pathname) {
  if (!fs.existsSync(STATIC_DIR)) return false;
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel.endsWith("/")) rel = "/index.html";
  let filePath = path.join(STATIC_DIR, rel);
  if (!filePath.startsWith(STATIC_DIR)) { json(res, 403, { ok: false, error: "forbidden" }); return true; }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (path.extname(rel)) return false; // 缺失的真·资源 → 走 404
    filePath = path.join(STATIC_DIR, "index.html"); // 无扩展名 → SPA 回退
    if (!fs.existsSync(filePath)) return false;
  }
  try {
    const buf = fs.readFileSync(filePath);
    const isIndex = filePath.endsWith("index.html");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
}

function sseSend(res, event, data) {
  // 错误消息净化:看着像 base64/二进制乱码(长 + 几乎全是 base64 字符)→ 换人话;否则截断,避免甩一墙到前端
  if (event === "error" && data && typeof data.error === "string") {
    let m = data.error;
    const head = m.slice(0, 240);
    const b64ish = m.length > 120 && /^[A-Za-z0-9+/=\s]+$/.test(head) && !/\s/.test(head.slice(0, 80));
    if (b64ish) m = "上游返回了无法识别的内容(某个模型/上游异常)。重试一下,或换「对话搭子」数量。";
    else if (m.length > 280) m = m.slice(0, 280) + "…";
    data = { ...data, error: m };
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 把侦察简报回写进 pack:挂 brief + 按 LLM「内容判定」重排证据类目(来源粗分常不准)+ 重建 byCategory,让维度真分布。
function applyEvidenceBrief(pack, brief) {
  if (!brief) return;
  pack.brief = brief;
  for (const it of pack.items || []) {
    // 1) LLM 按内容重判类目(比来源粗分准)
    if (brief.categories && brief.categories[it.id]) it.category = brief.categories[it.id];
    // 2) 强信号硬规则覆盖:应用商店/Show HN/GitHub 条目就是已存在的竞品(LLM 常误判成"需求")
    const t = `${it.title || ""} ${it.url || ""}`.toLowerCase();
    if (it.source === "github" || /app store|apps\.apple|play\.google|google play|应用商店|appstore|microsoft store|show hn/.test(t)) it.category = "competitor";
  }
  const by = {};
  for (const it of pack.items || []) (by[it.category] || (by[it.category] = [])).push(it.id);
  pack.byCategory = by;
}

// 引用校验:evidenceId 必须真实存在于信息板,否则 valid=false(UI 标红)
function validateCitations(citations, pack) {
  const ids = new Set((pack?.items || []).map((i) => i.id));
  return (citations || []).map((c) => ({
    evidenceId: c.evidenceId,
    valid: Boolean(c.evidenceId && ids.has(c.evidenceId)),
  }));
}

// turns → 喂回模型的 transcript(滚动窗口控制上下文增长)
function buildTranscript(turns, limit = 12) {
  return (turns || [])
    .slice(-limit)
    .map((t) => `${t.speaker}(${t.role}): ${t.body}`)
    .join("\n");
}

// 用户点赞(重视)的发言 → 高权重优先项,喂主脑/合成
async function pinnedBlock(discussionId) {
  const pins = await listPinnedTurns(discussionId);
  if (!pins.length) return "";
  const lines = pins.map((p, i) => `${i + 1}. ${p.role === "user" || p.speaker === "you" ? "你强调:" : p.speaker + "(被你点赞):"}${String(p.body || "").slice(0, 300)}`);
  return `\n\n⭐ 用户特别重视/点赞的几点(请优先照顾,务必体现在回应与最终方案里):\n${lines.join("\n")}`;
}
// 纠偏块:用户判定跑偏的方向(广播给后续每个脑 + 出方向卡当"已排除方向")。点赞块的反面。
async function correctionBlock(discussionId) {
  const cs = await listCorrectedTurns(discussionId);
  if (!cs.length) return "";
  const lines = cs.map((c, i) => `${i + 1}. ${String(c.correction || "").slice(0, 400)}`);
  return `\n\n🚫 用户纠偏(以下方向被用户判定跑偏,后续别再沿此走,按纠正方向调整):\n${lines.join("\n")}`;
}

// 单条发言:校验引用 → 落库(失败不阻断)→ SSE 推;失败 agent 只推降级、不落库、不伪造。
async function emitTurn(res, discussionId, turn, pack) {
  if (turn.failed) {
    sseSend(res, "turn", { failed: true, speaker: turn.speaker, role: turn.role, round: turn.round, error: turn.error });
    return;
  }
  const citations = validateCitations(turn.citations, pack);
  let stored = null;
  try {
    stored = await addTurn({
      discussionId,
      round: turn.round,
      speaker: turn.speaker,
      role: turn.role,
      body: turn.body,
      citations,
      latencyMs: turn.latencyMs,
    });
  } catch (error) {
    console.error("[roast-api] addTurn failed:", error?.message || error);
  }
  sseSend(res, "turn", {
    id: stored?.id,
    seq: stored?.seq,
    speaker: turn.speaker,
    standInFor: turn.standInFor || null,
    role: turn.role,
    round: turn.round,
    body: turn.body,
    citations,
    askUser: turn.askUser,
    latencyMs: turn.latencyMs,
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
