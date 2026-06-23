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

export type EvidencePack = {
  mode?: "idea" | "copy";
  items: EvidenceItem[];
  byCategory: Record<string, string[]>; // category → evidenceId[]
  sources: string[];
  redacted: boolean;
  failures?: { source: string; error: string }[];
};

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
  "drift-detector": "漂移检测",
  "assumption-finder": "假设猎手",
  "focus-finder": "聚焦",
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
export type SignalAction = "endorse" | "setAside" | "pin" | "reply" | "clear";
export type CurationStatus = "endorse" | "setAside" | "pin" | "none";
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
export type ArtifactType = "copy" | "prd" | "design_doc" | "code_sketch" | "image";

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
};

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
