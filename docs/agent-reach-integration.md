# Agent-Reach 集成 — 中文 / 社交证据补强

> 独立文档。补 `evidence-search-design.md` 的中文/社交源缺口。
> 一句话:**采用 Agent-Reach 的"工具选型",把它选定的上游 CLI/MCP 接到我们源无关的 `retrieve()` 后面,做成"中文/社交证据适配器"。**

---

## 1. Agent-Reach 是什么(先认清,别用错)

- MIT 开源、~20k★ 的**脚手架/安装器**,不是可 import 的库。
- 它的活:帮你**选好并配好**一堆上游 CLI/MCP 工具(Jina、Exa、xhs-cli、douyin-mcp、yt-dlp…),并给 Agent 装一份 SKILL.md。
- README 原话:"安装后 **Agent 直接调用上游工具,不经过 Agent Reach 的包装层**"。
- **结论**:放进我们 APP ≠ "运行时调 Agent-Reach",而是**采用它的工具选型 + 把那几个上游 CLI/MCP 接到后端**。MIT 只覆盖它自身代码;**每个上游工具各自 license、每个平台各自 ToS/风控**。

---

## 2. 平台覆盖 + 风险分级(决定接入顺序)

| 风险层 | 平台 | 上游工具 | 配置 |
|---|---|---|---|
| 🟢 低(免 cookie,先接) | 任意网页 | Jina Reader | 无 |
| 🟢 低 | 全网语义搜索 | Exa(via mcporter) | 免 key |
| 🟢 低 | **微信公众号** | Exa(+Camoufox 可选) | 无 |
| 🟢 低 | **微博** | 内置 | 无 |
| 🟢 低 | V2EX | 内置 | 无 |
| 🟢 低 | YouTube 字幕 | yt-dlp | 无 |
| 🟢 低 | 抖音(视频解析/无水印链接) | douyin-mcp | **无需登录** |
| 🟡 中(需配,无 cookie) | B站 | yt-dlp / bili-cli | 海外服务器需代理(~$1/月) |
| 🟡 中 | 雪球 | 内置 | 需配 |
| 🟡 中 | LinkedIn | linkedin-mcp | 浏览器自动化 |
| 🟡 中 | 小宇宙播客转写 | Whisper | 免费 key |
| 🔴 高(cookie 登录,封号/ToS 风险) | **小红书** | xhs-cli | cookie(`xhs login`) |
| 🔴 高 | Reddit | rdt-cli | cookie(`rdt login`) |
| 🔴 高 | Twitter/X | twitter-cli | cookie |

> 🟢 早接补中文;🟡 按需;🔴 **用专用小号、限流、当可选开关,别做成规模化依赖**(脚本调用可能被平台检测封号)。

---

## 3. 架构(怎么接)

```
前端 → 你的 /api/social-search、/api/read-url(只调你的后端)
后端 worker(容器,非 serverless):
  retrieve(category, query, platform) → 调对应上游 CLI/MCP → 归一化为 EvidenceItem[]
  ├─ 西方:SearXNG / HN Algolia / GitHub(见 evidence-search-design)
  └─ 中文/社交:Jina / Exa / 公众号 / 微博 / 抖音 / (cookie:小红书…)
  cookie/key 只在后端;限流 + 缓存 + 失败兜底
判断层:只据抓回正文产出 claim/可信度/影响,不编(P2)
```
- **接到已有的源无关接口** `retrieve(category,query)→EvidenceItem[]`,与西方源同构、可插拔、可单独开关。
- Agent-Reach 是 Python CLI + 需 shell + 系统依赖 → 必须**后端 worker/容器**,serverless 跑不动。
- **cookie / token / key 绝不进前端**;前端只调你封装的 `/api`。

---

## 4. 安全 / 合规

- cookie 平台(小红书/Twitter/Reddit)**用专用小号**,凭据只存后端、文件权限收紧、不外传。
- 限流 + 缓存(query→结果、url→正文)+ 单源失败兜底,**绝不因某源挂掉而空屏或造假**。
- 合规:PIPL / 数据安全法 / 2026 起 AI 获客机器人需带"AI 身份标识";中文平台数据商业化使用注意 ToS。
- 它"纯 vibe coding、best-effort 维护",**别当生产级 SLA 依赖**;规模化时用付费数据商(新榜/极致了/蝉妈妈)兜底。

---

## 5. 与现有设计的关系
- 西方源(SearXNG+Jina+HN+GitHub)和中文/社交源(本文)**共用同一个 `retrieve()` 接口和判断层**。
- Idea / Copy 两套搜索目标不变(见 evidence-search-design §3–4);中文/社交源主要补 Copy 模式的"平台语境/用户原话/同类爆款"和 Idea 模式的中文需求信号。
- Jina(读网页)、Exa(搜全网)两者本就一致,直接复用,不重复造。

---

## 6. 分期接入
1. **MVP**:先接 🟢 零配置批(公众号/微博/V2EX/抖音解析 + Jina/Exa)——免 cookie、低风险,立刻补中文。
2. **可选**:按需开 🟡(B站/雪球/小宇宙/LinkedIn)。
3. **谨慎**:🔴 cookie 批(小红书/Reddit/Twitter)用小号 + 开关,不规模化。
4. **规模化**:cookie 抓取改/补**付费数据商**。

---

## 7. 给 Claude Code 的实现要点
- 每个平台一个 channel 适配器,实现统一 `retrieve()`;`platform`/`category` 可配置、可开关。
- 在后端 worker 跑上游 CLI/MCP(参考 Agent-Reach 的 channels/ 选型);前端零凭据。
- 全程 allSettled + 缓存 + 失败标注;低可信/cookie 源结果在 UI 标注来源与风险。
- 默认只开 🟢 批;🔴 批默认关闭,需用户显式开启并提示封号风险。
