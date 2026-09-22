/**
 * @file Print one model-usage summary for the OpenClaw host that just stopped.
 *
 * The image entrypoint runs this as the host user and writes what it prints to
 * a path the host cannot reach, so this process only reads. It never prices
 * anything: a consumer prices tokens against a table it can date.
 *
 * OpenClaw normalizes every backend's usage into the same four counters and
 * stores it per assistant message in `transcript_events`, but which record
 * holds a run's true total differs by backend, so usage is grouped into one
 * bucket per backend and model and each bucket names its source:
 *
 * - `cli` (Claude Code): Claude Code's own session files, which hold one
 *   record per content block of an API response, so the last record per
 *   message id is the response's usage. OpenClaw's transcript is the
 *   cross-check: it records a run started by the principal but not one
 *   started by a channel delivery, and the image patch makes each row it does
 *   write the run's cumulative total. A CLI backend that leaves no session
 *   files is read from the transcript alone.
 * - `embedded` (OpenClaw's own provider client): the sum of transcript rows,
 *   one per model call, which also carry OpenClaw's catalog cost. The
 *   trajectory's `model.completed` rows hold per-attempt totals and only
 *   cross-check, because a repeated completion would double a sum of them.
 * - `codex` (the Codex app-server harness): Codex's own rollout files. OpenClaw
 *   keeps the last response's usage per turn, so neither its transcript nor its
 *   trajectory holds the total of a turn that calls a tool. The trajectory sum
 *   cross-checks and can only be lower.
 *
 * Every source file belongs to the host user, so the summary is only as honest
 * as the host: `integrity` says so. A value this cannot establish is `null`,
 * never zero.
 *
 * Usage: node finalize-host.mjs [STATE_DIR]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The tag the entrypoint checks before it keeps what this prints, so it must
 * stay equal to `MODEL_USAGE_SCHEMA` in `shared/entrypoint.mjs`. A shared
 * entrypoint importing from one image's script would tie every image to it.
 */
const SCHEMA = "moltzap.agent-model-usage/v1";
const DEFAULT_STATE_DIRECTORY = "/var/run/moltzap/bootstrap/state";
const MIRROR_MODEL = "delivery-mirror";
const CODEX_HARNESS_ID = "codex";
/** The provider OpenClaw records on a Claude Code transcript row, so a bucket read only from Claude Code's files keys the same price. */
const CLAUDE_CLI_PROVIDER = "claude-cli";
/** The counters a backend bills for, and so the ones a cross-check compares. */
const BILLED_COUNTERS = ["input", "output", "cacheRead", "cacheWrite"];
const COUNTERS = [...BILLED_COUNTERS, "reasoning"];
/** Keeps the summary well under the 1 MiB harvest bound; totals cover every message. */
const MAXIMUM_LISTED = 500;

/** @returns {Record<string, number>} */
function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/**
 * @param {Record<string, number>} total Mutated running total.
 * @param {Record<string, number>} tokens Counters to add.
 */
function addTokens(total, tokens) {
  for (const counter of COUNTERS) total[counter] += tokens[counter] ?? 0;
}

/**
 * @param {Record<string, unknown>} usage OpenClaw's normalized usage.
 * @returns {Record<string, number>} The five counters.
 */
function fromOpenClawUsage(usage) {
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    cacheRead: Number(usage.cacheRead ?? 0),
    cacheWrite: Number(usage.cacheWrite ?? 0),
    reasoning: Number(usage.reasoningTokens ?? 0),
  };
}

/**
 * @param {Record<string, number>} left Counters.
 * @param {Record<string, number>} right Counters.
 * @returns {boolean} Whether the four billed counters match.
 */
function sameBilledTokens(left, right) {
  return BILLED_COUNTERS.every((counter) => left[counter] === right[counter]);
}

/**
 * @param {Record<string, number>} lower Counters expected to be the smaller.
 * @param {Record<string, number>} upper Counters expected to be the larger.
 * @returns {boolean} Whether no billed counter of `lower` exceeds `upper`.
 */
function noneAbove(lower, upper) {
  return BILLED_COUNTERS.every((counter) => lower[counter] <= upper[counter]);
}

/**
 * @param {string} root Directory to walk.
 * @param {(name: string) => boolean} matches File name filter.
 * @returns {string[]} Matching files beneath it, or none when it is missing.
 */
function filesUnder(root, matches) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && matches(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * @param {string} path A JSONL file.
 * @returns {unknown[]} Its decodable lines; a torn last line is skipped.
 */
function jsonLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * @param {string} stateDirectory OpenClaw's state directory, the host's home.
 * @returns {{tokens: Record<string, number>, byModel: Map<string | null, Record<string, number>>, messages: number} | null}
 *     Claude Code's own per-response usage, in total and by the model each
 *     response names, or null when it left no session files.
 */
function claudeSessionUsage(stateDirectory) {
  const files = filesUnder(
    join(stateDirectory, ".claude", "projects"),
    (name) => name.endsWith(".jsonl"),
  );
  if (files.length === 0) return null;
  const lastByMessage = new Map();
  for (const file of files) {
    for (const record of jsonLines(file)) {
      const message = record?.message;
      if (record?.type !== "assistant" || typeof message?.id !== "string") {
        continue;
      }
      lastByMessage.set(message.id, {
        model: typeof message.model === "string" ? message.model : null,
        usage: message.usage ?? {},
      });
    }
  }
  const tokens = zeroTokens();
  const byModel = new Map();
  for (const { model, usage } of lastByMessage.values()) {
    const counted = {
      input: Number(usage.input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
      cacheRead: Number(usage.cache_read_input_tokens ?? 0),
      cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
      reasoning: Number(usage.output_tokens_details?.thinking_tokens ?? 0),
    };
    addTokens(tokens, counted);
    const modelTokens = byModel.get(model) ?? zeroTokens();
    addTokens(modelTokens, counted);
    byModel.set(model, modelTokens);
  }
  return { tokens, byModel, messages: lastByMessage.size };
}

/**
 * Codex counts cached and cache-written input inside `input_tokens`; OpenClaw
 * and this summary keep uncached input apart from both.
 * @param {string} agentDirectory `state/agents/<id>/agent`.
 * @returns {{tokens: Record<string, number>} | null} The last cumulative count
 *     of every rollout, or null when no rollout states one, which is unknown
 *     usage rather than none.
 */
function codexRolloutUsage(agentDirectory) {
  const files = filesUnder(
    join(agentDirectory, "codex-home", "sessions"),
    (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  );
  const tokens = zeroTokens();
  let counted = 0;
  for (const file of files) {
    const counts = jsonLines(file)
      .filter((record) => record?.payload?.type === "token_count")
      .map((record) => record.payload.info?.total_token_usage)
      .filter((total) => total !== undefined && total !== null);
    const last = counts.at(-1);
    if (last === undefined) continue;
    counted += 1;
    const cacheRead = Number(last.cached_input_tokens ?? 0);
    const cacheWrite = Number(last.cache_write_input_tokens ?? 0);
    addTokens(tokens, {
      input: Number(last.input_tokens ?? 0) - cacheRead - cacheWrite,
      output: Number(last.output_tokens ?? 0),
      cacheRead,
      cacheWrite,
      reasoning: Number(last.reasoning_output_tokens ?? 0),
    });
  }
  return counted === 0 ? null : { tokens };
}

/**
 * @param {DatabaseSync} database An agent database.
 * @param {string} table Table name.
 * @returns {boolean} Whether it exists.
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
 * @returns {Set<string>} Sessions the Codex harness ran.
 */
function codexSessions(database) {
  if (!hasTable(database, "session_windows")) return new Set();
  return new Set(
    database
      .prepare(
        "SELECT session_id FROM session_windows WHERE agent_harness_id = ?",
      )
      .all(CODEX_HARNESS_ID)
      .map((row) => String(row.session_id)),
  );
}

/**
 * @param {DatabaseSync} database An agent database.
 * @returns {{tokens: Record<string, number>, completions: number}}
 *     Every `model.completed` in the trajectory, summed as recorded.
 */
function trajectoryUsage(database) {
  const tokens = zeroTokens();
  let completions = 0;
  if (!hasTable(database, "trajectory_runtime_events")) {
    return { tokens, completions };
  }
  const rows = database
    .prepare("SELECT event_json FROM trajectory_runtime_events ORDER BY seq")
    .all();
  for (const row of rows) {
    const event = JSON.parse(String(row.event_json));
    if (event.type !== "model.completed") continue;
    completions += 1;
    addTokens(tokens, fromOpenClawUsage(event.data?.usage ?? {}));
  }
  return { tokens, completions };
}

/**
 * @returns {object} The cross-check of a bucket the trajectory says nothing
 *     about, which is unknown rather than an agreement or a disagreement.
 */
function noTrajectoryCrossCheck() {
  return { source: "trajectory", tokens: null, agrees: null, note: null };
}

/**
 * The trajectory is a subset source. OpenClaw records one completion per Codex
 * turn carrying only the turn's last response, and records none for a model
 * call made outside a run attempt, such as the embedded harness's isolated
 * finalization. A trajectory at or below the primary is therefore consistent
 * with it, and only a trajectory above the primary means the primary missed
 * usage.
 * @param {Record<string, number>} primary The bucket's reported tokens.
 * @param {{tokens: Record<string, number>, completions: number}} trajectory
 *     The agent's trajectory usage.
 * @param {string} behindNote What a trajectory below the primary means here.
 * @returns {object} The bucket's cross-check.
 */
function trajectoryCrossCheck(primary, trajectory, behindNote) {
  if (trajectory.completions === 0) return noTrajectoryCrossCheck();
  const same = sameBilledTokens(primary, trajectory.tokens);
  const agrees = same || noneAbove(trajectory.tokens, primary);
  return {
    source: "trajectory",
    tokens: trajectory.tokens,
    agrees,
    note: agrees && !same ? behindNote : null,
  };
}

/**
 * @param {DatabaseSync} database An agent database.
 * @returns {{buckets: Map<string, object>, runsStarted: number, mirrorRows: number, messages: object[]}}
 *     Transcript usage grouped by backend, provider and model.
 */
function transcriptUsage(database) {
  const buckets = new Map();
  const messages = [];
  let runsStarted = 0;
  let mirrorRows = 0;
  if (!hasTable(database, "transcript_events")) {
    return { buckets, runsStarted, mirrorRows, messages };
  }
  const codex = codexSessions(database);
  const rows = database
    .prepare(
      "SELECT session_id, seq, event_json FROM transcript_events ORDER BY created_at, seq",
    )
    .all();
  for (const row of rows) {
    const message = JSON.parse(String(row.event_json)).message;
    if (message?.role === "user") runsStarted += 1;
    if (message?.role !== "assistant") continue;
    if (message.model === MIRROR_MODEL) {
      mirrorRows += 1;
      continue;
    }
    const backend = codex.has(String(row.session_id))
      ? "codex"
      : message.api === "cli"
        ? "cli"
        : "embedded";
    const key = [backend, message.provider, message.model].join("\u0000");
    const bucket = buckets.get(key) ?? {
      backend,
      provider: message.provider ?? null,
      model: message.model ?? null,
      api: message.api ?? null,
      tokens: zeroTokens(),
      rows: 0,
      rowsWithUsage: 0,
      catalogCostUsd: 0,
      sawCatalogCost: false,
    };
    const tokens = fromOpenClawUsage(message.usage ?? {});
    addTokens(bucket.tokens, tokens);
    bucket.rows += 1;
    if (
      tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite >
      0
    ) {
      bucket.rowsWithUsage += 1;
    }
    const cost = message.usage?.cost?.total;
    if (typeof cost === "number" && cost > 0) {
      bucket.catalogCostUsd += cost;
      bucket.sawCatalogCost = true;
    }
    buckets.set(key, bucket);
    messages.push({
      sessionId: row.session_id,
      seq: Number(row.seq),
      backend,
      ...tokens,
    });
  }
  return { buckets, runsStarted, mirrorRows, messages };
}

/**
 * @param {object} bucket One transcript bucket.
 * @param {object} native The agent's native records and trajectory.
 * @returns {object} The bucket as reported, with its source and cross-check.
 */
function reportBucket(bucket, native) {
  const base = {
    backend: bucket.backend,
    provider: bucket.provider,
    model: bucket.model,
    api: bucket.api,
    modelMessages: bucket.rows,
  };
  if (bucket.backend === "codex") {
    const rollout = native.codex;
    if (rollout === null) {
      return {
        ...base,
        source: "trajectory",
        tokens: native.trajectory.tokens,
        reportedCost: null,
        coverage: "unknown",
        crossCheck: noTrajectoryCrossCheck(),
      };
    }
    return {
      ...base,
      source: "codex-rollout",
      tokens: rollout.tokens,
      reportedCost: null,
      coverage: "complete",
      crossCheck: trajectoryCrossCheck(
        rollout.tokens,
        native.trajectory,
        "trajectory holds last response only",
      ),
    };
  }
  if (bucket.backend === "cli") {
    const session = native.claude;
    if (session === null) {
      return {
        ...base,
        source: "transcript",
        tokens: bucket.tokens,
        reportedCost: null,
        coverage: bucket.rowsWithUsage < bucket.rows ? "partial" : "unknown",
        crossCheck: {
          source: "claude-session-files",
          tokens: null,
          agrees: null,
          note: null,
        },
      };
    }
    const same = sameBilledTokens(session.tokens, bucket.tokens);
    const behind = !same && noneAbove(bucket.tokens, session.tokens);
    return {
      ...base,
      source: "claude-session-files",
      tokens: session.tokens,
      reportedCost: null,
      coverage: "complete",
      crossCheck: {
        source: "transcript",
        tokens: bucket.tokens,
        agrees: same || behind,
        note: behind
          ? "the transcript omits a run started by a channel delivery, or one that ended before its row"
          : null,
      },
    };
  }
  return {
    ...base,
    source: "transcript",
    tokens: bucket.tokens,
    reportedCost: bucket.sawCatalogCost
      ? { usd: bucket.catalogCostUsd, origin: "openclaw-catalog" }
      : null,
    coverage: bucket.rowsWithUsage < bucket.rows ? "partial" : "complete",
    crossCheck: trajectoryCrossCheck(
      bucket.tokens,
      native.trajectory,
      "trajectory omits model calls made outside a run attempt",
    ),
  };
}

/**
 * An agent whose every run a channel delivery started has no transcript
 * assistant row at all, which is the ordinary case for an agent that only
 * answers others. Its spend is Claude Code's record, one bucket per model the
 * responses name, and an empty transcript agrees with it as a subset does.
 * @param {{byModel: Map<string | null, Record<string, number>>}} session
 *     Claude Code's own usage.
 * @returns {object[]} Buckets the transcript knows nothing about.
 */
function unrecordedCliBuckets(session) {
  return [...session.byModel.entries()].map(([model, tokens]) => ({
    backend: "cli",
    provider: model === null ? null : CLAUDE_CLI_PROVIDER,
    model,
    api: "cli",
    modelMessages: 0,
    source: "claude-session-files",
    tokens,
    reportedCost: null,
    coverage: "complete",
    crossCheck: {
      source: "transcript",
      tokens: null,
      agrees: true,
      note: "the transcript records no model message",
    },
  }));
}

/**
 * One bucket of unknown tokens makes the agent's total unknown as well: a sum
 * that left it out would read as a smaller spend rather than an unknown one.
 * @param {object[]} buckets Reported buckets.
 * @returns {Record<string, number> | null} What the agent's models used.
 */
function agentTotals(buckets) {
  if (buckets.some((bucket) => bucket.tokens === null)) return null;
  const totals = zeroTokens();
  for (const bucket of buckets) addTokens(totals, bucket.tokens);
  return totals;
}

/**
 * @param {object[]} buckets Reported buckets.
 * @param {number} runsStarted User rows seen.
 * @returns {string} The agent's status.
 */
function agentStatus(buckets, runsStarted) {
  if (buckets.length === 0) return runsStarted === 0 ? "no-runs" : "partial";
  if (buckets.some((bucket) => bucket.coverage !== "complete"))
    return "partial";
  if (buckets.some((bucket) => bucket.crossCheck.agrees === false)) {
    return "disagreement";
  }
  return "ok";
}

/**
 * @param {string} stateDirectory OpenClaw's state directory.
 * @param {string} agentId Agent directory name.
 * @returns {object} One agent's summary.
 */
function summarizeAgent(stateDirectory, agentId) {
  const agentDirectory = join(stateDirectory, "agents", agentId, "agent");
  const path = join(agentDirectory, "openclaw-agent.sqlite");
  if (!existsSync(path)) {
    return {
      agentId,
      status: "no-runs",
      runsStarted: 0,
      totals: zeroTokens(),
      buckets: [],
    };
  }
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const transcript = transcriptUsage(database);
    const native = {
      trajectory: trajectoryUsage(database),
      codex: codexRolloutUsage(agentDirectory),
      claude: claudeSessionUsage(stateDirectory),
    };
    const buckets = [...transcript.buckets.values()].map((bucket) =>
      reportBucket(bucket, native),
    );
    if (buckets.length === 0 && (native.claude?.messages ?? 0) > 0) {
      buckets.push(...unrecordedCliBuckets(native.claude));
    }
    const messages = transcript.messages.slice(0, MAXIMUM_LISTED);
    return {
      agentId,
      status: agentStatus(buckets, transcript.runsStarted),
      runsStarted: transcript.runsStarted,
      modelMessages: transcript.messages.length,
      deliveryMirrorRows: transcript.mirrorRows,
      totals: agentTotals(buckets),
      buckets,
      messagesListed: messages.length,
      messages,
    };
  } catch (cause) {
    return {
      agentId,
      status: "unreadable",
      reason: cause instanceof Error ? cause.message : "unknown failure",
      runsStarted: null,
      totals: null,
      buckets: [],
    };
  } finally {
    database?.close();
  }
}

const stateDirectory =
  process.argv[2] ?? process.env.OPENCLAW_STATE_DIR ?? DEFAULT_STATE_DIRECTORY;
const agentsRoot = join(stateDirectory, "agents");
const agentIds = existsSync(agentsRoot)
  ? readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];
process.stdout.write(
  JSON.stringify({
    schema: SCHEMA,
    status: "ok",
    writtenAt: new Date().toISOString(),
    integrity: "host-writable-sources",
    agents: agentIds.map((agentId) => summarizeAgent(stateDirectory, agentId)),
  }),
);
