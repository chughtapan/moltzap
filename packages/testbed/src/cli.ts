#!/usr/bin/env node

/**
 * @file `moltzap-testbed`: the verb tree that operates the simulator.
 *
 * The tree separates what is being acted on from what is being done to
 * it: `spec` verbs work on documents, `run` / `queue` / `rerun` work on
 * attempts, `recording` verbs work on sealed evidence, `driver` and
 * `lock` report on the build. Every verb prints a human line by default
 * and a record under `--json`; every failure carries its tag, and the tag
 * decides the exit code.
 *
 * A bundle is a spec with one more section, so every spec-shaped verb
 * accepts one: `run` reads the spec and never names `grade:`, which
 * materialization strips alongside `condition`.
 *
 * ```mermaid
 * flowchart LR
 *   S[spec or bundle.yaml] --> RUN[run]
 *   RUN --> REC[sealed recording]
 *   REC --> CHK[recording check]
 *   CHK --> G[the consumer's grader]
 * ```
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import type { ParseResult } from "effect";
import { stringify as stringifyYaml } from "yaml";
import { collectSpecPaths, loadDocument, loadSpec } from "./cli-documents.js";
import {
  RUN_FAILED_WITH_RECORDING,
  exitCodeFor,
  outcomeText,
  type ExitCode,
} from "./cli-exit.js";
import {
  openRecording,
  type GradeableRecording,
  type OpenRecordingError,
} from "./grader.js";
import { runDemo } from "./demo/index.js";
import type {
  ConfigTimeError,
  ManifestPersistFailed,
  SealFailed,
  UnknownAttempt,
} from "./simulator/errors.js";
import {
  AttemptId,
  RECORDING_SCHEMA_VERSION,
  RunSpec,
  describeDrivers,
  makeInProcessQueue,
  makeLocalRecordingStore,
  materializeRunSpec,
  run,
  type AttemptSnapshot,
  type InProcessQueue,
  type RunOutcome,
  type SealedAttempt,
} from "./simulator/index.js";

/** What a verb produces: lines to print, and the code to exit with. */
type Output = {
  readonly lines: ReadonlyArray<string>;
  readonly code: ExitCode;
};

/**
 * Every failure a verb can surface. The union is explicit rather than
 * `unknown` so the exit-code mapping has a named set to be total over.
 * `OpenRecordingError` contributes every refusal a recording read can
 * produce, including the store failure and the two grading-convention
 * refusals.
 */
type CliError =
  | ConfigTimeError
  | ManifestPersistFailed
  | SealFailed
  | OpenRecordingError
  | UnknownAttempt
  | ParseResult.ParseError;

type Verb<E extends CliError = CliError> = Effect.Effect<Output, E, never>;

const USAGE = `moltzap-testbed <verb>

  spec check <spec>              decode and materialize a spec; report nothing else
  spec show <spec>               print the materialized spec with per-field origin
  spec to-ts <spec>              print the spec as a typed TypeScript literal

  run <spec|dir...>              run one spec, several, or a directory of them
  rerun <recording>              new attempt under the recording's identity
  queue submit <spec>            materialize, enqueue, and drain
  queue status <attemptId>       print one attempt's record
  queue cancel <attemptId>       request cancellation
  queue work                     drain this process's queue

  recording show <dir>           print identity, outcome, and counts
  recording check <dir>          verify sealed and decodable; print the outcome
  recording events <dir>         print the event timeline as NDJSON

  driver check                   list registered drivers and their config schemas
  lock                           print the pins recordings will carry
  lock check                     verify the recorded pins resolve
  demo                           run the no-keys fault-theater demo

Options:
  --json                         emit one JSON record per result
  --store <dir>                  recording store root (default ./recordings)
  --condition <label>            condition label recording check compares against
  --require-completed            refuse a recording whose run did not complete

Exit codes: 0 ok, 2 config-time rejection, 3 run failed with a sealed
recording, 4 no recording, 5 recording unsealed by a seal failure,
10 not sealed, 11 schema mismatch, 12 invalid recording,
13 condition mismatch, 14 run not completed, 1 unexpected.`;

// ---------------------------------------------------------------------------
// Argument shape
// ---------------------------------------------------------------------------

type Args = {
  readonly words: ReadonlyArray<string>;
  readonly json: boolean;
  readonly store: string | undefined;
  readonly condition: string | undefined;
  readonly requireCompleted: boolean;
};

const JSON_FLAG = "--json";
const REQUIRE_COMPLETED_FLAG = "--require-completed";
const STORE_FLAG = "--store";
const CONDITION_FLAG = "--condition";

const BOOLEAN_FLAGS = new Set([JSON_FLAG, REQUIRE_COMPLETED_FLAG]);
const VALUE_FLAGS = new Set([STORE_FLAG, CONDITION_FLAG]);

type Tokens = {
  readonly words: ReadonlyArray<string>;
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  /** The value flag whose value the next token supplies. */
  readonly pending: string | undefined;
};

const EMPTY_TOKENS: Tokens = {
  words: [],
  flags: new Set(),
  values: new Map(),
  pending: undefined,
};

/**
 * Absorb one token. `pending` carries the value flag whose value the next
 * token supplies, so a trailing value flag ends the fold still pending
 * and its value is simply absent — the same as not passing the flag.
 */
function absorb(tokens: Tokens, token: string): Tokens {
  if (tokens.pending !== undefined) {
    return {
      ...tokens,
      values: new Map(tokens.values).set(tokens.pending, token),
      pending: undefined,
    };
  }
  if (BOOLEAN_FLAGS.has(token)) {
    return { ...tokens, flags: new Set(tokens.flags).add(token) };
  }
  if (VALUE_FLAGS.has(token)) return { ...tokens, pending: token };
  return { ...tokens, words: [...tokens.words, token] };
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const { words, flags, values } = argv.reduce(absorb, EMPTY_TOKENS);
  return {
    words,
    json: flags.has(JSON_FLAG),
    store: values.get(STORE_FLAG),
    condition: values.get(CONDITION_FLAG),
    requireCompleted: flags.has(REQUIRE_COMPLETED_FLAG),
  };
}

function usage(detail: string): Verb<never> {
  return Effect.succeed({ lines: [detail, "", USAGE], code: 1 });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type Group = (rest: ReadonlyArray<string>, args: Args) => Verb;

const GROUPS: Readonly<Record<string, Group>> = {
  spec: specVerb,
  run: runVerb,
  rerun: rerunVerb,
  queue: queueVerb,
  recording: recordingVerb,
  driver: (rest) => driverVerb(rest),
  lock: (rest) => lockVerb(rest),
  demo: (_rest, args) => demoVerb(args),
};

const HELP_WORDS = new Set(["help", "--help", "-h"]);

function dispatch(argv: ReadonlyArray<string>): Verb {
  const args = parseArgs(argv);
  const [group, ...rest] = args.words;
  if (group === undefined || HELP_WORDS.has(group)) {
    return Effect.succeed({ lines: [USAGE], code: 0 });
  }
  const handler = GROUPS[group];
  return handler === undefined
    ? usage(`Unknown verb "${group}".`)
    : handler(rest, args);
}

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

function specVerb(rest: ReadonlyArray<string>, args: Args): Verb {
  const [verb, ...operands] = rest;
  switch (verb) {
    case "check":
      return specCheck(operands, args);
    case "show":
      return specShow(operands, args);
    case "to-ts":
      return specToTs(operands);
    default:
      return usage("spec: expected check, show, or to-ts.");
  }
}

function materializeFrom(path: string) {
  return loadDocument(path).pipe(Effect.flatMap(materializeRunSpec));
}

function specCheck(operands: ReadonlyArray<string>, args: Args): Verb {
  const path = operands[0];
  if (path === undefined) return usage("spec check: name a spec document.");
  return materializeFrom(path).pipe(
    Effect.map((report) => ({
      lines: [
        args.json
          ? JSON.stringify({
              ok: true,
              specHash: report.specHash,
              seed: report.spec.seed,
              agents: report.spec.agents.map((agent) => agent.name),
            })
          : `ok  ${path}  specHash ${report.specHash}  seed ${String(report.spec.seed)}  agents ${String(report.spec.agents.length)}`,
      ],
      code: 0 as ExitCode,
    })),
  );
}

function specShow(operands: ReadonlyArray<string>, args: Args): Verb {
  const path = operands[0];
  if (path === undefined) return usage("spec show: name a spec document.");
  return materializeFrom(path).pipe(
    Effect.map((report) => {
      const encoded = Schema.encodeSync(RunSpec)(report.spec);
      if (args.json) {
        return {
          lines: [
            JSON.stringify({
              specHash: report.specHash,
              spec: encoded,
              provenance: report.provenance,
            }),
          ],
          code: 0 as ExitCode,
        };
      }
      return {
        lines: [
          `specHash ${report.specHash}`,
          stringifyYaml(encoded).trimEnd(),
          "field origins:",
          ...report.provenance.map(
            (entry) => `  ${entry.path.join(".")}: ${entry.origin}`,
          ),
        ],
        code: 0 as ExitCode,
      };
    }),
  );
}

function specToTs(operands: ReadonlyArray<string>): Verb {
  const path = operands[0];
  if (path === undefined) return usage("spec to-ts: name a spec document.");
  return materializeFrom(path).pipe(
    Effect.map((report) => ({
      lines: [
        `import type { RunSpec } from "@moltzap/testbed/simulator";`,
        ``,
        `export const spec = ${JSON.stringify(
          Schema.encodeSync(RunSpec)(report.spec),
          null,
          2,
        )} as const satisfies RunSpec;`,
      ],
      code: 0 as ExitCode,
    })),
  );
}

// ---------------------------------------------------------------------------
// run / rerun
// ---------------------------------------------------------------------------

/**
 * Fan-out over given specs, never a matrix: each spec gets its own
 * attempt and its own record, and the process exits with the worst of
 * theirs. Every spec materializes before the first one launches, so a
 * mistyped file in a suite fails at config time rather than after ten
 * real runs.
 */
function runVerb(operands: ReadonlyArray<string>, args: Args): Verb {
  if (operands.length === 0) {
    return usage("run: name a spec, several specs, or a directory.");
  }
  return collectSpecPaths(operands).pipe(
    Effect.flatMap((paths) =>
      Effect.forEach(paths, loadSpec, { concurrency: 1 }).pipe(
        Effect.tap((specs) =>
          Effect.forEach(
            specs,
            (spec) => materializeRunSpec(Schema.encodeSync(RunSpec)(spec)),
            { concurrency: 1, discard: true },
          ),
        ),
        Effect.map((specs) =>
          specs.map((spec, index) => ({ path: paths[index] ?? "", spec })),
        ),
      ),
    ),
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) =>
          Effect.scoped(run(entry.spec)).pipe(
            Effect.map((attempt) => ({ path: entry.path, attempt })),
          ),
        { concurrency: 1 },
      ),
    ),
    Effect.map((results) => renderRuns(results, args)),
  );
}

function renderRuns(
  results: ReadonlyArray<{
    readonly path: string;
    readonly attempt: SealedAttempt;
  }>,
  args: Args,
): Output {
  const lines = results.map((result) =>
    args.json
      ? JSON.stringify({
          spec: result.path,
          recording: result.attempt.recording.path,
          outcome: result.attempt.outcome,
        })
      : `${outcomeText(result.attempt.outcome)}  ${result.attempt.recording.path}`,
  );
  const worst = results.reduce<ExitCode>((code, result) => {
    const current = outcomeCode(result.attempt.outcome);
    return current > code ? current : code;
  }, 0);
  return { lines, code: worst };
}

function outcomeCode(outcome: RunOutcome): ExitCode {
  return outcome._tag === "infrastructure-failure"
    ? RUN_FAILED_WITH_RECORDING
    : 0;
}

/**
 * A new attempt under the recording's identity, from the spec the
 * manifest persisted — so a rerun cannot silently drift onto an edited
 * document.
 */
function rerunVerb(operands: ReadonlyArray<string>, args: Args): Verb {
  const path = operands[0];
  if (path === undefined) return usage("rerun: name a recording directory.");
  return openAny(path).pipe(
    Effect.flatMap((recording) =>
      Effect.scoped(run(recording.manifest.materializedSpec)),
    ),
    Effect.map((attempt) => renderRuns([{ path, attempt }], args)),
  );
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

function configuredStoreRoot(args: Args): string {
  return resolve(args.store ?? "./recordings");
}

/**
 * The v0 queue lives in one process, so each queue verb builds the queue,
 * acts, and tears it down: `submit` enqueues and drains, `work` drains
 * what this invocation holds. Attempt state does not outlive the process
 * until a durable queue lands behind the same seam, and the verbs are
 * shaped so that landing changes nothing here.
 */
function queueVerb(rest: ReadonlyArray<string>, args: Args): Verb {
  const [verb, ...operands] = rest;
  const storeRoot = configuredStoreRoot(args);
  switch (verb) {
    case "submit": {
      const path = operands[0];
      if (path === undefined) return usage("queue submit: name a spec.");
      return withQueue(storeRoot, (held) =>
        loadSpec(path).pipe(
          Effect.flatMap((spec) => held.queue.submit(spec)),
          Effect.tap(() => held.runner.work()),
          Effect.map((snapshot) => snapshotOutput(snapshot, args)),
        ),
      );
    }
    case "status":
      return withAttemptId(operands, "queue status", (id) =>
        withQueue(storeRoot, (held) =>
          held.queue
            .status(id)
            .pipe(Effect.map((snapshot) => snapshotOutput(snapshot, args))),
        ),
      );
    case "cancel":
      return withAttemptId(operands, "queue cancel", (id) =>
        withQueue(storeRoot, (held) =>
          held.queue.cancel(id).pipe(
            Effect.map((outcome) => ({
              lines: [args.json ? JSON.stringify(outcome) : outcome._tag],
              code: 0 as ExitCode,
            })),
          ),
        ),
      );
    case "work":
      return withQueue(storeRoot, (held) =>
        held.runner
          .work()
          .pipe(Effect.as({ lines: ["queue drained"], code: 0 as ExitCode })),
      );
    default:
      return usage("queue: expected submit, status, cancel, or work.");
  }
}

function withAttemptId(
  operands: ReadonlyArray<string>,
  verb: string,
  body: (id: AttemptId) => Verb,
): Verb {
  const raw = operands[0];
  if (raw === undefined) return usage(`${verb}: name an attempt id.`);
  return Schema.decodeUnknown(AttemptId)(raw).pipe(Effect.flatMap(body));
}

function withQueue<A, E extends CliError>(
  storeRoot: string,
  body: (held: InProcessQueue) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> {
  return makeInProcessQueue({
    store: makeLocalRecordingStore(storeRoot),
    storeRoot,
  }).pipe(
    Effect.flatMap((held) => body(held).pipe(Effect.ensuring(held.close))),
  );
}

function snapshotOutput(snapshot: AttemptSnapshot, args: Args): Output {
  return {
    lines: [
      args.json
        ? JSON.stringify(snapshot)
        : `${snapshot._tag}  ${snapshot.attemptId}`,
    ],
    code: 0,
  };
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

function openAny(path: string) {
  return openRecording(path, { condition: null, outcome: "any" });
}

function recordingVerb(rest: ReadonlyArray<string>, args: Args): Verb {
  const [verb, ...operands] = rest;
  const path = operands[0];
  if (verb === undefined || path === undefined) {
    return usage(
      "recording: expected show, check, or events, plus a directory.",
    );
  }
  switch (verb) {
    case "show":
      return recordingShow(path, args);
    case "check":
      return recordingCheck(path, args);
    case "events":
      return recordingEvents(path);
    default:
      return usage("recording: expected show, check, or events.");
  }
}

/** What `recording show` reports, in the one shape both renderings read. */
type RecordingSummary = {
  readonly runId: string;
  readonly specHash: string;
  readonly seed: number;
  readonly attemptId: string;
  readonly condition: string | null;
  readonly outcome: RunOutcome;
  readonly events: number;
  readonly spans: number;
};

function summarize(recording: GradeableRecording): RecordingSummary {
  return {
    runId: recording.manifest.runId,
    specHash: recording.manifest.specHash,
    seed: recording.manifest.seed,
    attemptId: recording.manifest.attemptId,
    condition: recording.manifest.materializedSpec.condition?.label ?? null,
    outcome: recording.result.outcome,
    events: recording.timeline.length,
    spans: recording.traces?.spans.length ?? 0,
  };
}

function summaryLines(summary: RecordingSummary): ReadonlyArray<string> {
  return [
    `runId      ${summary.runId}`,
    `identity   ${summary.specHash} seed ${String(summary.seed)} ${summary.attemptId}`,
    `condition  ${summary.condition ?? "(none)"}`,
    `outcome    ${outcomeText(summary.outcome)}`,
    `events     ${String(summary.events)}`,
    `spans      ${String(summary.spans)}`,
  ];
}

function recordingShow(path: string, args: Args): Verb {
  return openAny(path).pipe(
    Effect.map((recording) => {
      const summary = summarize(recording);
      return {
        lines: args.json ? [JSON.stringify(summary)] : summaryLines(summary),
        code: 0 as ExitCode,
      };
    }),
  );
}

/**
 * The instrument's half of grading preflight: sealed, this reader's
 * schema version, every file decodable, and — when the caller supplies
 * them — the condition label and the completed-run requirement. It prints
 * the sealed outcome so a wrapper learns *which* outcome sealed without
 * opening `result.json`.
 */
function recordingCheck(path: string, args: Args): Verb {
  return openRecording(path, {
    condition: args.condition ?? null,
    outcome: args.requireCompleted ? "completed-only" : "any",
  }).pipe(
    Effect.map((recording) => ({
      lines: [
        args.json
          ? JSON.stringify({
              ok: true,
              sealed: true,
              recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
              outcome: recording.result.outcome,
            })
          : `sealed  ${outcomeText(recording.result.outcome)}`,
      ],
      code: 0 as ExitCode,
    })),
  );
}

function recordingEvents(path: string): Verb {
  return openAny(path).pipe(
    Effect.map((recording) => ({
      lines: recording.timeline.map((event) => JSON.stringify(event)),
      code: 0 as ExitCode,
    })),
  );
}

// ---------------------------------------------------------------------------
// driver / lock / demo
// ---------------------------------------------------------------------------

function driverVerb(rest: ReadonlyArray<string>): Verb {
  if (rest[0] !== "check") return usage("driver: expected check.");
  return Effect.succeed({
    lines: describeDrivers().map(
      (driver) =>
        `${driver.kind.padEnd(12)} ${driver.name.padEnd(16)} ${driver.description}\n${" ".repeat(29)}${JSON.stringify(driver.configSchema)}`,
    ),
    code: 0,
  });
}

/**
 * The pins every recording's manifest carries. `lock check` re-reads them
 * so a build whose pins moved is caught before it produces recordings
 * claiming provenance it no longer has.
 */
function lockVerb(rest: ReadonlyArray<string>): Verb {
  const verb = rest[0];
  if (verb !== undefined && verb !== "check") {
    return usage("lock: expected no verb, or check.");
  }
  const pins = {
    recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
    simulatorVersion: simulatorVersion(),
  };
  return Effect.succeed({
    lines: [
      verb === undefined
        ? JSON.stringify(pins, null, 2)
        : `ok  simulatorVersion ${pins.simulatorVersion}  recordingSchemaVersion ${String(pins.recordingSchemaVersion)}`,
    ],
    code: 0,
  });
}

const PackageMetadata = Schema.Struct({ version: Schema.String });

/**
 * Read from this package's own manifest rather than the environment, so
 * `lock` reports the version a manifest will actually carry however the
 * bin was invoked.
 */
function simulatorVersion(): string {
  return Schema.decodeUnknownSync(PackageMetadata)(
    createRequire(import.meta.url)("../package.json"),
  ).version;
}

function demoVerb(args: Args): Verb {
  return runDemo({ storeRoot: configuredStoreRoot(args) }).pipe(
    Effect.map((result) => ({
      lines: args.json
        ? [JSON.stringify(result)]
        : [
            ...result.banner,
            "",
            `recording  ${result.recordingPath}`,
            `outcome    ${result.outcome}`,
          ],
      code: 0 as ExitCode,
    })),
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run one invocation and report its lines and exit code; never throws. */
export function main(
  argv: ReadonlyArray<string>,
): Effect.Effect<Output, never, never> {
  return dispatch(argv).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        lines: [`${error._tag}: ${error.message}`],
        code: exitCodeFor(error._tag),
      }),
    ),
    Effect.catchAllDefect((defect) =>
      Effect.succeed({
        lines: [`Unexpected: ${String(defect)}`],
        code: 1 as ExitCode,
      }),
    ),
  );
}

function invokedAsBin(): boolean {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- entrypoint-detection: process.argv is the only way to tell a direct bin invocation from an import of main()
  const entry = process.argv[1];
  return (
    entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
  );
}

if (invokedAsBin()) {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- the argv vector is this process's input; main() takes it as a value so every other caller stays pure
  const output = await Effect.runPromise(main(process.argv.slice(2)));
  for (const line of output.lines) {
    process.stdout.write(`${line}\n`);
  }
  process.exitCode = output.code;
}
