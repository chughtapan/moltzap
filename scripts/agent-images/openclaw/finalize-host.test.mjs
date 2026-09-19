/** @file The host finalizer's usage summary, read from a real SQLite fixture. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const FINALIZER = join(
  dirname(fileURLToPath(import.meta.url)),
  "finalize-host.mjs",
);
const run = promisify(execFile);

/**
 * @param {string} role Message role.
 * @param {object} fields Remaining message fields.
 * @returns {string} One `transcript_events.event_json` value.
 */
function event(role, fields) {
  return JSON.stringify({ type: "message", message: { role, ...fields } });
}

/**
 * @param {object[]} trajectory `trajectory_runtime_events` payloads, or none.
 * @returns {Promise<{state: string, workspace: string, root: string}>} A state dir with one agent.
 */
async function fixture(trajectory) {
  const root = await mkdtemp(join(tmpdir(), "finalize-host-test-"));
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  await mkdir(join(state, "agents", "alice", "agent"), { recursive: true });
  await mkdir(workspace);
  const database = new DatabaseSync(
    join(state, "agents", "alice", "agent", "openclaw-agent.sqlite"),
  );
  database.exec(
    "CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)",
  );
  const insert = database.prepare(
    "INSERT INTO transcript_events VALUES ('s1', ?, ?, ?)",
  );
  insert.run(1, event("user", { content: [] }), 1);
  insert.run(
    2,
    event("assistant", {
      provider: "claude-cli",
      model: "claude-opus-4-8",
      api: "cli",
      stopReason: "stop",
      content: [{ type: "text", text: "" }],
      usage: { input: 6, output: 164, cacheRead: 59352, cacheWrite: 17566 },
    }),
    2,
  );
  insert.run(
    3,
    event("assistant", {
      provider: "openclaw",
      model: "delivery-mirror",
      usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
      content: [],
    }),
    3,
  );
  if (trajectory.length > 0) {
    database.exec(
      "CREATE TABLE trajectory_runtime_events (session_id TEXT, seq INTEGER, run_id TEXT, event_json TEXT, created_at INTEGER)",
    );
    const add = database.prepare(
      "INSERT INTO trajectory_runtime_events VALUES ('s1', ?, 'r1', ?, 1)",
    );
    trajectory.forEach((payload, index) => {
      add.run(index + 1, JSON.stringify(payload));
    });
  }
  database.close();
  return { state, workspace, root };
}

/**
 * @param {{state: string, workspace: string}} dirs Fixture directories.
 * @returns {Promise<object>} The first agent in the written summary.
 */
async function summaryOf(dirs) {
  await run(process.execPath, [FINALIZER, dirs.state, dirs.workspace]);
  const written = JSON.parse(
    await readFile(join(dirs.workspace, "openclaw-usage.json"), "utf8"),
  );
  return written.agents[0];
}

test("totals count model messages and leave delivery-mirror rows out", async () => {
  const dirs = await fixture([]);
  try {
    const agent = await summaryOf(dirs);
    assert.deepEqual(agent.transcriptTotals, {
      input: 6,
      output: 164,
      cacheRead: 59352,
      cacheWrite: 17566,
      reasoning: 0,
    });
    assert.equal(agent.deliveryMirrorRows, 1);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("one agent run is counted per user message", async () => {
  const dirs = await fixture([]);
  try {
    const agent = await summaryOf(dirs);
    assert.equal(agent.agentRuns, 1);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("trajectory totals sum completed model calls only", async () => {
  const dirs = await fixture([
    { type: "model.started", data: { usage: { input: 5 } } },
    {
      type: "model.completed",
      data: { usage: { input: 7251, output: 60, reasoningTokens: 16 } },
    },
  ]);
  try {
    const agent = await summaryOf(dirs);
    assert.deepEqual(agent.trajectory, {
      modelCalls: 1,
      totals: {
        input: 7251,
        output: 60,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 16,
      },
    });
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("a state directory without agents writes an empty summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "finalize-host-test-"));
  try {
    await run(process.execPath, [FINALIZER, join(root, "missing"), root]);
    const written = JSON.parse(
      await readFile(join(root, "openclaw-usage.json"), "utf8"),
    );
    assert.deepEqual(written.agents, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
