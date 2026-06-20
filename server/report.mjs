// 报告聚合 —— 单一事实来源:基于直连 provider 的真实席位(server/providers.mjs)。
// 旧版 buildAgentGroupReport(依赖外部 agent-group)已随 agentGroupClient.mjs 一并删除。
const DECISION_ORDER = ["Kill", "Pause", "Fix", "Ship"];

export function buildReport({ mode, brief, results, status, evidencePack }) {
  const seats = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const providerCount = seats.length;
  const simulated = providerCount < 2; // P1: <2 真实参与方 → 不算完整议会

  // 引用校验(P4 原则):evidenceId 必须真实存在于 EvidencePack,否则 valid=false。
  const validIds = new Set((evidencePack?.items || []).map((e) => e.id));
  let citTotal = 0;
  let citValid = 0;
  for (const seat of seats) {
    for (const obj of seat.objections || []) {
      if (obj.evidenceId) {
        citTotal += 1;
        obj.valid = validIds.has(obj.evidenceId); // 引用不存在的证据 → 标 false(UI 标红/丢弃)
        if (obj.valid) citValid += 1;
      } else {
        obj.valid = false;
      }
    }
  }
  const citationRate = citTotal ? Math.round((citValid / citTotal) * 100) : null;

  const panel = seats.length
    ? seats.map((seat) => ({
        provider: seat.provider,
        role: seat.role,
        roleAngle: seat.roleAngle,
        stance: seat.stance,
        take: seat.take,
        objections: seat.objections || [],
        blindspot: `${seat.model} · ${seat.latencyMs}ms · ${seat.objections?.[0]?.text || seat.fatalAssumption || "—"}`,
      }))
    : status.map((provider) => ({
        provider: provider.label,
        role: provider.protocol,
        stance: "Pause",
        take: provider.configured
          ? "Configured, but no response was returned for this run. Check provider logs and model name."
          : `Not configured. Add ${envHint(provider.id)} to .env.local to let this vendor participate.`,
        blindspot: provider.configured
          ? "Configured provider failed before producing a council seat."
          : "No fake opinion generated. This seat is intentionally empty until a real key is present.",
      }));

  const verdict = simulated ? "Insufficient real dissent" : decideVerdict(seats);

  const topFatal = mostCommonUseful(seats.map((seat) => seat.fatalAssumption));
  const topTest = mostCommonUseful(seats.map((seat) => seat.cheapestTest));
  const stanceSpread = new Set(seats.map((seat) => seat.stance)).size;
  const failedText = failures.length
    ? ` Failed providers: ${failures.map((failure) => failure.provider).join(", ")}.`
    : "";
  const topRisks = rankedUnique(seats.map((seat) => seat.fatalAssumption)).slice(0, 5);
  const whatToCut = inferCuts({
    mode,
    risks: topRisks,
    suggestions: seats.map((seat) => seat.cheapestTest),
  }).slice(0, 4);
  const dissentMap = [
    ...seats.map((seat) => ({
      provider: seat.provider,
      stance: seat.stance,
      model: seat.model,
      status: "responded",
      keyRisk: seat.fatalAssumption || seat.objections?.[0]?.text || "",
    })),
    ...failures.map((failure) => ({
      provider: failure.provider,
      stance: "Failed",
      model: "",
      status: "failed",
      keyRisk: failure.error,
    })),
  ];

  return {
    verdict,
    summary: simulated
      ? `Only ${providerCount} vendor family responded. This run is not a valid council yet; configure at least two providers before treating it as real dissent.${failedText}`
      : `Real council run across ${providerCount} vendor families. The useful signal is the disagreement pattern, not a fake success score.${failedText}`,
    confidenceRange: simulated ? "Simulated / insufficient" : confidenceFor(seats),
    vendorSpread: `${providerCount}/${status.length} configured`,
    dissentLevel: simulated ? "Invalid" : stanceSpread >= 3 ? "High" : "Medium",
    hookClarity: mode === "copy" ? "Diagnosed by live council" : "N/A",
    nextAction: simulated ? "Add provider keys" : nextActionFor(verdict),
    fatalAssumption:
      topFatal ||
      "No provider returned a clean fatal assumption. Re-run with a more specific brief.",
    cheapestTest:
      topTest ||
      "No provider returned a clean cheap test. Ask for a narrower target customer and channel.",
    topRisks,
    whatToCut,
    dissentMap,
    copyDiagnosis:
      mode === "copy"
        ? copyDiagnosisFrom(seats)
        : "Copy mode was not selected for this run.",
    sevenDayPlan: sevenDayPlanFor({ mode, verdict, fatalAssumption: topFatal, test: topTest }),
    panel,
    debate: seats.length
      ? seats
          .map((seat) => ({ speaker: seat.provider, line: seat.debateLine }))
          .filter((entry) => entry.line)
      : [
          {
            speaker: "System",
            line: "No vendor seats responded. Add at least two provider keys before treating this as a real council.",
          },
        ],
    evidence: {
      items: evidencePack?.items || [],
      byTheme: evidencePack?.byTheme || { competitors: [], demandSignals: [], pricing: [], saturation: [] },
      sources: evidencePack?.sources || [],
      redacted: Boolean(evidencePack?.redacted),
      count: (evidencePack?.items || []).length,
    },
    citations: {
      total: citTotal,
      valid: citValid,
      invalid: citTotal - citValid,
      rate: citationRate, // 有效引用率(%),null=本轮无引用
    },
    live: {
      simulated,
      providerCount,
      configuredProviders: status.filter((item) => item.configured).map((item) => item.label),
      failures,
    },
  };
}

function rankedUnique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function inferCuts({ mode, risks = [], omissions = [], suggestions = [] }) {
  const text = [...risks, ...omissions, ...suggestions].join(" ").toLowerCase();
  const cuts = [];
  if (mode === "copy") {
    cuts.push("砍掉“会火 / 必火 / winning ideas”这类不可证明承诺。");
    cuts.push("砍掉 0-100 分作为主卖点，把 Hook、清晰度、购买理由放前面。");
  } else {
    cuts.push("砍掉完整产品开发冲动，先只做一个能验证付费或强需求的 concierge test。");
    cuts.push("砍掉泛人群定位，只保留一个最窄、最痛、最容易触达的用户群。");
  }
  if (/score|分数|0-100|100/.test(text)) {
    cuts.push("砍掉假精确分数的主视觉，保留为辅助信号。");
  }
  if (/多模型|multi|provider|厂商|模型/.test(text)) {
    cuts.push("砍掉“我们用了很多模型”的自嗨表达，改成展示具体分歧和下一步验证。");
  }
  return rankedUnique(cuts);
}

function decideVerdict(seats) {
  const counts = Object.fromEntries(DECISION_ORDER.map((stance) => [stance, 0]));
  for (const seat of seats) counts[seat.stance] += 1;
  // P5: 跨席位投票/阈值,绝不只取 seats[0]
  if (counts.Kill >= 2) return "Kill or radically narrow";
  if (counts.Pause >= 2) return "Pause and validate";
  if (counts.Ship >= 2 && counts.Kill === 0) return "Ship the test";
  return "Fix, then ship";
}

function confidenceFor(seats) {
  if (seats.length >= 4) return "Medium-high, still subjective";
  if (seats.length >= 2) return "Medium, partial council";
  return "Low";
}

function nextActionFor(verdict) {
  if (/kill/i.test(verdict)) return "Narrow the customer";
  if (/pause/i.test(verdict)) return "Run validation first";
  if (/ship/i.test(verdict)) return "Ship concierge test";
  return "Rewrite and test";
}

function copyDiagnosisFrom(seats) {
  const fixers = seats.filter((seat) => seat.stance !== "Ship");
  const source = fixers[0] || seats[0];
  return source?.take || "No copy diagnosis returned.";
}

function sevenDayPlanFor({ mode, verdict, fatalAssumption, test }) {
  const subject = mode === "copy" ? "copy" : "idea";
  return [
    `Day 1: rewrite the ${subject} around the fatal assumption: ${fatalAssumption || "unknown"}.`,
    `Day 2: run the cheapest test: ${test || "ask five target users for a concrete yes/no reaction"}.`,
    "Day 3: publish the before/after and ask for brutal replies.",
    "Day 4: book five calls with the narrowest responder group.",
    "Day 5: ask for a pre-order, paid report, or concrete commitment.",
    `Day 6: decide whether the verdict still holds: ${verdict}.`,
    "Day 7: keep only the message and workflow that caused action.",
  ].join(" ");
}

function mostCommonUseful(values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 12) || "";
}

function envHint(id) {
  const hints = {
    openai: "OPENAI_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    kimi: "KIMI_API_KEY or MOONSHOT_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    qwen: "QWEN_API_KEY or DASHSCOPE_API_KEY",
  };
  return hints[id] || "the provider API key";
}
