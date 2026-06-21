import React, { useState } from "react";

// 启动页:全屏嵌入原版 JARVIS 发布动画(public/launch/,作者原文件,100% 复刻),
// 密码门浮在底部。动画自动播放 + 23s 循环、无预览控件。
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

  return (
    <div className="landing">
      <iframe className="land-video" src="/launch/launch.html" title="ROAST · 点子陪练" tabIndex={-1} />
      <div className="land-overlay">
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
      </div>
    </div>
  );
}
