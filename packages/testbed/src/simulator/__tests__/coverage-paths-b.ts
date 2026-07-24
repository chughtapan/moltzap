/**
 * @file Bodies of hermetic coverage paths 13-23 and the design-doc
 * extension paths 27-35; `coverage.test.ts` is the inventory that runs
 * them.
 */
/* eslint-disable agent-code-guard/require-span-on-exported-effect -- exported path bodies run under vitest only; spans would be dead weight in the inventory runs */
import { expect } from "vitest";
import { Effect, FastCheck as fc, Fiber, Schema } from "effect";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { buildOpenClawConfig } from "../../openclaw-adapter.js";
import { buildNanoclawProcessPlan } from "../../nanoclaw-process.js";
import { makeWorld, type AppliedFault, type World } from "../world.js";
import {
  Agent,
  LogicalTime,
  RunSpec,
  materializeRunSpec,
} from "../run-spec.js";
import { failureReasonOf } from "../run-internal.js";
import { makeInProcessQueue, type InProcessQueue } from "../queue-live.js";
import { makeLocalRecordingStore } from "../local-store.js";
import { makeEnvironment } from "../environment.js";
import {
  RECORDING_SCHEMA_VERSION,
  TracesJson,
  makeSecrets,
  type RecordingStore,
} from "../recording.js";
import {
  decodeEventLine,
  makeEventLog,
  makeReceiver,
  makeTranscriptDrain,
} from "../event-log.js";
import { RunId, type AttemptId } from "../ids.js";
import {
  DriverCrashed,
  FaultRevertFailed,
  LoggingProxyFailed,
  ServerLaunchFailed,
  TraceCaptureFailed,
  TranscriptDrainFailed,
  type InfraError,
} from "../errors.js";
import {
  AGENT_ONE,
  AGENT_TWO,
  DONE_SPAN,
  PRINCIPAL_NAME,
  TASK_CONTENT,
  decodedEvents,
  expectedAttemptPath,
  makeFakeLaunch,
  makeFakePrincipal,
  postSpans,
  postSpansWhenLive,
  quietDrain,
  runHermetic,
  specInput,
  startHermetic,
  stubAgentInput,
  tempStoreRoot,
} from "./support.js";
import {
  CANCEL,
  ERROR_TAG,
  EVENT,
  EXIT,
  FAULT_EFFECT,
  OUTCOME,
  REASON,
  SNAPSHOT,
  TERMINATION,
} from "./tags.js";
import {
  SHORT_INACTIVITY,
  doneEpisode,
  outcomeOf,
  sealedPathOf,
  severWindow,
} from "./coverage-shared.js";
import { buildMessagesFixture, type FixtureMessage } from "./pglite-fixture.js";

const MOUNT_NAME = "notes";
const HTTP_OK = 200;
const TEST_MODEL = "model-under-test";
const FIXTURE_UUID = "11111111-1111-4111-8111-111111111111";

/** Path 13: the OpenClaw config carries the proxied MCP servers. */
export function path13(): Effect.Effect<void, unknown, never> {
  return Effect.sync(() => {
    const config = buildOpenClawConfig(
      {
        agentName: AGENT_ONE,
        mcpServers: [
          { name: MOUNT_NAME, command: "node", args: ["notes.mjs"], env: {} },
        ],
      },
      "workspace-fixture",
    );
    expect(config.mcp?.servers?.[MOUNT_NAME]).toMatchObject({
      transport: "stdio",
      command: "node",
    });
  });
}

/** Path 14: the Nanoclaw plan carries container-config defaults for mounts and model. */
export function path14(): Effect.Effect<void, unknown, never> {
  return Effect.sync(() => {
    const plan = buildNanoclawProcessPlan(
      {
        agentName: AGENT_ONE,
        agentId: agentId(FIXTURE_UUID),
        apiKey: redactedAgentKey(agentKeyString(80)),
        serverUrl: "ws://127.0.0.1:59999/ws",
        autoRegisterConversations: true,
        modelId: TEST_MODEL,
        mcpServers: [
          { name: MOUNT_NAME, command: "node", args: ["notes.mjs"], env: {} },
        ],
      },
      "runtime-fixture",
      {
        cacheDir: "cache-fixture",
        cacheFingerprint: "fingerprint-fixture",
        containerImage: "img",
      },
      { PATH: "/usr/bin", HOME: "/home/fixture" },
    );
    const servers = plan.env["MOLTZAP_MCP_SERVERS"];
    expect(servers).toBeDefined();
    expect(JSON.stringify(JSON.parse(servers ?? "{}"))).toContain(MOUNT_NAME);
    expect(plan.env["MOLTZAP_AGENT_MODEL"]).toBe(TEST_MODEL);
  });
}

/** Path 15: agents without mounts keep an empty plan; the launch path is unchanged. */
export function path15(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root);
    expect(outcome.sealedExit._tag).toBe(EXIT.success);
    const counts = outcome.launch.capturedSpecs.flatMap((spec) =>
      spec.agents.map((agent) => agent.mcpServers.length),
    );
    expect(counts.every((count) => count === 0)).toBe(true);
  });
}

/** Path 16: arbitrary span names pass through into events and traces verbatim. */
export function path16(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const names = fc.sample(spanNameArb, 5);
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const started = yield* startHermetic(input, root);
    yield* postSpansWhenLive(started, 2, names);
    const endpoint = yield* started.endpoint;
    yield* postSpans(endpoint, [DONE_SPAN]);
    const sealed = yield* started.join;
    expect(sealed._tag).toBe(EXIT.success);
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* started.store.read(path);
    const events = yield* decodedEvents(snapshot);
    const recorded = events.flatMap((event) =>
      event._tag === EVENT.spanAccepted ? [event.spanName] : [],
    );
    for (const name of names) {
      expect(recorded).toContain(name);
      expect(JSON.stringify(snapshot.traces)).toContain(
        JSON.stringify(name).slice(1, -1),
      );
    }
  });
}

const spanNameArb = fc
  .string({ minLength: 1, maxLength: 20, unit: "grapheme-ascii" })
  .filter((name) => !name.includes('"') && !name.includes("\\"));

/** Path 17: a window overlapping episode end records both boundaries; revert lands after termination. */
export function path17(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      world: { faults: [severWindow(AGENT_ONE, 700, 500_000)] },
      episode: doneEpisode(1_200),
    });
    const outcome = yield* runHermetic(input, root);
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.episode,
      termination: TERMINATION.timeout,
    });
    const path = yield* expectedAttemptPath(input, root);
    const events = yield* outcome.store
      .read(path)
      .pipe(Effect.flatMap(decodedEvents));
    const applied = events.find((event) => event._tag === EVENT.faultApplied);
    const reverted = events.find((event) => event._tag === EVENT.faultReverted);
    const terminated = events.find(
      (event) => event._tag === EVENT.episodeTerminated,
    );
    expect(applied).toMatchObject({ effect: FAULT_EFFECT.applied });
    expect(reverted).toMatchObject({ effect: FAULT_EFFECT.reverted });
    expect(terminated).toBeDefined();
    expect(reverted!.logicalSequence).toBeGreaterThan(
      terminated!.logicalSequence,
    );
  });
}

/** Path 18: a server bring-up failure still yields a sealed recording with its reason. */
export function path18(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root, {
      launcherConfig: { serverFailure: true },
    });
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.serverLaunchFailed,
      errorTag: ERROR_TAG.serverLaunchFailed,
    });
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* outcome.store.read(path);
    expect(snapshot.seal).toBeDefined();
  });
}

/** Path 19: receiver loss fails the run within the configured bound. */
export function path19(): Effect.Effect<void, unknown, never> {
  const stallAfterMs = 120;
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const outcome = yield* runHermetic(input, root, {
      internals: { makeReceiver: stallingReceiver(stallAfterMs) },
    });
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.spanAcceptanceLost,
      errorTag: ERROR_TAG.traceCaptureFailed,
    });
  });
}

function stallingReceiver(stallAfterMs: number): typeof makeReceiver {
  return (deps) =>
    Effect.succeed({
      endpoint: "http://127.0.0.1:1/unavailable",
      awaitFailure: () =>
        Effect.sleep(`${stallAfterMs} millis`).pipe(
          Effect.zipRight(
            Effect.fail(
              new TraceCaptureFailed({
                boundMs: deps.failBoundMs,
                phase: "stall",
                message:
                  "The OTLP receiver could not acknowledge exports within the bound.",
              }),
            ),
          ),
        ),
      drainTraces: () =>
        Effect.succeed(
          new TracesJson({
            recordingSchemaVersion: RECORDING_SCHEMA_VERSION,
            runId: deps.runId,
            spans: [],
          }),
        ),
    });
}

const DRAIN_CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DRAIN_SENDER = "33333333-3333-4333-8333-333333333333";
const DRAIN_SECRET = "drain-secret-0123456789";
const REDACTED_TEXT_PATTERN = /^hello \[REDACTED:k\d+\] world$/u;

function drainFixtureRows(): ReadonlyArray<FixtureMessage> {
  return [1, 2].map((seq) => ({
    id: `44444444-4444-4444-8444-44444444444${String(seq)}`,
    conversationId: DRAIN_CONVERSATION,
    senderId: DRAIN_SENDER,
    seq,
    parts: [{ type: "text", text: `hello ${DRAIN_SECRET} world` }],
  }));
}

function transcriptEventsOf(
  events: ReadonlyArray<{ _tag: string }>,
): ReadonlyArray<Record<string, unknown>> {
  return events.filter(
    (event): event is Record<string, unknown> & { _tag: string } =>
      event._tag === EVENT.transcriptMessage,
  );
}

/**
 * Path 20, hermetic tier: proves the storage-read → decode → redact →
 * enqueue pipeline against a fixture in the server's storage shape — the
 * drained set equals exactly the stored rows (count, identity fields,
 * full parts under redaction), and no registered secret survives.
 * Observer exclusion is asserted structurally, not behaviorally: the
 * observer credential never sends messages, so storage holds none of its
 * rows. Live-held PGlite ordering and real observer traffic need a real
 * server and belong to the live tier.
 */
export function path20(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const volume = yield* tempStoreRoot();
    const rows = drainFixtureRows();
    yield* Effect.tryPromise({
      try: () => buildMessagesFixture(volume, rows),
      catch: (cause) => `fixture build failed: ${String(cause)}`,
    }).pipe(Effect.orDie);
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root, {
      launcherConfig: { volumePath: volume },
      internals: { makeDrain: makeTranscriptDrain },
      options: { secrets: [DRAIN_SECRET] },
    });
    expect(outcome.sealedExit._tag).toBe(EXIT.success);
    const path = sealedPathOf(outcome.sealedExit);
    const events = yield* outcome.store
      .read(path)
      .pipe(Effect.flatMap(decodedEvents));
    const drained = transcriptEventsOf(events);
    expect(drained.length).toBe(rows.length);
    for (const row of rows) {
      assertDrainedRow(drained, row);
    }
    expect(JSON.stringify(events).includes(DRAIN_SECRET)).toBe(false);
  });
}

function assertDrainedRow(
  drained: ReadonlyArray<Record<string, unknown>>,
  row: FixtureMessage,
): void {
  const event = drained.find((entry) => entry["conversationSeq"] === row.seq);
  expect(event).toMatchObject({
    conversationId: row.conversationId,
    senderId: row.senderId,
  });
  const message = event?.["message"] as {
    id: string;
    parts: ReadonlyArray<{ type: string; text: string }>;
  };
  expect(message.id).toBe(row.id);
  expect(message.parts.length).toBe(row.parts.length);
  for (const [index, part] of row.parts.entries()) {
    expect(message.parts[index]?.type).toBe(part.type);
    expect(message.parts[index]?.text).toMatch(REDACTED_TEXT_PATTERN);
  }
}

const UNSAFE_SEQ = "9007199254740993";

/**
 * Path 30: drain failures at the final sweep seal with reason
 * transcript-drain-failed — a missing data dir, an encrypted row, and a
 * sequence beyond the safe integer range each land typed, never as a
 * defect that could strand the recording unsealed.
 */
export function path30(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    // The fake launcher's default volume is an empty directory: no
    // PGlite data dir exists.
    yield* assertDrainFailureSeals(undefined);
    yield* assertDrainFailureSeals([
      { ...drainFixtureRows()[0]!, dekVersion: 1 },
    ]);
    yield* assertDrainFailureSeals([
      { ...drainFixtureRows()[0]!, seq: UNSAFE_SEQ },
    ]);
  });
}

function assertDrainFailureSeals(
  rows: ReadonlyArray<FixtureMessage> | undefined,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const volume = yield* tempStoreRoot();
    if (rows !== undefined) {
      yield* Effect.tryPromise({
        try: () => buildMessagesFixture(volume, rows),
        catch: (cause) => `fixture build failed: ${String(cause)}`,
      }).pipe(Effect.orDie);
    }
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root, {
      launcherConfig: { volumePath: volume },
      internals: { makeDrain: makeTranscriptDrain },
    });
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.transcriptDrainFailed,
      errorTag: ERROR_TAG.transcriptDrainFailed,
    });
  });
}

/** Path 21: proxy transparency plus captured call/result pairing. */
export function path21(): Effect.Effect<void, unknown, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const log = yield* makeEventLog({
        runId: Schema.decodeSync(RunId)("abcdefabcdef-s7-a1"),
        clock: { now: () => Schema.decodeSync(LogicalTime)(0) },
        sink: {
          appendEvents: (batch) =>
            Effect.sync(() => {
              lines.push(...batch);
            }),
        },
        secrets: makeSecrets([]),
      });
      const handle = yield* makeEnvironment().prepare(
        mountedAgent(),
        log,
        makeSecrets([]),
      );
      const plan = handle.plan.proxiedServers[0];
      expect(plan).toBeDefined();
      const request = `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ping", arguments: { n: 1 } },
      })}\n`;
      const proxied = yield* execWithInput(plan!.command, plan!.args, request);
      const direct = yield* execWithInput(
        process.execPath,
        ["-e", MCP_ECHO_SCRIPT],
        request,
      );
      expect(proxied).toBe(direct);
      yield* awaitLine(lines, EVENT.toolResult);
      yield* assertToolPairCaptured(lines);
    }),
  );
}

function mountedAgent(): Agent {
  return Schema.decodeUnknownSync(Agent)({
    name: AGENT_ONE,
    runtime: { _tag: "stub", config: { script: "quiet" } },
    runsIn: "host",
    role: "standard",
    mcpServers: [
      {
        name: MOUNT_NAME,
        command: process.execPath,
        args: ["-e", MCP_ECHO_SCRIPT],
      },
    ],
  });
}

function assertToolPairCaptured(
  lines: ReadonlyArray<string>,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const events = yield* Effect.forEach(
      lines,
      (line) => decodeEventLine(line),
      { concurrency: 1 },
    );
    const call = events.find((event) => event._tag === EVENT.toolCall);
    const result = events.find((event) => event._tag === EVENT.toolResult);
    expect(call).toMatchObject({ tool: "ping", mount: MOUNT_NAME });
    expect(result).toMatchObject({ tool: "ping", isError: false });
    const pairMatches =
      call?._tag === EVENT.toolCall &&
      result?._tag === EVENT.toolResult &&
      call.correlationId === result.correlationId;
    expect(pairMatches).toBe(true);
  });
}

/** Minimal MCP-shaped stdio server: replies per request line, exits on stdin end. */
const MCP_ECHO_SCRIPT = [
  'process.stdin.on("data",(d)=>{d.toString().split("\\n").filter(Boolean).forEach((l)=>{const m=JSON.parse(l);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"pong:"+m.params.name}]}})+"\\n")})});',
  'process.stdin.on("end",()=>setTimeout(()=>process.exit(0),50));',
].join("");

function execWithInput(
  command: string,
  args: ReadonlyArray<string>,
  input: string,
): Effect.Effect<string, unknown, never> {
  return Command.make(command, ...args).pipe(
    Command.feed(input),
    Command.string,
    Effect.provide(NodeContext.layer),
  );
}

const LINE_POLL_MS = 25;

function awaitLine(
  lines: ReadonlyArray<string>,
  marker: string,
): Effect.Effect<void, unknown, never> {
  return lines.some((line) => line.includes(marker))
    ? Effect.void
    : Effect.sleep(`${LINE_POLL_MS} millis`).pipe(
        Effect.zipRight(Effect.suspend(() => awaitLine(lines, marker))),
      );
}

/** Path 22: the injected seed task is attributed to the principal identity. */
export function path22(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root);
    expect(outcome.sealedExit._tag).toBe(EXIT.success);
    const path = yield* expectedAttemptPath(input, root);
    const events = yield* outcome.store
      .read(path)
      .pipe(Effect.flatMap(decodedEvents));
    const injected = events.find((event) => event._tag === EVENT.taskInjected);
    expect(injected).toMatchObject({
      principal: PRINCIPAL_NAME,
      to: AGENT_ONE,
      content: TASK_CONTENT,
      source: "scheduler",
    });
  });
}

/** Path 23: an unregistered stub script is rejected by the adapter at config time. */
export function path23(): Effect.Effect<void, unknown, never> {
  return Effect.sync(() => {
    fc.assert(
      fc.property(unregisteredScriptArb, (scriptName) => {
        const exit = Effect.runSync(
          Effect.exit(materializeRunSpec(soloStubInput(scriptName))),
        );
        expect(exit._tag).toBe(EXIT.failure);
        expect(JSON.stringify(exit)).toContain(ERROR_TAG.adapterConfigRejected);
      }),
      { numRuns: 25 },
    );
  });
}

const unregisteredScriptArb = fc
  .string({ minLength: 1, maxLength: 16, unit: "grapheme-ascii" })
  .filter((name) => name !== "quiet");

function soloStubInput(scriptName: string): unknown {
  return specInput("./recordings-test", {
    agents: [
      {
        name: AGENT_ONE,
        runtime: { _tag: "stub", config: { script: scriptName } },
        runsIn: "host",
        role: "standard",
      },
    ],
    episode: {
      task: { principal: PRINCIPAL_NAME, to: AGENT_ONE, content: TASK_CONTENT },
      termination: { inactivityTimeoutMs: 60_000, onAgentCrash: "halt" },
    },
  });
}

/** Path 27: partial launch tears down started agents in reverse and seals the reason. */
export function path27(): Effect.Effect<void, unknown, never> {
  const third = "agent-three";
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      agents: [
        stubAgentInput(AGENT_ONE),
        stubAgentInput(AGENT_TWO),
        stubAgentInput(third),
      ],
      episode: doneEpisode(SHORT_INACTIVITY),
    });
    const outcome = yield* runHermetic(input, root, {
      launcherConfig: { failAtSlot: third },
    });
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.agentLaunchFailed,
    });
    expect(outcome.launch.teardownLog.slice(0, 2)).toStrictEqual([
      AGENT_TWO,
      AGENT_ONE,
    ]);
  });
}

/** Path 28: the seal-site map over the closed taxonomy (DriverCrashed included). */
export function path28(): Effect.Effect<void, unknown, never> {
  return Effect.sync(() => {
    const samples: ReadonlyArray<readonly [InfraError, string]> = [
      [
        new DriverCrashed({ driver: "principal-driver", message: "m" }),
        REASON.driverCrashed,
      ],
      [
        new ServerLaunchFailed({
          imageDigest: "sha256:0",
          detail: "d",
          message: "m",
        }),
        REASON.serverLaunchFailed,
      ],
      [
        new TranscriptDrainFailed({ detail: "d", message: "m" }),
        REASON.transcriptDrainFailed,
      ],
      [
        new FaultRevertFailed({
          faultKind: "sever",
          target: "a",
          message: "m",
        }),
        REASON.faultRevertFailed,
      ],
    ];
    fc.assert(
      fc.property(fc.constantFrom(...samples), ([error, reason]) => {
        expect(failureReasonOf(error)).toBe(reason);
      }),
    );
  });
}

/** Path 29: an acknowledgment stall beyond the bound fails the run and refuses the export. */
export function path29(): Effect.Effect<void, unknown, never> {
  const appendDelayMs = 400;
  const failBoundMs = 100;
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const store = makeLocalRecordingStore(root);
    const gate = { open: true };
    const slowStore: RecordingStore = {
      ...store,
      appendEvents: (ref, batch) =>
        gate.open
          ? store.appendEvents(ref, batch)
          : Effect.sleep(`${appendDelayMs} millis`).pipe(
              Effect.zipRight(store.appendEvents(ref, batch)),
            ),
    };
    const input = specInput(root, {
      episode: doneEpisode(60_000),
      timeouts: { otlpReceiverFailMs: failBoundMs },
    });
    const started = yield* startHermetic(input, root, { store: slowStore });
    const endpoint = yield* started.endpoint;
    yield* Effect.sleep("100 millis");
    gate.open = false;
    const status = yield* postSpans(endpoint, ["will.stall"]);
    gate.open = true;
    const sealed = yield* started.join;
    expect(status).not.toBe(HTTP_OK);
    expect(outcomeOf(sealed)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.spanAcceptanceLost,
    });
  });
}

/** Path 31: a mid-run proxy failure seals with its reason. */
export function path31(): Effect.Effect<void, unknown, never> {
  const failAfterMs = 150;
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const outcome = yield* runHermetic(input, root, {
      options: { mounts: failingMounts(failAfterMs) },
    });
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.loggingProxyFailed,
    });
  });
}

function failingMounts(
  failAfterMs: number,
): ReturnType<typeof makeEnvironment> {
  return {
    prepare: (agent) =>
      Effect.succeed({
        plan: { agent: agent.name, proxiedServers: [] },
        awaitFailure: () =>
          Effect.sleep(`${failAfterMs} millis`).pipe(
            Effect.zipRight(
              Effect.fail(
                new LoggingProxyFailed({
                  slot: agent.name,
                  mount: MOUNT_NAME,
                  message: "the proxy process died mid-run",
                }),
              ),
            ),
          ),
      }),
  };
}

/** Path 32: a failing revert seals with its reason. */
export function path32(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      world: { faults: [severWindow(AGENT_ONE, 400, 600)] },
      episode: doneEpisode(60_000),
    });
    const outcome = yield* runHermetic(input, root, {
      internals: { makeWorld: revertFailingWorld },
    });
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.faultRevertFailed,
    });
  });
}

/**
 * Regression companion to path 32: the revert fails during the
 * post-termination sweep (episode already terminated, `done` resolved),
 * where only the sweep's return channel can carry the failure to seal.
 */
export function path32Shutdown(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, {
      world: { faults: [severWindow(AGENT_ONE, 700, 500_000)] },
      episode: doneEpisode(1_200),
    });
    const outcome = yield* runHermetic(input, root, {
      internals: { makeWorld: revertFailingWorld },
    });
    expect(outcomeOf(outcome.sealedExit)).toMatchObject({
      _tag: OUTCOME.infrastructure,
      reason: REASON.faultRevertFailed,
    });
  });
}

function revertFailingWorld(): ReturnType<typeof makeWorld> {
  return makeWorld().pipe(
    Effect.map(
      (world): World => ({
        allocateEndpoint: (slot, upstream) =>
          world.allocateEndpoint(slot, upstream),
        apply: (fault) =>
          world.apply(fault).pipe(Effect.map(withFailingRevert)),
      }),
    ),
  );
}

function withFailingRevert(applied: AppliedFault): AppliedFault {
  return {
    ...applied,
    revert: () =>
      Effect.fail(
        new FaultRevertFailed({
          faultKind: applied.fault._tag,
          target: applied.fault.target,
          message: "revert failed by test wiring",
        }),
      ),
  };
}

type QueueForTest = InProcessQueue & { readonly store: RecordingStore };

function makeQueueForTest(
  root: string,
): Effect.Effect<QueueForTest, never, never> {
  return Effect.gen(function* () {
    const store = makeLocalRecordingStore(root);
    const launch = yield* makeFakeLaunch();
    const principal = makeFakePrincipal();
    const queue = yield* makeInProcessQueue({
      store,
      storeRoot: root,
      runOptions: { runner: launch.launcher },
      internals: {
        makeDrain: () => Effect.succeed(quietDrain),
        makeReceiver,
        makePrincipal: () => Effect.succeed(principal.principal),
      },
    });
    return { ...queue, store };
  });
}

const STATE_POLL_MS = 25;

function awaitState(
  queue: QueueForTest,
  attemptId: AttemptId,
  tag: "live" | "finished",
): Effect.Effect<void, unknown, never> {
  return queue.queue
    .status(attemptId)
    .pipe(
      Effect.flatMap((snapshot) =>
        snapshot._tag === tag
          ? Effect.void
          : Effect.sleep(`${STATE_POLL_MS} millis`).pipe(
              Effect.zipRight(
                Effect.suspend(() => awaitState(queue, attemptId, tag)),
              ),
            ),
      ),
    );
}

function decodeSpecInput(input: unknown): RunSpec {
  return Schema.decodeUnknownSync(RunSpec)(input);
}

/** Path 33: cancel races completion into exactly one sealed outcome; late cancel is a no-op. */
export function path33(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const queue = yield* makeQueueForTest(root);
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const submitted = yield* queue.queue.submit(decodeSpecInput(input));
    const worker = yield* Effect.forkDaemon(queue.runner.work());
    yield* awaitState(queue, submitted.attemptId, "live");
    const cancelled = yield* queue.queue.cancel(submitted.attemptId);
    expect(cancelled._tag).toBe(CANCEL.interruptDelivered);
    yield* awaitState(queue, submitted.attemptId, "finished");
    const late = yield* queue.queue.cancel(submitted.attemptId);
    expect(late._tag).toBe(CANCEL.alreadyTerminal);
    yield* assertInterruptedSeal(queue, submitted.attemptId);
    yield* queue.close;
    yield* Fiber.interrupt(worker);
  });
}

function assertInterruptedSeal(
  queue: QueueForTest,
  attemptId: AttemptId,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const snapshot = yield* queue.queue.status(attemptId);
    expect(snapshot._tag).toBe(SNAPSHOT.finished);
    if (snapshot._tag !== "finished") return;
    const recording = yield* queue.store.read(snapshot.recordingPath);
    expect(recording.seal).toBeDefined();
    expect(recording.result?.outcome).toMatchObject({
      _tag: OUTCOME.episode,
      termination: TERMINATION.interrupted,
    });
  });
}

/** Path 34: worker death marks the attempt unsealed + workerLost; retry re-enters the queue. */
export function path34(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const queue = yield* makeQueueForTest(root);
    const input = specInput(root, { episode: doneEpisode(60_000) });
    const submitted = yield* queue.queue.submit(decodeSpecInput(input));
    const worker = yield* Effect.forkDaemon(queue.runner.work());
    yield* awaitState(queue, submitted.attemptId, "live");
    yield* Fiber.interrupt(worker);
    yield* awaitState(queue, submitted.attemptId, "finished");
    const snapshot = yield* queue.queue.status(submitted.attemptId);
    expect(snapshot).toMatchObject({
      _tag: SNAPSHOT.finished,
      state: SNAPSHOT.unsealed,
      workerLost: true,
    });
    const retried = yield* queue.queue.retry(submitted.attemptId);
    expect(retried._tag).toBe(SNAPSHOT.queued);
    expect(retried.attemptId).not.toBe(submitted.attemptId);
    yield* queue.close;
  });
}

/** Path 35: irreversible teardown lands in `result.json` and the event stream. */
export function path35(): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    const root = yield* tempStoreRoot();
    const input = specInput(root, { episode: doneEpisode(SHORT_INACTIVITY) });
    const outcome = yield* runHermetic(input, root, {
      launcherConfig: {
        teardownReport: {
          complete: false,
          failures: ["proxy for agent-one would not stop"],
        },
      },
    });
    expect(outcome.sealedExit._tag).toBe(EXIT.success);
    const path = yield* expectedAttemptPath(input, root);
    const snapshot = yield* outcome.store.read(path);
    expect(snapshot.result?.teardownComplete).toBe(false);
    const events = yield* decodedEvents(snapshot);
    const teardown = events.find(
      (event) => event._tag === EVENT.teardownCompleted,
    );
    expect(teardown).toMatchObject({ complete: false });
  });
}
