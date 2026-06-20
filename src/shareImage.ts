// 生成带 receipts 的分享图(P3 分发护城河):裁决 + 各模型名/stance + 引用证据 + 有效率。
// 纯 canvas,无依赖,导出 PNG。所有内容来自真实 report,不写死。
import { CouncilReport } from "./roastEngine";

const STANCE: Record<string, string> = {
  Kill: "#ff5c6a",
  Fix: "#ffb44d",
  Ship: "#46e6a0",
  Pause: "#1b9fc4",
};
const MONO = '12px ui-monospace, Menlo, monospace';

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last.length && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

export function exportShareImage(brief: string, report: CouncilReport, dateLabel: string) {
  const W = 1000, H = 640, S = 2;
  const canvas = document.createElement("canvas");
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(S, S);

  // 背景(深空蓝 HUD)
  const g = ctx.createRadialGradient(W / 2, 220, 80, W / 2, 220, 800);
  g.addColorStop(0, "#0a1326");
  g.addColorStop(0.6, "#060a14");
  g.addColorStop(1, "#03060d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#16314e";
  ctx.lineWidth = 1;
  ctx.strokeRect(10.5, 10.5, W - 21, H - 21);

  // 标题
  ctx.textBaseline = "alphabetic";
  ctx.font = '600 22px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#34e1ff";
  ctx.fillText("ROAST", 40, 58);
  ctx.fillStyle = "#5f7a98";
  ctx.font = '20px ui-monospace, Menlo, monospace';
  ctx.fillText("· DECISION COUNCIL", 122, 58);
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#52688a";
  ctx.fillText("CROSS-VENDOR · EVIDENCE-GROUNDED · CITED RECEIPTS", 40, 80);

  // 点子
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#52688a";
  ctx.fillText("IDEA", 40, 118);
  ctx.font = '15px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = "#dcecf6";
  wrapLines(ctx, brief, W - 80, 2).forEach((l, i) => ctx.fillText(l, 40, 140 + i * 22));

  // 裁决
  const verdict = report.verdict || "—";
  const vColor = /kill/i.test(verdict) ? "#ff5c6a" : /pause/i.test(verdict) ? "#ffb44d" : /ship/i.test(verdict) ? "#46e6a0" : "#34e1ff";
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#52688a";
  ctx.fillText("VERDICT", 40, 212);
  ctx.font = '600 34px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = vColor;
  ctx.fillText(verdict, 40, 250);

  // 议会席位
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#52688a";
  ctx.fillText("COUNCIL (cross-vendor)", 40, 300);
  let y = 326;
  for (const m of report.panel || []) {
    const isDevil = m.roleAngle === "devils-advocate";
    const c = STANCE[m.stance] || (m.stance === "Failed" ? "#6a7891" : "#34e1ff");
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(48, y - 4, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '13px ui-monospace, Menlo, monospace';
    ctx.fillStyle = isDevil ? "#ff9aa3" : "#9fb4c8";
    const name = isDevil ? `${m.provider} (Devil's Advocate)` : m.provider;
    ctx.fillText(name, 62, y);
    ctx.fillStyle = c;
    ctx.textAlign = "right";
    ctx.fillText((m.stance || "").toUpperCase(), 470, y);
    ctx.textAlign = "left";
    y += 26;
    if (y > 470) break;
  }

  // receipts(引用证据)
  const items = report.evidence?.items || [];
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#52688a";
  ctx.fillText("RECEIPTS — real cited sources", 520, 300);
  let ry = 326;
  for (const it of items.slice(0, 6)) {
    ctx.fillStyle = "#ffb44d";
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillText(`${it.id} [${it.source}]`, 520, ry);
    ctx.fillStyle = "#9fb4c8";
    ctx.font = '12px -apple-system, system-ui, sans-serif';
    wrapLines(ctx, it.title || it.url, W - 600, 1).forEach((l) => ctx.fillText(l, 588, ry));
    ry += 22;
    if (ry > 470) break;
  }
  if (!items.length) {
    ctx.fillStyle = "#52688a";
    ctx.font = MONO;
    ctx.fillText("(no evidence retrieved / redacted)", 520, 326);
  }

  // 底栏:有效引用率 + 参与 + 日期
  const cit = report.citations;
  const live = report.live;
  ctx.strokeStyle = "#122742";
  ctx.beginPath();
  ctx.moveTo(40, 560);
  ctx.lineTo(W - 40, 560);
  ctx.stroke();
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#7f97b0";
  const bits: string[] = [];
  if (live) bits.push(`${live.providerCount} live vendors`);
  if (cit && cit.rate != null) bits.push(`${cit.rate}% valid citations`);
  if (report.dissentLevel) bits.push(`dissent: ${report.dissentLevel}`);
  ctx.fillText(bits.join("   ·   "), 40, 592);
  ctx.textAlign = "right";
  ctx.fillStyle = "#52688a";
  ctx.fillText(`Roast My Idea · ${dateLabel}`, W - 40, 592);
  ctx.textAlign = "left";

  // 下载
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `roast-council-${Date.now()}.png`;
  a.click();
}
