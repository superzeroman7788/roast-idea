# Roast — 审议引擎设计（白箱 · 人在环中 · 反共识）

> 这是产品的核心与护城河。议会流程以本文为准,PRD §6 引用本文。
> 北极星:**不是给"更准的答案",是"帮人想明白"。** 白箱,对 Fusion 的黑箱。

---

## 1. 与 Fusion 的根本区别（定位 = 护城河）

| 维度 | OpenRouter Fusion(黑箱) | Roast(白箱) |
|---|---|---|
| 目标 | 合成一个**更准的答案** | **放大反方 + 帮人做判断** |
| 箱体 | 黑箱:返回一坨合成结果 | 白箱:署名模型、分歧、证据全可见 |
| 人 | 不参与 | **人在环中**:认领/搁置/钉死/反驳,人塑形结论 |
| 共识 | 求共识,把"一致"当高置信 | **反共识**:守住最硬的反对,不被抹平 |
| 数据 | 无 | **偏好数据**(赞/踩)越用越懂你,可复利 |

> 一句话对外:**别卖"multi-model"(那等于让人去用 Fusion);卖"会带 receipts 来杀你点子、并帮你自己想明白的 AI"。**

---

## 2. 角色（5 席,按对抗角度,不按厂商）

| 席位 | 角色 | 职责 |
|---|---|---|
| 主脑 Organizer | 整理者(不当裁判) | 读点子+证据→结构化方案,挂证据 ID |
| 反方1 | 需求怀疑者 | 谁付钱?需求真伪?引证据 |
| 反方2 | 可行性/成本 | 造得出/可持续?引证据 |
| 反方3 | **魔鬼代言人(强制)** | 无论多好,给最强"会死"kill-case |
| 事实核查 Verifier | 独立核查 | 核查各反方事实陈述 vs 证据(引用校验的角色化),驳掉无证据支撑的断言 |
| 主席 Chairman | 综合者(不自由裁决) | 产出审议综述 + 据"人策展集合"收敛 |

主席用与主脑不同的厂商;角色↔厂商可配置。

> **本设计 = MAD(多智能体辩论)的一个实例。** 映射:主脑≈Responder/Proposer;三反方≈Debaters(魔鬼代言人=Multi-Persona 的 devil);Verifier=事实核查;主席≈Summarizer+Moderator;Moderator 的"防懒惰/不跑题/何时终止"折进编排+自适应停止。
> **唯一关键 departure(命根):canonical MAD 用 AI Judge 决定"答案"(神谕);本产品把 Judge 交给人(白箱+人策展),AI 不下最终判——这正是与 Fusion/普通 MAD 的分界。** 不引入软件团队那套 PM/架构/开发/测试 agent(领域不符)。
> Roadmap:可借 AgentVerse 的"HR"思路,按点子领域动态招募专家反方(如金融点子招"合规反方")。

### 2.1 角色库 + 可配置席位（默认3,可换角/加角）

**角色(persona)与模型(engine)解耦**:persona = 视角+systemPrompt;引擎 = 可用模型(当前 6 个)。用户选视角,系统把任意可用模型分配给每席。**绝不写死"某厂商=某角色"。**

- **中立/功能席自动**(不让用户选):主脑 Organizer · Verifier 事实核查 · 主席 Chairman · 人=Judge。
- **反方席默认 3 + 魔鬼代言人**;用户可换角/加角,**上限=可用模型数**。
- **Idea 默认反方**:投资人 · 增长·分发 · 可行性(+魔鬼);**库里备选**:目标用户、竞争·护城河、领域专家(合规/临床/隐私,动态招募)。
- **Copy 默认反方**:传播编辑 · 目标读者 · 怀疑读者(+魔鬼)。

**两条护栏(不可妥协):**
1. **魔鬼代言人 `locked=true`,任何自定义配置都不可删**(守反确认偏误)。
2. **加角=加成本/延迟/重叠噪音**:配置界面给成本与耗时预估;默认 3 是为便宜快,加到上限是 power user 选择。

```ts
interface Persona { id; name; angle; mode:"idea"|"copy"|"both"; kind:"functional"|"opinionated"; locked?:boolean; systemPrompt }
interface SeatConfig { personaId; modelId }            // 用户配置:角色↔模型
interface RunConfig { mode; seats: SeatConfig[]; autoRecruitDomain: boolean }
```
默认 `RunConfig` 按模式预置;`devils-advocate.locked=true`;`autoRecruitDomain` 开启则按领域临时加一个专家反方。

### 2.2 对话姿态（修复"纯找茬"：共创 ↔ 拷问）

Roast 不应只有"找茬"一种姿态。北极星"帮人想明白"**既包括拷问、也包括共创澄清**。加一个 posture 维度(独立于 Idea/Copy):

- **想清楚 / Clarify（共创,默认入口）**:你 + 主脑(可选 1 个"建设者")。主脑帮你**结构化、追问关键细节、从你的角度补完整、给建设性角度**——像聪明的搭子,不开火。**不召集对抗反方、不强制 kill。**
- **审议 / Council（平衡）**:多视角综述 + 温和质疑,摆出分歧但不强逼最硬 kill。
- **拷问 / Roast（对抗）**:全套对抗议会 + 强制魔鬼代言人(本文主体)。

**默认流**:先 Clarify(主脑陪你理清细节)→ 理清后一键"送进议会拷问"。**姿态由人控制**,不被强行塞进找茬机。

> ⚠️ Clarify ≠ 谄媚。它仍要 **sharp、诚实、会追问**(给真角度 + 真问题,如那张"主大脑"截图),只是姿态是"帮你建/想清楚",不是"试图杀死"。别借 Clarify 滑回拍马屁。

数据模型:`RunConfig.posture: "clarify"|"council"|"roast"`;`clarify` 下反方/魔鬼关闭,只跑主脑(+可选建设者);`roast` 才开强制魔鬼;裁决/不可静音等硬规则只在 `council`/`roast` 生效。

---

## 3. 流程（轮次 — 关键改动:加"人策展 → 主脑收敛"）

```
A 证据侦察(见 evidence-search-design.md)——先显示
B 议会(白箱发散):
  R1 立靶   主脑基于证据出结构化方案
  R2 独立并行开火 三反方各自审查,必须引证据;魔鬼代言人强制反对
  R3 匿名交叉互驳(仅"严酷"档) → 真分歧
  ✓ 引用校验  引用不存在证据的标红/丢弃
  ▣ 审议综述  主席产出 Fusion 式结构(见 §4),白箱展示全部观点
C 人策展(新,核心):
  人对每条观点 👍认领 / 👎搁置 / 📌钉死必答 / 插一句反驳
D 主脑收敛(人 steered):
  仅基于"人策展集合"收敛 → 被认领的逐条应对;搁置的留痕降权;
  魔鬼代言人最硬 kill-case 不可静音(见 §7)
E 输出  「你想明白了什么 / 待验证 / 最便宜验证」(见 §6),非 AI 裁决
```
顺序理由:独立先于交叉(避免趋同)、交叉匿名(减让步偏差)、**人策展在收敛之前**(让人塑形而非读裁决)。

---

## 4. 借鉴 Fusion:Judge 输出结构（白箱审议综述）

R2/R3 后,主席产出一份**结构化审议综述**(直接借 Fusion Judge,经实战验证):

- **共识 Consensus**:多数席位认同的点(标高置信,但**不当成结论**)。
- **矛盾 Contradictions**:席位间冲突 → 这就是给人看的"分歧"。
- **部分覆盖 Partial coverage**:只有部分席位提到的。
- **独有洞见 Unique insights**:某个模型独有的尖锐点。
- **盲点 Blind spots**:**谁都没提到、但重要的**——做成报告亮点字段。

> 与 Fusion 不同:这份综述是**给人策展用的白箱中间产物**,不是终稿。

---

## 5. 借鉴 OpenRouter 的 plumbing（直接用,省事又稳）

- **Response Healing**:自动修复畸形输出——治"OpenRouter free / 某模型 JSON 不稳"。
- **Structured Outputs**:强约束席位输出的 JSON schema(stance/objections/evidenceIds…)。
- **Guardrails**(prompt 注入 / 敏感信息)可选。
- **web_search / web_fetch server tools**:证据层的兜底(主力仍是 SearXNG 五类策展,见证据文档)。

---

## 6. 输出重定义（帮人想明白,不是神谕）

主产物不是"AI 判 Ship/Kill",而是:
- **你现在更清楚了什么**(人策展后沉淀的认知)
- **还没验证的关键问题**(open questions)
- **最便宜的验证动作**(cheapest tests / 7 天)
- **被认领反方的逐条应对**(主脑收敛)
- **你搁置了什么**(留痕,白箱诚实)
- (可选)**各 AI 视角** + 一个 AI take —— 明确标注"**这只是一个意见,不是答案**"

Idea / Copy 各自字段沿用(Idea:致命假设/风险/7天;Copy:hook/清晰度/改写/可发布版)。

---

## 7. 反共识 & 反确认偏误（硬规则,必须内建)

白箱+点赞最大的风险:**人只挑爱听的 → 主脑围着收敛 → 反谄媚工具变拍马屁机**。三条对策必须实现:
1. **点赞 ≠ 同意**:`endorse` 语义是"**这点尖锐、我要处理**",不是"我认同"。UI 文案与数据分清。
2. **最硬 kill-case 不可静音**:`isHardestKill` 的观点即使被全部 👎,收敛输出仍要回一句"**你回避了这 N 条最硬的,但它们还在这**"。人能调重点,删不掉最硬的真相。
3. **搁置留痕**:被 setAside 的写进"你搁置了什么",不抹掉。
此外:① 裁决(若给)仍是**透明投票**,不被主席独断;② 真实参与方 <2 → `simulated`,不给正式结论。

---

## 8. 数据模型

```ts
interface Viewpoint {
  id: string;                 // "V1"
  seat: string; roleAngle: "demand"|"feasibility"|"devils-advocate"|"organizer";
  stance: "Ship"|"Fix"|"Pause"|"Kill";
  text: string; evidenceIds: string[];   // 经 P4 校验
  isHardestKill?: boolean;    // 强制反方的最强 kill,不可静音
  round: 1|2|3;
}
interface HumanSignal {
  viewpointId: string;
  action: "endorse"|"setAside"|"pin"|"reply"; // endorse=尖锐要处理(≠agree)
  note?: string; at: string;
}
interface Deliberation {       // Fusion 式审议综述(白箱中间产物)
  consensus: string[]; contradictions: string[]; partialCoverage: string[];
  uniqueInsights: { seat: string; text: string }[]; blindSpots: string[];
}
interface ConvergedOutput {    // 人 steered 收敛
  clarified: string;           // 你想明白了什么
  addressed: { viewpointId: string; response: string }[]; // 认领的逐条应对
  setAside: { viewpointId: string; reason: string }[];    // 搁置留痕
  unsilenceable: string[];     // 不可静音的最硬 kill
  openQuestions: string[]; cheapestTests: string[];
  aiTake?: { verdict: string; disclaimer: "仅一个意见,不是答案" };
  verdictVote?: { decision: string; tally: Record<string,number>; simulated: boolean };
}
```

---

## 9. 人机交互
- 每条观点:👍认领 / 👎搁置 / 📌钉死必答 / 插一句反驳;可展开看引用证据原文(证明不编)。
- **再辩一轮**:针对📌钉死的点深挖(迭代地想)。
- **收敛成方案**:把人策展集合交给主脑,产出 §6 输出。
- 全程白箱:谁说的、引了什么证据、人怎么处理的,都可见可追溯。

---

## 10. 护城河小结
机制(多模型/合成)是水电,Fusion 已商品化。**Roast 的护城河 = 白箱 + 人在环中共创 + 反共识守硬骨 + 偏好数据 + 策展过的证据**——这些 Fusion 结构上做不出来,也不是一次 API 调用能克隆的。卖点:**帮你想明白,而不是替你下结论。**

---

## 11. 给 Claude Code 的实现要点
- 议会分两段:**发散(B)**与**收敛(D)**之间夹一个**人策展(C)**;收敛只吃人策展过的集合。
- `endorse` 与 `agree` 在数据与文案上分开;`isHardestKill` 全链路保留并在收敛时强制 surface。
- 审议综述、收敛输出都用 Structured Outputs 约束;畸形输出走 Response Healing。
- 记录所有 HumanSignal = 偏好数据集(护城河),从第一天落库。
