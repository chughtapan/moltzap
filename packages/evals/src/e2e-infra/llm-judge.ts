/**
 * LLM-as-judge for E2E evals, mirroring OpenClaw's evaluation_flow.ts.
 *
 * Uses Genkit to call a judge model (default: gemini-2.5-flash) that evaluates
 * whether the agent handled a scenario correctly.
 */

import { z } from "genkit";
import { ai } from "./ai.js";
import { rateLimiter } from "./rate-limiter.js";
import {
  MODELS,
  DEFAULT_JUDGE_MODEL,
  type ModelConfig,
} from "./model-config.js";
import { logger } from "./logger.js";
import type { EvalScenario, JudgeResult } from "./types.js";

const JudgeResultSchema = z.object({
  pass: z
    .boolean()
    .describe("Whether the agent handled the scenario correctly"),
  reason: z.string().describe("Summary explanation of the verdict"),
  issues: z
    .array(
      z.object({
        issue: z.string().describe("Description of the issue"),
        severity: z
          .enum(["minor", "significant", "critical"])
          .describe("Severity of the issue"),
      }),
    )
    .describe("Specific issues found"),
});

function buildEvalPrompt(opts: {
  scenario: EvalScenario;
  agentResponse: string;
  conversationContext: string;
}): string {
  return `You are an expert QA evaluator for an agent messaging system called MoltZap.
Your task is to evaluate whether an AI agent correctly handled a test scenario.

## Scenario
**ID:** ${opts.scenario.id}
**Name:** ${opts.scenario.name}
**Description:** ${opts.scenario.description}

## What the agent received
The agent received this message through the MoltZap protocol:
\`\`\`
${opts.scenario.setupMessage}
\`\`\`

## Conversation context
${opts.conversationContext}

## What the agent responded
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

function resolveJudgeModel(evalModel: string): ModelConfig {
  const match = MODELS.find(
    (m) => m.modelId === evalModel || m.provider === evalModel,
  );
  if (match) return match;

  return {
    provider: "google",
    modelId: evalModel,
    envVar: "GEMINI_API_KEY",
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
  };
}

/** Evaluation flow defined via Genkit. */
export const evaluationFlow = ai.defineFlow(
  {
    name: "e2eEvaluationFlow",
    inputSchema: z.object({
      scenarioId: z.string(),
      scenarioName: z.string(),
      scenarioDescription: z.string(),
      setupMessage: z.string(),
      expectedBehavior: z.string(),
      validationChecks: z.array(z.string()),
      agentResponse: z.string(),
      conversationContext: z.string(),
      evalModel: z.string(),
    }),
    outputSchema: z.object({
      pass: z.boolean(),
      reason: z.string(),
      issues: z
        .array(
          z.object({
            issue: z.string(),
            severity: z.enum(["minor", "significant", "critical"]),
          }),
        )
        .optional(),
      evalPrompt: z.string().optional(),
    }),
  },
  async (input) => {
    const scenario: EvalScenario = {
      id: input.scenarioId,
      name: input.scenarioName,
      description: input.scenarioDescription,
      setupMessage: input.setupMessage,
      expectedBehavior: input.expectedBehavior,
      validationChecks: input.validationChecks,
    };

    const evalPrompt = buildEvalPrompt({
      scenario,
      agentResponse: input.agentResponse,
      conversationContext: input.conversationContext,
    });

    const estimatedTokens = Math.ceil(evalPrompt.length / 2.5);
    const judgeModel = resolveJudgeModel(input.evalModel);

    await rateLimiter.acquirePermit(judgeModel, estimatedTokens);

    try {
      const response = await ai.generate({
        prompt: evalPrompt,
        model: `googleai/${input.evalModel}`,
        output: { schema: JudgeResultSchema },
      });

      const result = response.output;
      if (!result) {
        throw new Error("No output from judge model");
      }

      return {
        pass: result.pass,
        reason: result.reason || "No reason provided",
        issues: result.issues || [],
        evalPrompt,
      };
    } catch (e: unknown) {
      const err = e as Error;
      logger.error(`Error during evaluation: ${err.message}`);
      rateLimiter.reportError(judgeModel, e);
      throw e;
    }
  },
);

/** Run a single judge evaluation with a custom or default prompt. */
async function runJudge(opts: {
  scenario: EvalScenario;
  agentResponse: string;
  conversationContext: string;
  evalModel: string;
  buildPrompt?: (opts: { scenario: EvalScenario; agentResponse: string; conversationContext: string }) => string;
}): Promise<JudgeResult> {
  if (opts.buildPrompt) {
    const evalPrompt = opts.buildPrompt({
      scenario: opts.scenario,
      agentResponse: opts.agentResponse,
      conversationContext: opts.conversationContext,
    });

    const estimatedTokens = Math.ceil(evalPrompt.length / 2.5);
    const judgeModel = resolveJudgeModel(opts.evalModel);

    await rateLimiter.acquirePermit(judgeModel, estimatedTokens);

    const response = await ai.generate({
      prompt: evalPrompt,
      model: `googleai/${opts.evalModel}`,
      output: { schema: JudgeResultSchema },
    });

    const result = response.output;
    if (!result) {
      throw new Error("No output from judge model");
    }

    return {
      pass: result.pass,
      reason: result.reason || "No reason provided",
      issues: result.issues || [],
    };
  }

  const result = await evaluationFlow({
    scenarioId: opts.scenario.id,
    scenarioName: opts.scenario.name,
    scenarioDescription: opts.scenario.description,
    setupMessage: opts.scenario.setupMessage,
    expectedBehavior: opts.scenario.expectedBehavior,
    validationChecks: opts.scenario.validationChecks,
    agentResponse: opts.agentResponse,
    conversationContext: opts.conversationContext,
    evalModel: opts.evalModel,
  });

  return {
    pass: result.pass,
    reason: result.reason,
    issues: result.issues,
  };
}

/** Evaluate a single agent response using the LLM judge. */
export async function judgeAgentResponse(opts: {
  scenario: EvalScenario;
  agentResponse: string;
  conversationContext: string;
  evalModel?: string;
  buildPrompt?: (opts: { scenario: EvalScenario; agentResponse: string; conversationContext: string }) => string;
}): Promise<JudgeResult> {
  const evalModel = opts.evalModel ?? DEFAULT_JUDGE_MODEL;

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await runJudge({
        scenario: opts.scenario,
        agentResponse: opts.agentResponse,
        conversationContext: opts.conversationContext,
        evalModel,
        buildPrompt: opts.buildPrompt,
      });
    } catch (e: unknown) {
      if (attempt === maxRetries - 1) {
        const err = e as Error;
        logger.warn(
          `Evaluation failed after ${maxRetries} attempts: ${err.message}`,
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
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt)),
      );
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("Unreachable: retry loop exited without returning");
}

/** Analysis flow for summarizing failure patterns across scenarios. */
export const analysisFlow = ai.defineFlow(
  {
    name: "e2eAnalysisFlow",
    inputSchema: z.object({
      failures: z.array(
        z.object({
          scenarioId: z.string(),
          runNumber: z.number(),
          failureType: z.string(),
          reason: z.string(),
          issues: z.array(z.string()).optional(),
        }),
      ),
      numRuns: z.number(),
      evalModel: z.string(),
    }),
    outputSchema: z.string(),
  },
  async ({ failures, numRuns, evalModel }) => {
    const failureDetails = failures
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

${failures.length} failures out of ${numRuns} total runs.
${failures.filter((f) => f.failureType === "Schema Validation").length} schema validation failures.
${failures.filter((f) => f.failureType === "Evaluation Failure").length} evaluation failures.
${numRuns - failures.length} successful runs.

Failures:
${failureDetails}

Instructions:
1. Identify the broad types of errors (Schema Validation, Response Quality, Timeout, etc.).
2. Analyze patterns (e.g., "The agent consistently fails to respond within timeout").
3. Provide a concise summary.

Output Format:
Return a short Markdown-formatted summary with headers and bullet points.
`;

    const estimatedTokens = Math.ceil(analysisPrompt.length / 2.5);
    const judgeModel = resolveJudgeModel(evalModel);

    await rateLimiter.acquirePermit(judgeModel, estimatedTokens);

    try {
      const response = await ai.generate({
        prompt: analysisPrompt,
        model: `googleai/${evalModel}`,
        output: { format: "text" },
      });

      const output = response.output;
      if (!output || typeof output !== "string") {
        return "Analysis failed: Output was not a string.";
      }
      return output;
    } catch (e: unknown) {
      const err = e as Error;
      logger.error(`Error during analysis: ${err.message}`);
      rateLimiter.reportError(judgeModel, e);
      return `Analysis failed: ${err.message}`;
    }
  },
);
