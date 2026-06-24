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
  Artifact,
  ArtifactType,
  ARTIFACT_TYPE_LABEL,
  Viewpoint,
  Deliberation,
  STANCE_COLOR,
  ANGLE_LABEL,
  HumanSignal,
  CurationStatus,
  ConvergedOutput,
  ClarifyOutput,
  RelayHop,
  DirectionCard,
  RELAY_LENS_CN,
  Posture,
  RunConfig,
  PersonaInfo,
  Tab,
  TAB_ORDER,
  TAB_LABEL,
  TAB_SUB,
  CouncilIntensity,
  INTENSITY_LABEL,
  evidenceToMd,
  cardToMd,
  convergedToMd,
} from "./discussion";
import { Landing } from "./Landing";
import { exportMarkdown, exportPng, exportDocx, exportPptx } from "./exportDoc";

interface AttachFile { kind: "image" | "text"; dataUrl?: string; text?: string; name: string; }

async function readFileAsAttach(f: File): Promise<AttachFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    if (f.type.startsWith("image/")) {
      r.onload = () => resolve({ kind: "image", dataUrl: r.result as string, name: f.name });
      r.onerror = reject;
      r.readAsDataURL(f);
    } else {
      r.onload = () => resolve({ kind: "text", text: r.result as string, name: f.name });
      r.onerror = reject;
      r.readAsText(f);
    }
  });
}

const SAMPLE_BRIEF: Record<DiscussionMode, string> = {
  idea: "一个帮独立开发者把碎片灵感整理成可执行项目的 AI 工作台。",
  copy: "你的 AI 上线前陪练:粘贴点子,几个不同厂商的模型陪你把它辩成更好的方案。",
};

// 选角默认配置(§2.1):3 反方 + 魔鬼(locked)
const DEFAULT_CRITICS: Record<DiscussionMode, string[]> = {
  idea: ["investor", "growth", "feasibility", "devils-advocate"],
  copy: ["comms-editor", "target-reader", "skeptic-reader", "devils-advocate"],
};
function defaultRunConfig(m: DiscussionMode): RunConfig {
  return { mode: m, seats: DEFAULT_CRITICS[m].map((personaId) => ({ personaId })), functional: {}, autoRecruitDomain: false, posture: "clarify" };
}

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
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    // 讨论在服务器上找不到(免费层无持久盘,重启/冷启动会清空 DB)→ 友好提示而非甩生 JSON
    if (res.status === 404 || /not found/i.test(txt)) throw new Error("这场讨论在服务器上失效了(免费层重启会清空历史)—— 点左下「新讨论」重开即可。");
    throw new Error(txt || "stream failed");
  }
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
  const [solo, setSolo] = useState(true); // 只和主大脑讨论;需要时再引入辩论者
  const [dissentOnly, setDissentOnly] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [reconActive, setReconActive] = useState(false); // 事实侦察雷达页(议会前的证据预览,可逐条排除)
  const [reconElapsed, setReconElapsed] = useState(0); // 侦察用时(秒)

  const [attachments, setAttachments] = useState<AttachFile[]>([]);

  type HistItem = { id: string; mode: DiscussionMode; title: string; status: string; created_at: string; updated_at: string };
  const [history, setHistory] = useState<HistItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // 产出层(交付物)
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [produceType, setProduceType] = useState<ArtifactType>("copy");
  const [produceProviders, setProduceProviders] = useState<{ id: string; label: string; image: boolean }[]>([]);
  const [producing, setProducing] = useState(false);
  const [refineFor, setRefineFor] = useState<Artifact | null>(null);
  const [refineText, setRefineText] = useState("");

  // 审议引擎(白箱)
  const [viewpoints, setViewpoints] = useState<Viewpoint[]>([]);
  const [deliberation, setDeliberation] = useState<Deliberation | null>(null);
  const [deliberating, setDeliberating] = useState(false);
  const [delibFails, setDelibFails] = useState<{ seat: string; roleAngle: string; error: string }[]>([]);
  // 人策展:viewpointId → {status, replies}
  const [curation, setCuration] = useState<Record<string, { status: CurationStatus; replies: { note: string; at?: string }[] }>>({});
  const [replyOpen, setReplyOpen] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [converged, setConverged] = useState<ConvergedOutput | null>(null);
  const [clarify, setClarify] = useState<ClarifyOutput | null>(null); // 想清楚(旧单脑,保留兼容)
  const [relayHops, setRelayHops] = useState<RelayHop[]>([]); // 跨模型接力轨迹
  const [relayCard, setRelayCard] = useState<DirectionCard | null>(null); // 方向卡
  // 选角配置(§2.1)
  const [showSeatConfig, setShowSeatConfig] = useState(false);
  const [personaLib, setPersonaLib] = useState<{ functional: PersonaInfo[]; opinionated: { idea: PersonaInfo[]; copy: PersonaInfo[] }; providers: { id: string; label: string }[] } | null>(null);
  const [runConfig, setRunConfig] = useState<RunConfig | null>(null);

  // ===== 四站工作台 =====
  const [tab, setTab] = useState<Tab>("relay"); // 导航唯一真相源:搜索/陪练/议会/产出
  const [councilIntensity, setCouncilIntensity] = useState<CouncilIntensity>("council"); // 议会内部:温和⇄拷问(默认先暖)
  const [sendMenuFor, setSendMenuFor] = useState<Tab | null>(null); // 左栏「送到」下拉当前展开的文档
  const [dialogueN, setDialogueN] = useState(1); // 陪练对话搭子数(1-3,协同非对抗)
  const pendingHandoff = useRef(""); // 上游交接 MD,注入下一站运行后清空

  const token = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/status").then((r) => r.json()).then((d) => {
      const c = d.providers?.filter((p: { configured: boolean }) => p.configured) || [];
      setConn({ ok: c.length >= 2, text: c.length >= 2 ? `已连接 · ${c.length} 家` : `需 ≥2 家 · 当前 ${c.length}` });
    }).catch(() => setConn({ ok: false, text: "API 离线" }));
    refreshHistory();
    fetch("/api/produce-providers").then((r) => r.json()).then((d) => { if (d.ok) setProduceProviders(d.providers || []); }).catch(() => {});
    fetch("/api/personas").then((r) => r.json()).then((d) => { if (d.ok) setPersonaLib({ functional: d.functional, opinionated: d.opinionated, providers: d.providers || [] }); }).catch(() => {});
    return () => stopTimer();
  }, []);

  // 模式切换 → 从 DB 载该模式的已存配置(回落默认)
  useEffect(() => {
    let off = false;
    fetch(`/api/run-config?mode=${mode}`).then((r) => r.json()).then((d) => {
      if (off) return;
      setRunConfig(d.ok && d.runConfig ? { ...defaultRunConfig(mode), ...d.runConfig, mode } : defaultRunConfig(mode));
    }).catch(() => { if (!off) setRunConfig(defaultRunConfig(mode)); });
    return () => { off = true; };
  }, [mode]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, conclusion]);

  // 「送到 ▾」下拉:点击别处 / Esc 关闭
  useEffect(() => {
    if (!sendMenuFor) return;
    const onDown = (e: MouseEvent) => { const el = e.target as HTMLElement; if (el.closest(".send") || el.closest(".send-menu")) return; setSendMenuFor(null); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setSendMenuFor(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [sendMenuFor]);

  function stopTimer() { if (timer.current) clearInterval(timer.current); timer.current = null; }
  function startTimer() {
    stopTimer();
    const t0 = Date.now();
    setElapsed(0);
    timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
  }

  const cancelled = (t: number) => t !== token.current;

  function appendTurn(t: Turn) { setTurns((prev) => [...prev, t]); }

  async function addAttachFiles(files: FileList | null) {
    if (!files || !files.length) return;
    const newAtts = await Promise.all(Array.from(files).map(readFileAsAttach));
    setAttachments((prev) => [...prev, ...newAtts]);
  }

  function removeAttach(i: number) {
    setAttachments((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function finalize() {
    if (!discussion) return;
    const t = ++token.current;
    setBusy(true); setRunError(""); setPhase("finalizing"); startTimer();
    try {
      await streamSSE(`/api/discussion/${discussion.id}/finalize`, {}, (ev, d) => {
        if (cancelled(t)) return;
        if (ev === "conclusion") { setConclusion(d.conclusion); setPhase("finalized"); refreshHistory(); }
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(t));
    } catch (e) { if (!cancelled(t)) { setRunError((e as Error).message); setPhase("awaiting-user"); } }
    finally { if (!cancelled(t)) { setBusy(false); stopTimer(); } }
  }

  // 人-steered 收敛:只吃人策展集合 → ConvergedOutput(白箱,非裁决)
  async function converge() {
    if (!discussion) return;
    const t = ++token.current;
    setBusy(true); setRunError(""); setPhase("finalizing"); startTimer();
    try {
      await streamSSE(`/api/discussion/${discussion.id}/converge`, {}, (ev, d) => {
        if (cancelled(t)) return;
        if (ev === "converged") { setConverged(d.converged); setConclusion(d.conclusion); setPhase("finalized"); refreshHistory(); }
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(t));
    } catch (e) { if (!cancelled(t)) { setRunError((e as Error).message); setPhase("awaiting-user"); } }
    finally { if (!cancelled(t)) { setBusy(false); stopTimer(); } }
  }

  // 收敛分流:有审议观点 → steered 收敛(吃人策展);否则 → 老 finalize(对话路径,不破坏)
  function doConverge() { if (viewpoints.length > 0) converge(); else finalize(); }

  // ---- 选角配置 ----
  const personasForMode = personaLib ? (mode === "copy" ? personaLib.opinionated.copy : personaLib.opinionated.idea) : [];
  const maxSeats = personaLib?.providers.length || 6;
  const seatInUse = (pid: string) => !!runConfig?.seats.some((s) => s.personaId === pid);
  function addCritic(pid: string) { setRunConfig((rc) => (rc && rc.seats.length < maxSeats && !rc.seats.some((s) => s.personaId === pid)) ? { ...rc, seats: [...rc.seats, { personaId: pid }] } : rc); }
  function removeCritic(i: number) { setRunConfig((rc) => (!rc || rc.seats[i]?.personaId === "devils-advocate") ? rc : { ...rc, seats: rc.seats.filter((_, idx) => idx !== i) }); }
  function setSeatModel(i: number, modelId: string) { setRunConfig((rc) => rc ? { ...rc, seats: rc.seats.map((s, idx) => idx === i ? { ...s, modelId: modelId || undefined } : s) } : rc); }
  function setFuncModel(role: "organizer" | "verifier" | "chairman", modelId: string) { setRunConfig((rc) => rc ? { ...rc, functional: { ...rc.functional, [role]: modelId || undefined } } : rc); }

  function reset() {
    token.current++;
    stopTimer(); setBusy(false); setDeliberating(false); setProducing(false); setReconActive(false);
    setDiscussion(null); setTurns([]); setPack(null); setConclusion(""); setConverged(null);
    setPhase("drafting"); setUserInput(""); setRunError(""); setAttachments([]); setExcludedIds(new Set());
    setArtifacts([]); setRefineFor(null); setRefineText(""); setProduceType("copy");
    setViewpoints([]); setDeliberation(null); setClarify(null); setRelayHops([]); setRelayCard(null); setDelibFails([]);
    setCuration({}); setReplyOpen(null); setReplyText("");
    setBrief(SAMPLE_BRIEF[mode]);
    // 四站导航/交接复位:回默认首站 + 暖场强度 + 清挂起交接/下拉
    setTab("relay"); setCouncilIntensity("council"); setSendMenuFor(null); pendingHandoff.current = "";
    setRunConfig((rc) => (rc ? { ...rc, posture: "clarify" } : rc));
  }

  async function refreshHistory() {
    try {
      const r = await fetch("/api/discussions");
      const d = await r.json();
      if (d.ok) setHistory(d.discussions || []);
    } catch {}
  }

  // 从历史完整恢复一场讨论:发言/信息板/方案/角色全部回填,可继续辩或重新导出
  async function loadDiscussion(id: string) {
    token.current++;
    stopTimer(); setBusy(false); setDeliberating(false); setProducing(false); setReconActive(false); setRunError(""); setUserInput(""); setAttachments([]); setExcludedIds(new Set());
    try {
      const r = await fetch(`/api/discussion/${id}`);
      const d = await r.json();
      if (!d.ok || !d.discussion) throw new Error("加载失败");
      const dis = d.discussion;
      setMode(dis.mode);
      setBrief(dis.brief || "");
      setDiscussion({ id: dis.id, title: dis.title, seats: dis.roles || [] });
      setTurns(dis.turns || []);
      setPack(dis.evidencePack || null);
      setConclusion(dis.conclusion || "");
      setConverged(dis.converged || null);
      setArtifacts(dis.artifacts || []); setRefineFor(null); setRefineText("");
      setViewpoints(dis.viewpoints || []); setDeliberation(dis.deliberation || null); setClarify(dis.clarify || null); setDelibFails([]);
      setRelayHops(dis.relay?.hops || []); setRelayCard(dis.relay?.card || null);
      setCuration(deriveCuration(dis.humanSignals || [])); setReplyOpen(null); setReplyText("");
      setPhase(dis.status === "finalized" ? "finalized" : "awaiting-user");
      // 按恢复内容选落点 tab + 清挂起交接/下拉 + 复位议会强度
      const landTab: Tab = (dis.converged || dis.viewpoints?.length) ? "council" : dis.relay?.card ? "relay" : dis.evidencePack?.items?.length ? "search" : "relay";
      setTab(landTab); setSendMenuFor(null); pendingHandoff.current = "";
      setCouncilIntensity((dis.viewpoints || []).some((v: Viewpoint) => v.isHardestKill) ? "roast" : "council");
      setShowHistory(false);
    } catch (e) {
      setRunError((e as Error).message);
    }
  }

  async function removeDiscussion(id: string) {
    if (!window.confirm("删除这场讨论?本地记录将不可恢复。")) return;
    try { await fetch(`/api/discussion/${id}`, { method: "DELETE" }); } catch {}
    setHistory((prev) => prev.filter((h) => h.id !== id));
    if (discussion?.id === id) reset();
  }

  // ---- 产出层(交付物)----
  // fromArtifactId 在 = 改稿(纵向);否则 = 出一版/换一家(横向比稿)
  async function produce(type: ArtifactType, providerId: string, fromArtifactId?: string, instruction?: string) {
    if (!discussion || producing) return;
    const t = ++token.current;
    setProducing(true); setRunError("");
    setRefineFor(null); setRefineText("");
    const ho = pendingHandoff.current; pendingHandoff.current = ""; // 一次性消费,与 relay/council 一致
    try {
      await streamSSE(
        `/api/discussion/${discussion.id}/produce`,
        { type, provider: providerId, fromArtifactId, instruction, handoff: ho || undefined },
        (ev, d) => {
          if (cancelled(t)) return;
          if (ev === "artifact") setArtifacts((prev) => [...prev, d as Artifact]);
          else if (ev === "error") setRunError(d.error);
        },
        () => cancelled(t),
      );
    } catch (e) { if (!cancelled(t)) setRunError((e as Error).message); }
    finally { if (!cancelled(t)) setProducing(false); }
  }

  async function chooseArt(id: string, type: ArtifactType) {
    try {
      const r = await fetch(`/api/artifact/${id}/choose`, { method: "POST" });
      const d = await r.json();
      if (d.ok) setArtifacts((prev) => prev.map((a) => (a.type === type ? { ...a, status: a.id === id ? "chosen" : "candidate" } : a)));
    } catch {}
  }

  async function removeArt(id: string) {
    try { await fetch(`/api/artifact/${id}`, { method: "DELETE" }); } catch {}
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
    setRefineFor((cur) => (cur?.id === id ? null : cur));
  }

  function exportArtifact(a: Artifact, fmt: "md" | "docx") {
    const payload = { title: `${discussion?.title || "Roast"} · ${ARTIFACT_TYPE_LABEL[a.type]}`, conclusion: a.content, evidence: [] };
    if (fmt === "md") exportMarkdown(payload); else exportDocx(payload);
  }

  // ---- 审议引擎(白箱):结构化观点 + 审议综述 ----
  async function deliberate(postureOverride?: Posture, clarification?: string, didOverride?: string, handoff?: string) {
    const did = didOverride || discussion?.id;
    if (!did || deliberating) return;
    const usePosture = postureOverride || runConfig?.posture || "clarify";
    const t = ++token.current;
    setDeliberating(true); setPhase("responding"); startTimer(); setRunError(""); setViewpoints([]); setDeliberation(null); setClarify(null); setRelayHops([]); setRelayCard(null); setDelibFails([]); setCuration({}); setReplyOpen(null);
    try {
      await streamSSE(
        `/api/discussion/${did}/deliberate`,
        { runConfig: runConfig || undefined, posture: usePosture, excludedIds: [...excludedIds], clarification: clarification || undefined, handoff: handoff || undefined },
        (ev, d) => {
          if (cancelled(t)) return;
          if (ev === "viewpoint") setViewpoints((prev) => [...prev, d as Viewpoint]);
          else if (ev === "verification") setViewpoints((prev) => prev.map((v) => (v.id === d.id ? { ...v, verification: d.verification } : v)));
          else if (ev === "deliberation") setDeliberation(d as Deliberation);
          else if (ev === "clarify") setClarify(d as ClarifyOutput);
          else if (ev === "relay-hop") setRelayHops((p) => [...p, d as RelayHop]);
          else if (ev === "relay-card") setRelayCard(d as DirectionCard);
          else if (ev === "seat-failed") setDelibFails((prev) => [...prev, { seat: d.seat, roleAngle: d.roleAngle, error: d.error || "" }]);
          else if (ev === "error") setRunError(d.error);
        },
        () => cancelled(t),
      );
      if (!cancelled(t)) setPhase("awaiting-user");
    } catch (e) { if (!cancelled(t)) setRunError((e as Error).message); }
    finally { if (!cancelled(t)) { setDeliberating(false); stopTimer(); } }
  }

  // 从 append-only 信号日志重建当前策展态(最新状态信号胜出;reply 累积)
  function deriveCuration(signals: HumanSignal[]) {
    const m: Record<string, { status: CurationStatus; replies: { note: string; at?: string }[] }> = {};
    for (const s of signals || []) {
      const c = m[s.viewpointId] || (m[s.viewpointId] = { status: "none", replies: [] });
      if (s.action === "reply") c.replies.push({ note: s.note, at: s.createdAt });
      else if (s.action === "clear") c.status = "none";
      else c.status = s.action as CurationStatus;
    }
    return m;
  }

  async function postSignal(viewpointId: string, action: string, note?: string) {
    if (!discussion) return;
    try {
      await fetch(`/api/discussion/${discussion.id}/signal`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewpointId, action, note }),
      });
    } catch {}
  }

  // 认领/搁置/钉死:点已激活的再点 = 取消(toggle)。乐观更新 + 落库。
  function curate(vpId: string, action: "endorse" | "setAside" | "pin") {
    if (phase === "finalized") return; // 收敛已定稿,策展锁定(避免 recap 与收敛快照打架)
    const cur = curation[vpId]?.status || "none";
    const off = cur === action;
    setCuration((prev) => {
      const c = prev[vpId] || { status: "none", replies: [] };
      return { ...prev, [vpId]: { ...c, status: off ? "none" : action } };
    });
    postSignal(vpId, off ? "clear" : action);
  }

  function replyTo(vpId: string, note: string) {
    if (phase === "finalized" || !note.trim()) return;
    setCuration((prev) => {
      const c = prev[vpId] || { status: "none", replies: [] };
      return { ...prev, [vpId]: { ...c, replies: [...c.replies, { note }] } };
    });
    postSignal(vpId, "reply", note);
    setReplyOpen(null); setReplyText("");
  }

  // ===== 四站编排:一个工作台,四站共用同一 discussion;缺则惰性建(顺带检索证据)=====
  async function ensureDiscussion(force = false, briefOverride?: string): Promise<string | null> {
    if (!force && discussion) return discussion.id;
    const useBrief = briefOverride ?? brief;
    const toSend = attachments.slice();
    const t = ++token.current;
    setRunError(""); setAttachments([]);
    let newId: string | null = null, serverErr = "";
    try {
      await streamSSE(
        "/api/discussion/start",
        { mode, brief: useBrief, redacted: !retrieve, skipOpening: true, attachments: toSend, excludedIds: [], runConfig: runConfig || undefined },
        (ev, d) => {
          if (cancelled(t)) return;
          if (ev === "board") setPack(d.pack);
          else if (ev === "discussion") { newId = d.id; setDiscussion({ id: d.id, title: d.title, seats: d.seats }); }
          else if (ev === "error") { serverErr = d.error; setRunError(d.error); }
        },
        () => cancelled(t),
      );
      if (cancelled(t) || !newId) throw new Error(serverErr || "未能建立讨论");
      if (phase === "drafting") setPhase("opening");
      return newId;
    } catch (e) { if (!cancelled(t)) setRunError((e as Error).message); return null; }
  }

  // 搜索站:建讨论(顺带检索证据)。已有讨论 → 「重新搜索」强制重建 + 重抓(输入框编辑内容回写 brief)。
  async function runSearch() {
    setTab("search"); setSendMenuFor(null); setRunError("");
    if (busy || deliberating) return;
    const rebuild = !!discussion;
    const edited = userInput.trim();
    const nb = edited || brief;
    if (edited) { setBrief(edited); setUserInput(""); }
    if (rebuild) {
      setDiscussion(null); setPack(null); setExcludedIds(new Set());
      setViewpoints([]); setDeliberation(null); setConverged(null); setConclusion("");
      setRelayHops([]); setRelayCard(null); setArtifacts([]); setCuration({}); setDelibFails([]);
    }
    setBusy(true); setReconElapsed(0);
    const t0 = Date.now();
    const tick = setInterval(() => setReconElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    await ensureDiscussion(rebuild, nb);
    clearInterval(tick); setBusy(false);
  }

  // 陪练站:专注对话(1-3 协同搭子,非对抗)。一轮 = 主脑/协同就你这句聚焦回应。
  async function respondClarify(did: string, text: string) {
    const tk = ++token.current;
    setBusy(true); setRunError(""); setPhase("responding");
    const nextRound = Math.max(0, ...turns.map((x) => x.round)) + 1;
    if (text) appendTurn({ round: nextRound, speaker: "you", role: "user", body: text, citations: [] });
    try {
      await streamSSE(`/api/discussion/${did}/respond`, { userTurn: text, clarify: true, participants: dialogueN }, (ev, d) => {
        if (cancelled(tk)) return;
        if (ev === "turn") appendTurn(d as Turn);
        else if (ev === "round-done") setPhase("awaiting-user");
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(tk));
    } catch (e) { if (!cancelled(tk)) { setRunError((e as Error).message); setPhase("awaiting-user"); } }
    finally { if (!cancelled(tk)) setBusy(false); }
  }
  // 发送一句(drafting 时首句即点子,建讨论后再对话)
  async function sendClarify(text: string) {
    const t = text.trim();
    if (!t || busy || deliberating) return;
    setTab("relay"); setSendMenuFor(null);
    const drafting = !discussion;
    if (drafting) setBrief(t);
    setUserInput("");
    const id = drafting ? await ensureDiscussion(false, t) : discussion!.id;
    if (id) await respondClarify(id, t);
  }
  // 「理清了」→ 召多脑一轮 + 合成方向卡(读整段对话)
  function synthesizeCard() {
    if (!discussion || deliberating || busy) return;
    deliberate("clarify", undefined, discussion.id);
  }

  // 议会站:温和/拷问审议。clarification=底部补的一句背景(折进 brief)。
  async function runCouncil(intensity: CouncilIntensity = councilIntensity, clarification?: string) {
    setTab("council"); setSendMenuFor(null);
    setCouncilIntensity(intensity);
    setRunConfig((rc) => (rc ? { ...rc, posture: intensity } : rc));
    const ho = pendingHandoff.current; pendingHandoff.current = "";
    const id = await ensureDiscussion();
    if (id) deliberate(intensity, clarification, id, ho || undefined);
  }

  // 议会内部:温和⇄拷问(已有观点则按新强度重跑)
  function setIntensity(ci: CouncilIntensity) {
    if (ci === councilIntensity) return;
    setCouncilIntensity(ci);
    setRunConfig((rc) => (rc ? { ...rc, posture: ci } : rc));
    if (discussion && (viewpoints.length > 0 || deliberating) && !busy) deliberate(ci, undefined, discussion.id);
  }

  // 每站产出的规范 MD(= 工作台文档 + 交接载荷)
  function docFor(t: Tab): string {
    if (t === "search") return evidenceToMd(pack);
    if (t === "relay") return cardToMd(relayCard);
    if (t === "council") return converged ? convergedToMd(converged) : "";
    return "";
  }
  // 流水线状态:done(有产物)/ run(本站运行中)/ idle
  function pipeStatus(t: Tab): "done" | "run" | "idle" {
    const running = (t === "search" && busy && tab === "search") || ((t === "relay" || t === "council") && deliberating && tab === t) || (t === "produce" && producing);
    if (running) return "run";
    if (t === "search") return pack && pack.items.length > 0 ? "done" : "idle";
    if (t === "relay") return relayCard ? "done" : "idle";
    if (t === "council") return converged || viewpoints.length > 0 ? "done" : "idle";
    return artifacts.length > 0 ? "done" : "idle";
  }
  // 纯切站(浏览):清旧站报错 + 收下拉(run 函数会另行清,无冲突)
  function switchTab(tk: Tab) { setTab(tk); setSendMenuFor(null); setRunError(""); }

  // 交接:把 from 站的 MD 当输入送到 to 站
  function sendHandoff(from: Tab, to: Tab) {
    const md = docFor(from);
    if (!md) return;
    setSendMenuFor(null);
    if (to === "relay") { switchTab("relay"); return; } // 陪练是对话:证据/上游已随讨论共享,切过去继续聊即可
    pendingHandoff.current = md;
    if (to === "council") runCouncil();
    else switchTab(to); // 产出由厂商按钮触发,handoff 待用
  }

  const started = phase !== "drafting";
  // 单 key 时一个厂商可兼多 persona,故策展状态按「席位 = 厂商+角色」聚合,不按厂商折叠
  const personaStatus = (seat: string, roleAngle: string): CurationStatus => {
    const sv = viewpoints.filter((x) => x.seat === seat && x.roleAngle === roleAngle);
    let st: CurationStatus = "none";
    for (const x of sv) { const c = x.id ? curation[x.id]?.status : undefined; if (c === "pin") return "pin"; if (c === "endorse") st = "endorse"; else if (c === "setAside" && st === "none") st = "setAside"; }
    return st;
  };
  // 分歧图谱 orb(对照 council mockup + §4/§5 HUD 动效):旋转虚线环 + 呼吸辉光核 + 节点辉光 + Kill↔Ship 红虚线分歧边
  const councilOrb = () => {
    const seen = new Set<string>();
    const seats = viewpoints
      .filter((v) => { const k = `${v.seat}|${v.roleAngle}`; return !seen.has(k) && seen.add(k); })
      .map((v) => {
        const sv = viewpoints.filter((x) => x.seat === v.seat && x.roleAngle === v.roleAngle);
        const counts: Record<string, number> = {};
        sv.forEach((x) => { if (x.stance) counts[x.stance] = (counts[x.stance] || 0) + 1; });
        const stance = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        return { seat: v.seat, cn: ANGLE_LABEL[v.roleAngle] || v.roleAngle, devil: v.roleAngle === "devils-advocate", status: personaStatus(v.seat, v.roleAngle), stance };
      });
    if (!seats.length) return null;
    const C = 260, R = 172;
    const pos = seats.map((_, i) => { const a = (-90 + (i * 360) / seats.length) * (Math.PI / 180); return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) }; });
    const dis: [number, number][] = [];
    seats.forEach((s, i) => { if (s.stance === "Kill") seats.forEach((t, j) => { if (t.stance === "Ship") dis.push([i, j]); }); });
    return (
      <svg className="orb" viewBox="0 0 520 520" preserveAspectRatio="xMidYMid meet">
        {/* 同心 HUD 环 + 旋转虚线环(§4) */}
        <circle cx={C} cy={C} r={R} fill="none" stroke="#13283e" />
        {/* SMIL animateTransform 绕用户坐标圆心旋转,避开 transform-box:fill-box 的旧 Safari 兼容坑 */}
        <circle cx={C} cy={C} r={R} fill="none" stroke="#2a9fc4" strokeWidth="1" strokeDasharray="2 20" opacity="0.35">
          <animateTransform attributeName="transform" type="rotate" from="0 260 260" to="360 260 260" dur="26s" repeatCount="indefinite" />
        </circle>
        <circle cx={C} cy={C} r="132" fill="none" stroke="#1b6f8c" strokeWidth="1" strokeDasharray="2 14" opacity="0.22">
          <animateTransform attributeName="transform" type="rotate" from="360 260 260" to="0 260 260" dur="40s" repeatCount="indefinite" />
        </circle>
        <circle cx={C} cy={C} r="108" fill="none" stroke="#11223a" strokeDasharray="2 8" />
        {/* 中心→各席连线 */}
        {seats.map((s, i) => (
          <line key={"l" + i} x1={C} y1={C} x2={pos[i].x} y2={pos[i].y} stroke={s.devil ? "#ff5c6a" : "#2a9fc4"} strokeWidth="1" opacity={s.devil ? 0.5 : 0.3} strokeDasharray={s.devil ? "4 6" : undefined} />
        ))}
        {/* Kill↔Ship 红色虚线分歧边(§4) */}
        {dis.map(([i, j], k) => (
          <line key={"d" + k} x1={pos[i].x} y1={pos[i].y} x2={pos[j].x} y2={pos[j].y} stroke="#ff5c6a" strokeWidth="1" strokeDasharray="4 6" opacity="0.45" />
        ))}
        {/* 节点(发光) */}
        {seats.map((s, i) => {
          const { x, y } = pos[i];
          const col = s.devil ? "#ff5c6a" : s.status === "endorse" ? "#34e1ff" : "#9fd6ea";
          const ring = s.status === "endorse" ? "#34e1ff" : s.status === "pin" ? "#ffb44d" : null;
          return (
            <g key={i}>
              {ring && <circle cx={x} cy={y} r="16" fill="none" stroke={ring} strokeWidth="1" opacity="0.6" strokeDasharray={s.status === "pin" ? "2 3" : undefined} />}
              <circle cx={x} cy={y} r={s.devil || s.status !== "none" ? 11 : 9} fill={s.devil ? "#1a0d12" : "#08151f"} stroke={col} strokeWidth={s.devil ? 1.8 : 1.4} style={{ filter: `drop-shadow(0 0 5px ${col}aa)` }} />
              <text x={x} y={y - 21} textAnchor="middle" fontFamily="var(--mono)" fontSize="14" fill={col}>{s.seat}</text>
              <text x={x} y={y + 27} textAnchor="middle" fontFamily="var(--mono)" fontSize="12" fill={s.status === "endorse" ? "#7fd0ec" : s.status === "pin" ? "#e0a868" : "#8aa1bc"}>{s.cn}{s.status === "endorse" ? " · 已认领" : s.status === "pin" ? " · 钉死" : s.status === "setAside" ? " · 已搁置" : ""}</text>
            </g>
          );
        })}
        {/* 呼吸辉光核(§5 core) */}
        <circle className="core" cx={C} cy={C} r="16" fill="none" stroke="#34e1ff" strokeWidth="1" opacity="0.5" />
        <circle cx={C} cy={C} r="6" fill="#bfefff" style={{ filter: "drop-shadow(0 0 8px #34e1ff)" }} />
        <text x={C} y={C + 48} textAnchor="middle" fontFamily="var(--mono)" fontSize="12" fill="#8aa1bc">IDEA · 核心</text>
      </svg>
    );
  };
  // 想清楚(clarify §2.2):主脑结构化共创面板 —— 重述 + 关键追问 + 建设性角度 + 最尖锐张力 + 一键送进议会
  // 方向卡(Spec §10.1 Direction Convergence Card)
  const directionCard = (c: DirectionCard) => (
    <div className="dir-card">
      <div className="dc-title">方向卡 · 你现在想明白了什么</div>
      {c.oneLine && <div className="dc-oneline">{c.oneLine}</div>}
      <div className="dc-grid">
        {c.clear.length > 0 && <div className="dc-sec"><div className="dc-h ok">已稳定</div><ul>{c.clear.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        {c.expandedAngles.length > 0 && <div className="dc-sec"><div className="dc-h cy">接力铺开的新角度</div><ul>{c.expandedAngles.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        {c.assumptions.length > 0 && <div className="dc-sec"><div className="dc-h am">关键假设</div><ul>{c.assumptions.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        {c.dontBuildYet.length > 0 && <div className="dc-sec"><div className="dc-h rd">现在先别建</div><ul>{c.dontBuildYet.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      </div>
      {c.paths.length > 0 && <div className="dc-paths"><div className="dc-h">2-3 条路径</div>{c.paths.map((p, i) => <div className="dc-path" key={i}><b>{p.name}</b>{p.fit && <span className="dp-fit">{p.fit}</span>}{p.risk && <span className="dp-risk">风险:{p.risk}</span>}</div>)}</div>}
      {c.firstNarrowing && <div className="dc-narrow"><b>推荐先收窄 →</b> {c.firstNarrowing}</div>}
      {c.decisionsForYou.length > 0 && <div className="dc-decide"><div className="dc-h">需你拍板(AI 不替你定)</div><ul>{c.decisionsForYou.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
      {c.inviteYourInput && <div className="dc-invite">💬 {c.inviteYourInput}</div>}
    </div>
  );
  // 跨模型接力面板:接力轨迹(白箱)+ 方向卡 + 升级议会
  const relayPanel = () => {
    const lensCN = (l?: string | null) => (l ? (RELAY_LENS_CN[l] || l) : null);
    if (!relayHops.length && !relayCard) return <div className="clarify-wrap"><div className="clarify-loading">{deliberating ? "接力启动中…" : "(无)"}</div></div>;
    return (
      <div className="clarify-wrap relay-wrap">
        <div className="relay-trace">
          <div className="rl-h">跨模型接力 · 想清楚{relayHops.length ? ` · ${relayHops.length} 棒` : ""}</div>
          {relayHops.map((h) => (
            <div className={`relay-hop hop-${h.role}${h.failed ? " failed" : ""}`} key={h.order}>
              <div className="rh-top">
                <span className="rh-no">棒{h.order}</span>
                <span className="rh-seat">{h.seat}</span>
                <span className="rh-role">{h.role === "seed" ? "立框" : h.role === "synth" ? "收棒" : "接力"}</span>
                {h.lens && <span className="rh-lens">{lensCN(h.lens)}</span>}
              </div>
              {h.failed ? <div className="rh-fail">掉棒:{h.error}</div> : <>
                {h.role === "seed" && h.framing?.oneLine && <div className="rh-frame">{h.framing.oneLine}</div>}
                {h.accepted && <div className="rh-accept">接受核心:{h.accepted}</div>}
                {h.added.length > 0 && <ul className="rh-added">{h.added.map((a, i) => <li key={i}>{a}</li>)}</ul>}
              </>}
            </div>
          ))}
          {deliberating && !relayCard && <div className="relay-running"><span className="blink" />接力中…(主脑立框 → 各模型扩大思考面 → 收棒出方向卡)</div>}
        </div>
        {relayCard && directionCard(relayCard)}
      </div>
    );
  };
  const exportPayload = () => ({ title: discussion?.title || "Roast 方案", conclusion, evidence: pack?.items || [] });
  const citTotal = turns.reduce((n, t) => n + (t.citations?.filter((c) => c.evidenceId).length || 0), 0);
  const citValid = turns.reduce((n, t) => n + (t.citations?.filter((c) => c.valid).length || 0), 0);
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const fmtDate = (iso: string) => {
    const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const typeArtifacts = useMemo(() => artifacts.filter((a) => a.type === produceType), [artifacts, produceType]);
  const availProviders = produceType === "image" ? produceProviders.filter((p) => p.image) : produceProviders;
  const recap = useMemo(() => {
    const vals = Object.values(curation);
    const verified = viewpoints.filter((v) => v.verification);
    return {
      endorse: vals.filter((c) => c.status === "endorse").length,
      pin: vals.filter((c) => c.status === "pin").length,
      aside: vals.filter((c) => c.status === "setAside").length,
      unsil: converged?.unsilenceable.length || 0,
      pass: verified.length ? Math.round((verified.filter((v) => v.verification!.verdict === "supported").length / verified.length) * 100) : null,
    };
  }, [curation, viewpoints, converged]);
  // mini 分歧图:中心=点子,外围=各反方席(按代表 stance 配色,最硬 kill 红色加大)
  const miniGraph = () => {
    const seen = new Set<string>();
    const seats: { stance?: string; kill: boolean }[] = [];
    for (const v of viewpoints.filter((x) => x.round === 2)) {
      if (seen.has(v.seat)) continue;
      seen.add(v.seat);
      const sv = viewpoints.filter((x) => x.seat === v.seat && x.round === 2);
      const counts: Record<string, number> = {};
      sv.forEach((x) => { if (x.stance) counts[x.stance] = (counts[x.stance] || 0) + 1; });
      seats.push({ stance: Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0], kill: sv.some((x) => x.isHardestKill) });
    }
    if (seats.length < 2) return null;
    const cx = 70, cy = 70, r = 48;
    return (
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#13283e" />
        {seats.map((s, i) => {
          const ang = (-90 + (i * 360) / seats.length) * (Math.PI / 180);
          const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
          const col = s.kill ? STANCE_COLOR.Kill : STANCE_COLOR[s.stance || ""] || "#34e1ff";
          return (
            <g key={i}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke={col} opacity="0.35" />
              <circle cx={x} cy={y} r={s.kill ? 7 : 5} fill="#08151f" stroke={col} strokeWidth={s.kill ? 2 : 1.4} />
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r="5" fill="#bfefff" />
      </svg>
    );
  };

  // ============ 四站工作台:渲染件 ============
  const stationEmpty = (hint: string, cta?: () => void, ctaLabel?: string) => (
    <div className="station-empty">
      <div className="se-ico">◇</div>
      <div>{hint}</div>
      {cta && <div className="se-cta"><button className="btn primary" onClick={cta} disabled={busy || deliberating}>{ctaLabel || "开始"}</button></div>}
    </div>
  );

  // 证据卡列表(复用 info board 卡;搜索站右栏)
  const evidenceBoard = () => (
    <div className="board">
      {!pack && <div className="board-empty">{busy ? "侦察中…" : "还没有证据 —— 点下方「开始搜索」检索竞品/需求/定价/痛点"}</div>}
      {pack?.redacted && <div className="board-empty">已关闭检索</div>}
      {pack && !pack.redacted && pack.items.length === 0 && <div className="board-empty">本轮未检索到证据</div>}
      {(pack?.items || []).map((it) => {
        const excluded = excludedIds.has(it.id);
        const catLabel: Record<string, string> = {
          competitor: "竞品", oss: "开源", demand: "需求", pricing: "定价", pain: "痛点",
          viral: "爆款", userVoice: "用户声音", competitorCopy: "竞品文案", platform: "平台", risk: "风险",
        };
        return (
          <div className={`board-item cred-${it.credibility}${excluded ? " excluded" : ""}`} key={it.id}>
            <div className="bi-head">
              <span className="bi-id">{it.id}</span>
              {it.category && <span className="bi-theme">{catLabel[it.category] || it.category}</span>}
              <span className="bi-src">
                <span className={`bi-tier t-${it.tier || "green"}`} title={it.tier === "red" ? "cookie 源·封号/ToS 风险" : it.tier === "yellow" ? "需配置源" : "免 cookie 低风险源"} />
                {it.source}
              </span>
              <button className={`bi-exclude${excluded ? " on" : ""}`} onClick={() => setExcludedIds((prev) => { const s = new Set(prev); excluded ? s.delete(it.id) : s.add(it.id); return s; })} title={excluded ? "取消排除" : "排除(不进议会)"}>
                {excluded ? "✓" : "×"}
              </button>
            </div>
            <a className="bi-title-link" href={it.url} target="_blank" rel="noreferrer">{it.title}</a>
            {it.impact && <div className="bi-impact">{it.impact}</div>}
          </div>
        );
      })}
    </div>
  );

  // 白箱审议块(复用;议会站右栏)
  const delibBlock = () => (
    <div className="delib">
      <div className="delib-head">⚖ 白箱审议 · 署名观点
        {deliberation?.simulated && <span className="sim-tag" title="真实参与方<2,不出正式结论">SIMULATED</span>}
      </div>
      {viewpoints.map((v, i) => {
        const cur = (v.id && curation[v.id]) || { status: "none" as CurationStatus, replies: [] };
        return (
        <div className={`vp-card r${v.round}${v.isHardestKill ? " kill" : ""}${v.stance ? " st-" + v.stance.toLowerCase() : ""}${v.roleAngle === "organizer" ? " organizer" : ""} cur-${cur.status}`} key={v.id || i}>
          <div className="vp-head">
            <span className="vp-seat" style={{ color: ROLE_COLOR[v.roleAngle] || "#7fd6ee" }}>{v.seat}</span>
            <span className="vp-angle">{ANGLE_LABEL[v.roleAngle] || v.roleAngle}</span>
            {v.stance && <span className="vp-stance" style={{ color: STANCE_COLOR[v.stance], borderColor: STANCE_COLOR[v.stance] }}>{v.stance}</span>}
            {v.isHardestKill && <span className="vp-kill">🔪 最硬·不可静音</span>}
            {cur.status === "pin" && <span className="vp-pinned">📌 钉死</span>}
          </div>
          <div className="vp-text">{v.text}</div>
          {cur.replies.length > 0 && (
            <div className="vp-replies">
              {cur.replies.map((r, k) => <div className="vp-reply" key={k}>↳ 你:{r.note}</div>)}
            </div>
          )}
          <div className="vp-foot">
            {v.evidenceIds.map((id) => {
              const it = pack?.items.find((p) => p.id === id);
              return <a className="vp-cite" key={id} href={it?.url} target="_blank" rel="noreferrer" title={it?.claim || id}>{id}</a>;
            })}
            {v.verification && (
              <span className={`vp-verif ${v.verification.verdict}`} title={v.verification.note}>
                {v.verification.verdict === "supported" ? "✓ 核实" : v.verification.verdict === "unsupported" ? "✗ 无据" : "⚠ 夸大"}
              </span>
            )}
          </div>
          {v.id && (
            <div className="vp-acts">
              <button className={`vp-act${cur.status === "endorse" ? " on-cyan" : ""}`} disabled={phase === "finalized"} onClick={() => curate(v.id!, "endorse")} title="认领=这点尖锐,我要处理(≠我同意)">{cur.status === "endorse" ? "已认领" : "认领"}</button>
              <button className={`vp-act${cur.status === "pin" ? " on-amber" : ""}`} disabled={phase === "finalized"} onClick={() => curate(v.id!, "pin")} title="钉死必答">{cur.status === "pin" ? "已钉死" : "钉死"}</button>
              <button className={`vp-act${cur.status === "setAside" ? " on-gray" : ""}`} disabled={phase === "finalized"} onClick={() => curate(v.id!, "setAside")} title="搁置(留痕,不抹掉)">{cur.status === "setAside" ? "已搁置" : "搁置"}</button>
              <button className={`vp-act${replyOpen === v.id ? " on-cyan" : ""}`} disabled={phase === "finalized"} onClick={() => { setReplyOpen(replyOpen === v.id ? null : v.id!); setReplyText(""); }} title="插一句反驳">插一句</button>
            </div>
          )}
          {replyOpen === v.id && (
            <div className="vp-reply-box">
              <input value={replyText} onChange={(e) => setReplyText(e.target.value)} autoFocus placeholder="插一句反驳…" onKeyDown={(e) => { if (e.key === "Enter") replyTo(v.id!, replyText); }} />
              <button onClick={() => replyTo(v.id!, replyText)} disabled={!replyText.trim()}>发</button>
            </div>
          )}
        </div>
        );
      })}
      {delibFails.map((f, i) => (
        <div className="vp-card failed" key={"f" + i}>
          <div className="vp-head"><span className="vp-seat">{f.seat} ✕</span><span className="vp-angle">{ANGLE_LABEL[f.roleAngle] || f.roleAngle}</span></div>
          <div className="vp-text fail">本席降级未响应(不伪造):{(f.error || "").slice(0, 60)}</div>
        </div>
      ))}
      {deliberating && <div className="thinking"><span className="blink" /> 审议中…(主脑立靶 → 反方并行开火 → 主席综述)</div>}
      {viewpoints.some((v) => v.isHardestKill) && (
        <div className="lock-banner"><b>不可静音</b>魔鬼代言人最硬的 KILL 已锁定,无论怎么策展,收敛都会强制回应。</div>
      )}
    </div>
  );

  // 收敛 / 老结论块(复用;议会站右栏底)
  const convergedBlock = () => (
    converged ? (
      <div className="converged">
        <div className="conv-head">✦ 你想明白了什么<span className="conv-sub">人 steered · 白箱 · 非 AI 裁决</span></div>
        {converged.verdictVote?.decision && (
          <div className="conv-vote">投票
            {(["Ship", "Fix", "Pause", "Kill"] as const).filter((k) => (converged.verdictVote!.tally[k] || 0) > 0).map((k) => (
              <span className="cv-chip" style={{ color: STANCE_COLOR[k] }} key={k}>{k} {converged.verdictVote!.tally[k]}</span>
            ))}
            <span className="cv-note">· 仅参考{converged.verdictVote.simulated ? " · simulated" : ""}</span>
          </div>
        )}
        <div className="conv-recap">
          <span>认领 <b className="c">{recap.endorse}</b></span><span>钉死 <b className="a">{recap.pin}</b></span>
          <span>搁置 <b className="g">{recap.aside}</b></span><span>不可静音 <b className="k">{recap.unsil}</b></span>
          {recap.pass !== null && <span>核查通过 <b className="ok">{recap.pass}%</b></span>}
        </div>
        {miniGraph() && <div className="conv-minibox">{miniGraph()}<span className="conv-mini-cap">分歧图谱</span></div>}
        {converged.clarified && <div className="conv-clarified">{converged.clarified}</div>}
        {converged.addressed.length > 0 && (
          <div className="conv-sec"><div className="conv-label addr">认领的逐条应对</div>
            {converged.addressed.map((a, i) => <div className="conv-item" key={i}>{a.tag && <span className="conv-tag">{a.tag}</span>}<b>{a.point}</b> <span className="conv-arrow">→</span> {a.response}</div>)}
          </div>
        )}
        {converged.unsilenceable.length > 0 && (
          <div className="conv-sec"><div className="conv-label kill">不可静音的最硬 kill</div>
            {converged.unsilenceable.map((u, i) => <div className="conv-item killitem" key={i}>🔪 {u}</div>)}
          </div>
        )}
        {converged.setAside.length > 0 && (
          <div className="conv-sec"><div className="conv-label aside">你搁置了什么(留痕)</div>
            {converged.setAside.map((a, i) => <div className="conv-item dim" key={i}>{a.point}{a.reason ? `(理由:${a.reason})` : ""}</div>)}
          </div>
        )}
        {converged.openQuestions.length > 0 && (
          <div className="conv-sec"><div className="conv-label q">待验证的关键问题</div>
            {converged.openQuestions.map((q, i) => <div className="conv-item" key={i}>{q}</div>)}
          </div>
        )}
        {converged.cheapestTests.length > 0 && (
          <div className="conv-sec"><div className="conv-label test">最便宜的验证</div>
            {converged.cheapestTests.map((t, i) => <div className="conv-item" key={i}>{t}</div>)}
          </div>
        )}
        {converged.aiTake && (
          <div className="conv-sec"><div className="conv-label aitake">一个 AI 视角</div>
            <div className="conv-item dim">{converged.aiTake} <span className="conv-disclaimer">— 仅一个意见,不是答案</span></div>
          </div>
        )}
        <div className="conv-acts">
          <button onClick={() => deliberate(councilIntensity)} disabled={deliberating || busy} title="重开一轮审议(可先改策展)">再辩一轮</button>
          <button onClick={() => converge()} disabled={busy} title="改完认领/搁置后,据新策展重新收敛">改策展后重新收敛</button>
        </div>
        <div className="conc-export">
          <span className="ce-label">导出</span>
          <button onClick={() => exportMarkdown(exportPayload())}>MD</button>
          <button onClick={() => exportDocx(exportPayload())}>Word</button>
        </div>
      </div>
    ) : conclusion ? (
      <div className="conclusion">
        <div className="conc-head">✦ 打磨后的方案</div>
        <div className="conc-body">{renderMd(conclusion)}</div>
        <div className="conc-export">
          <span className="ce-label">导出</span>
          <button onClick={() => exportMarkdown(exportPayload())}>MD</button>
          <button onClick={() => exportPng(exportPayload())}>图片</button>
          <button onClick={() => exportDocx(exportPayload())}>Word</button>
          <button onClick={() => exportPptx(exportPayload())}>PPT</button>
        </div>
      </div>
    ) : null
  );

  // 产出层交付物块(复用;产出站中央)
  const deliverBlock = () => (
    <div className="deliver">
      <div className="deliver-tabs">
        {(["copy", "prd", "design_doc", "code_sketch", "image"] as ArtifactType[]).map((tp) => {
          const n = artifacts.filter((a) => a.type === tp).length;
          return (
            <button key={tp} className={`dl-tab${produceType === tp ? " on" : ""}`} onClick={() => setProduceType(tp)}>
              {ARTIFACT_TYPE_LABEL[tp]}{n ? ` ·${n}` : ""}
            </button>
          );
        })}
      </div>
      <div className="deliver-body">
        {typeArtifacts.length === 0 && !producing && (
          <div className="dl-empty">还没有「{ARTIFACT_TYPE_LABEL[produceType]}」。选一家 AI 出一版 ↓</div>
        )}
        {typeArtifacts.map((a) => (
          <div key={a.id} className={`dl-card${a.status === "chosen" ? " chosen" : ""}${a.parentId ? " child" : ""}`}>
            <div className="dl-card-head">
              <span className="dl-vendor-tag">{a.provider}</span>
              {a.mode === "refine" && <span className="dl-tag refine">改稿</span>}
              {a.status === "chosen" && <span className="dl-tag chosen">★ 采用</span>}
              <span className="dl-card-actions">
                {a.type !== "image" && <button onClick={() => exportArtifact(a, "md")} title="导出 Markdown">MD</button>}
                {a.type !== "image" && <button onClick={() => exportArtifact(a, "docx")} title="导出 Word">Word</button>}
                <button onClick={() => chooseArt(a.id, a.type)} disabled={a.status === "chosen"} title="采用这版">采用</button>
                {a.type !== "image" && <button onClick={() => { setRefineFor(a); setRefineText(""); }} disabled={producing} title="交给另一家改">改</button>}
                <button className="dl-del" onClick={() => removeArt(a.id)} title="删除这版">×</button>
              </span>
            </div>
            {a.type === "image"
              ? <img className="dl-img" src={`/api/artifact/${a.id}/image`} alt="配图" />
              : <div className="dl-content">{renderMd(a.content)}</div>}
          </div>
        ))}
        {producing && <div className="thinking"><span className="blink" /> 产出中…(免费/生图模型较慢)</div>}
        {refineFor && (
          <div className="dl-refine">
            <div className="dl-refine-label">把 <b>{refineFor.provider}</b> 这版交给另一家改:</div>
            <input className="dl-refine-input" value={refineText} onChange={(e) => setRefineText(e.target.value)} placeholder="改稿要求(可选,如:更口语 / 加个 CTA)" />
            <div className="dl-vendors">
              {availProviders.filter((p) => p.label !== refineFor.provider).map((p) => (
                <button key={p.id} className="dl-vendor" disabled={producing} onClick={() => produce(refineFor.type, p.id, refineFor.id, refineText)}>交给 {p.label}</button>
              ))}
              <button className="dl-vendor cancel" onClick={() => setRefineFor(null)}>取消</button>
            </div>
          </div>
        )}
        {!refineFor && (
          <div className="dl-gen">
            <span className="dl-gen-label">{typeArtifacts.length ? "换一家再出一版:" : "出一版:"}</span>
            <div className="dl-vendors">
              {availProviders.map((p) => (
                <button key={p.id} className="dl-vendor" disabled={producing} onClick={() => produce(produceType, p.id)}>{p.label}</button>
              ))}
              {produceType === "image" && availProviders.length === 0 && <span className="dl-note">当前无支持生图的厂商(需 OpenAI)</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // 顶部 tab 条 = 流水线流转
  const tabBar = () => (
    <nav className="tabs">
      {TAB_ORDER.map((tk, i) => (
        <React.Fragment key={tk}>
          {i > 0 && <span className="flow-arrow">→</span>}
          <button className={`tab${tab === tk ? " active" : ""}${pipeStatus(tk) === "done" ? " done" : ""}`} onClick={() => switchTab(tk)}>
            <span className="n">{i + 1}</span>{TAB_LABEL[tk]}<span className="sub">{TAB_SUB[tk]}</span>
          </button>
        </React.Fragment>
      ))}
      <span className="spacer" />
      <span className="lens">WORKSPACE · 一条点子 · 四站流转</span>
    </nav>
  );

  // 交接目标 + 各站输出底部的「送到下一站」内联条
  const onwardOf: Record<Tab, Tab[]> = { search: ["relay", "council"], relay: ["council", "produce"], council: ["produce"], produce: [] };
  const handoffBar = (from: Tab) => {
    if (!docFor(from) || !onwardOf[from].length) return null;
    return (
      <div className="handoff-bar">
        <span className="hb-lab">送到 →</span>
        {onwardOf[from].map((to) => (
          <button key={to} className="hb-btn" disabled={busy || deliberating} onClick={() => sendHandoff(from, to)}>{TAB_LABEL[to]}</button>
        ))}
      </div>
    );
  };

  // 左栏:对话常驻(每个 tab 都看得到 —— 它是所有 agent 理解项目的根基)
  const conversationCol = () => (
    <div className="col left">
      <div className="eyebrow">对话 · 根基 <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", color: "var(--tx3)" }}>{turns.length ? `${turns.length} 条` : ""}</span></div>
      {discussion && <div className="subject"><span className="lab">当前点子</span>{brief || "(未填写)"}</div>}
      <div className="out" style={{ flex: 1, minHeight: 0 }}>
        <div className="out-scroll" ref={transcriptRef}>{clarifyConvo()}</div>
      </div>
      {discussion && tab !== "relay" && <div className="conv-foot">想补背景 → 回<b>陪练</b>接着聊,所有站都吃这段对话</div>}
    </div>
  );

  // 中央:每站专属仪表
  const RELAY_CHAIN = [
    { who: "Claude", lens: "立框", role: "seed" }, { who: "OpenAI", lens: "假设猎手", role: "" },
    { who: "DeepSeek", lens: "漂移反方", role: "" }, { who: "Qwen", lens: "市场场景", role: "" },
    { who: "Kimi", lens: "共识整理", role: "" }, { who: "Claude", lens: "收棒", role: "synth" },
  ];
  const centerCol = () => {
    if (tab === "search") return (
      <div className="station">
        <div className="station-head">事实侦察雷达</div>
        <div className="station-sub">扫描竞品 · 需求 · 定价 · 痛点 —— 给点子找证据落点</div>
        <div className="station-canvas">
          <div className="radar">
            <div className="ring" /><div className="ring r2" /><div className="ring r3" />
            <div className="sweep" />
            {(pack?.items || []).slice(0, 8).map((it, i) => {
              const ang = i * 2.39996, rad = 38 + (it.credibility === "high" ? 0.4 : it.credibility === "medium" ? 0.66 : 0.9) * 116;
              const x = 150 + rad * Math.cos(ang), y = 150 + rad * Math.sin(ang);
              const cls = it.credibility === "high" ? "b3" : it.credibility === "medium" ? "b2" : "";
              return <div className={`blip ${cls}`} style={{ top: y, left: x }} key={it.id} />;
            })}
            <div className="radar-cap">{busy ? `扫描中 · ${reconElapsed}s` : pack?.items.length ? `命中 ${pack.items.length} 条证据` : "待检索"}</div>
          </div>
        </div>
      </div>
    );
    if (tab === "relay") {
      const synthing = deliberating || relayHops.length > 0 || relayCard;
      return (
      <div className="station">
        <div className="station-head">想清楚 · 陪练对话</div>
        <div className="station-sub">{synthing ? "召集多脑合成方向卡(关键点多人参与)" : "和搭子一来一往聊清楚 → 点「理清了」召多脑出方向卡"}</div>
        <div className="station-canvas">
          {synthing ? (
            <div className="chain">
              <div className="chain-rail">
                {deliberating && !relayCard && <div className="barge" />}
                {RELAY_CHAIN.map((n, i) => {
                  const done = relayHops.length > i || !!relayCard;
                  return (
                    <div className={`cnode ${n.role}${done ? " done" : ""}`} key={i}>
                      <div className="ball">{n.lens.slice(0, 2)}</div>
                      <div className="who">{n.who}</div><div className="clens">{n.lens}</div>
                    </div>
                  );
                })}
              </div>
              {relayCard ? <div className="grow-card"><div className="ol"><b>✓ 方向卡已出 →</b> 右栏查看,可「送到议会 / 产出」</div></div>
                : <div className="grow-card"><div className="ol">召多脑合成中…(立框 → 各模型扩面 → 收棒出方向卡)</div></div>}
            </div>
          ) : (
            <div className="clarify-hub">
              <div className="ch-orb"><span className="ch-core" /></div>
              <div className="ch-seats">
                <span className="ch-lab">对话搭子</span>
                {[1, 2, 3].map((n) => (
                  <button key={n} className={`ch-seat${dialogueN === n ? " on" : ""}`} disabled={busy} onClick={() => setDialogueN(n)} title={["主脑 Claude", "主脑 Claude + 副脑 OpenAI", "Claude + OpenAI + DeepSeek"][n - 1]}>{n === 1 ? "主脑" : `${n} 脑`}</button>
                ))}
              </div>
              <div className="ch-lineup">{["Claude", "Claude · OpenAI", "Claude · OpenAI · DeepSeek"][dialogueN - 1]}</div>
              <div className="ch-hint">{turns.length ? "聊清楚了就召多脑出卡 ↓" : "在下方说说你的点子,搭子会专注回应、帮你想清楚"}</div>
              <button className="btn primary" disabled={!discussion || busy || deliberating || !turns.length} onClick={synthesizeCard}>理清了 → 出方向卡</button>
            </div>
          )}
        </div>
      </div>
      );
    }
    if (tab === "council") return (
      <div className="station">
        <div className="station-head">议会 · 多 AI 审议</div>
        <div className="station-sub">主脑立靶 → 反方并行开火 → 红线=分歧 → 主席综述</div>
        <div className="station-toolbar">
          <div className="posture-seg">
            {(["council", "roast"] as CouncilIntensity[]).map((ci) => (
              <button key={ci} className={`ps-btn ps-${ci}${councilIntensity === ci ? " on" : ""}`} disabled={busy || deliberating} onClick={() => setIntensity(ci)} title={ci === "council" ? "温和:多视角综述,不强逼最硬 kill" : "拷问:强制魔鬼 + 不可静音 + R3 交叉"}>{INTENSITY_LABEL[ci]}</button>
            ))}
          </div>
        </div>
        <div className="station-canvas">
          {(viewpoints.length || deliberating) ? (councilOrb() || <div className="thinking"><span className="blink" /> 审议中…</div>) : stationEmpty("点下方「送进议会」—— 多个 AI 署名开火,你来策展(认领/钉死/搁置)", () => runCouncil(), "送进议会 →")}
        </div>
      </div>
    );
    // produce
    const planReady = !!(converged || relayCard || conclusion);
    return (
      <div className="station">
        <div className="station-head">产出 · 让某个 AI 生成</div>
        <div className="station-sub">把方案交给一个模型 → 文案 / PRD / 设计文档 / 配图</div>
        <div className="station-canvas" style={{ alignItems: "stretch", justifyContent: "flex-start" }}>
          {planReady ? <div className="out-scroll">{deliverBlock()}</div>
            : stationEmpty("先在「陪练」出方向卡、或「议会」收敛出方案,再用左栏「送到产出」把它送过来")}
        </div>
      </div>
    );
  };

  // 陪练对话流(你 ↔ 协同搭子)
  const clarifyConvo = () => {
    if (!turns.length) return <div className="board-empty" style={{ padding: 16 }}>{busy ? "搭子在想…" : "说说你的点子,搭子会专注回应、帮你一步步想清楚"}</div>;
    return (
      <>
        {turns.map((t, i) => (
          <div className={`cv-turn${t.role === "user" ? " me" : ""}${t.failed ? " failed" : ""}`} key={t.id || i}>
            <div className="cv-who">{t.role === "user" ? "你" : <>{t.speaker}<span className="cv-role">{ROLE_LABEL[t.role] || t.role}</span></>}</div>
            <div className="cv-body">{t.failed ? `(未响应:${(t.error || "").slice(0, 50)})` : t.body}</div>
            {t.askUser && !t.failed && <div className="cv-ask">↳ {t.askUser}</div>}
          </div>
        ))}
        {busy && <div className="thinking"><span className="blink" /> 搭子在回应你这句…</div>}
      </>
    );
  };

  // 右栏:每站专属输出
  const rightCol = () => {
    if (tab === "search") return (
      <div className="col right">
        <div className="eyebrow">证据 · EVIDENCE <span className="live"><span className="blink" />{busy ? "侦察中" : pack?.items.length ? `${pack.items.length} 命中` : "—"}</span></div>
        <div className="out"><div className="out-scroll">{evidenceBoard()}</div></div>
        {handoffBar("search")}
      </div>
    );
    if (tab === "relay") return (
      <div className="col right">
        <div className="eyebrow">方向卡 · DIRECTION</div>
        <div className="out"><div className="out-scroll">
          {relayCard ? directionCard(relayCard)
            : deliberating ? <div className="board-empty" style={{ padding: 16 }}>召多脑合成中…</div>
            : <div className="board-empty" style={{ padding: 16 }}>左栏和搭子聊清楚 → 点中央「理清了」召多脑出方向卡</div>}
        </div></div>
        {handoffBar("relay")}
      </div>
    );
    if (tab === "council") return (
      <div className="col right">
        <div className="eyebrow">观点 + 人策展 <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", color: "var(--tx3)" }}>{started ? `认领 ${recap.endorse} · 钉死 ${recap.pin} · 搁置 ${recap.aside}` : ""}</span></div>
        <div className="out"><div className="out-scroll">
          {(viewpoints.length || deliberating) ? delibBlock() : <div className="board-empty" style={{ padding: 16 }}>送进议会后,这里是各 AI 的署名观点 + 你的策展</div>}
          {convergedBlock()}
        </div></div>
        {handoffBar("council")}
      </div>
    );
    const planMd = (converged ? convergedToMd(converged) : "") || cardToMd(relayCard) || conclusion;
    return (
      <div className="col right">
        <div className="eyebrow">产出自 · SOURCE</div>
        <div className="out"><div className="out-scroll">{planMd ? <div className="conv-clarified" style={{ whiteSpace: "pre-wrap" }}>{planMd.slice(0, 1400)}</div> : <div className="board-empty" style={{ padding: 16 }}>暂无方案源 —— 先想清楚或审议</div>}</div></div>
      </div>
    );
  };

  // 底部输入条:每站不同
  const composerBar = () => {
    const drafting = !discussion;
    const bindBrief = drafting && tab !== "produce";
    const needIdea = drafting && !brief.trim(); // 仅起步(无讨论)才必须先有点子;之后再跑不需要输入
    const runCouncilBtn = () => { const tx = userInput.trim(); if (!drafting && tx) { setUserInput(""); runCouncil(councilIntensity, tx); } else runCouncil(); };
    const cfg: Record<Tab, { ph: string; hint: string; run: () => void; label: string; disabled: boolean }> = {
      search: { ph: "描述你的点子,开始事实侦察…", hint: "扫竞品/需求/定价/痛点,给证据评可信度", run: runSearch, label: busy ? "侦察中…" : pack ? "重新搜索 →" : "开始搜索 →", disabled: needIdea || busy },
      relay: { ph: drafting ? "说说你的点子,开始想清楚…" : "回应搭子 / 补充想法,继续往下聊…", hint: turns.length ? "一来一往聊清楚;理清了点中央「出方向卡」召多脑" : `搭子 ${dialogueN === 1 ? "主脑" : dialogueN + " 人"} 会专注回应、帮你想清楚`, run: () => sendClarify(bindBrief ? brief : userInput), label: busy ? "回应中…" : deliberating ? "出卡中…" : "发送", disabled: needIdea || busy || deliberating },
      council: { ph: drafting ? "描述你的点子,送进议会…" : "可补一句背景再审议(留空直接审)", hint: "温和=多视角综述;拷问=强制魔鬼 + R3 交叉", run: runCouncilBtn, label: deliberating ? "审议中…" : viewpoints.length ? "再审一轮 →" : "送进议会 →", disabled: needIdea || deliberating || busy },
      produce: { ph: "在中央选「格式」+ 模型生成;改稿在卡片上点「改」", hint: "把方案交给某个 AI 产出文案/PRD/图", run: () => {}, label: "在中央选模型生成", disabled: true },
    };
    const c = cfg[tab];
    return (
      <div className="bar">
        <div className="composer">
          <i className="composer-prefix">›</i>
          <div className="composer-body">
            <textarea
              className="composer-input"
              value={bindBrief ? brief : userInput}
              onChange={(e) => (bindBrief ? setBrief(e.target.value) : setUserInput(e.target.value))}
              disabled={tab === "produce"}
              placeholder={c.ph}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!c.disabled) c.run(); } }}
            />
            <div style={{ fontSize: 11, color: "#3a5878", fontFamily: "var(--mono)", marginTop: 4 }}>{c.hint}{tab !== "produce" ? " · 回车换行,⌘/Ctrl+Enter 提交" : ""}</div>
          </div>
        </div>
        <div className="btncol">
          <button className="btn primary" onClick={c.run} disabled={c.disabled}>{c.label}</button>
          {tab === "council" && <button className="btn ghost sm" onClick={doConverge} disabled={busy || phase === "finalized" || viewpoints.length === 0} title="据你策展过的观点收敛(白箱)">{phase === "finalizing" ? "收敛中…" : "收敛成方案"}</button>}
          <button className="btn ghost sm" onClick={() => setShowSeatConfig(true)} title="配置审议席位(角色↔模型)">席位{runConfig ? ` · ${3 + runConfig.seats.length}` : ""}</button>
          <button className="btn ghost sm" onClick={() => { setShowHistory(true); refreshHistory(); }} title="浏览/恢复过往讨论">历史{history.length ? ` · ${history.length}` : ""}</button>
          {started && <button className="btn ghost sm" onClick={reset} title="清空,开一条新点子">新讨论</button>}
        </div>
      </div>
    );
  };

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

      {tabBar()}
      <div className="grid work">
        {conversationCol()}
        <div className="col center">{centerCol()}</div>
        {rightCol()}
      </div>

      {runError && <div className="err">出错:{runError}</div>}

      {composerBar()}
      {showHistory && (
        <div className="hist-overlay" onClick={() => setShowHistory(false)}>
          <div className="hist-panel" onClick={(e) => e.stopPropagation()}>
            <div className="hist-head">
              <span>历史讨论 · {history.length}</span>
              <button className="hist-close" onClick={() => setShowHistory(false)} title="关闭">×</button>
            </div>
            <div className="hist-list">
              {history.length === 0 && <div className="hist-empty">还没有历史讨论</div>}
              {history.map((h) => (
                <div className="hist-item" key={h.id} onClick={() => loadDiscussion(h.id)}>
                  <div className="hist-item-main">
                    <span className={`hist-mode ${h.mode}`}>{h.mode === "copy" ? "文案" : "点子"}</span>
                    <span className="hist-title">{h.title || "(无标题)"}</span>
                  </div>
                  <div className="hist-item-meta">
                    <span className={`hist-status ${h.status}`}>{h.status === "finalized" ? "已收敛" : "进行中"}</span>
                    <span className="hist-date">{fmtDate(h.updated_at)}</span>
                    <button className="hist-del" onClick={(e) => { e.stopPropagation(); removeDiscussion(h.id); }} title="删除">×</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {showSeatConfig && runConfig && personaLib && (() => {
        const calls = 1 + runConfig.seats.length + 1 + 1 + (runConfig.posture === "roast" ? runConfig.seats.length : 0) + (runConfig.autoRecruitDomain ? 1 : 0);
        const estSec = runConfig.posture === "roast" ? 75 : 45;
        const cnOf = (pid: string) => personasForMode.find((p) => p.id === pid)?.cn || pid;
        const funcSeats: [string, string][] = [["organizer", "主脑 Organizer"], ["verifier", "Verifier 事实核查"], ["chairman", "主席 Chairman"]];
        return (
        <div className="sc-overlay" onClick={() => setShowSeatConfig(false)}>
          <div className="sc-panel" onClick={(e) => e.stopPropagation()}>
            <div className="sc-headbar"><span>席位配置 · COUNCIL CONFIG</span><button className="sc-x" onClick={() => setShowSeatConfig(false)}>×</button></div>
            <div className="sc-topbar">
              <span className={`sc-modetag ${mode}`}>{mode === "copy" ? "文案" : "点子"}</span>
              <span className="sc-meter">出场 <b>{3 + runConfig.seats.length}{runConfig.autoRecruitDomain ? "+" : ""}</b> 席 · 预估 <b>~{calls}×</b> · ~{estSec}s</span>
            </div>
            <div className="sc-grid">
              <div className="sc-lib">
                <div className="sc-eyebrow">反方角色库(点击加入)</div>
                {personasForMode.filter((p) => p.id !== "devils-advocate").map((p) => (
                  <div className={`sc-role${seatInUse(p.id) ? " dim" : ""}`} key={p.id} onClick={() => !seatInUse(p.id) && addCritic(p.id)}>
                    <span className="sc-rn">{p.cn}</span>
                    <span className="sc-radd">{seatInUse(p.id) ? "✓ 已在场" : "+ 加入"}</span>
                  </div>
                ))}
                <div className="sc-eyebrow" style={{ marginTop: 12 }}>领域专家</div>
                <div className="sc-libnote">开「自动招募」后,按点子领域临时招(金融→合规反方、医疗→临床反方…)</div>
              </div>
              <div className="sc-lineup">
                <div className="sc-eyebrow">中立功能席(固定)</div>
                {funcSeats.map(([role, name]) => (
                  <div className="sc-seat fixed" key={role}>
                    <div className="sc-info"><div className="sc-nm">{name} <span className="sc-tag fix">固定</span></div></div>
                    <select className="sc-sel" value={(runConfig.functional as any)?.[role] || ""} onChange={(e) => setFuncModel(role as any, e.target.value)}>
                      <option value="">自动</option>
                      {personaLib.providers.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
                    </select>
                  </div>
                ))}
                <div className="sc-eyebrow" style={{ marginTop: 10 }}>反方席(默认 3,可换角/加角,上限 {maxSeats})</div>
                {runConfig.seats.map((s, i) => {
                  const devil = s.personaId === "devils-advocate";
                  return (
                    <div className={`sc-seat ${devil ? "devil" : "opp"}`} key={i}>
                      <div className="sc-info"><div className="sc-nm">{cnOf(s.personaId)} {devil && <span className="sc-tag lock">🔒 锁定·不可删</span>}</div></div>
                      <select className="sc-sel" value={s.modelId || ""} onChange={(e) => setSeatModel(i, e.target.value)}>
                        <option value="">自动</option>
                        {personaLib.providers.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
                      </select>
                      <span className={`sc-rm${devil ? " lock" : ""}`} onClick={() => removeCritic(i)} title={devil ? "魔鬼代言人锁定,不可删" : "移除"}>✕</span>
                    </div>
                  );
                })}
                {runConfig.seats.length >= maxSeats && <div className="sc-full">已满 {maxSeats} 席(=可用模型数),需先移除或换角</div>}
                <label className="sc-toggle"><span className={`sc-sw${runConfig.autoRecruitDomain ? " on" : ""}`} onClick={() => setRunConfig((rc) => rc ? { ...rc, autoRecruitDomain: !rc.autoRecruitDomain } : rc)} />按点子领域自动招募专家反方</label>
                <div className="sc-note">对抗强度由顶部「想清楚 / 审议 / 拷问」姿态控制(拷问=强制魔鬼 + R3 交叉互驳)</div>
              </div>
            </div>
            <div className="sc-bar">
              <button className="sc-ghost" onClick={() => setRunConfig(defaultRunConfig(mode))}>恢复默认</button>
              <button className="sc-primary" onClick={() => { if (runConfig) fetch("/api/run-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, runConfig }) }).catch(() => {}); setShowSeatConfig(false); }}>保存配置</button>
            </div>
          </div>
        </div>
        );
      })()}
      <div className="corner c-tl" /><div className="corner c-tr" />
      <div className="corner c-bl" /><div className="corner c-br" />
    </div>
  );
}

// 登录后的 JARVIS 语音:播作者提供的录音(public/welcome.mp3,真音色)。
// 由解锁点击(用户手势)触发,允许发声。录音失败则回落浏览器 TTS。
function speakWelcome() {
  try {
    const a = new Audio("/welcome.mp3");
    a.volume = 0.9;
    a.play().catch(() => speakWelcomeTTS());
  } catch {
    speakWelcomeTTS();
  }
}

function speakWelcomeTTS() {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance("Welcome to a new world.");
    u.lang = "en-GB";
    u.rate = 0.84;
    u.pitch = 0.7;
    const pick = () => {
      const vs = synth.getVoices();
      const v =
        vs.find((x) => /daniel|arthur|google uk english male|microsoft (ryan|george|guy)/i.test(x.name)) ||
        vs.find((x) => /en-GB/i.test(x.lang)) ||
        vs.find((x) => /^en/i.test(x.lang));
      if (v) u.voice = v;
      synth.cancel();
      synth.speak(u);
    };
    if (synth.getVoices().length) pick();
    else synth.addEventListener("voiceschanged", pick, { once: true });
  } catch {
    /* 忽略 */
  }
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
        onUnlock={() => { sessionStorage.setItem("roast_auth", "1"); speakWelcome(); setAuthed(true); }}
      />
    );
  }
  return <App />;
}

// HMR 守卫:复用同一个 root,避免热重载反复 createRoot 报警(仅开发期噪音)。
const container = document.getElementById("root")! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
const root = container._root ?? (container._root = createRoot(container));
root.render(<Root />);
