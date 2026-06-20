import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const AGENT_GROUP_DIR =
  process.env.AGENT_GROUP_DIR || "/Users/bryan/agent group/agent-group";
const AGENT_GROUP_URL =
  process.env.AGENT_GROUP_URL || "http://127.0.0.1:8766";
const AGENT_GROUP_CONFIG = path.join(AGENT_GROUP_DIR, "config", "room.json");

let agentGroupProcess = null;

export function getAgentGroupConfig() {
  const raw = fs.readFileSync(AGENT_GROUP_CONFIG, "utf8");
  const config = JSON.parse(raw);
  const meeting = config.decision_meeting || {};
  const challengers = (meeting.challengers || []).map((challenger) => ({
    id: challenger.id,
    label: challenger.name || challenger.id,
    runner: challenger.runner || "disabled",
    configured: Boolean(challenger.enabled),
    model: challenger.model || challenger.runner || "local",
  }));

  return {
    url: AGENT_GROUP_URL,
    room: config.room || {},
    mainBrain: {
      label: meeting.main_brain?.runner || "main_brain",
      configured: Boolean(meeting.main_brain?.enabled),
      runner: meeting.main_brain?.runner || "disabled",
    },
    challengers,
  };
}

export async function getAgentGroupStatus() {
  const config = getAgentGroupConfig();
  try {
    await ensureAgentGroup();
    const projects = await requestJson("/api/projects", { method: "GET" });
    return {
      ok: true,
      ...config,
      projects: projects.projects || [],
      defaultProject: projects.default,
    };
  } catch (error) {
    return {
      ok: false,
      ...config,
      error: error?.message || "agent-group unavailable",
      projects: [],
    };
  }
}

export function getAgentGroupProviderStatus() {
  const config = getAgentGroupConfig();
  return [
    {
      id: "agent-group-main-brain",
      label: "Agent Group main brain",
      protocol: config.mainBrain.runner,
      model: config.mainBrain.runner,
      configured: config.mainBrain.configured,
    },
    ...config.challengers.map((challenger) => ({
      id: challenger.id,
      label: challenger.label,
      protocol: challenger.runner,
      model: challenger.model,
      configured: challenger.configured,
    })),
  ];
}

export async function runAgentGroupCouncil({ mode, brief }) {
  await ensureAgentGroup();
  const agentGroupStatus = getAgentGroupConfig();
  const failures = [];
  const messages = [
    {
      role: "boss",
      content: buildBossPrompt({ mode, brief }),
    },
  ];
  let plan = null;
  let mainBrainSkipped = false;
  if (!agentGroupStatus.mainBrain.configured) {
    mainBrainSkipped = true;
    plan = fallbackPlan({
      mode,
      brief,
      error: "Claude main brain is disabled for this product council.",
    });
  } else {
    try {
    const planResponse = await requestJson("/api/decision/plan", {
      method: "POST",
      body: { messages },
      timeoutMs: 420000,
    });
    if (!planResponse.ok) {
      throw new Error(planResponse.error || "agent-group plan failed");
    }
    plan = planResponse.plan;
  } catch (error) {
    failures.push({
      provider: "Agent Group main brain",
      error: compactError(error),
    });
    plan = fallbackPlan({ mode, brief, error });
    }
  }

  let challenge = null;
  let challenges = [];
  try {
    const challengeResponse = await requestJson("/api/decision/challenge-all", {
      method: "POST",
      body: { plan },
      timeoutMs: 420000,
    });
    if (!challengeResponse.ok) {
      throw new Error(challengeResponse.error || "agent-group challenge-all failed");
    }
    const challengeAll = challengeResponse.challenge_all || {};
    challenges = challengeAll.challenges || [];
    for (const failure of challengeAll.failures || []) {
      failures.push({
        provider: failure.name || "Agent Group challenger",
        error: failure.error || "challenge failed",
      });
    }
    challenge = challenges[0] || {
      enabled: false,
      name: "Agent Group challenger",
      stance: "未完成",
      risks: ["Agent Group 没有任何挑战者成功返回，本轮不能算真实反方会议。"],
      omissions: [],
      suggestions: ["先修复 agent-group 的对应 runner / key，再重新运行。"],
      raw: "",
    };
  } catch (error) {
    failures.push({
      provider: "Agent Group challenger",
      error: compactError(error),
    });
    challenge = {
      enabled: false,
      name: "Agent Group challenger",
      stance: "未完成",
      risks: ["Agent Group 挑战者调用失败，本轮不能算真实反方会议。"],
      omissions: [],
      suggestions: ["先修复 agent-group 的对应 runner / key，再重新运行。"],
      raw: "",
    };
  }

  return {
    mode,
    brief,
    plan,
    challenge,
    challenges,
    status: agentGroupStatus,
    failures,
    mainBrainSkipped,
  };
}

async function ensureAgentGroup() {
  if (await canReachAgentGroup()) return;
  if (!agentGroupProcess || agentGroupProcess.exitCode !== null) {
    agentGroupProcess = spawn("python3", ["cli.py", "serve"], {
      cwd: AGENT_GROUP_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    agentGroupProcess.stdout.on("data", (chunk) => {
      process.stdout.write(`[agent-group] ${chunk}`);
    });
    agentGroupProcess.stderr.on("data", (chunk) => {
      process.stderr.write(`[agent-group] ${chunk}`);
    });
  }
  const started = await waitForAgentGroup(12000);
  if (!started) {
    throw new Error(`agent-group did not start at ${AGENT_GROUP_URL}`);
  }
}

async function canReachAgentGroup() {
  try {
    const response = await fetch(`${AGENT_GROUP_URL}/api/projects`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForAgentGroup(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canReachAgentGroup()) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

async function requestJson(route, { method, body, timeoutMs = 15000 }) {
  const response = await fetch(`${AGENT_GROUP_URL}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    throw new Error(data.error || `agent-group HTTP ${response.status}`);
  }
  return data;
}

function buildBossPrompt({ mode, brief }) {
  const target =
    mode === "copy"
      ? "请诊断这段产品文案，不要预测会不会火，重点找 hook、清晰度、谁会买、哪句像废话、最小改写方向。"
      : "请评估这个产品想法，不要给假精确分数，重点找致命假设、最便宜验证方式、Ship/Fix/Pause/Kill 方向。";
  return `${target}

硬要求:
- 这是 Roast My Idea MVP 的真实反方会议，不允许把同一个模型伪装成多个角色。
- 输出要能被另一个厂商的挑战者反驳。
- 主菜是裁决、致命假设、风险和 7 天验证动作；分数不是主菜。

用户输入:
${brief}`;
}

function fallbackPlan({ mode, brief, error }) {
  const title = mode === "copy" ? "Copy roast fallback plan" : "Idea roast fallback plan";
  return {
    title,
    objective:
      mode === "copy"
        ? "诊断文案里的过度承诺、hook 清晰度和最小改写方向。"
        : "找出想法里最可能杀死项目的假设，并设计最低成本验证。",
    context: brief,
    approach:
      "Agent Group 主大脑本轮不可用，roast-idea 仅把用户输入包装成结构化计划后交给已启用挑战者审查。",
    output_criteria:
      "返回裁决方向、致命风险、遗漏、具体修改建议和一条本周能执行的验证动作。",
    constraints: `主大脑失败: ${compactError(error)}`,
    checkpoints: "修复主大脑认证后重新跑完整会议；当前结果只能作为不完整反方诊断。",
  };
}

function compactError(error) {
  const text = String(error?.message || error || "unknown error").replace(/\s+/g, " ");
  if (/authentication_failed|Invalid authentication credentials|api_error_status\"?:401|401/.test(text)) {
    return "Claude Code authentication failed (401). Re-authenticate the Claude CLI or switch the Agent Group main brain runner.";
  }
  if (/OPENAI_API_KEY/.test(text)) {
    return "OpenAI challenger is missing OPENAI_API_KEY in the environment used to start Agent Group.";
  }
  return text.replace(/\{[^\n]*\}/g, "[structured runtime output]").slice(0, 280);
}
