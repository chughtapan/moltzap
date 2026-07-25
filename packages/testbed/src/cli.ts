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
 * `run` accepts a bare RunSpec and nothing else. A bundle reaches it only
 * through `spec from-bundle`, which emits the bare spec — so a consumer's
 * grader half can never influence a run.
 *
 * ```mermaid
 * flowchart LR
 *   B[bundle.yaml] --> FB[spec from-bundle]
 *   FB --> S[spec.yaml]
 *   S --> RUN[run]
 *   RUN --> REC[sealed recording]
 *   REC --> CHK[recording check]
 *   CHK --> G[the consumer's grader]
 * ```
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import type { ParseResult } from "effect";
import { stringify as stringifyYaml } from "yaml";
import {
  collectSpecPaths,
  documentStem,
  loadDocument,
  loadSpec,
} from "./cli-documents.js";
import {
  RUN_FAILED_WITH_RECORDING,
  exitCodeFor,
  type ExitCode,
} from "./cli-exit.js";
import {
  openRecording,
  projectBundle,
  type BundleInvalid,
  type ContentVersionConflict,
  type ContentVersionMismatch,
  type OpenRecordingError,
  type RunNotCompleted,
} from "./grader.js";
import { runDemo } from "./demo/index.js";
import { RecordingStoreFailed } from "./simulator/errors.js";
import type {
  AttemptNotRetryable,
  ConfigTimeError,
  ManifestPersistFailed,
  SealFailed,
  UnknownAttempt,
} from "./simulator/errors.js";
import {
  AttemptId,
  RECORDING_SCHEMA_VERSION,
  RunSpec,
  decodeEventLine,
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
 */
type CliError =
  | ConfigTimeError
  | ManifestPersistFailed
  | RecordingStoreFailed
  | SealFailed
  | OpenRecordingError
  | BundleInvalid
  | ContentVersionConflict
  | ContentVersionMismatch
  | RunNotCompleted
  | UnknownAttempt
  | AttemptNotRetryable
  | ParseResult.ParseError;

type Verb<E extends CliError = CliError> = Effect.Effect<Output, E, never>;

const USAGE = `moltzap-testbed <verb>

  spec check <spec>              decode and materialize a spec; report nothing else
  spec show <spec>               print the materialized spec with per-field origin
  spec to-ts <spec>              print the spec as a typed TypeScript literal
  spec from-bundle <bundle...>   split bundles into bare RunSpecs (--out <dir>)

  run <spec|dir...>              run one spec, several, or a directory of them
  rerun <recording>              new attempt under the recording's identity
  queue submit <spec>            materialize, enqueue, and drain
  queue status <attemptId>       print one attempt's record
  queue cancel <attemptId>       request cancellation
  queue retry <attemptId>        new attempt from a terminal one
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
  --out <dir>                    where spec from-bundle writes specs
  --store <dir>                  recording store root (default ./recordings)
  --content-version <key>        content key recording check compares against
  --require-completed            refuse a recording whose run did not complete

Exit codes: 0 ok, 2 config-time rejection, 3 run failed with a sealed
recording, 4 no recording, 5 recording unsealed by a seal failure,
10 not sealed, 11 schema mismatch, 12 invalid recording,
13 content-version mismatch, 14 run not completed, 1 unexpected.`;

// ---------------------------------------------------------------------------
// Argument shape
// ---------------------------------------------------------------------------

type Args = {
  readonly words: ReadonlyArray<string>;
  readonly json: boolean;
  readonly out: string | undefined;
  readonly store: string | undefined;
  readonly contentVersion: string | undefined;
  readonly requireCompleted: boolean;
};

const VALUE_FLAGS = new Set(["--out", "--store", "--content-version"]);

function parseArgs(argv: ReadonlyArray<string>): Args {
  const words: Array<string> = [];
  const values = new Map<string, string>();
  let json = false;
  let requireCompleted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--json") {
      json = true;
    } else if (token === "--require-completed") {
      requireCompleted = true;
    } else if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value !== undefined) values.set(token, value);
      index += 1;
    } else {
      words.push(token);
    }
  }
  return {
    words,
    json,
    out: values.get("--out"),
    store: values.get("--store"),
    contentVersion: values.get("--content-version"),
    requireCompleted,
  };
}

function usage(detail: string): Verb<never> {
  return Effect.succeed({ lines: [detail, "", USAGE], code: 1 });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function dispatch(argv: ReadonlyArray<string>): Verb {
  const args = parseArgs(argv);
  const [group, ...rest] = args.words;
  switch (group) {
    case "spec":
      return specVerb(rest, args);
    case "run":
      return runVerb(rest, args);
    case "rerun":
      return rerunVerb(rest, args);
    case "queue":
      return queueVerb(rest, args);
    case "recording":
      return recordingVerb(rest, args);
    case "driver":
      return driverVerb(rest);
    case "lock":
      return lockVerb(rest);
    case "demo":
      return demoVerb(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return Effect.succeed({ lines: [USAGE], code: 0 });
    default:
      return usage(`Unknown verb "${group}".`);
  }
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
    case "from-bundle":
      return specFromBundle(operands, args);
    default:
      return usage("spec: expected check, show, to-ts, or from-bundle.");
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

/**
 * The run half of the projection, mirroring `spec to-ts`: both are total
 * transforms between two encodings of one spec. The grade half is a
 * grader's own grammar and ships as that grader's emitter, so this verb
 * emits bare specs and only reports which grader the bundle carried.
 */
function specFromBundle(operands: ReadonlyArray<string>, args: Args): Verb {
  if (operands.length === 0) {
    return usage("spec from-bundle: name one or more bundle documents.");
  }
  return Effect.forEach(
    operands,
    (path) =>
      loadDocument(path).pipe(
        Effect.flatMap((document) =>
          projectBundle(document, { stem: documentStem(path) }),
        ),
        Effect.flatMap((projected) =>
          writeProjectedSpec(path, projected.spec, args.out).pipe(
            Effect.map((written) => ({ source: path, projected, written })),
          ),
        ),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((results) => ({
      lines: results.map((result) => {
        if (args.json) {
          return JSON.stringify({
            source: result.source,
            out: result.written,
            spec: result.projected.spec,
            scenarioId: result.projected.envelope.scenarioId,
            grader: result.projected.grade.grader,
            contentVersion: result.projected.contentVersion ?? null,
          });
        }
        return result.written === null
          ? stringifyYaml(result.projected.spec).trimEnd()
          : `${result.source} -> ${result.written}  (grader ${result.projected.grade.grader})`;
      }),
      code: 0 as ExitCode,
    })),
  );
}

function writeProjectedSpec(
  source: string,
  spec: unknown,
  out: string | undefined,
): Effect.Effect<string | null, RecordingStoreFailed, never> {
  if (out === undefined) return Effect.succeed(null);
  const directory = resolve(out);
  const target = join(directory, `${documentStem(source)}.yaml`);
  return withFs((fs) =>
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.zipRight(fs.writeFileString(target, stringifyYaml(spec))),
        Effect.mapError(
          (cause) =>
            new RecordingStoreFailed({
              file: target,
              message: `The projected spec could not be written to ${target}: ${String(cause)}. Check the --out directory.`,
            }),
        ),
        Effect.as(target),
      ),
  );
}

type Fs = FileSystem.FileSystem;

const withFs = <A, E>(
  body: (fs: Fs) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.flatMap(FileSystem.FileSystem, body).pipe(
    Effect.provide(NodeContext.layer),
  );

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
  results: ReadonlyArray<{ readonly path: string; readonly attempt: SealedAttempt }>,
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

function outcomeText(outcome: RunOutcome): string {
  return outcome._tag === "episode"
    ? `episode ${outcome.termination}`
    : `infrastructure-failure ${outcome.reason} (${outcome.errorTag})`;
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

function storeRootOf(args: Args): string {
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
  const storeRoot = storeRootOf(args);
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
          held.queue.status(id).pipe(
            Effect.map((snapshot) => snapshotOutput(snapshot, args)),
          ),
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
    case "retry":
      return withAttemptId(operands, "queue retry", (id) =>
        withQueue(storeRoot, (held) =>
          held.queue.retry(id).pipe(
            Effect.map((snapshot) => snapshotOutput(snapshot, args)),
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
      return usage("queue: expected submit, status, cancel, retry, or work.");
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
  return openRecording(path, { contentVersion: null, outcome: "any" });
}

function recordingVerb(rest: ReadonlyArray<string>, args: Args): Verb {
  const [verb, ...operands] = rest;
  const path = operands[0];
  if (verb === undefined || path === undefined) {
    return usage("recording: expected show, check, or events, plus a directory.");
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

function recordingShow(path: string, args: Args): Verb {
  return openAny(path).pipe(
    Effect.map((recording) => ({
      lines: [
        args.json
          ? JSON.stringify({
              runId: recording.manifest.runId,
              specHash: recording.manifest.specHash,
              seed: recording.manifest.seed,
              attemptId: recording.manifest.attemptId,
              contentVersion: recording.manifest.contentVersion ?? null,
              outcome: recording.result.outcome,
              events: recording.events.length,
              spans: recording.traces?.spans.length ?? 0,
            })
          : [
              `runId      ${recording.manifest.runId}`,
              `identity   ${recording.manifest.specHash} seed ${String(recording.manifest.seed)} ${recording.manifest.attemptId}`,
              `content    ${recording.manifest.contentVersion ?? "(none)"}`,
              `outcome    ${outcomeText(recording.result.outcome)}`,
              `events     ${String(recording.events.length)}`,
              `spans      ${String(recording.traces?.spans.length ?? 0)}`,
            ].join("\n"),
      ],
      code: 0 as ExitCode,
    })),
  );
}

/**
 * The instrument's half of grading preflight: sealed, this reader's
 * schema version, every file decodable, and — when the caller supplies
 * them — the content key and the completed-run requirement. It prints the
 * sealed outcome so a wrapper learns *which* outcome sealed without
 * opening `result.json`.
 */
function recordingCheck(path: string, args: Args): Verb {
  return openRecording(path, {
    contentVersion: args.contentVersion ?? null,
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
    Effect.flatMap((recording) =>
      Effect.forEach(
        recording.events,
        (line) => decodeEventLine(JSON.stringify(line)),
        { concurrency: 1 },
      ),
    ),
    Effect.map((events) => ({
      lines: [...events]
        .sort((left, right) => left.logicalSequence - right.logicalSequence)
        .map((event) => JSON.stringify(event)),
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
  const pins = {
    recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
    simulatorVersion: simulatorVersion(),
  };
  if (verb === undefined) {
    return Effect.succeed({ lines: [JSON.stringify(pins, null, 2)], code: 0 });
  }
  if (verb !== "check") return usage("lock: expected no verb, or check.");
  return Effect.succeed({
    lines: [
      `ok  simulatorVersion ${pins.simulatorVersion}  recordingSchemaVersion ${String(pins.recordingSchemaVersion)}`,
    ],
    code: 0,
  });
}

function simulatorVersion(): string {
  return process.env["npm_package_version"] ?? "0.0.0-dev";
}

function demoVerb(args: Args): Verb {
  return runDemo({ storeRoot: storeRootOf(args) }).pipe(
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

function describeFailure(error: CliError): { tag: string; message: string } {
  return { tag: error._tag, message: error.message };
}

/** Run one invocation and report its lines and exit code; never throws. */
export function main(
  argv: ReadonlyArray<string>,
): Effect.Effect<Output, never, never> {
  return dispatch(argv).pipe(
    Effect.catchAll((error) => {
      const { tag, message } = describeFailure(error);
      return Effect.succeed({
        lines: [`${tag}: ${message}`],
        code: exitCodeFor(tag),
      });
    }),
    Effect.catchAllDefect((defect) =>
      Effect.succeed({
        lines: [`Unexpected: ${String(defect)}`],
        code: 1 as ExitCode,
      }),
    ),
  );
}

function invokedAsBin(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsBin()) {
  const output = await Effect.runPromise(main(process.argv.slice(2)));
  for (const line of output.lines) {
    process.stdout.write(`${line}\n`);
  }
  process.exitCode = output.code;
}
