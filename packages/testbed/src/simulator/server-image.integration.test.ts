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
import { Config, Effect, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "./episode.js";
import { makeLocalRecordingStore } from "./local-store.js";
import { resolveServerImagePin } from "./run-config.js";
import { RunSpec } from "./run-spec.js";
import { MESSAGE_DELIVERED_SPAN } from "./span-attrs.js";
import {
  projectRecordedConversation,
} from "../trace-capture-bundle.js";
import {
  AGENT_ONE,
  PRINCIPAL_NAME,
  SAY_TEXT,
  decodedEvents,
  specInput,
  stubAgentInput,
  tempStoreRoot,
} from "./__tests__/support.js";
import { EVENT } from "./__tests__/tags.js";

const SIM_INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_SIM_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);

const IMAGE_BUILD_TIMEOUT_MS = 900_000;
const RUN_TIMEOUT_MS = 300_000;
const INACTIVITY_MS = 60_000;

let imageDigest = "";

const buildServerImage = resolveServerImagePin().pipe(
  Effect.map((pin) => {
    imageDigest = pin;
  }),
  Effect.orDie,
);

/**
 * The hermetic spec, re-pointed at the real image. The echo agent answers
 * the principal in the conversation the step opened, and the done-signal
 * waits for exactly that message, so this run is the evidence that the
 * fold's termination condition is reachable over a real wire — and that
 * it is reachable without any span arriving.
 */
function liveSpec(storeRoot: string): RunSpec {
  return Schema.decodeUnknownSync(RunSpec)(
    specInput(storeRoot, {
      seed: 1,
      agents: [stubAgentInput(AGENT_ONE, "echo")],
      server: { imageDigest },
      episode: {
        steps: [{ by: PRINCIPAL_NAME, with: [AGENT_ONE], say: SAY_TEXT }],
        termination: {
          inactivityTimeoutMs: INACTIVITY_MS,
          onAgentCrash: "halt",
          doneSignal: {
            name: "replies",
            config: { from: AGENT_ONE, minCount: 1 },
          },
        },
      },
    }),
  );
}

const substrateRun = Effect.gen(function* () {
  const storeRoot = yield* tempStoreRoot();
  const store = makeLocalRecordingStore(storeRoot);
  const sealed = yield* Effect.scoped(run(liveSpec(storeRoot)));
  expect(sealed.outcome).toMatchObject({
    _tag: "episode",
    termination: "completed",
  });

  const snapshot = yield* store.read(sealed.recording.path);
  expect(snapshot.manifest.serverImageDigest).toBe(imageDigest);

  const events = yield* decodedEvents(snapshot);
  // Completion is decided in band, over a real wire: the one firing cites
  // a message this run's own connection observed, not a span. Spans are
  // asserted below as evidence, and the run would have completed without
  // any of them arriving.
  const firings = events.flatMap((event) =>
    event._tag === EVENT.predicateFired ? [event] : [],
  );
  expect(firings).toHaveLength(1);
  const firing = firings[0];
  const cause = events.find(
    (event) => event.logicalSequence === firing?.causationId,
  );
  expect(cause?._tag).toBe(EVENT.wireMessage);

  // A captured delivery span proves the container reached the receiver:
  // that export travels container -> host, the half of the wiring no
  // fixture can stand in for.
  expect(
    events.filter(
      (event) =>
        event._tag === "span.accepted" && event.spanName === MESSAGE_DELIVERED_SPAN,
    ).length,
  ).toBeGreaterThan(0);
  expect(snapshot.traces?.spans.length ?? 0).toBeGreaterThan(0);

  // A drained transcript proves the /data bind mount and the image's
  // pinned PGlite directory: the drain reads that directory on the host
  // after the container stops.
  const transcripts = events.filter(
    (event) => event._tag === "transcript.message",
  );
  expect(JSON.stringify(transcripts)).toContain(SAY_TEXT);

  // The cc-judge fold reads recordings through this projection, so it
  // runs here over a real one: the target's answer has to come back
  // attributed to the agent, not to the principal who spoke first.
  const conversation = yield* projectRecordedConversation({
    events,
    targetSlot: AGENT_ONE,
    principalName: PRINCIPAL_NAME,
  });
  expect(conversation.responses.length).toBeGreaterThan(0);
  expect(
    conversation.responses.every(
      (response) => response.senderId === conversation.targetAgentId,
    ),
  ).toBe(true);
  expect(conversation.participants.length).toBeGreaterThan(0);
}).pipe(Effect.orDie);

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
