import React, { useMemo } from "react";

// 实时议会图谱(docs/UI-design-jarvis.md §4)。
// 铁律:节点/连线一律来自真实 run 数据,绝不写死假数据当展示。
// 节点:中心=点子核;模型席位(按 stance 着色,魔鬼代言人红边);证据(琥珀)。
// 连线:模型→点子(参与)、模型↔模型(分歧,红虚线)、模型→证据(引用,青)、证据→点子(琥珀)。

export type GraphPhase =
  | "idle"
  | "searching"
  | "evidence-ready"
  | "debating"
  | "validating"
  | "verdict";

export type GraphObjection = { evidenceId?: string | null; valid?: boolean };
export type GraphSeat = {
  provider: string;
  roleAngle?: string;
  stance: string; // Ship | Fix | Pause | Kill | Failed
  objections?: GraphObjection[];
  failed?: boolean; // 调用失败的 provider:降级显示,不崩全场(P3)
};
export type EvidenceNode = { id: string; source: string; credibility?: string };

const C = 260;
const R_SEAT = 150;
const R_EV = 212;

const STANCE_FILL: Record<string, string> = {
  Kill: "#ff5d6e",
  Fix: "#ffb158",
  Ship: "#3fe3a0",
  Pause: "#1b9fc4",
};
const stanceColor = (s: string) => STANCE_FILL[s] || "#48dcff";

// 讨论模式:节点按角色着色
const ROLE_FILL: Record<string, string> = {
  host: "#48dcff",
  builder: "#3fe3a0",
  "devils-advocate": "#ff5d6e",
  "demand-skeptic": "#ffb158",
  feasibility: "#c9a0ff",
  synthesizer: "#48dcff",
};
const ROLE_LABEL: Record<string, string> = {
  host: "主持",
  builder: "建设者",
  "devils-advocate": "魔鬼",
  "demand-skeptic": "需求",
  feasibility: "可行性",
};

function ringPos(i: number, n: number, r: number, offset = 0) {
  const a = (-90 + ((i + offset) * 360) / Math.max(1, n)) * (Math.PI / 180);
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
}

export function CouncilGraph({
  seats,
  evidence = [],
  phase,
  revealed,
  showDissentOnly = false,
  speaking = "",
}: {
  seats: GraphSeat[];
  evidence?: EvidenceNode[];
  phase: GraphPhase;
  revealed: number;
  showDissentOnly?: boolean;
  speaking?: string; // 当前/最近发言的 provider label,高光
}) {
  const n = seats.length;
  const m = Math.min(evidence.length, 10);
  const ev = evidence.slice(0, m);
  const seatPositions = useMemo(() => seats.map((_, i) => ringPos(i, n, R_SEAT)), [n]);
  const evPositions = useMemo(() => ev.map((_, i) => ringPos(i, m, R_EV, 0.5)), [m]);
  const evIndex = useMemo(() => {
    const map = new Map<string, number>();
    ev.forEach((e, i) => map.set(e.id, i));
    return map;
  }, [m]);

  const debating = phase === "debating";
  const showEvidence = phase !== "idle" && phase !== "searching" && m > 0 && !showDissentOnly;

  // 分歧连线:Kill ↔ 非 Kill(真实 stance 差异),只连已点亮
  const dissentEdges: Array<[number, number]> = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (i >= revealed || j >= revealed) continue;
      if (seats[i].failed || seats[j].failed) continue; // 失败节点不参与分歧
      const a = seats[i].stance;
      const b = seats[j].stance;
      if ((a === "Kill" || b === "Kill") && a !== b) dissentEdges.push([i, j]);
    }

  // 引用连线:已点亮席位的有效引用 → 对应证据节点
  const citeEdges: Array<{ s: number; e: number }> = [];
  const citedEv = new Set<number>();
  if (showEvidence) {
    for (let i = 0; i < Math.min(revealed, n); i++) {
      if (seats[i].failed) continue;
      for (const o of seats[i].objections || []) {
        if (o.valid && o.evidenceId && evIndex.has(o.evidenceId)) {
          const e = evIndex.get(o.evidenceId)!;
          citeEdges.push({ s: i, e });
          citedEv.add(e);
        }
      }
    }
  }

  return (
    <svg className="hud" viewBox="0 0 520 520" preserveAspectRatio="xMidYMid meet">
      <g fill="none">
        <circle cx={C} cy={C} r="232" stroke="#16324d" />
        <circle cx={C} cy={C} r="186" stroke="#13283e" />
        <circle cx={C} cy={C} r="120" stroke="#12253a" />
      </g>
      <circle className="spin" style={{ transformOrigin: "260px 260px" }} cx={C} cy={C} r="232"
        fill="none" stroke="#48dcff" strokeWidth="1" strokeDasharray="2 16" opacity=".5" />
      <circle className="spin-r" style={{ transformOrigin: "260px 260px" }} cx={C} cy={C} r="186"
        fill="none" stroke="#48dcff" strokeWidth="1" strokeDasharray="1 22" opacity=".38" />
      <g stroke="#2a4a6a" strokeWidth="1">
        <line x1="260" y1="22" x2="260" y2="34" /><line x1="260" y1="486" x2="260" y2="498" />
        <line x1="22" y1="260" x2="34" y2="260" /><line x1="486" y1="260" x2="498" y2="260" />
      </g>
      <g stroke="#48dcff22" strokeWidth="1">
        <line x1="40" y1="260" x2="480" y2="260" /><line x1="260" y1="40" x2="260" y2="480" />
      </g>

      {/* 证据 → 点子核(琥珀,被引用的证据) */}
      {showEvidence &&
        evPositions.map((p, i) =>
          citedEv.has(i) ? (
            <line key={`ec${i}`} className="edge-appear" x1={p.x} y1={p.y} x2={C} y2={C}
              stroke="#ffb158" strokeWidth="1.1" style={{ ["--edge-o" as any]: ".4" }} opacity=".4" />
          ) : null,
        )}

      {/* 模型 → 证据(青色引用线) */}
      {citeEdges.map((ce, k) => (
        <line key={`ci${k}`} className="edge-appear" x1={seatPositions[ce.s].x} y1={seatPositions[ce.s].y}
          x2={evPositions[ce.e].x} y2={evPositions[ce.e].y} stroke="#48dcff" strokeWidth="1"
          style={{ ["--edge-o" as any]: ".5" }} opacity=".5" />
      ))}

      {/* 模型 → 点子核(参与) */}
      {!showDissentOnly &&
        seatPositions.map((p, i) =>
          i < revealed && !seats[i].failed ? (
            <line key={`c${i}`} className="edge-appear" x1={C} y1={C} x2={p.x} y2={p.y}
              stroke="#48dcff" strokeWidth="1.2" style={{ ["--edge-o" as any]: ".4" }} opacity=".4" />
          ) : null,
        )}

      {/* 模型 ↔ 模型 分歧(红虚线) */}
      {dissentEdges.map(([i, j], k) => (
        <line key={`d${k}`} className="edge-appear" x1={seatPositions[i].x} y1={seatPositions[i].y}
          x2={seatPositions[j].x} y2={seatPositions[j].y} stroke="#ff5d6e" strokeWidth="1.3"
          strokeDasharray="4 5" style={{ ["--edge-o" as any]: ".7" }} opacity=".7" />
      ))}

      {/* 证据节点(琥珀) */}
      {showEvidence &&
        ev.map((e, i) => {
          const p = evPositions[i];
          const cited = citedEv.has(i);
          return (
            <g key={`e${i}`} className="node-appear" style={{ transformOrigin: `${p.x}px ${p.y}px` }}>
              <circle cx={p.x} cy={p.y} r={cited ? 5.5 : 4} fill="#ffb158" opacity={cited ? 0.95 : 0.55}
                style={{ filter: cited ? "drop-shadow(0 0 6px #ffb158)" : "none" }} />
              <text x={p.x} y={p.y < C ? p.y - 8 : p.y + 14} textAnchor="middle"
                fontFamily="ui-monospace,Menlo,monospace" fontSize="8" fill={cited ? "#ffce93" : "#8a6a3a"}>
                {e.id}·{e.source}
              </text>
            </g>
          );
        })}

      {/* 中心点子核 */}
      <circle className="core" cx={C} cy={C} r="16" fill="#48dcff" opacity=".9"
        style={{ filter: "drop-shadow(0 0 16px #48dcff)" }} />
      <circle cx={C} cy={C} r="8" fill="#dffaff" />
      <text x={C} y="296" textAnchor="middle" fontFamily="ui-monospace,Menlo,monospace"
        fontSize="9" fill="#9fdcef">IDEA · 核心</text>

      {/* 模型席位节点 */}
      {seats.map((seat, i) => {
        if (i >= revealed) return null;
        const p = seatPositions[i];
        const failed = Boolean(seat.failed);
        const role = seat.roleAngle || "";
        const isDevil = role === "devils-advocate";
        const roleColor = ROLE_FILL[role] || "#48dcff";
        const speakingNow = !failed && !!speaking && seat.provider === speaking;
        const stroke = failed ? "#3a4658" : roleColor;
        const fill = failed ? "#0b0e15" : isDevil ? "#241018" : "#0c2536";
        const above = p.y < C;
        const bottom = failed ? "FAILED" : seat.stance ? seat.stance.toUpperCase() : ROLE_LABEL[role] || role;
        return (
          <g key={`m${i}`} className="node-appear" style={{ transformOrigin: `${p.x}px ${p.y}px`, opacity: failed ? 0.7 : 1 }}>
            <circle className={!failed && (debating || speakingNow) ? "pulse" : undefined} cx={p.x} cy={p.y}
              r={speakingNow ? 12.5 : 11} fill={fill} stroke={stroke}
              strokeWidth={failed ? 1.2 : speakingNow ? 2.4 : 1.6}
              strokeDasharray={failed ? "3 3" : undefined}
              style={{ filter: failed ? "none" : `drop-shadow(0 0 ${speakingNow ? 16 : 10}px ${roleColor}${speakingNow ? "" : "88"})` }} />
            {failed && (
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontFamily="ui-monospace,Menlo,monospace"
                fontSize="11" fill="#6a7891">✕</text>
            )}
            <text x={p.x} y={above ? p.y - 18 : p.y - 16} textAnchor="middle"
              fontFamily="ui-monospace,Menlo,monospace" fontSize="10"
              fill={failed ? "#5a6a80" : isDevil ? "#ff9aa3" : "#9fdcef"}>
              {seat.provider}
            </text>
            <text x={p.x} y={above ? p.y + 26 : p.y + 28} textAnchor="middle"
              fontFamily="ui-monospace,Menlo,monospace" fontSize="9"
              fill={failed ? "#6a7891" : roleColor}>
              {bottom}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
