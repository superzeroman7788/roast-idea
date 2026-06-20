import { buildSeatPrompt, providerRole } from "./prompts.mjs";

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

function firstEnv(keys) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

export function getProviderStatus() {
  return [
    ...OPENAI_COMPATIBLE.map((provider) => ({
      id: provider.id,
      label: provider.label,
      model: process.env[provider.modelEnv] || provider.defaultModel,
      configured: Boolean(firstEnv(provider.env)),
      protocol: "openai-compatible",
    })),
    {
      id: ANTHROPIC.id,
      label: ANTHROPIC.label,
      model: process.env[ANTHROPIC.modelEnv] || ANTHROPIC.defaultModel,
      configured: Boolean(firstEnv(ANTHROPIC.env)),
      protocol: "anthropic-messages",
    },
  ];
}

export async function runConfiguredProviders({ mode, brief }) {
  const tasks = [];
  for (const provider of OPENAI_COMPATIBLE) {
    if (firstEnv(provider.env)) tasks.push(runOpenAICompatible(provider, { mode, brief }));
  }
  if (firstEnv(ANTHROPIC.env)) tasks.push(runAnthropic({ mode, brief }));

  const settled = await Promise.allSettled(tasks);
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      ok: false,
      provider: tasks[index]?.providerLabel || "Unknown",
      error: result.reason?.message || String(result.reason),
    };
  });
}

async function runOpenAICompatible(provider, input) {
  const apiKey = firstEnv(provider.env);
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const role = providerRole(provider.label);
  const messages = buildSeatPrompt({
    mode: input.mode,
    provider: provider.label,
    role,
    brief: input.brief,
  });
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
    role,
    model,
    rawText,
    latencyMs: Date.now() - started,
  });
}

async function runAnthropic(input) {
  const apiKey = firstEnv(ANTHROPIC.env);
  const model = process.env[ANTHROPIC.modelEnv] || ANTHROPIC.defaultModel;
  const role = providerRole(ANTHROPIC.label);
  const messages = buildSeatPrompt({
    mode: input.mode,
    provider: ANTHROPIC.label,
    role,
    brief: input.brief,
  });
  const [system, user] = messages;
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
    provider: ANTHROPIC.label,
    role,
    model,
    rawText,
    latencyMs: Date.now() - started,
  });
}

function normalizeSeat({ provider, role, model, rawText, latencyMs }) {
  let parsed;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    parsed = {};
  }
  return {
    ok: true,
    provider,
    role,
    model,
    latencyMs,
    stance: normalizeStance(parsed.stance),
    take: clean(parsed.take) || clean(rawText).slice(0, 420),
    blindspot: clean(parsed.blindspot) || "This provider did not name its blind spot clearly.",
    fatalAssumption:
      clean(parsed.fatalAssumption) ||
      "The provider did not isolate a fatal assumption.",
    cheapestTest:
      clean(parsed.cheapestTest) || "The provider did not propose a cheap validation test.",
    debateLine:
      clean(parsed.debateLine) ||
      "I need a sharper disagreement before this council is useful.",
  };
}

function normalizeStance(value) {
  return ["Ship", "Fix", "Pause", "Kill"].includes(value) ? value : "Fix";
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found");
  return match[0];
}
