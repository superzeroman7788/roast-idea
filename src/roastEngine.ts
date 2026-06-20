export type RoastMode = "idea" | "copy";

type Stance = "Ship" | "Fix" | "Pause" | "Kill" | "Failed";

export type CouncilMember = {
  provider: string;
  role: string;
  stance: Stance;
  take: string;
  blindspot: string;
};

export type CouncilReport = {
  verdict: string;
  summary: string;
  confidenceRange: string;
  vendorSpread: string;
  dissentLevel: string;
  hookClarity: string;
  nextAction: string;
  fatalAssumption: string;
  cheapestTest: string;
  topRisks: string[];
  whatToCut: string[];
  dissentMap: Array<{
    provider: string;
    stance: Stance;
    model: string;
    status: "responded" | "failed";
    keyRisk: string;
  }>;
  copyDiagnosis: string;
  sevenDayPlan: string;
  panel: CouncilMember[];
  debate: Array<{ speaker: string; line: string }>;
  live?: {
    simulated: boolean;
    providerCount: number;
    configuredProviders: string[];
    failures: Array<{ provider: string; error: string }>;
  };
};

export type SampleBrief = Record<RoastMode, string>;

export const sampleBrief: SampleBrief = {
  idea:
    "Roast My Idea: a multi-model AI sparring partner for founders. Users paste a startup idea, landing page, or product copy. The app convenes separate models from different vendors, forces a devil's advocate round, then returns Ship/Fix/Pause/Kill, the fatal untested assumption, and a 7-day validation plan. Target users are solo founders, indie hackers, and product teams who want sharper feedback before building.",
  copy:
    "Your AI council before launch. Paste your idea and get a 0-100 score, five expert perspectives, viral copy suggestions, and a complete plan for what to build next. Stop guessing and ship only winning ideas.",
};

const ideaPanel: CouncilMember[] = [
  {
    provider: "OpenAI",
    role: "Product Strategist",
    stance: "Fix",
    take:
      "The wedge is credible only if the product proves real cross-vendor disagreement. Lead with the fatal assumption and cheapest test, not the score.",
    blindspot:
      "May over-optimize for crisp product framing while underweighting whether founders will pay repeatedly.",
  },
  {
    provider: "Anthropic",
    role: "Skeptical Operator",
    stance: "Pause",
    take:
      "This can become another idea validator unless the workflow creates behavior change: a test shipped, a call booked, or a landing page edited.",
    blindspot:
      "May be too cautious about punchy naming and social-native packaging.",
  },
  {
    provider: "Gemini",
    role: "Market Scanner",
    stance: "Ship",
    take:
      "The memorable angle is strong: 'not one model roleplaying a committee.' Demo the model disagreement visually and make sharing irresistible.",
    blindspot:
      "May reward novelty and demo value before retention is proven.",
  },
  {
    provider: "DeepSeek",
    role: "Cost & Systems Critic",
    stance: "Fix",
    take:
      "Multi-provider cost, latency, and failures are the hard part. MVP should cache, stream partial results, and degrade gracefully when a vendor is down.",
    blindspot:
      "May over-focus on infrastructure before demand is validated.",
  },
];

const copyPanel: CouncilMember[] = [
  {
    provider: "OpenAI",
    role: "Positioning Editor",
    stance: "Fix",
    take:
      "The promise is clear but too broad. Replace 'winning ideas' with a concrete job: finding the one assumption that can kill the project.",
    blindspot:
      "May polish language without testing whether the offer earns clicks.",
  },
  {
    provider: "Anthropic",
    role: "Trust Critic",
    stance: "Pause",
    take:
      "A numeric score invites distrust. Make the product feel like a rigorous sparring partner, not an oracle.",
    blindspot:
      "May sand off the theatrical edge that makes the product shareable.",
  },
  {
    provider: "Gemini",
    role: "Growth Reader",
    stance: "Ship",
    take:
      "The phrase 'AI council before launch' is usable. The hook needs a contrast: one-model cosplay versus real model disagreement.",
    blindspot:
      "May over-index on catchy contrast before buyer urgency.",
  },
  {
    provider: "DeepSeek",
    role: "Compression Knife",
    stance: "Fix",
    take:
      "Cut abstract claims. The copy should say exactly what comes back: verdict, fatal assumption, 7-day validation plan.",
    blindspot:
      "May make the copy too utilitarian for a social launch.",
  },
];

export function runCouncil(brief: string, mode: RoastMode): CouncilReport {
  const normalized = brief.toLowerCase();
  const mentionsScore = /score|0-100|100|分数/.test(normalized);
  const mentionsMultiModel =
    /multi|vendor|openai|claude|anthropic|gemini|deepseek|厂商|多模型/.test(
      normalized,
    );
  const mentionsValidation = /validation|validate|test|7-day|7 day|验证|测试/.test(
    normalized,
  );

  if (mode === "copy") {
    return {
      verdict: "Fix the promise",
      summary:
        "The copy has a usable category hook, but it overclaims prediction. Make it a diagnostic tool that creates sharper tests, not a fortune teller for viral success.",
      confidenceRange: mentionsScore ? "Medium, not numeric" : "Medium-high",
      vendorSpread: mentionsMultiModel ? "4 vendors named" : "Vendor proof missing",
      dissentLevel: "High",
      hookClarity: mentionsMultiModel ? "Sharp" : "Readable",
      nextAction: "Rewrite hero",
      fatalAssumption:
        "You assume founders want an AI to judge the idea. They likely want help deciding the next uncomfortable experiment.",
      cheapestTest:
        "Run 20 founder posts with two hooks: 'Roast my idea' versus 'Find my fatal assumption.' Track replies, saves, and requests for a second pass.",
      topRisks: [
        "Users may distrust a viral score because the product cannot prove virality.",
        "The copy overclaims prediction instead of selling useful diagnosis.",
        "The deliverable is unclear unless the report ends in a concrete rewrite and test.",
      ],
      whatToCut: [
        "Cut 'winning ideas' from the hero promise.",
        "Cut 0-100 score as the headline.",
        "Cut generic expert-perspective language.",
      ],
      dissentMap: copyPanel.map((seat) => ({
        provider: seat.provider,
        stance: seat.stance,
        model: seat.role,
        status: "responded",
        keyRisk: seat.take,
      })),
      copyDiagnosis:
        "Keep the council metaphor, remove fake certainty, and make the deliverable concrete: verdict, fatal assumption, and 7-day validation plan.",
      sevenDayPlan:
        "Day 1: rewrite three hero variants. Day 2: post them on X/HN/Indie Hackers. Day 3-4: roast 10 volunteered ideas manually. Day 5: ask which line felt most useful. Day 6: publish before/after examples. Day 7: charge for 5 deeper reports.",
      panel: copyPanel,
      debate: [
        {
          speaker: "Anthropic",
          line: "If you keep the score as the headline, serious users will debate the number instead of acting on the insight.",
        },
        {
          speaker: "Gemini",
          line: "The product still needs theater. 'Roast My Idea' gives people permission to share the pain.",
        },
        {
          speaker: "DeepSeek",
          line: "Theater is fine, but the output must end in a cheap test. Otherwise it is a novelty report.",
        },
        {
          speaker: "OpenAI",
          line: "Resolution: sell the roast, deliver the drill. The roast earns attention; the drill earns trust.",
        },
      ],
    };
  }

  return {
    verdict: mentionsMultiModel ? "Fix, then ship" : "Pause until real dissent",
    summary:
      "The idea is worth prototyping if the first visible feature proves cross-vendor disagreement. The product should act like a hard-nosed coach, not a judge with fake precision.",
    confidenceRange: mentionsScore ? "55-70, subjective" : "Medium",
    vendorSpread: mentionsMultiModel ? "OpenAI / Anthropic / Gemini / DeepSeek" : "Unproven",
    dissentLevel: mentionsMultiModel ? "Strong" : "Simulated",
    hookClarity: "Good",
    nextAction: mentionsValidation ? "Run concierge test" : "Define 7-day test",
    fatalAssumption:
      "The riskiest assumption is that real multi-model disagreement is valuable enough for founders to pay for, rather than just entertaining to read once.",
    cheapestTest:
      "Before wiring every provider, manually run 20 ideas through separate models, show the disagreement map, and ask users to choose one test they would actually do this week.",
    topRisks: [
      "Real multi-model disagreement may be entertaining once but not valuable enough to repeat.",
      "The product may look like a slower, more expensive idea validator.",
      "If the report reads like consulting prose, users will not act on it.",
      "Provider failures can break trust unless the UI shows partial results transparently.",
    ],
    whatToCut: [
      "Cut OpenRouter free from the default council; keep it as fallback.",
      "Cut full transcript as the default view.",
      "Cut fake precision scoring from the main card.",
      "Cut any claim that AI can know whether an idea will win.",
    ],
    dissentMap: ideaPanel.map((seat) => ({
      provider: seat.provider,
      stance: seat.stance,
      model: seat.role,
      status: "responded",
      keyRisk: seat.take,
    })),
    copyDiagnosis:
      "The hook should emphasize 'not one model roleplaying a committee' and avoid 'predicts winners' language.",
    sevenDayPlan:
      "Day 1: build a form and mock report. Day 2: manually process 10 founder ideas with real separate models. Day 3: ship public examples. Day 4: add copy-mode diagnostics. Day 5: ask for payment before the full report. Day 6: add provider status transparency. Day 7: keep only the outputs users acted on.",
    panel: ideaPanel,
    debate: [
      {
        speaker: "OpenAI",
        line: "This can ship if the interface makes the disagreement legible in under ten seconds.",
      },
      {
        speaker: "Anthropic",
        line: "Only if we stop pretending the model can know what will succeed. It can expose assumptions, not destiny.",
      },
      {
        speaker: "Gemini",
        line: "The name is the distribution. 'Roast My Idea' invites public use in a way 'Council' does not.",
      },
      {
        speaker: "DeepSeek",
        line: "Hard requirement: no same-model personas. Every provider response must be independently generated, timestamped, and attributable.",
      },
    ],
  };
}
