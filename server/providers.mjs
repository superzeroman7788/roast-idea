import { buildSeatPrompt, assignAngles, ROLE_ANGLES } from "./prompts.mjs";

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
