import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import {
  CouncilReport,
  EvidenceItem,
  RoastMode,
  buildSampleReport,
  sampleBrief,
} from "./roastEngine";
import { CouncilGraph, GraphPhase, GraphSeat } from "./CouncilGraph";
import { exportShareImage } from "./shareImage";

const PHASE_INDEX: Record<GraphPhase, number> = {
  idle: 0,
  searching: 1,
  "evidence-ready": 2,
  debating: 3,
  validating: 4,
  verdict: 5,
};

type Pack = { items: EvidenceItem[]; sources: string[]; redacted: boolean } | null;

const BLANK: CouncilReport = {
  verdict: "—", summary: "", confidenceRange: "", vendorSpread: "", dissentLevel: "",
  hookClarity: "", nextAction: "", fatalAssumption: "", cheapestTest: "",
  topRisks: [], whatToCut: [], dissentMap: [], copyDiagnosis: "", sevenDayPlan: "",
  panel: [], debate: [],
};

function toSeats(report: CouncilReport): GraphSeat[] {
  return (report.panel || []).map((m) => ({
    provider: m.provider,
    roleAngle: m.roleAngle,
    stance: m.stance,
    objections: m.objections,
  }));
}

function dissentCount(seats: GraphSeat[]): number {
  let c = 0;
  for (let i = 0; i < seats.length; i++)
    for (let j = i + 1; j < seats.length; j++) {
      if (seats[i].failed || seats[j].failed) continue;
      const a = seats[i].stance, b = seats[j].stance;
      if ((a === "Kill" || b === "Kill") && a !== b) c++;
    }
  return c;
}

// ok 席位 + 失败 provider → 图谱节点
function toGraphSeats(report: CouncilReport): GraphSeat[] {
  const failed: GraphSeat[] = (report.live?.failures || []).map((f) => ({
    provider: f.provider, stance: "Failed", failed: true,
  }));
  return [...toSeats(report), ...failed];
}

// 单个流式席位事件 → 图谱节点(失败不伪造,降级显示)
function mapSeatEvent(seat: any): GraphSeat {
  return seat.ok
    ? { provider: seat.provider, roleAngle: seat.roleAngle, stance: seat.stance, objections: seat.objections }
    : { provider: seat.provider, stance: "Failed", failed: true };
}

// 解析一段 SSE(event: / data:)
function parseSSE(raw: string): { event: string; data: any } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function App() {
  const initialSample = useMemo(() => buildSampleReport(sampleBrief.idea, "idea"), []);
  const [mode, setMode] = useState<RoastMode>("idea");
  const [brief, setBrief] = useState(sampleBrief.idea);
  const [report, setReport] = useState<CouncilReport>(initialSample);
  const [pack, setPack] = useState<Pack>(null);
  const [phase, setPhase] = useState<GraphPhase>("verdict");
  const [revealed, setRevealed] = useState(initialSample.panel.length);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [conn, setConn] = useState<{ ok: boolean; text: string }>({ ok: false, text: "检测中" });
  const [dissentOnly, setDissentOnly] = useState(false);
  const [retrieve, setRetrieve] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  const runToken = useRef(0);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [seats, setSeats] = useState<GraphSeat[]>(() => toGraphSeats(initialSample));
  const evNodes = useMemo(
    () => (pack?.items || []).map((i) => ({ id: i.id, source: i.source, credibility: i.credibility })),
    [pack],
  );
  const live = report.live;
  const isSample = Boolean(report.isSample);
  const isSimulated = isSample || Boolean(live?.simulated);
  const pIdx = PHASE_INDEX[phase];

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => {
        const configured =
          data.providers?.filter((p: { configured: boolean }) => p.configured) || [];
        setConn({
          ok: configured.length >= 2,
          text: configured.length >= 2 ? `已连接 · ${configured.length} 家` : `需 ≥2 家 · 当前 ${configured.length}`,
        });
      })
      .catch(() => setConn({ ok: false, text: "API 离线" }));
    return () => stopElapsed();
  }, []);

  function stopElapsed() {
    if (elapsedTimer.current) clearInterval(elapsedTimer.current);
    elapsedTimer.current = null;
  }
  function startElapsed() {
    stopElapsed();
    const t0 = Date.now();
    setElapsed(0);
    elapsedTimer.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
  }

  async function runRoast() {
    const token = ++runToken.current;
    setRunError("");
    setIsRunning(true);
    setReport(BLANK);
    setSeats([]);
    setRevealed(0);
    setPack(null);
    startElapsed();
    setPhase("searching");
    const acc: GraphSeat[] = [];
    try {
      // SSE 流式:证据 → 逐席位(真实完成顺序)→ 裁决
      const res = await fetch("/api/roast/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ mode, brief, redacted: !retrieve }),
      });
      if (!res.ok || !res.body) {
        throw new Error((await res.text().catch(() => "")) || "Council stream failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (token !== runToken.current) {
          try { await reader.cancel(); } catch {}
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const ev = parseSSE(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (!ev) continue;
          if (ev.event === "evidence") {
            const p = ev.data.pack;
            setPack({ items: p.items, sources: p.sources, redacted: p.redacted });
            setPhase("evidence-ready");
          } else if (ev.event === "seat") {
            acc.push(mapSeatEvent(ev.data));
            setSeats([...acc]);
            setRevealed(acc.length);
            setPhase("debating");
          } else if (ev.event === "verdict") {
            const rep: CouncilReport = ev.data.report;
            setReport(rep);
            if (rep.evidence) {
              setPack({ items: rep.evidence.items, sources: rep.evidence.sources, redacted: rep.evidence.redacted });
            }
            const finalSeats = toGraphSeats(rep);
            setSeats(finalSeats);
            setRevealed(finalSeats.length);
            setPhase("validating");
            await delay(550);
            if (token !== runToken.current) return;
            setPhase("verdict");
          } else if (ev.event === "error") {
            throw new Error(ev.data?.error || "stream error");
          }
        }
      }
    } catch (e) {
      if (token === runToken.current) {
        setRunError((e as Error)?.message || "Council run failed");
        setPhase("idle");
      }
    } finally {
      if (token === runToken.current) {
        setIsRunning(false);
        stopElapsed();
      }
    }
  }

  function loadSample(nextMode: RoastMode) {
    runToken.current++;
    setIsRunning(false);
    stopElapsed();
    setMode(nextMode);
    setBrief(sampleBrief[nextMode]);
    const s = buildSampleReport(sampleBrief[nextMode], nextMode);
    setReport(s);
    setSeats(toGraphSeats(s));
    setPack(null);
    setRevealed(s.panel.length);
    setPhase("verdict");
    setRunError("");
  }

  // 派生展示量(全部来自真实数据)
  const cit = report.citations;
  const okCount = seats.filter((s) => !s.failed).length;
  const modelsLive = live?.providerCount ?? okCount;
  const modelsTotal = live ? live.providerCount + (live.failures?.length || 0) : seats.length;
  const dCount = dissentCount(seats.slice(0, revealed));
  const nodes = 1 + revealed + (phase !== "idle" && phase !== "searching" ? evNodes.length : 0);
  const verdictStance = isRunning ? "议会进行中…" : report.verdict || "—";
  const isKill = /kill/i.test(verdictStance);
  const confFrac = isSample ? 0.6 : isSimulated ? 0.2
    : ({ 2: 0.55, 3: 0.66, 4: 0.74, 5: 0.8 } as Record<number, number>)[modelsLive] ?? 0.5;
  const ARC = 100;
  const evCount = pack && !pack.redacted ? pack.items.length : retrieve ? null : 0;

  return (
    <div className={`app${isSimulated && !isRunning ? " is-simulated" : ""}`}>
      <div className="chrome">
        <div className="dot r" /><div className="dot y" /><div className="dot g" />
        <div className="title">ROAST · <b>DECISION COUNCIL</b> · 认知界面</div>
        <div className="conn" style={{ color: conn.ok ? "var(--green)" : "var(--tx3)" }}>
          <span className="blink" style={{ background: conn.ok ? "#46e6a0" : "#52688a", boxShadow: conn.ok ? "0 0 8px #46e6a0" : "none" }} />
          {conn.text}
        </div>
      </div>

      <div className="grid">
        {/* LEFT */}
        <div className="col left">
          <div className="eyebrow">输入处理器 <span className="live"><span className="blink" />{phase === "idle" ? "待命" : isRunning ? "运行" : "就绪"}</span></div>
          <div className="reactor-wrap">
            <svg width="140" height="140" viewBox="0 0 140 140">
              <circle cx="70" cy="70" r="58" fill="none" stroke="#163a52" strokeWidth="1" />
              <circle cx="70" cy="70" r="58" fill="none" stroke="#34e1ff" strokeWidth="1.4" strokeDasharray="6 10" opacity=".7" style={{ transformOrigin: "70px 70px", animation: "spin 18s linear infinite" }} />
              <circle cx="70" cy="70" r="44" fill="none" stroke="#173052" strokeWidth="1" strokeDasharray="2 6" />
              <circle cx="70" cy="70" r="30" fill="#0c2233" stroke="#34e1ff" strokeWidth="1" opacity=".5" />
              <circle className={isRunning ? "core" : undefined} cx="70" cy="70" r="15" fill="#34e1ff" opacity={isRunning ? 0.9 : 0.4} style={{ filter: "drop-shadow(0 0 12px #34e1ff)" }} />
              <circle cx="70" cy="70" r="7" fill="#bfffff" opacity={isRunning ? 1 : 0.5} />
            </svg>
          </div>
          <div className="stat-row"><span>EVIDENCE</span><b className="amber">{evCount === null ? "—" : evCount}</b></div>
          <div className="stat-row"><span>SOURCES</span><b>{pack && !pack.redacted ? pack.sources.length : "—"}</b></div>
          <div className="stat-row"><span>MODELS</span><b>{modelsLive} <span style={{ color: "#52688a" }}>/</span> {modelsTotal}</b></div>
          <div className="stat-row"><span>CITATIONS</span><b>{cit ? <>{cit.valid} <span style={{ color: "#52688a" }}>/</span> {cit.invalid > 0 ? <span className="red">{cit.invalid}✕</span> : "0"}</> : "—"}</b></div>
          <div className="mode">
            <button className={mode === "idea" ? "on" : ""} onClick={() => loadSample("idea")}>IDEA</button>
            <button className={mode === "copy" ? "on" : ""} onClick={() => loadSample("copy")}>COPY</button>
          </div>
          <button className="mode" style={{ marginTop: 8 }} onClick={() => setRetrieve((v) => !v)} title="关闭后不把点子发去检索(P7 隐私)">
            <span style={{ flex: 1, textAlign: "left", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".14em", color: retrieve ? "var(--cyan)" : "var(--tx3)", padding: "8px", border: "1px solid #1d3350", borderRadius: 7, background: "#0a1626" }}>
              检索证据 · {retrieve ? "ON" : "OFF(redacted)"}
            </span>
          </button>
          <div className={`verdict${isSample ? " sample" : isKill ? " kill" : ""}`}>
            <div className="lbl">{isSample ? "SAMPLE · 示例" : "VERDICT · 裁决"}</div>
            <div className="v">{verdictStance}</div>
            {isSample && <div className="note">非真实 run · 点 RUN COUNCIL 获取真裁决</div>}
            {!isSample && isSimulated && !isRunning && <div className="note">参与不足(&lt;2 家),非完整议会</div>}
          </div>
        </div>

        {/* CENTER */}
        <div className="col center">
          <div className="stage">
            <span className={`step ${pIdx > 2 ? "done" : pIdx >= 1 ? "now" : ""}`}>检索</span>
            <span className={`step ${pIdx > 3 ? "done" : pIdx === 3 ? "now" : ""}`}>整理</span>
            <span className={`step ${pIdx > 4 ? "done" : pIdx === 3 || pIdx === 4 ? "now" : ""}`}>对线</span>
            <span className={`step ${pIdx === 5 ? "now" : ""}`}>综合</span>
          </div>
          <div className="scene">
            <CouncilGraph seats={seats} evidence={evNodes} phase={phase} revealed={revealed} showDissentOnly={dissentOnly} />
            <div className="legend">
              <div><span className="lg" style={{ background: "#34e1ff" }} />模型席位</div>
              <div><span className="lg" style={{ background: "#ffb44d" }} />证据(带链接)</div>
              <div><span className="lg" style={{ background: "#ff5c6a" }} />分歧 / Kill</div>
            </div>
            <div className="controls">
              <button onClick={() => loadSample(mode)}>重置</button>
              <button className={dissentOnly ? "on" : ""} onClick={() => setDissentOnly((v) => !v)}>只看分歧</button>
              {!isSample && !isRunning && (report.panel?.length || 0) > 0 && (
                <button onClick={() => exportShareImage(brief, report, new Date().toLocaleDateString())}>导出图</button>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div className="col right">
          <div className="eyebrow">遥测 · TELEMETRY</div>
          <div className="tel"><span className="k">节点</span><span className="val cyan">{nodes}</span></div>
          <div className="tel"><span className="k">分歧</span><span className={`val ${isSimulated ? "" : dCount > 0 ? "red" : "green"}`}>{isSimulated && !isRunning ? "INCOMPLETE" : (report.dissentLevel || "—").toUpperCase()}</span></div>
          <div className="tel"><span className="k">引用有效率</span><span className={`val ${cit?.rate != null ? (cit.rate >= 60 ? "green" : "amber") : ""}`}>{cit?.rate != null ? `${cit.rate}%` : "—"}</span></div>
          <div className="tel"><span className="k">证据 / 来源</span><span className="val amber">{pack && !pack.redacted ? `${pack.items.length}/${pack.sources.length}` : "—"}</span></div>
          <div className="tel"><span className="k">耗时</span><span className="val">{fmt(elapsed)}</span></div>
          <div className="ticks">
            <div className="eyebrow" style={{ margin: "14px 0 8px" }}>流水线 · TICK</div>
            <div className={`tick ${pIdx > 2 ? "done" : pIdx >= 1 ? "now" : ""}`}><i />事实侦察</div>
            <div className={`tick ${pIdx > 3 ? "done" : ""}`}><i />主脑整理</div>
            <div className={`tick ${pIdx > 3 ? "done" : pIdx === 3 ? "now" : ""}`}><i />反方对线</div>
            <div className={`tick ${pIdx > 4 ? "done" : pIdx === 4 ? "now" : ""}`}><i />引用校验</div>
            <div className={`tick ${pIdx === 5 ? "now" : ""}`}><i />综合裁决</div>
          </div>
          <div className="arc-wrap">
            <svg width="120" height="78" viewBox="0 0 120 78">
              <path d="M14 70 A46 46 0 0 1 106 70" fill="none" stroke="#15314c" strokeWidth="6" strokeLinecap="round" />
              <path d="M14 70 A46 46 0 0 1 106 70" fill="none" stroke={isKill ? "#ff5c6a" : "#34e1ff"} strokeWidth="6" strokeLinecap="round" pathLength={ARC} strokeDasharray={ARC} strokeDashoffset={ARC * (1 - confFrac)} style={{ filter: "drop-shadow(0 0 6px #34e1ff88)", transition: "stroke-dashoffset .8s ease" }} />
              <text x="60" y="62" textAnchor="middle" fontFamily="ui-monospace,Menlo,monospace" fontSize="15" fill="#dcecf6">{Math.round(confFrac * 100)}</text>
              <text x="60" y="75" textAnchor="middle" fontFamily="ui-monospace,Menlo,monospace" fontSize="8" fill="#6f88a4">CONFIDENCE · 主观</text>
            </svg>
          </div>
        </div>
      </div>

      {runError && <div className="err">运行失败:{runError}</div>}

      <div className="bar">
        <div className="field">
          <i>›</i>
          <input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="粘贴你的点子或文案(纯文本)…" />
        </div>
        <button className="run" onClick={runRoast} disabled={!brief.trim() || isRunning}>
          {isRunning ? "CONVENING…" : "RUN COUNCIL"}
        </button>
      </div>
      <div className="corner c-tl" /><div className="corner c-tr" />
      <div className="corner c-bl" /><div className="corner c-br" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
