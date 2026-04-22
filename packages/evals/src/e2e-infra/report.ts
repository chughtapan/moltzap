/**
 * Report generator for E2E evals, mirroring OpenClaw's summary format.
 *
 * Produces summary.md + per-failure detail files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { EvaluatedResult } from "./types.js";
import { logger } from "./logger.js";

function generateSummaryMarkdown(
  results: EvaluatedResult[],
  analysisText?: string,
): string {
  const nameWidth = 35;
  const latencyWidth = 18;
  const failWidth = 12;
  const sevWidth = 12;

  const header =
    `| ${"Scenario".padEnd(nameWidth)} ` +
    `| ${"Avg Latency (ms)".padEnd(latencyWidth)} ` +
    `| ${"Schema Fail".padEnd(failWidth)} ` +
    `| ${"Eval Fail".padEnd(failWidth)} ` +
    `| ${"Minor".padEnd(sevWidth)} ` +
    `| ${"Significant".padEnd(sevWidth)} ` +
    `| ${"Critical".padEnd(sevWidth)} |`;

  const divider =
    `|${"-".repeat(nameWidth + 2)}` +
    `|${"-".repeat(latencyWidth + 2)}` +
    `|${"-".repeat(failWidth + 2)}` +
    `|${"-".repeat(failWidth + 2)}` +
    `|${"-".repeat(sevWidth + 2)}` +
    `|${"-".repeat(sevWidth + 2)}` +
    `|${"-".repeat(sevWidth + 2)}|`;

  // Group results by scenario
  const byScenario = new Map<string, EvaluatedResult[]>();
  for (const r of results) {
    const group = byScenario.get(r.scenarioId) ?? [];
    group.push(r);
    byScenario.set(r.scenarioId, group);
  }

  let summary = "# E2E Evaluation Summary\n\n";
  summary += header + "\n" + divider;

  const sortedIds = [...byScenario.keys()].sort();
  for (const scenarioId of sortedIds) {
    const runs = byScenario.get(scenarioId)!;
    const totalRuns = runs.length;

    const schemaFailed = runs.filter(
      (r) => r.error || r.validationErrors.length > 0,
    ).length;
    const evalFailed = runs.filter(
      (r) => r.judgeResult && !r.judgeResult.pass,
    ).length;

    const totalLatency = runs.reduce((sum, r) => sum + r.latencyMs, 0);
    const avgLatency = (totalLatency / totalRuns).toFixed(0);

    const schemaStr = schemaFailed > 0 ? `${schemaFailed} / ${totalRuns}` : "";
    const evalStr = evalFailed > 0 ? `${evalFailed} / ${totalRuns}` : "";

    let minor = 0;
    let significant = 0;
    let critical = 0;
    for (const r of runs) {
      if (r.judgeResult?.issues) {
        for (const issue of r.judgeResult.issues) {
          if (issue.severity === "minor") minor++;
          else if (issue.severity === "significant") significant++;
          else if (issue.severity === "critical") critical++;
        }
      }
    }

    const scenarioName = `${scenarioId}: ${runs[0]!.scenario.name}`;
    summary +=
      `\n| ${scenarioName.padEnd(nameWidth)} ` +
      `| ${avgLatency.padEnd(latencyWidth)} ` +
      `| ${schemaStr.padEnd(failWidth)} ` +
      `| ${evalStr.padEnd(failWidth)} ` +
      `| ${(minor > 0 ? String(minor) : "").padEnd(sevWidth)} ` +
      `| ${(significant > 0 ? String(significant) : "").padEnd(sevWidth)} ` +
      `| ${(critical > 0 ? String(critical) : "").padEnd(sevWidth)} |`;
  }

  // Overall summary
  const totalRuns = results.length;
  const successfulRuns = results.filter(
    (r) =>
      !r.error &&
      r.validationErrors.length === 0 &&
      (!r.judgeResult || r.judgeResult.pass),
  ).length;
  const successPct =
    totalRuns === 0 ? "0.0" : ((successfulRuns / totalRuns) * 100).toFixed(1);

  summary += `\n\n**Total successful runs:** ${successfulRuns} / ${totalRuns} (${successPct}% success)`;

  // Latency stats
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalLatency = latencies.reduce((sum, l) => sum + l, 0);
  const meanLatency =
    totalRuns > 0 ? (totalLatency / totalRuns).toFixed(0) : "0";
  let medianLatency = 0;
  if (latencies.length > 0) {
    const mid = Math.floor(latencies.length / 2);
    medianLatency =
      latencies.length % 2 === 0
        ? (latencies[mid - 1]! + latencies[mid]!) / 2
        : latencies[mid]!;
  }

  summary += `\n\n## Latency`;
  summary += `\n- **Mean:** ${meanLatency} ms`;
  summary += `\n- **Median:** ${medianLatency} ms`;

  // Severity breakdown
  let totalMinor = 0;
  let totalSignificant = 0;
  let totalCritical = 0;
  for (const r of results) {
    if (r.judgeResult?.issues) {
      for (const issue of r.judgeResult.issues) {
        if (issue.severity === "minor") totalMinor++;
        else if (issue.severity === "significant") totalSignificant++;
        else if (issue.severity === "critical") totalCritical++;
      }
    }
  }

  summary += `\n\n## Severity Breakdown`;
  summary += `\n- **Minor:** ${totalMinor}`;
  summary += `\n- **Significant:** ${totalSignificant}`;
  summary += `\n- **Critical:** ${totalCritical}`;

  if (analysisText) {
    summary += `\n\n## Failure Analysis\n\n${analysisText}`;
  }

  return summary;
}

/** Write evaluation report artifacts to the output directory. */
export function generateReport(
  results: EvaluatedResult[],
  outputDir: string,
  analysisText?: string,
): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const detailsDir = path.join(outputDir, "details");
  fs.mkdirSync(detailsDir, { recursive: true });

  // Write summary.md
  const summary = generateSummaryMarkdown(results, analysisText);
  const summaryPath = path.join(outputDir, "summary.md");
  fs.writeFileSync(summaryPath, summary);
  logger.info(`Summary written to ${summaryPath}`);

  // Write per-failure detail files
  for (const result of results) {
    const hasFailed =
      result.error ||
      result.validationErrors.length > 0 ||
      (result.judgeResult && !result.judgeResult.pass);

    if (!hasFailed) continue;

    const baseName = `${result.scenarioId}.${result.runNumber}`;

    // Write failure details as YAML
    const failureData: Record<string, unknown> = {
      scenarioId: result.scenarioId,
      scenarioName: result.scenario.name,
      runNumber: result.runNumber,
      modelName: result.modelName,
      latencyMs: result.latencyMs,
      agentResponse: result.agentResponse,
      ...(result.transcript ? { transcript: result.transcript } : {}),
    };

    if (result.error) {
      failureData["error"] = result.error;
    }
    if (result.validationErrors.length > 0) {
      failureData["validationErrors"] = result.validationErrors;
    }
    if (result.judgeResult) {
      failureData["judgeResult"] = {
        pass: result.judgeResult.pass,
        reason: result.judgeResult.reason,
        issues: result.judgeResult.issues,
        overallSeverity: result.judgeResult.overallSeverity,
      };
    }

    fs.writeFileSync(
      path.join(detailsDir, `${baseName}.failed.yaml`),
      stringifyYaml(failureData),
    );

    // Write the eval prompt if available
    if (result.judgeResult?.evalPrompt) {
      fs.writeFileSync(
        path.join(detailsDir, `${baseName}.eval_prompt.txt`),
        result.judgeResult.evalPrompt,
      );
    }
  }

  // Write transcript for ALL results (pass or fail) for observability
  for (const result of results) {
    const baseName = `${result.scenarioId}.${result.runNumber}`;
    const passed =
      !result.error &&
      result.validationErrors.length === 0 &&
      (!result.judgeResult || result.judgeResult.pass);
    const suffix = passed ? "passed" : "failed";
    const transcriptData: Record<string, unknown> = {
      scenarioId: result.scenarioId,
      result: suffix,
      agentResponse: result.agentResponse,
      ...(result.transcript ? { transcript: result.transcript } : {}),
    };
    fs.writeFileSync(
      path.join(detailsDir, `${baseName}.${suffix}.transcript.yaml`),
      stringifyYaml(transcriptData),
    );
  }

  const failureCount = results.filter(
    (r) =>
      r.error ||
      r.validationErrors.length > 0 ||
      (r.judgeResult && !r.judgeResult.pass),
  ).length;

  logger.info(
    `Report: ${failureCount} failure detail(s), ${results.length} transcript(s) written to ${detailsDir}`,
  );
}

export { generateSummaryMarkdown };
