/**
 * @file Bodies of hermetic coverage paths 1-12; `coverage.test.ts` is
 * the inventory that runs them. Each path is one top-level function so
 * the inventory file stays a flat list.
 */
/* eslint-disable agent-code-guard/require-span-on-exported-effect -- exported path bodies run under vitest only; spans would be dead weight in the inventory runs */
import { expect } from "vitest";
import { Effect, FastCheck as fc, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import type { Socket } from "@effect/platform";
import { NodeContext, NodeSocketServer } from "@effect/platform-node";
import { join } from "node:path";
import { ServerUrl } from "../../runtime.js";
import { makeSchedule, type Schedule } from "../episode.js";
import { makeWorld } from "../world.js";
import {
  AgentName,
  JsonValue,
  canonicalJson,
  isJsonRecord,
  materializeRunSpec,
  serializeJsonCanonical,
  toCanonicalJson,
} from "../run-spec.js";
import { dialForEcho } from "../node-net-relay.js";
import {
  AGENT_ONE,
  AGENT_TWO,
  DONE_SPAN,
  decodedEvents,
  expectedAttemptPath,
  postSpansWhenLive,
  runHermetic,
  specInput,
  startHermetic,
  tempStoreRoot,
  awaitAgents,
  type StartedHermetic,
} from "./support.js";
import { EVENT, EXIT, FAULT_EFFECT, OUTCOME, TERMINATION } from "./tags.js";
import {
  CONDITION_LABEL,
  SHORT_INACTIVITY,
  doneEpisode,
  outcomeOf,
  sealedPathOf,
  severWindow,
} from "./coverage-shared.js";

const SCHEDULE_SAMPLE_RUNS = 20;
const RUN_A_SPAN = "only.run-a";
const RUN_B_SPAN = "only.run-b";
const PROXY_HELLO = "hello-through-proxy";
const PROXY_HEAL = "after-heal";

function canonicalScheduleOf(seed: number, label: string | undefined): string {
  const report = Effect.runSync(
    materializeRunSpec(
      specInput("./recordings-test", {
        seed,
        ...(label === undefined ? {} : { condition: { label } }),
      }),
    ),
  );
  const schedule: Schedule = makeSchedule(report.spec);
  const plain: unknown = JSON.parse(JSON.stringify(schedule));
  return Effect.runSync(toCanonicalJson(plain).pipe(Effect.map(canonicalJson)));
}

/** Path 1: byte-identical canonical schedules per seed; condition-independent. */
export function path1(): Effect.Effect<void, unknown, never> {
  return Effect.sync(() => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.option(fc.string({ minLength: 1, maxLength: 12 }), {
          nil: undefined,
        }),
        (seed, label) => {
          expect(canonicalScheduleOf(seed, undefined)).toBe(
            canonicalScheduleOf(seed, undefined),
          );
          expect(canonicalScheduleOf(seed, label)).toBe(
            canonicalScheduleOf(seed, undefined),
          );
        },
      ),
      { numRuns: SCHEDULE_SAMPLE_RUNS },
    );
  });
}

/** Path 2: a sealed run's event file is unique and strictly increasing per line. */
export function path2(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const started = yield* startHermetic(input, root);
    yield* postSpansWhenLive(started, 2, [DONE_SPAN]);
    const sealed = yield* started.join;
    expect(outcomeOf(sealed)).toMatchObject({ _tag: OUTCOME.episode });
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* started.store.read(path);
    const events = yield* decodedEvents(snapshot);
    const sequences = events.map((event) => event.logicalSequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((a, b) => a - b)).toStrictEqual(sequences);
  });
}

/** Path 3: done-signal termination seals `completed` with the predicate firing evented. */
export function path3(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const started = yield* startHermetic(input, root);
    yield* postSpansWhenLive(started, 2, [DONE_SPAN]);
    const sealed = yield* started.join;
    expect(outcomeOf(sealed)).toMatchObject({
      _tag: OUTCOME.episode,
      termination: TERMINATION.completed,
    });
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* started.store.read(path);
    expect(snapshot.seal).toBeDefined();
    const events = yield* decodedEvents(snapshot);
    expect(events.some((event) => event._tag === EVENT.predicateFired)).toBe(
      true,
    );
  });
}

/** Path 4: inactivity bound seals `timeout`. */
export function path4(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root);
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.episode,
      termination: TERMINATION.timeout,
    });
  });
}

/** Path 5: crash under `halt` seals `agent-crashed`, exit evented. */
export function path5(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const started = yield* startHermetic(input, root);
    yield* started.endpoint;
    yield* awaitAgents(started.launch, 2);
    const controls = started.launch.runtimes.get(AGENT_ONE);
    expect(controls).toBeDefined();
    yield* controls!.exit(1);
    const sealed = yield* started.join;
    expect(outcomeOf(sealed)).toMatchObject({
      _tag: OUTCOME.episode,
      termination: TERMINATION.agentCrashed,
    });
    const path = yield* expectedAttemptPath(input, root);
    const events = yield* started.store
      .read(path)
      .pipe(Effect.flatMap(decodedEvents));
    expect(events.some((event) => event._tag === EVENT.agentExited)).toBe(true);
  });
}

/** Path 6: crash under `continue` is evented; the run continues and seals. */
export function path6(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000, "continue") });
    const started = yield* startHermetic(input, root);
    yield* started.endpoint;
    yield* awaitAgents(started.launch, 2);
    const controls = started.launch.runtimes.get(AGENT_TWO);
    yield* controls!.exit(1);
    yield* Effect.sleep("100 millis");
    yield* postSpansWhenLive(started, 2, [DONE_SPAN]);
    const sealed = yield* started.join;
    expect(outcomeOf(sealed)).toMatchObject({
      _tag: OUTCOME.episode,
      termination: TERMINATION.completed,
    });
    const path = yield* expectedAttemptPath(input, root);
    const events = yield* started.store
      .read(path)
      .pipe(Effect.flatMap(decodedEvents));
    expect(events.some((event) => event._tag === EVENT.agentExited)).toBe(true);
  });
}

/** Path 7: interrupt mid-episode seals `interrupted`; teardown reverses startup. */
export function path7(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const started = yield* startHermetic(input, root);
    yield* started.endpoint;
    yield* Effect.sleep("50 millis");
    yield* started.interrupt;
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* started.store.read(path);
    expect(snapshot.seal).toBeDefined();
    expect(snapshot.result?.outcome).toMatchObject({
      _tag: OUTCOME.episode,
      termination: TERMINATION.interrupted,
    });
    const order = started.launch.teardownLog.filter((entry) =>
      entry.startsWith("teardown:"),
    );
    expect(order).toStrictEqual([
      `teardown:${AGENT_TWO}`,
      `teardown:${AGENT_ONE}`,
    ]);
  });
}

/** Path 8: manifest identity fields present; grader hard-fails on a version bump. */
export function path8(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root);
    expect(outcome.sealedExit._tag).toBe(EXIT.success);
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* outcome.store.read(path);
    expect(snapshot.manifest.simulatorVersion.length).toBeGreaterThan(0);
    expect(snapshot.manifest.serverImageDigest.startsWith("sha256:")).toBe(
      true,
    );
    expect(snapshot.manifest.slots.length).toBe(2);
    yield* rewriteManifestVersion(path, snapshot.manifest);
    const reread = yield* Effect.exit(outcome.store.read(path));
    expect(reread._tag).toBe(EXIT.failure);
  });
}

function rewriteManifestVersion(
  path: string,
  manifest: unknown,
): Effect.Effect<void, unknown, never> {
  return Effect.try((): unknown => JSON.parse(JSON.stringify(manifest))).pipe(
    Effect.flatMap((plain) => Schema.decodeUnknown(JsonValue)(plain)),
    Effect.map((encoded) =>
      serializeJsonCanonical(
        isJsonRecord(encoded)
          ? { ...encoded, recordingSchemaVersion: 999 }
          : encoded,
      ),
    ),
    Effect.flatMap((rewritten) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.writeFileString(join(path, "manifest.json"), rewritten),
        ),
        Effect.provide(NodeContext.layer),
      ),
    ),
  );
}

/** Path 9: concurrent runs stay isolated end-to-end. */
export function path9(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const inputA = specInput(root, { seed: 1, episode: doneEpisode(60_000) });
    const inputB = specInput(root, { seed: 2, episode: doneEpisode(60_000) });
    const startedA = yield* startHermetic(inputA, root);
    const startedB = yield* startHermetic(inputB, root);
    const endpointA = yield* startedA.endpoint;
    const endpointB = yield* startedB.endpoint;
    expect(endpointA).not.toBe(endpointB);
    yield* postSpansWhenLive(startedA, 2, [RUN_A_SPAN, DONE_SPAN]);
    yield* postSpansWhenLive(startedB, 2, [RUN_B_SPAN, DONE_SPAN]);
    const pathA = sealedPathOf(yield* startedA.join);
    const pathB = sealedPathOf(yield* startedB.join);
    expect(pathA).not.toBe(pathB);
    yield* assertTracesDisjoint(startedA, pathA, startedB, pathB);
  });
}

function assertTracesDisjoint(
  startedA: StartedHermetic,
  pathA: string,
  startedB: StartedHermetic,
  pathB: string,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const tracesA = JSON.stringify((yield* startedA.store.read(pathA)).traces);
    const tracesB = JSON.stringify((yield* startedB.store.read(pathB)).traces);
    expect(tracesA).toContain(RUN_A_SPAN);
    expect(tracesA.includes(RUN_B_SPAN)).toBe(false);
    expect(tracesB).toContain(RUN_B_SPAN);
    expect(tracesB.includes(RUN_A_SPAN)).toBe(false);
  });
}

/** Path 10: the condition label never reaches an agent-visible channel. */
export function path10(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      condition: { label: CONDITION_LABEL, notes: "hygiene fixture" },
      episode: doneEpisode(SHORT_INACTIVITY),
    });
    const outcome = yield* runHermetic(input, root);
    expect(outcome.sealedExit._tag).toBe(EXIT.success);
    // Agent-visible channels: the launch-facing spec (which feeds spawn
    // inputs, mount plans, and endpoints) and delivered task content.
    expect(JSON.stringify(outcome.launch.capturedSpecs)).not.toContain(
      CONDITION_LABEL,
    );
    // The recording keeps the designation (the manifest is not agent-visible).
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* outcome.store.read(path);
    expect(JSON.stringify(snapshot.manifest)).toContain(CONDITION_LABEL);
  });
}

/** Path 11: sever/heal against a live upstream through the per-agent proxied URL. */
export function path11(): Effect.Effect<void, unknown, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const upstreamPort = yield* startEchoUpstream();
      const world = yield* makeWorld();
      const agentName = Schema.decodeSync(AgentName)(AGENT_ONE);
      const proxied = yield* world.allocateEndpoint(
        agentName,
        ServerUrl(`ws://127.0.0.1:${String(upstreamPort)}/ws`),
      );
      const proxiedPort = Number(new URL(proxied).port);
      expect(yield* relayEcho(proxiedPort, PROXY_HELLO)).toBe(PROXY_HELLO);
      const applied = yield* world.apply({ _tag: "sever", target: agentName });
      const severed = yield* Effect.exit(relayEcho(proxiedPort, "after-sever"));
      const severedText = severed._tag === EXIT.success ? severed.value : "";
      expect(severedText).toBe("");
      yield* applied.revert();
      expect(yield* relayEcho(proxiedPort, PROXY_HEAL)).toBe(PROXY_HEAL);
    }),
  );
}

function startEchoUpstream(): Effect.Effect<
  number,
  unknown,
  import("effect").Scope.Scope
> {
  return Effect.gen(function* () {
    const upstream = yield* NodeSocketServer.make({
      host: "127.0.0.1",
      port: 0,
    });
    yield* Effect.forkScoped(upstream.run(echoConnection));
    return upstream.address._tag === "TcpAddress" ? upstream.address.port : 0;
  });
}

const ECHO_WINDOW_MS = 150;

function echoConnection(
  socket: Socket.Socket,
): Effect.Effect<void, never, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const write = yield* socket.writer;
      yield* socket.runRaw((chunk) => write(chunk));
    }),
  ).pipe(Effect.catchAll(() => Effect.void));
}

/** One relayed echo round-trip: connect through the proxy, write, collect, close. */
function relayEcho(
  proxiedPort: number,
  payload: string,
): Effect.Effect<string, unknown, never> {
  return Effect.async<string, never, never>((resume) => {
    const received: Array<string> = [];
    const close = dialForEcho(proxiedPort, payload, (text) => {
      received.push(text);
    });
    const timer = setTimeout(() => {
      close();
      resume(Effect.succeed(received.join("")));
    }, ECHO_WINDOW_MS);
    return Effect.sync(() => {
      clearTimeout(timer);
      close();
    });
  });
}

/** Path 12: a window scheduled before readiness records the apply as target-not-ready. */
export function path12(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      world: { faults: [severWindow(AGENT_ONE, 0, 1)] },
      episode: doneEpisode(SHORT_INACTIVITY),
    });
    const outcome = yield* runHermetic(input, root);
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.episode,
    });
    const path = yield* expectedAttemptPath(input, root);
    const events = yield* outcome.store
      .read(path)
      .pipe(Effect.flatMap(decodedEvents));
    const applied = events.find((event) => event._tag === EVENT.faultApplied);
    const reverted = events.find((event) => event._tag === EVENT.faultReverted);
    expect(applied).toMatchObject({ effect: FAULT_EFFECT.targetNotReady });
    expect(reverted).toMatchObject({ effect: FAULT_EFFECT.wasNotApplied });
  });
}
