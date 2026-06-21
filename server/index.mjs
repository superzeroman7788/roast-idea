import http from "node:http";
import { loadEnv } from "./env.mjs";
import {
  getProviderStatus,
  runDiscussionRound,
  runFinalize,
  assignDiscussionSeats,
} from "./providers.mjs";
import { buildEvidencePack } from "./evidence.mjs";
import {
  countRunRecords,
  createDiscussion,
  addTurn,
  getDiscussion,
  finalizeDiscussion,
} from "./db.mjs";

loadEnv();

const port = Number(process.env.ROAST_API_PORT || 8787);

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
          items: [],
          byTheme: { competitors: [], demandSignals: [], pricing: [], saturation: [] },
          sources: [],
          redacted: true,
        };
        if (!redacted) {
          const now = new Date();
          pack = await buildEvidencePack({ brief, redacted: false, nowIso: now.toISOString(), nowMs: now.getTime() });
        }
        sseSend(res, "board", { pack });

        const title = brief.split("\n")[0].slice(0, 60);
        const discussionId = createDiscussion({ mode, title, brief, evidencePack: pack, roles: seats });
        sseSend(res, "discussion", { id: discussionId, mode, title, seats });

        // solo:只让主大脑(host)开场;否则全议会
        const solo = Boolean(body.solo);
        const roundSeats = solo ? seats.filter((s) => s.role === "host") : seats;
        await runDiscussionRound(
          { mode, brief, evidence: pack.items || [], transcript: "", userTurn: "", seats: roundSeats, byoKeys, round: 1 },
          (turn) => emitTurn(res, discussionId, turn, pack),
        );
        sseSend(res, "round-done", { discussionId, round: 1 });
      } catch (error) {
        sseSend(res, "error", { error: error?.message || "start failed" });
      }
      res.end();
      return;
    }

    // 恢复会话
    const detail = url.pathname.match(/^\/api\/discussion\/([^/]+)$/);
    if (req.method === "GET" && detail) {
      const d = getDiscussion(detail[1]);
      if (!d) return json(res, 404, { ok: false, error: "not found" });
      return json(res, 200, { ok: true, discussion: d });
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
      // solo:只让主大脑(host)回应;否则全议会(引入辩论者后)
      const solo = Boolean(body.solo);
      const allSeats = d.roles?.length ? d.roles : assignDiscussionSeats(byoKeys);
      const seats = solo ? allSeats.filter((s) => s.role === "host") : allSeats;
      const round = Math.max(0, ...d.turns.map((t) => t.round)) + 1;

      sseHead(res);
      try {
        if (userTurn) {
          addTurn({ discussionId: d.id, round, speaker: "you", role: "user", body: userTurn, citations: [] });
        }
        const priorTurns = userTurn ? [...d.turns, { speaker: "you", role: "user", body: userTurn }] : d.turns;
        const transcript = buildTranscript(priorTurns);
        await runDiscussionRound(
          { mode: d.mode, brief: d.brief, evidence: d.evidencePack?.items || [], transcript, userTurn, seats, byoKeys, round },
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

    // 阶段 A:事实侦察 —— 先返回证据包,前端先得到价值(两段式)
    if (req.method === "POST" && url.pathname === "/api/evidence") {
      const body = await readJson(req);
      const brief = String(body.brief || "").trim();
      if (!brief) return json(res, 400, { ok: false, error: "brief is required" });
      const redacted = Boolean(body.redacted); // P7:用户可关检索
      const now = new Date();
      const pack = await buildEvidencePack({
        brief,
        redacted,
        nowIso: now.toISOString(),
        nowMs: now.getTime(),
      });
      return json(res, 200, { ok: true, pack });
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
