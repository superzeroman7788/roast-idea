// 证据检索层(PRD §7)——薄,可组合小工具。
// 铁律(P2):证据来自真实检索,带真实 url + fetchedAt + snippet + source,绝不让 LLM 生成证据。
// 起步两个零成本检索器:Hacker News(Algolia,免 key)+ GitHub 搜同类 repo(免 key 低频)。
import { getCachedPack, setCachedPack } from "./db.mjs";

// 只保留真正的功能词(冠词/代词/介词/泛动词);保留 startup/tool/product/idea 这类领域词——
// 它们正是搜竞品的关键。否则会把信号词全删光,剩长尾词做 AND 检索 → 0 结果。
const STOPWORDS = new Set(
  ("a an the and or but for to of in on at by with without is are was were be been being it its " +
    "this that these those you your yours we our us they them their he she his her " +
    "get gets help helps make makes made do does did can could will would should may might " +
    "before after into using use uses used so than then also just only very more most " +
    "not no who what when how why which where here there as if while about over under")
    .split(" "),
);
const KEEP_SHORT = new Set(["ai", "ml", "ar", "vr", "ux", "ui", "b2b", "b2c", "saas", "llm", "api"]);

// 从点子里抽检索词数组(纯字符串处理,不是"生成证据")。
export function keywords(brief, n = 6) {
  const words = String(brief || "")
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s]/g, " ")
    .split(/\s+/)
    .filter((w) => (w.length > 2 || KEEP_SHORT.has(w)) && !STOPWORDS.has(w));
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  // 按词频降序;同频保留出现顺序(主语通常在前,Array.sort 稳定)。
  // 不再按长度排序——那会把通用长词顶到领域词(ai/tool/startup)前面。
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

function ghCredibility(stars) {
  return stars >= 800 ? "high" : stars >= 80 ? "medium" : "low";
}
function hnCredibility(points) {
  return points >= 120 ? "high" : points >= 25 ? "medium" : "low";
}
function snip(text, max = 220) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function ghOnce(query, fetchedAt) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query,
  )}&sort=stars&order=desc&per_page=5`;
  const res = await fetch(url, {
    headers: { "User-Agent": "roast-idea", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const json = await res.json();
  return (json.items || [])
    .filter((r) => r && r.html_url)
    .map((r) => ({
      url: r.html_url,
      source: "github",
      title: r.full_name,
      claim: `已有同类项目 "${r.full_name}"(★${r.stargazers_count || 0})`,
      snippet: snip(r.description) || "(no description)",
      fetchedAt,
      credibility: ghCredibility(r.stargazers_count || 0),
      _theme: "competitors",
      _signal: r.stargazers_count || 0,
    }));
}

async function hnOnce(query, fetchedAt) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
    query,
  )}&tags=story&hitsPerPage=6`;
  const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`HN ${res.status}`);
  const json = await res.json();
  return (json.hits || [])
    .filter((h) => h && h.title)
    .map((h) => {
      const permalink = `https://news.ycombinator.com/item?id=${h.objectID}`;
      const isLaunch = /^(show hn|launch hn)/i.test(h.title || "");
      return {
        url: h.url || permalink,
        source: "hn",
        title: h.title,
        claim: isLaunch
          ? `有人已在做并公开发布:"${snip(h.title, 80)}"`
          : `相关讨论/需求信号:"${snip(h.title, 80)}"(${h.points || 0} 分,${h.num_comments || 0} 评)`,
        snippet: snip(h.story_text || h.title),
        fetchedAt,
        credibility: hnCredibility(h.points || 0),
        _theme: isLaunch ? "competitors" : "demandSignals",
        _signal: h.points || 0,
      };
    });
}

// GitHub 是 AND 匹配:词多易 0 命中 → 从 top3 逐步回退到 top2。
async function searchGitHub(terms, fetchedAt) {
  const tries = [terms.slice(0, 3), terms.slice(0, 2)].map((t) => t.join(" ")).filter(Boolean);
  let last = [];
  for (const q of tries) {
    last = await ghOnce(q, fetchedAt);
    if (last.length) return last;
  }
  return last;
}

// HN(Algolia)相关性匹配,通常有结果;0 时回退到 top2。
async function searchHN(terms, fetchedAt) {
  const tries = [terms.slice(0, 4), terms.slice(0, 2)].map((t) => t.join(" ")).filter(Boolean);
  let last = [];
  for (const q of tries) {
    last = await hnOnce(q, fetchedAt);
    if (last.length) return last;
  }
  return last;
}

// 组装 EvidencePack(契约见 PRD §4)。失败的检索器走 Promise.allSettled,不致命。
export async function buildEvidencePack({ brief, redacted, nowIso, nowMs }) {
  const emptyThemes = { competitors: [], demandSignals: [], pricing: [], saturation: [] };
  if (redacted) {
    return { items: [], byTheme: emptyThemes, searchedAt: nowIso, redacted: true, sources: [] };
  }

  const terms = keywords(brief);
  const cacheKey = terms.slice(0, 4).join(" ");
  if (!cacheKey) {
    return { items: [], byTheme: emptyThemes, searchedAt: nowIso, redacted: false, sources: [], failures: [], query: "" };
  }
  const cached = getCachedPack(cacheKey, nowMs);
  if (cached) return { ...cached, cached: true };

  const settled = await Promise.allSettled([
    searchGitHub(terms, nowIso),
    searchHN(terms, nowIso),
  ]);
  const raw = [];
  const failures = [];
  const sources = [];
  for (const [i, r] of settled.entries()) {
    const name = i === 0 ? "github" : "hn";
    if (r.status === "fulfilled") {
      if (r.value.length) sources.push(name);
      raw.push(...r.value);
    } else {
      failures.push({ source: name, error: String(r.reason?.message || r.reason).slice(0, 120) });
    }
  }

  // 去重(按 url)+ 排序(可信度/信号)+ 编号 E1..
  const seen = new Set();
  const sorted = raw
    .filter((it) => (seen.has(it.url) ? false : (seen.add(it.url), true)))
    .sort((a, b) => (b._signal || 0) - (a._signal || 0))
    .slice(0, 10);

  const items = sorted.map((it, i) => {
    const { _theme, _signal, ...rest } = it;
    return { id: `E${i + 1}`, ...rest };
  });

  const byTheme = { ...emptyThemes };
  sorted.forEach((it, i) => {
    const id = `E${i + 1}`;
    const theme = it._theme === "competitors" ? "competitors" : "demandSignals";
    byTheme[theme].push(id);
  });
  // 同质化信号:有几个真实竞品
  byTheme.saturation = [...byTheme.competitors];

  const pack = {
    items,
    byTheme,
    searchedAt: nowIso,
    redacted: false,
    sources,
    failures,
    query: cacheKey,
  };

  if (items.length) setCachedPack(cacheKey, pack, nowIso);
  return pack;
}
