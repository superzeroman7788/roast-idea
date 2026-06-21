import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import {
  Discussion,
  DiscussionMode,
  EvidencePack,
  Phase,
  Seat,
  Turn,
  ROLE_LABEL,
  ROLE_COLOR,
} from "./discussion";
import { CouncilGraph, GraphPhase, GraphSeat } from "./CouncilGraph";
import { Landing } from "./Landing";

const SAMPLE_BRIEF: Record<DiscussionMode, string> = {
  idea: "一个帮独立开发者把碎片灵感整理成可执行项目的 AI 工作台。",
  copy: "你的 AI 上线前陪练:粘贴点子,几个不同厂商的模型陪你把它辩成更好的方案。",
};

// 极简 markdown 渲染(## 标题 / - 列表 / 段落)
function renderMd(md: string): React.ReactNode {
  const lines = (md || "").split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: number) => {
    if (list.length) {
      out.push(<ul key={`u${k}`}>{list.map((li, i) => <li key={i}>{li}</li>)}</ul>);
      list = [];
    }
  };
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith("## ")) { flush(i); out.push(<h4 key={i}>{t.slice(3)}</h4>); }
    else if (t.startsWith("# ")) { flush(i); out.push(<h4 key={i}>{t.slice(2)}</h4>); }
    else if (/^[-*]\s/.test(t)) list.push(t.replace(/^[-*]\s/, ""));
    else if (/^\d+\.\s/.test(t)) list.push(t.replace(/^\d+\.\s/, ""));
    else if (t) { flush(i); out.push(<p key={i}>{t}</p>); }
  });
  flush(lines.length);
  return out;
}

async function streamSSE(
  path: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  isCancelled: () => boolean,
) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error((await res.text().catch(() => "")) || "stream failed");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (isCancelled()) { try { await reader.cancel(); } catch {} return; }
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) {
        try { onEvent(event, JSON.parse(data.join("\n"))); } catch {}
      }
    }
  }
}

const GRAPH_PHASE: Record<Phase, GraphPhase> = {
  drafting: "idle",
  opening: "debating",
  "awaiting-user": "verdict",
  responding: "debating",
  finalizing: "verdict",
  finalized: "verdict",
};

function App() {
  const [mode, setMode] = useState<DiscussionMode>("idea");
  const [brief, setBrief] = useState(SAMPLE_BRIEF.idea);
  const [discussion, setDiscussion] = useState<{ id: string; title: string; seats: Seat[] } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [conclusion, setConclusion] = useState("");
  const [phase, setPhase] = useState<Phase>("drafting");
  const [userInput, setUserInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [conn, setConn] = useState<{ ok: boolean; text: string }>({ ok: false, text: "检测中" });
  const [retrieve, setRetrieve] = useState(true);
  const [dissentOnly, setDissentOnly] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const token = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/status").then((r) => r.json()).then((d) => {
      const c = d.providers?.filter((p: { configured: boolean }) => p.configured) || [];
      setConn({ ok: c.length >= 2, text: c.length >= 2 ? `已连接 · ${c.length} 家` : `需 ≥2 家 · 当前 ${c.length}` });
    }).catch(() => setConn({ ok: false, text: "API 离线" }));
    return () => stopTimer();
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, conclusion]);

  function stopTimer() { if (timer.current) clearInterval(timer.current); timer.current = null; }
  function startTimer() {
    stopTimer();
    const t0 = Date.now();
    setElapsed(0);
    timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
  }

  const cancelled = (t: number) => t !== token.current;

  function appendTurn(t: Turn) { setTurns((prev) => [...prev, t]); }

  async function start() {
    const t = ++token.current;
    setRunError(""); setBusy(true); setDiscussion(null); setTurns([]); setPack(null); setConclusion("");
    setPhase("opening"); startTimer();
    try {
      await streamSSE("/api/discussion/start", { mode, brief, redacted: !retrieve }, (ev, d) => {
        if (cancelled(t)) return;
        if (ev === "board") setPack(d.pack);
        else if (ev === "discussion") setDiscussion({ id: d.id, title: d.title, seats: d.seats });
        else if (ev === "turn") appendTurn(d);
        else if (ev === "round-done") setPhase("awaiting-user");
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(t));
    } catch (e) { if (!cancelled(t)) { setRunError((e as Error).message); setPhase("drafting"); } }
    finally { if (!cancelled(t)) { setBusy(false); stopTimer(); } }
  }

  async function respond(text: string) {
    if (!discussion) return;
    const t = ++token.current;
    setBusy(true); setRunError(""); setPhase("responding"); startTimer();
    const nextRound = Math.max(0, ...turns.map((x) => x.round)) + 1;
    if (text) appendTurn({ round: nextRound, speaker: "you", role: "user", body: text, citations: [] });
    try {
      await streamSSE(`/api/discussion/${discussion.id}/respond`, { userTurn: text }, (ev, d) => {
        if (cancelled(t)) return;
        if (ev === "turn") appendTurn(d);
        else if (ev === "round-done") setPhase("awaiting-user");
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(t));
    } catch (e) { if (!cancelled(t)) { setRunError((e as Error).message); setPhase("awaiting-user"); } }
    finally { if (!cancelled(t)) { setBusy(false); stopTimer(); } }
  }

  async function finalize() {
    if (!discussion) return;
    const t = ++token.current;
    setBusy(true); setRunError(""); setPhase("finalizing"); startTimer();
    try {
      await streamSSE(`/api/discussion/${discussion.id}/finalize`, {}, (ev, d) => {
        if (cancelled(t)) return;
        if (ev === "conclusion") { setConclusion(d.conclusion); setPhase("finalized"); }
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(t));
    } catch (e) { if (!cancelled(t)) { setRunError((e as Error).message); setPhase("awaiting-user"); } }
    finally { if (!cancelled(t)) { setBusy(false); stopTimer(); } }
  }

  function reset() {
    token.current++;
    stopTimer(); setBusy(false);
    setDiscussion(null); setTurns([]); setPack(null); setConclusion("");
    setPhase("drafting"); setUserInput(""); setRunError("");
    setBrief(SAMPLE_BRIEF[mode]);
  }

  function sendUser() {
    const text = userInput.trim();
    if (!text || busy) return;
    setUserInput("");
    respond(text);
  }

  // 图谱席位:讨论席位 + 最近一条发言的引用 → 复用图谱引用连线
  const graphSeats: GraphSeat[] = useMemo(() => {
    const seats = discussion?.seats || [];
    return seats.map((s) => {
      const last = [...turns].reverse().find((x) => x.speaker === s.label && !x.failed);
      return {
        provider: s.label,
        roleAngle: s.role,
        stance: "",
        objections: (last?.citations || []).map((c) => ({ evidenceId: c.evidenceId, valid: c.valid })),
      };
    });
  }, [discussion, turns]);

  const evNodes = useMemo(
    () => (pack?.items || []).map((i) => ({ id: i.id, source: i.source, credibility: i.credibility })),
    [pack],
  );

  const started = phase !== "drafting";
  const citTotal = turns.reduce((n, t) => n + (t.citations?.filter((c) => c.evidenceId).length || 0), 0);
  const citValid = turns.reduce((n, t) => n + (t.citations?.filter((c) => c.valid).length || 0), 0);
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="app">
      <div className="chrome">
        <div className="dot r" /><div className="dot y" /><div className="dot g" />
        <div className="title">ROAST · <b>SPARRING COUNCIL</b> · 点子陪练</div>
        <div className="conn" style={{ color: conn.ok ? "var(--green)" : "var(--tx3)" }}>
          <span className="blink" style={{ background: conn.ok ? "#46e6a0" : "#52688a", boxShadow: conn.ok ? "0 0 8px #46e6a0" : "none" }} />
          {conn.text}
        </div>
      </div>

      <div className="grid discuss">
        {/* LEFT: 信息板 */}
        <div className="col left">
          <div className="eyebrow">信息板 · INFO BOARD <span className="live"><span className="blink" />{busy ? "运行" : started ? "就绪" : "待命"}</span></div>
          <div className="board">
            {!pack && <div className="board-empty">开场后,这里是供你和 AI 共同引用的真实证据</div>}
            {pack?.redacted && <div className="board-empty">已关闭检索(redacted)</div>}
            {pack && !pack.redacted && pack.items.length === 0 && <div className="board-empty">本轮未检索到证据</div>}
            {(pack?.items || []).map((it) => (
              <a className={`board-item cred-${it.credibility}`} key={it.id} href={it.url} target="_blank" rel="noreferrer">
                <div className="bi-head"><span className="bi-id">{it.id}</span><span className="bi-src">{it.source}</span></div>
                <div className="bi-title">{it.title}</div>
              </a>
            ))}
          </div>
          <div className="mode">
            <button className={mode === "idea" ? "on" : ""} disabled={started} onClick={() => { setMode("idea"); setBrief(SAMPLE_BRIEF.idea); }}>IDEA</button>
            <button className={mode === "copy" ? "on" : ""} disabled={started} onClick={() => { setMode("copy"); setBrief(SAMPLE_BRIEF.copy); }}>COPY</button>
          </div>
          {!started && (
            <button className="ghost-row" onClick={() => setRetrieve((v) => !v)}>
              检索证据 · {retrieve ? "ON" : "OFF(redacted)"}
            </button>
          )}
        </div>

        {/* CENTER: 辩论图谱 */}
        <div className="col center">
          <div className="stage">
            <span className={`step ${started ? "done" : "now"}`}>{discussion?.title ? discussion.title.slice(0, 22) : "点子"}</span>
            <span className={`step ${phase === "opening" || phase === "responding" ? "now" : turns.length ? "done" : ""}`}>对线</span>
            <span className={`step ${phase === "finalizing" ? "now" : phase === "finalized" ? "done" : ""}`}>收敛</span>
          </div>
          <div className="scene">
            <CouncilGraph seats={graphSeats} evidence={evNodes} phase={GRAPH_PHASE[phase]} revealed={graphSeats.length} showDissentOnly={dissentOnly} />
            <div className="legend">
              <div><span className="lg" style={{ background: "#34e1ff" }} />辩手席位</div>
              <div><span className="lg" style={{ background: "#ffb44d" }} />证据(带链接)</div>
              <div><span className="lg" style={{ background: "#ff5c6a" }} />魔鬼代言人</div>
            </div>
            <div className="controls">
              {started && <button onClick={reset}>新讨论</button>}
              <button className={dissentOnly ? "on" : ""} onClick={() => setDissentOnly((v) => !v)}>只看引用</button>
            </div>
          </div>
        </div>

        {/* RIGHT: 发言时间线 */}
        <div className="col right discuss-right">
          <div className="eyebrow">讨论 · TRANSCRIPT <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", color: "var(--tx3)" }}>{started ? `引用 ${citValid}/${citTotal} · ${fmt(elapsed)}` : ""}</span></div>
          <div className="transcript" ref={transcriptRef}>
            {!started && <div className="board-empty" style={{ padding: 20 }}>贴一个点子或文案,点「开场」——几个不同厂商的 AI 会和你一起把它辩成更好的方案。</div>}
            {turns.map((t, i) => (
              <div className={`turn-item${t.role === "user" ? " user" : ""}${t.failed ? " failed" : ""}`} key={t.id || i}>
                <div className="turn-head">
                  <span className="turn-role" style={{ color: t.failed ? "#6a7891" : ROLE_COLOR[t.role] || "#7fd6ee" }}>
                    {t.failed ? `${t.speaker} ✕` : `${t.speaker}`}
                    <span className="turn-rolelabel">{ROLE_LABEL[t.role] || t.role}</span>
                  </span>
                </div>
                {t.failed ? (
                  <div className="turn-body fail">本轮未响应(已降级,不伪造):{(t.error || "").slice(0, 60)}</div>
                ) : (
                  <>
                    <div className="turn-body">{t.body}</div>
                    {!!(t.citations && t.citations.length) && (
                      <div className="cites">
                        {t.citations.map((c, k) => (
                          <span className={`cite-chip ${c.valid ? "ok" : "bad"}`} key={k}>{c.evidenceId}{c.valid ? "" : "✗"}</span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            {busy && <div className="thinking"><span className="blink" /> {phase === "opening" ? "开场中…" : phase === "responding" ? "对线中…" : phase === "finalizing" ? "收敛中…" : "…"}</div>}
            {conclusion && (
              <div className="conclusion">
                <div className="conc-head">✦ 打磨后的方案</div>
                <div className="conc-body">{renderMd(conclusion)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {runError && <div className="err">出错:{runError}</div>}

      {/* BOTTOM: 双态输入 */}
      <div className="bar">
        {!started ? (
          <>
            <div className="field">
              <i>›</i>
              <input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="粘贴你的点子或文案(纯文本)…" onKeyDown={(e) => { if (e.key === "Enter" && brief.trim()) start(); }} />
            </div>
            <button className="run" onClick={start} disabled={!brief.trim() || busy}>{busy ? "OPENING…" : "开场 START"}</button>
          </>
        ) : (
          <>
            <div className="field">
              <i>›</i>
              <input value={userInput} onChange={(e) => setUserInput(e.target.value)} placeholder={phase === "finalized" ? "已收敛 · 点「新讨论」重开" : "插一句:回应、辩护、或给个新角度…"} disabled={busy || phase === "finalized"} onKeyDown={(e) => { if (e.key === "Enter") sendUser(); }} />
            </div>
            <button className="secondary" onClick={() => respond("")} disabled={busy || phase === "finalized"} title="让 agents 不带你的话再辩一轮">再辩一轮</button>
            <button className="secondary" onClick={sendUser} disabled={busy || phase === "finalized" || !userInput.trim()}>发送</button>
            <button className="run" onClick={finalize} disabled={busy || phase === "finalized" || turns.length === 0}>{phase === "finalizing" ? "收敛中…" : "收敛成方案"}</button>
          </>
        )}
      </div>
      <div className="corner c-tl" /><div className="corner c-tr" />
      <div className="corner c-bl" /><div className="corner c-br" />
    </div>
  );
}

// 门控:先启动页/密码门,解锁后进陪练台。session 内记住解锁态。
function Root() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("roast_auth") === "1");
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => setAuthRequired(Boolean(d.authRequired)))
      .catch(() => setAuthRequired(false));
  }, []);
  if (authRequired === null) return <div className="boot" />;
  if (!authed) {
    return (
      <Landing
        authRequired={authRequired}
        onUnlock={() => { sessionStorage.setItem("roast_auth", "1"); setAuthed(true); }}
      />
    );
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(<Root />);
