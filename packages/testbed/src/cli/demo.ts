/**
 * @file The `demo` verb: one scripted society, one severed link, one
 * sealed recording, no model keys and no external network.
 *
 * It exists to answer "what does this instrument produce?" in under two
 * minutes, on a machine that has only Docker. Everything it runs is an
 * instrument fixture, so the banner says so on every invocation —
 * mistaking a scripted stub for an agent is the one misreading a demo
 * can cause, and it is a misreading about evidence.
 *
 * The spec is a literal rather than a shipped YAML asset so the schema
 * keeps it honest: a field that changes shape breaks the build here
 * instead of failing at the demo's first invocation, which is the one
 * invocation a new reader makes.
 *
 * The fault window is the whole point. `severAtMs` lands after the
 * opening message and reverts before the done-signal fires, so the
 * recording holds a `fault.applied` / `fault.reverted` pair around live
 * traffic — the smallest thing that shows why the log is worth reading.
 *
 * The server image is resolved rather than hard-coded: the demo must run
 * with no arguments on a machine that has only Docker, and the digest of
 * a locally built image is a property of that machine, not of this file.
 */
import { Effect, Schema } from "effect";
import { resolveServerImagePin, run, RunSpec } from "../simulator/index.js";
import { outcomeText } from "./exit.js";
import { RunSpecInvalid } from "../simulator/errors.js";
import type {
  ConfigTimeError,
  ManifestPersistFailed,
  RecordingStoreFailed,
  SealFailed,
} from "../simulator/errors.js";

const SEVER_AT_MS = 3_000;
const HEAL_AT_MS = 8_000;
const INACTIVITY_TIMEOUT_MS = 60_000;

/** Where the demo's one recording lands. */
export type DemoOptions = {
  readonly storeRoot: string;
};

/** What the demo reports once its recording is sealed. */
export type DemoResult = {
  readonly banner: ReadonlyArray<string>;
  readonly recordingPath: string;
  readonly outcome: string;
};

/** The line every scripted-society output carries. */
const DEMO_BANNER: ReadonlyArray<string> = [
  "SCRIPTED FIXTURE — the two participants are StubRuntime scripts, not agents.",
  "Fault theater: the link between them is severed, then healed, while the log records both.",
];

/** Build the demo spec against a store root and the resolved server image. */
function demoSpec(storeRoot: string, imageDigest: string): RunSpec {
  return Schema.decodeUnknownSync(RunSpec)({
    seed: 1,
    agents: [
      {
        name: "asker",
        runtime: { _tag: "stub", config: { script: "demo-asker" } },
        runsIn: "host",
        role: "standard",
      },
      {
        name: "responder",
        runtime: { _tag: "stub", config: { script: "demo-responder" } },
        runsIn: "host",
        role: "standard",
      },
    ],
    server: { imageDigest },
    world: {
      faults: [
        {
          fault: { _tag: "sever", target: "responder" },
          applyAtMs: SEVER_AT_MS,
          revertAtMs: HEAL_AT_MS,
        },
      ],
    },
    episode: {
      steps: [
        {
          by: "operator",
          with: ["asker"],
          say: "Check whether the responder is reachable and report back.",
        },
      ],
      termination: {
        inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
        onAgentCrash: "halt",
        doneSignal: {
          name: "replies",
          config: { from: "asker", minCount: 1 },
        },
      },
    },
    recording: { storeRoot },
  });
}

/**
 * An unresolvable image is reported against the spec field that would
 * have carried it. The image pin has no tagged error of its own — it
 * fails with a sentence — and `server.imageDigest` is the field the demo
 * cannot fill, so a path-precise rejection at exit 2 says both that
 * nothing ran and where the gap is.
 */
function imageRejected(detail: string): RunSpecInvalid {
  return new RunSpecInvalid({
    issues: [{ path: ["server", "imageDigest"], message: detail }],
    message: `The demo has no server image: ${detail}.`,
  });
}

/**
 * Run the demo society and report where its recording landed.
 * @param options Where to write the recording.
 * @returns The banner, the recording path, and how the episode ended.
 */
export function runDemo(
  options: DemoOptions,
): Effect.Effect<
  DemoResult,
  ConfigTimeError | RecordingStoreFailed | ManifestPersistFailed | SealFailed,
  never
> {
  return resolveServerImagePin().pipe(
    Effect.mapError(imageRejected),
    Effect.flatMap((imageDigest) =>
      Effect.scoped(run(demoSpec(options.storeRoot, imageDigest))),
    ),
    Effect.map((attempt) => ({
      banner: DEMO_BANNER,
      recordingPath: attempt.recording.path,
      outcome: outcomeText(attempt.outcome),
    })),
  );
}
