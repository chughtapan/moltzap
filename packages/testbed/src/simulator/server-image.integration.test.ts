/**
 * @file The execution substrate against a real container: the image
 * `scripts/build-server-image.mjs` builds, brought up by the live
 * launcher, with the OTLP receiver bound where the container can reach
 * it and the transcript drain reading the PGlite directory the image
 * pins under `/data`. No model keys and no external network: the society
 * is StubRuntime processes and the traffic is the principal's own
 * injection, so every assertion here is about the substrate rather than
 * about agent behavior.
 *
 * Gate: `MOLTZAP_SIM_ITEST=1`, and a `TMPDIR` the container engine
 * shares — a VM-backed engine that does not share the system temp
 * directory fails the launch's mount check by design.
 */
/* eslint-disable sonarjs/assertions-in-tests -- the single entry delegates to `substrateRun`, where every expectation lives; splitting it would boot a second container per assertion */
// @agent-code-guard/regression-only: one end-to-end execution against a real container; the generative gates for this row live in the hermetic files
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Config, Effect, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "./episode.js";
import { decodeEventLine, type SimulatorEvent } from "./event-log.js";
import { makeLocalRecordingStore } from "./local-store.js";
import { RunSpec } from "./run-spec.js";

const SIM_INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_SIM_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);

const DELIVERED_SPAN = "moltzap.message.delivered";
const AGENT = "recipient";
const PRINCIPAL = "operator";
const TASK_CONTENT = "substrate check: does this message reach the recording";
const IMAGE_BUILD_TIMEOUT_MS = 900_000;
const RUN_TIMEOUT_MS = 300_000;

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const ImagePin = Schema.Struct({ imageDigest: Schema.String });

let imageDigest = "";

/** Build (or re-use) the image and record the pin its script prints. */
const buildServerImage: Effect.Effect<void, unknown, never> = Command.string(
  Command.make("node", join(packageRoot, "scripts", "build-server-image.mjs")),
).pipe(
  Effect.map((stdout) => stdout.trim().split("\n").at(-1) ?? "{}"),
  Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(ImagePin))),
  Effect.map((pin) => {
    imageDigest = pin.imageDigest;
  }),
  Effect.provide(NodeContext.layer),
  Effect.orDie,
);

function liveSpec(storeRoot: string): RunSpec {
  return Schema.decodeUnknownSync(RunSpec)({
    seed: 1,
    agents: [
      {
        name: AGENT,
        runtime: { _tag: "stub", config: { script: "quiet" } },
        runsIn: "host",
        role: "standard",
      },
    ],
    server: { imageDigest },
    episode: {
      task: { principal: PRINCIPAL, to: AGENT, content: TASK_CONTENT },
      termination: {
        inactivityTimeoutMs: 60_000,
        onAgentCrash: "halt",
        doneSignal: { name: "span-name", config: { name: DELIVERED_SPAN } },
      },
    },
    recording: { storeRoot },
  });
}

function eventsOf(
  lines: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<SimulatorEvent>, unknown, never> {
  return Effect.forEach(
    lines,
    (line) => decodeEventLine(JSON.stringify(line)),
    {
      concurrency: 1,
    },
  );
}

const substrateRun = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const storeRoot = yield* fs.makeTempDirectory({ prefix: "sim-live-store-" });
  const sealed = yield* Effect.scoped(run(liveSpec(storeRoot)));
  expect(sealed.outcome).toMatchObject({
    _tag: "episode",
    termination: "completed",
  });

  const snapshot = yield* makeLocalRecordingStore(storeRoot).read(
    sealed.recording.path,
  );
  expect(snapshot.manifest.serverImageDigest).toBe(imageDigest);

  const events = yield* eventsOf(snapshot.events);
  // A captured delivery span proves the container reached the receiver:
  // that export travels container -> host, the half of the wiring no
  // fixture can stand in for.
  expect(
    events.filter(
      (event) =>
        event._tag === "span.accepted" && event.spanName === DELIVERED_SPAN,
    ).length,
  ).toBeGreaterThan(0);
  expect(snapshot.traces?.spans.length ?? 0).toBeGreaterThan(0);

  // A drained transcript proves the /data bind mount and the image's
  // pinned PGlite directory: the drain reads that directory on the host
  // after the container stops.
  const transcripts = events.filter(
    (event) => event._tag === "transcript.message",
  );
  expect(JSON.stringify(transcripts)).toContain(TASK_CONTENT);
}).pipe(Effect.provide(NodeContext.layer), Effect.orDie);

describe.skipIf(!SIM_INTEGRATION_ENABLED)(
  "simulator execution substrate",
  () => {
    beforeAll(
      () => Effect.runPromise(buildServerImage),
      IMAGE_BUILD_TIMEOUT_MS,
    );

    it(
      "runs a society against the built image and seals span and transcript evidence",
      () => Effect.runPromise(substrateRun),
      RUN_TIMEOUT_MS,
    );
  },
);
