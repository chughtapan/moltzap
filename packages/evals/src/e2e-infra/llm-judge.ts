import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Duration, Effect, Schedule, Stream } from "effect";
import { DEFAULT_JUDGE_MODEL } from "./model-config.js";
import { logger } from "./logger.js";
import {
  JudgeError,
  type EvalScenario,
  type JudgeResult,
  type TranscriptEntry,
} from "./types.js";

const JudgeResultSchema = Type.Object(
  {
    pass: Type.Boolean(),
    reason: Type.String(),
    issues: Type.Array(
      Type.Object(
        {
          issue: Type.String(),
          severity: Type.Union([
            Type.Literal("minor"),
            Type.Literal("significant"),
            Type.Literal("critical"),
          ]),
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
  schema: JudgeResultSchema as Record<string, unknown>, // #ignore-sloppy-code[record-cast]: SDK outputFormat expects opaque JSON schema Record
};

/**
 * One underlying call into the SDK. Wrapped in `Effect.tryPromise` so SDK
 * rejections become typed JudgeError failures in the Effect channel.
 */
function callJudgeEffect(opts: {
  userPrompt: string;
  model: string;
  abortSignal?: AbortSignal;
}): Effect.Effect<JudgeResult, JudgeError> {
  return Effect.acquireUseRelease(
    Effect.sync(() => linkAbort(opts.abortSignal)),
    ({ controller }) => {
      // `query` returns an async-iterable — bridge to a Stream so the
      // consumer stays Effect-native. We pull until the first `result`
      // message, then synthesise a typed JudgeResult or a typed failure.
      const stream = Stream.fromAsyncIterable(
        query({
          prompt: opts.userPrompt,
          options: buildJudgeQueryOptions({
            model: opts.model,
            controller,
            maxTurns: 5,
            outputFormat: JUDGE_OUTPUT_FORMAT,
          }),
        }),
        (err) =>
          new JudgeError({
            message: err instanceof Error ? err.message : String(err),
            fatal: isFatalError(err),
          }),
      );

      return stream.pipe(
        Stream.filter((msg) => msg.type === "result"),
        Stream.runHead,
        Effect.flatMap((headOpt) =>
          headOpt._tag === "None"
            ? Effect.fail(
                new JudgeError({
                  message: "Judge stream ended without a result message",
                  fatal: false,
                }),
              )
            : Effect.sync(() => headOpt.value),
        ),
        Effect.flatMap((msg) => {
          if (msg.subtype !== "success") {
            const errs = (msg.errors ?? []).join("; ");
            return Effect.fail(
              new JudgeError({
                message: `Judge ${msg.subtype}${errs ? `: ${errs}` : ""}`,
                fatal: isFatalError({
                  message: `Judge ${msg.subtype}`,
                } as Error),
              }),
            );
          }
          const so = msg.structured_output;
          if (so === undefined || so === null) {
            return Effect.fail(
              new JudgeError({
                message: "Judge success result missing structured_output",
                fatal: true,
              }),
            );
          }
          return Effect.try({
            try: () => {
              const parsed = Value.Parse(JudgeResultSchema, so);
              return {
                pass: parsed.pass,
                reason: parsed.reason || "No reason provided",
                issues: parsed.issues,
              } satisfies JudgeResult;
            },
            catch: (e) =>
              new JudgeError({
                message: e instanceof Error ? e.message : String(e),
                fatal: isFatalError(e),
              }),
          });
        }),
      );
    },
    ({ dispose }) => Effect.sync(() => dispose()),
  );
}

/** Errors that should bypass the retry loop — retrying is guaranteed to fail. */
function isFatalError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("aborted") ||
    msg.includes("Expected") || // TypeBox Value.Parse errors
    msg.includes("missing structured_output")
  );
}

/** Max attempts including the initial attempt. Preserves prior 3-try semantics. */
const MAX_JUDGE_ATTEMPTS = 3;

/**
 * Retry schedule: exponential backoff starting at 1s, doubling each time,
 * bounded to (MAX_JUDGE_ATTEMPTS - 1) retries. This keeps the same total
 * wait-time (~3s) and same attempt count (3) as the pre-Effect loop, so the
 * existing fake-timer tests still line up.
 *
 * We additionally bail out early on fatal errors via `while` — there's no
 * point retrying a parse error or an aborted signal.
 */
const judgeRetrySchedule = Schedule.intersect(
  Schedule.exponential(Duration.seconds(1), 2),
  Schedule.recurs(MAX_JUDGE_ATTEMPTS - 1),
).pipe(Schedule.whileInput((err: JudgeError) => !err.fatal));

/**
 * Effect-native judge call: timeout-protected, retried with exponential
 * backoff, and finally mapped to a critical-severity fallback JudgeResult so
 * the top-level runner never has to handle a raised error here. The error
 * channel is `never` because internal failures are folded into a
 * `JudgeResult`; the only remaining failure is the abort-before-attempt
 * defect, which surfaces via `Effect.runPromise` as a rejection.
 */
export const judgeAgentResponse = (opts: {
  scenario: EvalScenario;
  agentResponse: string;
  conversationContext: string;
  transcript?: TranscriptEntry[];
  evalModel?: string;
  abortSignal?: AbortSignal;
  buildPrompt?: typeof buildEvalPrompt;
}): Effect.Effect<JudgeResult, never> =>
  Effect.gen(function* () {
    // Synchronous pre-check: the existing test contract expects a throw
    // before any SDK call when the signal is already aborted. Raise as a
    // defect so `Effect.runPromise` surfaces it as a rejection.
    if (opts.abortSignal?.aborted) {
      throw new Error("Judge aborted before attempt");
    }

    const evalModel = opts.evalModel ?? DEFAULT_JUDGE_MODEL;
    const userPrompt = (opts.buildPrompt ?? buildEvalPrompt)({
      scenario: opts.scenario,
      agentResponse: opts.agentResponse,
      conversationContext: opts.conversationContext,
      transcript: opts.transcript,
    });

    const judge = callJudgeEffect({
      userPrompt,
      model: evalModel,
      abortSignal: opts.abortSignal,
    }).pipe(
      // Timeout individual attempts so a stuck model call doesn't hang the run.
      Effect.timeoutFail({
        duration: Duration.seconds(60),
        onTimeout: () =>
          new JudgeError({
            message: "Judge call timed out after 60s",
            fatal: false,
          }),
      }),
      Effect.retry(judgeRetrySchedule),
    );

    return yield* judge.pipe(
      Effect.catchTag("JudgeError", (err) => {
        logger.warn(
          err.fatal
            ? `Evaluation failed (fatal, no retry): ${err.message}`
            : `Evaluation failed after ${MAX_JUDGE_ATTEMPTS} attempts: ${err.message}`,
        );
        return Effect.succeed<JudgeResult>({
          pass: false,
          reason: `Evaluation flow failed: ${err.message}`,
          issues: [
            {
              issue: `Judge model error: ${err.message}`,
              severity: "critical",
            },
          ],
        });
      }),
    );
  });

/**
 * Summarize failure patterns from an eval run. Never fails — internal
 * errors fold into a descriptive markdown string.
 */
export const analyzeFailures = (opts: {
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
}): Effect.Effect<string, never> =>
  Effect.suspend(() => {
    if (opts.failures.length === 0) {
      return Effect.succeed("No failures to analyze.");
    }
    return analyzeFailuresImpl(opts);
  });

const analyzeFailuresImpl = (opts: {
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
}): Effect.Effect<string, never> => {
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

  return Effect.acquireUseRelease(
    Effect.sync(() => linkAbort(opts.abortSignal)),
    ({ controller }) => {
      const stream = Stream.fromAsyncIterable(
        query({
          prompt: analysisPrompt,
          options: buildJudgeQueryOptions({
            model: evalModel,
            controller,
            maxTurns: 1,
          }),
        }),
        (err) => (err instanceof Error ? err : new Error(String(err))),
      );
      return stream.pipe(
        Stream.filter((msg) => msg.type === "result"),
        Stream.runHead,
        Effect.map((headOpt) => {
          if (headOpt._tag === "None") {
            return "Analysis failed: stream ended without result.";
          }
          const msg = headOpt.value;
          if (msg.subtype !== "success")
            return `Analysis failed: ${msg.subtype}`;
          return msg.result || "Analysis returned no text.";
        }),
      );
    },
    ({ dispose }) => Effect.sync(() => dispose()),
  ).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`Error during analysis: ${msg}`);
        return `Analysis failed: ${msg}`;
      }),
    ),
  );
};
