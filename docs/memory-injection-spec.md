# ROAST · Memory 注入规格(P1 — 把"越用越懂你"叫醒)

> 现状:`memories` 已落库 + Reflection 已写入 + WORKSPACE 可查,但**未注入各站 system prompt**(§11 自标)。本规格补这一步。
> 标 ★ = 必守。依据:已上线《产品设计文档》§9.2 Memory + 反共识/白箱原则。

---

## 0. 目标与命门

- **目标**:让陪练/议会/产出/自动档/马仔在干活时**读到该用户的偏好与本项目判断**,从"每次从零"变成"越陪越懂你"。
- **★ 命门(最容易做歪)**:记忆**不能把 AI 变成顺着你的回音室**。尤其议会——注入记忆是为了让反方**更精准地拷问你的倾向**,不是让它停止反对。**记忆喂给对抗席 = 弹药,不是马屁。**

---

## 1. 注入什么(按 category 分策略,不全注)

| category | 性质 | 注入策略 |
|---|---|---|
| `preference` | 用户稳定偏好/价值观(少、广适用) | **广注**(取最近/最常出现 top-N) |
| `pattern` | 跨项目规律(少、广适用) | **广注**(top-N) |
| `product_judgment` | 某讨论形成的判断(多、领域特定) | **★ 相关性门控**:只注「同一 discussion」+「与当前 brief 关键词相关」的;否则跨项目污染 |

- **★ 全部受 token 预算上限**(如 ≤ 8 条 / ≤ X tokens),超出按 recency/相关度截断。

---

## 2. 选取(MVP 不上向量)

```
selectMemories(userId, discussionId, brief, station):
  pref   = topN(preference by recency, n=3)
  pat    = topN(pattern by recency, n=2)
  judg   = product_judgment where (source_discussion_id == discussionId)
                              OR keywordOverlap(content, brief) >= 2
           , capped topN by recency
  return capByTokenBudget(pref + pat + judg)
```
- MVP 用关键词重叠做 `product_judgment` 相关性;记忆量大(几百条)再升 embedding 语义检索(§9.2 计划)。
- 全程按 `user_id` 过滤(分租,已具备)。

---

## 3. 注入位置与顺序

- 在各站 server-side handler,**system prompt 开头**拼一个带标签的记忆块,**位于 skill 块之前**:
```
[关于这位用户(记忆,软引导非事实,可被当前上下文覆盖)]
- 偏好:…
- 模式:…
[本项目已形成的判断]
- …
---
[Skill: name] …        ← 已有 skill 注入
---
[任务] …
```
- 顺序:**记忆(你是谁/项目判断)→ skill(怎么做)→ 任务**。

---

## 4. 各站注入策略(★ 含议会防回音室)

| 站 | 注入 | 用法措辞 |
|---|---|---|
| 陪练(clarify) | pref + pat + 本项目 judg | "按他的方式帮他想清楚" —— 软引导,可顺 |
| **议会(council/roast)** | pref + pat + judg | **★ "以下是用户的倾向,你的任务是精准压测它,而非迎合;魔鬼代言人尤其不得因其为用户偏好而让步"** |
| 产出(produce) | pref + pat + 本项目 judg | 让产物匹配他的风格/格式 |
| 自动档(auto) | 同陪练(建设型) | 帮搭结构化简报 |
| 马仔(agent) | pref(输出格式偏好)+ 相关 judg | 轻注,影响产物形态 |

---

## 5. 白箱 + 防腐

- **白箱**:UI 显示「本次参考了 N 条记忆」可点开看具体哪几条;用户能删(WORKSPACE 已有)、能纠。
- **软引导非事实**:prompt 里明确"记忆是偏好/判断,非事实,可被当前证据/上下文覆盖"。
- **过时**:按 recency 优先;后续可加轻量 confidence/衰减;错的让用户在 WORKSPACE 删。
- **★ 不让记忆压过反共识**:议会注入只增"被挑战的靶子",不增"必须认同的结论";最硬 kill 仍不可静音。

---

## 6. 给 Claude Code 的实现要点
1. 新增 `selectMemories(userId, discussionId, brief, station)`(§2)+ `formatMemoryBlock(memories, station)`(§3/§4,议会用对抗措辞)。
2. 在陪练/议会/产出/auto/马仔的 handler:system prompt 开头 = `formatMemoryBlock(...)` + 现有 skill 注入 + 任务。
3. ★ 议会/魔鬼代言人的记忆块用"压测倾向、不得让步"措辞;最硬 kill 不可静音不变。
4. token 上限 + recency 截断;`product_judgment` 相关性门控(同讨论 || 关键词≥2);MVP 关键词、后续 embedding。
5. 返回"已注入记忆列表"给前端做白箱展示(可点开/删)。
6. 全按 user_id 过滤;记忆标注"软引导非事实,可被覆盖"。

---

## 7. 验收
- 同一用户跨讨论:新讨论里能看到 his preference/pattern 被注入(白箱可见 N 条)。
- product_judgment **不**跨无关项目污染(注入列表里看不到无关项目的判断)。
- ★ 议会仍会反对用户偏好(注入记忆**没有**让反方变软;最硬 kill 仍在)。
- 删除某条记忆后,下次该条不再注入。

---

## 8. 实现状态(2026-06-29 落地)

✅ 已实现(P1),含动手前与 Claude 对齐的两条修正:

- **修正 ①(命门加固)**:议会(council)**只注 preference/pattern,不注 product_judgment** —— 判断要被重新拷问,不是免检通行证。`POLICY.council.judg = 0`(`server/memory.mjs`)。
- **修正 ②(验收升级)**:每站注入支持 `body.memory === false` 关闭开关,用于"注入前后火力对照"——验"反方有没有变软"要比 stance/Kill 强度分布,而非只验"还有没有反对"。

落地点:
- `server/memory.mjs`:`selectMemories`(按站 POLICY + 关键词门控)/ `formatMemoryBlock`(议会对抗措辞 vs 其余软引导)/ `buildMemoryInjection`(取→选→格式化,user_id 缺失安全空注)。
- `server/index.mjs`:5 站 handler(/respond 陪练·议会、/deliberate 议会·想清楚、/produce、/autopilot/round、/agent)在 skill 块**之前**前置记忆块,并 SSE 广播 `memories` 事件供白箱。
- `src/main.tsx` + `src/theme.css`:`memChipFor()` 白箱 chip("本次参考了 N 条记忆 ▾",议会标"压测靶子"),点开看具体条目 + 跳 WORKSPACE 删。

⏳ 留作后续(本期未做,不阻塞):
- `pattern` 类别注入端已留位,但写入侧 Reflection 暂只产出 `preference`/`product_judgment` —— 有了 pattern 即自动生效。
- 写入侧置信度/出现次数门槛 + 衰减(防 garbage-in);跨 provider 偏好泄露标注(讨论中提出的第 3/4 点,待拍板)。
- 记忆量大后 product_judgment 升 embedding 语义检索(现为关键词重叠 MVP)。
