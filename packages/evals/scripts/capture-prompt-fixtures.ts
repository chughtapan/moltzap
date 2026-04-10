/**
 * Captures golden prompt fixtures used by the snapshot tests in
 * __tests__/llm-judge.prompt.test.ts.
 *
 *   pnpm --filter @moltzap/evals exec tsx scripts/capture-prompt-fixtures.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEvalPrompt,
  formatTranscript,
} from "../src/e2e-infra/llm-judge.js";
import {
  PROMPT_CASES,
  SINGLE_CONV_TRANSCRIPT,
  MULTI_CONV_TRANSCRIPT,
  findScenario,
} from "../src/e2e-infra/__tests__/fixtures/cases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../src/e2e-infra/__tests__/fixtures");

mkdirSync(FIXTURE_DIR, { recursive: true });

let written = 0;
for (const c of PROMPT_CASES) {
  const prompt = buildEvalPrompt({
    scenario: findScenario(c.scenarioId),
    agentResponse: c.agentResponse,
    conversationContext: c.conversationContext,
    transcript: c.transcript,
  });
  const path = resolve(FIXTURE_DIR, `prompt-${c.name}.txt`);
  writeFileSync(path, prompt, "utf8");
  written++;
  console.log(`wrote ${path}  (${prompt.length} bytes)`);
}

writeFileSync(
  resolve(FIXTURE_DIR, "format-transcript-multi-conv.txt"),
  formatTranscript(MULTI_CONV_TRANSCRIPT),
  "utf8",
);
written++;

writeFileSync(
  resolve(FIXTURE_DIR, "format-transcript-single-conv.txt"),
  formatTranscript(SINGLE_CONV_TRANSCRIPT),
  "utf8",
);
written++;

console.log(`\nDone. Wrote ${written} fixture files to ${FIXTURE_DIR}`);
