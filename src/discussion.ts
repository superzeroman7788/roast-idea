// 讨论式陪练的前端类型契约(讨论重构)。与后端 /api/discussion/* 对齐。

export type DiscussionMode = "idea" | "copy";

export type EvidenceItem = {
  id: string;
  category: string; // idea: competitor|oss|demand|pricing|pain / copy: viral|userVoice|competitorCopy|platform|risk
  claim: string;
  impact: string;   // 判断层产出:对这个点子意味着什么
  url: string;
  source: string;
  title: string;
  snippet: string;
  fetchedAt: string;
  credibility: "high" | "medium" | "low";
  tier?: "green" | "yellow" | "red"; // 源风险层:green=免cookie / yellow=需配 / red=cookie·封号风险
  engagement?: { metric: string; value: number };
  excluded?: boolean; // 用户手动排除,不进议会
};

// 侦察简报(搜索站右栏):读全部证据后 LLM 合成的关键结论 + 整体可信度 + 进/补扫建议
export type EvidenceBrief = {
  conclusions: { cat: string; text: string }[];
  confidence: "high" | "medium" | "low";
  suggestion: string;
  categories?: Record<string, string>;
};

export type EvidencePack = {
  mode?: "idea" | "copy";
  items: EvidenceItem[];
  byCategory: Record<string, string[]>; // category → evidenceId[]
  sources: string[];
  redacted: boolean;
  failures?: { source: string; error: string }[];
  brief?: EvidenceBrief | null;
};

// 搜索站维度导航(左栏):idea / copy 各一套
export type SearchDim = { id: string; name: string; en: string };
export const SEARCH_DIMS_IDEA: SearchDim[] = [
  { id: "all", name: "全部", en: "ALL" },
  { id: "competitor", name: "竞品", en: "COMPETITORS" },
  { id: "demand", name: "需求", en: "DEMAND" },
  { id: "pain", name: "痛点", en: "PAIN" },
  { id: "pricing", name: "定价", en: "PRICING" },
  { id: "trend", name: "趋势", en: "TRENDS" },
];
export const SEARCH_DIMS_COPY: SearchDim[] = [
  { id: "all", name: "全部", en: "ALL" },
  { id: "viral", name: "爆款", en: "VIRAL" },
  { id: "userVoice", name: "用户原话", en: "USER VOICE" },
  { id: "competitorCopy", name: "竞品文案", en: "RIVAL COPY" },
  { id: "platform", name: "平台", en: "PLATFORM" },
  { id: "risk", name: "风险", en: "RISK" },
];
// 类目 → 颜色(证据维度标签 + 简报结论要点)
export const CAT_COLOR: Record<string, string> = {
  competitor: "#7C8DFF", demand: "#3FDD8A", pain: "#E8975C", pricing: "#34D2E6", trend: "#FFD24A",
  viral: "#FF7556", userVoice: "#34D2E6", competitorCopy: "#7C8DFF", platform: "#4FD8C0", risk: "#FF5C6A",
};
// 来源 → 颜色点
export const SRC_COLOR: Record<string, string> = {
  github: "#8aa0ff", hn: "#FF7556", exa: "#4FD8C0", v2ex: "#7C8DFF", searxng: "#FFD24A",
  reddit: "#FF6B3D", jike: "#FFD24A", sspai: "#E84C4C", ph: "#FF7556", web: "#7e97b3",
};
// 三档可信度 → 0-100 数字条 + 中文
export function credScore(c?: string): number { return c === "high" ? 88 : c === "medium" ? 74 : 62; }
export const CONFIDENCE_CN: Record<string, string> = { high: "高", medium: "中", low: "低" };

export type Citation = { evidenceId: string | null; valid: boolean };

export type Seat = { id: string; label: string; role: string };

export type Turn = {
  id?: string;
  seq?: number;
  round: number;
  speaker: string; // provider label | "you" | "system"
  role: string; // host/builder/devils-advocate/demand-skeptic/feasibility/user
  body: string;
  citations: Citation[];
  askUser?: string;
  latencyMs?: number;
  failed?: boolean;
  error?: string;
  pinned?: boolean; // 用户点赞:这条主脑会重视、出卡优先纳入
};

export type Phase =
  | "drafting"
  | "opening"
  | "awaiting-user"
  | "responding"
  | "finalizing"
  | "finalized";

export type Discussion = {
  id: string;
  mode: DiscussionMode;
  title: string;
  status: "open" | "finalized";
  conclusion: string;
  seats: Seat[];
  turns: Turn[];
  artifacts?: Artifact[];
  viewpoints?: Viewpoint[];
  deliberation?: Deliberation | null;
  converged?: ConvergedOutput | null;
  clarify?: ClarifyOutput | null;
  relay?: RelayOutput | null;
};

// 透明投票(裁决不由主席独断;展示全 tally,标"仅参考")
export type VerdictVote = { tally: Record<string, number>; decision: string | null; simulated: boolean };

// 人-steered 收敛输出(输出重定义:帮人想明白,非 AI 裁决)
export type ConvergedOutput = {
  clarified: string;
  addressed: { tag?: string; point: string; response: string }[];
  setAside: { point: string; reason: string }[];
  unsilenceable: string[];
  openQuestions: string[];
  cheapestTests: string[];
  aiTake?: string;
  verdictVote?: VerdictVote;
};

// 对话姿态(§2.2):独立于 idea/copy,控对抗强度。intensity(R3)已折进 roast。
export type Posture = "clarify" | "council" | "roast";
export const POSTURE_LABEL: Record<Posture, string> = { clarify: "想清楚", council: "审议", roast: "拷问" };
export const POSTURE_HINT: Record<Posture, string> = {
  clarify: "共创 · 主脑陪你理清(不召反方、不强制 kill)",
  council: "平衡 · 多视角综述,摆分歧不强逼最硬 kill",
  roast: "对抗 · 全套议会 + 强制魔鬼 + 不可静音 + 裁决",
};

// 选角配置(§2.1):persona↔model 解耦
export type SeatConfig = { personaId: string; modelId?: string };
export type RunConfig = {
  mode: DiscussionMode;
  seats: SeatConfig[];
  functional?: { organizer?: string; verifier?: string; chairman?: string };
  autoRecruitDomain?: boolean;
  posture: Posture;
};
export type PersonaInfo = { id: string; cn: string; locked?: boolean };

// 想清楚(clarify)产出:主脑作为共创搭子的结构化白箱(非裁决、非找茬,但仍 sharp)
export type ClarifyOutput = {
  restate: string;              // 结构化重述:把点子理清成一句话 + 几个要素
  keyQuestions: string[];       // 3-5 个关键追问(决定成败、你还没想清的)
  constructiveAngles: string[]; // 建设性角度:怎么把它做得更强
  sharpestTension: string;      // 最尖锐的一个张力/待解(诚实,但"待解决"非"杀死")
  createdAt?: string;
};

// 跨模型接力(想清楚引擎):方案在 4 家模型间逐棒传递,每棒接受核心 + 扩大思考范围(非盯小处)
export type RelayFraming = { oneLine: string; clear: string[]; assumptions: string[]; openQuestions: string[] };
export type RelayHop = {
  order: number;        // 1..N
  seat: string;         // 出品厂商 label(Claude/OpenAI/DeepSeek/Kimi)
  lens?: string | null; // 思考镜头(某一棒戴):drift-detector / assumption-finder …
  role: "seed" | "expand" | "synth";
  accepted?: string;    // 接受的扎实核心(expand 棒)
  added: string[];      // 这一棒新铺开的角度/维度(扩大思考范围的产物)
  framing?: RelayFraming | null; // 该棒修订后的框架(seed/expand)
  failed?: boolean;
  error?: string;
  latencyMs?: number;
};
// 方向卡(两层:AI 向你发问定方向 + 邀你主动补判断)。MVP 人驱动。
export type DirectionCard = {
  oneLine: string;                 // 一句话内核
  clear: string[];                 // 已稳定(几棒没动的共识核)
  expandedAngles: string[];        // 接力铺开的新角度
  assumptions: string[];           // 关键假设
  paths: { name: string; fit: string; risk: string }[]; // 2-3 条路径带权衡
  firstNarrowing: string;          // 推荐先收窄哪一刀
  decisionsForYou: string[];       // AI → 你:需你拍板的决策
  inviteYourInput: string;         // 邀你基于具体情况主动补的判断
  dontBuildYet: string[];          // 现在先别建什么
};
export type RelayOutput = {
  hops: RelayHop[];
  card: DirectionCard | null;
  models: string[];
  createdAt?: string;
};

export const RELAY_LENS_CN: Record<string, string> = {
  "drift-detector": "漂移检测·反方",
  "assumption-finder": "假设猎手",
  "focus-finder": "聚焦",
  "market-lens": "市场·用户场景",
  "consensus-mapper": "共识·分歧整理",
};

// 审议引擎(白箱):结构化署名观点 + Fusion 式审议综述
export type Stance = "Ship" | "Fix" | "Pause" | "Kill";

export type Verification = { verdict: "supported" | "unsupported" | "overreach"; note: string };

export type Viewpoint = {
  id?: string;
  discussionId?: string;
  seat: string; // 出品厂商 label
  roleAngle: string; // personaId:organizer/investor/growth/feasibility/devils-advocate/...
  stance: Stance | null;
  text: string;
  evidenceIds: string[];
  isHardestKill: boolean; // 不可静音的最硬 kill
  round: number; // 1=立靶 2=独立开火 3=交叉
  verification?: Verification | null; // Verifier 事实核查结论
  latencyMs?: number;
  createdAt?: string;
};

export type Deliberation = {
  consensus: string[];
  contradictions: string[];
  partialCoverage: string[];
  uniqueInsights: { seat: string; text: string }[];
  blindSpots: string[];
  simulated: boolean;
  createdAt?: string;
};

// 人策展(人在环中):endorse=这点尖锐我要处理(≠agree)
export type SignalAction = "endorse" | "setAside" | "pin" | "reject" | "reply" | "clear";
export type CurationStatus = "endorse" | "setAside" | "pin" | "reject" | "none";
export type HumanSignal = { id?: string; viewpointId: string; action: SignalAction; note: string; createdAt?: string };

export const STANCE_COLOR: Record<string, string> = {
  Ship: "#46e6a0",
  Fix: "#ffb44d",
  Pause: "#c9a0ff",
  Kill: "#ff5c6a",
};

export const ANGLE_LABEL: Record<string, string> = {
  organizer: "主脑·整理",
  verifier: "事实核查",
  chairman: "主席·综合",
  // idea 反方
  investor: "投资人",
  growth: "增长·分发",
  feasibility: "可行性",
  "target-user": "目标用户",
  moat: "竞争·护城河",
  "domain-expert": "领域专家",
  demand: "需求怀疑",
  // copy 反方
  "comms-editor": "传播编辑",
  "target-reader": "目标读者",
  "skeptic-reader": "怀疑读者",
  // 魔鬼
  "devils-advocate": "魔鬼代言人",
};

// 产出层(交付物):把方案变成文案/PRD/设计文档/代码草稿/配图
export type ArtifactType = "copy" | "prd" | "design_doc" | "code_sketch" | "image" | "ppt";

export type Artifact = {
  id: string;
  discussionId: string;
  type: ArtifactType;
  provider: string; // 出品厂商 label
  content: string; // 文字交付物正文(markdown/代码);图为空
  imagePath: string | null; // 图片;文字为 null
  parentId: string | null; // 改稿:上一版 id(谱系)
  mode: "draft" | "refine";
  instruction: string;
  status: "candidate" | "chosen";
  createdAt: string;
  latencyMs?: number;
};

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  copy: "文案",
  prd: "一页 PRD",
  design_doc: "设计文档",
  code_sketch: "代码草稿",
  image: "配图",
  ppt: "PPT",
};

// 产出站格式格(中栏五宫格):id 对应 ArtifactType
export type ProduceFormat = { id: ArtifactType; ic: string; name: string; en: string; c: string; sub: string };
export const PRODUCE_FORMATS: ProduceFormat[] = [
  { id: "copy", ic: "¶", name: "文案", en: "COPY", c: "#46DDA0", sub: "落地页 / Slogan" },
  { id: "prd", ic: "▤", name: "PRD", en: "PRD", c: "#34D2E6", sub: "需求文档" },
  { id: "design_doc", ic: "◳", name: "设计文档", en: "DESIGN", c: "#E8975C", sub: "信息架构 / 流程" },
  { id: "image", ic: "◍", name: "配图", en: "IMAGE", c: "#7C8DFF", sub: "封面 / 示意图" },
  { id: "ppt", ic: "▦", name: "PPT", en: "DECK", c: "#F2BF52", sub: "路演 / 介绍" },
];

export const ROLE_LABEL: Record<string, string> = {
  host: "主持",
  builder: "建设者",
  "devils-advocate": "魔鬼代言人",
  "demand-skeptic": "需求怀疑者",
  feasibility: "可行性",
  synthesizer: "综合者",
  user: "你",
};

export const ROLE_COLOR: Record<string, string> = {
  host: "#34e1ff",
  builder: "#46e6a0",
  "devils-advocate": "#ff5c6a",
  "demand-skeptic": "#ffb44d",
  feasibility: "#c9a0ff",
  user: "#dcecf6",
};

// ===== 四站工作台:搜索/陪练/议会/产出(相互独立 + MD 文档交接) =====
export type Tab = "search" | "relay" | "council" | "produce";
export const TAB_ORDER: Tab[] = ["search", "relay", "council", "produce"];
export const TAB_LABEL: Record<Tab, string> = { search: "搜索", relay: "陪练", council: "议会", produce: "产出" };
export const TAB_SUB: Record<Tab, string> = { search: "事实侦察", relay: "想清楚", council: "温和/拷问", produce: "生图/文/PPT" };

// 议会内部强度:温和(council)⇄ 拷问(roast)
export type CouncilIntensity = "council" | "roast";
export const INTENSITY_LABEL: Record<CouncilIntensity, string> = { council: "温和", roast: "拷问" };

// 工作台文档(交接载荷):每站产出序列化成一份规范 MD
export type StationDoc = { station: Tab; name: string; md: string };

export function evidenceToMd(pack: EvidencePack | null): string {
  if (!pack || !pack.items?.length) return "";
  const L: string[] = ["# 证据简报", ""];
  for (const it of pack.items) {
    if (it.excluded) continue;
    L.push(`## [${it.category}] ${it.claim}`);
    if (it.impact) L.push(`- 意味:${it.impact}`);
    L.push(`- 来源:${it.source}${it.url ? ` (${it.url})` : ""} · 可信度 ${it.credibility}`);
    L.push("");
  }
  return L.join("\n").trim();
}

export function cardToMd(card: DirectionCard | null): string {
  if (!card) return "";
  const L: string[] = ["# 方向卡", "", `**一句话内核**:${card.oneLine}`, ""];
  const sec = (title: string, items?: string[]) => {
    if (items && items.length) { L.push(`## ${title}`); items.forEach((x) => L.push(`- ${x}`)); L.push(""); }
  };
  sec("已稳定", card.clear);
  sec("接力铺开的新角度", card.expandedAngles);
  sec("关键假设", card.assumptions);
  if (card.paths?.length) { L.push("## 路径"); card.paths.forEach((p) => L.push(`- **${p.name}**:契合 ${p.fit} / 风险 ${p.risk}`)); L.push(""); }
  if (card.firstNarrowing) { L.push("## 推荐先收窄", card.firstNarrowing, ""); }
  sec("需你拍板", card.decisionsForYou);
  if (card.inviteYourInput) { L.push("## 邀你补充", card.inviteYourInput, ""); }
  sec("现在先别建", card.dontBuildYet);
  return L.join("\n").trim();
}

export function convergedToMd(c: ConvergedOutput | null): string {
  if (!c) return "";
  const L: string[] = ["# 收敛方案", "", c.clarified, ""];
  if (c.addressed?.length) { L.push("## 已应对"); c.addressed.forEach((a) => L.push(`- ${a.tag ? `[${a.tag}] ` : ""}${a.point} → ${a.response}`)); L.push(""); }
  if (c.unsilenceable?.length) { L.push("## 不可静音(即使搁置也保留)"); c.unsilenceable.forEach((x) => L.push(`- ${x}`)); L.push(""); }
  if (c.setAside?.length) { L.push("## 暂搁置"); c.setAside.forEach((s) => L.push(`- ${s.point} — ${s.reason}`)); L.push(""); }
  if (c.openQuestions?.length) { L.push("## 待你验证的开放问题"); c.openQuestions.forEach((x) => L.push(`- ${x}`)); L.push(""); }
  if (c.cheapestTests?.length) { L.push("## 最便宜的验证"); c.cheapestTests.forEach((x) => L.push(`- ${x}`)); L.push(""); }
  if (c.aiTake) { L.push("## AI 视角(仅参考)", c.aiTake); }
  return L.join("\n").trim();
}
