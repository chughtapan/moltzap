import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { stringEnum } from "@moltzap/protocol";
import { DEFAULT_JUDGE_MODEL } from "./model-config.js";
import { logger } from "./logger.js";
import type { EvalScenario, JudgeResult, TranscriptEntry } from "./types.js";

const JudgeResultSchema = Type.Object(
  {
    pass: Type.Boolean(),
    reason: Type.String(),
    issues: Type.Array(
      Type.Object(
        {
          issue: Type.String(),
          severity: stringEnum(["minor", "significant", "critical"]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export function formatTranscript(transcript: TranscriptEntry[]): string {
  const convIds = [...new Set(transcript.map((t) => t.conversationId))];
  if (convIds.length <= 1) {
    return transcript.map((t) => `[${t.role}]: ${t.text}`).join("\n");
  }
  let result = "";
  let currentConv = "";
  for (const entry of transcript) {
    if (entry.conversationId !== currentConv) {
      currentConv = entry.conversationId;
      const idx = convIds.indexOf(currentConv) + 1;
      result += `\n--- Conversation ${idx} (${currentConv.slice(0, 8)}...) ---\n`;
    }
    result += `[${entry.role}]: ${entry.text}\n`;
  }
  return result;
}

export function buildEvalPrompt(opts: {
  scenario: EvalScenario;
  agentResponse: string;
  conversationContext: string;
  transcript?: TranscriptEntry[];
}): string {
  const conversationSection =
    opts.transcript && opts.transcript.length > 0
      ? formatTranscript(opts.transcript)
      : opts.scenario.setupMessage;

  return `You are an expert QA evaluator for an agent messaging system called MoltZap.
Your task is to evaluate whether an AI agent correctly handled a test scenario.

## Scenario
**ID:** ${opts.scenario.id}
**Name:** ${opts.scenario.name}
**Description:** ${opts.scenario.description}

## Full conversation transcript
\`\`\`
${conversationSection}
\`\`\`
${opts.scenario.followUpMessages ? `\n**Note:** This is a multi-turn scenario. The follow-up messages were: ${opts.scenario.followUpMessages.map((m) => `"${m}"`).join(", ")}` : ""}
${opts.scenario.crossConversationProbe ? `\n**Note:** This is a cross-conversation scenario. The probe "${opts.scenario.crossConversationProbe}" was sent from a DIFFERENT conversation by a DIFFERENT agent.` : ""}

## Conversation context (protocol metadata)
${opts.conversationContext}

## Final agent response being evaluated
\`\`\`
${opts.agentResponse}
\`\`\`

## Expected behavior
${opts.scenario.expectedBehavior}

## Validation checks that must pass
${opts.scenario.validationChecks.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Instructions
1. Analyze the agent's response against the expected behavior.
2. Check each validation point listed above.
3. If the response satisfies the scenario requirements, return "pass": true.
4. If there are issues, return "pass": false with specific issues and their severity.
5. Be lenient on exact wording -- the agent's personality may vary -- but strict on protocol correctness.

## Severity definitions
- **Minor**: Cosmetic or slight deviation (odd phrasing, extra verbosity).
- **Significant**: The response is confusing, off-topic, or partially incorrect.
- **Critical**: The agent failed to respond, returned an error, or violated protocol constraints.

Return a JSON object matching this schema:

\`\`\`json
{
  "type": "object",
  "properties": {
    "pass": { "type": "boolean" },
    "reason": { "type": "string" },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "issue": { "type": "string" },
          "severity": { "type": "string", "enum": ["minor", "significant", "critical"] }
        },
        "required": ["issue", "severity"]
      }
    }
  },
  "required": ["pass", "reason", "issues"]
}
\`\`\`
`;
}

/** Bridges an external AbortSignal into a fresh AbortController; returns a disposer for cleanup. */
function linkAbort(signal: AbortSignal | undefined): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (!signal) return { controller, dispose: () => {} };
  if (signal.aborted) {
    controller.abort();
    return { controller, dispose: () => {} };
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/** Common SDK option baseline for both judge calls. */
function buildJudgeQueryOptions(opts: {
  model: string;
  controller: AbortController;
  maxTurns: number;
  outputFormat?: Options["outputFormat"];
}): Options {
  return {
    model: opts.model,
    // Suppress the SDK's default Claude Code persona — judge persona is inline in the user prompt.
    systemPrompt: "",
    // With outputFormat the SDK uses a synthesis turn after the model response, so 1 is too tight.
    maxTurns: opts.maxTurns,
    settingSources: [],
    persistSession: false,
    tools: [],
    abortController: opts.controller,
    ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
  };
}

const JUDGE_OUTPUT_FORMAT: Options["outputFormat"] = {
  type: "json_schema",
  schema: JudgeResultSchema as Record<string, unknown>,
};

async function callJudgeWithSdk(opts: {
  userPrompt: string;
  model: string;
  abortSignal?: AbortSignal;
}): Promise<JudgeResult> {
  const { controller, dispose } = linkAbort(opts.abortSignal);
  try {
    const stream = query({
      prompt: opts.userPrompt,
      options: buildJudgeQueryOptions({
        model: opts.model,
        controller,
        maxTurns: 5,
        outputFormat: JUDGE_OUTPUT_FORMAT,
      }),
    });

    for await (const msg of stream) {
      if (msg.type !== "result") continue;
      if (msg.subtype === "success") {
        const so = msg.structured_output;
        if (so === undefined || so === null) {
          throw new Error("Judge success result missing structured_output");
        }
        const parsed = Value.Parse(JudgeResultSchema, so);
        return {
          pass: parsed.pass,
          reason: parsed.reason || "No reason provided",
          issues: parsed.issues,
        };
      }
      const errs = (msg.errors ?? []).join("; ");
      throw new Error(`Judge ${msg.subtype}${errs ? `: ${errs}` : ""}`);
    }

    throw new Error("Judge stream ended without a result message");
  } finally {
    dispose();
  }
}

/** Errors that should bypass the retry loop — retrying is guaranteed to fail. */
function isFatal(err: Error): boolean {
  const msg = err.message;
  return (
    msg.includes("aborted") ||
    msg.includes("Expected") || // TypeBox Value.Parse errors
    msg.includes("missing structured_output")
  );
}

/** Evaluate a single agent response using the LLM judge. */
export async function judgeAgentResponse(opts: {
  scenario: EvalScenario;
  agentResponse: string;
  conversationContext: string;
  transcript?: TranscriptEntry[];
  evalModel?: string;
  abortSignal?: AbortSignal;
  buildPrompt?: typeof buildEvalPrompt;
}): Promise<JudgeResult> {
  const evalModel = opts.evalModel ?? DEFAULT_JUDGE_MODEL;
  const userPrompt = (opts.buildPrompt ?? buildEvalPrompt)({
    scenario: opts.scenario,
    agentResponse: opts.agentResponse,
    conversationContext: opts.conversationContext,
    transcript: opts.transcript,
  });

  const maxRetries = 3;
  let attempt = 0;
  while (true) {
    if (opts.abortSignal?.aborted) {
      throw new Error("Judge aborted before attempt");
    }
    try {
      return await callJudgeWithSdk({
        userPrompt,
        model: evalModel,
        abortSignal: opts.abortSignal,
      });
    } catch (e: unknown) {
      const err = e as Error;
      const isLast = attempt === maxRetries - 1;
      if (isFatal(err) || isLast) {
        logger.warn(
          isLast
            ? `Evaluation failed after ${maxRetries} attempts: ${err.message}`
            : `Evaluation failed (fatal, no retry): ${err.message}`,
        );
        return {
          pass: false,
          reason: `Evaluation flow failed: ${err.message}`,
          issues: [
            {
              issue: `Judge model error: ${err.message}`,
              severity: "critical",
            },
          ],
        };
      }
      attempt++;
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
      );
    }
  }
}

/** Summarize failure patterns from an eval run. Plain-text Claude output. */
export async function analyzeFailures(opts: {
  failures: Array<{
    scenarioId: string;
    runNumber: number;
    failureType: string;
    reason: string;
    issues?: string[];
  }>;
  numRuns: number;
  evalModel?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  if (opts.failures.length === 0) {
    return "No failures to analyze.";
  }
  const evalModel = opts.evalModel ?? DEFAULT_JUDGE_MODEL;

  const failureDetails = opts.failures
    .map((f) => {
      let details = `Scenario: ${f.scenarioId} (Run ${f.runNumber})\nType: ${f.failureType}\nReason: ${f.reason}`;
      if (f.issues && f.issues.length > 0) {
        details += `\nIssues:\n- ${f.issues.join("\n- ")}`;
      }
      return details;
    })
    .join("\n\n---\n\n");

  const analysisPrompt = `You are an expert AI analyst.
Analyze the following failures from a MoltZap agent messaging eval run.

${opts.failures.length} failures out of ${opts.numRuns} total runs.
${opts.failures.filter((f) => f.failureType === "Schema Validation").length} schema validation failures.
${opts.failures.filter((f) => f.failureType === "Evaluation Failure").length} evaluation failures.
${opts.numRuns - opts.failures.length} successful runs.

Failures:
${failureDetails}

Instructions:
1. Identify the broad types of errors (Schema Validation, Response Quality, Timeout, etc.).
2. Analyze patterns (e.g., "The agent consistently fails to respond within timeout").
3. Provide a concise summary.

Output Format:
Return a short Markdown-formatted summary with headers and bullet points.
`;

  const { controller, dispose } = linkAbort(opts.abortSignal);
  try {
    const stream = query({
      prompt: analysisPrompt,
      options: buildJudgeQueryOptions({
        model: evalModel,
        controller,
        maxTurns: 1,
      }),
    });

    for await (const msg of stream) {
      if (msg.type !== "result") continue;
      if (msg.subtype === "success") {
        return msg.result || "Analysis returned no text.";
      }
      return `Analysis failed: ${msg.subtype}`;
    }
    return "Analysis failed: stream ended without result.";
  } catch (e: unknown) {
    const err = e as Error;
    logger.error(`Error during analysis: ${err.message}`);
    return `Analysis failed: ${err.message}`;
  } finally {
    dispose();
  }
}
