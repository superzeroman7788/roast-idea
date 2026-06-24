// 证据检索层 — 雷达(HN+GitHub+SearXNG) + 阅读器(Jina) + 判断层(规则)
// 铁律:证据来自真实检索,带真实 url+fetchedAt+snippet+source,禁止 LLM 生成证据内容本身。
import { getCachedPack, setCachedPack } from "./db.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

// ─── 5 类(Idea) / 5 类(Copy) ────────────────────────────────────────────────
export const IDEA_CATEGORIES = ["competitor", "oss", "demand", "pricing", "pain"];
export const COPY_CATEGORIES = ["viral", "userVoice", "competitorCopy", "platform", "risk"];

export const CATEGORY_LABEL = {
  // idea
  competitor: "竞品",
  oss: "开源同类",
  demand: "需求信号",
  pricing: "定价/商业",
  pain: "痛点案例",
  // copy
  viral: "爆款案例",
  userVoice: "用户原话",
  competitorCopy: "竞品文案",
  platform: "平台语境",
  risk: "风险表达",
};

// ─── 停用词 ──────────────────────────────────────────────────────────────────
const STOPWORDS = new Set(
  ("a an the and or but for to of in on at by with without is are was were be been being it its " +
    "this that these those you your yours we our us they them their he she his her " +
    "get gets help helps make makes made do does did can could will would should may might " +
    "before after into using use uses used so than then also just only very more most " +
    "not no who what when how why which where here there as if while about over under")
    .split(" "),
);
const KEEP_SHORT = new Set(["ai", "ml", "ar", "vr", "ux", "ui", "b2b", "b2c", "saas", "llm", "api"]);

export function keywords(brief, n = 6) {
  const words = String(brief || "")
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s]/g, " ")
    .split(/\s+/)
    .filter((w) => (w.length > 2 || KEEP_SHORT.has(w)) && !STOPWORDS.has(w));
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

// ─── 工具 ────────────────────────────────────────────────────────────────────
function snip(text, max = 240) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}
function ghCredibility(stars) {
  return stars >= 800 ? "high" : stars >= 80 ? "medium" : "low";
}
function hnCredibility(points) {
  return points >= 120 ? "high" : points >= 25 ? "medium" : "low";
}
function webCredibility(domain) {
  if (/github\.com|producthunt\.com|ycombinator\.com|techcrunch\.com/.test(domain)) return "high";
  if (/medium\.com|substack\.com|reddit\.com/.test(domain)) return "medium";
  return "low";
}

// 规则判断层:据现有数据产出 impact(不靠 LLM 编);LLM 增强留 Phase B。
function computeImpact(item) {
  const cat = item._category;
  const sig = item._signal || 0;
  if (cat === "oss") {
    return sig >= 800
      ? `强竞品:已有 ${sig} ⭐ 的成熟开源项目，差异化压力大`
      : sig >= 80
        ? `有 ${sig} ⭐ 的开源探索者，验证方向但尚未规模化`
        : `有人尝试但未获关注(${sig} ⭐)，可能是方向未被验证或执行不足`;
  }
  if (cat === "competitor") {
    return `有团队已公开发布并获得社区关注(${sig} 分)，直接验证了方向，同时带来竞争压力`;
  }
  if (cat === "demand") {
    return sig >= 120
      ? `高热度需求讨论(${sig} 分)，说明痛点真实且广泛`
      : `有社区讨论(${sig} 分)，需求信号值得深入验证`;
  }
  if (cat === "viral") return "爆款案例，可参考其表达结构和钩子设计";
  if (cat === "userVoice") return "真实用户原话，可直接用于优化文案表达";
  if (cat === "competitorCopy") return "竞品文案，对比可发现差异化切入点";
  if (cat === "platform") return "平台语境信号，帮助判断表达方式是否匹配目标渠道";
  if (cat === "risk") return "潜在风险表达，提前规避可信度问题";
  return "相关参考信号";
}

// ─── Jina Reader(免费内容抓取) ───────────────────────────────────────────────
// 用 https://r.jina.ai/{url} 读真实正文;失败不致命,降级用 snippet。
async function jinaRead(url) {
  const jinaKey = process.env.JINA_API_KEY;
  const headers = { Accept: "text/plain" };
  if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return snip(text, 600);
  } catch {
    return null;
  }
}

// ─── SearXNG(自托管 metasearch,可选) ────────────────────────────────────────
// 需设 SEARXNG_URL 环境变量(如 http://localhost:8888)。未设时跳过。
async function searchSearXNG(query, categoryHint, fetchedAt) {
  const base = process.env.SEARXNG_URL;
  if (!base) return [];
  const url =
    `${base.replace(/\/$/, "")}/search?` +
    new URLSearchParams({ q: query, format: "json", language: "en", time_range: "year" });
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "roast-idea/2" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.results || [])
      .filter((r) => r.url && r.title)
      .slice(0, 6)
      .map((r) => {
        const domain = (() => { try { return new URL(r.url).hostname; } catch { return ""; } })();
        return {
          url: r.url,
          source: "web",
          title: snip(r.title, 120),
          claim: snip(r.content || r.title, 200),
          snippet: snip(r.content || r.title),
          fetchedAt,
          credibility: webCredibility(domain),
          _category: categoryHint,
          _signal: r.score || 0,
        };
      });
  } catch {
    return [];
  }
}

// ─── GitHub(同类开源,免 key) ─────────────────────────────────────────────────
async function ghOnce(query, fetchedAt) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=5`;
  const res = await fetch(url, {
    headers: { "User-Agent": "roast-idea", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const json = await res.json();
  return (json.items || [])
    .filter((r) => r?.html_url)
    .map((r) => ({
      url: r.html_url,
      source: "github",
      title: r.full_name,
      claim: `已有同类开源项目 "${r.full_name}"(★${r.stargazers_count || 0})`,
      snippet: snip(r.description) || "(no description)",
      fetchedAt,
      credibility: ghCredibility(r.stargazers_count || 0),
      _category: "oss",
      _signal: r.stargazers_count || 0,
    }));
}

async function searchGitHub(terms, fetchedAt) {
  const tries = [terms.slice(0, 3), terms.slice(0, 2)].map((t) => t.join(" ")).filter(Boolean);
  for (const q of tries) {
    const res = await ghOnce(q, fetchedAt);
    if (res.length) return res;
  }
  return [];
}

// ─── HN Algolia(需求信号+同类发布,免 key) ───────────────────────────────────
async function hnOnce(query, fetchedAt) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`HN ${res.status}`);
  const json = await res.json();
  return (json.hits || [])
    .filter((h) => h?.title)
    .map((h) => {
      const permalink = `https://news.ycombinator.com/item?id=${h.objectID}`;
      const isLaunch = /^(show hn|launch hn)/i.test(h.title || "");
      return {
        url: h.url || permalink,
        source: "hn",
        title: h.title,
        claim: isLaunch
          ? `社区已有发布:"${snip(h.title, 80)}"(${h.points || 0} 分)`
          : `相关讨论:"${snip(h.title, 80)}"(${h.points || 0} 分,${h.num_comments || 0} 评)`,
        snippet: snip(h.story_text || h.title),
        fetchedAt,
        credibility: hnCredibility(h.points || 0),
        _category: isLaunch ? "competitor" : "demand",
        _signal: h.points || 0,
        engagement: h.points ? { metric: "points", value: h.points } : undefined,
      };
    });
}

async function searchHN(terms, fetchedAt) {
  const tries = [terms.slice(0, 4), terms.slice(0, 2)].map((t) => t.join(" ")).filter(Boolean);
  for (const q of tries) {
    const res = await hnOnce(q, fetchedAt);
    if (res.length) return res;
  }
  return [];
}

// ─── Jina 内容增强(异步,失败不阻断) ─────────────────────────────────────────
// 对 top N 条结果补抓正文,用于更准确的 impact 生成(Phase B LLM 判断前置)。
async function enrichWithJina(items, topN = 3) {
  if (!process.env.JINA_ENABLED && !process.env.JINA_API_KEY) return items;
  const toEnrich = items.slice(0, topN);
  await Promise.allSettled(
    toEnrich.map(async (item) => {
      const content = await jinaRead(item.url);
      if (content) {
        item.snippet = snip(content, 320);
        item._jinaEnriched = true;
      }
    }),
  );
  return items;
}

// ─── AI 关键词抽取(中文 brief → 英文搜索词,gpt-4o-mini,50 token) ────────────
// 纯规则 keywords() 对整段中文无法分词,导致 GitHub/HN 搜索 0 命中。
// fallback:若无 key 或超时,用规则结果。
async function extractKeywordsViaAI(brief) {
  const apiKey = (process.env.OPENAI_API_KEY || process.env.KIMI_API_KEY || "").trim();
  if (!apiKey) return null;
  const isKimi = !process.env.OPENAI_API_KEY && process.env.KIMI_API_KEY;
  const baseURL = isKimi ? "https://api.moonshot.cn/v1" : "https://api.openai.com/v1";
  const model = isKimi ? "moonshot-v1-8k" : "gpt-4o-mini";
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 60,
        temperature: 0,
        messages: [{ role: "user", content: `Extract 4 English search keywords capturing the MOST DISTINCTIVE, specific angle of this idea — its particular problem/niche/audience, NOT generic category words alone (avoid bare "AI", "app", "tool", "platform", "software"). Prefer the unique value proposition. Reply ONLY with comma-separated keywords:\n\n${brief.slice(0, 400)}` }],
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const kw = (json.choices?.[0]?.message?.content || "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, ""))
      .filter((s) => s.length > 1);
    return kw.length >= 2 ? kw : null;
  } catch {
    return null;
  }
}

// ─── 中文/社交源(Agent-Reach 工具选型,接到源无关 retrieve)────────────────────
// Exa:经 mcporter 调托管 MCP(免 key),语义搜全网/中文(公众号/博客/社区)。
async function searchExa({ terms, cnQuery, mode, nowIso }) {
  const q = cnQuery ? cnQuery.slice(0, 200) : terms.slice(0, 6).join(" "); // Exa 语义搜:中文 brief 直接用原文
  const { stdout } = await execFileP(
    "mcporter",
    ["call", "https://mcp.exa.ai/mcp.web_search_exa", `query=${q}`, "numResults=5"],
    { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
  );
  const blocks = String(stdout).split(/\n(?=Title: )/);
  const items = [];
  for (const b of blocks) {
    const title = (b.match(/Title:\s*(.+)/)?.[1] || "").trim();
    const url = (b.match(/URL:\s*(\S+)/)?.[1] || "").trim();
    if (!url || !/^https?:/.test(url)) continue;
    const hl = (b.split(/Highlights:/)[1] || "").replace(/\n\.\.\.\n/g, " ").replace(/\s+/g, " ").trim();
    items.push({
      url,
      source: "exa",
      title: title || url,
      claim: mode === "copy" ? `网络/中文语境:"${snip(title, 70)}"` : `相关内容/讨论:"${snip(title, 70)}"`,
      snippet: snip(hl || title, 240),
      fetchedAt: nowIso,
      credibility: "medium",
      _category: mode === "copy" ? "platform" : "demand",
      _signal: 0,
    });
  }
  return items.slice(0, 5);
}

// V2EX:经 sov2ex 搜索 API(免 key),中文开发者/技术社区的需求与用户原话。
async function searchV2EX({ terms, cnQuery, mode, nowIso }) {
  const q = cnQuery ? cnQuery.slice(0, 40) : terms.slice(0, 4).join(" "); // sov2ex 中文全文搜
  const res = await fetch(`https://www.sov2ex.com/api/search?q=${encodeURIComponent(q)}&size=5&sort=sumup`, {
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`sov2ex ${res.status}`);
  const json = await res.json();
  return (json.hits || [])
    .map((h) => h._source || h)
    .filter((s) => s && s.id)
    .map((s) => ({
      url: `https://www.v2ex.com/t/${s.id}`,
      source: "v2ex",
      title: s.title || "(无标题)",
      claim: `V2EX 讨论:"${snip(s.title, 70)}"(${s.replies || 0} 回复)`,
      snippet: snip(s.content || s.title),
      fetchedAt: nowIso,
      credibility: "low",
      _category: mode === "copy" ? "userVoice" : "demand",
      _signal: s.replies || 0,
      engagement: s.replies ? { metric: "replies", value: s.replies } : undefined,
    }));
}

// ─── Channel 注册表:每源 id/label/tier/开关/run;源无关、可插拔、可单独开关 ─────
// tier: green=免 cookie 低风险 / yellow=需配 / red=cookie 登录(封号风险,默认关)。
// 脆弱/cookie 源(微博/抖音/小红书/Reddit/Twitter)在此扩展即可,默认 enabled:false。
export const CHANNELS = [
  { id: "github", label: "GitHub", tier: "green", enabled: () => true, run: ({ terms, nowIso }) => searchGitHub(terms, nowIso) },
  { id: "hn", label: "Hacker News", tier: "green", enabled: () => true, run: ({ terms, nowIso }) => searchHN(terms, nowIso) },
  { id: "exa", label: "Exa", tier: "green", enabled: () => process.env.ROAST_EXA !== "0", run: (ctx) => searchExa(ctx) },
  { id: "v2ex", label: "V2EX", tier: "green", enabled: () => process.env.ROAST_V2EX !== "0", run: (ctx) => searchV2EX(ctx) },
  { id: "searxng", label: "SearXNG", tier: "green", enabled: () => !!process.env.SEARXNG_URL, run: async ({ searxngQueries, nowIso }) => (await Promise.all(searxngQueries.map(({ q, cat }) => searchSearXNG(q, cat, nowIso)))).flat() },
];

export function listChannels() {
  return CHANNELS.map((c) => ({ id: c.id, label: c.label, tier: c.tier, enabled: c.enabled() }));
}

// ─── EvidencePack 组装 ───────────────────────────────────────────────────────
export async function buildEvidencePack({ brief, mode = "idea", redacted, nowIso, nowMs, byoKeys }) {
  const cats = mode === "copy" ? COPY_CATEGORIES : IDEA_CATEGORIES;
  const emptyByCategory = Object.fromEntries(cats.map((c) => [c, []]));

  if (redacted) {
    return { mode, items: [], byCategory: emptyByCategory, searchedAt: nowIso, redacted: true, sources: [], failures: [] };
  }

  // 中文 brief 检测:>30% CJK 字符时走 AI 关键词抽取(规则分词对整段中文无效)
  const ruleTerms = keywords(brief);
  const cjkRatio = (brief.match(/[一-鿿]/g) || []).length / Math.max(brief.replace(/\s/g, "").length, 1);
  const terms = cjkRatio > 0.3 ? ((await extractKeywordsViaAI(brief)) || ruleTerms) : ruleTerms;
  const cacheKey = `${mode}:${terms.slice(0, 4).join(" ")}`;
  if (!terms.length) {
    return { mode, items: [], byCategory: emptyByCategory, searchedAt: nowIso, redacted: false, sources: [], failures: [], query: "" };
  }

  const cached = await getCachedPack(cacheKey, nowMs);
  if (cached) return { ...cached, cached: true };

  // 并行检索:GitHub + HN + SearXNG(可选)
  const searxngQueries =
    mode === "idea"
      ? [
          { q: `${terms.slice(0, 3).join(" ")} pricing saas`, cat: "pricing" },
          { q: `${terms.slice(0, 3).join(" ")} failed startup lessons`, cat: "pain" },
        ]
      : [
          { q: `${terms.slice(0, 3).join(" ")} viral marketing copy`, cat: "viral" },
          { q: `${terms.slice(0, 3).join(" ")} user reviews complaints`, cat: "userVoice" },
        ];

  // 从启用的 channel 适配器并行检索(源无关;失败 allSettled 兜底,不空屏不造假)
  const activeChannels = CHANNELS.filter((c) => c.enabled());
  // 中文 brief → 中文源(exa/v2ex)用原文查询;西方源用英文 terms
  const cnQuery = cjkRatio > 0.3 ? brief.replace(/\s+/g, " ").trim() : null;
  const ctx = { terms, cnQuery, mode, nowIso, searxngQueries };
  const settled = await Promise.allSettled(activeChannels.map((c) => c.run(ctx)));
  const raw = [];
  const failures = [];
  const sources = new Set();

  for (const [i, r] of settled.entries()) {
    const ch = activeChannels[i];
    if (r.status === "fulfilled") {
      if (r.value.length) sources.add(ch.id);
      for (const it of r.value) raw.push({ ...it, tier: ch.tier }); // 给每条标 tier(供 UI 风险标注)
    } else {
      failures.push({ source: ch.id, error: String(r.reason?.message || r.reason).slice(0, 120) });
    }
  }

  // 去重(按 url) + 排序(可信度优先→信号强度)
  const credOrder = { high: 0, medium: 1, low: 2 };
  const seen = new Set();
  const sorted = raw
    .filter((it) => it.url && (seen.has(it.url) ? false : (seen.add(it.url), true)))
    .sort((a, b) => {
      const dc = (credOrder[a.credibility] ?? 2) - (credOrder[b.credibility] ?? 2);
      return dc !== 0 ? dc : (b._signal || 0) - (a._signal || 0);
    })
    .slice(0, 12);

  // Jina 内容增强(仅 top 3,失败不阻断)
  await enrichWithJina(sorted, 3);

  // 打 impact + 编号
  const items = sorted.map((it, i) => {
    const { _category, _signal, _jinaEnriched, ...rest } = it;
    return {
      id: `E${i + 1}`,
      category: _category || "demand",
      impact: computeImpact(it),
      ...rest,
    };
  });

  // byCategory
  const byCategory = Object.fromEntries(cats.map((c) => [c, []]));
  items.forEach((it) => {
    if (byCategory[it.category]) byCategory[it.category].push(it.id);
    else byCategory[cats[cats.length - 1]].push(it.id); // 兜底最后一类
  });

  const pack = { mode, items, byCategory, searchedAt: nowIso, redacted: false, sources: [...sources], failures, query: cacheKey };
  if (items.length) await setCachedPack(cacheKey, pack, nowIso);
  return pack;
}
