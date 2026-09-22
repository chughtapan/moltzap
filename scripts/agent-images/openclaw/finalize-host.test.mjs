/** @file The OpenClaw host finalizer's summary, read from real SQLite and JSONL fixtures. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MODEL_USAGE_SCHEMA } from "../shared/entrypoint.mjs";

const FINALIZER = join(
  dirname(fileURLToPath(import.meta.url)),
  "finalize-host.mjs",
);
const run = promisify(execFile);

const CLI_ROW = {
  role: "assistant",
  provider: "claude-cli",
  model: "claude-opus-4-8",
  api: "cli",
  usage: { input: 6, output: 164, cacheRead: 59352, cacheWrite: 17566 },
};
const EMBEDDED_ROW = {
  role: "assistant",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  api: "anthropic-messages",
  usage: {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    cost: { total: 0.25 },
  },
};
const CODEX_ROW = {
  role: "assistant",
  provider: "openai",
  model: "gpt-5.6-sol",
  api: "openai-chatgpt-responses",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const MIRROR_ROW = {
  role: "assistant",
  provider: "openclaw",
  model: "delivery-mirror",
  usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
};

/**
 * @param {object} usage OpenClaw-normalized usage.
 * @returns {object} One `model.completed` trajectory event.
 */
function completed(usage) {
  return { type: "model.completed", data: { usage } };
}

/**
 * @param {object} total Codex `total_token_usage`.
 * @returns {string} One rollout `token_count` line.
 */
function tokenCount(total) {
  return JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total } },
  });
}

/**
 * @param {string} id Claude API message id.
 * @param {object} usage Claude Code usage record.
 * @returns {string} One Claude Code session line.
 */
function claudeLine(id, usage) {
  return JSON.stringify({ type: "assistant", message: { id, usage } });
}

/**
 * @param {object} options What the stopped host left behind.
 * @param {boolean} [options.started] Whether a user message opened a run; default true.
 * @param {object[]} [options.rows] Transcript messages after it.
 * @param {object[]} [options.trajectory] Trajectory events.
 * @param {boolean} [options.codexHarness] Whether the session ran in Codex.
 * @param {string[]} [options.rollout] Codex rollout lines.
 * @param {string[]} [options.claudeSession] Claude Code session lines.
 * @returns {Promise<{root: string, state: string}>} A state directory for agent `alice`.
 */
async function hostState(options) {
  const root = await mkdtemp(join(tmpdir(), "finalize-host-test-"));
  const state = join(root, "state");
  const agent = join(state, "agents", "alice", "agent");
  await mkdir(agent, { recursive: true });
  const database = new DatabaseSync(join(agent, "openclaw-agent.sqlite"));
  database.exec(
    "CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);" +
      "CREATE TABLE trajectory_runtime_events (session_id TEXT, seq INTEGER, run_id TEXT, event_json TEXT, created_at INTEGER);" +
      "CREATE TABLE session_windows (session_id TEXT, agent_harness_id TEXT);",
  );
  database
    .prepare("INSERT INTO session_windows VALUES ('s1', ?)")
    .run(options.codexHarness === true ? "codex" : null);
  const insert = database.prepare(
    "INSERT INTO transcript_events VALUES ('s1', ?, ?, ?)",
  );
  const opening = options.started === false ? [] : [{ role: "user" }];
  [...opening, ...(options.rows ?? [])].forEach((message, index) => {
    insert.run(index + 1, JSON.stringify({ message }), index + 1);
  });
  const trace = database.prepare(
    "INSERT INTO trajectory_runtime_events VALUES ('s1', ?, 'r1', ?, 1)",
  );
  (options.trajectory ?? []).forEach((event, index) => {
    trace.run(index + 1, JSON.stringify(event));
  });
  database.close();
  if (options.rollout !== undefined) {
    const sessions = join(agent, "codex-home", "sessions", "2026", "09", "19");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-1.jsonl"),
      options.rollout.join("\n"),
    );
  }
  if (options.claudeSession !== undefined) {
    const project = join(state, ".claude", "projects", "workspace");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "session.jsonl"),
      options.claudeSession.join("\n"),
    );
  }
  return { root, state };
}

/**
 * @param {string} state State directory.
 * @returns {Promise<object>} The summary the finalizer prints.
 */
async function summaryOf(state) {
  const { stdout } = await run(process.execPath, [FINALIZER, state]);
  return JSON.parse(stdout);
}

/**
 * @param {object} options Passed to `hostState`.
 * @returns {Promise<object>} Agent `alice` in the summary.
 */
async function aliceAfter(options) {
  const dirs = await hostState(options);
  try {
    return (await summaryOf(dirs.state)).agents[0];
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
}

test("delivery-mirror rows are counted and left out of the totals", async () => {
  const alice = await aliceAfter({ rows: [CLI_ROW, MIRROR_ROW] });

  assert.equal(alice.deliveryMirrorRows, 1);
  assert.equal(alice.totals.output, 164);
});

test("a CLI backend's tokens come from the transcript", async () => {
  const alice = await aliceAfter({ rows: [CLI_ROW] });

  assert.equal(alice.buckets[0].source, "transcript");
  assert.deepEqual(alice.buckets[0].tokens, {
    input: 6,
    output: 164,
    cacheRead: 59352,
    cacheWrite: 17566,
    reasoning: 0,
  });
});

test("the CLI cross-check takes the last Claude Code record of each message id", async () => {
  const alice = await aliceAfter({
    rows: [CLI_ROW],
    claudeSession: [
      claudeLine("msg_1", { input_tokens: 4, output_tokens: 9 }),
      claudeLine("msg_1", {
        input_tokens: 4,
        output_tokens: 112,
        cache_read_input_tokens: 25314,
        cache_creation_input_tokens: 8959,
      }),
      claudeLine("msg_2", {
        input_tokens: 2,
        output_tokens: 52,
        cache_read_input_tokens: 34038,
        cache_creation_input_tokens: 8607,
      }),
    ],
  });

  assert.equal(alice.buckets[0].crossCheck.agrees, true);
  assert.equal(alice.status, "ok");
});

test("a CLI run the backend spent more on than the transcript records is partial", async () => {
  const alice = await aliceAfter({
    rows: [CLI_ROW],
    claudeSession: [
      claudeLine("msg_1", {
        input_tokens: 6,
        output_tokens: 900,
        cache_read_input_tokens: 59352,
        cache_creation_input_tokens: 17566,
      }),
    ],
  });

  assert.equal(alice.status, "partial");
  assert.equal(alice.buckets[0].crossCheck.tokens.output, 900);
});

test("a CLI run with no transcript row reports unknown tokens, not zero", async () => {
  const alice = await aliceAfter({
    rows: [],
    claudeSession: [
      claudeLine("msg_1", { input_tokens: 3, output_tokens: 40 }),
    ],
  });

  assert.equal(alice.buckets[0].tokens, null);
  assert.equal(alice.status, "partial");
});

test("an agent whose tokens are unknown reports no total rather than zero", async () => {
  const alice = await aliceAfter({
    rows: [],
    claudeSession: [
      claudeLine("msg_1", { input_tokens: 3, output_tokens: 40 }),
    ],
  });

  assert.equal(alice.totals, null);
});

test("an embedded provider's tokens are the sum of its transcript rows", async () => {
  const alice = await aliceAfter({
    rows: [EMBEDDED_ROW, EMBEDDED_ROW],
    trajectory: [
      completed({ input: 20, output: 40, cacheRead: 60, cacheWrite: 80 }),
    ],
  });

  assert.equal(alice.buckets[0].source, "transcript");
  assert.equal(alice.buckets[0].tokens.output, 40);
  assert.deepEqual(alice.buckets[0].reportedCost, {
    usd: 0.5,
    origin: "openclaw-catalog",
  });
  assert.equal(alice.status, "ok");
});

test("an embedded row that states no usage leaves the bucket partial", async () => {
  const alice = await aliceAfter({
    rows: [EMBEDDED_ROW, { ...EMBEDDED_ROW, usage: undefined }],
  });

  assert.equal(alice.buckets[0].coverage, "partial");
});

test("a repeated embedded completion shows as a disagreement and does not double the total", async () => {
  const attempt = completed({
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
  });
  const alice = await aliceAfter({
    rows: [EMBEDDED_ROW],
    trajectory: [attempt, attempt],
  });

  assert.equal(alice.totals.output, 20);
  assert.equal(alice.status, "disagreement");
});

test("Codex tokens come from the last cumulative count of its rollout", async () => {
  const alice = await aliceAfter({
    rows: [CODEX_ROW],
    codexHarness: true,
    trajectory: [completed({ input: 900, output: 60, cacheRead: 100 })],
    rollout: [
      tokenCount({ input_tokens: 500, output_tokens: 10 }),
      tokenCount({
        input_tokens: 1000,
        cached_input_tokens: 100,
        output_tokens: 60,
        reasoning_output_tokens: 16,
      }),
    ],
  });

  assert.equal(alice.buckets[0].source, "codex-rollout");
  assert.deepEqual(alice.buckets[0].tokens, {
    input: 900,
    output: 60,
    cacheRead: 100,
    cacheWrite: 0,
    reasoning: 16,
  });
});

test("a Codex turn of several responses records that the trajectory undercounts", async () => {
  const alice = await aliceAfter({
    rows: [CODEX_ROW],
    codexHarness: true,
    trajectory: [completed({ input: 400, output: 20 })],
    rollout: [tokenCount({ input_tokens: 1200, output_tokens: 90 })],
  });

  assert.equal(alice.buckets[0].tokens.output, 90);
  assert.equal(
    alice.buckets[0].crossCheck.note,
    "trajectory holds last response only",
  );
  assert.equal(alice.status, "ok");
});

test("Codex without a rollout reports coverage it cannot know", async () => {
  const alice = await aliceAfter({
    rows: [CODEX_ROW],
    codexHarness: true,
    trajectory: [completed({ input: 400, output: 20 })],
  });

  assert.equal(alice.buckets[0].coverage, "unknown");
  assert.equal(alice.status, "partial");
});

test("a Codex rollout that counts nothing reports coverage it cannot know", async () => {
  const alice = await aliceAfter({
    rows: [CODEX_ROW],
    codexHarness: true,
    trajectory: [completed({ input: 400, output: 20 })],
    rollout: [
      JSON.stringify({ type: "event_msg", payload: { type: "other" } }),
    ],
  });

  assert.equal(alice.buckets[0].coverage, "unknown");
});

test("an embedded model call outside a run attempt is noted, not a disagreement", async () => {
  const alice = await aliceAfter({
    rows: [EMBEDDED_ROW, EMBEDDED_ROW],
    trajectory: [
      completed({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
    ],
  });

  assert.equal(
    alice.buckets[0].crossCheck.note,
    "trajectory omits model calls made outside a run attempt",
  );
  assert.equal(alice.status, "ok");
});

test("an agent that took no turn reports no runs", async () => {
  const alice = await aliceAfter({ started: false });

  assert.equal(alice.status, "no-runs");
});

test("a run that left no model message is partial", async () => {
  const alice = await aliceAfter({ rows: [] });

  assert.equal(alice.status, "partial");
});

test("an agent directory without a database reports no runs with zero totals", async () => {
  const root = await mkdtemp(join(tmpdir(), "finalize-host-test-"));
  try {
    await mkdir(join(root, "agents", "bob", "agent"), { recursive: true });
    const summary = await summaryOf(root);

    assert.equal(summary.agents[0].status, "no-runs");
    assert.equal(summary.agents[0].totals.output, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt database makes that agent unreadable and leaves the others", async () => {
  const dirs = await hostState({ rows: [CLI_ROW] });
  try {
    const broken = join(dirs.state, "agents", "bob", "agent");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "openclaw-agent.sqlite"), "not a database");
    const summary = await summaryOf(dirs.state);

    assert.deepEqual(
      summary.agents.map((agent) => [agent.agentId, agent.status]),
      [
        ["alice", "ok"],
        ["bob", "unreadable"],
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("a state directory without agents prints an empty summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "finalize-host-test-"));
  try {
    const summary = await summaryOf(join(root, "missing"));

    assert.deepEqual(summary.agents, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the summary carries the tag the entrypoint keeps it for", async () => {
  const root = await mkdtemp(join(tmpdir(), "finalize-host-test-"));
  try {
    const summary = await summaryOf(join(root, "missing"));

    assert.equal(summary.schema, MODEL_USAGE_SCHEMA);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
