// 讨论式陪练的前端类型契约(讨论重构)。与后端 /api/discussion/* 对齐。

export type DiscussionMode = "idea" | "copy";

export type EvidenceItem = {
  id: string;
  claim: string;
  url: string;
  source: string;
  title: string;
  snippet: string;
  fetchedAt: string;
  credibility: "high" | "medium" | "low";
};

export type EvidencePack = {
  items: EvidenceItem[];
  byTheme: {
    competitors: string[];
    demandSignals: string[];
    pricing: string[];
    saturation: string[];
  };
  sources: string[];
  redacted: boolean;
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
