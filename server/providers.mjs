import {
  buildSeatPrompt,
  assignAngles,
  ROLE_ANGLES,
  buildTurnPrompt,
  buildFinalizePrompt,
  assignDiscussionRoles,
  DISCUSSION_ROLES,
  buildProducePrompt,
  buildImagePrompt,
  buildOrganizerPrompt,
  buildClarifyPrompt,
  buildRelaySeedPrompt,
  buildRelayHopPrompt,
  buildRelaySynthPrompt,
  buildCriticViewpointsPrompt,
  buildChairmanSummaryPrompt,
  buildVerifierPrompt,
  buildConvergePrompt,
  buildCrossRebuttalPrompt,
  buildDomainDetectPrompt,
  PERSONAS,
  DEFAULT_RUN_CONFIG,
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
  // 从 agent-group 迁入(room.json 的两个"免费模型反方"):OpenAI 兼容协议。
  // noResponseFormat:这两家(尤其免费/聚合模型)未必支持 response_format:json_object,
  // 关掉以免 400;靠 prompt「只返回 JSON」+ extractJson 兜底解析。
  {
    id: "agnes",
    label: "Agnes",
    env: ["AGNES_API_KEY"],
    baseURL: "https://apihub.agnes-ai.com/v1",
    modelEnv: "AGNES_MODEL",
    defaultModel: "agnes-2.0-flash",
    noResponseFormat: true,
  },
  // OpenRouter 殿后(备选):免费模型偶发 429/较慢,放最后让轮询优先把关键席(主脑/魔鬼)
  // 分给更快的模型;OpenRouter 多落到可降级的 verifier 席。
  {
    id: "openrouter",
    label: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    baseURL: "https://openrouter.ai/api/v1",
    modelEnv: "OPENROUTER_MODEL",
    // 想换:OPENROUTER_MODEL=openrouter/auto(更快但可能付费)或其他 :free slug。
    defaultModel: "nex-agi/nex-n2-pro:free",
    noResponseFormat: true,
  },
];

const ANTHROPIC = {
  id: "claude",
  label: "Claude",
  env: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  modelEnv: "ANTHROPIC_MODEL",
  defaultModel: "claude-haiku-4-5-20251001",
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

// 瞬时失败退避重试:429/5xx/网络抖动/超时重试一次,救慢/抖 provider(Kimi/Agnes/OpenRouter 并发突发下的瞬时过载)。
// makeOpts 是工厂:每次 attempt 拿全新 options(AbortSignal.timeout 触发后不可复用)。最后一次失败照常返回/抛出,保留 seat-failed 文案。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
async function fetchRetry(url, makeOpts, tries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, makeOpts());
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || i >= tries - 1) return res;
      await res.text().catch(() => ""); // 释放连接再退避
    } catch (e) {
      if (i >= tries - 1) throw e; // 网络错误/超时:重试用尽才抛
    }
    await new Promise((r) => setTimeout(r, 700 * (i + 1))); // 0.7s → 1.4s 退避
  }
}

// 统一聊天调用:Anthropic vs OpenAI 兼容;jsonMode 控制是否强制 JSON(finalize 出 markdown 不用)。
async function chatRaw(provider, apiKey, messages, { jsonMode = true } = {}) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  if (provider.id === "claude") {
    const [system, user] = messages;
    const res = await fetchRetry("https://api.anthropic.com/v1/messages", () => ({
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
    }));
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = await res.json();
    return json.content?.map((p) => p.text || "").join("\n") || "";
  }
  const body = { model, messages, temperature: 0.6 };
  if (jsonMode && !provider.noResponseFormat) body.response_format = { type: "json_object" };
  const res = await fetchRetry(`${provider.baseURL}/chat/completions`, () => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  }));
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

// ============ 产出层(交付物)============
// 支持文生图的厂商(各家 API 形状不同,均已用真实 key 验证):
//  openai/agnes → /images/generations(OpenAI 兼容,返 b64 或 url)
//  qwen         → DashScope 通义万相异步原生端点 + 轮询(返 OSS url)
//  openrouter   → /chat/completions + modalities(返 data url,付费,无免费档)
const IMAGE_CONFIG = {
  openai: { mode: "openai-images", modelEnv: "OPENAI_IMAGE_MODEL", defaultModel: "gpt-image-1" },
  agnes: { mode: "openai-images", modelEnv: "AGNES_IMAGE_MODEL", defaultModel: "agnes-image-2.1-flash" },
  qwen: { mode: "dashscope-wanx", modelEnv: "QWEN_IMAGE_MODEL", defaultModel: "wan2.2-t2i-flash" },
  openrouter: { mode: "openrouter-chat", modelEnv: "OPENROUTER_IMAGE_MODEL", defaultModel: "google/gemini-2.5-flash-image" },
};
export const IMAGE_PROVIDER_IDS = Object.keys(IMAGE_CONFIG);

export function listProduceProviders(byoKeys) {
  return getConfiguredProviders(byoKeys).map((e) => ({
    id: e.provider.id,
    label: e.provider.label,
    image: IMAGE_PROVIDER_IDS.includes(e.provider.id),
  }));
}

// 把 http url 或 data: url 统一转成 base64(去掉 data 前缀;http 则下载)。
async function urlToB64(url) {
  if (url.startsWith("data:")) return url.slice(url.indexOf(",") + 1);
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`下载生成图失败 ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}

// OpenAI 兼容(openai / agnes):/images/generations
async function genOpenAIImages(provider, apiKey, prompt, cfg) {
  const model = process.env[cfg.modelEnv] || cfg.defaultModel;
  const body = { model, prompt, n: 1, size: "1024x1024" };
  if (/dall-e/i.test(model)) body.response_format = "b64_json"; // gpt-image-1 默认即 b64 且不接受该参数
  const res = await fetch(`${provider.baseURL}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${provider.label} 生图 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()).data?.[0] || {};
  if (d.b64_json) return d.b64_json;
  if (d.url) return urlToB64(d.url);
  throw new Error(`${provider.label} 生图返回空`);
}

// Qwen 通义万相:异步提交 → 轮询 → OSS url
async function genQwenWanx(apiKey, prompt, cfg) {
  const model = process.env[cfg.modelEnv] || cfg.defaultModel;
  const sub = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify({ model, input: { prompt }, parameters: { size: "1024*1024", n: 1 } }),
    signal: AbortSignal.timeout(20000),
  });
  const sj = await sub.json();
  if (!sub.ok || sj.code) throw new Error(`Qwen 生图提交 ${sub.status}: ${(sj.message || "").slice(0, 150)}`);
  const taskId = sj.output?.task_id;
  if (!taskId) throw new Error("Qwen 生图无 task_id");
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const tr = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const tj = await tr.json();
    const st = tj.output?.task_status;
    if (st === "SUCCEEDED") {
      const url = tj.output?.results?.[0]?.url;
      if (!url) throw new Error("Qwen 生图无 url");
      return urlToB64(url);
    }
    if (st === "FAILED") throw new Error(`Qwen 生图失败: ${(tj.output?.message || "").slice(0, 120)}`);
  }
  throw new Error("Qwen 生图超时");
}

// OpenRouter:chat/completions + modalities,图在 message.images[].image_url.url(data url)
async function genOpenRouterImage(provider, apiKey, prompt, cfg) {
  const model = process.env[cfg.modelEnv] || cfg.defaultModel;
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${provider.label} 生图 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const url = (await res.json()).choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`${provider.label} 生图返回无图`);
  return urlToB64(url);
}

// 文生图统一入口:按厂商分发,均返回 base64。
async function generateImage(provider, apiKey, prompt) {
  const cfg = IMAGE_CONFIG[provider.id];
  if (!cfg) throw new Error(`${provider.label} 暂不支持生图`);
  if (cfg.mode === "dashscope-wanx") return genQwenWanx(apiKey, prompt, cfg);
  if (cfg.mode === "openrouter-chat") return genOpenRouterImage(provider, apiKey, prompt, cfg);
  return genOpenAIImages(provider, apiKey, prompt, cfg);
}

// 统一产出入口:文字类走 chatRaw(jsonMode 关),图走 generateImage。
// 返回 { kind:'text', provider, content } 或 { kind:'image', provider, b64 },外加 latencyMs。
export async function runProduce({ type, mode, brief, conclusion, evidence, sourceContent, instruction, providerId, byoKeys }) {
  const provider = ALL.find((p) => p.id === providerId);
  if (!provider) throw new Error(`未知 provider: ${providerId}`);
  const apiKey = resolveKey(provider, byoKeys);
  if (!apiKey) throw new Error(`${provider.label} 未配置 key`);
  const started = Date.now();
  if (type === "image") {
    if (!IMAGE_PROVIDER_IDS.includes(provider.id)) throw new Error(`${provider.label} 暂不支持生图`);
    const prompt = buildImagePrompt({ brief, conclusion, instruction, sourceHint: sourceContent });
    const b64 = await generateImage(provider, apiKey, prompt);
    return { kind: "image", provider: provider.label, b64, latencyMs: Date.now() - started };
  }
  const messages = buildProducePrompt({ type, mode, brief, conclusion, evidence, sourceContent, instruction });
  const content = await chatRaw(provider, apiKey, messages, { jsonMode: false });
  if (!content || !content.trim()) throw new Error(`${provider.label} 返回空内容`);
  return { kind: "text", provider: provider.label, content: content.trim(), latencyMs: Date.now() - started };
}

// ============ 审议引擎(白箱)============
// Response Healing:JSON 解析失败时,自动二次请求"只返回合法 JSON"修复一次。
// 治 OpenRouter free / 某模型 JSON 不稳;仍失败则抛 → 调用方降级不伪造。
async function chatJSON(provider, apiKey, messages) {
  const raw = await chatRaw(provider, apiKey, messages, { jsonMode: true });
  try {
    return JSON.parse(extractJson(raw));
  } catch {
    const healMsgs = [
      ...messages,
      { role: "assistant", content: String(raw).slice(0, 2000) },
      { role: "user", content: "你上面的输出不是合法 JSON。请只输出一个合法的、能被 JSON.parse 解析的 JSON 对象,不要任何解释、不要 markdown 围栏。" },
    ];
    const healed = await chatRaw(provider, apiKey, healMsgs, { jsonMode: true });
    return JSON.parse(extractJson(healed));
  }
}

const asStrArr = (x) => (Array.isArray(x) ? x.map((s) => clean(typeof s === "string" ? s : s?.text)).filter(Boolean) : []);
const asInsightArr = (x) =>
  Array.isArray(x) ? x.map((o) => ({ seat: clean(o?.seat), text: clean(o?.text) })).filter((o) => o.text) : [];

function formatOrganizerPlan(plan) {
  const kp = (plan.keyPoints || [])
    .map((k) => `- ${clean(k?.text)}${k?.evidenceIds?.length ? " (" + k.evidenceIds.join(",") + ")" : ""}`)
    .filter((l) => l !== "- ")
    .join("\n");
  return [
    `定位:${clean(plan.positioning)}`,
    `目标用户:${clean(plan.targetUser)}`,
    `要点:\n${kp}`,
    `最危险假设:${clean(plan.riskiestAssumption)}`,
  ].join("\n");
}

// 席位分配(§2.1 persona↔model 解耦):RunConfig 驱动,任意可用模型轮询分配任意席。
// 绝不写死"某厂商=某角色"。功能席(organizer/verifier/chairman)自动;反方席来自 runConfig(默认 3+魔鬼)。
export function assignDeliberationSeats(byoKeys, runConfig) {
  const configured = getConfiguredProviders(byoKeys);
  const n = configured.length;
  if (n === 0) return { organizer: null, critics: [], verifier: null, chairman: null, simulated: true, count: 0 };
  const models = configured.map((e) => ({ id: e.provider.id, label: e.provider.label }));
  const cfg = runConfig && Array.isArray(runConfig.seats) ? runConfig : DEFAULT_RUN_CONFIG(runConfig?.mode || "idea");

  const pick = (id, fb) => (id ? models.find((m) => m.id === id) : null) || fb;
  const organizer = { ...pick(cfg.functional?.organizer, models[0]), personaId: "organizer" };
  let cursor = 1;
  const nextModel = () => models[cursor++ % n];

  // 反方席:每个 persona 取一个模型(SeatConfig.modelId 指定且可用则用之,否则轮询)
  let critics = cfg.seats
    .map((s) => {
      const persona = PERSONAS[s.personaId];
      if (!persona) return null;
      const fixed = s.modelId ? models.find((m) => m.id === s.modelId) : null;
      const m = fixed || nextModel();
      return { id: m.id, label: m.label, personaId: persona.id };
    })
    .filter(Boolean);
  // locked 魔鬼不可删:默认已含;补一道保险(最后一席强制为魔鬼,模型不变)
  if (critics.length && !critics.some((c) => c.personaId === "devils-advocate")) {
    critics[critics.length - 1] = { ...critics[critics.length - 1], personaId: "devils-advocate" };
  }

  const vm = nextModel();
  const verifier = { ...pick(cfg.functional?.verifier, vm), personaId: "verifier" };
  // 主席尽量 ≠ organizer 模型
  let cm = nextModel();
  if (cm.id === organizer.id && n >= 2) cm = models[(models.findIndex((m) => m.id === organizer.id) + 1) % n];
  const chairman = { ...pick(cfg.functional?.chairman, cm), personaId: "chairman" };

  return { organizer, critics, verifier, chairman, simulated: n < 2, count: n };
}

// 角色库(供选角配置 UI):功能席 + 反方库(idea/copy 分组),不含动态 domain-expert。
export function listPersonas() {
  const pub = (p) => ({ id: p.id, cn: p.cn, locked: !!p.locked });
  const all = Object.values(PERSONAS);
  const opp = all.filter((p) => p.kind === "opinionated" && p.id !== "domain-expert");
  return {
    functional: all.filter((p) => p.kind === "functional").map(pub),
    opinionated: {
      idea: opp.filter((p) => p.mode === "idea" || p.mode === "both").map(pub),
      copy: opp.filter((p) => p.mode === "copy" || p.mode === "both").map(pub),
    },
  };
}

// 跑一轮审议:R1 organizer 立靶 → R2 critics 并行开火 → 主席审议综述。
// onEvent(ev,data):ev ∈ viewpoint | seat-failed | deliberation。逐步冒泡,失败降级不伪造。
// 想清楚(clarify §2.2):只跑主脑,产出结构化共创白箱(无反方/无裁决/无不可静音)。
export async function runClarify({ mode, brief, evidence, byoKeys, runConfig }, onEvent) {
  const emit = (ev, data) => onEvent && onEvent(ev, data);
  const seats = assignDeliberationSeats(byoKeys, runConfig || DEFAULT_RUN_CONFIG(mode));
  let brain = seats.organizer;
  if (!brain) {
    const first = getConfiguredProviders(byoKeys)[0];
    if (first) brain = { id: first.provider.id, label: first.provider.label };
  }
  if (!brain) { emit("error", { error: "no configured provider" }); return { clarify: null, simulated: true }; }
  const prov = ALL.find((p) => p.id === brain.id);
  const apiKey = resolveKey(prov, byoKeys);
  try {
    const out = await chatJSON(prov, apiKey, buildClarifyPrompt({ mode, brief, evidence }));
    const clarify = {
      restate: clean(out.restate),
      keyQuestions: asStrArr(out.keyQuestions),
      constructiveAngles: asStrArr(out.constructiveAngles),
      sharpestTension: clean(out.sharpestTension),
    };
    emit("clarify", clarify);
    return { clarify, simulated: false, brain: brain.label };
  } catch (e) {
    emit("seat-failed", { seat: brain.label, roleAngle: "organizer", round: 1, error: compact(e?.message || String(e)) });
    return { clarify: null, simulated: false };
  }
}

// ============ 跨模型接力(想清楚引擎;串行跑 Spec lenses)============
// Claude 立框 → 假设猎手 → 漂移检测 → 收棒出方向卡。每棒换模型、接受核心 + 扩大思考范围。
const RELAY_CHAIN_PREF = ["claude", "openai", "deepseek", "kimi"]; // 主力顺序;缺谁从可用池补
const RELAY_LENS_BY_HOP = [null, "assumption-finder", "drift-detector", null]; // 中间棒戴镜头(对齐 Spec)

function normFraming(o) {
  return { oneLine: clean(o?.oneLine), clear: asStrArr(o?.clear), assumptions: asStrArr(o?.assumptions), openQuestions: asStrArr(o?.openQuestions) };
}
function normCard(o) {
  const paths = (Array.isArray(o?.paths) ? o.paths : []).map((p) => ({ name: clean(p?.name), fit: clean(p?.fit), risk: clean(p?.risk) })).filter((p) => p.name);
  return {
    oneLine: clean(o?.oneLine), clear: asStrArr(o?.clear), expandedAngles: asStrArr(o?.expandedAngles),
    assumptions: asStrArr(o?.assumptions), paths, firstNarrowing: clean(o?.firstNarrowing),
    decisionsForYou: asStrArr(o?.decisionsForYou), inviteYourInput: clean(o?.inviteYourInput), dontBuildYet: asStrArr(o?.dontBuildYet),
  };
}

export async function runRelay({ mode, brief, evidence, byoKeys, runConfig }, onEvent) {
  const emit = (ev, data) => onEvent && onEvent(ev, data);
  const configured = getConfiguredProviders(byoKeys);
  if (configured.length < 2) { emit("error", { error: "接力至少需要 2 家可用模型" }); return { hops: [], card: null, models: [] }; }
  // 按主力顺序排链(Claude→OpenAI→DeepSeek→Kimi),缺的从可用池补,去重取前 4
  const byId = new Map(configured.map((e) => [e.provider.id, e]));
  const chain = [];
  for (const id of RELAY_CHAIN_PREF) { const e = byId.get(id); if (e && !chain.includes(e)) chain.push(e); }
  for (const e of configured) { if (chain.length >= 4) break; if (!chain.includes(e)) chain.push(e); }
  const links = chain.slice(0, Math.min(4, chain.length));
  const N = links.length;
  const models = links.map((l) => l.provider.label);
  const hops = [];
  let framing = null;
  const allAdded = [];
  for (let i = 0; i < N; i++) {
    const { provider, apiKey } = links[i];
    const isSeed = i === 0;
    const isSynth = i === N - 1; // 最后一棒收棒(N≥2)
    const lens = (!isSeed && !isSynth) ? (RELAY_LENS_BY_HOP[i] || "assumption-finder") : null;
    const role = isSeed ? "seed" : isSynth ? "synth" : "expand";
    const started = Date.now();
    try {
      if (isSeed) {
        const out = await chatJSON(provider, apiKey, buildRelaySeedPrompt({ mode, brief, evidence }));
        framing = normFraming(out);
        const hop = { order: i + 1, seat: provider.label, role, lens: null, added: [], framing, latencyMs: Date.now() - started };
        hops.push(hop); emit("relay-hop", hop);
      } else if (isSynth) {
        // 收棒:依次尝试(本棒模型 → 主脑 → 其余),单模型 429/挂掉不丢方向卡
        const synthOrder = [links[i], links[0], ...links].filter((v, idx, a) => a.indexOf(v) === idx);
        let card = null, synthSeat = provider.label, lastErr = "";
        for (const cand of synthOrder) {
          try {
            const out = await chatJSON(cand.provider, cand.apiKey, buildRelaySynthPrompt({ mode, brief, framing, allAdded }));
            card = normCard(out); synthSeat = cand.provider.label; break;
          } catch (e) { lastErr = compact(e?.message || String(e)); }
        }
        const hop = { order: i + 1, seat: synthSeat, role, lens, added: [], failed: !card, error: card ? undefined : lastErr, latencyMs: Date.now() - started };
        hops.push(hop); emit("relay-hop", hop);
        if (card) emit("relay-card", card);
        return { hops, card, models };
      } else {
        const out = await chatJSON(provider, apiKey, buildRelayHopPrompt({ framing, lens }));
        const added = asStrArr(out?.added);
        if (out?.framing) framing = normFraming(out.framing);
        allAdded.push(...added);
        const hop = { order: i + 1, seat: provider.label, role, lens, accepted: clean(out?.accepted), added, framing, latencyMs: Date.now() - started };
        hops.push(hop); emit("relay-hop", hop);
      }
    } catch (e) {
      const hop = { order: i + 1, seat: provider.label, role, lens, added: [], failed: true, error: compact(e?.message || String(e)), latencyMs: Date.now() - started };
      hops.push(hop); emit("relay-hop", hop);
      if (isSeed) { emit("error", { error: "立框失败:" + hop.error }); return { hops, card: null, models }; }
      // 中间棒失败:跳过继续(framing 不更新);收棒失败:无 card
    }
  }
  return { hops, card: null, models };
}

export async function runDeliberation({ mode, brief, evidence, byoKeys, runConfig, posture }, onEvent) {
  const seats = assignDeliberationSeats(byoKeys, runConfig || DEFAULT_RUN_CONFIG(mode));
  const emit = (ev, data) => onEvent && onEvent(ev, data);
  const stance = posture || runConfig?.posture || "roast"; // roast=全套对抗;council=温和(不强制魔鬼kill/不跑R3)
  const isRoast = stance === "roast";
  const collected = [];

  // R1 主脑立靶
  let organizerPlan = "";
  if (seats.organizer) {
    const prov = ALL.find((p) => p.id === seats.organizer.id);
    const apiKey = resolveKey(prov, byoKeys);
    const started = Date.now();
    try {
      const plan = await chatJSON(prov, apiKey, buildOrganizerPrompt({ mode, brief, evidence }));
      organizerPlan = formatOrganizerPlan(plan);
      const evIds = [...new Set((plan.keyPoints || []).flatMap((k) => (Array.isArray(k?.evidenceIds) ? k.evidenceIds : [])))].filter(Boolean);
      const vp = { seat: seats.organizer.label, roleAngle: "organizer", stance: null, text: organizerPlan, evidenceIds: evIds, isHardestKill: false, round: 1, latencyMs: Date.now() - started };
      collected.push(vp);
      emit("viewpoint", vp);
    } catch (e) {
      emit("seat-failed", { seat: seats.organizer.label, roleAngle: "organizer", round: 1, error: compact(e?.message || String(e)) });
    }
  }

  // autoRecruit:R1 后按领域临时加一席专家反方(金融→合规、医疗→临床、隐私→隐私反方…)
  if (runConfig?.autoRecruitDomain) {
    try {
      const configured = getConfiguredProviders(byoKeys);
      if (configured.length) {
        const det = await chatJSON(configured[0].provider, configured[0].apiKey, buildDomainDetectPrompt({ brief }));
        const domain = clean(det?.domain);
        if (domain && domain !== "none" && clean(det?.systemFocus)) {
          const m = configured[seats.critics.length % configured.length];
          seats.critics.push({
            id: m.provider.id,
            label: m.provider.label,
            personaId: "domain-expert",
            persona: { id: "domain-expert", cn: clean(det.cn) || "领域专家", system: `${PERSONAS["domain-expert"].system}\nDomain focus: ${clean(det.systemFocus)}` },
          });
          emit("seat-added", { roleAngle: "domain-expert", cn: clean(det.cn) || "领域专家", domain });
        }
      }
    } catch {}
  }

  // R2 反方并行开火(吃 persona;角色按 personaId 存)
  await Promise.all(
    seats.critics.map(async (c) => {
      const prov = ALL.find((p) => p.id === c.id);
      const apiKey = resolveKey(prov, byoKeys);
      const persona = c.persona || PERSONAS[c.personaId];
      const started = Date.now();
      const isDevil = c.personaId === "devils-advocate";
      try {
        const out = await chatJSON(prov, apiKey, buildCriticViewpointsPrompt({ provider: c.label, persona, brief, evidence, organizerPlan: organizerPlan || brief, posture: stance }));
        const vps = (Array.isArray(out.viewpoints) ? out.viewpoints : [])
          .map((v) => ({ stance: normalizeStance(v?.stance), text: clean(v?.text), evidenceIds: Array.isArray(v?.evidenceIds) ? v.evidenceIds.filter(Boolean) : [], isHardestKill: Boolean(v?.isHardestKill) }))
          .filter((v) => v.text);
        // 魔鬼代言人必须有一条不可静音的最硬 kill —— 仅 roast 强制;council 下魔鬼是普通锐评,不强制 kill
        if (isRoast && isDevil && vps.length && !vps.some((v) => v.isHardestKill)) vps[0].isHardestKill = true;
        let devilMarked = false;
        for (const v of vps) {
          const isHK = isRoast && isDevil && v.isHardestKill && !devilMarked;
          if (isHK) devilMarked = true;
          const vp = { seat: c.label, roleAngle: c.personaId, stance: v.stance, text: v.text, evidenceIds: v.evidenceIds, isHardestKill: isHK, round: 2, latencyMs: Date.now() - started };
          collected.push(vp);
          emit("viewpoint", vp);
        }
      } catch (e) {
        emit("seat-failed", { seat: c.label, roleAngle: c.personaId, round: 2, error: compact(e?.message || String(e)) });
      }
    }),
  );

  // R2.5 Verifier 事实核查:核查各反方断言 vs 证据,驳无证据支撑的(index 对应 R2 观点的发出顺序)
  const r2 = collected.filter((v) => v.round === 2);
  if (seats.verifier && r2.length) {
    const prov = ALL.find((p) => p.id === seats.verifier.id);
    const apiKey = resolveKey(prov, byoKeys);
    try {
      const out = await chatJSON(prov, apiKey, buildVerifierPrompt({ brief, evidence, viewpoints: r2 }));
      const checks = Array.isArray(out.checks) ? out.checks : [];
      for (const ch of checks) {
        const idx = Number(ch?.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= r2.length) continue;
        const verdict = ["supported", "unsupported", "overreach"].includes(ch.verdict) ? ch.verdict : null;
        if (!verdict) continue;
        const verification = { verdict, note: clean(ch.note) };
        r2[idx].verification = verification;
        emit("verification", { index: idx, verification });
      }
    } catch (e) {
      emit("seat-failed", { seat: seats.verifier.label, roleAngle: "verifier", round: 2, error: compact(e?.message || String(e)) });
    }
  }

  // R3 匿名交叉互驳(严酷档 + 自适应停止):R2 分歧≥2 种 stance 才跑(否则"何时终止"=跳过)
  const r2vps = collected.filter((v) => v.round === 2);
  const distinctStances = new Set(r2vps.map((v) => v.stance).filter(Boolean));
  if (isRoast && seats.critics.length >= 2 && distinctStances.size >= 2) {
    await Promise.all(
      seats.critics.map(async (c) => {
        const others = r2vps.filter((v) => v.seat !== c.label);
        if (!others.length) return;
        const prov = ALL.find((p) => p.id === c.id);
        const apiKey = resolveKey(prov, byoKeys);
        const persona = PERSONAS[c.personaId];
        const anon = others.map((v, i) => `- 反方${String.fromCharCode(65 + i)}: ${v.text}`).join("\n");
        const started = Date.now();
        try {
          const out = await chatJSON(prov, apiKey, buildCrossRebuttalPrompt({ provider: c.label, persona, brief, othersAnonymized: anon }));
          const vps = (Array.isArray(out.viewpoints) ? out.viewpoints : [])
            .map((v) => ({ stance: normalizeStance(v?.stance), text: clean(v?.text), evidenceIds: Array.isArray(v?.evidenceIds) ? v.evidenceIds.filter(Boolean) : [] }))
            .filter((v) => v.text);
          for (const v of vps) {
            const vp = { seat: c.label, roleAngle: c.personaId, stance: v.stance, text: v.text, evidenceIds: v.evidenceIds, isHardestKill: false, round: 3, latencyMs: Date.now() - started };
            collected.push(vp);
            emit("viewpoint", vp);
          }
        } catch (e) {
          emit("seat-failed", { seat: c.label, roleAngle: c.personaId, round: 3, error: compact(e?.message || String(e)) });
        }
      }),
    );
  }

  // 主席审议综述(需至少有 R2 观点)
  let deliberation = null;
  if (seats.chairman && collected.some((v) => v.round === 2)) {
    const prov = ALL.find((p) => p.id === seats.chairman.id);
    const apiKey = resolveKey(prov, byoKeys);
    try {
      const s = await chatJSON(prov, apiKey, buildChairmanSummaryPrompt({ brief, viewpoints: collected }));
      deliberation = {
        consensus: asStrArr(s.consensus),
        contradictions: asStrArr(s.contradictions),
        partialCoverage: asStrArr(s.partialCoverage),
        uniqueInsights: asInsightArr(s.uniqueInsights),
        blindSpots: asStrArr(s.blindSpots),
        simulated: seats.simulated,
      };
      emit("deliberation", deliberation);
    } catch (e) {
      emit("seat-failed", { seat: seats.chairman.label, roleAngle: "chairman", round: 3, error: compact(e?.message || String(e)) });
    }
  }

  return { viewpoints: collected, deliberation, simulated: seats.simulated, seats };
}

// ============ 人-steered 收敛(D)============
// 从 append-only 信号日志重建每条观点的当前策展态(最新状态胜出;reply 累积)。
function deriveCurationServer(signals) {
  const m = {};
  for (const s of signals || []) {
    const c = m[s.viewpointId] || (m[s.viewpointId] = { status: "none", replies: [] });
    if (s.action === "reply") c.replies.push(s.note);
    else if (s.action === "clear") c.status = "none";
    else c.status = s.action;
  }
  return m;
}

function convergedToMarkdown(c) {
  const sec = (title, items, render) => (items && items.length ? `## ${title}\n${items.map(render).join("\n")}\n\n` : "");
  let md = "";
  if (c.clarified) md += `## 你想明白了什么\n${c.clarified}\n\n`;
  if (c.verdictVote && c.verdictVote.decision) {
    const t = Object.entries(c.verdictVote.tally).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ");
    md += `## 投票(仅参考${c.verdictVote.simulated ? " · simulated" : ""})\n${t}\n\n`;
  }
  md += sec("认领的逐条应对", c.addressed, (a) => `- **${a.tag ? "[" + a.tag + "] " : ""}${a.point}** → ${a.response}`);
  if (c.unsilenceable.length) md += `## 不可静音的最硬 kill\n${c.unsilenceable.map((u) => `- ${u}`).join("\n")}\n\n`;
  md += sec("你搁置了什么(留痕)", c.setAside, (a) => `- ${a.point}${a.reason ? `(理由:${a.reason})` : ""}`);
  md += sec("待验证的关键问题", c.openQuestions, (q) => `- ${q}`);
  md += sec("最便宜的验证", c.cheapestTests, (t) => `- ${t}`);
  if (c.aiTake) md += `## 一个 AI 视角(仅一个意见,不是答案)\n${c.aiTake}\n`;
  return md.trim();
}

// 人-steered 收敛:只吃人策展集合;反共识硬兜底 —— 最硬 kill 即使被搁置也强制进 unsilenceable。
export async function runConverge({ brief, evidence, viewpoints, signals, byoKeys }) {
  const cur = deriveCurationServer(signals);
  const endorsed = [], pinned = [], setAside = [], replies = [], hardKills = [];
  const tagOf = (v) => PERSONAS[v.roleAngle]?.cn || v.roleAngle;
  for (const v of viewpoints || []) {
    if (v.isHardestKill) hardKills.push(v.text);
    const c = cur[v.id];
    if (!c) continue;
    if (c.status === "endorse") endorsed.push({ text: v.text, tag: tagOf(v) });
    else if (c.status === "pin") pinned.push({ text: v.text, tag: tagOf(v) });
    else if (c.status === "setAside") setAside.push(v.text);
    for (const note of c.replies) replies.push({ point: v.text.slice(0, 60), note });
  }
  const configured = getConfiguredProviders(byoKeys);
  if (!configured.length) throw new Error("no configured providers");
  const prov = configured[0].provider;
  const apiKey = configured[0].apiKey;
  const out = await chatJSON(prov, apiKey, buildConvergePrompt({ brief, evidence, endorsed, pinned, setAside, replies, unsilenceable: hardKills }));

  const converged = {
    clarified: clean(out.clarified),
    addressed: Array.isArray(out.addressed) ? out.addressed.map((o) => ({ tag: clean(o?.tag), point: clean(o?.point), response: clean(o?.response) })).filter((o) => o.point || o.response) : [],
    setAside: Array.isArray(out.setAside) ? out.setAside.map((o) => ({ point: clean(o?.point), reason: clean(o?.reason) })).filter((o) => o.point) : [],
    unsilenceable: asStrArr(out.unsilenceable),
    openQuestions: asStrArr(out.openQuestions),
    cheapestTests: asStrArr(out.cheapestTests),
    aiTake: clean(out.aiTake),
    verdictVote: tallyVotes(viewpoints, configured.length),
  };
  // 反共识硬兜底:每条最硬 kill 必须在 unsilenceable(模型漏了就补;搁置也不可静音)
  for (const k of hardKills) {
    const key = k.slice(0, 18);
    if (!converged.unsilenceable.some((u) => u.includes(key) || k.includes(u.slice(0, 18)))) converged.unsilenceable.push(k);
  }
  return { converged, conclusion: convergedToMarkdown(converged) };
}

// 透明投票:每个反方席一票(该席观点的众数 stance);展示全 tally,标"仅参考",不由主席独断。
function tallyVotes(viewpoints, modelCount) {
  const bySeat = {};
  for (const v of viewpoints || []) {
    if (v.roleAngle === "organizer" || !v.stance) continue;
    (bySeat[v.seat] = bySeat[v.seat] || []).push(v.stance);
  }
  const tally = { Ship: 0, Fix: 0, Pause: 0, Kill: 0 };
  for (const seat of Object.keys(bySeat)) {
    const counts = {};
    for (const s of bySeat[seat]) counts[s] = (counts[s] || 0) + 1;
    const rep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (rep && tally[rep] !== undefined) tally[rep]++;
  }
  const ranked = Object.entries(tally).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return { tally, decision: ranked[0]?.[0] || null, simulated: (modelCount || 0) < 2 || Object.keys(bySeat).length < 2 };
}

// 视觉读图:用 OpenAI(gpt-4o 系,支持视觉)把图片转成文字描述,供讨论参考。
async function describeImage(dataUrl, byoKeys) {
  const openai = OPENAI_COMPATIBLE.find((p) => p.id === "openai");
  const apiKey = resolveKey(openai, byoKeys);
  if (!apiKey) return "(未配置 OpenAI key,无法识别图片)";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const res = await fetch(`${openai.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 450,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "用中文简要描述这张图片对一个产品点子讨论有用的关键信息(界面/产品形态/数据/文案/竞品等要点),不超过 6 句。" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
  const json = await res.json();
  return clean(json.choices?.[0]?.message?.content) || "(空)";
}

// 把用户附件(图片 / 文本文件)转成可注入讨论的文字块。
export async function buildAttachmentContext(attachments, byoKeys) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  const parts = [];
  for (const a of attachments) {
    if (a?.kind === "image" && a.dataUrl) {
      try {
        const desc = await describeImage(a.dataUrl, byoKeys);
        parts.push(`【图片:${a.name || "image"}】AI 识别:\n${desc}`);
      } catch (e) {
        parts.push(`【图片:${a.name || "image"}】(识别失败:${compact(e?.message || e)})`);
      }
    } else if (a?.kind === "text" && a.text) {
      parts.push(`【文件:${a.name || "file"}】内容:\n${String(a.text).slice(0, 4000)}`);
    }
  }
  return parts.length ? `\n\n=== 用户附件 ===\n${parts.join("\n\n")}` : "";
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
