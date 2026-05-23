/**
 * Unit tests for `moltzap start` (spec D2 #599 / sub-issue #661).
 *
 * Coverage map matches per-flow doc 09 §7. Each test body is a named
 * helper to keep describe-blocks under the 50-line per-function limit
 * (matches the pattern in `transport.test.ts`).
 */
import { Effect } from "effect";
import * as fc from "fast-check";
import { it as effectIt } from "@effect/vitest";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it as plainIt,
  vi,
  type MockInstance,
} from "vitest";
import {
  AgentsLookupByName,
  DEFAULT_APP_ID,
  MessagesSend,
  TaskConversationList,
  TaskRequest,
} from "@moltzap/protocol";
import { Transport } from "../transport.js";
import { makeFakeTransport, type TestTransportCall } from "./test-transport.js";
import { runStartHandler, startCommand } from "./start.js";

const it = effectIt.effect;

// ─── Contractual literals (also asserted in `help` test) ──────────────────

const HELP_SYNOPSIS = "Start a task with named participants";
const HELP_MENTIONS_MESSAGES_SEND = "MessagesSend";
const HELP_APP_ID_FLAG = "--app-id";
const HELP_EXIT_CODES_HEADING = "Exit codes:";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const CONVERSATION_NAME = "demo";
const TASK_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "00000000-0000-4000-8000-00000000000c";
const MESSAGE_ID = "00000000-0000-4000-8000-00000000000a";
const INITIATOR_ID = "00000000-0000-4000-8000-0000000000f0";
const BOB_AGENT_ID = "00000000-0000-4000-8000-000000000ab1";
const CAROL_AGENT_ID = "00000000-0000-4000-8000-000000000ab2";
const DAVE_AGENT_ID_UUID = "00000000-0000-4000-8000-000000000ab3";
const NOW_ISO = "2026-05-19T00:00:00Z";
const VALID_APP_ID_OVERRIDE = "11111111-2222-4333-8444-555555555555";
const UUID_V1_OVERRIDE = "11111111-2222-1333-8444-555555555555";

const taskFixture = {
  id: TASK_ID,
  appId: DEFAULT_APP_ID,
  initiatorAgentId: INITIATOR_ID,
  status: "active" as const,
  startedAt: NOW_ISO,
  endedAt: null,
  createdAt: NOW_ISO,
};

const conversationFixture = {
  id: CONVERSATION_ID,
  name: CONVERSATION_NAME,
  createdBy: INITIATOR_ID,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const messageFixture = {
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  senderId: INITIATOR_ID,
  parts: [{ type: "text" as const, text: "hello" }],
  createdAt: NOW_ISO,
};

const agentCard = (id: string, name: string) => ({
  id,
  name,
  status: "active" as const,
});

const TASK_CREATE_OK = () => ({
  task: taskFixture,
  conversation: conversationFixture,
});

const MESSAGES_SEND_OK = () => ({ message: messageFixture });

// ─── Fake transport assembly ──────────────────────────────────────────────

interface RespondConfig {
  readonly lookupResults?: Record<string, ReturnType<typeof agentCard>[]>;
  readonly taskCreate?: () => unknown | Error;
  readonly messagesSend?: () => unknown | Error;
  readonly taskConversationList?: (call: TestTransportCall) => unknown | Error;
}

const respondLookup = (call: TestTransportCall, config: RespondConfig) => {
  // Batched lookup (P3-2): coalesce all requested-name agent cards from
  // the mock's `lookupResults` map. Names with no entry return nothing
  // — the handler maps that to `UnresolvedParticipantError` per token.
  const params = call.params as { names: readonly string[] };
  const lookupResults = config.lookupResults ?? {};
  const agents = params.names.flatMap((name) => lookupResults[name] ?? []);
  return { agents };
};

const respondFromConfig =
  (config: RespondConfig) => (call: TestTransportCall) => {
    if (call.method === AgentsLookupByName.name) {
      return respondLookup(call, config);
    }
    if (call.method === TaskRequest.name) {
      return (config.taskCreate ?? TASK_CREATE_OK)();
    }
    if (call.method === MessagesSend.name) {
      return (config.messagesSend ?? MESSAGES_SEND_OK)();
    }
    if (call.method === TaskConversationList.name) {
      return (
        config.taskConversationList ?? (() => ({ items: [] as unknown[] }))
      )(call);
    }
    return new Error(`Unexpected RPC: ${call.method}`);
  };

const makeTransportWith = (config: RespondConfig) =>
  makeFakeTransport(respondFromConfig(config));

const runWith = (
  transport: ReturnType<typeof makeFakeTransport>["transport"],
  args: Parameters<typeof runStartHandler>[0],
) => runStartHandler(args).pipe(Effect.provideService(Transport, transport));

const findCallOf = (calls: readonly TestTransportCall[], method: string) =>
  calls.find((c) => c.method === method);

type TaskCreateParams = {
  appId: string;
  invitedAgentIds: readonly string[];
  // Spec D2 (#599) amendment N7 — `participants` is OPTIONAL on the
  // wire (caller-only path omits it; see `start.ts → createTaskAtomic`).
  initialConversation: {
    name: string;
    participants?: readonly string[];
  };
};

const taskCreateParams = (
  calls: readonly TestTransportCall[],
): TaskCreateParams =>
  findCallOf(calls, TaskRequest.name)!.params as TaskCreateParams;

const mutatingCalls = (calls: readonly TestTransportCall[]) =>
  calls.filter(
    (c) => c.method === TaskRequest.name || c.method === MessagesSend.name,
  );

const standardArgs = (
  participants: readonly string[],
  overrides: Partial<Parameters<typeof runStartHandler>[0]> = {},
): Parameters<typeof runStartHandler>[0] => ({
  name: CONVERSATION_NAME,
  participants,
  message: undefined,
  appId: undefined,
  ...overrides,
});

const onlyBobLookup = (): RespondConfig => ({
  lookupResults: { bob: [agentCard(BOB_AGENT_ID, "bob")] },
});

const bobCarolLookup = (): RespondConfig => ({
  lookupResults: {
    bob: [agentCard(BOB_AGENT_ID, "bob")],
    carol: [agentCard(CAROL_AGENT_ID, "carol")],
  },
});

// ─── Shared harness (console + process.exit) ──────────────────────────────

let stdoutSpy: MockInstance;
let stderrSpy: MockInstance;
let exitSpy: ReturnType<typeof vi.fn>;
const originalExit = process.exit;

const installHarness = () => {
  stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.fn();
  process.exit = exitSpy as never;
};

const restoreHarness = () => {
  process.exit = originalExit;
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
};

/**
 * Single-source the install/restore lifecycle for one `body` execution.
 * Used by property-test iterators (`expectNonV4Rejected`,
 * `expectNonAgentTokenRejected`) so each `fc.assert` iteration gets a
 * fresh, isolated harness without inline `installHarness()` / explicit
 * `restoreHarness()` calls that drift out of sync over time. `finally`
 * guarantees restore even on `expect` throw.
 */
const withInstalledHarness = (body: () => void): void => {
  installHarness();
  try {
    body();
  } finally {
    restoreHarness();
  }
};

const stderrLines = () => stderrSpy.mock.calls.map((c) => String(c[0] ?? ""));

// ─── Test bodies: participant model ───────────────────────────────────────

const dmShape = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith(onlyBobLookup());
    yield* runWith(transport, standardArgs(["agent:bob"]));
    const params = taskCreateParams(calls);
    expect(params.invitedAgentIds).toEqual([BOB_AGENT_ID]);
    expect(params.invitedAgentIds.length).toBe(1);
    expect(params.initialConversation.participants).toEqual([BOB_AGENT_ID]);
    expect(params.initialConversation.name).toBe(CONVERSATION_NAME);
  });

const groupShape = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith(bobCarolLookup());
    yield* runWith(transport, standardArgs(["agent:bob", "agent:carol"]));
    const params = taskCreateParams(calls);
    expect(params.invitedAgentIds).toEqual([BOB_AGENT_ID, CAROL_AGENT_ID]);
    // Pins the P3-2 batched-lookup optimization: N name-shaped tokens
    // coalesce into ONE `AgentsLookupByName` RPC, not N. Drift here
    // re-introduces a fan-out per token (visible cost on group tasks).
    const lookups = calls.filter((c) => c.method === AgentsLookupByName.name);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.params).toEqual({ names: ["bob", "carol"] });
  });

const duplicateNameDedupesLookup = () =>
  Effect.gen(function* () {
    // P3-2 secondary invariant: duplicate name tokens dedupe in the
    // batched lookup payload (one wire-name per unique value) but
    // resolve to the agent id at every input position. UUID-shaped
    // siblings still skip the wire.
    const { calls, transport } = makeTransportWith(onlyBobLookup());
    yield* runWith(
      transport,
      standardArgs(["agent:bob", `agent:${DAVE_AGENT_ID_UUID}`, "agent:bob"]),
    );
    const params = taskCreateParams(calls);
    expect(params.invitedAgentIds).toEqual([
      BOB_AGENT_ID,
      DAVE_AGENT_ID_UUID,
      BOB_AGENT_ID,
    ]);
    const lookups = calls.filter((c) => c.method === AgentsLookupByName.name);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.params).toEqual({ names: ["bob"] });
  });

const callerExcluded = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith(onlyBobLookup());
    yield* runWith(transport, standardArgs(["agent:bob"]));
    const params = taskCreateParams(calls);
    expect(params.invitedAgentIds).not.toContain(INITIATOR_ID);
    expect(params.invitedAgentIds).toEqual([BOB_AGENT_ID]);
  });

const uuidShorthand = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({});
    yield* runWith(transport, standardArgs([`agent:${DAVE_AGENT_ID_UUID}`]));
    const lookups = calls.filter((c) => c.method === AgentsLookupByName.name);
    expect(lookups).toEqual([]);
    const params = taskCreateParams(calls);
    expect(params.invitedAgentIds).toEqual([DAVE_AGENT_ID_UUID]);
  });

const zeroParticipants = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({});
    yield* runWith(transport, standardArgs([]));
    const params = taskCreateParams(calls);
    expect(params.invitedAgentIds).toEqual([]);
    // P2-B: zero-participant path MUST omit `participants` from
    // `initialConversation` so the wire payload satisfies
    // `InitialConversationSchema` (participants is Optional with
    // `minItems: 1`). The exact shape pin guards against drift.
    expect(params.initialConversation).toEqual({ name: CONVERSATION_NAME });
    expect("participants" in params.initialConversation).toBe(false);
    const lookups = calls.filter((c) => c.method === AgentsLookupByName.name);
    expect(lookups).toEqual([]);
  });

describe("moltzap start — participant model", () => {
  beforeEach(installHarness);
  afterEach(restoreHarness);

  it("dm-shape", dmShape);
  it("group-shape, order preserved", groupShape);
  it("caller-excluded", callerExcluded);
  it("uuid-shorthand", uuidShorthand);
  it("zero-participants admitted (plan §R4)", zeroParticipants);
  it(
    "duplicate name tokens dedupe in batched lookup (P3-2)",
    duplicateNameDedupesLookup,
  );
});

// ─── Test bodies: output format ───────────────────────────────────────────

const outputFormat = () =>
  Effect.gen(function* () {
    const { transport } = makeTransportWith(onlyBobLookup());
    yield* runWith(
      transport,
      standardArgs(["agent:bob"], { message: "hello" }),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${TASK_ID} (conversation: ${CONVERSATION_ID})`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(`Message sent: ${MESSAGE_ID}`);
  });

describe("moltzap start — output format", () => {
  beforeEach(installHarness);
  afterEach(restoreHarness);

  it("prints exact stdout strings with response IDs", outputFormat);
});

// ─── Test bodies: --app-id ────────────────────────────────────────────────

const defaultAppId = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith(onlyBobLookup());
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(taskCreateParams(calls).appId).toBe(DEFAULT_APP_ID);
  });

const validAppIdOverride = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith(onlyBobLookup());
    yield* runWith(
      transport,
      standardArgs(["agent:bob"], { appId: VALID_APP_ID_OVERRIDE }),
    );
    expect(taskCreateParams(calls).appId).toBe(VALID_APP_ID_OVERRIDE);
  });

const invalidAppIdGarbage = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({});
    yield* runWith(transport, standardArgs([], { appId: "not-a-uuid" }));
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(calls).toEqual([]);
    expect(stderrSpy).toHaveBeenCalledWith("Invalid --app-id: not a UUID");
  });

const invalidAppIdUuidV1 = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({});
    yield* runWith(transport, standardArgs([], { appId: UUID_V1_OVERRIDE }));
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(calls).toEqual([]);
  });

const nonV4HexDigit = fc
  .integer({ min: 0, max: 15 })
  .filter((n) => n !== 4)
  .map((n) => n.toString(16));

/**
 * Property body: builds a syntactically-valid UUID with a non-4
 * version digit and asserts the handler exits 64 with zero RPC calls.
 * Runs synchronously via `Effect.runSync` because the test transport
 * never suspends.
 */
const expectNonV4Rejected = (digit: string) =>
  withInstalledHarness(() => {
    const uuid = `11111111-2222-${digit}333-8444-555555555555`;
    const { calls, transport } = makeTransportWith({});
    Effect.runSync(runWith(transport, standardArgs([], { appId: uuid })));
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(calls).toEqual([]);
  });

const invariantNonV4Rejection = () => {
  fc.assert(fc.property(nonV4HexDigit, expectNonV4Rejected), { numRuns: 30 });
  // Re-install for afterEach symmetry; each property iteration tore
  // down its harness via `withInstalledHarness`, leaving none for the
  // outer afterEach to restore.
  installHarness();
};

describe("moltzap start — --app-id", () => {
  beforeEach(installHarness);
  afterEach(restoreHarness);

  it("default sends DEFAULT_APP_ID", defaultAppId);
  it("override sends the provided v4", validAppIdOverride);
  it("garbage UUID -> exit 64, ZERO RPC calls", invalidAppIdGarbage);
  it("UUID v1 -> exit 64, ZERO RPC calls", invalidAppIdUuidV1);
  plainIt(
    "invariant: every non-v4 syntax exits 64 with ZERO RPC calls",
    invariantNonV4Rejection,
  );
});

// ─── Test bodies: failure paths ───────────────────────────────────────────

const serverRejectsTaskCreate = () =>
  Effect.gen(function* () {
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: () => new Error("app not installed"),
    });
    yield* runWith(
      transport,
      standardArgs(["agent:bob"], { appId: VALID_APP_ID_OVERRIDE }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrLines().some((s) => s.startsWith("Failed: "))).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

const partialSuccess = () =>
  Effect.gen(function* () {
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      messagesSend: () => new Error("conv full"),
    });
    yield* runWith(
      transport,
      standardArgs(["agent:bob"], { message: "hello" }),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${TASK_ID} (conversation: ${CONVERSATION_ID})`,
    );
    expect(
      stderrLines().some((s) => s.startsWith("Error sending message: ")),
    ).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

const unresolvedLookupEmpty = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({ lookupResults: {} });
    yield* runWith(transport, standardArgs(["agent:unknown"]));
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(mutatingCalls(calls)).toEqual([]);
    expect(stderrLines().some((s) => s.includes("agent:unknown"))).toBe(true);
  });

const unresolvedShape = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({});
    yield* runWith(transport, standardArgs(["bob"]));
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(calls).toEqual([]);
  });

const tooManyDistinctNames = () =>
  Effect.gen(function* () {
    // P3-2 carve-out: `AgentsLookupByName.params.names` is capped at
    // `maxItems: 100`. With 101 DISTINCT name tokens, the batched RPC
    // would otherwise fail server-side AJV → opaque exit 1. The
    // pre-RPC cap check surfaces it as exit 64 with a clear message.
    const tokens = Array.from(
      { length: 101 },
      (_, i) => `agent:user${i.toString().padStart(3, "0")}`,
    );
    const { calls, transport } = makeTransportWith({});
    yield* runWith(transport, standardArgs(tokens));
    expect(exitSpy).toHaveBeenCalledWith(64);
    // Cap fires BEFORE the RPC — zero wire calls.
    expect(calls).toEqual([]);
    // Structural assertion: diagnostic mentions BOTH the offending
    // count and the schema cap so the user can reduce input directly.
    expect(
      stderrLines().some(
        (s) => s.includes("Too many") && s.includes("101") && s.includes("100"),
      ),
    ).toBe(true);
  });

/**
 * Property body: any token without the `agent:` prefix fails at the
 * shape check before any RPC. The handler must always exit 64 with
 * zero RPC calls — the resolver short-circuits at the prefix test.
 */
const expectNonAgentTokenRejected = (token: string) =>
  withInstalledHarness(() => {
    const { calls, transport } = makeTransportWith({});
    Effect.runSync(runWith(transport, standardArgs([token])));
    expect(exitSpy).toHaveBeenCalledWith(64);
    expect(calls).toEqual([]);
  });

const nonAgentToken = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => !s.startsWith("agent:"));

const invariantNonAgentRejection = () => {
  fc.assert(fc.property(nonAgentToken, expectNonAgentTokenRejected), {
    numRuns: 30,
  });
  installHarness();
};

describe("moltzap start — failure paths", () => {
  beforeEach(installHarness);
  afterEach(restoreHarness);

  it("server-reject TaskRequest -> exit 1", serverRejectsTaskCreate);
  it(
    "partial-success TaskRequest OK + MessagesSend fail -> exit 2",
    partialSuccess,
  );
  it(
    "unresolved (lookup empty) -> exit 64, ZERO mutating RPCs",
    unresolvedLookupEmpty,
  );
  it("unresolved (shape) -> exit 64, ZERO RPC calls", unresolvedShape);
  it(
    ">100 distinct names -> exit 64 with TooManyParticipantNamesError diagnostic",
    tooManyDistinctNames,
  );
  plainIt(
    "invariant: non-agent: prefix tokens exit 64 with ZERO RPC calls",
    invariantNonAgentRejection,
  );
});

// ─── Test bodies: dedup hit (P2-A, spec D2 amendment N6) ─────────────────

const EXISTING_TASK_ID = "00000000-0000-4000-8000-0000000000d1";
const EXISTING_CONV_ID_ACTIVE = "00000000-0000-4000-8000-0000000000d2";
const EXISTING_CONV_ID_OLDER = "00000000-0000-4000-8000-0000000000d3";
const OTHER_TASK_ID = "00000000-0000-4000-8000-0000000000e9";

// Widened-status type so active/closed fixtures share a common shape
// (default + override into `TASK_CREATE_DEDUP` without an `unknown` cast).
// `satisfies` would be tighter but `taskFixture` itself is loose-typed
// upstream (string id, no `as Task` cast) — adding a strict satisfies
// here would propagate that brittleness without the corresponding
// upstream fix. The widened alias is the local lower bound that the
// dedup tests need; protocol-schema drift is caught by the protocol
// type canaries (`task-conversation-family.types-check.ts`), not by
// fixture site checks.
type TaskLikeFixture = Omit<typeof taskFixture, "status" | "endedAt"> & {
  status: "active" | "closed";
  endedAt: string | null;
};

const existingTaskFixture: TaskLikeFixture = {
  ...taskFixture,
  id: EXISTING_TASK_ID,
};

const existingTaskClosedFixture: TaskLikeFixture = {
  ...existingTaskFixture,
  status: "closed",
  endedAt: NOW_ISO,
};

const conversationFixtureActive = {
  ...conversationFixture,
  id: EXISTING_CONV_ID_ACTIVE,
  createdAt: "2026-05-19T01:00:00Z",
};

const conversationFixtureOlder = {
  ...conversationFixture,
  id: EXISTING_CONV_ID_OLDER,
  createdAt: "2026-05-18T00:00:00Z",
};

const TASK_CREATE_DEDUP =
  (task: TaskLikeFixture = existingTaskFixture) =>
  () => ({
    task,
    conversation: null,
  });

const taskConvListItem = (
  taskId: string,
  conversation: typeof conversationFixture,
) => ({
  taskId,
  conversation,
  participants: [INITIATOR_ID, BOB_AGENT_ID],
});

const dedupHitSingleConversation = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(),
      taskConversationList: () => ({
        items: [taskConvListItem(EXISTING_TASK_ID, conversationFixtureActive)],
      }),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${EXISTING_TASK_ID} (reusing existing conversation: ${EXISTING_CONV_ID_ACTIVE})`,
    );
    expect(exitSpy).not.toHaveBeenCalled();
    // Must have called TaskConversationList exactly once (single page,
    // single match). Cursor MUST NOT be passed on first page.
    const listCall = findCallOf(calls, TaskConversationList.name);
    expect(listCall).toBeDefined();
    expect(listCall!.params).toEqual({ limit: 100 });
  });

const dedupHitMultipleConversations = () =>
  Effect.gen(function* () {
    // Server-side ordering is activity-desc, so the FIRST item under
    // the target task is the most-recently-active. The handler picks
    // it without re-sorting (per spec D2 amendment N6 tie-break: "first
    // match in server iteration order").
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(),
      taskConversationList: () => ({
        items: [
          // Server order: active first, older second.
          taskConvListItem(EXISTING_TASK_ID, conversationFixtureActive),
          taskConvListItem(EXISTING_TASK_ID, conversationFixtureOlder),
        ],
      }),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${EXISTING_TASK_ID} (reusing existing conversation: ${EXISTING_CONV_ID_ACTIVE})`,
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

const dedupHitWithMessage = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(),
      taskConversationList: () => ({
        items: [taskConvListItem(EXISTING_TASK_ID, conversationFixtureActive)],
      }),
    });
    yield* runWith(
      transport,
      standardArgs(["agent:bob"], { message: "hello" }),
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${EXISTING_TASK_ID} (reusing existing conversation: ${EXISTING_CONV_ID_ACTIVE})`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(`Message sent: ${MESSAGE_ID}`);
    // The MessagesSend payload MUST route to the REUSED conversation,
    // not the (null) freshly-created one.
    const sendCall = findCallOf(calls, MessagesSend.name);
    expect(sendCall).toBeDefined();
    expect(
      (sendCall!.params as { conversationId: string }).conversationId,
    ).toBe(EXISTING_CONV_ID_ACTIVE);
  });

const dedupHitFiltersOtherTaskAndArchived = () =>
  Effect.gen(function* () {
    // The list mixes items from other tasks AND archived rows under
    // our task — the handler must skip both and find the lone non-
    // archived match.
    const archivedConv = {
      ...conversationFixtureOlder,
      archivedAt: NOW_ISO,
    };
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(),
      taskConversationList: () => ({
        items: [
          taskConvListItem(OTHER_TASK_ID, conversationFixtureActive),
          taskConvListItem(EXISTING_TASK_ID, archivedConv),
          taskConvListItem(EXISTING_TASK_ID, conversationFixtureActive),
        ],
      }),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${EXISTING_TASK_ID} (reusing existing conversation: ${EXISTING_CONV_ID_ACTIVE})`,
    );
  });

const dedupHitTaskClosedNoUsableConversation = () =>
  Effect.gen(function* () {
    // Existing task is reported by the dedup query but all
    // conversations under it are archived → `findReusableConversation`
    // returns null → handler emits closed-task diagnostic + exit 1.
    const archivedConv = {
      ...conversationFixtureActive,
      archivedAt: NOW_ISO,
    };
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(existingTaskClosedFixture),
      taskConversationList: () => ({
        items: [taskConvListItem(EXISTING_TASK_ID, archivedConv)],
      }),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(stderrLines()).toContain(
      `Task already exists but is closed: ${EXISTING_TASK_ID}`,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

const dedupHitPaginatesUntilFound = () =>
  Effect.gen(function* () {
    // First page is full of OTHER tasks → handler must follow
    // `nextCursor` to find the target on page two. Pin both calls so a
    // regression that drops pagination support fails the test.
    let callCount = 0;
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(),
      taskConversationList: () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            items: [taskConvListItem(OTHER_TASK_ID, conversationFixtureOlder)],
            nextCursor: "2026-05-18T12:00:00Z",
          };
        }
        return {
          items: [
            taskConvListItem(EXISTING_TASK_ID, conversationFixtureActive),
          ],
        };
      },
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(callCount).toBe(2);
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${EXISTING_TASK_ID} (reusing existing conversation: ${EXISTING_CONV_ID_ACTIVE})`,
    );
    // Second call MUST forward the cursor returned by the first page.
    const listCalls = calls.filter(
      (c) => c.method === TaskConversationList.name,
    );
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]!.params).toEqual({
      limit: 100,
      cursor: "2026-05-18T12:00:00Z",
    });
  });

const dedupHitCapsAtMaxPages = () =>
  Effect.gen(function* () {
    // Adversarial server that NEVER returns nextCursor: undefined. The
    // handler MUST stop at `DEDUP_LOOKUP_MAX_PAGES = 10` and surface
    // the closed-task diagnostic; without the cap this loops forever
    // and the test times out. Pins the cap value as a contract.
    let pageCount = 0;
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(),
      taskConversationList: () => {
        pageCount += 1;
        return {
          items: [taskConvListItem(OTHER_TASK_ID, conversationFixtureOlder)],
          nextCursor: `cursor-page-${pageCount}`,
        };
      },
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    const listCalls = calls.filter(
      (c) => c.method === TaskConversationList.name,
    );
    expect(listCalls).toHaveLength(10); // DEDUP_LOOKUP_MAX_PAGES
    expect(stderrLines()).toContain(
      `Task already exists but is closed: ${EXISTING_TASK_ID}`,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

const dedupHitClosedTaskWithMessage = () =>
  Effect.gen(function* () {
    // Partial-failure: TaskRequest dedup-hit + closed-task + --message.
    // The user's message is intentionally DROPPED — handler exits 1
    // before reaching `sendFirstMessage`. Pinned so any future change
    // to add a separate diagnostic ('Message NOT sent: ...') has to
    // update this test, preventing silent regression.
    const archivedConv = {
      ...conversationFixtureActive,
      archivedAt: NOW_ISO,
    };
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(existingTaskClosedFixture),
      taskConversationList: () => ({
        items: [taskConvListItem(EXISTING_TASK_ID, archivedConv)],
      }),
    });
    yield* runWith(
      transport,
      standardArgs(["agent:bob"], { message: "hello" }),
    );
    expect(calls.filter((c) => c.method === MessagesSend.name)).toEqual([]);
    expect(stderrLines()).toContain(
      `Task already exists but is closed: ${EXISTING_TASK_ID}`,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

const dedupHitListRpcFailure = () =>
  Effect.gen(function* () {
    // TaskRequest succeeds (dedup hit). TaskConversationList fails with
    // a wire error (e.g. cursor-format drift). Without the
    // `DedupListFailedError` remap, the user would see
    // `Failed: <list-error>` and assume TaskRequest failed → retry →
    // re-dedup forever. The remap surfaces the existing taskId so the
    // user knows the task is real.
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskCreate: TASK_CREATE_DEDUP(),
      taskConversationList: () => new Error("cursor server-rejected"),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(
      stderrLines().some(
        (s) =>
          s.startsWith(`Task ${EXISTING_TASK_ID} already exists`) &&
          s.includes("reusable-conversation lookup failed"),
      ),
    ).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

describe("moltzap start — dedup hit (P2-A / spec D2 amendment N6)", () => {
  beforeEach(installHarness);
  afterEach(restoreHarness);

  it("single existing conversation -> reuses it", dedupHitSingleConversation);
  it(
    "multiple conversations -> picks first in server iteration order",
    dedupHitMultipleConversations,
  );
  it("with --message -> sends to reused conversation", dedupHitWithMessage);
  it(
    "filters items from other tasks and archived rows",
    dedupHitFiltersOtherTaskAndArchived,
  );
  it(
    "task closed / all archived -> exit 1 with stderr diagnostic",
    dedupHitTaskClosedNoUsableConversation,
  );
  it(
    "paginates via nextCursor when first page misses",
    dedupHitPaginatesUntilFound,
  );
  it(
    "caps at DEDUP_LOOKUP_MAX_PAGES when server never returns final page",
    dedupHitCapsAtMaxPages,
  );
  it(
    "closed task + --message -> message dropped, exit 1",
    dedupHitClosedTaskWithMessage,
  );
  it(
    "TaskConversationList wire failure -> distinct diagnostic, NOT 'Failed: ...'",
    dedupHitListRpcFailure,
  );
});

// ─── Tests: help text ─────────────────────────────────────────────────────

const helpDescription = () => {
  const desc = JSON.stringify(startCommand);
  expect(desc).toContain(HELP_SYNOPSIS);
  expect(desc).toContain(HELP_MENTIONS_MESSAGES_SEND);
  expect(desc).toContain(HELP_APP_ID_FLAG);
  expect(desc).toContain(HELP_EXIT_CODES_HEADING);
};

describe("moltzap start — help", () => {
  plainIt(
    "Command.withDescription contains synopsis + --app-id + exit-code table",
    helpDescription,
  );
});
