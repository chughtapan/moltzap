/**
 * @file Write one compact usage summary per agent into the workspace when the
 * host has stopped, so a run's ordinary workspace harvest carries it out.
 *
 * OpenClaw keeps per-message usage in `transcript_events` of each agent's
 * SQLite database, normalized to the same fields for every model backend. The
 * database is tens of times over the harvest size limit, so this reads it in
 * the pod and keeps only what a cost report needs: one row per assistant
 * message that a model produced, plus totals. `delivery-mirror` rows are
 * OpenClaw's own copy of a delivered message, not a model call, so they are
 * counted and left out of the totals.
 *
 * A harness such as Codex records each completed model call in
 * `trajectory_runtime_events` and leaves the transcript without usage when a
 * turn ends on a tool call, so `effectiveTotals` takes the trajectory when it
 * has model calls and the transcript otherwise. Both raw totals stay in the
 * output so a disagreement between them is visible.
 *
 * The image entrypoint runs this file, when the image ships one, after the host
 * process has stopped and before it acknowledges finalization.
 *
 * Usage: node finalize-host.mjs [STATE_DIR] [WORKSPACE_DIR]
 */
import { readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_STATE_DIR = "/var/run/moltzap/bootstrap/state";
const DEFAULT_WORKSPACE_DIR = "/var/run/moltzap/bootstrap/workspace";
const OUTPUT_FILE = "openclaw-usage.json";
/** Keeps the file under the 64 KiB harvest limit; totals always cover every row. */
const MAXIMUM_LISTED_CALLS = 200;
const MIRROR_MODEL = "delivery-mirror";
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

/** @returns {{input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number}} */
function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/**
 * @param {ReturnType<typeof zeroTokens>} total Running total, mutated.
 * @param {Record<string, unknown>} usage One normalized usage record.
 */
function addUsage(total, usage) {
  for (const field of TOKEN_FIELDS) {
    total[field] += Number(usage[field] ?? 0);
  }
  total.reasoning += Number(usage.reasoningTokens ?? 0);
}

/**
 * @param {DatabaseSync} database An agent database.
 * @param {string} table Table name.
 * @returns {boolean} Whether the table exists.
 */
function hasTable(database, table) {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

/**
 * @param {DatabaseSync} database An agent database.
 * @returns {{calls: object[], totals: object, mirrorRows: number, userRows: number}} Transcript usage.
 */
function transcriptUsage(database) {
  const calls = [];
  const totals = zeroTokens();
  let mirrorRows = 0;
  let userRows = 0;
  if (!hasTable(database, "transcript_events")) {
    return { calls, totals, mirrorRows, userRows };
  }
  const rows = database
    .prepare(
      "SELECT session_id, seq, event_json FROM transcript_events ORDER BY created_at, seq",
    )
    .all();
  for (const row of rows) {
    const message = JSON.parse(String(row.event_json)).message;
    if (message?.role === "user") userRows += 1;
    if (message?.role !== "assistant") continue;
    if (message.model === MIRROR_MODEL) {
      mirrorRows += 1;
      continue;
    }
    const usage = message.usage ?? {};
    addUsage(totals, usage);
    calls.push({
      sessionId: row.session_id,
      seq: Number(row.seq),
      at: message.timestamp,
      provider: message.provider,
      model: message.model,
      api: message.api,
      stopReason: message.stopReason,
      toolCalls: (message.content ?? []).filter(
        (part) => part?.type === "toolCall",
      ).length,
      input: Number(usage.input ?? 0),
      output: Number(usage.output ?? 0),
      cacheRead: Number(usage.cacheRead ?? 0),
      cacheWrite: Number(usage.cacheWrite ?? 0),
      reasoning: Number(usage.reasoningTokens ?? 0),
    });
  }
  return { calls, totals, mirrorRows, userRows };
}

/**
 * @param {DatabaseSync} database An agent database.
 * @returns {{modelCalls: number, totals: object}} Usage from completed model calls in the trajectory.
 */
function trajectoryUsage(database) {
  const totals = zeroTokens();
  let modelCalls = 0;
  if (!hasTable(database, "trajectory_runtime_events")) {
    return { modelCalls, totals };
  }
  const rows = database
    .prepare("SELECT event_json FROM trajectory_runtime_events ORDER BY seq")
    .all();
  for (const row of rows) {
    const event = JSON.parse(String(row.event_json));
    if (event.type !== "model.completed") continue;
    modelCalls += 1;
    addUsage(totals, event.data?.usage ?? event.usage ?? {});
  }
  return { modelCalls, totals };
}

/**
 * @param {string} stateDirectory OpenClaw's state directory.
 * @returns {Promise<object[]>} One summary per agent database found.
 */
async function summarize(stateDirectory) {
  const agentsRoot = join(stateDirectory, "agents");
  if (!existsSync(agentsRoot)) return [];
  const summaries = [];
  for (const agentId of await readdir(agentsRoot)) {
    const path = join(agentsRoot, agentId, "agent", "openclaw-agent.sqlite");
    if (!existsSync(path)) continue;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const transcript = transcriptUsage(database);
      const trajectory = trajectoryUsage(database);
      summaries.push({
        agentId,
        agentRuns: transcript.userRows,
        modelMessages: transcript.calls.length,
        deliveryMirrorRows: transcript.mirrorRows,
        effectiveTotals:
          trajectory.modelCalls > 0 ? trajectory.totals : transcript.totals,
        effectiveSource:
          trajectory.modelCalls > 0 ? "trajectory" : "transcript",
        transcriptTotals: transcript.totals,
        trajectory,
        callsListed: Math.min(transcript.calls.length, MAXIMUM_LISTED_CALLS),
        calls: transcript.calls.slice(0, MAXIMUM_LISTED_CALLS),
      });
    } finally {
      database.close();
    }
  }
  return summaries;
}

const stateDirectory = process.argv[2] ?? DEFAULT_STATE_DIR;
const workspaceDirectory = process.argv[3] ?? DEFAULT_WORKSPACE_DIR;
await writeFile(
  join(workspaceDirectory, OUTPUT_FILE),
  JSON.stringify({
    schema: "moltzap.openclaw-usage/v1",
    writtenAt: new Date().toISOString(),
    agents: await summarize(stateDirectory),
  }),
);
