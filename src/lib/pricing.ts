/**
 * OpenClaw Model Pricing
 * Based on OpenRouter and Anthropic pricing as of Feb 2026
 * All prices in USD per million tokens
 */

export interface ModelPricing {
  id: string;
  name: string;
  alias?: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  contextWindow: number;
}

export const MODEL_PRICING: ModelPricing[] = [
  // Anthropic models
  {
    id: "anthropic/claude-opus-4-6",
    name: "Opus 4.6",
    alias: "opus",
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Sonnet 4.6",
    alias: "sonnet-4-6",
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Sonnet 4.5",
    alias: "sonnet",
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Haiku 4.5",
    alias: "haiku-4-5",
    inputPricePerMillion: 1.00,
    outputPricePerMillion: 5.00,
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-haiku-3-5",
    name: "Haiku 3.5",
    alias: "haiku",
    inputPricePerMillion: 0.80,
    outputPricePerMillion: 4.00,
    contextWindow: 200000,
  },
  // GitHub Copilot (Pro+ is flat-rate, but we surface underlying Anthropic
  // prices as "estimated value delivered" so the user sees meaningful numbers).
  {
    id: "github-copilot/claude-opus-4.6",
    name: "Copilot Opus 4.6",
    alias: "copilot-opus",
    inputPricePerMillion: 15.00,
    outputPricePerMillion: 75.00,
    contextWindow: 200000,
  },
  {
    id: "github-copilot/claude-sonnet-4.6",
    name: "Copilot Sonnet 4.6",
    alias: "copilot-sonnet",
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 15.00,
    contextWindow: 200000,
  },
  // OpenAI GPT-5 family (our fallback chain). Pricing per OpenAI's public
  // GPT-5 tiers at the time of writing; update when official numbers shift.
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    alias: "gpt-5.4",
    inputPricePerMillion: 10.00,
    outputPricePerMillion: 40.00,
    contextWindow: 400000,
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    alias: "gpt-5.2",
    inputPricePerMillion: 3.00,
    outputPricePerMillion: 12.00,
    contextWindow: 400000,
  },
  // Google Gemini models
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini Flash",
    alias: "gemini-flash",
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
    contextWindow: 1000000,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini Pro",
    alias: "gemini-pro",
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5.00,
    contextWindow: 2000000,
  },
  // X.AI Grok
  {
    id: "x-ai/grok-4-1-fast",
    name: "Grok 4.1 Fast",
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 10.00,
    contextWindow: 128000,
  },
  // MiniMax
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    alias: "minimax",
    inputPricePerMillion: 0.30,
    outputPricePerMillion: 1.10,
    contextWindow: 1000000,
  },
];

/**
 * Calculate cost for a given model and token usage
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING.find(
    (p) => p.id === modelId || p.alias === modelId
  );

  if (!pricing) {
    console.warn(`Unknown model: ${modelId}, using default pricing`);
    // Default to Sonnet pricing if unknown
    return (
      (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0
    );
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMillion;

  return inputCost + outputCost;
}

/**
 * Get human-readable model name
 */
export function getModelName(modelId: string): string {
  const pricing = MODEL_PRICING.find(
    (p) => p.id === modelId || p.alias === modelId
  );
  return pricing?.name || modelId;
}

/**
 * Normalize model ID (handle aliases and different formats)
 */
export function normalizeModelId(modelId: string): string {
  // Handle short aliases and OpenClaw format (without provider prefix)
  const aliasMap: Record<string, string> = {
    // Short aliases
    opus: "anthropic/claude-opus-4-6",
    sonnet: "anthropic/claude-sonnet-4-5",
    haiku: "anthropic/claude-haiku-3-5",
    "gemini-flash": "google/gemini-2.5-flash",
    "gemini-pro": "google/gemini-2.5-pro",
    // Versioned short aliases used by our stack (coordinador/github-apptolast
    // sessions record `model: "claude-opus-4.6"`, `claude-sonnet-4-6`, etc.)
    "claude-opus-4-6": "anthropic/claude-opus-4-6",
    "claude-opus-4.6": "anthropic/claude-opus-4-6",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
    "claude-sonnet-4.6": "anthropic/claude-sonnet-4-6",
    "claude-sonnet-4-5": "anthropic/claude-sonnet-4-5",
    "claude-haiku-4-5": "anthropic/claude-haiku-4-5",
    "claude-haiku-3-5": "anthropic/claude-haiku-3-5",
    "gpt-5.4": "openai/gpt-5.4",
    "gpt-5.2": "openai/gpt-5.2",
    "gemini-2.5-flash": "google/gemini-2.5-flash",
    "gemini-2.5-pro": "google/gemini-2.5-pro",
    // MiniMax
    minimax: "minimax/minimax-m2.5",
    "minimax-m2.5": "minimax/minimax-m2.5",
  };

  return aliasMap[modelId] || modelId;
}
