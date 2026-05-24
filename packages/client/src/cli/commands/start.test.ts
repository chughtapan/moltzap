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
  TaskList,
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
  readonly taskList?: (call: TestTransportCall) => unknown | Error;
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
    const handlers: Record<string, (c: TestTransportCall) => unknown | Error> =
      {
        [AgentsLookupByName.name]: (c) => respondLookup(c, config),
        [TaskRequest.name]: () => (config.taskCreate ?? TASK_CREATE_OK)(),
        [MessagesSend.name]: () => (config.messagesSend ?? MESSAGES_SEND_OK)(),
        [TaskConversationList.name]:
          config.taskConversationList ?? (() => ({ items: [] as unknown[] })),
        [TaskList.name]:
          config.taskList ?? (() => ({ tasks: [] as unknown[] })),
      };
    const handler = handlers[call.method];
    return handler === undefined
      ? new Error(`Unexpected RPC: ${call.method}`)
      : handler(call);
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

// ─── Test bodies: proactive "one DM per pair" dedup (issue #685) ──────────

const EXISTING_TASK_ID = "00000000-0000-4000-8000-0000000000d1";
const EXISTING_CONV_ID_ACTIVE = "00000000-0000-4000-8000-0000000000d2";
const EXISTING_CONV_ID_OLDER = "00000000-0000-4000-8000-0000000000d3";
const OTHER_TASK_ID = "00000000-0000-4000-8000-0000000000e9";

// Widened-status type so active/closed/other-app fixtures share a common
// shape. `taskFixture` is loose-typed upstream (string id, no `as Task`
// cast); the widened alias is the local lower bound these tests need.
// Protocol-schema drift is caught by the protocol type canaries
// (`task-conversation-family.types-check.ts`), not by fixture site checks.
type TaskLikeFixture = Omit<
  typeof taskFixture,
  "status" | "endedAt" | "appId"
> & {
  status: "active" | "closed";
  endedAt: string | null;
  appId: string;
};

const existingTaskFixture: TaskLikeFixture = {
  ...taskFixture,
  id: EXISTING_TASK_ID,
};

const existingTaskOtherAppFixture: TaskLikeFixture = {
  ...existingTaskFixture,
  id: OTHER_TASK_ID,
  appId: VALID_APP_ID_OVERRIDE,
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

const taskListWith =
  (...tasks: TaskLikeFixture[]) =>
  () => ({ tasks });

const taskConvListItem = (
  taskId: string,
  conversation: typeof conversationFixture,
  participants: readonly string[] = [INITIATOR_ID, BOB_AGENT_ID],
) => ({
  taskId,
  conversation,
  participants: [...participants],
});

const dedupReusesActiveDm = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: taskListWith(existingTaskFixture),
      taskConversationList: () => ({
        items: [taskConvListItem(EXISTING_TASK_ID, conversationFixtureActive)],
      }),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${EXISTING_TASK_ID} (reusing existing conversation: ${EXISTING_CONV_ID_ACTIVE})`,
    );
    expect(exitSpy).not.toHaveBeenCalled();
    // Reuse path MUST NOT create a task. App-scoping list uses limit 200;
    // the conversation list first page MUST NOT pass a cursor.
    expect(findCallOf(calls, TaskRequest.name)).toBeUndefined();
    expect(findCallOf(calls, TaskList.name)!.params).toEqual({ limit: 200 });
    expect(findCallOf(calls, TaskConversationList.name)!.params).toEqual({
      limit: 100,
    });
  });

const dedupPicksFirstActivityOrder = () =>
  Effect.gen(function* () {
    // Conversations are activity-desc; the handler reuses the FIRST match
    // under the target task without re-sorting.
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: taskListWith(existingTaskFixture),
      taskConversationList: () => ({
        items: [
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

const dedupReuseWithMessage = () =>
  Effect.gen(function* () {
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: taskListWith(existingTaskFixture),
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
    expect(findCallOf(calls, TaskRequest.name)).toBeUndefined();
    expect(findCallOf(calls, MessagesSend.name)).toBeDefined();
    // The MessagesSend payload MUST route to the REUSED conversation,
    // not the (null) freshly-created one.
    const sendCall = findCallOf(calls, MessagesSend.name);
    expect(sendCall).toBeDefined();
    expect(
      (sendCall!.params as { conversationId: string }).conversationId,
    ).toBe(EXISTING_CONV_ID_ACTIVE);
  });

const dedupFiltersArchivedAndOtherTask = () =>
  Effect.gen(function* () {
    // The conversation list mixes an OTHER task (not in the app-scoped
    // active set) and an archived row under our task — both skipped; the
    // lone non-archived match under the in-scope task is reused.
    const archivedConv = { ...conversationFixtureOlder, archivedAt: NOW_ISO };
    const { transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: taskListWith(existingTaskFixture),
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
    expect(exitSpy).not.toHaveBeenCalled();
  });

const dedupScopesToRequestedApp = () =>
  Effect.gen(function* () {
    // A conversation under a DIFFERENT-app task with a matching participant
    // set MUST NOT be reused: `task/list` scopes the active set to the
    // requested app, and the join drops the other-app task id.
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: taskListWith(existingTaskOtherAppFixture),
      taskConversationList: () => ({
        items: [taskConvListItem(OTHER_TASK_ID, conversationFixtureActive)],
      }),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    // No in-scope match → create a fresh task.
    expect(findCallOf(calls, TaskRequest.name)).toBeDefined();
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${TASK_ID} (conversation: ${CONVERSATION_ID})`,
    );
  });

const dedupParticipantSetMustMatchExactly = () =>
  Effect.gen(function* () {
    // Group request {bob, carol} must NOT reuse a {bob}-only DM: the task
    // participant set differs in size, so it fails to match → create.
    const { calls, transport } = makeTransportWith({
      ...bobCarolLookup(),
      taskList: taskListWith(existingTaskFixture),
      taskConversationList: () => ({
        items: [
          taskConvListItem(EXISTING_TASK_ID, conversationFixtureActive, [
            INITIATOR_ID,
            BOB_AGENT_ID,
          ]),
        ],
      }),
    });
    yield* runWith(transport, standardArgs(["agent:bob", "agent:carol"]));
    expect(findCallOf(calls, TaskRequest.name)).toBeDefined();
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${TASK_ID} (conversation: ${CONVERSATION_ID})`,
    );
  });

const dedupSkippedForZeroParticipants = () =>
  Effect.gen(function* () {
    // Solo (zero-participant) start: dedup is carved out entirely — no
    // list scan happens and a fresh task is created.
    const { calls, transport } = makeTransportWith({
      taskList: taskListWith(existingTaskFixture),
    });
    yield* runWith(transport, standardArgs([]));
    expect(findCallOf(calls, TaskList.name)).toBeUndefined();
    expect(findCallOf(calls, TaskConversationList.name)).toBeUndefined();
    expect(findCallOf(calls, TaskRequest.name)).toBeDefined();
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${TASK_ID} (conversation: ${CONVERSATION_ID})`,
    );
  });

const dedupBestEffortOnScanFailure = () =>
  Effect.gen(function* () {
    // A transient `task/list` failure MUST NOT block creation: the scan is
    // best-effort, so the handler falls through to create a fresh task.
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: () => new Error("list temporarily unavailable"),
    });
    yield* runWith(transport, standardArgs(["agent:bob"]));
    expect(findCallOf(calls, TaskRequest.name)).toBeDefined();
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${TASK_ID} (conversation: ${CONVERSATION_ID})`,
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

const dedupPaginatesConversationList = () =>
  Effect.gen(function* () {
    // First conversation page misses (OTHER task) → follow `nextCursor` to
    // page two where the in-scope match lives. Pins cursor forwarding.
    let callCount = 0;
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: taskListWith(existingTaskFixture),
      taskConversationList: () => {
        callCount += 1;
        return callCount === 1
          ? {
              items: [
                taskConvListItem(OTHER_TASK_ID, conversationFixtureOlder),
              ],
              nextCursor: "2026-05-18T12:00:00Z",
            }
          : {
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
    const listCalls = calls.filter(
      (c) => c.method === TaskConversationList.name,
    );
    expect(listCalls[1]!.params).toEqual({
      limit: 100,
      cursor: "2026-05-18T12:00:00Z",
    });
  });

const dedupCapsScanAndFallsThroughToCreate = () =>
  Effect.gen(function* () {
    // Adversarial server that never returns `nextCursor: undefined`. The
    // scan MUST stop at `DEDUP_SCAN_MAX_PAGES = 10`; with no match it falls
    // through to create rather than looping forever.
    let pageCount = 0;
    const { calls, transport } = makeTransportWith({
      ...onlyBobLookup(),
      taskList: taskListWith(existingTaskFixture),
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
    expect(listCalls).toHaveLength(10); // DEDUP_SCAN_MAX_PAGES
    expect(findCallOf(calls, TaskRequest.name)).toBeDefined();
    expect(stdoutSpy).toHaveBeenCalledWith(
      `Task started: ${TASK_ID} (conversation: ${CONVERSATION_ID})`,
    );
  });

describe("moltzap start — proactive DM dedup (#685)", () => {
  beforeEach(installHarness);
  afterEach(restoreHarness);

  it("reuses an existing active DM conversation", dedupReusesActiveDm);
  it(
    "picks the first match in activity-desc order",
    dedupPicksFirstActivityOrder,
  );
  it(
    "with --message -> sends to the reused conversation",
    dedupReuseWithMessage,
  );
  it(
    "filters archived rows and out-of-app-scope tasks",
    dedupFiltersArchivedAndOtherTask,
  );
  it(
    "does not reuse a conversation under another app",
    dedupScopesToRequestedApp,
  );
  it(
    "does not reuse when the participant set differs",
    dedupParticipantSetMustMatchExactly,
  );
  it(
    "skips dedup entirely for zero-participant starts",
    dedupSkippedForZeroParticipants,
  );
  it(
    "falls through to create when the list scan fails",
    dedupBestEffortOnScanFailure,
  );
  it(
    "paginates the conversation list via nextCursor",
    dedupPaginatesConversationList,
  );
  it(
    "caps the scan and creates when no match is found",
    dedupCapsScanAndFallsThroughToCreate,
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
