import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv } from "./env.mjs";
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
  runConverge,
  listPersonas,
} from "./providers.mjs";
import { buildEvidencePack } from "./evidence.mjs";
import {
  countRunRecords,
  createDiscussion,
  addTurn,
  getDiscussion,
  finalizeDiscussion,
  listDiscussions,
  deleteDiscussion,
  saveArtifact,
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
  getRunConfig,
  saveRunConfig,
} from "./db.mjs";

loadEnv();

// PORT 优先(Render/Fly/Railway 等平台注入动态端口);本地回落 ROAST_API_PORT / 8787
const port = Number(process.env.PORT || process.env.ROAST_API_PORT || 8787);
// 图片落盘根目录(与 db.mjs 的默认 data 目录一致)
const DATA_DIR = process.env.ROAST_DATA_DIR || path.join(process.cwd(), "data");
// 生产:vite build 静态产物目录(单进程托管前端)
const STATIC_DIR = process.env.ROAST_STATIC_DIR || path.join(process.cwd(), "dist");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      const providers = getProviderStatus();
      return json(res, 200, {
        ok: providers.some((provider) => provider.configured),
        providers,
        runs: safeCount(),
        authRequired: Boolean(process.env.ROAST_ACCESS_PASSWORD),
      });
    }

    // 内部分发软门:校验访问密码(ROAST_ACCESS_PASSWORD,不进前端包/不进 git)。
    // 未设密码 → 门默认开。密码错误不透露任何细节。
    if (req.method === "POST" && url.pathname === "/api/auth") {
      const body = await readJson(req);
      const required = process.env.ROAST_ACCESS_PASSWORD;
      if (!required) return json(res, 200, { ok: true, open: true });
      const ok = typeof body.password === "string" && body.password === required;
      return json(res, ok ? 200 : 401, { ok });
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
        }
        // 用户排除的证据 id 列表(前端传来,不进议会)
        const excludedIds = new Set(Array.isArray(body.excludedIds) ? body.excludedIds : []);
        const evidenceForAgents = (pack.items || []).filter((it) => !excludedIds.has(it.id));
        sseSend(res, "board", { pack });

        // 附件:图片→视觉转文字 / 文本文件→正文,注入点子(供整场讨论参考)
        const attachCtx = await buildAttachmentContext(body.attachments, byoKeys);
        const fullBrief = brief + attachCtx;

        const title = brief.split("\n")[0].slice(0, 60);
        const discussionId = createDiscussion({ mode, title, brief: fullBrief, evidencePack: pack, roles: seats });
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

    // 历史列表:过往讨论(标题/模式/状态/时间),供前端「历史」面板浏览
    if (req.method === "GET" && url.pathname === "/api/discussions") {
      return json(res, 200, { ok: true, discussions: listDiscussions(100) });
    }

    // 恢复会话
    const detail = url.pathname.match(/^\/api\/discussion\/([^/]+)$/);
    if (req.method === "GET" && detail) {
      const d = getDiscussion(detail[1]);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      return json(res, 200, { ok: true, discussion: d });
    }

    // 删除一场讨论(本地数据,用户主动清理)
    if (req.method === "DELETE" && detail) {
      const ok = deleteDiscussion(detail[1]);
      return json(res, ok ? 200 : 404, { ok });
    }

    // 用户插话(userTurn 为空 = "再辩一轮")→ 跑一轮 agent 回应
    const respond = url.pathname.match(/^\/api\/discussion\/([^/]+)\/respond$/);
    if (req.method === "POST" && respond) {
      const d = getDiscussion(respond[1]);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      if (d.status === "finalized") return json(res, 400, { ok: false, error: "discussion finalized" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const userTurn = String(body.userTurn || "").trim();
      // clarify(想清楚):N 个协同搭子(同模型不同角度,host/builder,非对抗);solo:只主脑;否则全议会
      const clarify = Boolean(body.clarify);
      const participants = Math.max(1, Math.min(3, Number(body.participants) || 1));
      const solo = Boolean(body.solo);
      const allSeats = d.roles?.length ? d.roles : assignDiscussionSeats(byoKeys);
      const CLARIFY_ROLES = ["host", "builder", "builder"];
      const seats = clarify
        ? allSeats.slice(0, participants).map((s, i) => ({ ...s, role: CLARIFY_ROLES[i] || "builder" }))
        : solo ? allSeats.filter((s) => s.role === "host") : allSeats;
      const round = Math.max(0, ...d.turns.map((t) => t.round)) + 1;

      sseHead(res);
      try {
        // 附件注入:UI 时间线只存用户原话,喂给 agent 的带附件内容
        const attachCtx = await buildAttachmentContext(body.attachments, byoKeys);
        const effUserTurn = (userTurn + attachCtx).trim();
        if (userTurn || attachCtx) {
          addTurn({ discussionId: d.id, round, speaker: "you", role: "user", body: userTurn || "(已附附件)", citations: [] });
        }
        const priorTurns = userTurn || attachCtx ? [...d.turns, { speaker: "you", role: "user", body: effUserTurn }] : d.turns;
        const transcript = buildTranscript(priorTurns);
        await runDiscussionRound(
          { mode: d.mode, brief: d.brief, evidence: d.evidencePack?.items || [], transcript, userTurn: effUserTurn, seats, byoKeys, round },
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
      const d = getDiscussion(finalize[1]);
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
        finalizeDiscussion(d.id, conclusion);
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
      const d = getDiscussion(converge[1]);
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
        finalizeDiscussion(d.id, conclusion, converged);
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
      const d = getDiscussion(deliberate[1]);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;

      sseHead(res);
      try {
        clearViewpoints(d.id); // 重跑覆盖旧观点
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
        const convo = buildTranscript(d.turns || [], 40);
        let effBrief = d.brief;
        if (convo) effBrief += `\n\n想清楚阶段的完整对话(理解这个项目的根基,优先于初稿):\n${convo}`;
        if (handoffDoc) effBrief += `\n\n上一站交接来的方案文档(请基于它推进):\n${handoffDoc}`;
        if (posture === "clarify") {
          // 想清楚:跨模型接力(串行跑 Spec lenses)→ 方向卡。不召反方/不裁决。
          const relayRes = await runRelay(
            { mode: d.mode, brief: effBrief, evidence: evidenceForAgents, byoKeys, runConfig },
            (ev, data) => {
              if (ev === "relay-hop") sseSend(res, "relay-hop", data);
              else if (ev === "relay-card") sseSend(res, "relay-card", data);
              else if (ev === "seat-failed") sseSend(res, "seat-failed", data);
              else if (ev === "error") sseSend(res, "error", data);
            },
          );
          try { saveRelay(d.id, relayRes); } catch (e) { console.error("[roast-api] saveRelay failed:", e?.message || e); }
        } else {
        await runDeliberation(
          { mode: d.mode, brief: effBrief, evidence: evidenceForAgents, byoKeys, runConfig, posture },
          (ev, data) => {
            if (ev === "viewpoint") {
              // 引用校验:丢弃不存在于信息板的证据 id(不编造)
              const evidenceIds = (data.evidenceIds || []).filter((id) => validIds.has(id));
              let saved = null;
              try { saved = saveViewpoint({ discussionId: d.id, ...data, evidenceIds }); }
              catch (e) { console.error("[roast-api] saveViewpoint failed:", e?.message || e); }
              if (data.round === 2) round2Ids.push(saved?.id || null);
              sseSend(res, "viewpoint", saved || { ...data, evidenceIds });
            } else if (ev === "verification") {
              const id = round2Ids[data.index];
              if (id) {
                try { updateViewpointVerification(id, data.verification); }
                catch (e) { console.error("[roast-api] updateViewpointVerification failed:", e?.message || e); }
                sseSend(res, "verification", { id, verification: data.verification });
              }
            } else if (ev === "deliberation") {
              let saved = null;
              try { saved = saveDeliberation({ discussionId: d.id, ...data }); }
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
      const d = getDiscussion(signal[1]);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const viewpointId = String(body.viewpointId || "");
      const action = String(body.action || "");
      const note = body.note ? String(body.note).slice(0, 1000) : "";
      if (!viewpointId || !["endorse", "setAside", "pin", "reply", "clear"].includes(action)) {
        return json(res, 400, { ok: false, error: "bad signal" });
      }
      const saved = saveSignal({ discussionId: d.id, viewpointId, action, note });
      return json(res, 200, { ok: true, signal: { ...saved, viewpointId, action, note } });
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
      return json(res, 200, { ok: true, runConfig: getRunConfig(mode) });
    }
    if (req.method === "POST" && url.pathname === "/api/run-config") {
      const body = await readJson(req);
      const mode = body.mode === "copy" ? "copy" : "idea";
      if (!body.runConfig || typeof body.runConfig !== "object") return json(res, 400, { ok: false, error: "runConfig required" });
      return json(res, 200, { ok: true, runConfig: saveRunConfig(mode, body.runConfig) });
    }

    // 产出一版交付物(SSE):draft / refine(fromArtifactId) / image
    const produce = url.pathname.match(/^\/api\/discussion\/([^/]+)\/produce$/);
    if (req.method === "POST" && produce) {
      const d = getDiscussion(produce[1]);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      const body = await readJson(req);
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const type = String(body.type || "");
      const providerId = String(body.provider || "");
      const fromArtifactId = body.fromArtifactId ? String(body.fromArtifactId) : null;
      const instruction = body.instruction ? String(body.instruction).slice(0, 2000) : "";
      // 交接来的方案文档(MD,如 方向卡/收敛方案 → 产出):优先作为产出的"方案源"
      const handoffDoc = typeof body.handoff === "string" ? body.handoff.trim().slice(0, 8000) : "";
      const validTypes = ["copy", "prd", "design_doc", "code_sketch", "image"];
      if (!validTypes.includes(type)) return json(res, 400, { ok: false, error: "invalid type" });
      if (!providerId) return json(res, 400, { ok: false, error: "provider required" });

      sseHead(res);
      try {
        let sourceContent = "";
        let mode = "draft";
        if (fromArtifactId) {
          const src = getArtifact(fromArtifactId);
          if (src) {
            sourceContent = src.content || "";
            mode = "refine";
          }
        }
        const convoCtx = buildTranscript(d.turns || [], 30);
        const out = await runProduce({
          type,
          mode,
          brief: convoCtx ? `${d.brief}\n\n想清楚阶段对话(理解项目的根基):\n${convoCtx}` : d.brief,
          conclusion: handoffDoc || d.conclusion,
          evidence: d.evidencePack?.items || [],
          sourceContent,
          instruction,
          providerId,
          byoKeys,
        });
        let saved;
        if (out.kind === "image") {
          const dir = path.join(DATA_DIR, "artifacts", d.id);
          fs.mkdirSync(dir, { recursive: true });
          const fname = `${randomUUID()}.png`;
          fs.writeFileSync(path.join(dir, fname), Buffer.from(out.b64, "base64"));
          const imagePath = path.join("artifacts", d.id, fname);
          saved = saveArtifact({ discussionId: d.id, type, provider: out.provider, imagePath, parentId: fromArtifactId, mode, instruction });
        } else {
          saved = saveArtifact({ discussionId: d.id, type, provider: out.provider, content: out.content, parentId: fromArtifactId, mode, instruction });
        }
        sseSend(res, "artifact", { ...saved, latencyMs: out.latencyMs });
        sseSend(res, "produce-done", { discussionId: d.id });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "produce failed" });
      }
      res.end();
      return;
    }

    // 采用某一版(同 type 内单选)
    const choose = url.pathname.match(/^\/api\/artifact\/([^/]+)\/choose$/);
    if (req.method === "POST" && choose) {
      const a = chooseArtifact(choose[1]);
      return json(res, a ? 200 : 404, { ok: Boolean(a), artifact: a });
    }

    // 取交付物图片(本服务器首个二进制端点)
    const artImg = url.pathname.match(/^\/api\/artifact\/([^/]+)\/image$/);
    if (req.method === "GET" && artImg) {
      const a = getArtifact(artImg[1]);
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
      const { deleted, imagePath } = deleteArtifact(artDel[1]);
      if (deleted && imagePath) {
        try { fs.unlinkSync(path.join(DATA_DIR, imagePath)); } catch {}
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
});

function safeCount() {
  try {
    return countRunRecords();
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
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

// 单条发言:校验引用 → 落库(失败不阻断)→ SSE 推;失败 agent 只推降级、不落库、不伪造。
function emitTurn(res, discussionId, turn, pack) {
  if (turn.failed) {
    sseSend(res, "turn", { failed: true, speaker: turn.speaker, role: turn.role, round: turn.round, error: turn.error });
    return;
  }
  const citations = validateCitations(turn.citations, pack);
  let stored = null;
  try {
    stored = addTurn({
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
