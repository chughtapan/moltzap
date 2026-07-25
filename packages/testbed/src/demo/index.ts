/**
 * @file The `demo` verb's front door: one scripted society, one severed
 * link, one sealed recording, no model keys and no external network.
 *
 * It exists to answer "what does this instrument produce?" in under two
 * minutes, on a machine that has only Docker. Everything it runs is an
 * instrument fixture, so the banner says so on every invocation —
 * mistaking a scripted stub for an agent is the one misreading a demo
 * can cause, and it is a misreading about evidence.
 */
import { Effect } from "effect";
import { run, RunSpec, type SealedAttempt } from "../simulator/index.js";
import { demoSpec } from "./fault-theater.js";
import type { ConfigTimeError } from "../simulator/errors.js";
import type {
  ManifestPersistFailed,
  RecordingStoreFailed,
  SealFailed,
} from "../simulator/errors.js";

export type DemoOptions = {
  readonly storeRoot: string;
};

export type DemoResult = {
  readonly banner: ReadonlyArray<string>;
  readonly recordingPath: string;
  readonly outcome: string;
};

/** The line every scripted-society output carries. */
export const DEMO_BANNER: ReadonlyArray<string> = [
  "SCRIPTED FIXTURE — the two participants are StubRuntime scripts, not agents.",
  "Fault theater: the link between them is severed, then healed, while the log records both.",
];

/** Run the demo society and report where its recording landed. */
export function runDemo(
  options: DemoOptions,
): Effect.Effect<
  DemoResult,
  ConfigTimeError | RecordingStoreFailed | ManifestPersistFailed | SealFailed,
  never
> {
  return Effect.scoped(run(demoSpec(options.storeRoot))).pipe(
    Effect.map((attempt) => ({
      banner: DEMO_BANNER,
      recordingPath: attempt.recording.path,
      outcome: outcomeText(attempt),
    })),
  );
}

function outcomeText(attempt: SealedAttempt): string {
  return attempt.outcome._tag === "episode"
    ? `episode ${attempt.outcome.termination}`
    : `infrastructure-failure ${attempt.outcome.reason}`;
}

export { demoSpec, DEMO_SERVER_IMAGE_DIGEST } from "./fault-theater.js";
export type { RunSpec };
