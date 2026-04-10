import { describe, expect, it, vi } from "vitest";

const { mockQuery, asyncIter } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  function asyncIter<T>(messages: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        let i = 0;
        return {
          async next(): Promise<IteratorResult<T>> {
            if (i < messages.length)
              return { value: messages[i++]!, done: false };
            return { value: undefined as unknown as T, done: true };
          },
        };
      },
    };
  }
  return { mockQuery, asyncIter };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { judgeAgentResponse, analyzeFailures } from "../llm-judge.js";
import type { EvalScenario } from "../types.js";

const SCENARIO: EvalScenario = {
  id: "TEST-001",
  name: "test scenario",
  description: "a test",
  setupMessage: "hello",
  expectedBehavior: "respond politely",
  validationChecks: ["non-empty response"],
};

const SUCCESS = {
  type: "result" as const,
  subtype: "success" as const,
  structured_output: { pass: true, reason: "Looks good.", issues: [] },
  usage: { input_tokens: 100, output_tokens: 50 },
};

const ERROR_RESULT = {
  type: "result" as const,
  subtype: "error_during_execution" as const,
  errors: ["network blip"],
  usage: { input_tokens: 0, output_tokens: 0 },
};

describe("judgeAgentResponse", () => {
  it("returns the parsed judgment and passes the right SDK options", async () => {
    mockQuery.mockReset();
    mockQuery.mockReturnValueOnce(asyncIter([SUCCESS]));

    const result = await judgeAgentResponse({
      scenario: SCENARIO,
      agentResponse: "hi",
      conversationContext: "{}",
      evalModel: "claude-opus-4-6",
    });

    expect(result.pass).toBe(true);
    expect(result.reason).toBe("Looks good.");
    const call = mockQuery.mock.calls[0]![0]!;
    expect(call.options.model).toBe("claude-opus-4-6");
    expect(call.options.systemPrompt).toBe("");
    expect(call.options.outputFormat.type).toBe("json_schema");
    expect(call.options.settingSources).toEqual([]);
    expect(call.options.persistSession).toBe(false);
    expect(call.options.tools).toEqual([]);
    expect(call.options.maxTurns).toBeGreaterThanOrEqual(2);
    // Persona must stay inline in user prompt, not lifted to systemPrompt.
    expect(call.prompt).toContain("You are an expert QA evaluator");
  });

  it("retries on transient SDK errors and eventually succeeds", async () => {
    vi.useFakeTimers();
    mockQuery.mockReset();
    mockQuery
      .mockReturnValueOnce(asyncIter([ERROR_RESULT]))
      .mockReturnValueOnce(asyncIter([SUCCESS]));

    const promise = judgeAgentResponse({
      scenario: SCENARIO,
      agentResponse: "hi",
      conversationContext: "{}",
      evalModel: "claude-opus-4-6",
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.pass).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("returns critical-severity fallback after 3 failed attempts", async () => {
    vi.useFakeTimers();
    mockQuery.mockReset();
    mockQuery.mockReturnValue(asyncIter([ERROR_RESULT]));

    const promise = judgeAgentResponse({
      scenario: SCENARIO,
      agentResponse: "hi",
      conversationContext: "{}",
      evalModel: "claude-opus-4-6",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.pass).toBe(false);
    expect(result.issues?.[0]?.severity).toBe("critical");
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("rejects before first attempt when signal is already aborted", async () => {
    mockQuery.mockReset();
    const ac = new AbortController();
    ac.abort();

    await expect(
      judgeAgentResponse({
        scenario: SCENARIO,
        agentResponse: "hi",
        conversationContext: "{}",
        evalModel: "claude-opus-4-6",
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow(/aborted before attempt/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("honors a custom buildPrompt override", async () => {
    mockQuery.mockReset();
    mockQuery.mockReturnValueOnce(asyncIter([SUCCESS]));

    await judgeAgentResponse({
      scenario: SCENARIO,
      agentResponse: "hi",
      conversationContext: "{}",
      evalModel: "claude-opus-4-6",
      buildPrompt: () => "CUSTOM PROMPT BODY",
    });

    expect(mockQuery.mock.calls[0]![0]!.prompt).toBe("CUSTOM PROMPT BODY");
  });
});

describe("analyzeFailures", () => {
  it("returns the SDK's text result on success", async () => {
    mockQuery.mockReset();
    mockQuery.mockReturnValueOnce(
      asyncIter([
        {
          type: "result" as const,
          subtype: "success" as const,
          result: "## Failure analysis\n- 2 schema failures",
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      ]),
    );

    const text = await analyzeFailures({
      failures: [
        {
          scenarioId: "TEST-001",
          runNumber: 1,
          failureType: "Schema Validation",
          reason: "missing field",
        },
      ],
      numRuns: 5,
      evalModel: "claude-opus-4-6",
    });

    expect(text).toContain("Failure analysis");
  });

  it("short-circuits with no SDK call when failures are empty", async () => {
    mockQuery.mockReset();
    const text = await analyzeFailures({
      failures: [],
      numRuns: 5,
      evalModel: "claude-opus-4-6",
    });

    expect(text).toBe("No failures to analyze.");
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
