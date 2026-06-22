# Claude Code 开工 Prompt — Roast My Idea v2(Web 优先重建)

> 用法:把本文件整段贴给 Claude Code,让它**先读文档、按 P0→P1 顺序、带验收地**重建。

---

你正在重建 `roast-idea`(一个白箱、人在环中、反共识的"AI 决策陪练")。**先读完下列文档再动手,按阶段做,每阶段达到验收再进下一阶段。**

## 必读文档(本仓库 docs/)
- `PRD-roast-v2-mac.md` — 总纲(Web 优先,Mac 后置)
- `council-design.md` — **核心/护城河**:审议引擎(白箱·人策展·反共识·借鉴 Fusion)
- `evidence-search-design.md` — 证据/事实侦察层(SearXNG+Jina/Firecrawl+判断层)
- `UI-design-jarvis.md` — UI 设计令牌与规格
- 原型:`ui-mockup-jarvis-v2.html`、`ui-mockup-evidence-list.html`、`ui-mockup-council.html`(**UI 视觉参考,P3 才用;P1/P2 别碰视觉**)

## 不可妥协的原则(每条都要有代码机制,不是文案)
1. **绝不伪造议会**:任何时候不得把写死的 mock 或单模型扮多角色渲染成真实结果。示例必须明确标 SAMPLE。
2. **真跨厂商**:反方席位调不同 provider;真实参与<2 → `simulated`,不出正式结论。
3. **强制魔鬼代言人**:独立 prompt,给最强 kill-case;其最硬一条 `isHardestKill` 全链路保留、收敛时强制 surface。
4. **证据检索而非生成**:证据来自真实抓取(URL+时间+正文),判断层只据正文,不编。
5. **人在环中**:发散→**人策展(认领/搁置/钉死/插一句)**→主脑据策展集合收敛。`endorse`≠`agree`(语义="这点尖锐我要处理")。
6. **裁决透明**:若给裁决,用跨席位投票,不由主席独断;搁置项留痕不抹。
7. **自包含**:不依赖外部 agent-group,无 `/Users/...` 硬编码,密钥不进 .env/日志/前端。

## 技术栈(本期 Web)
Vite + React + TS 前端;Node/serverless 后端跑议会编排+证据层;hosted DB(或磁盘 SQLite)落 `RunRecord` + `HumanSignal`;provider 直连(Anthropic / OpenAI 兼容)或经 OpenRouter;**BYO key,服务端只中转不存**。可用 OpenRouter 的 Response Healing + Structured Outputs。**不引入 Tauri、不接 Claude Code CLI、MVP 不接中文源、不做语音。**

---

## P0 — 清理 + 自包含(先做,达到验收再进 P1)
1. 移除对外部 `agent-group` 的依赖与硬编码路径,把议会编排逻辑搬进本仓库。
2. 删除/隔离 `src/roastEngine.ts` 的写死 mock(含从未接入的 Gemini);示例数据明确标 SAMPLE,绝不当真实结果渲染。
3. 删掉死代码路径(`server/providers.mjs` 与 agent-group 路径二选一,留一个事实来源)。
4. 硬化 `.gitignore`:加 `.env`、`.env.local`、`.env*.local`。
5. 建库:`RunRecord` + `HumanSignal` 表(护城河数据,从第一天落)。
6. 接通 provider 直连/OpenRouter,BYO key(服务端中转不存)。

**P0 验收**:`npm run build` 通过、应用能起;无外部服务依赖、无硬路径;`git status` 不会暂存任何 key 文件;空跑/示例不会出现伪造议会。

---

## P1 — 议会引擎核心(无炫 UI,先把程序写对)
**目标:先写对引擎,UI 后置(P3)。** 本阶段只配一个**最小测试界面**(CLI 或裸 HTML/JSON dump)验证逻辑,不做 JARVIS 视觉、不做图谱。
按 `council-design.md` 实现:
1. **角色库 + 可配置席位 + 对话姿态**:persona≠model(绝不写死厂商=角色);默认 3 反方 + 魔鬼 `locked`;**`RunConfig.posture: clarify|council|roast`,默认 `clarify`(只跑主脑+可选建设者,关反方/魔鬼);`roast` 才开强制魔鬼 + 不可静音 + 裁决**(见 council-design §2.1–2.2)。
2. **编排**:主脑 + 可配置反方 + **Verifier** + 主席;R1 立靶 → R2 独立并行开火(必引证据)→ R3 匿名交叉(严酷档)。Structured Outputs 约束,畸形走 Response Healing。
3. **引用校验**:反方每条挂 `evidenceId`,不存在的标红/丢弃。
4. **审议综述**(借 Fusion Judge):consensus / contradictions / partialCoverage / uniqueInsights / **blindSpots**。
5. **人策展(先做成 API/数据层,不做炫 UI)**:`endorse`(≠agree)/`setAside`/`pin`/`reply`;`isHardestKill` 全链路保留。
6. **人 steered 收敛**:只吃人策展集合 → 输出「你想明白了什么 / 待验证 / 最便宜验证 / 认领逐条应对 / 搁置留痕 / 不可静音的最硬 kill」;裁决=透明投票;`simulated` 门。
7. **证据**:先用一个简单 web 搜索 **stub** 打通管线(完整 SearXNG/Jina 留 P2)。
8. **落库**:`RunRecord` + 每个 `HumanSignal`(从第一天)。

**最小测试界面**:CLI 或单页——输入点子 → 打印各席位观点 + 审议综述 → 命令行/按钮模拟 endorse/pin/setAside → 打印收敛输出。够验证逻辑即可,**不求好看**。

**P1 验收(API/CLI 级,不看视觉)**:真·多厂商跑通;verdict 跨席位聚合(非取第一个);<2 厂商→simulated;`endorse` 与 `agree` 数据上分开;**把所有难受观点都 setAside,收敛仍强制 surface 最硬 kill**;可配置席位(换角/加角/换模型)生效且魔鬼不可删;收敛反映策展;HumanSignal 落库;**posture=clarify 只跑主脑、不召反方/不强制 kill,可一键升级到 roast**。

---

## 后续(P1 引擎通过后,详见 PRD/证据文档)
P2 完整证据层(SearXNG+Jina,5 类,判断层,证据数据)→ **P3 UI(JARVIS:中央图谱 + 人策展 + 证据列表,见原型与 `UI-design-jarvis.md`)** → P4 上线 Web → P5 Tauri 封 Mac。
> 原型与 UI 规格是 **P3 才用**的视觉参考;P1/P2 别在视觉上花时间。

## 工作方式
- 小步提交,每完成一个验收点就停下报告。
- **遇到要扩大范围/改架构,先问再做**,别擅自加东西。
- 每个 UI 做完截图自检,和对应原型比对。

## 绝对不要
伪造议会 / 接 agent-group 或 Claude Code CLI / 硬编码路径 / 把高价 key 给全网免费跑 / 跳过人策展直接自动综合 / MVP 接中文源 / 做语音 / 在核心没跑通前先打磨图谱。
