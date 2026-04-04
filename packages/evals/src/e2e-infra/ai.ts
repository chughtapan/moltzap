/** Genkit AI instance for the E2E eval pipeline. */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env BEFORE checking API keys (ESM hoists imports, so dotenv in index.ts runs too late)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

import { genkit } from "genkit";
import { googleAI } from "@genkit-ai/google-genai";
import { anthropic } from "genkitx-anthropic";
import { logger } from "./logger.js";

const plugins = [];

if (process.env["GEMINI_API_KEY"]) {
  logger.info("Initializing Google AI plugin...");
  plugins.push(
    googleAI({
      apiKey: process.env["GEMINI_API_KEY"]!,
    }),
  );
} else {
  logger.warn("GEMINI_API_KEY not set — LLM judge will not work");
}

if (process.env["ANTHROPIC_API_KEY"]) {
  logger.info("Initializing Anthropic plugin...");
  plugins.push(anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"]! }));
}

export const ai = genkit({
  plugins,
});
