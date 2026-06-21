# Roast — 事实侦察 / Evidence 搜索层设计

> 独立文档(从 PRD §7 抽出并细化)。PRD 第 7 节引用本文为准。
> 一句话:**SearXNG 当雷达,Firecrawl/Jina 当阅读器,我们自己做判断层。** 模型不"凭记忆搜",只对**真抓回来的正文**做判断。

---

## 1. 架构:雷达 + 阅读器 + 判断层

| 层 | 选型 | 说明 / 取舍 |
|---|---|---|
| 雷达·搜链接 | **SearXNG**(自托管 metasearch) | 免费、无 key、聚合多引擎、隐私好(实例去查引擎,第三方看不到完整 query)。代价:要自托管(Docker),上游引擎会限流/验证码 → **多引擎 + 狠缓存 + 失败兜底** |
| 雷达·高信号补充 | **HN Algolia(免费)+ GitHub API** 直连 | Reddit/HN/OSS 这类结构化信号,直连比经 SearXNG 更准更稳——**别什么都塞给 SearXNG** |
| 阅读器·读正文 | **Jina Reader(MVP,便宜)** / Firecrawl(JS 重难页) | URL→干净正文/markdown;**每类只读 top 3-5 条**(控成本+延迟) |
| 兜底搜索 | Tavily / Brave(SearXNG 抽风时) | 付费搜索 fallback,保证不空手 |
| 判断层(质量所在,我们做) | 便宜模型 + 规则 | 排序、去重、可信度打分、抽 claim、评"影响"——**只据抓回的正文,不许编(P2)** |

---

## 2. 流程

```
extractQueries(idea, 5类) → SearXNG 搜链接(+HN/GitHub 直连) → 候选去重排序
  → Jina/Firecrawl 读 top N 正文 → 判断层(可信度+claim+影响,只据正文)
  → 结构化 EvidencePack(按5类) → 列表页展示 → 喂主脑+反方(每条挂 evidenceId)
```
1. **抽查询**:便宜模型从点子抽 `{category, entities, 关键词[], 竞品名猜测[], targetUser, valueProp}`,为 5 类各生成定向 query。**绝不把整段点子直接丢去搜。**
2. **搜链接**:5 类并行打 SearXNG + HN + GitHub;`allSettled` + 每源超时 + query 哈希缓存。
3. **选链接**:去重(URL+近似标题)、按 来源权重×相关度×新鲜度 排序,每类留 top 3-5 再读。
4. **读正文**:Jina(难页 Firecrawl)抓正文;失败跳过并标记,不编。
5. **判断层**:仅据正文产出 `EvidenceItem`;丢 SEO 垃圾(无日期/内容农场/正文过薄)。
6. **结构化 + 展示**:归入 5 类 → `EvidencePack`;**两段式**:证据包先返回先显示(列表页),议会再开。

---

## 3. Idea 模式 — 5 类(问"值不值得做")
①竞品 ②GitHub/开源同类 ③Reddit/HN/X 需求讨论 ④定价/付费意愿 ⑤用户痛点 & 失败案例。

## 4. Copy 模式 — 5 类(问"这句话会不会被看懂/相信/转发/点击")
①同类爆款(标题/hook/开头三秒) ②**用户原话(最高价值,捞真实表达)** ③竞品表达(官网/落地页/广告语/定价/FAQ) ④平台语境(X/HN 厌夸张爱洞见;小红书要场景+人群+结果;PH 要一句话价值+demo;LinkedIn 要背书+业务结果) ⑤风险表达(诈骗/过度承诺/AI 味/空泛/同质化,部分用规则库)。

**Copy 输出**(替代"市场验证"):Hook 强度 / 清晰度 / 用户语言匹配度 / 可信度 / 差异化 / 平台适配 / 最该删的废话 / 3 个改写 / **1 个可直接发布版本**。

**约束**:不承诺"会爆"(爆款不可预测,只给范例+用户原话,输出停在诊断);"爆款"需互动数据源(HN points/Reddit score/PH upvotes),通用 SearXNG 只给"怎么写";中文平台覆盖受限(见 §9)。

---

## 5. 数据模型

```ts
interface EvidenceItem {
  id: string;          // "E1"
  category: "competitor"|"oss"|"demand"|"pricing"|"pain"   // Idea
          | "viral"|"userVoice"|"competitorCopy"|"platform"|"risk"; // Copy
  claim: string;       // 一句话发现（据正文，不编）
  url: string; title: string; snippet: string;
  source: "searxng"|"web"|"github"|"hn"|"reddit"|"producthunt"|"other";
  fetchedAt: string;   // ISO，freshness
  credibility: "high"|"medium"|"low";
  impact: string;      // 对这个 idea/文案意味着什么
  engagement?: { metric: "points"|"score"|"upvotes"; value: number }; // 有则显示热度
  excluded?: boolean;  // 用户在列表页手动排除
}
interface EvidencePack {
  mode: "idea"|"copy";
  byCategory: Record<string, string[]>;  // 类→evidenceId[]
  items: EvidenceItem[];
  searchedAt: string; redacted: boolean; // 关闭检索时 true
  failures: { source: string; error: string }[];
}
```

---

## 6. 可信度与排序
- 来源权重:官网/竞品官网 > GitHub/HN/PH > 一般博客 > 内容农场(近乎丢弃)。
- 新鲜度:`fetchedAt`/内容日期越新越高(定价、竞品尤甚)。
- `score = 来源权重 × 相关度 × 新鲜度`;低可信标灰,不直接删(让用户判断)。

## 7. 成本 / 性能 / 缓存
- query→结果、url→正文 都落缓存(Web:hosted DB;Mac:SQLite),TTL 如 7 天。
- 每类 query 数、每类读取页数(3-5)、每次总页数设上限。
- 免费试一次:HN(免费)+ 有限 SearXNG/Jina;重度走用户自带 key。
- 两段式 + 流式:证据边到边显示。

## 8. 失败 / 隐私
- 某源/某页失败 → 用其余继续,在 `failures` 标注,**绝不编造**。
- 隐私(P7):检索把基于点子的 query 发出去 → "事实侦察"是**可关开关**(`redacted=true` 纯模型模式);SearXNG 自托管时第三方看不到完整 query(隐私加分)。

## 9. 中文源(小红书/公众号,后置)
无干净内容搜索 API(围墙+反爬+法律风险)。MVP 先靠西方平台;要做走**付费数据商**(新榜/极致了/蝉妈妈)不自爬;做成源无关适配器;合规 PIPL/数据安全法/AI 身份标识。

---

## 10. 证据列表页 UX（新增设计 — "事实侦察"结果屏）

**位置**:输入 → 点"事实侦察" → **本页(证据列表)** → "开议会"。是 idea/copy 共用的中间屏。

**布局**(暗色 JARVIS,克制不压迫):
- **顶部条**:点子摘要 + 侦察状态(`已侦察 N 条 · M 源 · 用时 Xs`)+ 操作:`重新侦察`、`不检索直接开议会`、主按钮 **`开议会(基于证据)`**(琥珀)。
- **左窄栏**:5 类 + 计数,点击过滤;"只看高可信"开关;`redacted` 时显示"未检索"。
- **主区**:证据卡片,按类分组(可折叠),流式逐条出现。
- **底部**:同顶部主按钮(长列表时仍可触达)。

**单条证据卡(card anatomy)**:
- 左侧细边按可信度着色(high=青、medium=琥珀、low=灰)。
- 第一行:**claim(粗)** + 来源徽章(web/github/hn/reddit/ph)+ 域名 + 时间;有热度则显示 `▲ points/score`。
- 第二行:`影响:…`(琥珀小字,判断层产出)。
- 右侧:打开链接图标;`排除`(置 `excluded`,不喂议会)。
- 低可信卡整体降饱和并标"低可信"。

**状态机**:`searching`(骨架+逐条流入)→ `done`(分组完整)→ `empty`(无结果:提示放宽/换词/直接开议会)→ `redacted`(用户关了检索)。

**交互要点**:
- 用户可**排除**个别证据 / **重搜某一类**;排除项不进议会。
- 卡片可点开看 `snippet` 原文片段(证明不是编的)。
- "开议会"把**未排除**的 EvidencePack 传给议会,每条反对挂 `evidenceId`(P4 校验)。

---

## 11. 给 Claude Code 的实现要点
- 检索器接口源无关:`retrieve(category, query) → EvidenceItem[]`,SearXNG/HN/GitHub/数据商都实现它。
- 判断层独立可测:输入"正文+元数据"→ 输出 `{claim, credibility, impact}`,**禁止凭空生成**。
- 列表页与议会解耦:列表页产出 `EvidencePack`,议会消费它。
- 全程缓存 + allSettled + 失败标注,不因单源挂掉而空屏或造假。
