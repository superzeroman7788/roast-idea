// ROAST · Memory 注入 —— 把"越用越懂你"叫醒。
// 依据 docs/memory-injection-spec.md(P1)。memories 已落库 + Reflection 已写入,本模块补"注入各站 system prompt"。
//
// ★ 命门(最容易做歪):记忆是给对抗席的"弹药",不是把 AI 变成回音室。
//   - 议会(council)只注 偏好/模式 当"待压测的靶子",★ 不注 product_judgment —— 判断要被重新拷问,不是免检通行证。
//   - 其余站软引导(陪练/产出/自动档/马仔)。
// 全部按 user_id 过滤(分租),受 token 预算上限,product_judgment 走相关性门控防跨项目污染。

const CAT = { pref: "preference", pat: "pattern", judg: "product_judgment" };

// 各站注入策略(§4)。judg=0 即不注 product_judgment。
// council ★ judg:0 = 防回音室;agent 轻注(无 pattern);其余建设型全注。
const POLICY = {
  clarify: { pref: 3, pat: 2, judg: 3, max: 8 },
  council: { pref: 3, pat: 2, judg: 0, max: 6 }, // ★ 不注 judg
  produce: { pref: 3, pat: 2, judg: 3, max: 8 },
  auto: { pref: 3, pat: 2, judg: 3, max: 8 },
  agent: { pref: 2, pat: 0, judg: 2, max: 4 }, // 轻注,影响产物形态
};
const MAX_CHARS = 1600; // token 预算粗界(中文 ~1 字 1 token)

// 轻量中文关键词重叠:ascii 词(≥3)+ CJK 二元组,去重交集计数。
// MVP 不上向量;记忆量大(几百条 product_judgment)再升 embedding 语义检索(§9.2 计划)。
function tokenize(s) {
  const t = String(s || "").toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]{3,}/g) || []) out.add(w);
  for (const run of t.match(/[一-鿿]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}
function keywordOverlap(a, b) {
  const A = tokenize(a), B = tokenize(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n;
}

// 选取(§2)。memories 已按 created_at DESC(recency)。返回挑中的子集(白箱可见)。
// product_judgment ★ 相关性门控:同一 discussion || 与 brief 关键词重叠 ≥2,否则跨项目污染。
export function selectMemories(memories, { discussionId, brief, station } = {}) {
  const list = Array.isArray(memories) ? memories : [];
  const pol = POLICY[station] || POLICY.clarify;
  const byCat = (c, n) => (n > 0 ? list.filter((m) => m.category === c).slice(0, n) : []);
  const pref = byCat(CAT.pref, pol.pref);
  const pat = byCat(CAT.pat, pol.pat);
  let judg = [];
  if (pol.judg > 0) {
    judg = list
      .filter((m) => m.category === CAT.judg)
      .filter((m) => (discussionId && m.source_discussion_id === discussionId) || keywordOverlap(m.content, brief) >= 2)
      .slice(0, pol.judg);
  }
  // token 预算:条数 ≤ pol.max + 总字符 ≤ MAX_CHARS 截断(recency 优先,pref→pat→judg)
  const ordered = [...pref, ...pat, ...judg];
  const capped = [];
  let chars = 0;
  for (const m of ordered) {
    if (capped.length >= pol.max) break;
    chars += (m.content || "").length;
    if (chars > MAX_CHARS && capped.length) break;
    capped.push(m);
  }
  return capped;
}

// 格式化注入块(§3/§4)。位于 skill 块之前;末尾带分隔,可直接拼到 brief 头部。
// 议会用对抗措辞(靶子,不得让步);其余软引导(可被当前上下文覆盖)。
export function formatMemoryBlock(memories, station) {
  if (!memories?.length) return "";
  const pref = memories.filter((m) => m.category === CAT.pref);
  const pat = memories.filter((m) => m.category === CAT.pat);
  const judg = memories.filter((m) => m.category === CAT.judg);
  const lines = [];
  if (station === "council") {
    lines.push("[关于这位用户的倾向(记忆 —— 这是你要精准压测的靶子,不是要迎合的结论)]");
    for (const m of pref) lines.push(`- 偏好:${m.content}`);
    for (const m of pat) lines.push(`- 模式:${m.content}`);
    lines.push(
      "你的任务是更精准地拷问这些倾向,而非因其为用户偏好而让步;魔鬼代言人尤其不得手软。记忆是软引导非事实,可被当前证据推翻,最硬的 Kill 不可静音。",
    );
  } else {
    lines.push("[关于这位用户(记忆 —— 软引导非事实,可被当前上下文/证据覆盖)]");
    for (const m of pref) lines.push(`- 偏好:${m.content}`);
    for (const m of pat) lines.push(`- 模式:${m.content}`);
    if (judg.length) {
      lines.push("[本项目已形成的判断(参考,不取代当前推理)]");
      for (const m of judg) lines.push(`- ${m.content}`);
    }
  }
  return lines.join("\n") + "\n\n---\n\n";
}

// 一站式:取记忆 → 选 → 格式化。返回 { block, injected }。
// injected 供前端白箱展示(N 条/可点开/可删);block 拼到 brief 头部(skill 之前)。
// getMemories: db.getMemories(userId, limit);disabled(A/B 火力对照)→ 空注入。
export async function buildMemoryInjection(getMemories, userId, { discussionId, brief, station, disabled } = {}) {
  if (!userId || disabled) return { block: "", injected: [] };
  let all = [];
  try { all = await getMemories(userId, 50); } catch { all = []; }
  const injected = selectMemories(all, { discussionId, brief, station });
  return { block: formatMemoryBlock(injected, station), injected };
}
