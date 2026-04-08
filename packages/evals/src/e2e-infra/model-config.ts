/**
 * Model configuration for E2E evals.
 *
 * Two separate model roles:
 *
 *   Agent model — the model the OpenClaw agent runs with inside Docker.
 *     Pass any "provider/model" string via --model. OpenClaw resolves it
 *     internally; env var lookup uses openclaw/plugin-sdk/provider-env-vars.
 *     Model IDs are case-sensitive and must match OpenClaw's catalog exactly
 *     (e.g. "minimax/MiniMax-M2.7-highspeed", not "minimax/minimax-2.7-highspeed").
 *     All *_API_KEY env vars are auto-forwarded to containers.
 *
 *   Judge model — the LLM-as-judge used to score agent responses.
 *     Currently hardwired to Google AI via genkit (googleai/ prefix).
 *     Requires GEMINI_API_KEY.
 */

import { getProviderEnvVars } from "openclaw/plugin-sdk/provider-env-vars";

/** Judge/eval model configuration (used for LLM-as-judge scoring via genkit). */
export interface ModelConfig {
  provider: string;
  modelId: string;
  envVar: string;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export const DEFAULT_JUDGE_MODEL = "gemini-3-flash-preview";

export const DEFAULT_AGENT_MODEL_ID = "minimax/MiniMax-M2.7-highspeed";

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

export function getModelConfig(): ModelConfig {
  const provider = process.env["EVAL_LLM_PROVIDER"] ?? "anthropic";

  const match = MODELS.find((m) => m.provider === provider);
  if (match) return match;

  // Default to first model if provider not recognized
  return MODELS[0]!;
}

/** Pre-flight: crash early if the API key for this model's provider isn't set. */
export function validateAgentModelEnv(modelId: string): void {
  const slash = modelId.indexOf("/");
  if (slash < 1)
    throw new Error(
      `Invalid model ID "${modelId}" — expected "provider/model"`,
    );
  const provider = modelId.slice(0, slash);
  const envVars = getProviderEnvVars(provider);
  if (!envVars.length)
    throw new Error(`Unknown provider "${provider}" in model "${modelId}"`);
  if (!envVars.some((v) => process.env[v])) {
    throw new Error(
      `No API key for provider "${provider}". Set one of: ${envVars.join(", ")}`,
    );
  }
}
