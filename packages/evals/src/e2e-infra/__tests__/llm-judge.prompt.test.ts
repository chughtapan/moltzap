import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEvalPrompt, formatTranscript } from "../llm-judge.js";
import {
  PROMPT_CASES,
  SINGLE_CONV_TRANSCRIPT,
  MULTI_CONV_TRANSCRIPT,
  findScenario,
} from "./fixtures/cases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf8");
}

describe("buildEvalPrompt — golden snapshots", () => {
  for (const c of PROMPT_CASES) {
    it(`${c.name} (${c.scenarioId}) matches captured fixture`, () => {
      const got = buildEvalPrompt({
        scenario: findScenario(c.scenarioId),
        agentResponse: c.agentResponse,
        conversationContext: c.conversationContext,
        transcript: c.transcript,
      });
      expect(got).toBe(loadFixture(`prompt-${c.name}.txt`));
    });
  }
});

describe("formatTranscript — golden snapshots", () => {
  it("single-conversation transcript", () => {
    expect(formatTranscript(SINGLE_CONV_TRANSCRIPT)).toBe(
      loadFixture("format-transcript-single-conv.txt"),
    );
  });

  it("multi-conversation transcript with boundaries", () => {
    expect(formatTranscript(MULTI_CONV_TRANSCRIPT)).toBe(
      loadFixture("format-transcript-multi-conv.txt"),
    );
  });
});
