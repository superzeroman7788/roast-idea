import React, { useState } from "react";

// 启动/落地页(内部分发软门)。忠实重建 roast-idea Launch Video 的 JARVIS 风格:
// 深空蓝 + 同心环 + 旋转虚线 + 反应堆核心 + 顾问节点点亮 + wordmark + CTA/密码门。
// 文案对齐新产品(陪练/辩论),不再是旧的"裁决拷问"。

const ADVISORS = [
  { label: "主持", color: "#34e1ff" },
  { label: "建设者", color: "#46e6a0" },
  { label: "需求", color: "#ffb44d" },
  { label: "可行性", color: "#c9a0ff" },
  { label: "魔鬼代言人", color: "#ff5c6a" },
];

const C = 200;
const R = 150;

export function Landing({
  authRequired,
  onUnlock,
}: {
  authRequired: boolean;
  onUnlock: () => void;
}) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function enter() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const d = await res.json();
      if (d.ok) onUnlock();
      else setErr("密码不对,问发给你链接的人");
    } catch {
      setErr("网络错误,稍后再试");
    } finally {
      setBusy(false);
    }
  }

  const nodes = ADVISORS.map((a, i) => {
    const ang = ((-90 + i * 72) * Math.PI) / 180;
    return { ...a, x: C + R * Math.cos(ang), y: C + R * Math.sin(ang), delay: 0.6 + i * 0.32 };
  });

  return (
    <div className="landing">
      <div className="land-hud">
        <svg viewBox="0 0 400 400" className="land-svg">
          <g fill="none">
            <circle cx={C} cy={C} r="186" stroke="#16324d" />
            <circle cx={C} cy={C} r="150" stroke="#13283e" />
            <circle cx={C} cy={C} r="96" stroke="#12253a" />
          </g>
          <circle className="spin" style={{ transformOrigin: "200px 200px" }} cx={C} cy={C} r="186"
            fill="none" stroke="#34e1ff" strokeWidth="1" strokeDasharray="2 16" opacity=".5" />
          <circle className="spin-r" style={{ transformOrigin: "200px 200px" }} cx={C} cy={C} r="150"
            fill="none" stroke="#34e1ff" strokeWidth="1" strokeDasharray="1 22" opacity=".4" />
          <g stroke="#34e1ff22" strokeWidth="1">
            <line x1="24" y1="200" x2="376" y2="200" /><line x1="200" y1="24" x2="200" y2="376" />
          </g>
          <g stroke="#2a4a6a" strokeWidth="1">
            <line x1="200" y1="14" x2="200" y2="26" /><line x1="200" y1="374" x2="200" y2="386" />
            <line x1="14" y1="200" x2="26" y2="200" /><line x1="374" y1="200" x2="386" y2="200" />
          </g>
          {nodes.map((n, i) => (
            <g key={i} className="land-adv" style={{ animationDelay: `${n.delay}s` }}>
              <line x1={C} y1={C} x2={n.x} y2={n.y} stroke={n.color} strokeWidth="1" opacity=".4" />
              <circle cx={n.x} cy={n.y} r="9" fill="#0c2536" stroke={n.color} strokeWidth="1.6"
                style={{ filter: `drop-shadow(0 0 8px ${n.color})` }} />
              <text x={n.x} y={n.y < C ? n.y - 16 : n.y + 24} textAnchor="middle"
                fontFamily="Share Tech Mono, ui-monospace, monospace" fontSize="10" fill={n.color}>{n.label}</text>
            </g>
          ))}
          <circle className="core" cx={C} cy={C} r="20" fill="#34e1ff" opacity=".9"
            style={{ filter: "drop-shadow(0 0 22px #34e1ff)" }} />
          <circle cx={C} cy={C} r="10" fill="#dffaff" />
        </svg>
      </div>

      <div className="land-mark">ROAST</div>
      <div className="land-sub">SPARRING COUNCIL · 点子陪练</div>
      <div className="land-tag">和多个不同厂商的 AI 一起,把你的点子或文案,辩成更好的方案。</div>

      {authRequired ? (
        <div className="land-gate">
          <input type="password" value={pw} placeholder="访问密码" autoFocus
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") enter(); }} />
          <button onClick={enter} disabled={busy || !pw}>{busy ? "…" : "进入 →"}</button>
        </div>
      ) : (
        <button className="land-enter" onClick={onUnlock}>进入 →</button>
      )}
      {err && <div className="land-err">{err}</div>}

      <div className="corner c-tl" /><div className="corner c-tr" />
      <div className="corner c-bl" /><div className="corner c-br" />
    </div>
  );
}
