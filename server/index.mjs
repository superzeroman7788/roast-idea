import http from "node:http";
import { randomUUID } from "node:crypto";
import { loadEnv } from "./env.mjs";
import {
  getProviderStatus,
  runConfiguredProviders,
  runConfiguredProvidersStream,
} from "./providers.mjs";
import { buildReport } from "./report.mjs";
import { buildEvidencePack } from "./evidence.mjs";
import { saveRunRecord, countRunRecords } from "./db.mjs";

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
      });
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

    // 流式版:SSE,模型按真实完成顺序逐个推送(快的先亮)
    if (req.method === "POST" && url.pathname === "/api/roast/stream") {
      const body = await readJson(req);
      const mode = body.mode === "copy" ? "copy" : "idea";
      const brief = String(body.brief || "").trim();
      if (!brief) return json(res, 400, { ok: false, error: "brief is required" });
      if (brief.length > 12000) return json(res, 400, { ok: false, error: "brief is too long" });
      const byoKeys = body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const redacted = Boolean(body.redacted);

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      try {
        // 阶段 A:事实侦察
        let evidencePack =
          body.evidencePack && typeof body.evidencePack === "object" ? body.evidencePack : null;
        if (!evidencePack) {
          const now = new Date();
          evidencePack = await buildEvidencePack({
            brief,
            redacted,
            nowIso: now.toISOString(),
            nowMs: now.getTime(),
          });
        }
        send("evidence", { pack: evidencePack });

        // 阶段 B:议会流式(每个 provider 真实完成即推)
        const status = getProviderStatus(byoKeys);
        const results = await runConfiguredProvidersStream(
          { mode, brief, byoKeys, evidence: evidencePack.items || [] },
          (seat) => send("seat", seat),
        );

        // 引用校验 + 聚合裁决 + 落库
        const report = buildReport({ mode, brief, results, status, evidencePack });
        const record = {
          id: randomUUID(),
          mode,
          brief,
          evidencePack,
          seats: results,
          verdict: {
            decision: report.verdict,
            aggregatedFrom: report.live.providerCount,
            dissentLevel: report.dissentLevel,
            simulated: report.live.simulated,
          },
          createdAt: new Date().toISOString(),
        };
        try {
          saveRunRecord(record);
        } catch (error) {
          console.error("[roast-api] persist failed:", error?.message || error);
        }
        send("verdict", { runId: record.id, report });
      } catch (error) {
        send("error", { error: error?.message || "stream failed" });
      }
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/roast") {
      const body = await readJson(req);
      const mode = body.mode === "copy" ? "copy" : "idea";
      const brief = String(body.brief || "").trim();
      if (!brief) return json(res, 400, { ok: false, error: "brief is required" });
      if (brief.length > 12000) {
        return json(res, 400, { ok: false, error: "brief is too long" });
      }

      // BYO-key:用户前端可在请求里带各 provider 的 key,服务端只中转、绝不落库 key。
      const byoKeys =
        body.keys && typeof body.keys === "object" ? body.keys : undefined;
      const redacted = Boolean(body.redacted);

      // 证据包:优先用前端阶段 A 传回的同一份(保证展示=被引用一致);
      // 没传则现建(缓存命中近乎瞬时)。redacted 时为空包。
      let evidencePack =
        body.evidencePack && typeof body.evidencePack === "object" ? body.evidencePack : null;
      if (!evidencePack) {
        const now = new Date();
        evidencePack = await buildEvidencePack({
          brief,
          redacted,
          nowIso: now.toISOString(),
          nowMs: now.getTime(),
        });
      }

      const status = getProviderStatus(byoKeys);
      // 直连各 provider;失败走 Promise.allSettled,进 failures,不伪造(P1)
      const results = await runConfiguredProviders({
        mode,
        brief,
        byoKeys,
        evidence: evidencePack.items || [],
      });
      // buildReport 内做引用校验(evidenceId 不存在 → valid=false)
      const report = buildReport({ mode, brief, results, status, evidencePack });

      // 落库(护城河数据集):run + 证据 + 裁决
      const record = {
        id: randomUUID(),
        mode,
        brief,
        evidencePack,
        seats: results,
        verdict: {
          decision: report.verdict,
          aggregatedFrom: report.live.providerCount,
          dissentLevel: report.dissentLevel,
          simulated: report.live.simulated,
        },
        createdAt: new Date().toISOString(),
      };
      try {
        saveRunRecord(record);
      } catch (error) {
        // 落库失败不阻断返回,但要记录,绝不静默伪装成功
        console.error("[roast-api] persist failed:", error?.message || error);
      }

      return json(res, 200, { ok: true, runId: record.id, report, providers: status });
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
