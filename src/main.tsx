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
  SEARCH_DIMS_IDEA,
  SEARCH_DIMS_COPY,
  CAT_COLOR,
  SRC_COLOR,
  credScore,
  CONFIDENCE_CN,
  PRODUCE_FORMATS,
  AutoRun,
  AutoRound,
  AutoFields,
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
  // AbortController:既能被取消(isCancelled)即时掐断,也能被卡死看门狗掐断 —— 否则后端卡住时 reader.read() 永久阻塞,只能退出重进
  const ctrl = new AbortController();
  const STALL_MS = 100000; // 100s 内没有任何新字节 = 后端真卡死(单脑一轮最长 ~60s,留足余量)→ 主动断开,可重发
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    if (isCancelled()) return;
    // fetch 直接 reject(Failed to fetch)= 连接层失败:服务器重启/冷启动/断网
    throw new Error("连不上服务器 —— 可能正在重启或冷启动(免费层闲置会休眠),等几秒再发一次。");
  }
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    // 网关错误(502/503/504)或返回 HTML 错误页 = 服务在重启/部署/冷启动中,别把整页 HTML 甩给用户
    if ([502, 503, 504].includes(res.status) || /^\s*<(!doctype|html)/i.test(txt)) throw new Error("服务正在重启或部署中(刚推过新版本 / 免费层冷启动)—— 等十几秒再发一次就好。");
    // 讨论在服务器上找不到(免费层无持久盘,重启/冷启动会清空 DB)→ 友好提示而非甩生 JSON
    if (res.status === 404 || /not found/i.test(txt)) throw new Error("这场讨论在服务器上失效了(免费层重启会清空历史)—— 点左下「新讨论」重开即可。");
    throw new Error(txt.slice(0, 200) || "stream failed");
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastData = Date.now();
  // 看门狗:被取消 → 立即断;100s 无新字节 → 判后端卡死,主动断
  const watch = setInterval(() => {
    if (isCancelled() || Date.now() - lastData > STALL_MS) { try { ctrl.abort(); } catch {} }
  }, 1000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (isCancelled()) { try { await reader.cancel(); } catch {} return; }
      lastData = Date.now();
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
  } catch (e) {
    if (isCancelled()) return; // 用户主动取消 → 静默
    if (ctrl.signal.aborted) throw new Error("响应卡住了(后端 100 秒没动静),已自动断开 —— 重发一次试试。");
    throw e;
  } finally {
    clearInterval(watch);
  }
}

// 陪练 redesign:厂商 → 颜色/角色镜头(用于时间线/三脑并列/主脑方案配色)
const AG: Record<string, { n: string; c: string }> = {
  claude: { n: "Claude", c: "var(--c-claude)" },
  openai: { n: "OpenAI", c: "var(--c-openai)" },
  deepseek: { n: "DeepSeek", c: "var(--c-deepseek)" },
};
const AG_ROLE: Record<string, string> = { claude: "主脑 · 建框架", openai: "假设猎手 · 验路径", deepseek: "反方 · 找盲点" };
function agentKey(speaker?: string): string {
  const s = (speaker || "").toLowerCase();
  if (s.includes("claude")) return "claude";
  if (s.includes("openai") || s.includes("gpt")) return "openai";
  if (s.includes("deepseek")) return "deepseek";
  return "claude";
}
function agentColor(key: string): string { return AG[key]?.c || "var(--c-claude)"; }
const LL_LINEUP = [["claude"], ["claude", "openai"], ["claude", "openai", "deepseek"]];

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
  const [flashMsg, setFlashMsg] = useState(""); // 轻提示(复制成功/已导出…),~1.6s 自动消失
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmBox, setConfirmBox] = useState<{ title: string; body?: string; yesLabel?: string; danger?: boolean; onYes: () => void } | null>(null); // App 内嵌确认框,替原生 window.confirm
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
  type LibArt = Artifact & { discussionId: string; discussionTitle: string };
  const [library, setLibrary] = useState<LibArt[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [previewArt, setPreviewArt] = useState<Artifact | null>(null); // HTML 原型放大预览(沙箱 iframe,见 openHtmlPreview)

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
  const [delibPhase, setDelibPhase] = useState(""); // 议会分阶段进度:organizer→critics→verify→chair
  const [delibFails, setDelibFails] = useState<{ seat: string; roleAngle: string; error: string }[]>([]);
  // 人策展:viewpointId → {status, replies}
  const [curation, setCuration] = useState<Record<string, { status: CurationStatus; replies: { note: string; at?: string }[] }>>({});
  const [replyOpen, setReplyOpen] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [converged, setConverged] = useState<ConvergedOutput | null>(null);
  const [clarify, setClarify] = useState<ClarifyOutput | null>(null); // 想清楚(旧单脑,保留兼容)
  const [relayHops, setRelayHops] = useState<RelayHop[]>([]); // 跨模型接力轨迹
  const [relayCard, setRelayCard] = useState<DirectionCard | null>(null); // 方向卡
  const [solutionDoc, setSolutionDoc] = useState<string | null>(null); // 方案文档(主脑收口的厚方案,交下游精修)
  const [makingSolDoc, setMakingSolDoc] = useState(false);
  // 选角配置(§2.1)
  const [showSeatConfig, setShowSeatConfig] = useState(false);
  const [personaLib, setPersonaLib] = useState<{ functional: PersonaInfo[]; opinionated: { idea: PersonaInfo[]; copy: PersonaInfo[] }; providers: { id: string; label: string }[] } | null>(null);
  const [runConfig, setRunConfig] = useState<RunConfig | null>(null);

  // ===== 四站工作台 =====
  const [tab, setTab] = useState<Tab>("relay"); // 导航唯一真相源:搜索/陪练/议会/产出
  const [councilIntensity, setCouncilIntensity] = useState<CouncilIntensity>("council"); // 议会内部:温和⇄拷问(默认先暖)
  const [sendMenuFor, setSendMenuFor] = useState<Tab | null>(null); // 左栏「送到」下拉当前展开的文档
  const [dialogueN, setDialogueN] = useState(1); // 陪练对话搭子数(1-3,协同非对抗)
  const [detailId, setDetailId] = useState<string | null>(null); // 陪练:左栏点开某条 → 中央看详情(null=三脑并列列表)
  const [correctFor, setCorrectFor] = useState<string | null>(null); // 陪练:正在纠偏哪条(turn id,展开输入)
  const [correctText, setCorrectText] = useState(""); // 纠偏输入框内容
  const [searchDim, setSearchDim] = useState("all"); // 搜索:左栏选中的侦察维度(过滤中间证据流)
  const [councilSel, setCouncilSel] = useState("all"); // 议会:左栏选中的议题(松筛中间署名观点)
  const [produceModel, setProduceModel] = useState<string>(""); // 产出:选中的模型(provider id),空=用默认第一个
  const [protoRealImg, setProtoRealImg] = useState(true); // HTML 原型:配真图(gpt-image-1)开关,关=用 picsum 占位省额度
  const [artInstr, setArtInstr] = useState(""); // 产物「改稿」给同模型的一句指令
  // 自动档 Auto-Pilot
  const [autoRun, setAutoRun] = useState<AutoRun | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoLive, setAutoLive] = useState<any>(null); // 当前轮流式累积
  const [autoNote, setAutoNote] = useState(""); // 轮间插话
  const [autoInjected, setAutoInjected] = useState<string | null>(null); // 已注入到哪个站
  const [autoLooping, setAutoLooping] = useState(false); // 自动连跑中(不打断就一直跑)
  const autoLoopRef = useRef(false); // 异步循环读最新值,避免闭包陈旧
  const [artMenu, setArtMenu] = useState<{ id: string; mode: "refine" | "regen" | "critique" } | null>(null); // 产物卡内联菜单:改稿(同模型+指令)/ 换模型重生 / 让另一家挑刺
  const llScrollRef = useRef<HTMLDivElement>(null); // 陪练时间线滚动容器(自动滚到最新)
  const [llAtBottom, setLlAtBottom] = useState(true); // 时间线是否贴底:贴底才自动跟随,滚上去看历史就不打扰
  // 方向卡分段折叠:key→是否收起。默认折起最长的几段(新角度/关键假设/暂不做)
  const [cardCollapsed, setCardCollapsed] = useState<Record<string, boolean>>({ angles: true, assumptions: true, dont: true });
  const [dirOpen, setDirOpen] = useState(false); // 陪练右栏「方向卡」整块折叠,默认收起(内核置顶、聊天在下)
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
    // 刷新恢复:把上次的工作台接回来(存在才载,已删则清记号),感知上不再"丢工作台"
    const last = localStorage.getItem("roast_last_did");
    if (last) fetch(`/api/discussion/${last}`).then((r) => r.json()).then((d) => { if (d.ok && d.discussion) loadDiscussion(last); else localStorage.removeItem("roast_last_did"); }).catch(() => {});
    return () => stopTimer();
  }, []);

  // 当前工作台 id 落 localStorage(建/载即存,reset 清)→ 供刷新恢复
  useEffect(() => {
    if (discussion?.id) localStorage.setItem("roast_last_did", discussion.id);
    else localStorage.removeItem("roast_last_did");
  }, [discussion?.id]);

  // 陪练时间线:新发言进来时,若已贴底则自动滚到最新(滚上去看历史则不打扰)
  useEffect(() => {
    if (tab !== "relay" || !llAtBottom) return;
    const el = llScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy, tab, detailId, llAtBottom]);

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
        if (ev === "converged") { setConverged(d.converged); setConclusion(d.conclusion); setPhase("finalized"); refreshHistory(); switchTab("produce"); } // 收敛完成 → 直接落到产出站(方案源已含收敛结论)
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
    setSolutionDoc(null); setMakingSolDoc(false);
    setAutoRun(null); setAutoLive(null); setAutoBusy(false); setAutoNote(""); setAutoInjected(null);
    setCuration({}); setReplyOpen(null); setReplyText("");
    setBrief(SAMPLE_BRIEF[mode]);
    // 四站导航/交接复位:回默认首站 + 暖场强度 + 清挂起交接/下拉
    setTab("relay"); setCouncilIntensity("council"); setSendMenuFor(null); pendingHandoff.current = ""; setDetailId(null); setSearchDim("all"); setCorrectFor(null); setCorrectText(""); setArtMenu(null); setProduceModel(""); setCouncilSel("all"); setLlAtBottom(true); setCardCollapsed({ angles: true, assumptions: true, dont: true });
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
    stopTimer(); setBusy(false); setDeliberating(false); setProducing(false); setReconActive(false); setRunError(""); setUserInput(""); setAttachments([]); setExcludedIds(new Set()); setDetailId(null); setSearchDim("all"); setCorrectFor(null); setCorrectText(""); setArtMenu(null); setProduceModel(""); setCouncilSel("all"); setLlAtBottom(true); setCardCollapsed({ angles: true, assumptions: true, dont: true });
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
      setRelayHops(dis.relay?.hops || []); setRelayCard(dis.relay?.card || null); setSolutionDoc(dis.solutionDoc || null);
      setAutoRun(dis.autoRun || null); setAutoLive(null);
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

  function removeDiscussion(id: string) {
    confirmAsk({
      title: "删除这场讨论?", body: "记录将不可恢复。", yesLabel: "删除", danger: true,
      onYes: async () => {
        try { await fetch(`/api/discussion/${id}`, { method: "DELETE" }); } catch {}
        setHistory((prev) => prev.filter((h) => h.id !== id));
        if (discussion?.id === id) reset();
        flash("✓ 已删除");
      },
    });
  }

  // ---- 产出层(交付物)----
  // fromArtifactId 在 = 改稿(纵向);否则 = 出一版/换一家(横向比稿)
  async function produce(type: ArtifactType, providerId: string, fromArtifactId?: string, instruction?: string) {
    if (producing) return;
    setRefineFor(null); setRefineText("");
    const atts = attachments.slice();
    const hadDiscussion = !!discussion;
    let did = discussion?.id || null;
    // 独立产出:没讨论也能用 —— 拿「补充要求 / 附件」当种子建一条(redacted 不检索),附件随 /start 折进 brief
    if (!did) {
      const seed = (instruction || "").trim() || (atts.length ? "(独立产出:见附件素材)" : "");
      if (!seed) { setRunError("独立产出请先在下方写要做什么,或附一个素材文件。"); return; }
      setProducing(true); setRunError("");
      setBrief(seed); setAttachments([]);
      did = await ensureDiscussion(true, seed, true);
      if (!did) { setProducing(false); return; }
    } else {
      setProducing(true); setRunError("");
      setAttachments([]); // 已有讨论:本次附件随 /produce 走
    }
    // 注意:token 必须在 ensureDiscussion 之后拿 —— ensureDiscussion 内部会 ++token.current,
    // 先拿会让本次 produce 的 SSE 立刻被判为已取消(net::ERR_ABORTED)。
    const t = ++token.current;
    const ho = pendingHandoff.current || solutionDoc || ""; pendingHandoff.current = ""; // 方案文档当持久方案源(没显式交接也用)
    const produceAtts = hadDiscussion ? atts : []; // 刚建的讨论附件已被 /start 消费,别重复发
    try {
      await streamSSE(
        `/api/discussion/${did}/produce`,
        { type, provider: providerId, fromArtifactId, instruction, handoff: ho || undefined, attachments: produceAtts.length ? produceAtts : undefined, realImg: type === "html_proto" ? protoRealImg : undefined },
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
  // 配图下载:同源图片用 a[download] 直接存盘
  function downloadArtifactImage(a: Artifact) {
    const l = document.createElement("a");
    l.href = `/api/artifact/${a.id}/image`;
    l.download = `roast-配图-${(a.id || "img").slice(0, 8)}.png`;
    document.body.appendChild(l); l.click(); l.remove();
    flash("✓ 已下载配图");
  }
  // HTML 原型:剥掉模型可能加的 ```html 围栏 → 拿到纯 HTML
  function htmlOf(content?: string | null): string {
    let s = String(content || "").trim();
    // 整段被 ```html … ``` 包裹才剥(锚定首尾,避免正文里出现的 ``` 把文档截断)
    const m = s.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
    if (m) return m[1].trim();
    // 截断输出:只有开头的 ```html 没收尾 → 去掉开头围栏,渲染残页而不是显示字面量 ```html
    return s.replace(/^```(?:html)?[^\n]*\n?/i, "").trim();
  }
  // 下载前把 /api/proto-asset 生成图抓成 base64 内联,让下载的 .html 离线也能看(file:// 无法解析根相对 URL)
  async function inlineProtoAssets(html: string): Promise<string> {
    const urls = Array.from(new Set(html.match(/\/api\/proto-asset\/[^\s"')]+\.png/g) || []));
    for (const u of urls) {
      try {
        const blob = await fetch(u, { credentials: "include" }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error("404"))));
        const dataUri = await new Promise<string>((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = reject; fr.readAsDataURL(blob); });
        html = html.split(u).join(dataUri);
      } catch { /* 抓不到就留 URL —— 联网打开仍可见 */ }
    }
    return html;
  }
  async function downloadHtml(a: Artifact) {
    const html = await inlineProtoAssets(htmlOf(a.content));
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const l = document.createElement("a"); l.href = url; l.download = `roast-原型-${(a.id || "p").slice(0, 8)}.html`;
    document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
    flash("✓ 已下载 HTML");
  }
  // 放大预览:走沙箱 iframe overlay,不能用 window.open(blob) —— blob 文档继承 app origin、无沙箱,
  // 模型生成的 HTML(可被 brief/附件/证据 prompt 注入)就能同源 fetch 已鉴权的 /api 偷数据。
  // 沙箱 iframe(allow-scripts、不带 allow-same-origin)= opaque origin,碰不到 app/cookie;srcDoc 又能对 app origin 解析 /api/proto-asset 真图。
  function openHtmlPreview(a: Artifact) { setPreviewArt(a); }
  // 全局交付物库:拉本用户所有产物
  async function openLibrary() {
    setShowLibrary(true);
    try { const r = await fetch("/api/artifacts").then((x) => x.json()); if (r.ok) setLibrary(r.artifacts || []); } catch {}
  }

  // ---- 审议引擎(白箱):结构化观点 + 审议综述 ----
  async function deliberate(postureOverride?: Posture, clarification?: string, didOverride?: string, handoff?: string) {
    const did = didOverride || discussion?.id;
    if (!did || deliberating) return;
    const usePosture = postureOverride || runConfig?.posture || "clarify";
    const t = ++token.current;
    setDeliberating(true); setDelibPhase(usePosture === "clarify" ? "" : "organizer"); setPhase("responding"); startTimer(); setRunError(""); setViewpoints([]); setDeliberation(null); setClarify(null); setRelayHops([]); setRelayCard(null); setDelibFails([]); setCuration({}); setReplyOpen(null);
    try {
      await streamSSE(
        `/api/discussion/${did}/deliberate`,
        { runConfig: runConfig || undefined, posture: usePosture, excludedIds: [...excludedIds], clarification: clarification || undefined, handoff: handoff || undefined },
        (ev, d) => {
          if (cancelled(t)) return;
          if (ev === "viewpoint") { setViewpoints((prev) => [...prev, d as Viewpoint]); setDelibPhase((d as Viewpoint).round >= 2 ? "critics" : "organizer"); }
          else if (ev === "verification") { setViewpoints((prev) => prev.map((v) => (v.id === d.id ? { ...v, verification: d.verification } : v))); setDelibPhase("verify"); }
          else if (ev === "deliberation") { setDeliberation(d as Deliberation); setDelibPhase("chair"); }
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
  function curate(vpId: string, action: "endorse" | "setAside" | "pin" | "reject") {
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
  async function ensureDiscussion(force = false, briefOverride?: string, redactedOverride?: boolean): Promise<string | null> {
    if (!force && discussion) return discussion.id;
    const useBrief = briefOverride ?? brief;
    const useRedacted = redactedOverride ?? !retrieve; // 陪练起手传 true 跳过检索(8-15s);搜索站走 retrieve 开关
    const toSend = attachments.slice();
    const t = ++token.current;
    setRunError(""); setAttachments([]);
    let newId: string | null = null, serverErr = "";
    try {
      await streamSSE(
        "/api/discussion/start",
        { mode, brief: useBrief, redacted: useRedacted, skipOpening: true, attachments: toSend, excludedIds: [], runConfig: runConfig || undefined },
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
    const edited = userInput.trim();
    const nb = edited || brief;
    if (edited) { setBrief(edited); setUserInput(""); }
    setExcludedIds(new Set()); // 证据 id 是位置型(E1..),重检索会重编号 → 必须清旧排除,否则旧排除错落到不相干的新证据
    setBusy(true); setReconElapsed(0);
    const t0 = Date.now();
    const tick = setInterval(() => setReconElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    try {
      // 已有工作台(常见:陪练已惰性起手建了讨论)→ 把证据补进同一讨论,不新建、不丢对话/方案;
      // 否则搜索起手 → 建讨论 + 检索(redacted 由 retrieve 开关定)。
      if (discussion) await retrieveEvidence(discussion.id, nb);
      else await ensureDiscussion(false, nb);
    } finally { clearInterval(tick); setBusy(false); }
  }

  // 给已有讨论补检索:更新同一工作台的信息板(不重建讨论,保留对话/议会/产出)
  async function retrieveEvidence(did: string, briefText: string) {
    const tk = ++token.current;
    try {
      await streamSSE(`/api/discussion/${did}/retrieve`, { brief: briefText }, (ev, d) => {
        if (cancelled(tk)) return;
        if (ev === "board") setPack(d.pack);
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(tk));
    } catch (e) { if (!cancelled(tk)) setRunError((e as Error).message); }
  }

  // 陪练站:专注对话(1-3 协同搭子,非对抗)。一轮 = 主脑/协同就你这句聚焦回应。
  async function respondClarify(did: string, text: string, atts: AttachFile[] = []) {
    const tk = ++token.current;
    setBusy(true); setRunError(""); setPhase("responding");
    const nextRound = Math.max(0, ...turns.map((x) => x.round)) + 1;
    if (text || atts.length) appendTurn({ round: nextRound, speaker: "you", role: "user", body: text || "(已附附件)", citations: [] });
    try {
      await streamSSE(`/api/discussion/${did}/respond`, { userTurn: text, clarify: true, participants: dialogueN, attachments: atts.length ? atts : undefined }, (ev, d) => {
        if (cancelled(tk)) return;
        if (ev === "turn") {
          const turn = d as Turn;
          // 后端回推带 id 的用户发言 → 替换乐观条(同正文、无 id),让它可被点赞;AI 发言直接追加
          setTurns((prev) => {
            if (turn.role === "user") {
              const idx = prev.findIndex((x) => !x.id && x.role === "user" && x.body === turn.body);
              if (idx >= 0) { const n = [...prev]; n[idx] = turn; return n; }
            }
            return [...prev, turn];
          });
        }
        else if (ev === "round-done") setPhase("awaiting-user");
        else if (ev === "error") setRunError(d.error);
      }, () => cancelled(tk));
    } catch (e) { if (!cancelled(tk)) { setRunError((e as Error).message); setPhase("awaiting-user"); } }
    finally { if (!cancelled(tk)) setBusy(false); }
  }
  // 对话点赞:标记/取消"用户重视"(主脑回应 + 出卡都会优先照顾)
  async function togglePin(t: Turn) {
    if (!discussion || !t.id) return;
    const next = !t.pinned;
    setTurns((prev) => prev.map((x) => (x.id === t.id ? { ...x, pinned: next } : x)));
    try { await fetch(`/api/discussion/${discussion.id}/turn/${t.id}/pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: next }) }); } catch {}
  }
  // 纠偏:判定某条跑偏 → 记信号(广播给全桌后续 + 方向卡)+ 这条脑带纠正立刻重答替换。再点取消纠偏。
  async function correctTurn(t: Turn, correction: string) {
    if (!discussion || !t.id) return;
    if (t.corrected) { // 取消纠偏
      setTurns((prev) => prev.map((x) => (x.id === t.id ? { ...x, corrected: false, correction: null } : x)));
      setCorrectFor(null); setCorrectText("");
      try { await fetch(`/api/discussion/${discussion.id}/turn/${t.id}/correct`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ corrected: false }) }); } catch {}
      return;
    }
    setCorrectFor(null); setCorrectText("");
    setTurns((prev) => prev.map((x) => (x.id === t.id ? { ...x, corrected: true, correctingNow: true } as Turn & { correctingNow?: boolean } : x)));
    try {
      const r = await fetch(`/api/discussion/${discussion.id}/turn/${t.id}/correct`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ correction }) }).then((x) => x.json());
      setTurns((prev) => prev.map((x) => (x.id === t.id ? { ...x, corrected: true, correction: r.correction || x.correction, body: r.newBody || x.body, correctingNow: false } as Turn : x)));
    } catch { setTurns((prev) => prev.map((x) => (x.id === t.id ? { ...x, correctingNow: false } as Turn : x))); }
  }
  // 发送一句(drafting 时首句即点子,建讨论后再对话)
  async function sendClarify(text: string) {
    const t = text.trim();
    if (busy || deliberating) return;
    const drafting = !discussion;
    if (drafting && !t) return; // 起步必须有点子文本
    if (!drafting && !t && !attachments.length) return; // 续聊:文本或附件至少一个
    setTab("relay"); setSendMenuFor(null); setDetailId(null);
    if (drafting) setBrief(t);
    setUserInput("");
    // 立即反馈:发送键转忙 + 空态显示"搭子在想…",消除「建讨论」期间的死按钮窗口(原先 busy 直到 respondClarify 才置真)
    setBusy(true); setRunError("");
    // 起步附件由 ensureDiscussion 送进 /start(折进 brief);续聊附件由 respondClarify 送进 /respond。避免重复发。
    const atts = drafting ? [] : attachments.slice();
    if (!drafting) setAttachments([]);
    // 陪练起手不检索证据(redacted=true,省 8-15s);证据交给「搜索」站按需补进同一工作台
    const id = drafting ? await ensureDiscussion(false, t, true) : discussion!.id;
    if (!id) { setBusy(false); return; }
    await respondClarify(id, t, atts);
  }
  // 「理清了」→ 召多脑一轮 + 合成方向卡(读整段对话)
  function synthesizeCard() {
    if (!discussion || deliberating || busy) return;
    deliberate("clarify", undefined, discussion.id);
  }
  // 出方案文档:主脑读整段对话 + 方向卡 + 赞/纠偏 → 厚的固定分节方案文档(交下游精修的真正方案)
  async function makeSolutionDoc() {
    if (!discussion || makingSolDoc || deliberating || busy) return;
    setMakingSolDoc(true); setRunError("");
    try {
      const r = await fetch(`/api/discussion/${discussion.id}/solution-doc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).then((x) => x.json());
      if (r.ok && r.md) { setSolutionDoc(r.md); flash("✓ 已更新方案文档"); }
      else setRunError(r.error || "方案文档生成失败");
    } catch (e) { setRunError((e as Error).message); }
    finally { setMakingSolDoc(false); }
  }

  // 议会站:温和/拷问审议。clarification=底部补的一句背景(折进 brief)。
  // 重跑议会会清空旧观点 + 你的策展 → 有策展时先确认(避免静默丢失)
  const hasCuration = () => Object.values(curation).some((c) => c.status !== "none" || c.replies.length > 0);
  // 重跑守卫:仅当有策展会丢时弹 App 内嵌确认(不再用原生 window.confirm);否则直接 proceed
  function guardRerun(why: string, proceed: () => void) {
    if (viewpoints.length > 0 && hasCuration())
      confirmAsk({ title: `${why}会清空你的策展`, body: "会重跑议会、清空当前观点和你的认领 / 否决 / 搁置。继续?", yesLabel: "继续重跑", danger: true, onYes: proceed });
    else proceed();
  }

  function runCouncil(intensity: CouncilIntensity = councilIntensity, clarification?: string) {
    guardRerun("再审一轮", async () => {
      setTab("council"); setSendMenuFor(null);
      setCouncilIntensity(intensity);
      setRunConfig((rc) => (rc ? { ...rc, posture: intensity } : rc));
      const ho = pendingHandoff.current || solutionDoc || ""; pendingHandoff.current = ""; // 没显式交接也用方案文档当源
      const id = await ensureDiscussion();
      if (id) deliberate(intensity, clarification, id, ho || undefined);
    });
  }

  // 议会内部:温和⇄拷问(已有观点则按新强度重跑;有策展先确认)
  function setIntensity(ci: CouncilIntensity) {
    if (ci === councilIntensity) return;
    const willRerun = !!(discussion && (viewpoints.length > 0 || deliberating) && !busy);
    const apply = () => {
      setCouncilIntensity(ci);
      setRunConfig((rc) => (rc ? { ...rc, posture: ci } : rc));
      if (willRerun) deliberate(ci, undefined, discussion!.id);
    };
    if (willRerun) guardRerun("切换审议强度", apply); else apply();
  }

  // 每站产出的规范 MD(= 工作台文档 + 交接载荷)
  function docFor(t: Tab): string {
    if (t === "search") return evidenceToMd(pack, excludedIds);
    if (t === "relay") return solutionDoc || cardToMd(relayCard); // 优先送厚的方案文档,没有才退回薄方向卡
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
    if (t === "auto") return autoBusy && tab === "auto" ? "run" : (autoRun?.rounds?.length ? "done" : "idle");
    if (t === "produce") return artifacts.length > 0 ? "done" : "idle";
    return artifacts.length > 0 ? "done" : "idle";
  }
  // 取消正在跑的请求(挽救卡死):bump token → streamSSE 看门狗 1s 内 abort fetch;复位所有忙态,无需退出重进
  function cancelRun() {
    token.current++; // 让所有在飞 streamSSE 的 isCancelled() 即刻为真 → 看门狗断开连接
    autoLoopRef.current = false;
    setBusy(false); setDeliberating(false); setMakingSolDoc(false); setProducing(false); setAutoBusy(false); setAutoLooping(false); setReconActive(false);
    setPhase((p) => (p === "drafting" ? "drafting" : "awaiting-user"));
    setRunError("已停止当前请求 —— 可以重发了。");
  }
  // 轻提示:右下角浮一条 ~1.6s 自动消失(成功反馈统一走这里,而非静默)
  function flash(msg: string) {
    setFlashMsg(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashMsg(""), 1600);
  }
  // 复制 + 反馈:成功浮「✓ 已复制」,失败给可操作提示(不再静默)
  async function copy(text: string, label = "已复制") {
    try { await navigator.clipboard.writeText(text || ""); flash("✓ " + label); }
    catch { flash("复制失败 —— 请手动选中复制"); }
  }
  // App 内嵌确认(替原生 window.confirm 的丑弹窗)
  function confirmAsk(opts: { title: string; body?: string; yesLabel?: string; danger?: boolean; onYes: () => void }) { setConfirmBox(opts); }
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
  const onwardOf: Record<Tab, Tab[]> = { search: ["relay", "council"], relay: ["council", "produce"], council: ["produce"], produce: [], auto: [] };
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
          <div className={`cv-turn${t.role === "user" ? " me" : ""}${t.failed ? " failed" : ""}${t.pinned ? " pinned" : ""}`} key={t.id || i}>
            <div className="cv-who">
              {t.role === "user" ? "你" : <>{t.speaker}<span className="cv-role">{ROLE_LABEL[t.role] || t.role}</span></>}
              {t.id && !t.failed && (
                <button className={`cv-pin${t.pinned ? " on" : ""}`} title={t.pinned ? "已重视 · 主脑会优先照顾、出卡纳入(点击取消)" : "点赞:让主脑重视这条、收进方案"} onClick={() => togglePin(t)}>👍</button>
              )}
            </div>
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
      auto: { ph: "", hint: "", run: () => {}, label: "", disabled: true },
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

  // ============ 陪练 redesign:顶部步骤条 + 时间线 / 三脑并列 / 方向卡 ============
  function logout() { fetch("/api/auth/logout", { method: "POST" }).catch(() => {}).finally(() => location.reload()); }
  const topChrome = () => (
    <>
      <div className="topbar">
        <div className="brand">ROAST &nbsp;·&nbsp; <b>SPARRING&nbsp;COUNCIL</b> &nbsp;·&nbsp; 点子陪练</div>
        <div className={`online${conn.ok ? "" : " off"}`}><span className="dot" />{conn.text}</div>
      </div>
      <div className="steps">
        {TAB_ORDER.map((tk, i) => {
          const st = tab === tk ? "active" : pipeStatus(tk) === "done" ? "done" : "";
          return (
            <React.Fragment key={tk}>
              {i > 0 && <span className="arrow">→</span>}
              <div className={`step ${st}`} onClick={() => switchTab(tk)}>
                <span className="num">{i + 1}</span><b>{TAB_LABEL[tk]}</b><span className="sub">{TAB_SUB[tk]}</span>
              </div>
            </React.Fragment>
          );
        })}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <span className="ghost-chip" onClick={() => setShowSeatConfig(true)}>席位 · {runConfig ? 3 + runConfig.seats.length : maxSeats}</span>
          <span className="ghost-chip" onClick={() => { setShowHistory(true); refreshHistory(); }}>历史 · {history.length}</span>
          <span className="ghost-chip" title="我所有点子产出过的交付物" onClick={openLibrary}>交付物库</span>
          <span className="ghost-chip" title="登出" onClick={logout}>登出</span>
          <span className="ws">WORKSPACE · 一条点子 · 四站流转</span>
        </div>
      </div>
    </>
  );

  const LikeBtn = ({ turn, small }: { turn: Turn; small?: boolean }) => {
    const active = !!turn.pinned;
    return (
      <button className="clk" onClick={() => togglePin(turn)} title={active ? "已纳入主脑方案(点击移除)" : "点赞:让主脑重视这条、收进方案"}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid " + (active ? "rgba(232,154,42,.6)" : "var(--line2)"), background: active ? "rgba(232,154,42,.16)" : "rgba(255,255,255,.02)", color: active ? "#F2BF52" : "var(--muted)", borderRadius: 8, padding: small ? "6px 11px" : "8px 14px", fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".4px", cursor: "pointer" }}>
        <span style={{ fontSize: 13 }}>👍</span>{active ? "已纳入主脑方案" : "点赞 · 纳入主脑"}
      </button>
    );
  };

  const llTimeline = () => (
    <div style={{ position: "relative", borderRight: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="label">对话时间线</span><span className="mono" style={{ fontSize: 11, color: "var(--cyan)" }}>{turns.length} 条</span>
      </div>
      {!llAtBottom && turns.length > 2 && (
        <button className="clk" onClick={() => { const el = llScrollRef.current; if (el) el.scrollTop = el.scrollHeight; setLlAtBottom(true); }}
          style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", zIndex: 5, padding: "6px 14px", borderRadius: 16, border: "1px solid var(--cyan)", background: "#0c1a2e", color: "var(--cyan)", fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, boxShadow: "0 6px 16px #000a", cursor: "pointer" }}>↓ 跳到最新</button>
      )}
      <div ref={llScrollRef} onScroll={(e) => { const el = e.currentTarget; setLlAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }}
        style={{ flex: 1, minHeight: 0, padding: 14, overflow: "auto", display: "flex", flexDirection: "column", gap: 11 }}>
        {turns.length === 0 && <div className="mono" style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.7 }}>还没开始 —— 在右侧说说你的点子,这里会留下每一步对话轨迹。</div>}
        {turns.map((t, i) => {
          const isUser = t.role === "user"; const k = agentKey(t.speaker);
          const rc = isUser ? "#34D2E6" : t.role === "system" ? "#7B8B9C" : agentColor(k);
          const name = isUser ? "你" : t.role === "system" ? "系统" : t.speaker || "AI";
          const active = detailId === t.id;
          const short = (t.body || "").replace(/\n+/g, " ").trim().slice(0, 46);
          return (
            <div className="tl clk" key={t.id || i} style={{ display: "flex", gap: 10 }} onClick={() => t.id && setDetailId(t.id)}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: active ? "var(--cyan)" : "var(--faint)", boxShadow: active ? "0 0 8px var(--cyan)" : "none" }} />
              </div>
              <div style={{ flex: 1, minWidth: 0, border: "1px solid " + (active ? "var(--cyan)" : "var(--line)"), borderRadius: 8, padding: "9px 11px", background: active ? "var(--cyan2)" : "rgba(255,255,255,.012)" }}>
                <span style={{ display: "inline-block", fontFamily: "var(--mono)", fontSize: 9.5, padding: "2px 7px", borderRadius: 5, marginBottom: 6, color: rc, border: "1px solid " + rc + "44", background: rc + "14" }}>{name}{t.pinned ? " ⭐" : ""}</span>
                <div style={{ fontSize: 12, color: "#C2CCD6", lineHeight: 1.45 }}>{short || (t.failed ? "(未响应)" : "…")}</div>
              </div>
            </div>
          );
        })}
        {(busy || deliberating) && (
          <div className="tl" style={{ display: "flex", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6 }}><span className="breath" /></div>
            <div style={{ flex: 1, border: "1px solid var(--cyan)", borderRadius: 8, padding: "9px 11px", background: "var(--cyan2)" }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--cyan)" }}>{deliberating ? "主脑读整段对话 · 收口出方向卡…" : `${dialogueN === 1 ? "主脑" : dialogueN + " 脑"} · 作答中…`}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const LaneCard = ({ turn }: { turn: Turn }) => {
    const k = agentKey(turn.speaker); const a = AG[k]; const active = !!turn.pinned;
    const corrected = !!turn.corrected; const correcting = !!turn.correctingNow; const editing = correctFor === turn.id;
    const border = corrected ? "rgba(255,93,110,.4)" : active ? "rgba(232,154,42,.4)" : "var(--line)";
    const bg = corrected ? "rgba(255,93,110,.04)" : active ? "rgba(232,151,92,.045)" : "rgba(255,255,255,.018)";
    return (
      <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid " + border, borderTop: "2px solid " + a.c, borderRadius: 10, background: bg, overflow: "hidden" }}>
        <div style={{ padding: "10px 13px", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="agent-pill" style={{ color: a.c }}><span className="d" style={{ background: a.c }} />{turn.speaker || a.n}</span>
            {active && <span className="mono" style={{ fontSize: 9, color: "#F2BF52", border: "1px solid rgba(232,154,42,.5)", borderRadius: 5, padding: "2px 6px" }}>主脑方案</span>}
            {corrected && <span className="mono" title="你判定这条跑偏 —— 已带纠正重答 + 广播给全桌后续" style={{ fontSize: 9, color: "var(--red)", border: "1px solid rgba(255,93,110,.5)", borderRadius: 5, padding: "2px 6px", background: "rgba(255,93,110,.1)" }}>↻ 已纠偏重答</span>}
            <span className="mono" style={{ marginLeft: "auto", fontSize: 9.5, color: turn.failed ? "var(--red)" : correcting ? "var(--cyan)" : "var(--green)" }}>{turn.failed ? "未响应" : correcting ? "重答中…" : "已完成"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>{AG_ROLE[k] || ROLE_LABEL[turn.role] || turn.role}</span>
            {turn.standInFor && turn.standInFor !== turn.speaker && (
              <span className="mono" title={`原指派 ${turn.standInFor} 过载/掉线,${turn.speaker} 接棒作答(白箱降级,非伪装)`} style={{ fontSize: 9, color: "#F2BF52", border: "1px solid rgba(232,154,42,.45)", borderRadius: 5, padding: "1.5px 6px", background: "rgba(232,154,42,.1)" }}>↪ {turn.standInFor} 过载 · {turn.speaker} 接棒</span>
            )}
          </div>
        </div>
        <div className="msg-body ll-lane-scroll" style={{ padding: "13px 14px", fontSize: 13.5, lineHeight: 1.6, overflow: "auto", flex: 1, opacity: correcting ? 0.6 : 1 }}>{turn.failed ? `(未响应:${(turn.error || "").slice(0, 60)})` : correcting ? <span style={{ color: "var(--cyan)" }}><span className="blink" /> 带你的纠正重答中…</span> : turn.body}</div>
        {corrected && turn.correction && !correcting && <div className="mono" style={{ padding: "0 14px 9px", fontSize: 10, color: "#ff8a93", lineHeight: 1.5 }}>🚫 {turn.correction}</div>}
        <div style={{ padding: "9px 12px", borderTop: "1px solid var(--line)" }}>
          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <textarea className="yc-reply" style={{ width: "100%", boxSizing: "border-box", flex: "none", resize: "vertical", minHeight: 56, lineHeight: 1.5 }} value={correctText} autoFocus placeholder="这条哪儿不对?(可留空,直接否掉)· Enter 提交,Shift+Enter 换行" onChange={(e) => setCorrectText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); correctTurn(turn, correctText.trim()); } if (e.key === "Escape") { setCorrectFor(null); setCorrectText(""); } }} />
              <div style={{ display: "flex", gap: 7 }}>
                <button className="mbtn" style={{ borderColor: "var(--red)", color: "var(--red)" }} onClick={() => correctTurn(turn, correctText.trim())}>纠偏 · 重答这条 + 告诉全桌</button>
                <button className="ghost-chip" onClick={() => { setCorrectFor(null); setCorrectText(""); }}>取消</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              {turn.id && !turn.failed ? <LikeBtn turn={turn} small /> : <span />}
              {turn.id && !turn.failed && (corrected
                ? <span className="clk" onClick={() => correctTurn(turn, "")} title="撤销纠偏" style={{ fontSize: 9.5, color: "var(--red)" }}>✓ 已纠偏 · 撤销</span>
                : <span className="clk" onClick={() => { setCorrectFor(turn.id!); setCorrectText(""); }} title="判定这条跑偏 → 带你的纠正重答这条 + 把信号广播给全桌后续" style={{ fontSize: 11, color: "var(--faint)", display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 13 }}>👎</span> 纠偏</span>)}
            </div>
          )}
        </div>
      </div>
    );
  };
  const LanePending = () => (
    <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid var(--line)", borderRadius: 10, background: "rgba(255,255,255,.012)", overflow: "hidden", opacity: .75 }}>
      <div style={{ padding: "10px 13px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
        <span className="breath" /><span className="mono" style={{ fontSize: 10, color: "var(--cyan)" }}>正在作答…</span>
      </div>
      <div style={{ padding: "14px", flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
        {[0, 1, 2].map((i) => <div key={i} style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,.05)", width: i === 2 ? "60%" : "100%" }} />)}
      </div>
    </div>
  );

  const llComposer = () => {
    const drafting = !discussion; const bind = drafting;
    const canSend = drafting ? !!brief.trim() : !!(userInput.trim() || attachments.length);
    const send = () => { if (busy || deliberating || !canSend) return; sendClarify(bind ? brief : userInput); };
    return (
      <div style={{ flex: "0 0 auto", padding: "14px 24px 16px", borderTop: "1px solid var(--line)" }}>
        {attachments.length > 0 && (
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 8 }}>
            {attachments.map((a, i) => (
              <span key={i} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, padding: "4px 9px", borderRadius: 7, border: "1px solid var(--line2)", background: "rgba(255,255,255,.03)", color: "var(--muted)" }}>
                {a.kind === "image" ? "🖼" : "📄"} {a.name.length > 22 ? a.name.slice(0, 20) + "…" : a.name}
                <span className="clk" onClick={() => removeAttach(i)} title="移除" style={{ color: "var(--faint)", fontSize: 12, lineHeight: 1 }}>×</span>
              </span>
            ))}
          </div>
        )}
        <div className="ll-composer">
          <span className="mono" style={{ color: "var(--cyan)", fontSize: 14 }}>›</span>
          <textarea value={bind ? brief : userInput} disabled={busy} rows={1}
            placeholder={drafting ? "说说你的点子,开始想清楚…" : "回应搭子 / 补充想法,继续往下聊…"}
            onChange={(e) => (bind ? setBrief(e.target.value) : setUserInput(e.target.value))}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          <input ref={fileRef} type="file" multiple accept="image/*,.txt,.md,.markdown,.json,.csv,.log,.yml,.yaml" style={{ display: "none" }} onChange={(e) => { addAttachFiles(e.target.files); e.currentTarget.value = ""; }} />
          <button className="ghost-chip" disabled={busy} title="添加图片 / 文本文件(喂给搭子参考)" onClick={() => fileRef.current?.click()} style={{ padding: "7px 11px", fontSize: 14 }}>📎</button>
          {started && <span className="ghost-chip" onClick={reset}>＋新讨论</span>}
          {busy || deliberating
            ? <button className="ghost-chip" title="停止当前请求(卡住时点这里,不用退出重进)" onClick={cancelRun} style={{ padding: "7px 13px", fontSize: 12.5, color: "var(--red)", borderColor: "var(--red)" }}>■ 停止</button>
            : <button className="amber-btn send-icon" disabled={!canSend} onClick={send}>↑</button>}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 8, paddingLeft: 4 }}>📎 加图片/文件给搭子参考 · 点左栏记录看详情 · ⌘/Ctrl+Enter 提交{(busy || deliberating) && " · 卡住了?点「■ 停止」即可恢复"}</div>
      </div>
    );
  };

  // 陪练空场 HUD:三脑环绕「IDEA · 核心」星图(沿用议会图谱动效 §4/§5)。在场搭子按 dialogueN 点亮,其余暗置。
  const LL_HEX: Record<string, string> = { claude: "#e8975c", openai: "#4fd8c0", deepseek: "#8aa0ff" };
  const llIdleOrb = () => {
    const brains = ["claude", "openai", "deepseek"];
    const active = new Set(LL_LINEUP[dialogueN - 1]);
    const C = 260, R = 150;
    const pos = brains.map((_, i) => { const a = (-90 + (i * 360) / brains.length) * (Math.PI / 180); return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) }; });
    return (
      <div style={{ margin: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <svg className="orb" viewBox="0 0 520 520" preserveAspectRatio="xMidYMid meet" style={{ width: "min(380px, 50vh)", height: "min(380px, 50vh)" }}>
          {/* 同心 HUD 环 + 反向旋转虚线环 */}
          <circle cx={C} cy={C} r={R} fill="none" stroke="#13283e" />
          <circle cx={C} cy={C} r="108" fill="none" stroke="#11223a" strokeDasharray="2 8" />
          <circle cx={C} cy={C} r={R} fill="none" stroke="#2a9fc4" strokeWidth="1" strokeDasharray="2 20" opacity="0.35">
            <animateTransform attributeName="transform" type="rotate" from="0 260 260" to="360 260 260" dur="26s" repeatCount="indefinite" />
          </circle>
          <circle cx={C} cy={C} r="132" fill="none" stroke="#1b6f8c" strokeWidth="1" strokeDasharray="2 14" opacity="0.22">
            <animateTransform attributeName="transform" type="rotate" from="360 260 260" to="0 260 260" dur="40s" repeatCount="indefinite" />
          </circle>
          <g stroke="#48dcff18" strokeWidth="1"><line x1="64" y1="260" x2="456" y2="260" /><line x1="260" y1="64" x2="260" y2="456" /></g>
          {/* 中心 → 各脑连线(在场亮、缺席暗虚) */}
          {brains.map((k, i) => { const on = active.has(k); return (
            <line key={"l" + i} x1={C} y1={C} x2={pos[i].x} y2={pos[i].y} stroke={LL_HEX[k]} strokeWidth="1" opacity={on ? 0.5 : 0.2} strokeDasharray={on ? undefined : "3 7"} />
          ); })}
          {/* 脑节点(全员在册,本轮在场的更亮)*/}
          {brains.map((k, i) => { const on = active.has(k); const { x, y } = pos[i]; const col = LL_HEX[k]; return (
            <g key={i} opacity={on ? 1 : 0.62}>
              <circle className={on && busy ? "pulse" : undefined} cx={x} cy={y} r={on ? 12 : 9.5} fill="#08151f" stroke={col} strokeWidth={on ? 1.9 : 1.4} style={{ filter: `drop-shadow(0 0 ${on ? 9 : 4}px ${col}${on ? "cc" : "77"})`, transformOrigin: `${x}px ${y}px` }} />
              <text x={x} y={y - 20} textAnchor="middle" fontFamily="var(--mono)" fontSize="13" fill={col}>{AG[k].n}</text>
              <text x={x} y={y + 26} textAnchor="middle" fontFamily="var(--mono)" fontSize="10" fill={on ? "#9fd6ea" : "#7e93a8"}>{i === 0 ? "主脑" : on ? "在场" : "待命"}</text>
            </g>
          ); })}
          {/* 加载游标:待命慢转,作答中快转 */}
          <circle cx={C} cy={C} r="40" fill="none" stroke="#48dcff" strokeWidth="2" strokeDasharray="5 11" opacity={busy ? 0.85 : 0.32}>
            <animateTransform attributeName="transform" type="rotate" from="0 260 260" to="360 260 260" dur={busy ? "1.3s" : "6s"} repeatCount="indefinite" />
          </circle>
          {/* 呼吸辉光核 */}
          <circle className="core" cx={C} cy={C} r="17" fill="#48dcff" opacity="0.85" style={{ filter: "drop-shadow(0 0 16px #48dcff)", transformOrigin: "260px 260px" }} />
          <circle cx={C} cy={C} r="8" fill="#dffaff" />
          <text x={C} y={C + 52} textAnchor="middle" fontFamily="var(--mono)" fontSize="11" fill="#8aa1bc" letterSpacing="2">IDEA · 核心</text>
        </svg>
        <div className="mono" style={{ fontSize: 12, color: busy ? "var(--cyan)" : "var(--faint)", letterSpacing: ".5px", textAlign: "center" }}>{busy ? "搭子作答中…" : started ? "继续在下方说,搭子会专注回应" : "在下方说说你的点子 → 搭子待命,帮你一步步想清楚"}</div>
      </div>
    );
  };
  const llListView = () => {
    const lastUserIdx = turns.map((t) => t.role).lastIndexOf("user");
    const userBubble = lastUserIdx >= 0 ? turns[lastUserIdx] : null;
    const replies = (lastUserIdx >= 0 ? turns.slice(lastUserIdx + 1) : turns).filter((t) => t.role !== "user" && t.role !== "system");
    const pending = busy ? Math.max(0, dialogueN - replies.length) : 0;
    const lineup = LL_LINEUP[dialogueN - 1].map((k) => AG[k].n).join(" · ");
    return (
      <div className="viewin" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }} key="list">
        <div style={{ padding: "13px 24px", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 11 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>想清楚 · {dialogueN === 1 ? "主脑陪练" : dialogueN + "脑并列"}</div>
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{dialogueN === 1 ? "专注一来一往,帮你想清楚" : "同一个问题,多家同时答 → 你比对、追问"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="breath" /><span className="label">对话搭子</span>
            <div className="seg">
              {[1, 2, 3].map((n) => <button key={n} className={dialogueN === n ? "on" : ""} disabled={busy || deliberating} onClick={() => setDialogueN(n)}>{n === 1 ? "主脑" : n + " 脑"}</button>)}
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{lineup}</span>
            <button className="amber-btn" style={{ marginLeft: "auto", padding: "9px 18px", fontSize: 13, fontFamily: "var(--mono)" }} disabled={!discussion || busy || deliberating || !turns.length} onClick={synthesizeCard}>{deliberating ? "主脑收口中…" : "理清了 · 出方向卡 ↓"}</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "18px 24px", display: "flex", flexDirection: "column", gap: 18, minHeight: 0 }}>
          {deliberating && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid rgba(232,151,92,.4)", borderRadius: 10, padding: "11px 14px", background: "rgba(232,151,92,.08)" }}>
              <span className="breath" style={{ background: "var(--c-claude)", boxShadow: "0 0 8px var(--c-claude)" }} />
              <span className="mono" style={{ fontSize: 12, color: "#EEE3D2" }}>主脑收口中 —— 读整段对话,正在右栏长出方向卡…</span>
            </div>
          )}
          {turns.length === 0 ? (
            llIdleOrb()
          ) : (
            <>
              {userBubble && (
                <div style={{ display: "flex", flexDirection: "column", gap: 7, alignSelf: "flex-end", maxWidth: "78%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "#5a6b7a" }}>你</span></div>
                  <div className="msg-body" style={{ background: "rgba(63,221,138,.06)", border: "1px solid rgba(63,221,138,.18)", borderRadius: 11, padding: "13px 16px", fontSize: 13.5 }}>{userBubble.body}</div>
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="breath" /><div style={{ flex: 1, height: 2, borderRadius: 2, background: "linear-gradient(90deg,var(--cyan),transparent)" }} />
                <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{replies.length + pending || "—"} 家{busy ? "作答中" : "已答"}</span>
              </div>
              <div style={{ display: "flex", gap: 14, minHeight: 300, flex: 1 }}>
                {replies.map((t, i) => <LaneCard turn={t} key={t.id || i} />)}
                {Array.from({ length: pending }).map((_, i) => <LanePending key={"p" + i} />)}
              </div>
            </>
          )}
        </div>
        {llComposer()}
      </div>
    );
  };

  const CtxCard = ({ dir, rec }: { dir: string; rec?: Turn }) => {
    if (!rec) return <div style={{ flex: 1 }} />;
    const isUser = rec.role === "user"; const rc = isUser ? "#34D2E6" : rec.role === "system" ? "#7B8B9C" : agentColor(agentKey(rec.speaker));
    return (
      <div className="tl clk" style={{ flex: 1, minWidth: 0, border: "1px solid var(--line)", borderRadius: 9, padding: "11px 13px", background: "rgba(255,255,255,.012)" }} onClick={() => rec.id && setDetailId(rec.id)}>
        <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)", marginBottom: 7 }}>{dir}</div>
        <span style={{ display: "inline-block", fontFamily: "var(--mono)", fontSize: 9.5, padding: "2px 7px", borderRadius: 5, marginBottom: 6, color: rc, border: "1px solid " + rc + "44", background: rc + "14" }}>{isUser ? "你" : rec.role === "system" ? "系统" : rec.speaker}</span>
        <div style={{ fontSize: 12.5, color: "#C2CCD6", lineHeight: 1.45 }}>{(rec.body || "").replace(/\n+/g, " ").slice(0, 48)}</div>
      </div>
    );
  };
  const llDetail = (t: Turn) => {
    const idx = turns.findIndex((x) => x.id === t.id);
    const prev = turns[idx - 1], next = turns[idx + 1];
    const isUser = t.role === "user"; const k = agentKey(t.speaker);
    const rc = isUser ? "#34D2E6" : t.role === "system" ? "#7B8B9C" : agentColor(k);
    const paras = (t.body || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const titleLine = paras[0] || t.body || "";
    const rest = paras.slice(1);
    return (
      <div className="viewin" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }} key={t.id}>
        <div style={{ padding: "12px 26px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 14 }}>
          <span className="clk" onClick={() => setDetailId(null)} style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--cyan)", fontSize: 13 }}>← 返回三脑并列</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>对话时间线 / {isUser ? "你" : t.role === "system" ? "系统" : t.speaker}</span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>第 {idx + 1} / {turns.length} 条</span>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "26px 30px 16px", display: "flex", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 720, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {isUser || t.role === "system" ? <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: rc }}>{isUser ? "你" : "系统"}</span>
                : <span className="agent-pill" style={{ color: rc }}><span className="d" style={{ background: rc }} />{t.speaker}</span>}
              {!isUser && t.role !== "system" && <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{AG_ROLE[k] || ROLE_LABEL[t.role] || t.role}</span>}
              {t.id && !t.failed && <div style={{ marginLeft: "auto" }}><LikeBtn turn={t} small /></div>}
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#EEF2F6", lineHeight: 1.42, letterSpacing: ".2px" }}>{titleLine}</div>
            {rest.length > 0 && <div className="msg-body" style={{ fontSize: 15, lineHeight: 1.78, display: "flex", flexDirection: "column", gap: 14 }}>{rest.map((p, i) => <p key={i} style={{ margin: 0 }}>{p}</p>)}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="label">上下文</div>
              <div style={{ display: "flex", gap: 12 }}><CtxCard dir="↑ 上一条" rec={prev} /><CtxCard dir="↓ 下一条" rec={next} /></div>
            </div>
          </div>
        </div>
        <div style={{ flex: "0 0 auto", padding: "14px 30px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 720, display: "flex", gap: 10, alignItems: "center" }}>
            <button className="amber-btn" style={{ padding: "11px 20px", fontSize: 13, fontFamily: "var(--mono)" }} onClick={() => { setUserInput((u) => (u ? u + "\n\n" : "") + `> ${(t.body || "").replace(/\n+/g, " ").slice(0, 80)}…\n`); setDetailId(null); }}>↳ 追问此条</button>
            <span className="ghost-chip" style={{ padding: "11px 16px" }} onClick={() => copy(t.body || "", "已复制内容")}>⧉ 复制内容</span>
            <span className="clk mono" onClick={() => setDetailId(null)} style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)" }}>← 跳转自左栏「对话时间线」</span>
          </div>
        </div>
        {llComposer()}
      </div>
    );
  };

  const toggleSec = (key: string) => setCardCollapsed((p) => ({ ...p, [key]: !p[key] }));
  const llDirSec = (key: string, glyph: string, gc: string, title: string, items?: string[]) => {
    if (!items || !items.length) return null;
    const collapsed = !!cardCollapsed[key];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="clk" onClick={() => toggleSec(key)} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 16, height: 16, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, color: gc, border: "1px solid " + gc + "66", background: gc + "1a" }}>{glyph}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#D6DEE7" }}>{title}</span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>{items.length}</span>
          <span style={{ fontSize: 9, color: "var(--faint)", width: 10, textAlign: "center" }}>{collapsed ? "▸" : "▾"}</span>
        </div>
        {!collapsed && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 4 }}>
            {items.map((t, i) => <div key={i} style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5, display: "flex", gap: 8, alignItems: "baseline" }}><span style={{ color: gc, opacity: .7 }}>·</span><span style={{ flex: 1 }}>{t}</span></div>)}
          </div>
        )}
      </div>
    );
  };
  const llDirectionCard = () => {
    const adopted = turns.filter((t) => t.pinned && t.id);
    const c = relayCard;
    const recent = turns.filter((t) => t.role !== "system").slice(-6); // 最新对话(右栏底部快速回看)
    return (
      <div style={{ borderLeft: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="label">方向卡 · DIRECTION</span>
          {c && <span className="ghost-chip" style={{ marginLeft: "auto", padding: "5px 9px", fontSize: 10 }} onClick={() => copy(cardToMd(c), "已复制方向卡")}>⧉ 复制</span>}
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: "16px 15px", overflow: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* ① 一句话内核 —— 置顶 */}
          {c?.oneLine
            ? <div style={{ border: "1px solid rgba(72,220,255,.32)", borderTop: "2px solid var(--cyan)", borderRadius: 10, padding: "12px 14px", background: "rgba(72,220,255,.06)" }}>
                <div className="mono" style={{ fontSize: 9, color: "var(--cyan)", marginBottom: 5, letterSpacing: 1 }}>一句话内核 · CORE</div>
                <div style={{ fontSize: 14, color: "#E6EEF6", lineHeight: 1.5, fontWeight: 600 }}>{c.oneLine}</div>
              </div>
            : <div style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.6 }}>和搭子聊清楚后,点中央「理清了 · 出方向卡」—— 主脑(Claude)读整段对话收口,这里会长出一句内核 + 方向卡(已稳定 / 新角度 / 需你拍板 / 暂不做)。</div>}

          {/* ② 方向卡 —— 整块折叠,默认收起 */}
          {c && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
              <div className="clk" onClick={() => setDirOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 13px", background: "rgba(232,151,92,.06)" }}>
                <span style={{ width: 7, height: 7, borderRadius: 2, background: "var(--c-claude)" }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: "#EEE3D2" }}>方向卡</span>
                <span className="mono" style={{ fontSize: 9, color: "var(--faint)" }}>主脑收口</span>
                {adopted.length > 0 && <span className="mono" style={{ fontSize: 9.5, color: "#F2BF52" }}>· 已纳入 {adopted.length}</span>}
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)" }}>{dirOpen ? "▾ 收起" : "▸ 展开"}</span>
              </div>
              {dirOpen && (
                <div style={{ padding: "14px 13px", display: "flex", flexDirection: "column", gap: 16, borderTop: "1px solid var(--line)" }}>
                  <div style={{ border: "1px solid rgba(232,151,92,.3)", borderRadius: 9, background: "rgba(232,151,92,.05)", padding: "11px 12px", display: "flex", flexDirection: "column", gap: 9 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: "#EEE3D2" }}>主脑方案</span>
                      <span className="mono" style={{ fontSize: 9, color: "var(--faint)", letterSpacing: 1 }}>MASTER PLAN</span>
                      <span className="mono" style={{ marginLeft: "auto", fontSize: 9.5, color: adopted.length ? "#F2BF52" : "var(--faint)" }}>已纳入 {adopted.length}</span>
                    </div>
                    {adopted.length === 0
                      ? <div style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.5 }}>给任意搭子的回答点「👍」→ 纳入主脑方案,主脑出卡围绕它收敛。</div>
                      : <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                          {adopted.map((t) => { const k = agentKey(t.speaker); return (
                            <div key={t.id} style={{ display: "flex", gap: 7, alignItems: "flex-start", border: "1px solid var(--line)", borderRadius: 7, padding: "8px 9px", background: "rgba(255,255,255,.02)" }}>
                              <span style={{ flex: "0 0 auto", width: 6, height: 6, borderRadius: 2, marginTop: 5, background: agentColor(k) }} />
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div className="mono" style={{ fontSize: 9, color: agentColor(k), marginBottom: 3 }}>{t.speaker} · 强制纳入</div>
                                <div style={{ fontSize: 11.5, color: "#CCD6E0", lineHeight: 1.45 }}>{(t.body || "").slice(0, 110)}{(t.body || "").length > 110 ? "…" : ""}</div>
                              </div>
                              <span className="clk" onClick={(e) => { e.stopPropagation(); togglePin(t); }} title="移除" style={{ color: "var(--faint)", fontSize: 13, lineHeight: 1 }}>×</span>
                            </div>); })}
                        </div>}
                  </div>
                  {llDirSec("clear", "✓", "#3FDD8A", "已稳定", c?.clear)}
                  {llDirSec("angles", "+", "#34D2E6", "接力铺开的新角度", c?.expandedAngles)}
                  {llDirSec("assumptions", "!", "#E8975C", "关键假设", c?.assumptions)}
                  {(c.firstNarrowing || (c.decisionsForYou && c.decisionsForYou.length > 0)) && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div className="clk" onClick={() => toggleSec("decide")} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 16, height: 16, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700, color: "var(--cyan)", border: "1px solid rgba(52,210,230,.5)", background: "var(--cyan2)" }}>◆</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#D6DEE7" }}>需要你拍板</span>
                        <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--faint)", width: 10, textAlign: "center" }}>{cardCollapsed.decide ? "▸" : "▾"}</span>
                      </div>
                      {!cardCollapsed.decide && (
                        <div style={{ border: "1px solid rgba(232,154,42,.4)", borderRadius: 10, padding: 13, background: "rgba(232,154,42,.06)" }}>
                          {c.firstNarrowing && <div style={{ fontSize: 13, fontWeight: 700, color: "#EEE3D2", lineHeight: 1.4 }}>{c.firstNarrowing}</div>}
                          {c.decisionsForYou && c.decisionsForYou.length > 0 && <ul style={{ margin: "8px 0 0", paddingLeft: 16, display: "flex", flexDirection: "column", gap: 5 }}>{c.decisionsForYou.map((x, i) => <li key={i} style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>{x}</li>)}</ul>}
                          {c.inviteYourInput && <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 10, lineHeight: 1.5 }}>💬 {c.inviteYourInput}</div>}
                        </div>
                      )}
                    </div>
                  )}
                  {llDirSec("dont", "–", "#7B8B9C", "暂不做", c?.dontBuildYet)}
                </div>
              )}
            </div>
          )}

          {/* ③ 最新对话 —— 右栏底部快速回看,点开看大图 */}
          {recent.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="label">最新对话 · RECENT</span>
                <span className="mono" style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--faint)" }}>近 {recent.length} 条</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {recent.map((t, i) => {
                  const isUser = t.role === "user";
                  const col = isUser ? "var(--cyan)" : agentColor(agentKey(t.speaker));
                  return (
                    <div key={t.id || i} className={t.id ? "clk" : ""} onClick={() => t.id && setDetailId(t.id)} title={t.id ? "看大图" : ""} style={{ display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", background: "rgba(255,255,255,.015)" }}>
                      <span style={{ flex: "0 0 auto", width: 6, height: 6, borderRadius: 2, marginTop: 5, background: col }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="mono" style={{ fontSize: 9, color: col, marginBottom: 3 }}>{isUser ? "你" : t.speaker}</div>
                        <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.45 }}>{(t.body || "").replace(/\s+/g, " ").slice(0, 100)}{(t.body || "").length > 100 ? "…" : ""}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        {turns.length > 0 && (
          <div style={{ flex: "0 0 auto", padding: "12px 15px", borderTop: "1px solid var(--line)", background: solutionDoc ? "rgba(63,221,138,.05)" : "rgba(232,151,92,.05)", display: "flex", flexDirection: "column", gap: 9 }}>
            {solutionDoc ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--green)" }}>✓ 方案文档已出 · 主脑收口</span>
                  <span className="ghost-chip" style={{ marginLeft: "auto", padding: "4px 8px", fontSize: 10 }} onClick={() => copy(solutionDoc || "", "已复制方案文档")}>⧉ 复制</span>
                  <span className="ghost-chip" style={{ padding: "4px 8px", fontSize: 10, ...(makingSolDoc ? { opacity: 0.55, pointerEvents: "none" } : {}) }} onClick={makeSolutionDoc} title="重新收口一版(读最新对话)">{makingSolDoc ? "↻ 重出中…" : "↻ 重出"}</span>
                </div>
                <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>这份厚方案 = 交下游精修的真正方案(比方向卡厚):</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="mbtn" style={{ flex: 1, justifyContent: "center" }} disabled={busy || deliberating} onClick={() => sendHandoff("relay", "council")} title="带方案文档进议会,多 AI 署名压测">⚖ 议会压测</button>
                  <button className="amber-btn" style={{ flex: 1.5, padding: "9px 12px", fontFamily: "var(--mono)", fontSize: 12.5, justifyContent: "center" }} disabled={busy || deliberating} onClick={() => sendHandoff("relay", "produce")} title="带方案文档去产出,各模型精修成文案/PRD/PPT/图">⚡ 送到产出 →</button>
                </div>
              </>
            ) : (
              <>
                <div className="mono" style={{ fontSize: 10, color: "#F2BF52", lineHeight: 1.5 }}>聊清楚了?让主脑把整段对话收口成「方案文档」—— 厚、固定分节,才是交下游精修的真正方案(方向卡只是想清楚的辅助)。</div>
                <button className="amber-btn" style={{ padding: "11px 12px", fontFamily: "var(--mono)", fontSize: 13, justifyContent: "center" }} disabled={makingSolDoc || busy || deliberating} onClick={makeSolutionDoc}>{makingSolDoc ? "主脑收口中…(读整段对话写方案)" : "📄 出方案文档"}</button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };
  const llBody = () => {
    const detailTurn = detailId ? turns.find((t) => t.id === detailId) : null;
    return (
      <div className="ll">
        {llTimeline()}
        {detailTurn ? llDetail(detailTurn) : llListView()}
        {llDirectionCard()}
      </div>
    );
  };

  // ============ 搜索 redesign:侦察维度 / 证据流 / 侦察简报 ============
  const SS_DIMS = mode === "copy" ? SEARCH_DIMS_COPY : SEARCH_DIMS_IDEA;
  const ssDimName = (cat: string) => SS_DIMS.find((d) => d.id === cat)?.name || cat;
  const ssCard = (it: EvidencePack["items"][number]) => {
    const picked = !excludedIds.has(it.id);
    const sc = SRC_COLOR[it.source] || "#7e97b3";
    const cc = CAT_COLOR[it.category] || "var(--cyan)";
    const conf = credScore(it.credibility);
    const confC = conf >= 85 ? "var(--green)" : conf >= 70 ? "var(--cyan)" : "#F2BF52";
    return (
      <div key={it.id} style={{ border: "1px solid " + (picked ? "rgba(72,220,255,.4)" : "var(--line)"), borderRadius: 11, padding: "14px 16px", background: picked ? "rgba(72,220,255,.05)" : "rgba(255,255,255,.015)", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--faint)" }}>{it.id}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 8px", borderRadius: 5, color: cc, border: "1px solid " + cc + "55", background: cc + "18" }}>{ssDimName(it.category)}</span>
          <span className="src-pill"><span style={{ width: 7, height: 7, borderRadius: 2, background: sc }} />{it.source}</span>
          {it.engagement && <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>· {it.engagement.value} {it.engagement.metric === "points" ? "分" : it.engagement.metric}</span>}
          {it.tier && it.tier !== "green" && <span className="mono" style={{ fontSize: 9, color: it.tier === "red" ? "var(--red)" : "#F2BF52" }}>{it.tier === "red" ? "⚠风险源" : "需配置"}</span>}
          <button className="ghost-chip" onClick={() => setExcludedIds((prev) => { const s = new Set(prev); picked ? s.add(it.id) : s.delete(it.id); return s; })} style={{ marginLeft: "auto", padding: "5px 10px", fontSize: 10, ...(picked ? { borderColor: "var(--cyan)", color: "var(--cyan)" } : {}) }}>{picked ? "✓ 已纳简报" : "纳入简报"}</button>
        </div>
        <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: 14.5, fontWeight: 600, color: "#E7ECF2", lineHeight: 1.4, textDecoration: "none" }}>{it.title || it.claim}</a>
        <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.55 }}>{it.impact || it.snippet}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="label" style={{ letterSpacing: "1.5px" }}>可信度</span>
          <div style={{ flex: 1, height: 4, borderRadius: 4, background: "var(--line2)", overflow: "hidden" }}><div style={{ width: conf + "%", height: "100%", background: confC }} /></div>
          <span className="mono" style={{ fontSize: 10, color: confC }}>{conf}</span>
        </div>
      </div>
    );
  };
  const ssComposer = () => {
    const drafting = !discussion;
    const send = () => { if (busy || deliberating) return; if (drafting && !brief.trim()) return; runSearch(); };
    return (
      <div style={{ flex: "0 0 auto", padding: "14px 24px 16px", borderTop: "1px solid var(--line)" }}>
        <div className="ll-composer">
          <span className="mono" style={{ color: "var(--cyan)", fontSize: 14 }}>›</span>
          <textarea value={drafting ? brief : userInput} disabled={busy} rows={1}
            placeholder={drafting ? "描述你的点子,开始事实侦察…" : "追加侦察方向 / 修订点子,重新搜索…"}
            onChange={(e) => (drafting ? setBrief(e.target.value) : setUserInput(e.target.value))}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          {started && <span className="ghost-chip" onClick={reset}>＋新讨论</span>}
          <button className="amber-btn" style={{ padding: "10px 18px", fontFamily: "var(--mono)", fontSize: 13 }} disabled={busy || deliberating || (drafting && !brief.trim())} onClick={send}>{busy ? "侦察中…" : pack ? "重新搜索 →" : "开始搜索 →"}</button>
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 8, paddingLeft: 4 }}>点左栏维度可筛选证据 · ⌘/Ctrl+Enter 提交</div>
      </div>
    );
  };
  const ssBody = () => {
    const items = pack?.items || [];
    const eb = pack?.brief;
    const countOf = (id: string) => (id === "all" ? items.length : items.filter((i) => i.category === id).length);
    const shown = searchDim === "all" ? items : items.filter((i) => i.category === searchDim);
    const pickedCount = items.filter((i) => !excludedIds.has(i.id)).length;
    return (
      <div className="ll" style={{ gridTemplateColumns: "248px 1fr 312px" }}>
        {/* 左:侦察维度 */}
        <div style={{ borderRight: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="label">侦察维度 · RECON</span>{busy && <span className="breath" />}
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: 14, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            {discussion && <div style={{ border: "1px solid var(--line2)", borderRadius: 10, padding: "12px 13px", background: "linear-gradient(180deg,rgba(72,220,255,.05),rgba(255,255,255,.01))" }}>
              <div className="label" style={{ marginBottom: 7 }}>当前点子</div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: "#D6DEE7" }}>{brief || "(未填写)"}</div>
            </div>}
            <div className="mini-radar"><i /><i className="r2" /><i className="r3" /><div className="mr-sweep" /></div>
            {busy && <div className="mono" style={{ textAlign: "center", fontSize: 10, color: "var(--cyan)", marginTop: -4, letterSpacing: ".5px" }}>扫描中 · {reconElapsed}s</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {SS_DIMS.map((d) => {
                const cnt = countOf(d.id); const active = searchDim === d.id;
                const scanned = d.id === "all" || cnt > 0; const sc = scanned ? "var(--green)" : "var(--faint)";
                return (
                  <div key={d.id} role="button" tabIndex={0} aria-pressed={active} className={"dim" + (active ? " on" : "")} onClick={() => setSearchDim(d.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSearchDim(d.id); } }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: sc, boxShadow: scanned ? "0 0 7px " + sc : "none", flex: "0 0 auto" }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: active ? "var(--cyan)" : "#D6DEE7" }}>{d.name}</div>
                      <div className="mono" style={{ fontSize: 9, color: "var(--faint)", letterSpacing: ".5px" }}>{d.en}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {d.id !== "all" && <div className="mono" style={{ fontSize: 10, color: sc }}>{scanned ? "已扫" : "待扫"}</div>}
                      <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: cnt ? "#C2CCD6" : "var(--faint)" }}>{d.id === "all" ? cnt + " 命中" : cnt ? "命中 " + cnt : "—"}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {/* 中:证据流 */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "13px 24px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>事实侦察 · 证据流</div>
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>给点子找证据落点 · 竞品 / 需求 / 痛点 / 定价 / 趋势</span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--cyan)" }}>{ssDimName(searchDim)} · {shown.length} 条</span>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "18px 24px", display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
            {shown.length === 0
              ? <div className="board-empty" style={{ margin: "auto", textAlign: "center", lineHeight: 1.8, maxWidth: 400 }}>{busy ? "侦察中,在扫竞品 / 需求 / 痛点 / 定价 / 趋势…" : items.length ? "该维度暂无证据,换一个维度看看" : pack && pack.failures && pack.failures.length ? `检索源都没返回结果(${pack.failures.length} 个源失败/超时:${[...new Set(pack.failures.map((f) => f.source))].slice(0, 4).join("、")})。换个说法或稍后重试。` : pack ? "本轮没检索到证据 —— 换个更具体的说法再搜。" : "在下方描述你的点子,开始事实侦察。"}</div>
              : shown.map((it) => ssCard(it))}
          </div>
          {ssComposer()}
        </div>
        {/* 右:侦察简报 */}
        <div style={{ borderLeft: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center" }}>
            <span className="label">侦察简报 · BRIEF</span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--cyan)" }}>已纳 {pickedCount} 条</span>
          </div>
          <div style={{ padding: "16px 15px", overflow: "auto", display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: 11, textAlign: "center", background: "rgba(255,255,255,.015)" }}>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--green)" }}>{items.length}</div>
                <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginTop: 2 }}>命中证据</div>
              </div>
              <div style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: 11, textAlign: "center", background: "rgba(255,255,255,.015)" }}>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--cyan)" }}>{eb ? CONFIDENCE_CN[eb.confidence] : "—"}</div>
                <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginTop: 2 }}>整体可信度</div>
              </div>
            </div>
            {!eb
              ? <div style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.6 }}>{busy ? "情报官正在读证据、提炼简报…" : items.length ? "简报合成中…" : "开始搜索后,这里会出:关键结论 + 整体可信度 + 进 / 补扫建议。"}</div>
              : <>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="label">关键结论</div>
                  {eb.conclusions.map((c, i) => <div key={i} style={{ fontSize: 12.5, color: "#CCD6E0", lineHeight: 1.5, display: "flex", gap: 9 }}><span style={{ color: CAT_COLOR[c.cat] || "#34D2E6", marginTop: 1 }}>—</span><span>{c.text}</span></div>)}
                </div>
                {eb.suggestion && <div style={{ border: "1px solid rgba(232,154,42,.35)", borderRadius: 9, padding: "11px 13px", background: "rgba(232,154,42,.06)" }}>
                  <div className="mono" style={{ fontSize: 10, color: "#F2BF52", marginBottom: 5 }}>侦察建议</div>
                  <div style={{ fontSize: 12.5, color: "#EEE3D2", lineHeight: 1.55 }}>{eb.suggestion}</div>
                </div>}
              </>}
          </div>
          <div style={{ flex: "0 0 auto", padding: "13px 15px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 9 }}>
            <div className="label" style={{ textAlign: "center" }}>送到 →</div>
            <div style={{ display: "flex", gap: 9 }}>
              <button className="amber-btn" style={{ flex: 1, padding: 11, fontSize: 13, fontFamily: "var(--mono)" }} disabled={!docFor("search") || busy || deliberating} onClick={() => sendHandoff("search", "relay")}>陪练 · 想清楚</button>
              <button className="ghost-chip" style={{ flex: 1, padding: 11, justifyContent: "center", fontSize: 12 }} disabled={!docFor("search") || busy || deliberating} onClick={() => sendHandoff("search", "council")}>议会 · 审议</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ============ 产出 redesign:方案源 / 格式+模型生成 / 产物清单 ============
  const ccPlanPoints = (): { from: string; c: string; t: string }[] => {
    const pts: { from: string; c: string; t: string }[] = [];
    if (relayCard) {
      (relayCard.clear || []).slice(0, 3).forEach((t) => pts.push({ from: "陪练", c: "var(--cyan)", t }));
      if (relayCard.firstNarrowing) pts.push({ from: "陪练", c: "var(--cyan)", t: "先收窄:" + relayCard.firstNarrowing });
    }
    if (converged) {
      (converged.addressed || []).slice(0, 3).forEach((a) => pts.push({ from: "议会", c: "var(--green)", t: "认领:" + a.point }));
      (converged.unsilenceable || []).slice(0, 2).forEach((u) => pts.push({ from: "议会", c: "var(--red)", t: "钉死:" + u }));
    }
    return pts;
  };
  // 立项包/计数:同类多版只取「已采用」;无采用则取最新一版(避免把同类所有草稿都打包)
  const ccPicked = () => {
    const byType: Record<string, Artifact[]> = {};
    artifacts.forEach((a) => (byType[a.type] || (byType[a.type] = [])).push(a));
    return Object.values(byType).flatMap((arr) => { const ch = arr.filter((a) => a.status === "chosen"); return ch.length ? ch : [arr[arr.length - 1]]; });
  };
  const ccPackMd = () => {
    const L: string[] = [`# ${discussion?.title || brief.slice(0, 30) || "立项包"}`, "", "> 一条点子 · 四站流转 · ROAST", "", "## 点子", brief || "(未填写)", ""];
    // 优先收厚的「方案文档」(主脑收口);没有才退回议会收敛 / 方向卡 / 结论
    if (solutionDoc) L.push("## 方案文档(主脑收口)", solutionDoc, "");
    const planMd = (converged ? convergedToMd(converged) : "") || cardToMd(relayCard) || conclusion;
    if (planMd) L.push(converged ? "## 议会收敛" : "## 方向卡", planMd, "");
    const picked = ccPicked();
    picked.filter((a) => a.type !== "image" && a.type !== "html_proto" && a.type !== "critique" && a.content).forEach((a) => L.push(`## ${ARTIFACT_TYPE_LABEL[a.type]} · ${a.provider}`, a.content, ""));
    const protos = picked.filter((a) => a.type === "html_proto");
    if (protos.length) { L.push("## HTML 原型"); protos.forEach((a) => L.push(`- ${a.provider}:见单独的 .html 文件(产物卡「↓ 下载 HTML」)`)); L.push(""); }
    const imgs = picked.filter((a) => a.type === "image" && a.imagePath);
    if (imgs.length) { L.push("## 配图"); imgs.forEach((a) => L.push(`- ${a.provider}:/api/artifact/${a.id}/image`)); L.push(""); }
    return L.join("\n").trim();
  };
  const ccNextHint = () => {
    if (!artifacts.length) return "选一个格式 + 一个模型,生成第一份交付物。";
    const types = new Set(artifacts.map((a) => a.type));
    const missing = (["prd", "copy", "image"] as ArtifactType[]).filter((t) => !types.has(t)).map((t) => ARTIFACT_TYPE_LABEL[t]);
    return missing.length ? `已出 ${artifacts.length} 件。补上 ${missing.slice(0, 2).join(" / ")} 后,可一键打包为「立项包」交付。` : `PRD / 文案 / 配图 都齐了 —— 可一键打包为「立项包」交付。`;
  };
  const ccProvColor = (label: string) => agentColor(agentKey(label));
  const ccAvail = (type: ArtifactType) => (type === "image" ? produceProviders.filter((p) => p.image) : produceProviders);
  const ccExportArt = (a: Artifact) => {
    if (a.type === "ppt") { exportPptx({ title: `${discussion?.title || "Roast"} · PPT`, conclusion: a.content, evidence: [] }); flash("✓ 已导出 PPTX"); }
    else { exportMarkdown({ title: `${discussion?.title || "Roast"} · ${ARTIFACT_TYPE_LABEL[a.type]}`, conclusion: a.content, evidence: [] }); flash("✓ 已导出 Markdown"); }
  };
  const ccArtCard = (a: Artifact) => {
    const fm = (PRODUCE_FORMATS.find((f) => f.id === a.type) || (a.type === "code_sketch" ? { ic: "‹›", name: "代码草稿", c: "#8AA0FF" } : a.type === "critique" ? { ic: "🔍", name: "挑刺", c: "#FF8A6B" } : PRODUCE_FORMATS[1]));
    const pc = ccProvColor(a.provider);
    const menuOpen = artMenu?.id === a.id;
    const isCrit = a.type === "critique";
    const avail = ccAvail(a.type).filter((p) => (artMenu?.mode === "critique" ? p.label !== a.provider : true));
    const sameModelId = produceProviders.find((p) => p.label === a.provider)?.id || avail[0]?.id;
    return (
      <div key={a.id} style={{ border: "1px solid var(--line)", borderLeft: "2px solid " + fm.c, borderRadius: 11, padding: "15px 17px", background: "rgba(255,255,255,.015)", display: "flex", flexDirection: "column", gap: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <span style={{ width: 26, height: 26, borderRadius: 7, display: "grid", placeItems: "center", fontSize: 13, color: fm.c, border: "1px solid " + fm.c + "55", background: fm.c + "18" }}>{fm.ic}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 8px", borderRadius: 5, color: fm.c, border: "1px solid " + fm.c + "44", background: fm.c + "14" }}>{fm.name}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#EEF2F6" }}>{ARTIFACT_TYPE_LABEL[a.type]}</span>
          <span className="agent-pill" style={{ color: pc }}><span className="d" style={{ background: pc }} />{a.provider}</span>
          {!isCrit && <button className="mbtn" style={{ marginLeft: "auto", padding: "4px 10px", ...(a.status === "chosen" ? { borderColor: "var(--green)", color: "var(--green)", background: "rgba(63,227,160,.12)" } : {}) }} onClick={() => chooseArt(a.id, a.type)} title={a.status === "chosen" ? "已采用 —— 立项包用这版" : "采用这版 —— 立项包只收已采用的,同类其余转候选"}>{a.status === "chosen" ? "✓ 已采用" : "采用"}</button>}
          <span className="clk" onClick={() => removeArt(a.id)} title="删除" style={{ color: "var(--faint)", fontSize: 14, marginLeft: isCrit ? "auto" : 0 }}>×</span>
        </div>
        {a.type === "image" && a.imagePath
          ? <img src={`/api/artifact/${a.id}/image`} alt="配图" style={{ width: "100%", maxHeight: 280, objectFit: "contain", borderRadius: 8, border: "1px solid var(--line)" }} />
          : a.type === "html_proto"
          ? <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
              <iframe srcDoc={htmlOf(a.content)} sandbox="allow-scripts" title="HTML 原型预览" style={{ width: "100%", height: 440, border: "none", display: "block", background: "#fff" }} />
            </div>
          : <div style={{ fontSize: 13, color: "#C2CCD6", lineHeight: 1.65, whiteSpace: "pre-wrap", borderLeft: "1px solid var(--line)", paddingLeft: 13, maxHeight: 460, overflow: "auto" }}>{a.content || ""}</div>}
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 10, borderTop: "1px solid var(--line)", flexWrap: "wrap" }}>
          {a.type !== "image" && !isCrit && <button className="mbtn" disabled={producing} title={`让 ${a.provider} 自己按你的指令改这版(不换模型)`} onClick={() => { setArtInstr(""); setArtMenu(menuOpen && artMenu?.mode === "refine" ? null : { id: a.id, mode: "refine" }); }}>✎ 改稿</button>}
          {a.type !== "image" && !isCrit && <button className="mbtn" disabled={producing} title="让另一家 AI 只挑刺、不改写 —— 读完你自己决定怎么改" onClick={() => setArtMenu(menuOpen && artMenu?.mode === "critique" ? null : { id: a.id, mode: "critique" })}>🔍 让另一家挑刺</button>}
          {!isCrit && <button className="mbtn" disabled={producing} title="换一家从头另出一版,并排比较(不在原稿上改)" onClick={() => setArtMenu(menuOpen && artMenu?.mode === "regen" ? null : { id: a.id, mode: "regen" })}>⤺ 换模型重生</button>}
          {a.type !== "image" && <button className="mbtn" onClick={() => copy(a.type === "html_proto" ? htmlOf(a.content) : (a.content || ""), "已复制")}>⧉ 复制</button>}
          {a.type === "html_proto" && <button className="mbtn" onClick={() => openHtmlPreview(a)}>⛶ 放大预览</button>}
          {a.type === "html_proto" && <button className="mbtn" onClick={() => downloadHtml(a)}>↓ 下载 HTML</button>}
          {a.type !== "image" && a.type !== "html_proto" && <button className="mbtn" onClick={() => ccExportArt(a)}>{a.type === "ppt" ? "↓ 导出 PPTX" : "↓ 导出 MD"}</button>}
          {a.type === "image" && a.imagePath && <button className="mbtn" onClick={() => downloadArtifactImage(a)}>↓ 下载图</button>}
        </div>
        {menuOpen && artMenu?.mode === "refine" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 7, paddingTop: 4 }}>
            <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>让 <b style={{ color: pc }}>{a.provider}</b> 自己改(给一句具体要求,不换模型):</span>
            <textarea className="yc-reply" style={{ width: "100%", boxSizing: "border-box", flex: "none", resize: "vertical", minHeight: 50, lineHeight: 1.5 }} value={artInstr} autoFocus placeholder="例如:把 MVP 范围写具体 / 风险那节再补 2 条 / 语气更克制 …(⌘/Ctrl+Enter 提交)" onChange={(e) => setArtInstr(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { if (sameModelId) { produce(a.type, sameModelId, a.id, artInstr.trim() || undefined); setArtMenu(null); setArtInstr(""); } } if (e.key === "Escape") { setArtMenu(null); setArtInstr(""); } }} />
            <div style={{ display: "flex", gap: 7 }}>
              <button className="mbtn" disabled={producing || !sameModelId} onClick={() => { produce(a.type, sameModelId!, a.id, artInstr.trim() || undefined); setArtMenu(null); setArtInstr(""); }}>✎ 让 {a.provider} 改这版</button>
              <button className="ghost-chip" onClick={() => { setArtMenu(null); setArtInstr(""); }}>取消</button>
            </div>
          </div>
        )}
        {menuOpen && artMenu?.mode !== "refine" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>
            <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{artMenu?.mode === "critique" ? "让哪家挑刺(只批不改):" : "换哪家从头重生:"}</span>
            {avail.map((p) => <button key={p.id} className="mbtn" disabled={producing} onClick={() => { if (artMenu?.mode === "critique") produce("critique", p.id, a.id); else produce(a.type, p.id, undefined); setArtMenu(null); }}>{p.label}</button>)}
            {avail.length === 0 && <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{artMenu?.mode === "critique" ? "没有别家可挑刺" : "无可用模型"}</span>}
          </div>
        )}
      </div>
    );
  };
  const ccBody = () => {
    const fmt = produceType;
    const avail = ccAvail(fmt);
    // 默认模型:HTML 原型 / 代码草稿吃代码能力,默认挑强 coder(Claude→DeepSeek→OpenAI);其余用列表第一个
    const defaultModel = ((fmt === "html_proto" || fmt === "code_sketch") && ["claude", "deepseek", "openai"].map((id) => avail.find((p) => p.id === id)).find(Boolean)?.id) || avail[0]?.id || "";
    const model = produceModel && avail.some((p) => p.id === produceModel) ? produceModel : defaultModel;
    const fmName = PRODUCE_FORMATS.find((f) => f.id === fmt)?.name || "";
    const done = artifacts.filter((a) => a.type === "image" ? a.imagePath : a.content).length;
    const plan = ccPlanPoints();
    return (
      <div className="ll" style={{ gridTemplateColumns: "250px 1fr 314px" }}>
        {/* 左:方案源 */}
        <div style={{ borderRight: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="label">方案源 · PLAN</span><span className="mono" style={{ fontSize: 11, color: plan.length ? "var(--green)" : "var(--faint)" }}>{plan.length ? "已收敛" : "待收敛"}</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: 14, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            {discussion && <div style={{ border: "1px solid var(--line2)", borderRadius: 10, padding: "12px 13px", background: "linear-gradient(180deg,rgba(72,220,255,.05),rgba(255,255,255,.01))" }}>
              <div className="label" style={{ marginBottom: 7 }}>当前点子</div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: "#D6DEE7" }}>{brief || "(未填写)"}</div>
            </div>}
            {solutionDoc && (
              <div style={{ border: "1px solid rgba(63,221,138,.3)", borderTop: "2px solid var(--green)", borderRadius: 10, background: "rgba(63,221,138,.04)", padding: "12px 13px", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span className="label" style={{ color: "var(--green)" }}>方案文档 · 主脑收口</span>
                  <span className="ghost-chip" style={{ marginLeft: "auto", padding: "3px 7px", fontSize: 9 }} onClick={() => copy(solutionDoc || "", "已复制方案文档")}>⧉ 复制</span>
                </div>
                <div style={{ maxHeight: 340, overflow: "auto", fontSize: 11.5, lineHeight: 1.65, color: "#CCD6E0", whiteSpace: "pre-wrap", borderTop: "1px solid var(--line)", paddingTop: 8 }}>{solutionDoc}</div>
                <div className="mono" style={{ fontSize: 9, color: "var(--faint)" }}>↓ 下面各模型会精修这份方案 → 文案 / PRD / PPT / 图</div>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div className="label">{solutionDoc ? "要点速览(完整见上)" : "喂给 AI 的要点"}</div>
              {plan.length === 0 && <div style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.6 }}>先在「陪练」出方向卡、或「议会」收敛出方案 —— 这里会汇成喂给 AI 的要点。没有也能直接生成(用点子本身)。</div>}
              {plan.map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 9, border: "1px solid var(--line)", borderRadius: 8, padding: "9px 10px", background: "rgba(255,255,255,.012)" }}>
                  <span style={{ flex: "0 0 auto", width: 6, height: 6, borderRadius: 2, marginTop: 5, background: p.c }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 9, color: p.c, marginBottom: 3, letterSpacing: ".5px" }}>来自 {p.from}</div>
                    <div style={{ fontSize: 12, color: "#CCD6E0", lineHeight: 1.45 }}>{p.t}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* 中:格式 + 模型 → 生成 + 产物流 */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "13px 24px", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>产出 · 让某个 AI 生成</div>
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>把方案交给一个模型 → 文案 / PRD / 设计文档 / 配图 / PPT</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 9 }}>
              {PRODUCE_FORMATS.map((f) => (
                <div key={f.id} className={"fmt" + (fmt === f.id ? " on" : "")} onClick={() => { setProduceType(f.id); setProduceModel(""); }}>
                  <span className="ic" style={{ color: f.c, border: "1px solid " + f.c + "55", background: f.c + "18" }}>{f.ic}</span>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: fmt === f.id ? "var(--cyan)" : "#E7ECF2" }}>{f.name}</div>
                    <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)", marginTop: 2 }}>{f.sub}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="label" style={{ flex: "0 0 auto" }}>交给</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {avail.map((p) => <button key={p.id} className={"mbtn" + (model === p.id ? " on" : "")} onClick={() => setProduceModel(p.id)}><span style={{ width: 7, height: 7, borderRadius: 2, background: ccProvColor(p.label) }} />{p.label}</button>)}
                {avail.length === 0 && <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{fmt === "image" ? "无支持生图的厂商(需 OpenAI)" : "无可用模型"}</span>}
              </div>
              {fmt === "html_proto" && (
                <button
                  className={"mbtn" + (protoRealImg ? " on" : "")}
                  title={protoRealImg ? "原型里的图用 gpt-image-1 真生成(贴题,慢 +~30s/耗额度);关掉则用 picsum 占位图" : "原型里的图用 picsum 占位(快/免费但不贴题);开启则真生图"}
                  onClick={() => setProtoRealImg((v) => !v)}
                  style={{ flex: "0 0 auto" }}
                >🖼 配真图 {protoRealImg ? "开" : "关"}</button>
              )}
              <button className="amber-btn" style={{ marginLeft: fmt === "html_proto" ? 0 : "auto", padding: "10px 22px", fontSize: 13.5, fontFamily: "var(--mono)" }} disabled={producing || !model || (!discussion && !attachments.length)} onClick={() => produce(fmt, model)}>{producing ? "生成中…" : `⚡ 生成 ${fmName}`}</button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "18px 24px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
            <div className="label">本轮产物 · {artifacts.length}</div>
            {producing && (
              <div style={{ border: "1px solid var(--line)", borderRadius: 11, padding: "15px 17px", background: "rgba(255,255,255,.012)", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span className="breath" /><span style={{ fontSize: 13.5, color: "#E7ECF2" }}>{fmName} 生成中…</span>
                </div>
                <div className="gen" style={{ height: 9, borderRadius: 5, width: "92%" }} />
                <div className="gen" style={{ height: 9, borderRadius: 5, width: "76%" }} />
              </div>
            )}
            {artifacts.length === 0 && !producing && <div className="board-empty" style={{ margin: "auto", textAlign: "center", lineHeight: 1.8, maxWidth: 360 }}>{discussion ? "选个格式 + 模型,点「生成」出第一份交付物。" : "选格式 + 模型,在下方写要求或 📎 附素材,直接生成 —— 产出也能当独立工具用。"}</div>}
            {[...artifacts].reverse().map((a) => ccArtCard(a))}
          </div>
          <div style={{ flex: "0 0 auto", padding: "14px 24px 16px", borderTop: "1px solid var(--line)" }}>
            {attachments.length > 0 && (
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 8 }}>
                {attachments.map((a, i) => (
                  <span key={i} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, padding: "4px 9px", borderRadius: 7, border: "1px solid var(--line2)", background: "rgba(255,255,255,.03)", color: "var(--muted)" }}>
                    {a.kind === "image" ? "🖼" : "📄"} {a.name.length > 22 ? a.name.slice(0, 20) + "…" : a.name}
                    <span className="clk" onClick={() => removeAttach(i)} title="移除" style={{ color: "var(--faint)", fontSize: 12, lineHeight: 1 }}>×</span>
                  </span>
                ))}
              </div>
            )}
            <div className="ll-composer">
              <span className="mono" style={{ color: "var(--cyan)", fontSize: 14 }}>›</span>
              <textarea value={userInput} disabled={producing} rows={1} placeholder={discussion ? "补充生成要求 / 指定风格语气,让 AI 重新产出…" : "写要做什么 / 附素材 → 选格式+模型,直接生成(产出可独立用)…"}
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (model && !producing && (discussion || userInput.trim() || attachments.length)) { produce(fmt, model, undefined, userInput.trim() || undefined); setUserInput(""); } } }} />
              <input ref={fileRef} type="file" multiple accept="image/*,.txt,.md,.markdown,.json,.csv,.log,.yml,.yaml" style={{ display: "none" }} onChange={(e) => { addAttachFiles(e.target.files); e.currentTarget.value = ""; }} />
              <button className="ghost-chip" disabled={producing} title="附素材给 AI 参考(图片仿样 / 文档改写)" onClick={() => fileRef.current?.click()} style={{ padding: "7px 11px", fontSize: 14 }}>📎</button>
              {producing
                ? <button className="ghost-chip" title="停止当前生成(卡住时点这里,不用退出重进)" onClick={cancelRun} style={{ padding: "7px 13px", fontSize: 12.5, color: "var(--red)", borderColor: "var(--red)" }}>■ 停止</button>
                : <button className="amber-btn send-icon" disabled={!model || (!discussion && !userInput.trim() && !attachments.length)} onClick={() => { produce(fmt, model, undefined, userInput.trim() || undefined); setUserInput(""); }}>↑</button>}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 8, paddingLeft: 4 }}>📎 附素材直接产出(无需先走前几站) · 选格式+模型生成 · 卡片上点「改稿」 · ⌘/Ctrl+Enter</div>
          </div>
        </div>
        {/* 右:产物清单 / 导出 */}
        <div style={{ borderLeft: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center" }}>
            <span className="label">产物 · OUTPUTS</span><span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--cyan)" }}>{artifacts.length} 件</span>
          </div>
          <div style={{ padding: "16px 15px", overflow: "auto", display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: 11, textAlign: "center", background: "rgba(255,255,255,.015)" }}>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--green)" }}>{done}</div>
                <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginTop: 2 }}>已完成</div>
              </div>
              <div style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: 11, textAlign: "center", background: "rgba(255,255,255,.015)" }}>
                <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--cyan)" }}>{producing ? 1 : 0}</div>
                <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginTop: 2 }}>生成中</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="label">本条点子产物</div>
              {artifacts.length === 0 && <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>还没有产物</div>}
              {[...artifacts].reverse().map((a) => { const fm = (PRODUCE_FORMATS.find((f) => f.id === a.type) || (a.type === "code_sketch" ? { ic: "‹›", name: "代码草稿", c: "#8AA0FF" } : a.type === "critique" ? { ic: "🔍", name: "挑刺", c: "#FF8A6B" } : PRODUCE_FORMATS[1])); return (
                <div key={a.id} style={{ display: "flex", gap: 9, border: "1px solid var(--line)", borderRadius: 8, padding: "9px 10px", background: "rgba(255,255,255,.012)", alignItems: "center" }}>
                  <span style={{ flex: "0 0 auto", width: 22, height: 22, borderRadius: 6, display: "grid", placeItems: "center", fontSize: 11, color: fm.c, border: "1px solid " + fm.c + "44", background: fm.c + "14" }}>{fm.ic}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, color: "#D6DEE7", lineHeight: 1.35, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ARTIFACT_TYPE_LABEL[a.type]}</div>
                    <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginTop: 2 }}>{fm.name} · {a.provider}</div>
                  </div>
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--green)" }}>✓</span>
                </div>
              ); })}
            </div>
            <div style={{ border: "1px solid rgba(232,154,42,.35)", borderRadius: 9, padding: "11px 13px", background: "rgba(232,154,42,.06)" }}>
              <div className="mono" style={{ fontSize: 10, color: "#F2BF52", marginBottom: 5 }}>下一步建议</div>
              <div style={{ fontSize: 12, color: "#EEE3D2", lineHeight: 1.55 }}>{ccNextHint()}</div>
            </div>
          </div>
          <div style={{ flex: "0 0 auto", padding: "13px 15px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 9 }}>
            <button className="amber-btn" style={{ padding: 12, fontSize: 13.5, fontFamily: "var(--mono)" }} disabled={!artifacts.length} onClick={() => exportMarkdown({ title: `${discussion?.title || "Roast"} · 立项包`, conclusion: ccPackMd(), evidence: [] })}>打包为立项包 ↓</button>
            <div style={{ display: "flex", gap: 9 }}>
              <button className="ghost-chip" style={{ flex: 1, padding: 9, justifyContent: "center" }} disabled={!artifacts.length} onClick={() => exportDocx({ title: `${discussion?.title || "Roast"} · 立项包`, conclusion: ccPackMd(), evidence: [] })}>导出 DOCX</button>
              <button className="ghost-chip" style={{ flex: 1, padding: 9, justifyContent: "center" }} disabled={!artifacts.length} title={artifacts.length ? "复制本场所有产物为一份 Markdown" : "还没有产物 —— 先生成一个再复制"} onClick={() => copy(ccPackMd(), "已复制全部产物")}>复制全部</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ============ 议会 redesign:议程 / 署名观点审议 / 策展台 ============
  const YC_STANCE_CN: Record<string, string> = { Ship: "主张", Fix: "验证", Pause: "待定", Kill: "拷问" };
  const YC_MST: Record<string, { t: string; c: string; g: string }> = {
    claim: { t: "已认领", c: "var(--green)", g: "✓" }, reject: { t: "已否决", c: "var(--red)", g: "✕" },
    park: { t: "已搁置", c: "var(--faint)", g: "–" }, open: { t: "待裁决", c: "var(--cyan)", g: "•" },
  };
  // 议题(左栏):从议会综述派生 —— 共识→已认领,分歧/盲点→待裁
  const ycMotions = (): { id: string; t: string; state: string }[] => {
    const ms: { id: string; t: string; state: string }[] = [];
    (deliberation?.consensus || []).forEach((t, i) => ms.push({ id: "C" + i, t, state: "claim" }));
    (deliberation?.contradictions || []).forEach((t, i) => ms.push({ id: "X" + i, t, state: "open" }));
    (deliberation?.blindSpots || []).slice(0, 2).forEach((t, i) => ms.push({ id: "B" + i, t, state: "open" }));
    return ms;
  };
  const ycVerdicts = () => viewpoints.filter((v) => v.roleAngle !== "organizer" && v.roleAngle !== "chairman");
  const ycShown = () => {
    const vps = ycVerdicts();
    if (councilSel === "all") return vps;
    const m = ycMotions().find((x) => x.id === councilSel);
    if (!m) return vps;
    const words = m.t.replace(/[：:，。、（）()]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
    const hit = vps.filter((v) => words.some((w) => (v.text || "").includes(w)));
    return hit.length ? hit : vps;
  };
  const ycFlags = (v: Viewpoint): { t: string; hot: boolean }[] => {
    const f: { t: string; hot: boolean }[] = [];
    if (v.isHardestKill) f.push({ t: "🔴 不可静音的最硬 kill", hot: true });
    if (v.verification?.verdict === "overreach") f.push({ t: "⚠ 核查·论据过头", hot: false });
    else if (v.verification?.verdict === "unsupported") f.push({ t: "⚠ 核查·证据不足", hot: false });
    else if (v.verification?.verdict === "supported") f.push({ t: "✓ 核查·证据支持", hot: false });
    if (v.round === 3) f.push({ t: "R3 交叉质疑", hot: false });
    return f;
  };
  const ycChairHint = () => {
    const c = deliberation?.contradictions || [];
    if (c.length) return `反方提出 ${c.length} 条红线分歧,建议优先裁决这几条再收敛。`;
    if (deliberation?.blindSpots?.length) return `还有 ${deliberation.blindSpots.length} 个盲点未被覆盖,收敛前确认要不要补。`;
    return "观点已就位 —— 认领你要处理的、否决站不住的、其余搁置,再收敛成方案。";
  };
  const councilMinutesMd = () => {
    const L: string[] = [`# ${discussion?.title || "议会纪要"}`, "", "## 受审点子", brief || "(未填写)", ""];
    const v = ycVerdicts();
    const sec = (title: string, st: CurationStatus) => { const its = v.filter((x) => x.id && curation[x.id]?.status === st); if (its.length) { L.push(`## ${title}`); its.forEach((x) => L.push(`- **${x.seat}**(${ANGLE_LABEL[x.roleAngle] || x.roleAngle}):${x.text}`)); L.push(""); } };
    sec("认领 · 进方案", "endorse"); sec("否决 · 不采纳", "reject"); sec("搁置 · 待定", "setAside");
    if (deliberation?.contradictions?.length) { L.push("## 红线分歧"); deliberation.contradictions.forEach((c) => L.push(`- ${c}`)); L.push(""); }
    if (converged?.clarified) L.push("## 收敛方案", converged.clarified, "");
    return L.join("\n").trim();
  };
  const ycVerdictCard = (v: Viewpoint) => {
    const k = agentKey(v.seat); const a = AG[k]; const hot = v.stance === "Kill" || v.isHardestKill;
    const disp = (v.id && curation[v.id]?.status) || "none";
    const sc = v.stance ? STANCE_COLOR[v.stance] : "var(--cyan)";
    return (
      <div key={v.id} style={{ border: "1px solid " + (hot ? "rgba(255,93,110,.34)" : "var(--line)"), borderLeft: "2px solid " + a.c, borderRadius: 11, padding: "15px 17px", background: hot ? "rgba(255,93,110,.045)" : "rgba(255,255,255,.015)", display: "flex", flexDirection: "column", gap: 11, opacity: disp === "setAside" ? .55 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="agent-pill" style={{ color: a.c }}><span className="d" style={{ background: a.c }} />{v.seat}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{ANGLE_LABEL[v.roleAngle] || v.roleAngle}</span>
          {v.stance && <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 8px", borderRadius: 5, color: sc, border: "1px solid " + sc + "66", background: sc + "1a" }}>{YC_STANCE_CN[v.stance] || v.stance}</span>}
          <span className="mono" style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--faint)" }}>{disp !== "none" ? "已策展" : "你来策展 →"}</span>
        </div>
        <div style={{ fontSize: 13.5, color: "#D6E0EA", lineHeight: 1.62 }}>{v.text}</div>
        {(() => { const fl = ycFlags(v); return fl.length ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {fl.map((f, i) => <span key={i} className="mono" style={{ fontSize: 10, padding: "3px 9px", borderRadius: 6, color: f.hot ? "var(--red)" : "var(--muted)", border: "1px solid " + (f.hot ? "rgba(255,93,110,.4)" : "var(--line2)"), background: f.hot ? "rgba(255,93,110,.1)" : "transparent" }}>{f.t}</span>)}
          </div>
        ) : null; })()}
        <div style={{ display: "flex", gap: 8, paddingTop: 11, borderTop: "1px solid var(--line)", flexWrap: "wrap", alignItems: "center" }}>
          <button className={"act" + (disp === "endorse" ? " on-green" : "")} disabled={phase === "finalized" || !v.id} onClick={() => v.id && curate(v.id, "endorse")}>✓ 认领</button>
          <button className={"act" + (disp === "reject" ? " on-red" : "")} disabled={phase === "finalized" || !v.id} onClick={() => v.id && curate(v.id, "reject")}>✕ 否决</button>
          <button className={"act" + (disp === "setAside" ? " on-gray" : "")} disabled={phase === "finalized" || !v.id} onClick={() => v.id && curate(v.id, "setAside")}>– 搁置</button>
          <button className={"act" + (replyOpen === v.id ? " on-cyan" : "")} disabled={phase === "finalized" || !v.id} onClick={() => { setReplyOpen(replyOpen === v.id ? null : v.id!); setReplyText(""); }}>↳ 插一句</button>
        </div>
        {replyOpen === v.id && (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="yc-reply" value={replyText} autoFocus placeholder="插一句你的反驳 / 追问…" onChange={(e) => setReplyText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") replyTo(v.id!, replyText); }} />
            <button className="mbtn" onClick={() => replyTo(v.id!, replyText)}>记下</button>
          </div>
        )}
        {v.id && curation[v.id]?.replies?.map((r, i) => <div key={i} className="mono" style={{ fontSize: 11, color: "var(--cyan)", paddingLeft: 4 }}>↳ {r.note}</div>)}
      </div>
    );
  };
  // 议会分阶段进度条:立靶 → 反方开火 → 核查 → 主席(据 deliberate SSE 事件推进,不再笼统"审议中")
  const DELIB_STEPS = [
    { key: "organizer", cn: "立靶", sub: "主脑搭框架" },
    { key: "critics", cn: "反方开火", sub: "多家并行质疑" },
    { key: "verify", cn: "核查引用", sub: "证据校验" },
    { key: "chair", cn: "主席综述", sub: "共识 / 分歧 / 盲点" },
  ];
  const ycProgress = () => {
    if (!deliberating) return null;
    const cur = Math.max(0, DELIB_STEPS.findIndex((s) => s.key === delibPhase));
    return (
      <div style={{ display: "flex", gap: 10, border: "1px solid var(--cyan)", borderRadius: 10, padding: "12px 14px", background: "var(--cyan2)" }}>
        {DELIB_STEPS.map((s, i) => {
          const done = i < cur, active = i === cur;
          const col = done ? "var(--green)" : active ? "var(--cyan)" : "var(--faint)";
          return (
            <div key={s.key} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5, opacity: i <= cur ? 1 : 0.5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {active ? <span className="breath" /> : <span style={{ width: 8, height: 8, borderRadius: "50%", background: col, boxShadow: done ? "0 0 6px " + col : "none" }} />}
                <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: col }}>{done ? "✓ " : ""}{s.cn}</span>
              </div>
              <span className="mono" style={{ fontSize: 9, color: "var(--faint)", paddingLeft: 14 }}>{s.sub}</span>
              <div style={{ height: 2, borderRadius: 2, background: i <= cur ? col : "var(--line2)" }} />
            </div>
          );
        })}
      </div>
    );
  };
  const ycBody = () => {
    const motions = ycMotions();
    const verdicts = ycVerdicts();
    const shown = ycShown();
    const cn = (st: CurationStatus) => verdicts.filter((v) => v.id && curation[v.id]?.status === st).length;
    const openCount = verdicts.filter((v) => !v.id || !curation[v.id] || curation[v.id].status === "none").length;
    return (
      <div className="ll" style={{ gridTemplateColumns: "250px 1fr 318px" }}>
        {/* 左:议程 */}
        <div style={{ borderRight: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="label">议程 · MOTIONS</span><span className="mono" style={{ fontSize: 11, color: openCount ? "var(--cyan)" : "var(--green)" }}>{openCount ? openCount + " 待策展" : "已就绪"}</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: 14, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            {discussion && <div style={{ border: "1px solid var(--line2)", borderRadius: 10, padding: "12px 13px", background: "linear-gradient(180deg,rgba(72,220,255,.05),rgba(255,255,255,.01))" }}>
              <div className="label" style={{ marginBottom: 7 }}>受审点子</div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: "#D6DEE7" }}>{brief || "(未填写)"}</div>
            </div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {[{ id: "all", t: "全部议题", state: "open" }, ...motions].map((m) => {
                const s = YC_MST[m.state]; const active = councilSel === m.id;
                return (
                  <div key={m.id} onClick={() => setCouncilSel(m.id)} style={{ display: "flex", gap: 9, padding: "10px 11px", borderRadius: 9, cursor: "pointer", border: "1px solid " + (active ? "var(--cyan)" : "var(--line)"), background: active ? "var(--cyan2)" : "rgba(255,255,255,.012)" }}>
                    <span style={{ flex: "0 0 auto", width: 17, height: 17, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, marginTop: 1, color: s.c, border: "1px solid " + s.c + "66", background: s.c + "1a" }}>{s.g}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12.5, color: active ? "#E7ECF2" : "#C2CCD6", lineHeight: 1.4 }}>{m.t}</div>
                      {m.id !== "all" && <div className="mono" style={{ fontSize: 9, color: s.c, marginTop: 4, letterSpacing: ".5px" }}>{m.id} · {s.t}</div>}
                    </div>
                  </div>
                );
              })}
              {motions.length === 0 && <div className="mono" style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.6, paddingLeft: 2 }}>送进议会、审议综述出来后,这里会列出共识与分歧议题。</div>}
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {([["认领 " + cn("endorse"), "var(--green)"], ["否决 " + cn("reject"), "var(--red)"], ["搁置 " + cn("setAside"), "var(--faint)"]] as [string, string][]).map((x, i) => (
                <span key={i} className="mono" style={{ fontSize: 10, padding: "4px 9px", borderRadius: 6, color: x[1], border: "1px solid " + x[1] + "44" }}>{x[0]}</span>
              ))}
            </div>
          </div>
        </div>
        {/* 中:多 AI 审议 */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "13px 24px", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>议会 · 多 AI 审议</div>
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>主脑立靶 → 反方并行开火 → 红线=分歧 → 你来策展</span>
              <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--cyan)" }}>{shown.length} 条署名观点</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <span className="breath" /><span className="label">审议强度</span>
              <div className="seg">
                {(["council", "roast"] as CouncilIntensity[]).map((ci) => <button key={ci} className={councilIntensity === ci ? (ci === "roast" ? "onhot" : "on") : ""} disabled={busy || deliberating} onClick={() => setIntensity(ci)}>{ci === "council" ? "温和 · 综述" : "拷问 · 开火"}</button>)}
              </div>
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{councilIntensity === "roast" ? "反方强制开火 · R3 交叉质疑" : "多视角温和综述"}</span>
              <button className="amber-btn" style={{ marginLeft: "auto", padding: "9px 18px", fontSize: 13, fontFamily: "var(--mono)" }} disabled={!verdicts.length || busy || deliberating} onClick={doConverge}>送进产出 · 收敛成方案 →</button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "18px 24px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
            {ycProgress()}
            {verdicts.length === 0
              ? (deliberating
                ? <div className="board-empty" style={{ margin: "8px auto 0", textAlign: "center", color: "var(--faint)" }}>观点陆续就位中…</div>
                : <div className="board-empty" style={{ margin: "auto", textAlign: "center", lineHeight: 1.9, maxWidth: 400, display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>{discussion ? "点下方「送进议会」—— 多个 AI 署名开火,你来认领/否决/搁置。" : "先开一条点子(搜索/陪练),再送进议会。"}</div>
                    {discussion && <button className="amber-btn" style={{ alignSelf: "center", padding: "10px 22px", fontFamily: "var(--mono)" }} onClick={() => runCouncil()}>送进议会 →</button>}
                  </div>)
              : shown.map((v) => ycVerdictCard(v))}
          </div>
          <div style={{ flex: "0 0 auto", padding: "14px 24px 16px", borderTop: "1px solid var(--line)" }}>
            <div className="ll-composer">
              <span className="mono" style={{ color: "var(--cyan)", fontSize: 14 }}>›</span>
              <textarea value={userInput} disabled={deliberating || busy} rows={1} placeholder="追问某位 AI / 提出你的反驳,让议会再开一轮火…"
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (discussion && !deliberating) { runCouncil(councilIntensity, userInput.trim() || undefined); setUserInput(""); } } }} />
              {started && <span className="ghost-chip" onClick={reset}>＋新讨论</span>}
              {deliberating || busy
                ? <button className="ghost-chip" title="停止当前审议(卡住时点这里,不用退出重进)" onClick={cancelRun} style={{ padding: "7px 13px", fontSize: 12.5, color: "var(--red)", borderColor: "var(--red)" }}>■ 停止</button>
                : <button className="amber-btn send-icon" disabled={!discussion} onClick={() => { runCouncil(councilIntensity, userInput.trim() || undefined); setUserInput(""); }}>↑</button>}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 8, paddingLeft: 4 }}>温和=多视角综述;拷问=强制开火 + R3 交叉 · 点左栏议题可聚焦 · ⌘/Ctrl+Enter 提交</div>
          </div>
        </div>
        {/* 右:策展台 */}
        <div style={{ borderLeft: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center" }}>
            <span className="label">策展台 · CURATION</span><span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: openCount ? "var(--cyan)" : "var(--green)" }}>{openCount ? openCount + " 待策展" : "已就绪"}</span>
          </div>
          <div style={{ padding: "16px 15px", overflow: "auto", display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
            {([["认领 · 进方案", "var(--green)", "✓", "endorse", "把你认同的观点认领进最终方案。"], ["否决 · 不采纳", "var(--red)", "✕", "reject", "否决站不住或风险过高的观点。"], ["搁置 · 待定", "var(--faint)", "–", "setAside", "暂不决定的观点放这里。"]] as [string, string, string, CurationStatus, string][]).map(([title, c, g, st, empty]) => {
              const items = verdicts.filter((v) => v.id && curation[v.id]?.status === st);
              return (
                <div key={st} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 16, height: 16, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700, color: c, border: "1px solid " + c + "66", background: c + "1a" }}>{g}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#D6DEE7" }}>{title}</span>
                    <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--faint)" }}>{items.length}</span>
                  </div>
                  {items.length === 0 ? <div style={{ fontSize: 11.5, color: "var(--faint)", paddingLeft: 4, lineHeight: 1.5 }}>{empty}</div>
                    : <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                        {items.map((v) => { const k = agentKey(v.seat); return (
                          <div key={v.id} style={{ display: "flex", gap: 8, border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", background: "rgba(255,255,255,.02)" }}>
                            <span style={{ flex: "0 0 auto", width: 6, height: 6, borderRadius: 2, marginTop: 5, background: agentColor(k) }} />
                            <div style={{ minWidth: 0 }}>
                              <div className="mono" style={{ fontSize: 9, color: agentColor(k), marginBottom: 3 }}>{v.seat} · {ANGLE_LABEL[v.roleAngle] || v.roleAngle}</div>
                              <div style={{ fontSize: 11.5, color: "#CCD6E0", lineHeight: 1.4 }}>{(v.text || "").slice(0, 80)}{(v.text || "").length > 80 ? "…" : ""}</div>
                            </div>
                          </div>
                        ); })}
                      </div>}
                </div>
              );
            })}
            {verdicts.length > 0 && <div style={{ border: "1px solid rgba(232,154,42,.35)", borderRadius: 9, padding: "11px 13px", background: "rgba(232,154,42,.06)" }}>
              <div className="mono" style={{ fontSize: 10, color: "#F2BF52", marginBottom: 5 }}>主席提示</div>
              <div style={{ fontSize: 12, color: "#EEE3D2", lineHeight: 1.55 }}>{ycChairHint()}</div>
            </div>}
            {converged && <div style={{ border: "1px solid rgba(72,220,255,.3)", borderRadius: 9, padding: "11px 13px", background: "rgba(72,220,255,.05)" }}>
              <div className="mono" style={{ fontSize: 10, color: "var(--cyan)", marginBottom: 5 }}>已收敛</div>
              <div style={{ fontSize: 12, color: "#DCE6EF", lineHeight: 1.55 }}>{(converged.clarified || "").slice(0, 160)}</div>
            </div>}
          </div>
          <div style={{ flex: "0 0 auto", padding: "13px 15px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 9 }}>
            <button className="amber-btn" style={{ padding: 12, fontSize: 13.5, fontFamily: "var(--mono)" }} disabled={!verdicts.length || busy || deliberating} onClick={doConverge}>收敛成方案 → 产出</button>
            <button className="ghost-chip" style={{ padding: 10, justifyContent: "center", fontSize: 12 }} disabled={!verdicts.length} onClick={() => exportMarkdown({ title: `${discussion?.title || "Roast"} · 议会纪要`, conclusion: councilMinutesMd(), evidence: pack?.items || [] })}>导出议会纪要</button>
          </div>
        </div>
      </div>
    );
  };

  // ============ 自动档 Auto-Pilot ============
  const autoMdText = (md: AutoFields & { brief_original?: string }) =>
    [`# ${brief?.split("\n")[0]?.slice(0, 40) || "自动档草稿"}`, "", "## 一句话方向", md.direction || "", "", `## 待拍板(自动注议会)`, ...((md.open_questions || []).map((q) => "- " + q)), "", "## 建议产出", (md.artifacts_hint || []).join("、"), "", "## 原始点子", md.brief_original || brief || ""].join("\n");
  async function runAutoPilotRound(humanNote?: string, didOverride?: string): Promise<any> {
    if (autoBusy) return null;
    const did = didOverride || await ensureDiscussion(false, undefined, true);
    if (!did) return null;
    const t = ++token.current;
    setAutoBusy(true); setRunError("");
    const roundIndex = (autoRun?.rounds?.length || 0) + 1;
    setAutoLive({ roundIndex, taskOrder: null, lens: null, agents: [], fields: null, viewpoint: null, convergence: null, eval: null, done: false, humanNote: humanNote || null });
    let doneData: any = null, capped = false;
    try {
      await streamSSE(`/api/discussion/${did}/autopilot/round`, { humanNote: humanNote || undefined },
        (ev, d) => {
          if (cancelled(t)) return;
          if (ev === "task-order") setAutoLive((p: any) => ({ ...p, taskOrder: d.taskOrder, lens: d.lens, by: d.by }));
          else if (ev === "agent") setAutoLive((p: any) => ({ ...p, agents: [...(p?.agents || []), d] }));
          else if (ev === "fields") setAutoLive((p: any) => ({ ...p, fields: d.fields, viewpoint: d.viewpoint }));
          else if (ev === "convergence") setAutoLive((p: any) => ({ ...p, convergence: d }));
          else if (ev === "eval") setAutoLive((p: any) => ({ ...p, eval: d }));
          else if (ev === "round-done") { doneData = d; setAutoLive((p: any) => ({ ...p, done: true, roundDone: d })); }
          else if (ev === "capped") { capped = true; setRunError(`已达上限 ${d.maxRounds} 轮 —— 收当前最佳轮`); setAutoLive((p: any) => ({ ...p, done: true })); }
          else if (ev === "error") setRunError(d.error);
        }, () => cancelled(t));
      if (!cancelled(t)) {
        const r = await fetch(`/api/discussion/${did}`).then((x) => x.json()).catch(() => null);
        if (r?.discussion?.autoRun) setAutoRun(r.discussion.autoRun);
        setAutoNote("");
      }
    } catch (e) { if (!cancelled(t)) setRunError((e as Error).message); }
    finally { if (!cancelled(t)) setAutoBusy(false); }
    return cancelled(t) ? null : (capped ? { capped: true } : doneData);
  }
  // 自动连跑:跑一轮 → 若仍在 loop 且不该暂停(疑似复读 / 导演建议停 / 到顶)→ 隔 ~1.6s 续下一轮,期间用户可暂停/插话
  async function loopAuto(did: string, note?: string) {
    const done = await runAutoPilotRound(note, did);
    if (!done || !autoLoopRef.current) { setAutoLooping(false); autoLoopRef.current = false; return; }
    const pause = done.capped || done.repeatFlagged || done.stopRecommended || (done.roundIndex >= done.maxRounds);
    if (pause) { setAutoLooping(false); autoLoopRef.current = false; return; }
    await new Promise((r) => setTimeout(r, 1600));
    if (autoLoopRef.current) loopAuto(did);
  }
  async function startAutoPilot() {
    if (autoBusy || !brief.trim()) return;
    const did = await ensureDiscussion(true, brief.trim(), true); // 强制新讨论(新 idea,不读过往对话)
    if (!did) return;
    setAutoRun(null); setAutoLive(null); setAutoInjected(null);
    setAutoLooping(true); autoLoopRef.current = true;
    loopAuto(did);
  }
  function pauseAuto() { setAutoLooping(false); autoLoopRef.current = false; }
  function resumeAuto() { if (!discussion) return; setAutoLooping(true); autoLoopRef.current = true; loopAuto(discussion.id); }
  function newAutoIdea() { pauseAuto(); setAutoRun(null); setAutoLive(null); setAutoInjected(null); setAutoNote(""); setDiscussion(null); setBrief(""); }
  async function autoInject(target: "relay" | "council" | "produce") {
    if (!discussion) return;
    try {
      const r = await fetch(`/api/discussion/${discussion.id}/autopilot/inject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) }).then((x) => x.json());
      if (r.ok) { setAutoInjected(target); await loadDiscussion(discussion.id); switchTab(target); flash("✓ 已带成果注入「" + TAB_LABEL[target as Tab] + "」"); }
      else setRunError(r.missing ? "注入缺字段:" + r.missing.join("、") : (r.error || "注入失败"));
    } catch (e) { setRunError((e as Error).message); }
  }
  async function autoReset() {
    if (discussion) { try { await fetch(`/api/discussion/${discussion.id}/autopilot/reset`, { method: "POST" }); } catch {} }
    setAutoRun(null); setAutoLive(null); setAutoInjected(null); setAutoNote("");
  }
  const autoSpark = (rounds: AutoRound[]) => {
    const w = 224, h = 46, pad = 7;
    const xs = rounds.map((_, i) => pad + (rounds.length === 1 ? (w - 2 * pad) / 2 : i * (w - 2 * pad) / (rounds.length - 1)));
    const ys = rounds.map((r) => h - pad - ((Math.max(1, Math.min(5, r.eval?.spec_satisfaction || 1)) - 1) / 4) * (h - 2 * pad));
    const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
    return (
      <svg width={w} height={h} style={{ display: "block" }}>
        {rounds.length > 1 && <polyline points={pts} fill="none" stroke="var(--cyan)" strokeWidth="1.6" />}
        {xs.map((x, i) => <circle key={i} cx={x} cy={ys[i]} r={rounds[i].convergence?.repeat ? 3.6 : 2.6} fill={rounds[i].convergence?.repeat ? "var(--red)" : "var(--cyan)"} />)}
      </svg>
    );
  };
  const ROLE_CN: Record<string, string> = { direction: "方向", questions: "待拍板", evidence: "证据/分歧" };
  const acBody = () => {
    const rounds = autoRun?.rounds || [];
    const md = autoRun?.md;
    const stage: any = autoLive || (rounds.length ? { ...rounds[rounds.length - 1], done: true, roundIndex: rounds.length } : null);
    const fourFilled = !!(md?.direction && md?.open_questions?.length && md?.artifacts_hint?.length);
    return (
      <div className="ll" style={{ gridTemplateColumns: "256px 1fr 322px" }}>
        {/* 左:进度 + 收敛趋势 + 点子 */}
        <div style={{ borderRight: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}><span className="label">进度 · AUTO-PILOT</span></div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 15px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: "10px 8px", textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: "var(--cyan)", fontFamily: "var(--mono)" }}>{rounds.length}</div><div className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>已跑轮</div></div>
              <div style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 9, padding: "10px 8px", textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: "var(--green)", fontFamily: "var(--mono)" }}>{rounds.length ? (rounds[rounds.length - 1].eval?.spec_satisfaction ?? "–") : "–"}<span style={{ fontSize: 11, color: "var(--faint)" }}>/5</span></div><div className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>成稿度</div></div>
            </div>
            {rounds.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <span className="label">收敛趋势 · CONVERGENCE</span>
                <div style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "8px 6px", background: "rgba(255,255,255,.012)" }}>{autoSpark(rounds)}</div>
                <div className="mono" style={{ fontSize: 9.5, color: rounds[rounds.length - 1].convergence?.repeat ? "var(--red)" : "var(--faint)", lineHeight: 1.5 }}>{rounds[rounds.length - 1].convergence?.reason}</div>
              </div>
            )}
            {rounds.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="label">当前点子</span>
              <div style={{ fontSize: 12, color: "#C2CCD6", lineHeight: 1.55, border: "1px solid var(--line)", borderRadius: 8, padding: "10px 11px" }}>{brief}</div>
            </div>}
          </div>
        </div>
        {/* 中:workflow 舞台 */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
            <span className="label">⚡ 自动档舞台</span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>导演调度 · 三脑并行 · 反熵防复读 · 自动连跑(随时可打断)</span>
            {autoLooping && <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--cyan)", display: "inline-flex", alignItems: "center", gap: 5 }}><span className="breath" />自动连跑中</span>}
            {rounds.length > 0 && <button className="ghost-chip" style={{ marginLeft: autoLooping ? 8 : "auto", fontSize: 10 }} onClick={newAutoIdea}>↺ 新点子</button>}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
            {!stage && (
              <div style={{ margin: "auto", maxWidth: 540, display: "flex", flexDirection: "column", gap: 15, textAlign: "center" }}>
                <div className="board-empty" style={{ lineHeight: 1.9 }}>输入一个<b>模糊的新点子</b> → 自动档并行跑 <b>方向 / 待拍板 / 证据</b> 三路 + 导演调度 + 反熵防复读,<b>自动连跑</b>几轮出一份能带进站打磨的粗稿(你随时可暂停 / 插一句 / 够了收草稿)。</div>
                <textarea className="yc-reply" style={{ width: "100%", boxSizing: "border-box", flex: "none", minHeight: 92, resize: "vertical", lineHeight: 1.6, fontSize: 13.5 }} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="一个模糊的新点子…(例:一个帮播客创作者把长音频自动剪成短视频片段的工具)" autoFocus />
                <div><button className="amber-btn" style={{ padding: "12px 28px", fontSize: 14, fontFamily: "var(--mono)" }} disabled={autoBusy || !brief.trim()} onClick={startAutoPilot}>⚡ 开始自动档(自动连跑)</button></div>
              </div>
            )}
            {stage && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--cyan)" }}>ROUND {stage.roundIndex}</span>
                  {stage.lens && <span className="agent-pill" style={{ color: "#C9A6FF" }}><span className="d" style={{ background: "#C9A6FF" }} />透镜 · {stage.lens.name}</span>}
                  {stage.humanNote && <span className="mono" style={{ fontSize: 10, color: "#F2BF52" }}>↳ 你插了一句</span>}
                  {!stage.done && <span className="breath" style={{ marginLeft: "auto" }} />}
                </div>
                {stage.taskOrder ? <div style={{ border: "1px solid rgba(232,151,92,.3)", borderLeft: "2px solid var(--c-claude)", borderRadius: 9, background: "rgba(232,151,92,.05)", padding: "11px 13px" }}>
                  <div className="mono" style={{ fontSize: 9, color: "var(--c-claude)", marginBottom: 5 }}>导演 · 任务单{stage.by ? " · " + stage.by : ""}</div>
                  {stage.taskOrder.read && <div style={{ fontSize: 12.5, color: "#EEE3D2", lineHeight: 1.55, marginBottom: 6 }}>{stage.taskOrder.read}</div>}
                  {stage.taskOrder.focus && <div style={{ fontSize: 11.5, color: "var(--cyan)", lineHeight: 1.5 }}>▸ 本轮重点:{stage.taskOrder.focus}</div>}
                </div> : !stage.done && <div className="gen" style={{ height: 44, borderRadius: 9 }} />}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 11 }}>
                  {["direction", "questions", "evidence"].map((role) => {
                    const a: any = (stage.agents || []).find((x: any) => x.role === role);
                    const col = a ? agentColor(agentKey(a.model)) : "var(--faint)";
                    return (
                      <div key={role} style={{ border: "1px solid var(--line)", borderTop: "2px solid " + col, borderRadius: 9, padding: "10px 11px", minHeight: 84, background: "rgba(255,255,255,.012)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                          <span style={{ width: 6, height: 6, borderRadius: 2, background: col }} />
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: "#D6DEE7" }}>{ROLE_CN[role]}</span>
                          {role === "evidence" && stage.viewpoint?.dup && <span className="mono" title={"与历史观点近似(余弦 " + (stage.viewpoint.dupSim?.toFixed?.(2) ?? "") + ")—— 反熵 C 去重提示"} style={{ fontSize: 8.5, color: "var(--red)", border: "1px solid rgba(255,93,110,.4)", borderRadius: 4, padding: "1px 4px" }}>近似已说</span>}
                          {a && <span className="mono" style={{ marginLeft: "auto", fontSize: 9, color: col }}>{a.model}</span>}
                        </div>
                        {!a ? <div className="gen" style={{ height: 32, borderRadius: 6 }} />
                          : a.failed ? <div style={{ fontSize: 10.5, color: "var(--red)" }}>挂了:{(a.error || "").slice(0, 40)}</div>
                            : <div style={{ fontSize: 11, color: "#C2CCD6", lineHeight: 1.5 }}>
                                {role === "direction" && <span>{a.out?.direction}</span>}
                                {role === "questions" && <ul style={{ margin: 0, paddingLeft: 14 }}>{((a.out?.open_questions as string[]) || []).slice(0, 5).map((q, i) => <li key={i} style={{ marginBottom: 2 }}>{q}</li>)}</ul>}
                                {role === "evidence" && <span><b style={{ color: col }}>{a.out?.stance}</b> · {a.out?.text}</span>}
                              </div>}
                      </div>
                    );
                  })}
                </div>
                {stage.eval && <div style={{ display: "flex", gap: 11, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 200, border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px" }}>
                    <div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginBottom: 5 }}>导演评估 · 成稿度 {stage.eval.spec_satisfaction}/5</div>
                    <div style={{ fontSize: 11.5, color: "#C2CCD6", lineHeight: 1.5 }}>{stage.eval.reason}</div>
                    {(stage.eval.blind_spots || []).length > 0 && <div style={{ marginTop: 7, fontSize: 10.5, color: "#F2BF52", lineHeight: 1.5 }}>盲点(下轮专攻):{(stage.eval.blind_spots || []).join("、")}</div>}
                  </div>
                  {stage.convergence && <div style={{ flex: 1, minWidth: 200, border: "1px solid " + (stage.convergence.repeat ? "rgba(255,93,110,.4)" : "var(--line)"), borderRadius: 9, padding: "10px 12px", background: stage.convergence.repeat ? "rgba(255,93,110,.06)" : "transparent" }}>
                    <div className="mono" style={{ fontSize: 9, color: stage.convergence.repeat ? "var(--red)" : "var(--faint)", marginBottom: 5 }}>收敛判定 · L{stage.convergence.layer}{stage.convergence.sim != null ? " · 余弦 " + stage.convergence.sim.toFixed(3) : ""}</div>
                    <div style={{ fontSize: 11.5, color: stage.convergence.repeat ? "#ff8a93" : "#C2CCD6", lineHeight: 1.5 }}>{stage.convergence.reason}</div>
                    {stage.convergence.repeat && <div style={{ marginTop: 6, fontSize: 10.5, color: "#F2BF52" }}>⚠ 疑似复读 —— 建议插一句新角度,或「够了收草稿」</div>}
                  </div>}
                </div>}
              </>
            )}
            {rounds.length > 1 && <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span className="label">历史轮</span>
              {rounds.slice(0, -1).map((r) => <div key={r.index} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 7, padding: "6px 9px" }}>
                <span className="mono" style={{ color: "var(--faint)" }}>R{r.index}</span><span style={{ color: "#C9A6FF" }}>{r.lens?.name}</span><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.fields?.direction}</span><span className="mono" style={{ color: r.convergence?.repeat ? "var(--red)" : "var(--faint)" }}>{r.eval?.spec_satisfaction}/5</span>
              </div>)}
            </div>}
          </div>
          {rounds.length > 0 && (
            <div style={{ flex: "0 0 auto", padding: "12px 18px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 9 }}>
              {autoLooping ? (
                <button className="mbtn" style={{ justifyContent: "center", borderColor: "var(--cyan)", color: "var(--cyan)" }} onClick={pauseAuto}>⏸ 暂停自动(跑完这轮停)</button>
              ) : (
                <>
                  <textarea className="yc-reply" style={{ width: "100%", boxSizing: "border-box", flex: "none", minHeight: 44, resize: "vertical", lineHeight: 1.5 }} value={autoNote} onChange={(e) => setAutoNote(e.target.value)} placeholder="插一句:喂个新角度 / 纠正理解(人是最强反熵)—— 留空则只是继续自动" disabled={autoBusy} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="mbtn" style={{ flex: 1, justifyContent: "center" }} disabled={autoBusy} onClick={() => { const n = autoNote.trim(); if (discussion) { setAutoLooping(true); autoLoopRef.current = true; loopAuto(discussion.id, n || undefined); } }}>{autoBusy ? "跑这一轮中…" : autoNote.trim() ? "↳ 带这句续跑(恢复自动)" : "▶ 继续自动"}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {/* 右:MD 粗稿 + 分发 */}
        <div style={{ borderLeft: "1px solid var(--line)", background: "var(--panel)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="label">MD 粗稿 · DRAFT</span>
            {md && <span className="ghost-chip" style={{ marginLeft: "auto", fontSize: 10 }} onClick={() => copy(autoMdText(md), "已复制草稿")}>⧉ 复制</span>}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "15px", display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
            {!md ? <div style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.6 }}>跑起来后这里实时长出四个强字段:一句话方向 / 待拍板 / 建议产出 / 原始点子。攒够了注入某站继续细化。</div>
              : <>
                <div style={{ border: "1px solid rgba(72,220,255,.3)", borderTop: "2px solid var(--cyan)", borderRadius: 9, padding: "11px 13px", background: "rgba(72,220,255,.05)" }}><div className="mono" style={{ fontSize: 9, color: "var(--cyan)", marginBottom: 4 }}>一句话方向</div><div style={{ fontSize: 13, color: "#E6EEF6", lineHeight: 1.5, fontWeight: 600 }}>{md.direction || "(待生成)"}</div></div>
                <div><div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginBottom: 5 }}>待拍板(自动注议会)· {md.open_questions?.length || 0}</div><ul style={{ margin: 0, paddingLeft: 15, display: "flex", flexDirection: "column", gap: 4 }}>{(md.open_questions || []).map((q, i) => <li key={i} style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>{q}</li>)}</ul></div>
                <div><div className="mono" style={{ fontSize: 9, color: "var(--faint)", marginBottom: 5 }}>建议产出</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{(md.artifacts_hint || []).map((h, i) => <span key={i} className="agent-pill" style={{ color: "var(--green)" }}>{h}</span>)}</div></div>
              </>}
          </div>
          <div style={{ flex: "0 0 auto", padding: "13px 15px", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 9 }}>
            {autoInjected && <div className="mono" style={{ fontSize: 10, color: "var(--green)" }}>✓ 已注入 {TAB_LABEL[autoInjected as Tab]} · <span className="clk" style={{ color: "var(--cyan)" }} onClick={async () => { if (discussion) { await fetch(`/api/discussion/${discussion.id}/autopilot/restore`, { method: "POST" }); await loadDiscussion(discussion.id); setAutoInjected(null); } }}>一键还原</span></div>}
            <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)" }}>{fourFilled ? "四强字段齐 → 注入任意站继续打磨:" : "再跑一两轮把字段攒齐,即可注入。"}</div>
            <div style={{ display: "flex", gap: 7 }}>
              <button className="mbtn" style={{ flex: 1, justifyContent: "center" }} disabled={!md?.direction || autoBusy} onClick={() => autoInject("relay")}>陪练</button>
              <button className="mbtn" style={{ flex: 1, justifyContent: "center" }} disabled={!md?.open_questions?.length || autoBusy} onClick={() => autoInject("council")} title="需待拍板≥1">议会</button>
              <button className="amber-btn" style={{ flex: 1.2, padding: "9px 10px", fontFamily: "var(--mono)", fontSize: 12.5, justifyContent: "center" }} disabled={!md?.direction || autoBusy} onClick={() => autoInject("produce")}>产出 →</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      {topChrome()}
      {tab === "relay" ? llBody()
        : tab === "search" ? ssBody()
        : tab === "produce" ? ccBody()
        : tab === "auto" ? acBody()
        : tab === "council" ? ycBody()
        : <div className="grid work">
            {conversationCol()}
            <div className="col center">{centerCol()}</div>
            {rightCol()}
          </div>}

      {runError && <div className="err">出错:{runError.length > 200 ? runError.slice(0, 200) + "…" : runError}</div>}

      {flashMsg && <div className="flash-toast">{flashMsg}</div>}
      {confirmBox && (
        <div className="confirm-overlay" onClick={() => setConfirmBox(null)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <h4>{confirmBox.title}</h4>
            {confirmBox.body && <p>{confirmBox.body}</p>}
            <div className="row">
              <button className="ghost-chip" style={{ padding: "8px 16px" }} onClick={() => setConfirmBox(null)}>取消</button>
              <button className="amber-btn" style={{ padding: "8px 18px", ...(confirmBox.danger ? { background: "var(--red)", borderColor: "var(--red)", color: "#fff" } : {}) }} onClick={() => { const f = confirmBox.onYes; setConfirmBox(null); f(); }}>{confirmBox.yesLabel || "确认"}</button>
            </div>
          </div>
        </div>
      )}

      {tab !== "relay" && tab !== "search" && tab !== "produce" && tab !== "council" && tab !== "auto" && composerBar()}
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
      {showLibrary && (
        <div className="hist-overlay" onClick={() => setShowLibrary(false)}>
          <div className="hist-panel" onClick={(e) => e.stopPropagation()}>
            <div className="hist-head">
              <span>我的交付物 · {library.length}</span>
              <button className="hist-close" onClick={() => setShowLibrary(false)} title="关闭">×</button>
            </div>
            <div className="hist-list">
              {library.length === 0 && <div className="hist-empty">还没有产出过交付物 —— 去「产出」站生成一份</div>}
              {library.map((a) => {
                const fm = PRODUCE_FORMATS.find((f) => f.id === a.type);
                return (
                  <div className="hist-item" key={a.id}>
                    <div className="hist-item-main" style={{ minWidth: 0 }}>
                      <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: fm?.c || "#9fd6ea", border: "1px solid " + ((fm?.c || "#7e97b3") + "55"), borderRadius: 5, padding: "2px 7px", flex: "0 0 auto" }}>{ARTIFACT_TYPE_LABEL[a.type]}</span>
                      <span className="hist-title" title={a.discussionTitle}>{a.discussionTitle || "(无标题点子)"}</span>
                    </div>
                    <div className="hist-item-meta" style={{ gap: 9 }}>
                      <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{a.provider}</span>
                      <span className="hist-date">{fmtDate(a.createdAt || "")}</span>
                      {a.type === "image"
                        ? <button className="hist-del" style={{ color: "var(--cyan)" }} title="下载图" onClick={() => downloadArtifactImage(a)}>↓</button>
                        : a.type === "html_proto"
                        ? <button className="hist-del" style={{ color: "var(--cyan)" }} title="下载 HTML" onClick={() => downloadHtml(a)}>↓</button>
                        : <button className="hist-del" style={{ color: "var(--cyan)" }} title="导出 MD" onClick={() => exportArtifact(a, "md")}>↓</button>}
                      <button className="hist-del" style={{ color: "var(--green)" }} title="打开这条点子的产出站" onClick={() => { setShowLibrary(false); loadDiscussion(a.discussionId).then(() => switchTab("produce")); }}>↗</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {previewArt && (
        <div className="hist-overlay" onClick={() => setPreviewArt(null)}>
          <div className="hist-panel" style={{ width: "min(1120px, 95vw)", height: "92vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
            <div className="hist-head">
              <span>HTML 原型预览 · {previewArt.provider}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button className="mbtn" onClick={() => downloadHtml(previewArt)}>↓ 下载 HTML</button>
                <button className="hist-close" onClick={() => setPreviewArt(null)} title="关闭">×</button>
              </div>
            </div>
            <iframe srcDoc={htmlOf(previewArt.content)} sandbox="allow-scripts" title="HTML 原型放大预览" style={{ flex: 1, width: "100%", border: "none", borderRadius: "0 0 12px 12px", background: "#fff", minHeight: 0 }} />
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

// 错误边界:渲染崩溃时显示提示 + 刷新,而不是整页黑屏。
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  constructor(props: { children: React.ReactNode }) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error("[roast] 渲染崩溃:", err); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, color: "#d8e3ee", fontFamily: "var(--sans)", padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 16 }}>页面渲染出错了</div>
          <div style={{ fontSize: 13, color: "#93a8bf", maxWidth: 460 }}>{this.state.err.message}</div>
          <button style={{ padding: "9px 20px", borderRadius: 10, border: "1px solid #1c5170", background: "#0c1a2e", color: "#48dcff", cursor: "pointer", fontSize: 14 }} onClick={() => location.reload()}>刷新重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// 门控:邮箱魔法链接登录(/api/me 判会话)。点链接 → 后端发 cookie + 302 回 /?welcome=1 → 这里判已登录进台。
function Root() {
  const [me, setMe] = useState<{ email: string } | null | "loading">("loading");
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => {
        setMe(d.user || null);
        if (d.user && new URLSearchParams(location.search).get("welcome") === "1") {
          speakWelcome();
          history.replaceState(null, "", location.pathname); // 清掉 ?welcome,避免刷新重播
        }
      })
      .catch(() => setMe(null));
  }, []);
  if (me === "loading") return <div className="boot" />;
  if (!me) return <Landing />;
  return <App />;
}

// HMR 守卫:复用同一个 root,避免热重载反复 createRoot 报警(仅开发期噪音)。
const container = document.getElementById("root")! as HTMLElement & { _root?: ReturnType<typeof createRoot> };
const root = container._root ?? (container._root = createRoot(container));
root.render(<ErrorBoundary><Root /></ErrorBoundary>);
