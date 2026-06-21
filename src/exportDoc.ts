// 多格式导出(讨论重构 P4):把"打磨后的方案"导成 MD / 图片 / Word / PPT。
// docx 与 pptxgenjs 用动态 import,不进主包;MD/PNG 零依赖。内容全来自真实讨论。
import { EvidenceItem } from "./discussion";

export type ExportPayload = {
  title: string;
  conclusion: string; // markdown
  evidence: EvidenceItem[];
};

function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

type Section = { h: string; paras: string[]; items: string[] };
function parseSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { h: "", paras: [], items: [] };
  const push = () => {
    if (cur.h || cur.paras.length || cur.items.length) out.push(cur);
  };
  for (const ln of (md || "").split("\n")) {
    const t = ln.trim();
    if (/^#{1,3}\s/.test(t)) {
      push();
      cur = { h: t.replace(/^#{1,3}\s/, ""), paras: [], items: [] };
    } else if (/^[-*]\s/.test(t)) cur.items.push(t.replace(/^[-*]\s/, ""));
    else if (/^\d+\.\s/.test(t)) cur.items.push(t.replace(/^\d+\.\s/, ""));
    else if (t) cur.paras.push(t);
  }
  push();
  return out;
}

// ---- Markdown(零依赖)----
export function exportMarkdown(p: ExportPayload) {
  const ev = p.evidence?.length
    ? "\n\n## 引用证据\n" + p.evidence.map((e) => `- ${e.id} [${e.source}] ${e.title} — ${e.url}`).join("\n")
    : "";
  const md = `# ${p.title}\n\n> 由 ROAST 点子陪练(多 agent 讨论)打磨\n\n${p.conclusion}${ev}\n`;
  download(new Blob([md], { type: "text/markdown;charset=utf-8" }), `roast-${stamp()}.md`);
}

// ---- PNG(canvas,JARVIS 卡片)----
export function exportPng(p: ExportPayload) {
  const W = 1000, H = 720, S = 2;
  const cv = document.createElement("canvas");
  cv.width = W * S;
  cv.height = H * S;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.scale(S, S);
  const g = ctx.createRadialGradient(W / 2, 240, 80, W / 2, 240, 820);
  g.addColorStop(0, "#0a1326");
  g.addColorStop(0.6, "#060a14");
  g.addColorStop(1, "#03060d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#16314e";
  ctx.strokeRect(10.5, 10.5, W - 21, H - 21);

  ctx.font = '600 22px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#34e1ff";
  ctx.fillText("ROAST", 40, 56);
  ctx.fillStyle = "#5f7a98";
  ctx.font = '20px ui-monospace, Menlo, monospace';
  ctx.fillText("· 点子陪练 · 打磨后的方案", 122, 56);

  ctx.font = '600 26px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = "#dcecf6";
  wrap(ctx, p.title, 40, 96, W - 80, 30, 2);

  let y = 160;
  for (const s of parseSections(p.conclusion)) {
    if (y > H - 80) break;
    if (s.h) {
      ctx.font = '600 16px -apple-system, system-ui, sans-serif';
      ctx.fillStyle = "#46e6a0";
      ctx.fillText(s.h, 40, y);
      y += 24;
    }
    ctx.font = '14px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = "#cfe0ee";
    for (const para of s.paras) {
      y = wrap(ctx, para, 40, y, W - 80, 20, 3) + 6;
      if (y > H - 80) break;
    }
    for (const it of s.items) {
      ctx.fillStyle = "#34e1ff";
      ctx.fillText("•", 44, y);
      ctx.fillStyle = "#cfe0ee";
      y = wrap(ctx, it, 60, y, W - 100, 20, 2) + 4;
      if (y > H - 80) break;
    }
    y += 8;
  }

  ctx.strokeStyle = "#122742";
  ctx.beginPath();
  ctx.moveTo(40, H - 56);
  ctx.lineTo(W - 40, H - 56);
  ctx.stroke();
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.fillStyle = "#7f97b0";
  const sources = [...new Set((p.evidence || []).map((e) => e.source))];
  ctx.fillText(
    `多 agent 讨论打磨 · 证据 ${p.evidence?.length || 0} 条${sources.length ? " · " + sources.join("/") : ""}`,
    40,
    H - 32,
  );

  cv.toBlob((b) => b && download(b, `roast-${stamp()}.png`), "image/png");
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines: number): number {
  const words = String(text || "").split(/(\s+)/);
  let line = "";
  let lines = 0;
  for (const w of words) {
    const test = line + w;
    if (ctx.measureText(test).width > maxW && line.trim()) {
      ctx.fillText(line.trim(), x, y);
      y += lh;
      lines++;
      line = w.trim() ? w : "";
      if (lines >= maxLines) {
        return y;
      }
    } else line = test;
  }
  if (line.trim()) {
    ctx.fillText(line.trim(), x, y);
    y += lh;
  }
  return y;
}

// ---- Word(.docx,动态 import)----
export async function exportDocx(p: ExportPayload) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const children: any[] = [
    new Paragraph({ text: p.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: "由 ROAST 点子陪练(多 agent 讨论)打磨", italics: true, color: "7F97B0" })] }),
  ];
  for (const s of parseSections(p.conclusion)) {
    if (s.h) children.push(new Paragraph({ text: s.h, heading: HeadingLevel.HEADING_2 }));
    for (const para of s.paras) children.push(new Paragraph({ children: [new TextRun(para)] }));
    for (const it of s.items) children.push(new Paragraph({ text: it, bullet: { level: 0 } }));
  }
  if (p.evidence?.length) {
    children.push(new Paragraph({ text: "引用证据", heading: HeadingLevel.HEADING_2 }));
    for (const e of p.evidence)
      children.push(new Paragraph({ text: `${e.id} [${e.source}] ${e.title} — ${e.url}`, bullet: { level: 0 } }));
  }
  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  download(blob, `roast-${stamp()}.docx`);
}

// ---- PPT(.pptx,动态 import)----
export async function exportPptx(p: ExportPayload) {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 10, height: 5.625 });
  pptx.layout = "WIDE";

  const title = pptx.addSlide();
  title.background = { color: "04070E" };
  title.addText("ROAST", { x: 0.5, y: 1.7, w: 9, h: 0.8, fontSize: 40, color: "34E1FF", bold: true, align: "center" });
  title.addText(p.title, { x: 0.8, y: 2.7, w: 8.4, h: 1.2, fontSize: 22, color: "DCECF6", align: "center" });
  title.addText("点子陪练 · 多 agent 讨论打磨后的方案", { x: 0.5, y: 4.1, w: 9, h: 0.5, fontSize: 13, color: "7F97B0", align: "center" });

  for (const s of parseSections(p.conclusion)) {
    const sl = pptx.addSlide();
    sl.background = { color: "070C18" };
    sl.addText(s.h || "方案", { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, color: "34E1FF", bold: true });
    const body = [
      ...s.paras.map((t) => ({ text: t, options: { fontSize: 16, color: "DCECF6", paraSpaceAfter: 8 } })),
      ...s.items.map((t) => ({ text: t, options: { bullet: true, fontSize: 16, color: "DCECF6", paraSpaceAfter: 6 } })),
    ];
    if (body.length) sl.addText(body as any, { x: 0.6, y: 1.4, w: 8.8, h: 3.9, valign: "top" });
  }

  if (p.evidence?.length) {
    const ev = pptx.addSlide();
    ev.background = { color: "070C18" };
    ev.addText("引用证据 · receipts", { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 22, color: "FFB44D", bold: true });
    ev.addText(
      p.evidence.slice(0, 10).map((e) => ({ text: `${e.id} [${e.source}] ${e.title}`, options: { bullet: true, fontSize: 13, color: "9FB4C8", paraSpaceAfter: 6 } })) as any,
      { x: 0.6, y: 1.4, w: 8.8, h: 3.9, valign: "top" },
    );
  }

  await pptx.writeFile({ fileName: `roast-${stamp()}.pptx` });
}
