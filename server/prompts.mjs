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

// 输出语言(硬约束):这是中文版产品 —— 所有面向用户的输出一律简体中文。
// 做法甲:system prompt 保持英文(过滤器安全),只在输出端强制中文,不改内部指令。
const OUTPUT_LANG = `OUTPUT LANGUAGE (hard requirement): Write EVERYTHING you output — every JSON field value, every sentence, every word the founder reads — in 简体中文 (Simplified Chinese). Do NOT output English prose. The only English allowed is unavoidable proper nouns (product/brand names, acronyms like API/SaaS/MVP) and evidence ids (E1, E2…). This is a Chinese-language product.`;

function evidenceBlock(evidence) {
  if (!evidence || !evidence.length) {
    return `EVIDENCE: none retrieved for this run. Set "evidenceId" to null for every citation.`;
  }
  const lines = evidence
    .map((e) => {
      const impact = e.impact ? ` | 影响:${e.impact}` : "";
      return `${e.id} [${e.source}] ${e.claim}${impact} — ${e.snippet.slice(0, 160)} (${e.url})`;
    })
    .join("\n");
  return `EVIDENCE (retrieved real sources — cite by id only, never invent ids):\n${lines}`;
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

${OUTPUT_LANG}

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
Each turn: surface the single STRONGEST reason this could fail — the risk most likely to derail it — then
suggest how the founder might get around it. Be direct and candid about the risk, but you are a sparring
partner: the goal is a sharper, more resilient plan. Specific, never generic.`,
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
  "body": "your turn — conversational, 2-5 sentences; build on or push back against another participant and respond to the founder. Do NOT deliver an overall verdict or score.",
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

${OUTPUT_LANG}

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
Cite evidence inline as (E#) where the info board supports a claim; never invent evidence or ids.

${OUTPUT_LANG}`,
    },
    {
      role: "user",
      content: `${subject.toUpperCase()}:\n${brief}\n\n${evidenceBlock(evidence)}\n\nDISCUSSION:\n${transcript || "(none)"}`,
    },
  ];
}

// 中间席位循环复用的角色(host 固定首位、devils-advocate 固定末位之外)。
const MIDDLE_ROLES = ["builder", "demand-skeptic", "feasibility"];
// 把可用 provider 分配到讨论角色:host 固定首位(跨轮稳定),末位固定魔鬼代言人,
// 中间按位次循环 builder/demand/feasibility。任意家数都不产生空洞(>5 也安全)。
// 角色按位次定、不按厂商(纠正 v1 的厂商偏向)——迁入的新 provider 同样按位次入席。
export function assignDiscussionRoles(count) {
  if (count <= 0) return [];
  if (count === 1) return ["host"];
  const roles = ["host"];
  for (let i = 1; i < count - 1; i++) roles.push(MIDDLE_ROLES[(i - 1) % MIDDLE_ROLES.length]);
  roles.push("devils-advocate");
  return roles;
}

// ============ 产出层(交付物):把方案变成文案/PRD/设计文档/代码草稿 ============
// 文字类交付物:复用 chatRaw(jsonMode 关 → 出 markdown/代码,不是 JSON)。
export const PRODUCE_TYPES = {
  copy: {
    label: "文案",
    system: `你是资深增长文案。把方案变成可直接投放/上线的中文文案初稿:一个主标题、2-3 个副标题/卖点、一段正文、一个明确的行动号召(CTA)。语言具体、有钩子,不说空话。输出 Markdown。`,
  },
  prd: {
    label: "一页 PRD",
    system: `你是产品经理。把方案压成一页可执行的中文 PRD。用 Markdown,包含这些小标题:## 一句话定位 / ## 目标用户 / ## 核心用户故事 / ## 功能范围(MVP) / ## 非目标 / ## 关键指标 / ## 里程碑。具体、可落地,别空泛。`,
  },
  design_doc: {
    label: "设计文档",
    system: `你是技术负责人。把方案变成一份中文技术/方案设计文档。用 Markdown,包含:## 背景与目标 / ## 总体方案 / ## 关键模块 / ## 数据与接口 / ## 技术选型与取舍 / ## 风险与对策 / ## 落地步骤。务实、有取舍判断。`,
  },
  code_sketch: {
    label: "代码草稿",
    system: `你是资深工程师。把方案变成一份可直接起步的代码草稿(脚手架):选最合适的技术栈,给出关键文件结构和核心代码骨架(用围栏代码块),并在代码外用简短中文说明怎么跑起来。重在能起步的最小骨架,不是伪代码。`,
  },
};

export function buildProducePrompt({ type, mode, brief, conclusion, evidence, sourceContent, instruction }) {
  const spec = PRODUCE_TYPES[type] || PRODUCE_TYPES.copy;
  const ctx = [
    `点子/文案原始输入:\n${brief}`,
    `议会打磨后的方案:\n${conclusion || "(无)"}`,
    evidenceBlock(evidence),
  ];
  let task;
  if (mode === "refine" && sourceContent) {
    task = `下面是另一家 AI 出的「${spec.label}」初稿,请在保留其可取之处的基础上修改/改进:\n\n---\n${sourceContent}\n---\n\n修改要求:${instruction || "整体打磨,使其更清晰、更可用。"}`;
  } else {
    task = `请基于以上方案,产出一份高质量的「${spec.label}」初稿。${instruction ? `额外要求:${instruction}` : ""}`;
  }
  return [
    { role: "system", content: `${spec.system}\n\n${OUTPUT_LANG}` },
    { role: "user", content: `${ctx.join("\n\n")}\n\n${task}` },
  ];
}

// 生图提示词:把方案/指令凝成一句图像生成 prompt。
export function buildImagePrompt({ brief, conclusion, instruction, sourceHint }) {
  const base = instruction?.trim() || `为这个产品点子设计一张有代表性的概念配图/主视觉:${brief}`;
  const ref = sourceHint ? `\n参考已有版本方向:${String(sourceHint).slice(0, 200)}` : "";
  return `${base}\n背景方案要点:${(conclusion || brief).slice(0, 400)}${ref}\n要求:干净、现代、适合做产品宣传/概念图,不要文字水印。`;
}

// ============ 审议引擎(白箱):R1 立靶 → R2 独立开火 → 审议综述 ============
// 主脑(整理者,不当裁判)+ 主席(综合者,不自由裁决);反方角度复用 ROLE_ANGLES。
export const DELIB_ROLES = {
  organizer: {
    cn: "主脑/整理者",
    system: `You are the ORGANIZER on a white-box deliberation council. You are NOT a judge.
Read the founder's idea/copy and the EVIDENCE, then lay out a clear, structured "target" plan for the critics to attack:
crisp positioning, the target user, the key points (each tied to evidence when possible), and the single riskiest assumption.
Be concrete and non-generic. You set the target; you do not defend or score it.`,
  },
  chairman: {
    cn: "主席/综合者",
    system: `You are the CHAIRMAN of a white-box deliberation council. You are NOT delivering a verdict.
Read ALL viewpoints from the seats and synthesize a structured deliberation summary (Fusion-style, but as a WHITE-BOX
intermediate product for the human to curate — never a final answer). Surface where seats agree, where they conflict,
what only some raised, each model's unique sharp insight, and — most important — the BLIND SPOTS nobody raised but matter.`,
  },
};

const ORGANIZER_SHAPE = `Return ONLY one compact JSON object, no markdown, no prose outside it:
{
  "positioning": "one-sentence positioning of the idea/copy",
  "targetUser": "who it is for (narrow)",
  "keyPoints": [ { "text": "one concrete key point of the plan", "evidenceIds": ["E# from EVIDENCE, or omit"] } ],
  "riskiestAssumption": "the single most dangerous untested assumption"
}`;

export function buildOrganizerPrompt({ mode, brief, evidence }) {
  const modeLine = mode === "copy"
    ? "The founder brought a piece of COPY to deliberate (hook / clarity / who-buys)."
    : "The founder brought a product IDEA to deliberate.";
  return [
    { role: "system", content: `${DELIB_ROLES.organizer.system}\n${modeLine}\n\n${CITATION_RULES}\n\n${OUTPUT_LANG}\n\n${ORGANIZER_SHAPE}` },
    { role: "user", content: `IDEA/COPY:\n${brief}\n\n${evidenceBlock(evidence)}` },
  ];
}

const VIEWPOINTS_SHAPE = `Return ONLY one compact JSON object, no markdown, no prose outside it:
{
  "viewpoints": [
    {
      "stance": "Ship" | "Fix" | "Pause" | "Kill",
      "text": "one concrete, specific objection or judgement argued strictly from your angle",
      "evidenceIds": ["E# from EVIDENCE that supports this, or omit"],
      "isHardestKill": true
    }
  ]
}`;

export function buildCriticViewpointsPrompt({ provider, persona, brief, evidence, organizerPlan, posture = "roast" }) {
  const devil = persona.id === "devils-advocate";
  const roast = posture === "roast";
  const extra = devil
    ? (roast
        ? `HARD: produce EXACTLY ONE viewpoint — your single strongest "this will die" kill-case — and mark it "isHardestKill": true. Even if everyone loves the idea, find it.`
        : `Produce EXACTLY ONE sharp, honest concern from a skeptic's angle. This is a BALANCED council (not a roast): surface the real tension, but do NOT force a "this will die" verdict and do NOT set isHardestKill.`)
    : `Produce EXACTLY ONE viewpoint — your single sharpest, most distinct point from your angle (the one thing you'd stake your seat on). Do NOT set isHardestKill.`;
  const tone = roast
    ? `Be adversarial: your job is to find what kills this.`
    : `Be a balanced critic: name the real disagreement honestly, but stay measured — surface tension, don't manufacture a kill.`;
  return [
    {
      role: "system",
      content: `${persona.system}

You are vendor seat "${provider}", ONE independent vendor in a REAL white-box deliberation. Stay strictly in your angle: ${persona.cn}.
${tone} Attack the ORGANIZER's target plan from your angle. ${extra}

${CITATION_RULES}

${OUTPUT_LANG}

${VIEWPOINTS_SHAPE}`,
    },
    {
      role: "user",
      content: `IDEA/COPY:\n${brief}\n\n${evidenceBlock(evidence)}\n\nORGANIZER's target plan:\n${organizerPlan}`,
    },
  ];
}

// R3 匿名交叉互驳(严酷档):把他人观点去署名喂回,逼出真分歧、减让步偏差。
export function buildCrossRebuttalPrompt({ provider, persona, brief, othersAnonymized }) {
  return [
    {
      role: "system",
      content: `${persona.system}

You are vendor seat "${provider}" in ROUND 3 of a white-box deliberation: ANONYMOUS CROSS-REBUTTAL.
Below are OTHER seats' viewpoints with identities hidden. Push back where you genuinely disagree, concede where they are right,
and sharpen the REAL disagreements. Stay in your angle: ${persona.cn}. Do NOT just repeat your earlier points — engage theirs.

${CITATION_RULES}

${OUTPUT_LANG}

${VIEWPOINTS_SHAPE}`,
    },
    { role: "user", content: `IDEA/COPY:\n${brief}\n\nOTHER SEATS' VIEWPOINTS (anonymized):\n${othersAnonymized}` },
  ];
}

const DELIBERATION_SHAPE = `Return ONLY one compact JSON object, no markdown, no prose outside it:
{
  "consensus": ["points most seats agree on (high-confidence, but NOT a conclusion)"],
  "contradictions": ["where seats directly conflict — the real disagreements"],
  "partialCoverage": ["points only some seats raised"],
  "uniqueInsights": [ { "seat": "vendor label", "text": "a sharp point only this model raised" } ],
  "blindSpots": ["important things NO seat raised but should have"]
}`;

export function buildChairmanSummaryPrompt({ brief, viewpoints }) {
  const lines = (viewpoints || [])
    .map((v) => `- [${v.seat} / ${v.roleAngle}${v.stance ? " / " + v.stance : ""}${v.isHardestKill ? " / HARDEST-KILL" : ""}] ${v.text}${v.evidenceIds?.length ? " (" + v.evidenceIds.join(",") + ")" : ""}`)
    .join("\n");
  return [
    { role: "system", content: `${DELIB_ROLES.chairman.system}\n\n${OUTPUT_LANG}\n\n${DELIBERATION_SHAPE}` },
    { role: "user", content: `IDEA/COPY:\n${brief}\n\nALL VIEWPOINTS:\n${lines || "(none)"}` },
  ];
}

// ============ §2.1 角色库(persona)+ 模型解耦 ============
// persona = 视角 + systemPrompt;与模型(engine)解耦 —— 任意可用模型可分配任意席,绝不写死厂商=角色。
export const PERSONAS = {
  // 功能席(中立,自动分配模型)
  organizer: { id: "organizer", cn: "主脑·整理", kind: "functional", system: DELIB_ROLES.organizer.system },
  verifier: {
    id: "verifier", cn: "事实核查", kind: "functional",
    system: `You are the VERIFIER (independent fact-checker) on a white-box deliberation council. You add NO new opinions.
Your only job: check each critic viewpoint's factual claims against the EVIDENCE list. For each viewpoint decide:
"supported" (listed evidence backs the factual claim), "unsupported" (asserted as fact but NO listed evidence backs it),
or "overreach" (some basis but the claim goes further than the evidence supports). Rebut unsupported/overreach in one short sentence.
Be strict — an unsupported factual assertion is a problem even if it sounds plausible. Opinions/judgements without factual claims = supported.`,
  },
  chairman: { id: "chairman", cn: "主席·综合", kind: "functional", system: DELIB_ROLES.chairman.system },
  // Idea 反方(opinionated)
  investor: { id: "investor", cn: "投资人", mode: "idea", kind: "opinionated", system: `You are an INVESTOR / buyer skeptic. Pressure-test who actually PAYS and why: vague or imaginary buyer, low willingness-to-pay, "vitamin not painkiller", no urgency, weak monetization, broken unit economics. Name the single weakest demand/monetization assumption. Cite evidence. Be specific, non-generic.` },
  growth: { id: "growth", cn: "增长·分发", mode: "idea", kind: "opinionated", system: `You are a GROWTH & DISTRIBUTION critic. Pressure-test how this actually REACHES users and spreads: realistic acquisition channel, CAC vs LTV, virality/retention realism, the wedge, why incumbents' distribution won't bury it. A great product with no distribution dies. Cite evidence. Be specific.` },
  feasibility: { id: "feasibility", cn: "可行性", mode: "idea", kind: "opinionated", system: ROLE_ANGLES.feasibility.system },
  "target-user": { id: "target-user", cn: "目标用户", mode: "idea", kind: "opinionated", system: `You are the TARGET-USER skeptic. Is the chosen user real, reachable, and acute enough — or too broad? Would they actually change behavior for this? Name the riskiest user assumption. Cite evidence.` },
  moat: { id: "moat", cn: "竞争·护城河", mode: "idea", kind: "opinionated", system: `You are the COMPETITION & MOAT critic. Who already does this, or could in a weekend? Why won't a bigger player crush it? What is the DURABLE moat (data, network, switching cost)? Cite competitor evidence. Be concrete.` },
  "domain-expert": { id: "domain-expert", cn: "领域专家", mode: "both", kind: "opinionated", system: `You are a DOMAIN EXPERT for this idea's field (compliance, clinical, privacy, security — whatever is relevant). Surface domain-specific risks an outsider misses: regulation, safety, data handling, liability. Be specific to the domain.` },
  // Copy 反方(opinionated)
  "comms-editor": { id: "comms-editor", cn: "传播编辑", mode: "copy", kind: "opinionated", system: `You are a COMMS EDITOR. Pressure-test the hook, the clarity, and which line is filler. Is the core message instantly clear in one read? What is the single strongest cut or rewrite? Be specific.` },
  "target-reader": { id: "target-reader", cn: "目标读者", mode: "copy", kind: "opinionated", system: `You are the TARGET READER. Read as the intended audience: does it land, what's confusing, what makes you act vs bounce? Be honest about your real reaction.` },
  "skeptic-reader": { id: "skeptic-reader", cn: "怀疑读者", mode: "copy", kind: "opinionated", system: `You are a SKEPTIC READER. Read as a distrustful audience: what feels overclaimed, salesy, vague, or unbelievable? What kills trust? Be specific.` },
  // 魔鬼代言人(强制,locked —— 任何配置都不可删,守反确认偏误)
  "devils-advocate": { id: "devils-advocate", cn: "魔鬼代言人", mode: "both", kind: "opinionated", locked: true, system: `You are the DEVIL'S ADVOCATE. HARD: regardless of how good it looks, construct the SINGLE STRONGEST "this will die" kill-case. Assume it fails and explain the most likely reason. Argue to kill or radically narrow. Do not hedge. If you cannot find a credible kill-case, dig harder. Be specific and incisive, never generic.` },
};

export const PERSONA_CN = Object.fromEntries(Object.values(PERSONAS).map((p) => [p.id, p.cn]));

// 默认配置:3 反方 + 魔鬼(locked)。便宜快;power user 可加角到上限=可用模型数(配置 UI 后续)。
export function DEFAULT_RUN_CONFIG(mode) {
  const seats = mode === "copy"
    ? ["comms-editor", "target-reader", "skeptic-reader", "devils-advocate"]
    : ["investor", "growth", "feasibility", "devils-advocate"];
  return { mode, seats: seats.map((personaId) => ({ personaId })), posture: "clarify" };
}

// 想清楚(clarify §2.2):主脑作为共创搭子 —— 结构化、追问、补完整、给建设性角度。sharp 但不开火、不强制 kill。
// ⚠️ Clarify ≠ 谄媚:仍要诚实、会追问、点出最尖锐张力,只是姿态是"帮你建/想清楚"。
export function buildClarifyPrompt({ mode, brief, evidence }) {
  const evLines = (evidence || []).slice(0, 10).map((e, i) => `[${e.id || "E" + (i + 1)}] ${e.claim || e.title}`).join("\n");
  return [
    {
      role: "system",
      content: `${OUTPUT_LANG}
你是用户的"主脑"——一个聪明、诚实、会追问的共创搭子(不是找茬机,也不是马屁精)。
姿态 = 帮 TA 把${mode === "copy" ? "这条文案" : "这个点子"}想清楚、补完整、变更强,而不是试图杀死它。
要 sharp:给真角度、点出真问题、问到关键处;但语气是"我们一起把它做对",不开火、不强制 kill、不下裁决。
只返回一个 JSON 对象,不要任何解释:
{
  "restate": "结构化重述:把它理清成一句话核心 + 2-3 个关键要素(让 TA 看到你真的懂了)",
  "keyQuestions": ["3-5 个真正决定成败、但 TA 大概还没想清的关键追问(具体、可回答,不是泛问)"],
  "constructiveAngles": ["2-3 个建设性角度:怎么把它做得更强 / 没想到的发力点 / 类比参照"],
  "sharpestTension": "一个最尖锐的待解张力(诚实指出,但措辞是'这点要解决'而非'这会死')"
}`,
    },
    {
      role: "user",
      content: `${mode === "copy" ? "文案" : "点子"}:\n${String(brief || "").slice(0, 1500)}${evLines ? `\n\n可参考的证据(可选用,标 [Ex]):\n${evLines}` : ""}`,
    },
  ];
}

// autoRecruit:判定点子是否触及受监管/专业领域,需要临时招一席领域专家反方。
export function buildDomainDetectPrompt({ brief }) {
  return [
    {
      role: "system",
      content: `Decide if this idea touches a REGULATED or specialist domain that warrants a dedicated EXPERT critic. Reply ONLY one JSON object, no prose:
{"domain":"finance|medical|privacy|legal|safety|none","cn":"中文角色名,如 合规反方 / 临床反方 / 隐私反方","systemFocus":"one short line: the domain-specific risks this critic should attack"}
If it's a generic consumer/SaaS/tooling idea with no special regulation, return domain "none".`,
    },
    { role: "user", content: String(brief || "").slice(0, 600) },
  ];
}

const VERIFIER_SHAPE = `Return ONLY one compact JSON object, no markdown, no prose outside it:
{
  "checks": [
    { "index": 0, "verdict": "supported" | "unsupported" | "overreach", "note": "one short sentence: why, or the rebuttal" }
  ]
}`;

export function buildVerifierPrompt({ brief, evidence, viewpoints }) {
  const lines = (viewpoints || [])
    .map((v, i) => `#${i} [${v.seat}/${v.roleAngle}] ${v.text}${v.evidenceIds?.length ? " (cites " + v.evidenceIds.join(",") + ")" : " (cites none)"}`)
    .join("\n");
  return [
    { role: "system", content: `${PERSONAS.verifier.system}\n\n${CITATION_RULES}\n\n${OUTPUT_LANG}\n\n${VERIFIER_SHAPE}` },
    { role: "user", content: `IDEA/COPY:\n${brief}\n\n${evidenceBlock(evidence)}\n\nVIEWPOINTS TO VERIFY (by index):\n${lines || "(none)"}` },
  ];
}

// ============ 人-steered 收敛(D):只吃人策展集合,反共识硬规则 ============
// 命根:AI 不下最终判。主脑据「人认领/钉死」的观点逐条应对;搁置留痕;最硬 kill 不可静音。
const CONVERGE_SHAPE = `Return ONLY one compact JSON object, no markdown, no prose outside it:
{
  "clarified": "what the founder now understands more clearly (1-3 sentences, NOT a verdict)",
  "addressed": [ { "tag": "the persona that raised it, e.g. 投资人 / 增长·分发", "point": "the endorsed/pinned objection (gist)", "response": "how the sharpened plan answers it" } ],
  "setAside": [ { "point": "a viewpoint the founder set aside (gist)", "reason": "their stated/implied reason — kept on record, not erased" } ],
  "unsilenceable": [ "the hardest kill-case(s) — restated plainly even if set aside" ],
  "openQuestions": [ "key questions still unvalidated" ],
  "cheapestTests": [ "cheapest concrete tests to run this week / 7 days" ],
  "aiTake": "OPTIONAL one-paragraph opinion — clearly just one opinion, not the answer"
}`;

export function buildConvergePrompt({ brief, evidence, endorsed, pinned, setAside, replies, unsilenceable }) {
  const fmtTagged = (arr) => (arr && arr.length ? arr.map((o) => `- [${o.tag || "?"}] ${o.text}`).join("\n") : "(none)");
  const fmt = (arr) => (arr && arr.length ? arr.map((t) => `- ${t}`).join("\n") : "(none)");
  const repl = (replies || []).length ? (replies || []).map((r) => `- 针对「${r.point}」你说:${r.note}`).join("\n") : "(none)";
  return [
    {
      role: "system",
      content: `You are the ORGANIZER converging the deliberation — but you are NOT a judge and you do NOT issue a Ship/Kill verdict.
HARD RULES (反共识,不可违反):
1. Converge ONLY around the human's CURATED set below — address each ENDORSED/PINNED objection point-by-point in "addressed".
2. The human's PINNED points must be answered most thoroughly.
3. SET-ASIDE viewpoints are NOT erased — record them honestly in "setAside" (留痕).
4. The UNSILENCEABLE hardest kill-case(s) MUST be restated plainly in "unsilenceable" EVEN IF the human set them aside.
   You may help the founder face them, but you may not delete or soften them away.
The product helps the founder THINK, it does not decide for them.

${OUTPUT_LANG}

${CONVERGE_SHAPE}`,
    },
    {
      role: "user",
      content: `IDEA/COPY:\n${brief}\n\n${evidenceBlock(evidence)}

THE HUMAN'S CURATION (only this shapes convergence):
认领(尖锐、要处理):\n${fmtTagged(endorsed)}
钉死(必答,最重要):\n${fmtTagged(pinned)}
搁置(留痕,不抹掉):\n${fmt(setAside)}
不可静音的最硬 kill:\n${fmt(unsilenceable)}
人的反驳:\n${repl}`,
    },
  ];
}
