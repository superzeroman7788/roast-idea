const DECISION_ORDER = ["Kill", "Pause", "Fix", "Ship"];

export function buildAgentGroupReport({ mode, council }) {
  const plan = council.plan || {};
  const challenge = council.challenge || {};
  const challenges = Array.isArray(council.challenges) && council.challenges.length
    ? council.challenges
    : challenge.enabled
      ? [challenge]
      : [];
  const challengerEnabled = challenges.length > 0;
  const mainBrainSkipped = Boolean(council.mainBrainSkipped);
  const mainBrainFailed = (council.failures || []).some(
    (failure) => failure.provider === "Agent Group main brain",
  );
  const hasMainBrain = !mainBrainSkipped && !mainBrainFailed;
  const participantCount = (hasMainBrain ? 1 : 0) + challenges.length;
  const simulated = participantCount < 2;
  const stance = mapChallengeStance(challenges[0]?.stance || challenge.stance);
  const risks = challenges.flatMap((item) => cleanList(item.risks));
  const omissions = challenges.flatMap((item) => cleanList(item.omissions));
  const suggestions = challenges.flatMap((item) => cleanList(item.suggestions));
  const firstRisk = risks[0] || omissions[0] || plan.constraints || "";
  const firstSuggestion = suggestions[0] || plan.checkpoints || plan.output_criteria || "";
  const topRisks = rankedUnique([
    ...risks,
    ...omissions.map((item) => `遗漏: ${item}`),
  ]).slice(0, 5);
  const whatToCut = inferCuts({ mode, plan, risks, omissions, suggestions }).slice(0, 4);
  const dissentMap = buildDissentMap({ challenges, failures: council.failures || [] });

  const panel = [];

  if (hasMainBrain) {
    panel.push({
      provider: "Agent Group / Main Brain",
      role: council.status.mainBrain.runner,
      stance: "Fix",
      take:
        plan.approach ||
        plan.objective ||
        "主大脑已形成 v1 方案，但返回内容过短，需要补充更具体的目标和验收标准。",
      blindspot: plan.constraints || "主大脑负责压缩方案，不负责当反方裁判。",
    });
  }

  if (challengerEnabled) {
    for (const item of challenges) {
      const itemRisks = cleanList(item.risks);
      const itemOmissions = cleanList(item.omissions);
      const itemSuggestions = cleanList(item.suggestions);
    panel.push({
        provider: item.name || "Agent Group challenger",
        role: item.runner || "Forced devil's advocate",
        stance: mapChallengeStance(item.stance),
      take:
          [itemRisks[0], itemSuggestions[0]].filter(Boolean).join(" ") ||
        "挑战者已响应，但没有给出足够具体的风险和修改建议。",
      blindspot:
          itemOmissions[0] ||
          `${item.model || item.runner || "agent-group"} returned no explicit omission.`,
    });
    }
  } else {
    panel.push({
      provider: "Agent Group challenger",
      role: "Not enabled",
      stance: "Pause",
      take:
        suggestions[0] ||
        "agent-group 里挑战者插槽存在，但当前没有 enabled challenger 参与。",
      blindspot: "没有把 disabled 角色伪装成真实分歧。",
    });
  }

  return {
    verdict: simulated ? "Agent Group ready, dissent incomplete" : verdictFromChallenge(stance),
    summary: simulated
      ? `Agent Group 已接入，但本轮少于两个真实参与方响应，所以不能当作完整反方会议。${failureSummary(council.failures)}`
      : `Agent Group live run: ${hasMainBrain ? "主大脑先形成方案，" : "Claude 已移除，使用轻量 intake plan，"}${challenges.map((item) => item.name).join(" / ")} 做强制反方审查。`,
    confidenceRange: simulated ? "Incomplete" : "Medium, subjective",
    vendorSpread: `${participantCount} live participant${participantCount > 1 ? "s" : ""}`,
    dissentLevel: simulated ? "Incomplete" : stance === "Ship" ? "Low" : "Real",
    hookClarity: mode === "copy" ? "Diagnosed by Agent Group" : "N/A",
    nextAction: nextActionFor(verdictFromChallenge(stance)),
    fatalAssumption:
      firstRisk ||
      plan.context ||
      "这轮没有抽出足够明确的致命假设，请把目标用户、付费场景和分发渠道写得更窄。",
    cheapestTest:
      firstSuggestion ||
      "找 10 个目标用户做一次 concierge roast，要求他们选择一个本周真的会执行的验证动作。",
    topRisks,
    whatToCut,
    dissentMap,
    copyDiagnosis:
      mode === "copy"
        ? [risks[0], suggestions[0], plan.output_criteria].filter(Boolean).join(" ")
        : "Copy mode was not selected for this run.",
    sevenDayPlan: buildAgentGroupSevenDayPlan({ mode, plan, risk: firstRisk, test: firstSuggestion }),
    panel,
    debate: [
      ...(hasMainBrain
        ? [{
            speaker: "Main Brain",
            line: plan.objective || plan.title || "形成 v1 方案。",
          }]
        : []),
      {
        speaker: challenges.map((item) => item.name).join(" / ") || challenge.name || "Challenger",
        line:
          [challenge.stance, risks[0], suggestions[0]].filter(Boolean).join(" · ") ||
          "挑战者未启用或没有返回可读内容。",
      },
      {
        speaker: "System",
        line: "本轮由 roast-idea 调用 agent-group 的 /api/decision/plan 与 /api/decision/challenge-all 生成。",
      },
    ],
    live: {
      simulated,
      providerCount: participantCount,
      configuredProviders: [
        ...(hasMainBrain ? ["Agent Group main brain"] : []),
        ...challenges.map((item) => item.name || "Agent Group challenger"),
      ],
      failures: council.failures || [],
    },
  };
}

export function buildReport({ mode, brief, results, status }) {
  const seats = results.filter((result) => result.ok);
  const failures = results.filter((result) => !result.ok);
  const providerCount = seats.length;
  const simulated = providerCount < 2;

  const panel = seats.length
    ? seats.map((seat) => ({
        provider: seat.provider,
        role: seat.role,
        stance: seat.stance,
        take: seat.take,
        blindspot: `${seat.model} · ${seat.latencyMs}ms · ${seat.blindspot}`,
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

  const verdict = simulated
    ? "Insufficient real dissent"
    : decideVerdict(seats);

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
      keyRisk: seat.fatalAssumption,
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
      ? seats.map((seat) => ({
          speaker: seat.provider,
          line: seat.debateLine,
        }))
      : [
          {
            speaker: "System",
            line: "No vendor seats responded. Add at least two provider keys before treating this as a real council.",
          },
        ],
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

function buildDissentMap({ challenges, failures }) {
  return [
    ...challenges.map((item) => ({
      provider: item.name || "Agent Group challenger",
      stance: mapChallengeStance(item.stance),
      model: item.model || item.runner || "",
      status: "responded",
      keyRisk:
        cleanList(item.risks)[0] ||
        cleanList(item.omissions)[0] ||
        cleanList(item.suggestions)[0] ||
        "No sharp risk returned.",
    })),
    ...failures.map((failure) => ({
      provider: failure.provider || failure.name || "Agent Group challenger",
      stance: "Failed",
      model: failure.runner || "",
      status: "failed",
      keyRisk: failure.error || "Provider failed before returning a seat.",
    })),
  ];
}

function inferCuts({ mode, plan = {}, risks = [], omissions = [], suggestions = [] }) {
  const text = [
    plan.objective,
    plan.approach,
    plan.constraints,
    ...risks,
    ...omissions,
    ...suggestions,
  ].join(" ").toLowerCase();
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
  if (/免费|openrouter|free/.test(text)) {
    cuts.push("砍掉免费模型默认席位，把不稳定模型放到 fallback 或低成本模式。");
  }
  return rankedUnique(cuts);
}

function mapChallengeStance(stance) {
  const text = String(stance || "").toLowerCase();
  if (/反对|kill|否|不建议/.test(text)) return "Kill";
  if (/暂停|pause|观望/.test(text)) return "Pause";
  if (/同意|ship|支持/.test(text) && !/部分/.test(text)) return "Ship";
  return "Fix";
}

function verdictFromChallenge(stance) {
  if (stance === "Kill") return "Kill or radically narrow";
  if (stance === "Pause") return "Pause and validate";
  if (stance === "Ship") return "Ship the test";
  return "Fix, then ship";
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function buildAgentGroupSevenDayPlan({ mode, plan, risk, test }) {
  const subject = mode === "copy" ? "copy" : "idea";
  return [
    `Day 1: rewrite the ${subject} around this risk: ${risk || plan.constraints || "unknown"}.`,
    `Day 2: run the cheapest test: ${test || plan.checkpoints || "ask five target users for a concrete yes/no reaction"}.`,
    "Day 3: publish the before/after and ask for brutal replies.",
    "Day 4: book five calls with the narrowest responder group.",
    "Day 5: ask for a pre-order, paid report, or concrete commitment.",
    `Day 6: compare evidence against the v1 criteria: ${plan.output_criteria || "specific user action"}.`,
    "Day 7: keep only the message and workflow that caused action.",
  ].join(" ");
}

function failureSummary(failures = []) {
  if (!failures.length) return "";
  return ` Failed: ${failures.map((failure) => failure.provider).join(", ")}.`;
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

function decideVerdict(seats) {
  const counts = Object.fromEntries(DECISION_ORDER.map((stance) => [stance, 0]));
  for (const seat of seats) counts[seat.stance] += 1;
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
