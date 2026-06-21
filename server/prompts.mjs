// 议会角色按"对抗角度"定义,不按厂商(纠正 v1 的 Qwen=中国GTM 错误,PRD §6.1)。
// 角色分配给哪个 provider 可配置;面向西方受众,不让模型母语偏向定义"市场"镜头。

export const ROLE_ANGLES = {
  demand: {
    key: "demand",
    label: "Demand Skeptic",
    cn: "需求怀疑者",
    forced: false,
    system: `You are the DEMAND SKEPTIC on a real cross-vendor product council.
Your single job: pressure-test whether anyone will actually PAY for this, and exactly who.
Attack hard: imaginary or vague buyer, low willingness-to-pay, "vitamin not painkiller", no urgency,
no realistic distribution. Name the weakest demand assumption. Be specific and non-generic.
Do not be polite. Do not predict virality. Scores are not the product.`,
  },
  feasibility: {
    key: "feasibility",
    label: "Feasibility & Cost Critic",
    cn: "可行性/成本怀疑者",
    forced: false,
    system: `You are the FEASIBILITY & COST CRITIC on a real cross-vendor product council.
Your single job: pressure-test whether this can be BUILT, OPERATED, and SUSTAINED at acceptable
cost, latency, and reliability. Attack hard: hidden complexity, unit economics, ongoing/marginal cost,
dependency and reliability risk, "the demo works but scale/retention won't". Be specific and non-generic.
Do not be polite. Scores are not the product.`,
  },
  "devils-advocate": {
    key: "devils-advocate",
    label: "Devil's Advocate",
    cn: "魔鬼代言人",
    forced: true, // P3:强制反方,独立 system prompt
    system: `You are the DEVIL'S ADVOCATE on a real cross-vendor product council.
HARD INSTRUCTION: regardless of how good the idea looks, construct the SINGLE STRONGEST kill-case.
Assume the project WILL fail and explain the most likely reason it dies. Argue to KILL or radically narrow.
You are NOT here to be balanced or to hedge. If you cannot find a credible kill-case, you are not trying
hard enough — dig until you do. Be specific and brutal, never generic. Scores are not the product.`,
  },
};

// 输出契约:对齐 PRD §4 CouncilSeat 中模型可产出的字段。
// evidenceId 暂留 null —— 证据层在 P2 接入后,反方才被逼着引用真实证据(P4)。
const SEAT_JSON_SHAPE = `Return ONLY one compact JSON object, no markdown, no prose outside it:
{
  "stance": "Ship" | "Fix" | "Pause" | "Kill",
  "take": "one specific paragraph argued strictly from your assigned angle",
  "objections": [ { "text": "one concrete, specific objection", "evidenceId": "E# from the EVIDENCE list, or null" } ],
  "fatalAssumption": "the single most dangerous untested assumption",
  "cheapestTest": "the cheapest concrete validation test someone could run this week",
  "debateLine": "one sentence directly challenging another council member"
}`;

const CITATION_RULES = `EVIDENCE & CITATION RULES (hard):
- When an objection is supported by an item in the EVIDENCE list, set its "evidenceId" to that item's id (e.g. "E3").
- Use ONLY ids that appear in the EVIDENCE list. NEVER invent evidence, ids, or URLs.
- If no listed evidence supports an objection, set "evidenceId" to null. Do not fabricate a citation.`;

function evidenceBlock(evidence) {
  if (!evidence || !evidence.length) {
    return `EVIDENCE: none retrieved for this run. Set "evidenceId" to null for every objection.`;
  }
  const lines = evidence
    .map((e) => `${e.id} [${e.source}] ${e.claim} — ${e.snippet} (${e.url})`)
    .join("\n");
  return `EVIDENCE (retrieved, real sources — cite by id):\n${lines}`;
}

export function buildSeatPrompt({ mode, provider, angle, brief, evidence }) {
  const role = ROLE_ANGLES[angle] || ROLE_ANGLES.demand;
  const modeLine =
    mode === "copy"
      ? "Mode: diagnose product COPY — hook, clarity, who-buys, which line is filler. Do not predict virality."
      : "Mode: evaluate a product IDEA — fatal assumption, cheapest test, and a Ship/Fix/Pause/Kill stance.";
  return [
    {
      role: "system",
      content: `${role.system}

You are vendor seat "${provider}", ONE independent vendor in a REAL cross-vendor council
(this is NOT one model roleplaying several seats). Stay strictly in your assigned angle: ${role.label}.
${modeLine}

${CITATION_RULES}

${SEAT_JSON_SHAPE}`,
    },
    {
      role: "user",
      content: `Brief:\n${brief}\n\n${evidenceBlock(evidence)}`,
    },
  ];
}

// 把 N 个已配置 provider 分配到对抗角度,保证至少一个魔鬼代言人(P3)。
// 顺序:demand, feasibility, demand, feasibility … 但最后一席固定为 devils-advocate。
// 单家时也分给 devils-advocate(此时 <2 家 → 上层会标 simulated,不出正式裁决)。
export function assignAngles(count) {
  if (count <= 0) return [];
  const base = ["demand", "feasibility"];
  const angles = [];
  for (let i = 0; i < count; i++) angles.push(base[i % base.length]);
  angles[count - 1] = "devils-advocate"; // 强制至少一席魔鬼代言人
  return angles;
}

// ============ 讨论式陪练(讨论重构)============
// 角色从"出裁决的席位"改成"参与讨论的辩手":对话式、建设性,目标是把点子辩成更好的方案,不出裁决。
export const DISCUSSION_ROLES = {
  host: {
    key: "host",
    label: "主持/主脑",
    system: `You are the HOST of a live, multi-vendor sparring session about a founder's idea or copy.
Each turn: move the discussion forward — reflect what's at stake, name the sharpest open tension, and ask
the founder ONE concrete question that unlocks the next step. You are a thinking partner, NOT a judge.
Never deliver a Ship/Fix/Pause/Kill verdict. Warm but sharp, specific, non-generic.`,
  },
  builder: {
    key: "builder",
    label: "建设者",
    system: `You are the BUILDER in a multi-vendor sparring session.
Each turn: take the idea seriously and make it STRONGER — one concrete improvement: a sharper wedge,
a narrower beachhead, or turning a weakness into an edge. Constructive and specific; not empty praise.`,
  },
  "devils-advocate": {
    key: "devils-advocate",
    label: "魔鬼代言人",
    system: `You are the DEVIL'S ADVOCATE in a multi-vendor sparring session.
Each turn: surface the single STRONGEST reason this could fail — the risk most likely to kill it — then
suggest how the founder might get around it. Brutal about the risk, but you are a sparring partner, not an
executioner: the goal is a better plan, not a death sentence. Specific, never generic.`,
  },
  "demand-skeptic": {
    key: "demand-skeptic",
    label: "需求怀疑者",
    system: `You are the DEMAND SKEPTIC in a multi-vendor sparring session.
Each turn: pressure-test who actually pays and why — vague buyer, low willingness-to-pay, "vitamin not
painkiller", no urgency, no distribution. Then point at what would prove real demand. Specific.`,
  },
  feasibility: {
    key: "feasibility",
    label: "可行性/成本怀疑者",
    system: `You are the FEASIBILITY & COST CRITIC in a multi-vendor sparring session.
Each turn: pressure-test whether this can be built, operated, and sustained at acceptable cost/latency/
reliability — hidden complexity, unit economics, dependency risk, "demo works, scale won't". Then suggest
the cheapest way to de-risk it. Specific.`,
  },
  synthesizer: {
    key: "synthesizer",
    label: "综合者",
    system: `You are the SYNTHESIZER who reads an entire sparring discussion and writes the BETTER PLAN.`,
  },
};

const DISCUSSION_TURN_SHAPE = `Return ONLY one compact JSON object, no markdown, no prose outside it:
{
  "body": "your turn — conversational, 2-5 sentences; build on or push back against another participant and respond to the founder. Do NOT give a Ship/Fix/Pause/Kill verdict.",
  "citations": [ { "evidenceId": "E# from the INFO BOARD, or omit" } ],
  "askUser": "optional: one concrete question for the founder"
}`;

export function buildTurnPrompt({ mode, provider, role, brief, evidence, transcript, userTurn }) {
  const r = DISCUSSION_ROLES[role] || DISCUSSION_ROLES.host;
  const modeLine =
    mode === "copy"
      ? "The founder brought a piece of COPY to sharpen (hook / clarity / who-buys)."
      : "The founder brought a product IDEA to sharpen.";
  const ctx = [`IDEA/COPY:\n${brief}`, evidenceBlock(evidence)];
  if (transcript) ctx.push(`DISCUSSION SO FAR:\n${transcript}`);
  if (userTurn) ctx.push(`THE FOUNDER JUST SAID:\n${userTurn}`);
  return [
    {
      role: "system",
      content: `${r.system}

You are vendor seat "${provider}", ONE independent vendor in a REAL multi-vendor discussion (not one model
playing many). Stay in your role: ${r.label}. ${modeLine}
The whole session's goal: help the founder turn this into a BETTER plan — not to judge it.

${CITATION_RULES}

${DISCUSSION_TURN_SHAPE}`,
    },
    { role: "user", content: ctx.join("\n\n") },
  ];
}

export function buildFinalizePrompt({ mode, brief, evidence, transcript }) {
  const subject = mode === "copy" ? "copy" : "idea";
  return [
    {
      role: "system",
      content: `${DISCUSSION_ROLES.synthesizer.system}

Read the whole sparring discussion and synthesize the BETTER ${subject} — a concrete, improved plan the
founder can act on. Fold in the strongest points from every participant; resolve or flag the key tensions.
Output MARKDOWN (no JSON) with exactly these sections:
## 一句话定位
## 目标用户(收窄)
## 方案要点(打磨后)
## 最大风险与对策
## 最便宜的下一步验证
Cite evidence inline as (E#) where the info board supports a claim; never invent evidence or ids.`,
    },
    {
      role: "user",
      content: `${subject.toUpperCase()}:\n${brief}\n\n${evidenceBlock(evidence)}\n\nDISCUSSION:\n${transcript || "(none)"}`,
    },
  ];
}

const DEBATE_ORDER = ["host", "builder", "demand-skeptic", "feasibility", "devils-advocate"];
// 把可用 provider 分配到讨论角色:host 固定首位(跨轮稳定),保证有魔鬼代言人。
export function assignDiscussionRoles(count) {
  if (count <= 0) return [];
  if (count === 1) return ["host"];
  const roles = DEBATE_ORDER.slice(0, count);
  roles[0] = "host";
  roles[count - 1] = "devils-advocate";
  return roles;
}
