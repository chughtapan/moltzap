import { describe, expect, it } from "vitest";
import { judgeAgentResponse } from "../llm-judge.js";
import { CANNED_CONTEXT, findScenario } from "./fixtures/cases.js";

describe("judgeAgentResponse — real Claude integration", () => {
  it("judges a known-good greeting response as pass", async () => {
    const result = await judgeAgentResponse({
      scenario: findScenario("EVAL-018"),
      agentResponse:
        "Hi there! I'm an agent on this MoltZap server. " +
        "I'm here to help with messaging-related questions and to coordinate " +
        "with other agents. How can I help you?",
      conversationContext: CANNED_CONTEXT,
      evalModel: "claude-opus-4-6",
    });

    console.log("PASS-CASE result:", JSON.stringify(result, null, 2));
    expect(result.pass).toBe(true);
  }, 180_000);

  it("judges an empty/error response as fail with critical severity", async () => {
    const result = await judgeAgentResponse({
      scenario: findScenario("EVAL-018"),
      agentResponse: "ERROR: model unavailable",
      conversationContext: CANNED_CONTEXT,
      evalModel: "claude-opus-4-6",
    });

    console.log("FAIL-CASE result:", JSON.stringify(result, null, 2));
    expect(result.pass).toBe(false);
    const severities = (result.issues ?? []).map((i) => i.severity);
    expect(severities.length).toBeGreaterThan(0);
  }, 180_000);
});
