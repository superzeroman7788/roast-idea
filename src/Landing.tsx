import React, { useState } from "react";

// 启动页:全屏嵌入 JARVIS 发布动画(public/launch/)+ 邮箱魔法链接登录门(邀请制,无密码)。
export function Landing() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<null | "email" | "log">(null);
  const [err, setErr] = useState("");

  async function send() {
    const e = email.trim();
    if (busy) return;
    if (!e.includes("@")) { setErr("请填写有效邮箱"); return; }
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e }),
      });
      const d = await res.json();
      if (d.ok && d.via === "direct") { window.location.href = "/?welcome=1"; return; } // 直登:名单内 → 直接进台
      if (d.ok) setSent(d.via === "email" ? "email" : "log");
      else setErr(d.error || "发起失败,稍后再试");
    } catch {
      setErr("网络错误,稍后再试");
    } finally {
      setBusy(false);
    }
  }

  const expired = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("auth") === "expired";

  return (
    <div className="landing">
      <iframe className="land-video" src="/launch/launch.html" title="ROAST · 点子陪练" tabIndex={-1} />
      <div className="land-overlay">
        {sent ? (
          <div className="land-sent">
            {sent === "email"
              ? <>登录链接已发到 <b>{email}</b> —— 查收邮箱,点链接进入。</>
              : <>已为 <b>{email}</b> 生成登录链接(邀请制)—— 找站长要你的专属链接即可进入。</>}
            <button className="land-resend" onClick={() => { setSent(null); setEmail(""); }}>换个邮箱</button>
          </div>
        ) : (
          <div className="land-gate">
            <input type="email" value={email} placeholder="你的邮箱(受邀)" autoFocus inputMode="email" autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
            <button onClick={send} disabled={busy || !email.trim()}>{busy ? "…" : "登录 →"}</button>
          </div>
        )}
        {(err || expired) && <div className="land-err">{err || "链接已过期,重新获取一个"}</div>}
      </div>
    </div>
  );
}
