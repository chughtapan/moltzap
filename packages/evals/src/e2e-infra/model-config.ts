/** Model configuration for E2E evals, mirroring OpenClaw's models.ts pattern. */

/** Judge/eval model configuration (used for LLM-as-judge scoring). */
export interface ModelConfig {
  provider: string;
  modelId: string;
  envVar: string;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

/** Agent model configuration (the model the OpenClaw agent runs with). */
export interface AgentModelConfig {
  /** OpenClaw provider/model format, e.g. "zai/glm-4.7" */
  id: string;
  /** OpenClaw provider name for config injection */
  provider: string;
  /** Model ID within the provider */
  modelId: string;
  /** Environment variable that must contain the API key */
  envVar: string;
}

export const DEFAULT_JUDGE_MODEL = "gemini-2.5-flash";

export const MODELS: ModelConfig[] = [
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    envVar: "ANTHROPIC_API_KEY",
    requestsPerMinute: 50,
    tokensPerMinute: 30000,
  },
  {
    provider: "google",
    modelId: "gemini-2.5-flash",
    envVar: "GEMINI_API_KEY",
    requestsPerMinute: 0,
    tokensPerMinute: 0,
  },
  {
    provider: "google",
    modelId: "gemini-3-flash-preview",
    envVar: "GEMINI_API_KEY",
    requestsPerMinute: 0,
    tokensPerMinute: 0,
  },
  {
    provider: "openai",
    modelId: "gpt-5-mini",
    envVar: "OPENAI_API_KEY",
    requestsPerMinute: 500,
    tokensPerMinute: 500000,
  },
];

/** Models the OpenClaw agent can be configured to use during evals. */
export const AGENT_MODELS: AgentModelConfig[] = [
  {
    id: "zai/glm-4.7",
    provider: "zai",
    modelId: "glm-4.7",
    envVar: "ZAI_API_KEY",
  },
  {
    id: "anthropic/claude-sonnet-4-20250514",
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    envVar: "ANTHROPIC_API_KEY",
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "google",
    modelId: "gemini-2.5-flash",
    envVar: "GEMINI_API_KEY",
  },
  {
    id: "openai/gpt-5-mini",
    provider: "openai",
    modelId: "gpt-5-mini",
    envVar: "OPENAI_API_KEY",
  },
];

export function getModelConfig(): ModelConfig {
  const provider = process.env["EVAL_LLM_PROVIDER"] ?? "anthropic";

  const match = MODELS.find((m) => m.provider === provider);
  if (match) return match;

  // Default to first model if provider not recognized
  return MODELS[0]!;
}

/** Resolve and validate an agent model by ID. Crashes if the required API key is missing. */
export function resolveAgentModel(modelId: string): AgentModelConfig {
  const model = AGENT_MODELS.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(
      `Unknown agent model "${modelId}". Available: ${AGENT_MODELS.map((m) => m.id).join(", ")}`,
    );
  }

  const apiKey = process.env[model.envVar];
  if (!apiKey) {
    throw new Error(`${model.envVar} required for model ${model.id}`);
  }

  return model;
}

/** Resolve all agent models. Crashes if ANY required API key is missing. */
export function resolveAllAgentModels(): AgentModelConfig[] {
  const missing: string[] = [];
  for (const model of AGENT_MODELS) {
    if (!process.env[model.envVar]) {
      missing.push(`${model.envVar} required for model ${model.id}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing API keys for --all-models:\n  ${missing.join("\n  ")}`,
    );
  }
  return AGENT_MODELS;
}
