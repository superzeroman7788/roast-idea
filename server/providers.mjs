import {
  buildSeatPrompt,
  assignAngles,
  ROLE_ANGLES,
  buildTurnPrompt,
  buildFinalizePrompt,
  assignDiscussionRoles,
  DISCUSSION_ROLES,
} from "./prompts.mjs";

const OPENAI_COMPATIBLE = [
  {
    id: "openai",
    label: "OpenAI",
    env: ["OPENAI_API_KEY"],
    baseURL: "https://api.openai.com/v1",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "kimi",
    label: "Kimi",
    env: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    baseURL: "https://api.moonshot.cn/v1",
    modelEnv: "KIMI_MODEL",
    defaultModel: "moonshot-v1-8k",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    baseURL: "https://api.deepseek.com",
    modelEnv: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-chat",
  },
  {
    id: "qwen",
    label: "Qwen",
    env: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelEnv: "QWEN_MODEL",
    defaultModel: "qwen-turbo",
  },
];

const ANTHROPIC = {
  id: "claude",
  label: "Claude",
  env: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  modelEnv: "ANTHROPIC_MODEL",
  defaultModel: "claude-3-5-haiku-latest",
};

const ALL = [...OPENAI_COMPATIBLE, ANTHROPIC];

function firstEnv(keys) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

// BYO-key 中转(PRD web 版命门):优先用请求里带的 key(byoKeys[providerId]),
// 回落到服务端 .env(仅开发/“免费试一次”用)。服务端只中转、不落库 key。
function resolveKey(provider, byoKeys) {
  const fromRequest = byoKeys?.[provider.id]?.trim?.();
  if (fromRequest) return fromRequest;
  return firstEnv(provider.env);
}

export function getProviderStatus(byoKeys) {
  return ALL.map((provider) => ({
    id: provider.id,
    label: provider.label,
    model: process.env[provider.modelEnv] || provider.defaultModel,
    configured: Boolean(resolveKey(provider, byoKeys)),
    protocol: provider.id === "claude" ? "anthropic-messages" : "openai-compatible",
  }));
}

// 跑真实议会席位:已配置 provider → 分配对抗角度(保证魔鬼代言人)→ 并行直连。
// 失败走 Promise.allSettled,进 failures,绝不用默认文案伪装成有效席位(P1/§6.7)。
function buildRuns({ mode, brief, byoKeys, evidence }) {
  const configured = ALL.map((provider) => ({ provider, apiKey: resolveKey(provider, byoKeys) }))
    .filter((entry) => entry.apiKey);
  const angles = assignAngles(configured.length);
  return configured.map((entry, index) => {
    const angle = angles[index];
    const isAnthropic = entry.provider.id === "claude";
    const input = { mode, brief, angle, apiKey: entry.apiKey, evidence };
    return {
      label: entry.provider.label,
      angle,
      run: () =>
        isAnthropic
          ? runAnthropic(entry.provider, input)
          : runOpenAICompatible(entry.provider, input),
    };
  });
}

// 流式:每个 provider 真实完成(成功/失败)即回调 onSeat,顺序=真实延迟(快的先亮)。
// 失败进结果不伪造(P1/§6.7)。返回完整结果数组。
export async function runConfiguredProvidersStream(input, onSeat) {
  const runs = buildRuns(input);
  const results = new Array(runs.length);
  await Promise.all(
    runs.map(async (r, i) => {
      try {
        results[i] = await r.run();
      } catch (e) {
        results[i] = {
          ok: false,
          provider: r.label,
          roleAngle: r.angle,
          error: compact(e?.message || String(e)),
        };
      }
      if (onSeat) onSeat(results[i]);
    }),
  );
  return results;
}

export async function runConfiguredProviders(input) {
  return runConfiguredProvidersStream(input, null);
}

async function runOpenAICompatible(provider, { mode, brief, angle, apiKey, evidence }) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const messages = buildSeatPrompt({ mode, provider: provider.label, angle, brief, evidence });
  const started = Date.now();
  const response = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: provider.id === "deepseek" ? 0.7 : 0.55,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${provider.label} ${response.status}: ${text.slice(0, 220)}`);
  }

  const json = await response.json();
  const rawText = json.choices?.[0]?.message?.content || "";
  return normalizeSeat({
    provider: provider.label,
    angle,
    model,
    rawText,
    latencyMs: Date.now() - started,
  });
}

async function runAnthropic(provider, { mode, brief, angle, apiKey, evidence }) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const [system, user] = buildSeatPrompt({ mode, provider: provider.label, angle, brief, evidence });
  const started = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      temperature: 0.55,
      system: system.content,
      messages: [{ role: "user", content: user.content }],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Claude ${response.status}: ${text.slice(0, 220)}`);
  }

  const json = await response.json();
  const rawText = json.content?.map((part) => part.text || "").join("\n") || "";
  return normalizeSeat({
    provider: provider.label,
    angle,
    model,
    rawText,
    latencyMs: Date.now() - started,
  });
}

// 不伪造(§6.7):解析失败或无有效 stance → 抛错,该席位进 failures,
// 绝不用默认文案填充成"有效席位"。take 回落到模型真实原文(不是编的)。
function normalizeSeat({ provider, angle, model, rawText, latencyMs }) {
  let parsed;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    throw new Error(`${provider} returned unparseable output (no valid JSON seat)`);
  }
  const stance = normalizeStance(parsed.stance);
  if (!stance) {
    throw new Error(`${provider} returned no valid stance (Ship/Fix/Pause/Kill)`);
  }

  const objections = Array.isArray(parsed.objections)
    ? parsed.objections
        .map((item) => ({
          text: clean(typeof item === "string" ? item : item?.text),
          evidenceId: (item && typeof item === "object" && item.evidenceId) || null,
          valid: false, // P4 引用校验前一律 false;有证据层后再置真
        }))
        .filter((item) => item.text)
    : [];

  return {
    ok: true,
    provider,
    model,
    roleAngle: angle,
    role: ROLE_ANGLES[angle]?.label || angle,
    latencyMs,
    stance,
    take: clean(parsed.take) || clean(rawText).slice(0, 420),
    objections,
    fatalAssumption: clean(parsed.fatalAssumption),
    cheapestTest: clean(parsed.cheapestTest),
    debateLine: clean(parsed.debateLine),
  };
}

function normalizeStance(value) {
  return ["Ship", "Fix", "Pause", "Kill"].includes(value) ? value : null;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compact(text) {
  return String(text || "unknown error").replace(/\s+/g, " ").slice(0, 240);
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found");
  return match[0];
}

// ============ 讨论式陪练(讨论重构)============

export function getConfiguredProviders(byoKeys) {
  return ALL.map((provider) => ({ provider, apiKey: resolveKey(provider, byoKeys) })).filter(
    (e) => e.apiKey,
  );
}

// 角色→provider 固定映射(host 首位稳定),整场复用。
export function assignDiscussionSeats(byoKeys) {
  const configured = getConfiguredProviders(byoKeys);
  const roles = assignDiscussionRoles(configured.length);
  return configured.map((e, i) => ({ id: e.provider.id, label: e.provider.label, role: roles[i] }));
}

// 统一聊天调用:Anthropic vs OpenAI 兼容;jsonMode 控制是否强制 JSON(finalize 出 markdown 不用)。
async function chatRaw(provider, apiKey, messages, { jsonMode = true } = {}) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  if (provider.id === "claude") {
    const [system, user] = messages;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 1100,
        temperature: 0.6,
        system: system.content,
        messages: [{ role: "user", content: user.content }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = await res.json();
    return json.content?.map((p) => p.text || "").join("\n") || "";
  }
  const body = { model, messages, temperature: 0.6 };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`${provider.label} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

// 解析一条讨论发言;空 body / 不可解析 → 抛错(不伪造),由调用方降级。
function parseTurnJson(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    throw new Error("unparseable turn (no valid JSON)");
  }
  const body = clean(parsed.body);
  if (!body) throw new Error("empty turn body");
  const citations = Array.isArray(parsed.citations)
    ? parsed.citations
        .map((c) => ({
          evidenceId: (c && typeof c === "object" ? c.evidenceId : c) || null,
          valid: false, // validateCitations 事后置真
        }))
        .filter((c) => c.evidenceId)
    : [];
  return { body, citations, askUser: clean(parsed.askUser) };
}

// 跑一轮讨论:每个 seat(角色)并行发一条,完成即 onTurn 回调(真实顺序);失败进降级不伪造。
export async function runDiscussionRound(
  { mode, brief, evidence, transcript, userTurn, seats, byoKeys, round },
  onTurn,
) {
  const results = [];
  await Promise.all(
    seats.map(async (seat) => {
      const provider = ALL.find((p) => p.id === seat.id);
      const apiKey = provider ? resolveKey(provider, byoKeys) : "";
      if (!provider || !apiKey) {
        if (onTurn) onTurn({ failed: true, speaker: seat.label, role: seat.role, round, error: "not configured" });
        return;
      }
      const started = Date.now();
      try {
        const messages = buildTurnPrompt({ mode, provider: seat.label, role: seat.role, brief, evidence, transcript, userTurn });
        const rawText = await chatRaw(provider, apiKey, messages, { jsonMode: true });
        const parsed = parseTurnJson(rawText);
        const turn = {
          ok: true,
          speaker: seat.label,
          role: seat.role,
          round,
          body: parsed.body,
          citations: parsed.citations,
          askUser: parsed.askUser,
          latencyMs: Date.now() - started,
        };
        results.push(turn);
        if (onTurn) onTurn(turn);
      } catch (e) {
        if (onTurn) onTurn({ failed: true, speaker: seat.label, role: seat.role, round, error: compact(e?.message || String(e)) });
      }
    }),
  );
  return results;
}

// finalize:选一个 provider 当综合者(默认 host 那家),出 markdown 方案。
export async function runFinalize({ mode, brief, evidence, transcript, byoKeys, providerId }) {
  const seats = assignDiscussionSeats(byoKeys);
  const chosen = providerId || seats.find((s) => s.role === "host")?.id || seats[0]?.id;
  const provider = ALL.find((p) => p.id === chosen);
  const apiKey = provider ? resolveKey(provider, byoKeys) : "";
  if (!provider || !apiKey) throw new Error("no configured provider for finalize");
  const messages = buildFinalizePrompt({ mode, brief, evidence, transcript });
  const md = await chatRaw(provider, apiKey, messages, { jsonMode: false });
  return { conclusion: clean(md), by: provider.label };
}
