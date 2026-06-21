# ROAST · 点子陪练 (Sparring Council)

一个独立 web 应用:把你的**一个点子或一段文案**,和**多个不同厂商的 AI** 一起,**多回合讨论辩论、你在场参与**,辩成一个**更好的方案**——不是给"行 / 不行"的裁决。

## 它做什么

1. **共享信息板** — 开场先检索真实外部信息(竞品 / 需求信号 / 定价,来自 Hacker News + GitHub),你能浏览、AI 能引用,讨论时事实对齐。
2. **多 agent 讨论** — 主持 / 建设者 / 需求怀疑者 / 可行性怀疑者 / 魔鬼代言人,各由**不同厂商**的模型扮演,轮流发言;你能**插话、让它们再辩一轮**。
3. **收敛成方案** — 综合者把整场辩论收敛成结构化方案(一句话定位 / 目标用户 / 方案要点 / 最大风险与对策 / 最便宜验证)。
4. **多格式导出** — Markdown / 图片 / Word(.docx) / PPT(.pptx)。

**原则**:跨厂商真讨论(不是单模型扮多角色);反方引用**真实证据**且事后校验(编造的引用标红);失败的 agent 降级显示,**绝不伪造**。

## 跑起来

```bash
npm install
npm run dev      # Vite 前端 :5173 + Node 后端 :8787
```

打开 http://localhost:5173 。设了访问密码就先输密码进入。

## 配置(`.env.local`,已 gitignore)

- **Provider key**(BYO;服务端只中转、**不落库 key**):`OPENAI_API_KEY` / `KIMI_API_KEY` / `DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `ANTHROPIC_API_KEY`。配 **≥2 家**才能形成讨论。
- **访问密码门**(内部分发):`ROAST_ACCESS_PASSWORD=...`(不设则门默认开)。
- 模板见 `.env.example`。

## 架构

- **前端**:Vite + React + TS,JARVIS HUD。`src/`:启动页 `Landing.tsx`、讨论台 `main.tsx`、议会图谱 `CouncilGraph.tsx`、类型 `discussion.ts`、导出 `exportDoc.ts`、主题令牌 `theme.css`。
- **后端**:Node 标准库 HTTP + SSE(`server/index.mjs`);跨厂商直连 `providers.mjs`;证据检索 `evidence.mjs`;`node:sqlite` 落库 `db.mjs`(`discussions` / `discussion_turns` + 证据缓存)。
- **API**:`POST /api/discussion/start`、`POST /api/discussion/:id/respond`、`POST /api/discussion/:id/finalize`(均 SSE)、`GET /api/discussion/:id`、`POST /api/auth`、`GET /api/status`。

## 路线

- **当前**:Web 版(一个 URL,好分享、好内部分发)。
- **后续**:用 Tauri 把同一套前后端封装成 macOS 版(key 换 Keychain、DB 用本地 SQLite)。
