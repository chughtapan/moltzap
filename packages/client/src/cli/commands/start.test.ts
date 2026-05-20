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
  TaskCreate,
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
  tmEndpointAddress: "endpoint",
  startedAt: NOW_ISO,
  endedAt: null,
  createdAt: NOW_ISO,
};

const conversationFixture = {
  id: CONVERSATION_ID,
  type: "group" as const,
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
}

const respondLookup = (call: TestTransportCall, config: RespondConfig) => {
  const params = call.params as { names: readonly string[] };
  const requestedName = params.names[0] ?? "";
  const lookupResults = config.lookupResults ?? {};
  return { agents: lookupResults[requestedName] ?? [] };
};

const respondFromConfig =
  (config: RespondConfig) => (call: TestTransportCall) => {
    if (call.method === AgentsLookupByName.name) {
      return respondLookup(call, config);
    }
    if (call.method === TaskCreate.name) {
      return (config.taskCreate ?? TASK_CREATE_OK)();
    }
    if (call.method === MessagesSend.name) {
      return (config.messagesSend ?? MESSAGES_SEND_OK)();
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
  initialConversation: { name: string; participants: readonly string[] };
};

const taskCreateParams = (
  calls: readonly TestTransportCall[],
): TaskCreateParams =>
  findCallOf(calls, TaskCreate.name)!.params as TaskCreateParams;

const mutatingCalls = (calls: readonly TestTransportCall[]) =>
  calls.filter(
    (c) => c.method === TaskCreate.name || c.method === MessagesSend.name,
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
    expect(params.initialConversation.participants).toEqual([]);
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
const expectNonV4Rejected = (digit: string) => {
  const uuid = `11111111-2222-${digit}333-8444-555555555555`;
  const { calls, transport } = makeTransportWith({});
  installHarness();
  Effect.runSync(runWith(transport, standardArgs([], { appId: uuid })));
  expect(exitSpy).toHaveBeenCalledWith(64);
  expect(calls).toEqual([]);
  restoreHarness();
};

const invariantNonV4Rejection = () => {
  fc.assert(fc.property(nonV4HexDigit, expectNonV4Rejected), { numRuns: 30 });
  // Re-install for afterEach symmetry; the property body restored
  // its own harness on each iteration.
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

/**
 * Property body: any token without the `agent:` prefix fails at the
 * shape check before any RPC. The handler must always exit 64 with
 * zero RPC calls — the resolver short-circuits at the prefix test.
 */
const expectNonAgentTokenRejected = (token: string) => {
  installHarness();
  const { calls, transport } = makeTransportWith({});
  Effect.runSync(runWith(transport, standardArgs([token])));
  expect(exitSpy).toHaveBeenCalledWith(64);
  expect(calls).toEqual([]);
  restoreHarness();
};

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

  it("server-reject TaskCreate -> exit 1", serverRejectsTaskCreate);
  it(
    "partial-success TaskCreate OK + MessagesSend fail -> exit 2",
    partialSuccess,
  );
  it(
    "unresolved (lookup empty) -> exit 64, ZERO mutating RPCs",
    unresolvedLookupEmpty,
  );
  it("unresolved (shape) -> exit 64, ZERO RPC calls", unresolvedShape);
  plainIt(
    "invariant: non-agent: prefix tokens exit 64 with ZERO RPC calls",
    invariantNonAgentRejection,
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
