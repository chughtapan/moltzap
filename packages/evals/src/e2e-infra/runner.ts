/**
 * Main E2E eval orchestrator. Four phases: generate → validate → evaluate →
 * analyze. Each phase's own JSDoc documents its shape and concurrency.
 */

import { Duration, Effect } from "effect";
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
} from "@moltzap/server-core/test-utils";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import {
  launchFleet,
  type AgentFleet,
  type AgentRuntime,
} from "./agent-fleet.js";
import { TIER5_SCENARIOS } from "./scenarios.js";
import { analyzeFailures, judgeAgentResponse } from "./llm-judge.js";
import { generateReport, generateSummaryMarkdown } from "./report.js";
import { DEFAULT_JUDGE_MODEL, DEFAULT_AGENT_MODEL_ID } from "./model-config.js";
import { logger } from "./logger.js";
import type {
  EvalScenario,
  GeneratedResult,
  TranscriptEntry,
  ValidatedResult,
  EvaluatedResult,
  E2ERunResult,
  IssueSeverity,
} from "./types.js";

const AGENT_RESPONSE_TIMEOUT_MS = 120_000;
/** Concurrency cap for the evaluation phase (LLM judge calls). */
const EVAL_PHASE_CONCURRENCY = 4;
/** Settle window after a group message so bystander agents can pipe a side reply. */
const BYSTANDER_SETTLE_MS = 3000;

/** Validate a MoltZap message response against protocol constraints. */
function validateResponse(result: GeneratedResult): ValidatedResult {
  const errors: string[] = [];

  if (result.error) {
    errors.push(`Generation error: ${result.error}`);
    return { ...result, validationErrors: errors };
  }

  if (!result.agentResponse || result.agentResponse.trim() === "") {
    errors.push("Agent response is empty");
  }

  // The response text is what we got from the agent via MoltZap.
  // We validate context metadata embedded during generation.
  if (result.conversationContext) {
    try {
      const ctx = JSON.parse(result.conversationContext) as {
        conversationId?: string;
        senderId?: string;
        messageId?: string;
        parts?: Array<{ type: string; text?: string }>;
      };

      if (!ctx.conversationId) {
        errors.push("Response missing conversationId");
      }
      if (!ctx.senderId) {
        errors.push("Response missing sender agent ID");
      }
      if (!ctx.messageId) {
        errors.push("Response missing message ID");
      }
      if (!ctx.parts || ctx.parts.length === 0) {
        errors.push("Response has no message parts");
      } else {
        const hasText = ctx.parts.some(
          (p) => p.type === "text" && p.text && p.text.trim() !== "",
        );
        if (!hasText) {
          errors.push("Response has no non-empty text parts");
        }
      }
    } catch (err) {
      errors.push(
        `Conversation context is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { ...result, validationErrors: errors };
}

type RawMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  parts: Array<{ type: string; text?: string }>;
  createdAt: string;
};

/** Effect-native: send a message and wait for a matching response. */
export const sendAndWaitForResponseEffect = (opts: {
  client: MoltZapTestClient;
  conversationId: string;
  message: string;
  expectedSenderId: string;
  timeoutMs: number;
}): Effect.Effect<{ responseText: string; rawMessage: RawMessage }, Error> =>
  Effect.gen(function* () {
    const { client, conversationId, message, expectedSenderId, timeoutMs } =
      opts;

    yield* client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: message }],
    });

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = Math.max(1000, deadline - Date.now());
      const maybeEvent = yield* client
        .waitForEvent("messages/received", remaining)
        .pipe(
          // Per-poll timeout is expected; the outer while-loop enforces the
          // real deadline.
          Effect.either,
        );
      if (maybeEvent._tag === "Left") continue;
      const msg = (maybeEvent.right.data as { message: RawMessage }).message;
      if (
        msg.conversationId === conversationId &&
        msg.senderId === expectedSenderId
      ) {
        const responseText = msg.parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n");
        return { responseText, rawMessage: msg };
      }
    }

    return yield* Effect.fail(
      new Error(
        `Timeout waiting for agent response in conversation ${conversationId}`,
      ),
    );
  });

/** Promise-facing wrapper for callers outside Effect. */
export function sendAndWaitForResponse(opts: {
  client: MoltZapTestClient;
  conversationId: string;
  message: string;
  expectedSenderId: string;
  timeoutMs: number;
  // #ignore-sloppy-code-next-line[promise-type]: public signature kept for external callers; orchestration is Effect-native above
}): Promise<{ responseText: string; rawMessage: RawMessage }> {
  return Effect.runPromise(sendAndWaitForResponseEffect(opts));
}

/**
 * Phase 1: Send a scenario to the agent and capture its response.
 *
 * Supports DM and group conversations, multi-turn exchanges,
 * and cross-conversation probes.
 */
// #ignore-sloppy-code-next-line[async-keyword]: evals scenario orchestration boundary
async function generateResult(opts: {
  scenario: EvalScenario;
  testClient: MoltZapTestClient;
  agentId: string;
  runNumber: number;
  modelName: string;
  /** Connected bystander agents for group scenarios. */
  bystanders?: Array<{ client: MoltZapTestClient; agentId: string }>;
  /** Separate probe client for cross-conversation scenarios (different sender than testClient). */
  probeClient?: MoltZapTestClient;
  // #ignore-sloppy-code-next-line[promise-type]: evals scenario orchestration boundary
}): Promise<GeneratedResult> {
  const { scenario, testClient, agentId, runNumber, modelName } = opts;
  const start = performance.now();

  try {
    const transcript: TranscriptEntry[] = [];
    let conversationId: string;

    // Create conversation based on type
    if (scenario.conversationType === "group") {
      const bystanderParticipants = (opts.bystanders ?? [])
        .slice(0, scenario.groupBystanders ?? 0)
        .map((b) => ({ type: "agent" as const, id: b.agentId }));

      const conv = (await Effect.runPromise(
        testClient.rpc("conversations/create", {
          type: "group",
          name: `Eval Group ${scenario.id}`,
          participants: [
            { type: "agent", id: agentId },
            ...bystanderParticipants,
          ],
        }),
      )) as { conversation: { id: string; type: string } };
      conversationId = conv.conversation.id;

      // Send bystander messages to create realistic group context
      if (scenario.bystanderMessages && opts.bystanders) {
        for (
          let i = 0;
          i < scenario.bystanderMessages.length &&
          i < (opts.bystanders.length ?? 0);
          i++
        ) {
          const bystander = opts.bystanders[i]!;
          await Effect.runPromise(
            bystander.client.rpc("messages/send", {
              conversationId,
              parts: [{ type: "text", text: scenario.bystanderMessages[i] }],
            }),
          );
          transcript.push({
            role: "user",
            text: scenario.bystanderMessages[i]!,
            conversationId,
          });
        }

        // Settle: let agent process bystander messages, then drain events
        await new Promise((r) => setTimeout(r, BYSTANDER_SETTLE_MS));
        testClient.drainEvents();
      }
    } else {
      const conv = (await Effect.runPromise(
        testClient.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: agentId }],
        }),
      )) as { conversation: { id: string; type: string } };
      conversationId = conv.conversation.id;
    }

    // Send the initial setup message
    let lastResponse = await sendAndWaitForResponse({
      client: testClient,
      conversationId,
      message: scenario.setupMessage,
      expectedSenderId: agentId,
      timeoutMs: AGENT_RESPONSE_TIMEOUT_MS,
    });
    transcript.push({
      role: "user",
      text: scenario.setupMessage,
      conversationId,
    });
    transcript.push({
      role: "agent",
      text: lastResponse.responseText,
      conversationId,
    });

    // Send follow-up messages for multi-turn scenarios
    if (scenario.followUpMessages) {
      for (const followUp of scenario.followUpMessages) {
        lastResponse = await sendAndWaitForResponse({
          client: testClient,
          conversationId,
          message: followUp,
          expectedSenderId: agentId,
          timeoutMs: AGENT_RESPONSE_TIMEOUT_MS,
        });
        transcript.push({ role: "user", text: followUp, conversationId });
        transcript.push({
          role: "agent",
          text: lastResponse.responseText,
          conversationId,
        });
      }
    }

    // Cross-conversation probe: send from a DIFFERENT agent in a NEW conversation
    if (scenario.crossConversationProbe && opts.probeClient) {
      const probeConv = (await Effect.runPromise(
        opts.probeClient.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: agentId }],
        }),
      )) as { conversation: { id: string } };

      const probeConvId = probeConv.conversation.id;
      lastResponse = await sendAndWaitForResponse({
        client: opts.probeClient,
        conversationId: probeConvId,
        message: scenario.crossConversationProbe,
        expectedSenderId: agentId,
        timeoutMs: AGENT_RESPONSE_TIMEOUT_MS,
      });
      transcript.push({
        role: "user",
        text: scenario.crossConversationProbe,
        conversationId: probeConvId,
      });
      transcript.push({
        role: "agent",
        text: lastResponse.responseText,
        conversationId: probeConvId,
      });
    }

    const { responseText, rawMessage } = lastResponse;

    const conversationContext = JSON.stringify({
      conversationId: rawMessage.conversationId,
      senderId: rawMessage.senderId,
      messageId: rawMessage.id,
      parts: rawMessage.parts,
      createdAt: rawMessage.createdAt,
    });

    return {
      scenarioId: scenario.id,
      scenario,
      modelName,
      runNumber,
      agentResponse: responseText,
      conversationContext,
      latencyMs: performance.now() - start,
      transcript,
    };
  } catch (e: unknown) {
    const err = e as Error;
    return {
      scenarioId: scenario.id,
      scenario,
      modelName,
      runNumber,
      agentResponse: "",
      conversationContext: "",
      latencyMs: performance.now() - start,
      error: err.message,
    };
  }
}

export { type AgentRuntime } from "./agent-fleet.js";

interface ScenarioJob {
  scenario: EvalScenario;
  run: number;
  index: number; // 1-based, for logging
}

/** Sequential: scenarios share the eval client, and `drainEvents` between
 * jobs would clear stale events from prior runs. */
function generatePhase(
  jobs: ScenarioJob[],
  ctx: {
    evalClient: MoltZapTestClient;
    probeClient: MoltZapTestClient;
    agentId: string;
    modelName: string;
    bystanders: Array<{ client: MoltZapTestClient; agentId: string }>;
    totalJobs: number;
    signal?: AbortSignal;
  },
): Effect.Effect<GeneratedResult[], never> {
  return Effect.forEach(jobs, (job) =>
    Effect.gen(function* () {
      if (ctx.signal?.aborted) {
        return yield* Effect.succeed({
          scenarioId: job.scenario.id,
          scenario: job.scenario,
          modelName: ctx.modelName,
          runNumber: job.run,
          agentResponse: "",
          conversationContext: "",
          latencyMs: 0,
          error: "Aborted before generation",
        } as GeneratedResult);
      }

      // Drain stale events between scenarios — previous agent responses
      // can leak into the next scenario's waitForEvent since DM conversations
      // are reused (findExistingDm returns the same conv).
      yield* Effect.sync(() => ctx.evalClient.drainEvents());
      // Wait for any in-flight agent responses to settle.
      yield* Effect.sleep(Duration.seconds(2));
      yield* Effect.sync(() => ctx.evalClient.drainEvents());

      yield* Effect.sync(() => {
        logger.info(
          `[${job.index}/${ctx.totalJobs}] ${job.scenario.id} run ${job.run}`,
        );
      });

      // `generateResult` catches its own errors into the returned shape, so
      // the Promise never rejects — but we still route it through
      // `tryPromise` + `catchAll` rather than `Effect.promise` to keep the
      // "unexpected defect" channel honest.
      return yield* Effect.tryPromise({
        try: () =>
          generateResult({
            scenario: job.scenario,
            testClient: ctx.evalClient,
            agentId: ctx.agentId,
            runNumber: job.run,
            modelName: ctx.modelName,
            bystanders: ctx.bystanders,
            probeClient: ctx.probeClient,
          }),
        catch: (err) => err,
      }).pipe(
        Effect.catchAll((err) =>
          Effect.succeed({
            scenarioId: job.scenario.id,
            scenario: job.scenario,
            modelName: ctx.modelName,
            runNumber: job.run,
            agentResponse: "",
            conversationContext: "",
            latencyMs: 0,
            error: err instanceof Error ? err.message : String(err),
          } as GeneratedResult),
        ),
      );
    }),
  );
}

/** Pure per-item transform; no Effect needed. */
function validatePhase(generated: GeneratedResult[]): ValidatedResult[] {
  return generated.map((r) => {
    const v = validateResponse(r);
    if (v.validationErrors.length > 0) {
      logger.warn(
        `${v.scenarioId} run ${v.runNumber}: ${v.validationErrors.length} validation error(s)`,
      );
    }
    return v;
  });
}

/** Build the EvaluatedResult for hard-failed validations or generation. */
function evaluatedFromValidationFailure(v: ValidatedResult): EvaluatedResult {
  return {
    ...v,
    judgeResult: {
      pass: false,
      reason:
        v.error ?? `Schema validation failed: ${v.validationErrors.join("; ")}`,
      issues: v.validationErrors.map((e) => ({
        issue: e,
        severity: "critical" as IssueSeverity,
      })),
      overallSeverity: "critical" as IssueSeverity,
    },
  };
}

function computeOverallSeverity(
  issues: Array<{ severity: IssueSeverity }> | undefined,
  pass: boolean,
): IssueSeverity | undefined {
  if (pass || !issues) return undefined;
  const severities = issues.map((i) => i.severity);
  if (severities.includes("critical")) return "critical";
  if (severities.includes("significant")) return "significant";
  if (severities.includes("minor")) return "minor";
  return undefined;
}

/** Concurrency 4 overlaps the (slow) LLM judge calls. Deterministic
 * pass/fail checks short-circuit without invoking the judge. */
function evaluatePhase(
  validated: ValidatedResult[],
  opts: { evalModel: string; signal?: AbortSignal },
): Effect.Effect<EvaluatedResult[], never> {
  return Effect.forEach(
    validated,
    (v) =>
      Effect.gen(function* () {
        if (v.error || v.validationErrors.length > 0) {
          return evaluatedFromValidationFailure(v);
        }
        if (v.scenario.deterministicPassCheck?.(v.agentResponse)) {
          yield* Effect.sync(() => {
            logger.info(
              `${v.scenarioId} run ${v.runNumber}: Deterministic pass check matched`,
            );
          });
          return {
            ...v,
            judgeResult: {
              pass: true,
              reason: "Deterministic pass check matched",
            },
          } satisfies EvaluatedResult;
        }
        if (v.scenario.deterministicFailCheck?.(v.agentResponse)) {
          yield* Effect.sync(() => {
            logger.info(
              `${v.scenarioId} run ${v.runNumber}: Deterministic fail check matched`,
            );
          });
          return {
            ...v,
            judgeResult: {
              pass: false,
              reason: "Deterministic fail check matched",
              issues: [
                {
                  issue: "Response matched deterministic failure pattern",
                  severity: "critical" as IssueSeverity,
                },
              ],
              overallSeverity: "critical" as IssueSeverity,
            },
          } satisfies EvaluatedResult;
        }

        yield* Effect.sync(() => {
          logger.info(
            `${v.scenarioId} run ${v.runNumber}: Running LLM judge...`,
          );
        });

        const judge = yield* judgeAgentResponse({
          scenario: v.scenario,
          agentResponse: v.agentResponse,
          conversationContext: v.conversationContext,
          transcript: v.transcript,
          evalModel: opts.evalModel,
          abortSignal: opts.signal,
        });

        const overallSeverity = computeOverallSeverity(
          judge.issues,
          judge.pass,
        );

        const evaluated: EvaluatedResult = {
          ...v,
          judgeResult: { ...judge, overallSeverity },
        };

        yield* Effect.sync(() => {
          const status = evaluated.judgeResult?.pass ? "PASS" : "FAIL";
          logger.info(
            `${v.scenarioId} run ${v.runNumber}: ${status} (${evaluated.latencyMs.toFixed(0)}ms)`,
          );
        });

        return evaluated;
      }),
    { concurrency: EVAL_PHASE_CONCURRENCY },
  );
}

/**
 * Phase 4: aggregate results into an E2ERunResult and optionally feed the
 * LLM failure-analysis prompt.
 */
function analyzePhase(
  allResults: EvaluatedResult[],
  opts: { evalModel: string; signal?: AbortSignal; outputDir?: string },
): Effect.Effect<{ result: E2ERunResult; analysisText: string | undefined }> {
  return Effect.gen(function* () {
    const failures = allResults.filter(
      (r) =>
        r.error ||
        r.validationErrors.length > 0 ||
        (r.judgeResult && !r.judgeResult.pass),
    );

    let analysisText: string | undefined;
    if (failures.length > 0) {
      yield* Effect.sync(() => {
        logger.info(
          `Running failure analysis on ${failures.length} failure(s)...`,
        );
      });
      // analyzeFailures is Effect-native and never fails — yield directly.
      analysisText = yield* analyzeFailures({
        failures: failures.map((f) => ({
          scenarioId: f.scenarioId,
          runNumber: f.runNumber,
          failureType: f.error
            ? "Generation Error"
            : f.validationErrors.length > 0
              ? "Schema Validation"
              : "Evaluation Failure",
          reason: f.error ?? f.judgeResult?.reason ?? "Unknown",
          issues: f.judgeResult?.issues?.map(
            (i) => `${i.severity}: ${i.issue}`,
          ),
        })),
        numRuns: allResults.length,
        evalModel: opts.evalModel,
        abortSignal: opts.signal,
      });
    }

    if (opts.outputDir) {
      yield* Effect.sync(() => {
        generateReport(allResults, opts.outputDir!, analysisText);
      });
    }

    yield* Effect.sync(() => {
      const summary = generateSummaryMarkdown(allResults, analysisText);
      logger.info(summary);
    });

    const passed = allResults.filter(
      (r) =>
        !r.error &&
        r.validationErrors.length === 0 &&
        (!r.judgeResult || r.judgeResult.pass),
    ).length;
    const totalLatency = allResults.reduce((sum, r) => sum + r.latencyMs, 0);

    return {
      result: {
        results: allResults,
        summary: {
          total: allResults.length,
          passed,
          failed: allResults.length - passed,
          avgLatencyMs:
            allResults.length > 0 ? totalLatency / allResults.length : 0,
        },
      },
      analysisText,
    };
  });
}

/** Error surfaced from `runE2EEvals`. Tests + callers at the process edge
 * unwrap this via `Effect.runPromise`, which throws a `FiberFailure`. */
export class RunError extends Error {
  readonly _tag = "RunError" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunError";
  }
}

export interface RunE2EEvalsOptions {
  scenarios?: string[];
  agentModelId?: string;
  runsPerScenario?: number;
  evalModel?: string;
  resultsDir?: string;
  cleanResults?: boolean;
  logLevel?: string;
  signal?: AbortSignal;
  runtime?: AgentRuntime;
}

export const runE2EEvals = (
  opts: RunE2EEvalsOptions,
): Effect.Effect<E2ERunResult, RunError> =>
  Effect.tryPromise({
    try: () => runE2EEvalsImpl(opts),
    catch: (e) =>
      new RunError(e instanceof Error ? e.message : String(e), {
        cause: e,
      }),
  });

// #ignore-sloppy-code-next-line[async-keyword]: evals top-level orchestration boundary
async function runE2EEvalsImpl(
  opts: RunE2EEvalsOptions,
  // #ignore-sloppy-code-next-line[promise-type]: evals top-level orchestration boundary
): Promise<E2ERunResult> {
  const {
    scenarios: scenarioFilter,
    runsPerScenario = 1,
    evalModel = DEFAULT_JUDGE_MODEL,
    resultsDir,
    cleanResults = false,
  } = opts;

  const modelName = opts.agentModelId ?? DEFAULT_AGENT_MODEL_ID;

  // Filter scenarios
  let selectedScenarios = TIER5_SCENARIOS;
  if (scenarioFilter && scenarioFilter.length > 0) {
    selectedScenarios = TIER5_SCENARIOS.filter((s) =>
      scenarioFilter.some((f) => s.id.startsWith(f) || s.id === f),
    );
    if (selectedScenarios.length === 0) {
      throw new Error(
        `No scenarios match filter: ${scenarioFilter.join(", ")}`,
      );
    }
  }

  // Clean results directory
  const outputDir =
    resultsDir ?? `results/output-${modelName.replace(/[/:]/g, "_")}`;
  if (cleanResults) {
    const fs = await import("node:fs");
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }

  const runtime: AgentRuntime = opts.runtime ?? "openclaw";
  let fleet: AgentFleet | null = null;
  let testServerBaseUrl = "";
  let testServerWsUrl = "";
  const clientsToClose: MoltZapTestClient[] = [];

  try {
    // Phase 0: Start test infrastructure
    logger.info("Starting MoltZap core test server (testcontainers)...");
    const server = await startCoreTestServer();
    testServerBaseUrl = server.baseUrl;
    testServerWsUrl = server.wsUrl;
    await resetCoreTestDb();

    // Register eval sender agent (core: no invites, direct registration)
    const evalClient = new MoltZapTestClient(
      testServerBaseUrl,
      testServerWsUrl,
    );
    const evalReg = await Effect.runPromise(evalClient.register("eval-runner"));

    // Register the OpenClaw agent account
    const registrationClient = new MoltZapTestClient(
      testServerBaseUrl,
      testServerWsUrl,
    );
    const agentReg = await Effect.runPromise(
      registrationClient.register("openclaw-eval-agent"),
    );
    await Effect.runPromise(registrationClient.close());

    // Connect eval client
    await Effect.runPromise(evalClient.connect(evalReg.apiKey));
    clientsToClose.push(evalClient);

    // Register probe agent for cross-conversation scenarios (different sender)
    const probeClient = new MoltZapTestClient(
      testServerBaseUrl,
      testServerWsUrl,
    );
    const probeReg = await Effect.runPromise(
      probeClient.register("eval-probe"),
    );
    await Effect.runPromise(probeClient.connect(probeReg.apiKey));
    clientsToClose.push(probeClient);

    // Register + connect bystander agents for group scenarios (parallel).
    const maxBystanders = Math.max(
      0,
      ...selectedScenarios.map((s) => s.groupBystanders ?? 0),
    );
    const bystanderIndices = Array.from({ length: maxBystanders }, (_, i) => i);
    const bystanders = await Effect.runPromise(
      Effect.forEach(
        bystanderIndices,
        (i) => {
          // Compose the register/connect pair from small Effects so the try
          // closure stays synchronous (no `async` keyword boundary).
          const bc = new MoltZapTestClient(testServerBaseUrl, testServerWsUrl);
          return bc.register(`bystander-${i}`).pipe(
            Effect.flatMap((reg) =>
              bc.connect(reg.apiKey).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    clientsToClose.push(bc);
                  }),
                ),
                Effect.as({ client: bc, agentId: reg.agentId }),
              ),
            ),
          );
        },
        { concurrency: "unbounded" },
      ),
    );

    // Start the agent runtime via fleet API (blocks until connected).
    fleet = await launchFleet({
      runtime,
      agents: [{ name: "openclaw-eval-agent", apiKey: agentReg.apiKey }],
      serverUrl: testServerWsUrl,
      modelId: opts.agentModelId,
    });
    logger.info("Agent connected. Starting eval scenarios...");

    // Build the job list (scenario × run).
    const jobs: ScenarioJob[] = [];
    let idx = 0;
    for (const scenario of selectedScenarios) {
      for (let run = 1; run <= runsPerScenario; run++) {
        jobs.push({ scenario, run, index: ++idx });
      }
    }

    // Run the pipeline as a single Effect so each phase's failures compose.
    const pipeline = Effect.gen(function* () {
      const generated = yield* generatePhase(jobs, {
        evalClient,
        probeClient,
        agentId: agentReg.agentId,
        modelName,
        bystanders,
        totalJobs: jobs.length,
        signal: opts.signal,
      });
      const validated = validatePhase(generated);
      const evaluated = yield* evaluatePhase(validated, {
        evalModel,
        signal: opts.signal,
      });
      const { result } = yield* analyzePhase(evaluated, {
        evalModel,
        signal: opts.signal,
        outputDir,
      });
      return result;
    });

    return await Effect.runPromise(pipeline);
  } finally {
    if (fleet) await fleet.stopAll();
    for (const c of clientsToClose) await Effect.runPromise(c.close());
    await stopCoreTestServer().catch(() => {});
  }
}
