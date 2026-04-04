/**
 * Main E2E eval orchestrator, mirroring OpenClaw's index.ts pipeline.
 *
 * 4-phase pipeline:
 *   1. Generation — send scenarios to a real OpenClaw agent via MoltZap
 *   2. Validation — validate responses against MoltZap protocol schemas
 *   3. Evaluation — LLM-as-judge scores the agent's behavior
 *   4. Analysis  — aggregate failures, identify patterns
 */

import { execSync } from "node:child_process";
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
} from "@moltzap/server-core/test-utils";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { DockerManager } from "./docker-manager.js";
import { TIER5_SCENARIOS } from "./scenarios.js";
import { judgeAgentResponse, analysisFlow } from "./llm-judge.js";
import { generateReport, generateSummaryMarkdown } from "./report.js";
import { getModelConfig, DEFAULT_JUDGE_MODEL } from "./model-config.js";
import type { AgentModelConfig } from "./model-config.js";
import { logger } from "./logger.js";
import type {
  EvalScenario,
  GeneratedResult,
  ValidatedResult,
  EvaluatedResult,
  E2ERunResult,
  IssueSeverity,
} from "./types.js";

const AGENT_RESPONSE_TIMEOUT_MS = 120_000;

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
        senderType?: string;
        senderId?: string;
        messageId?: string;
        parts?: Array<{ type: string; text?: string }>;
      };

      if (!ctx.conversationId) {
        errors.push("Response missing conversationId");
      }
      if (ctx.senderType !== "agent") {
        errors.push(
          `Expected sender type "agent", got "${ctx.senderType ?? "missing"}"`,
        );
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
    } catch {
      errors.push("Conversation context is not valid JSON");
    }
  }

  return { ...result, validationErrors: errors };
}

type RawMessage = {
  id: string;
  conversationId: string;
  sender: { type: string; id: string };
  parts: Array<{ type: string; text?: string }>;
  seq: number;
  createdAt: string;
};

/** Send a message to a conversation and wait for a response from the expected sender. */
export async function sendAndWaitForResponse(opts: {
  client: MoltZapTestClient;
  conversationId: string;
  message: string;
  expectedSenderId: string;
  timeoutMs: number;
}): Promise<{ responseText: string; rawMessage: RawMessage }> {
  const { client, conversationId, message, expectedSenderId, timeoutMs } = opts;

  await client.rpc("messages/send", {
    conversationId,
    parts: [{ type: "text", text: message }],
  });

  const deadline = Date.now() + timeoutMs;
  let found: RawMessage | null = null;

  while (Date.now() < deadline) {
    let event;
    try {
      event = await client.waitForEvent(
        "messages/received",
        Math.max(1000, deadline - Date.now()),
      );
    } catch {
      // waitForEvent timed out on this poll — keep trying until deadline
      continue;
    }
    const msg = (event.data as { message: RawMessage }).message;

    if (
      msg.conversationId === conversationId &&
      msg.sender.id === expectedSenderId
    ) {
      found = msg;
      break;
    }
  }

  if (!found) {
    throw new Error(
      `Timeout waiting for agent response in conversation ${conversationId}`,
    );
  }

  const responseText = found.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");

  return { responseText, rawMessage: found };
}

/**
 * Phase 1: Send a scenario to the agent and capture its response.
 *
 * Creates a DM conversation between a test client and the OpenClaw agent,
 * sends the setup message, and waits for the agent's reply.
 */
async function generateResult(opts: {
  scenario: EvalScenario;
  testClient: MoltZapTestClient;
  agentId: string;
  runNumber: number;
  modelName: string;
}): Promise<GeneratedResult> {
  const { scenario, testClient, agentId, runNumber, modelName } = opts;
  const start = performance.now();

  try {
    const conv = (await testClient.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: agentId }],
    })) as { conversation: { id: string; type: string } };

    const conversationId = conv.conversation.id;

    // Send the initial setup message
    let lastResponse = await sendAndWaitForResponse({
      client: testClient,
      conversationId,
      message: scenario.setupMessage,
      expectedSenderId: agentId,
      timeoutMs: AGENT_RESPONSE_TIMEOUT_MS,
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
      }
    }

    const { responseText, rawMessage } = lastResponse;

    const conversationContext = JSON.stringify({
      conversationId: rawMessage.conversationId,
      senderType: rawMessage.sender.type,
      senderId: rawMessage.sender.id,
      messageId: rawMessage.id,
      parts: rawMessage.parts,
      seq: rawMessage.seq,
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

export async function runE2EEvals(opts: {
  scenarios?: string[];
  model?: string;
  agentModel?: AgentModelConfig;
  runsPerScenario?: number;
  evalModel?: string;
  resultsDir?: string;
  cleanResults?: boolean;
  logLevel?: string;
}): Promise<E2ERunResult> {
  const {
    scenarios: scenarioFilter,
    runsPerScenario = 1,
    evalModel = DEFAULT_JUDGE_MODEL,
    resultsDir,
    cleanResults = false,
  } = opts;

  const modelConfig = getModelConfig();
  const modelName = opts.model ?? modelConfig.modelId;

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

  const zaiApiKey = process.env["ZAI_API_KEY"];
  if (!zaiApiKey) {
    throw new Error("ZAI_API_KEY env var required for agent LLM");
  }

  const dockerManager = new DockerManager();
  let testServerBaseUrl = "";
  let testServerWsUrl = "";

  try {
    // Verify Docker image exists
    await dockerManager.verifyImage();

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
    const evalReg = await evalClient.register("eval-runner");

    // Register the OpenClaw agent account
    const registrationClient = new MoltZapTestClient(
      testServerBaseUrl,
      testServerWsUrl,
    );
    const agentReg = await registrationClient.register("openclaw-eval-agent");
    registrationClient.close();

    // Core server has open access — no contacts needed for DMs

    // Connect eval client
    await evalClient.connect(evalReg.apiKey);

    // Start OpenClaw Docker container with MoltZap channel
    logger.info("Starting OpenClaw agent container...");
    const agentContainer = await dockerManager.startAgent({
      name: "openclaw-eval-agent",
      moltzapServerUrl: testServerWsUrl,
      moltzapApiKey: agentReg.apiKey,
      zaiApiKey,
      agentModel: opts.agentModel,
    });

    // Wait for the agent's channel plugin to actually connect via WebSocket.
    // Poll container logs for "[moltzap] connected as" which confirms the plugin's
    // auth/connect RPC succeeded.
    logger.info("Waiting for agent to connect via MoltZap channel...");
    const connectDeadline = Date.now() + 90_000;
    let agentConnected = false;
    while (Date.now() < connectDeadline) {
      await new Promise((r) => setTimeout(r, 2000));
      // Check container is still running
      try {
        const status = execSync(
          `docker inspect ${agentContainer.containerId} --format='{{.State.Status}}'`,
          { encoding: "utf-8" },
        ).trim();
        if (status !== "running") {
          const logs = dockerManager.getContainerLogs(agentContainer);
          throw new Error(`Agent container exited. Logs:\n${logs}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("container exited"))
          throw err;
      }
      // Check container logs for successful MoltZap connection
      const logs = dockerManager.getContainerLogs(agentContainer);
      if (logs.includes("[moltzap] connected as")) {
        agentConnected = true;
        // Give the server a moment to register the connection
        await new Promise((r) => setTimeout(r, 2000));
        break;
      }
    }
    if (!agentConnected) {
      const logs = dockerManager.getContainerLogs(agentContainer);
      throw new Error(
        `Agent channel plugin did not connect within 90s. Container logs:\n${logs}`,
      );
    }
    logger.info("Agent channel plugin connected. Starting eval scenarios...");

    const allResults: EvaluatedResult[] = [];
    const totalJobs = selectedScenarios.length * runsPerScenario;
    let completedJobs = 0;

    for (const scenario of selectedScenarios) {
      for (let run = 1; run <= runsPerScenario; run++) {
        // Drain stale events between scenarios — previous agent responses
        // can leak into the next scenario's waitForEvent since DM conversations
        // are reused (findExistingDm returns the same conv).
        evalClient.drainEvents();

        // Wait for any in-flight agent responses to settle
        await new Promise((r) => setTimeout(r, 2000));
        evalClient.drainEvents();

        logger.info(
          `[${++completedJobs}/${totalJobs}] ${scenario.id} run ${run}/${runsPerScenario}`,
        );

        let generated: GeneratedResult;

        generated = await generateResult({
          scenario,
          testClient: evalClient,
          agentId: agentReg.agentId,
          runNumber: run,
          modelName,
        });

        // Phase 2: Validation
        const validated = validateResponse(generated);

        if (validated.validationErrors.length > 0) {
          logger.warn(
            `${scenario.id} run ${run}: ${validated.validationErrors.length} validation error(s)`,
          );
        }

        // Phase 3: Evaluation (skip if generation or validation failed hard)
        let evaluated: EvaluatedResult;
        if (validated.error || validated.validationErrors.length > 0) {
          evaluated = {
            ...validated,
            judgeResult: {
              pass: false,
              reason:
                validated.error ??
                `Schema validation failed: ${validated.validationErrors.join("; ")}`,
              issues: validated.validationErrors.map((e) => ({
                issue: e,
                severity: "critical" as IssueSeverity,
              })),
              overallSeverity: "critical" as IssueSeverity,
            },
          };
        } else {
          logger.info(`${scenario.id} run ${run}: Running LLM judge...`);
          const judgeResult = await judgeAgentResponse({
            scenario,
            agentResponse: validated.agentResponse,
            conversationContext: validated.conversationContext,
            evalModel,
          });

          let overallSeverity: IssueSeverity | undefined;
          if (!judgeResult.pass && judgeResult.issues) {
            const severities = judgeResult.issues.map((i) => i.severity);
            if (severities.includes("critical")) overallSeverity = "critical";
            else if (severities.includes("significant"))
              overallSeverity = "significant";
            else if (severities.includes("minor")) overallSeverity = "minor";
          }

          evaluated = {
            ...validated,
            judgeResult: {
              ...judgeResult,
              overallSeverity,
            },
          };
        }

        allResults.push(evaluated);

        const status = evaluated.judgeResult?.pass ? "PASS" : "FAIL";
        logger.info(
          `${scenario.id} run ${run}: ${status} (${evaluated.latencyMs.toFixed(0)}ms)`,
        );
      }
    }

    // Phase 4: Analysis
    const failures = allResults.filter(
      (r) =>
        r.error ||
        r.validationErrors.length > 0 ||
        (r.judgeResult && !r.judgeResult.pass),
    );

    let analysisText: string | undefined;
    if (failures.length > 0) {
      logger.info(
        `Running failure analysis on ${failures.length} failure(s)...`,
      );
      try {
        analysisText = await analysisFlow({
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
          evalModel,
        });
      } catch (e: unknown) {
        const err = e as Error;
        logger.error(`Failed to run failure analysis: ${err.message}`);
        analysisText = "Failed to run analysis.";
      }
    }

    // Generate report
    if (outputDir) {
      generateReport(allResults, outputDir, analysisText);
    }

    const summary = generateSummaryMarkdown(allResults, analysisText);
    logger.info(summary);

    // Cleanup
    evalClient.close();

    const passed = allResults.filter(
      (r) =>
        !r.error &&
        r.validationErrors.length === 0 &&
        (!r.judgeResult || r.judgeResult.pass),
    ).length;
    const totalLatency = allResults.reduce((sum, r) => sum + r.latencyMs, 0);

    return {
      results: allResults,
      summary: {
        total: allResults.length,
        passed,
        failed: allResults.length - passed,
        avgLatencyMs:
          allResults.length > 0 ? totalLatency / allResults.length : 0,
      },
    };
  } finally {
    // Capture container logs before stopping (helps debug failures)
    for (const c of dockerManager["containers"]) {
      const logs = dockerManager.getContainerLogs(c);
      if (logs && logs !== "(no logs available)") {
        logger.info(
          `Container "${c.name}" logs (last 20 lines):\n${logs.split("\n").slice(-20).join("\n")}`,
        );
      }
    }
    await dockerManager.stopAll();
    await stopCoreTestServer().catch(() => {});
  }
}
