import http from "node:http";
import { loadEnv } from "./env.mjs";
import { buildAgentGroupReport } from "./report.mjs";
import {
  getAgentGroupProviderStatus,
  getAgentGroupStatus,
  runAgentGroupCouncil,
} from "./agentGroupClient.mjs";

loadEnv();

const port = Number(process.env.ROAST_API_PORT || 8787);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      const agentGroup = await getAgentGroupStatus();
      return json(res, 200, {
        ok: agentGroup.ok,
        providers: getAgentGroupProviderStatus(),
        agentGroup,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/roast") {
      const body = await readJson(req);
      const mode = body.mode === "copy" ? "copy" : "idea";
      const brief = String(body.brief || "").trim();
      if (!brief) return json(res, 400, { ok: false, error: "brief is required" });
      if (brief.length > 12000) {
        return json(res, 400, { ok: false, error: "brief is too long" });
      }

      const council = await runAgentGroupCouncil({ mode, brief });
      const report = buildAgentGroupReport({ mode, council });
      return json(res, 200, {
        ok: true,
        report,
        providers: getAgentGroupProviderStatus(),
        agentGroup: await getAgentGroupStatus(),
      });
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
  const configured = getAgentGroupProviderStatus()
    .filter((provider) => provider.configured)
    .map((provider) => provider.label);
  console.log(
    `[roast-api] agent-group participants: ${configured.length ? configured.join(", ") : "none"}`,
  );
});

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
