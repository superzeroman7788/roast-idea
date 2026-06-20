# Roast My Idea v2 — 产品详细设计文档（Mac 原生 · 证据接地决策议会）

> 交接对象：Claude Code / Codex（重建本项目）
> 版本：v2.0 设计 ｜ 日期：2026-06-20
> 一句话：把"AI 主观吐槽器"升级为**有证据的跨厂商反方决策议会**。
> **交付顺序：先做 Web 版上线,再用 Tauri 包成 macOS 版**(同一套前端+后端,改动很小)。

---

## 0. 给 Claude Code 的总则（先读这条）

1. **按阶段实现，别一次全做。** 见第 11 节交付阶段。先 ship 实质（真议会 + 证据 + 裁决完整性），炫的图谱可视化和语音排后面。
2. **自包含。** 不依赖外部 `agent-group` 服务，不出现任何 `/Users/...` 硬编码路径。议会编排逻辑放进本仓库。
3. **绝不伪造议会。** 任何时候都不允许把写死的 mock、或单模型扮多角色，渲染成真实结果（旧版 `src/roastEngine.ts` 的 mock 是反面教材，删除或明确隔离为 SAMPLE）。
4. **每个产品原则都要有代码机制,不能只写在 prompt/文案里**(强制分歧、引用证据、跨厂商聚合都要真实现 + 可校验)。

---

## 1. 产品定位与目标

**是什么**：用户输入一个产品点子或文案 → 系统先**检索真实外部证据**(竞品、需求讨论、定价、同质化信号)生成证据包 → 主脑基于证据整理结构化方案 → **不同厂商的多个模型组成反方会议,每条反对必须引用证据** → 输出裁决、致命假设、最便宜验证、7 天计划,并附带可点击的证据链接。

**为什么这版不同**：从"AI 凭直觉吐槽"(可被一句"它会枪毙 Airbnb"打死)升级为"带 receipts 的反方会议"——更可信、更好传播、周末抄不走。证据层是护城河(接地)的第一块砖,也是通往未来 ontology 接地的路。

**本期目标**：先交付一个**可上线的 Web 应用**(一个 URL,好分享、好传播、好迭代),跑通"点子 → 证据包 → 反方议会 → 裁决"完整闭环,UI 采用 JARVIS 暗色图谱风(见第 9 节),并从第一天起把每次 run 落库(为未来的"裁决 vs 真实结果"数据集 = 真护城河)。Web 跑通后,用 Tauri 把同一套前端+后端包成 **macOS 版**。

---

## 2. 产品原则（不可妥协,每条都要有代码机制）

| # | 原则 | 代码层要求 |
|---|---|---|
| P1 | 真跨厂商,不许单模型扮多角色 | 反方席位必须调用不同 provider；<2 个真实参与方时标记 `simulated`,不出裁决 |
| P2 | 证据"检索"而非"生成" | 证据项必须来自真实检索结果,带真实 URL + 抓取时间 + 来源 + 原文片段；模型不得编造证据 |
| P3 | 强制反方 | 至少一个独立席位是"魔鬼代言人",被指令构造最强 kill-case,无论其他人是否同意 |
| P4 | 反方必须引用证据 | 每条反对挂 `evidenceId`；事后校验引用的 ID 必须存在,否则丢弃/标红 |
| P5 | 裁决跨席位聚合 | verdict 由所有席位投票/阈值得出,不能只取第一个席位 |
| P6 | 分数是辅助,不是主菜 | 主菜 = 裁决 + 致命假设 + 证据 + 7 天计划；分数若有,标"主观参考" |
| P7 | 密钥本地、隐私可控 | BYO key 存 macOS Keychain；不记录原始点子/key；检索用户点子要明示并可关闭 |

---

## 3. 核心用户流程（两段式,流式）

```
1. 输入点子/文案(纯文本,无语音)+ 选择模式(Idea / Copy)
2. [阶段A · 快] 事实侦察:并行调用 2-3 个检索器 → 结构化证据包(带ID/链接/时间)
   → 立即在 UI 展示证据包(用户先获得价值)
3. [阶段B · 慢,流式] 主脑基于证据整理 v1 方案
4. [阶段B] 跨厂商反方会议:各席位流式吐出观点,每条挂证据ID;魔鬼代言人强制反对
5. 引用校验:丢弃/标红引用不存在证据的条目
6. 裁决聚合 → 输出报告:Verdict / 致命假设 / Top风险(带证据链接) / 最便宜验证 / 7天计划
7. 落库(run + 证据 + 裁决);可复制 / 生成分享图(带各模型名 + receipts)
```

UI 必须**分两段**:阶段 A 的证据包先到先显示,阶段 B 的议会流式追加。绝不让用户对着 spinner 等到全部完成。

---

## 4. 数据模型（TypeScript 类型,作为实现契约）

```ts
type Mode = "idea" | "copy";

interface EvidenceItem {
  id: string;            // e.g. "E1"
  claim: string;         // 一句话事实，如"已有 X 在做类似事"
  url: string;           // 真实可点击链接
  source: "web"|"github"|"reddit"|"hn"|"producthunt"|"trends"|"other";
  title: string;
  snippet: string;       // 检索到的原文片段
  fetchedAt: string;     // ISO 时间，freshness
  credibility: "high"|"medium"|"low"; // 基于来源类型与信号
}

interface EvidencePack {
  items: EvidenceItem[];
  byTheme: {             // 结构化,不是搜索结果列表
    competitors: string[];   // evidenceId 引用
    demandSignals: string[];
    pricing: string[];
    saturation: string[];
  };
  searchedAt: string;
  redacted: boolean;     // 用户若关闭检索则 true
}

interface CouncilSeat {
  provider: string;      // 真实厂商名
  model: string;
  roleAngle: "demand"|"feasibility"|"devils-advocate"; // 按对抗角度,不按厂商
  stance: "Ship"|"Fix"|"Pause"|"Kill";
  take: string;
  objections: { text: string; evidenceId: string | null; valid: boolean }[];
  fatalAssumption: string;
  cheapestTest: string;
  latencyMs: number;
  ok: boolean;           // 失败=false,进 failures,不填默认值伪装
}

interface Verdict {
  decision: "Ship the test"|"Fix, then ship"|"Pause and validate"|"Kill or radically narrow";
  aggregatedFrom: number;     // 参与席位数
  dissentLevel: "Real"|"Low"|"Incomplete";
  simulated: boolean;         // <2 真实席位
}

interface RunRecord {        // 落库 = 护城河数据集
  id: string; mode: Mode; brief: string;
  evidencePack: EvidencePack; seats: CouncilSeat[]; verdict: Verdict;
  createdAt: string;
  outcome?: { followedUp: boolean; result: string; updatedAt: string }; // 未来回填"后来成没成"
}
```

---

## 5. 系统架构（macOS 原生,自包含）

**技术选型(已定,理由见第 10 节)：Tauri 2 + React + TypeScript。**

```
┌─────────────────────────────────────────────┐
│  macOS .app (Tauri 2 / Rust 外壳)            │
│  ┌──────────────┐   ┌──────────────────────┐ │
│  │ React 前端    │←→│ 本地服务(Node sidecar │ │
│  │ (暗色图谱UI) │   │ 或 Rust commands)     │ │
│  └──────────────┘   │  - 证据检索层         │ │
│         ↑           │  - 议会编排           │ │
│   Keychain(密钥)    │  - 引用校验/裁决聚合   │ │
│   SQLite(run落库)   │  - 直连各 provider API│ │
│                     └──────────┬───────────┘ │
└────────────────────────────────┼─────────────┘
                  ┌───────────────┼───────────────┐
              provider APIs   检索器(web/github/   缓存
              (BYO key)        reddit/hn/PH)      (SQLite)
```

- **去掉外部 agent-group 依赖**:议会编排(plan + challenge-all + 聚合)在本应用内实现。
- **密钥**:macOS Keychain(Tauri Stronghold 或 keychain 插件),不进 .env、不进日志。
- **落库**:SQLite(`tauri-plugin-sql`),存 `RunRecord`。这是唯一会复利的资产,Phase 1 就要建表。
- **检索层**:2-3 个检索器起步(见第 7 节),结果带 source/url/fetchedAt,缓存进 SQLite。
- **模型调用**:直连各 provider(OpenAI 兼容 + Anthropic),BYO key;失败走 `Promise.allSettled`,进 failures,不伪造。

> **本期是 Web 版,上面第 5 节那套(Tauri+Keychain+本地 SQLite)是后续 Mac 版。Web 版主路径如下:**
> - 前端 Vite/React 部署到 Vercel/Netlify;后端用 serverless / Node 服务跑议会编排 + 证据检索。
> - **密钥策略(Web 的命门)**:绝不把你的高价 key 给全网免费跑。两选一——① 用户前端填自己的 key,**每次请求带上、服务端只中转不存储**;② 你用便宜/开源模型 + 严格限额 + 缓存做"免费试一次",重度模式要求 BYO key。
> - 落库用 hosted DB(Postgres 或磁盘 SQLite);run 数据集照样攒。
> - 隐私:Web 托管=点子经过你服务器,必须明示 + 可关检索。
> - **Mac 版后做**:Tauri 复用同一套前端+后端,只把 key 换 Keychain、DB 换本地 SQLite。

---

## 6. 议会与裁决逻辑（核心算法,逐条实现）

1. **席位定义按对抗角度,不按厂商**(纠正旧版 `providerRole` 的 Qwen=中国GTM 错误):
   - 需求怀疑者(谁会付钱)、可行性/成本怀疑者(能不能造/持续)、**魔鬼代言人**(强制最强 kill-case)。
   - 角色分配给哪个厂商可配置;面向西方受众,别让模型母语偏向定义"市场"镜头。
2. **强制反方(P3)**:魔鬼代言人用独立 system prompt,明确"无论方案多好,给出最可能杀死它的理由"。
3. **引用校验(P4)**:解析每个 seat 的 `objections[].evidenceId` → 若 ID 不在 EvidencePack,`valid=false`,UI 标红或丢弃。统计"有效引用率"作为质量信号。
4. **裁决聚合(P5)**:对所有 `ok` 席位的 stance 计票:`Kill≥2→Kill`;`Pause≥2→Pause`;`Ship≥2 且 Kill=0→Ship`;否则 `Fix`。绝不只取 `seats[0]`。
5. **致命假设综合**:跨席位聚类风险,取被多个席位提及/最高严重度的,不是 `risks[0]`。
6. **simulated 门(P1)**:真实参与方(主脑 + 反方)<2 时,`verdict.simulated=true`,UI 明示"参与不足,非完整议会",不给正式裁决。
7. **JSON 健壮性**:解析失败的模型标记为失败(进 failures),**不要**用默认文案填充伪装成有效席位。

---

## 7. 证据检索层（薄,别做成 WorldMonitor）

借 WorldMonitor 的**原则**(搜索做成可组合小工具 + source/freshness 元数据),**不借架构、不抄代码(AGPL-3.0)**。

起步只做 2-3 类检索器,每个返回 `EvidenceItem[]`:
- **竞品/同类是否存在**:Web 搜索 + GitHub API(搜同类 repo)+ Product Hunt。
- **需求/抱怨信号**:Reddit + Hacker News(Algolia API)。
- (可选 Phase 后加)定价、Google Trends。

要求:
- 真实 URL + `fetchedAt` + `snippet`,**绝不让 LLM 生成证据**(P2)。
- 结果缓存进 SQLite,降成本降延迟。
- 成本控制:免费版 BYO 搜索 key 或用免费/便宜检索 + 狠缓存,源头限 2-3 个。
- 隐私(P7):检索会把用户点子发出去,UI 必须明示并提供"不检索"开关(`redacted=true`)。

---

## 8. 旧代码处置（重建时清理）

- **删/隔离**:`src/roastEngine.ts` 的写死 mock(含从未接入的 Gemini)——这是"假议会"隐患。
- **删**:死代码路径 `server/providers.mjs` 里没被调用的部分,或反过来以它为基(直连 provider)重建,二选一,留一个事实来源。
- **去掉**:`server/agentGroupClient.mjs` 对外部 agent-group 的依赖与硬编码路径。
- **硬化**:本仓库 `.gitignore` 加 `.env`、`.env.local`、`.env*.local`(别只靠全局忽略)。

---

## 9. UI / UX 设计规范（参考"Cognitive Surface"暗色图谱风）

### 9.1 设计语言
- 背景近黑 `#0B0E14`;面板 `#12161F`,圆角 14px,细边框 `rgba(255,255,255,0.06)`。
- 主文字 `#E6E9EF`,次要 `#8A93A6`;遥测数字用等宽字体。
- 强调色 = 琥珀/橙 `#E8A15A`(活跃节点光晕、主按钮)。图谱节点蓝灰 `#5B6B82`,活跃节点琥珀发光。
- 整体克制、留白大、暗、像"仪表盘",不像表单。

### 9.2 三栏布局（把截图每个区域映射成对 Roast 有意义的语义）

| 区域 | 截图里是 | 在 Roast 里改成 |
|---|---|---|
| 顶栏 | 贾维斯·Cognitive Surface | **Roast My Idea · Decision Council** + 运行状态 |
| 左栏 | 用户消息处理器 + 节点球 + Constraint/Memory… | **输入与运行**:点子输入框、模式切换(Idea/Copy)、运行按钮、迷你统计(证据数 / 来源数 / 模型数 / 有效引用率)。节点球→运行状态 orb |
| 中央 | 力导向知识图谱 | **核心:实时议会图谱**(见 9.3)——这是产品的灵魂,不是装饰 |
| 右栏 | 状态:已连接/节点/连线/TOK·S + Tick·心跳·思考·工具 | **运行遥测**:已连模型(live/failed)、证据项数、有效/丢弃引用数、分歧等级、Tokens/s、耗时;Tick→**流水线阶段指示**(检索中→整理→对线→综合) |
| 底栏 | 按住空格键开始说话 / 发送 | **输入条**:粘贴点子(纯文本,**不做语音**)+ 主按钮"Run council" |
| 左下 | 重置节点图 / 图谱调节 | **图谱控制**:重置布局 / 过滤(只看分歧/只看证据) |

### 9.3 中央"实时议会图谱"语义（核心必做,P1 即开始,产品灵魂）
- **节点**:① 中心 = 点子;② 各模型(按厂商着色);③ 证据项(EvidenceItem)。
- **连线**:模型→证据(引用)、模型↔模型(分歧)、证据→点子(支持/反驳)。
- **动效**:阶段 A 证据节点先点亮;阶段 B 模型节点依次"发言"时发光,引用证据时连线亮起,分歧用红色边。
- **价值**:这同时是①差异化证明(看得见真·多模型+receipts)②娱乐/留存(看 AI 带证据对线)③分享对象(截图带各模型名+证据)。

### 9.4 状态机
`idle → searching(阶段A) → evidence-ready → debating(阶段B,流式) → validating(引用校验) → verdict` ;任意模型失败→降级显示该节点 failed,不中断全场;<2 真实参与→`simulated` 态。

---

## 10. 技术选型理由

| 阶段 | 选型 | 理由 |
|---|---|---|
| **本期 Web(选它)** | Vite + React + TS 前端 + Node/serverless 后端 | 复用现有代码;最快上线;一个 URL 好分享/传播(契合 HN/PH/X 发布);JARVIS UI 是 HTML/SVG,浏览器原生支持 |
| **后续 Mac** | **Tauri 2** 包同一套前端+后端 | 产出真 .app 体积小;key 换 Keychain、DB 换本地 SQLite,改动小 |
| 不选 | Electron(重、Mac 原生感弱) / SwiftUI(要重写、丢 React) | — |

---

## 11. 分阶段交付（强制,按序;每阶段有验收）

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| **P0 清理+自包含** | 去 agent-group 依赖、去硬路径、硬化 .gitignore、删/隔离 mock、建 RunRecord 表(Web 用 hosted DB,Mac 用本地 SQLite) | `git` 不会提交 key;无外部服务依赖;空跑不出现伪造议会 |
| **P1 真议会核心 + 图谱骨架(Web)** | Vite 构建可部署 Web 应用 + 定 key 策略;直连各 provider(BYO key);**裁决跨席位聚合 + 强制魔鬼代言人 + simulated 门**;**中央实时议会图谱的可用骨架**(节点=模型,发言发光,分歧红边,流式) | 真·多厂商→聚合裁决;<2 厂商 simulated;每次 run 落库;**图谱能看见模型实时发言与分歧(非占位、非假数据)** |
| **P2 证据层 + 图谱接证据** | 2-3 个检索器 → EvidencePack(带链接/时间)→ 两段式 UX(证据先显示)→ 反方**引用证据ID + 校验**;**图谱加入证据节点 + "模型引用证据"连线** | 报告每条风险可点开真实来源;引用不存在的被标红/丢弃;可关检索;**证据→模型引用连线实时点亮** |
| **P3 图谱打磨 + 分享 + 遥测** | 流式动效、布局过滤(只看分歧/只看证据)、重置布局、**生成带 receipts 分享图**、右栏完整遥测、单模型失败降级 | 动效顺滑;分享图含各模型名+证据;遥测准确;单模型失败不崩全场 |
| **P4 上线 Web** | 部署(Vercel/Netlify + 后端)、限额/缓存、隐私说明、落地页 | 公网可访问;成本可控;可发 HN/PH/X |
| **P5 Mac 封装(Web 跑通后)** | 用 Tauri 把同一套前端+后端包成 .app,key→Keychain,DB→本地 SQLite | .app 跑出与 Web 一致的议会;无外部依赖/硬路径 |

**不要做(本期)**:**语音输入(已砍)**、账号系统、团队协作、56 层数据、WorldMonitor 那套 registry/JMESPath、付费层。

---

## 12. 安全与隐私（P7 展开）

- 密钥存 macOS Keychain,绝不进 `.env`/日志/前端;`.gitignore` 加 `.env*`。
- 不持久化原始点子明文除非用户同意(落库可加开关/本地加密)。
- 检索会外发点子→UI 明示 + "不检索"开关;对怕被抄的用户给"仅本地模型"或"redacted"模式。
- 错误信息脱敏后再给前端,别把上游 provider 原始报文透传。
- 中国模型(Kimi/DeepSeek/Qwen)对西方用户是信任点:provider 列表透明 + 允许只选西方模型。

---

## 13. 风险（给 Claude Code 和 Bryan 都看）

| 风险 | 应对 |
|---|---|
| 范围膨胀(原生+图谱+证据+语音一起上) | 严格按 P0→P4 顺序,实质先于眼睛糖 |
| 证据层自己幻觉,反而镀假权威 | P2:只用真检索结果,绝不让 LLM 编证据 |
| "搜竞品"=validator 标配,非差异化 | 差异化是"证据 + 被逼引用的跨厂商对抗议会"的组合,两者都要在 |
| 延迟(检索叠 7 分钟议会) | 两段式 + 流式;检索缓存;反方限轮数/限席位 |
| 图谱沦为装饰 | 图谱必须映射真实的证据/模型/分歧(9.3),不是好看而已 |
| 护城河仍是壳(易抄) | 从 P0 落库 run+裁决,P 后回填 outcome,攒"裁决 vs 结果"数据集 |

---

## 14. 一句话收口
重建的目标不是"做个更炫的吐槽器",是做一个**自包含、有真实证据、跨厂商被逼着引用证据对线、裁决可信、每次 run 都在攒数据集**的 macOS 决策陪练。炫的图谱是核心必做——但它必须可视化**真实**的议会(真模型、真证据、真分歧),实质与图谱一起做,绝不让漂亮的图谱去渲染一个假的或坏掉的议会。
