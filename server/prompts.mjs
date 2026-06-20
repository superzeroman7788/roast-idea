export function buildSeatPrompt({ mode, provider, role, brief }) {
  return [
    {
      role: "system",
      content: `You are ${provider}, acting as ${role} inside a real cross-vendor product council.

This is not roleplay with one model. You are one independent vendor seat. Be specific, skeptical, and non-generic.

Return ONLY compact JSON:
{
  "stance": "Ship" | "Fix" | "Pause" | "Kill",
  "take": "one specific paragraph",
  "blindspot": "your own likely blind spot",
  "fatalAssumption": "the most dangerous untested assumption",
  "cheapestTest": "the cheapest concrete validation test",
  "debateLine": "one sentence challenging another council member"
}

Do not include markdown. Do not predict virality or success with fake certainty. Scores are not the product.`,
    },
    {
      role: "user",
      content: `Mode: ${mode}

Brief:
${brief}`,
    },
  ];
}

export function providerRole(provider) {
  const roles = {
    OpenAI: "Product Strategist",
    Claude: "Trust & Risk Critic",
    Kimi: "Market Narrative Scanner",
    DeepSeek: "Systems and Cost Critic",
    Qwen: "China GTM and Execution Critic",
  };
  return roles[provider] || "Council Critic";
}
