export type ProviderName = "openai" | "anthropic" | "gemini" | "deepseek";

export type ProviderInput = {
  mode: "idea" | "copy";
  brief: string;
  systemPrompt: string;
};

export type ProviderOutput = {
  provider: ProviderName;
  model: string;
  rawText: string;
  latencyMs: number;
};

export type ProviderAdapter = {
  name: ProviderName;
  model: string;
  isConfigured: () => boolean;
  run: (input: ProviderInput) => Promise<ProviderOutput>;
};

export const HARD_REQUIREMENTS = [
  "Each council seat must call a different provider family in production.",
  "Do not replace missing providers with same-model personas without labeling the run as simulated.",
  "Devil's advocate prompts must be adversarial and provider-specific, not generic roleplay.",
  "Scores are secondary references; verdict, fatal assumption, and cheapest validation plan are primary.",
];

export async function runProductionCouncil() {
  throw new Error(
    "Production adapters are intentionally not wired in the MVP. Add server-side routes for OpenAI, Anthropic, Gemini, and DeepSeek keys before enabling live runs.",
  );
}
