/**
 * @file The MoltZap message tool's `send` and `reply` through OpenClaw's own
 * message action runner, the code path the message tool takes, with the
 * MoltZap plugin loaded as the active channel plugin. Both actions carry the
 * same text to the same parser; `reply` takes the current turn's
 * conversation as its target.
 *
 * OpenClaw does not export the runner or its plugin registry through the
 * plugin SDK, so {@link loadOpenClawInternals} loads them from the bundled
 * dist the way the agent image's dist patch finds its anchors: by the
 * function's definition, then the alias its chunk exports it under. These
 * tests run against the pinned OpenClaw version; a version that renames one of
 * the functions fails the lookup rather than testing something else.
 */

import type { HarnessEndpoint, SendInput } from "@moltzap/client";
import type {
  ChannelAccountSnapshot,
  ChannelRuntimeSurface,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { live as it } from "@effect/vitest";
import { Data, Effect, Fiber, type ParseResult, Schema, Stream } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The package has no @effect/platform dependency, and this test only lists and reads OpenClaw's installed dist to find the runner's chunk.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, vi } from "vitest";

import { createMoltzapChannelPlugin } from "./plugin.js";

const ACCOUNT_ID = "primary";
const REQUESTER = "agent:alice";
const GROUP = "group:alice,bob,primary";
const MAIN_SESSION_KEY = "agent:primary:main";

/** How OpenClaw's runner reports an action the channel plugin performed. */
const HANDLED_BY_PLUGIN = "plugin";

/** OpenClaw's refusal of a `reply` that has no target and no turn to take one from. */
const REPLY_NEEDS_TARGET = "Action reply requires a target.";

/**
 * The agent configuration the simulator renders for an OpenClaw agent, as far
 * as the message action runner reads it: one MoltZap account, visible replies
 * through the message tool only, and no `tools.message` policy, so no
 * message-action allowlist.
 */
const SIMULATOR_CONFIG: OpenClawConfig = {
  channels: { moltzap: { accounts: [{ id: ACCOUNT_ID, mode: "shared" }] } },
  messages: { visibleReplies: "message_tool" },
};

/**
 * The tool context OpenClaw builds for a turn the MoltZap plugin submitted:
 * the provider is the channel, and the current conversation is the turn's
 * `OriginatingTo`, which the plugin sets to the turn's address.
 */
const MOLTZAP_TURN_CONTEXT = {
  currentChannelProvider: "moltzap",
  currentChannelId: REQUESTER,
  currentMessageId: "post-1",
};

const ANSWER_TEXT = '{"action":"accept","content":{"slot":"mon"}}';

/** What the endpoint receives for {@link ANSWER_TEXT} sent to `to`. */
const answerTo = (to: string) => ({
  to,
  collectiveResponse: { action: "accept", content: { slot: "mon" } },
});

const GATHER_TEXT = JSON.stringify({
  gather: "Which day?",
  deadline: 60,
  requestedSchema: {
    type: "object",
    properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  },
});

/** The fields of OpenClaw's `runMessageAction` input these tests set. */
interface MessageActionRunInput {
  readonly cfg: OpenClawConfig;
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly sourceReplyDeliveryMode?: "message_tool_only";
  readonly toolContext?: typeof MOLTZAP_TURN_CONTEXT;
}

/** The fields of OpenClaw's `runMessageAction` result these tests read. */
const messageActionRunResultSchema = Schema.Struct({
  kind: Schema.String,
  handledBy: Schema.String,
});

/** OpenClaw's plugin registry, reduced to the channel list these tests fill. */
interface PluginRegistry {
  readonly channels: Array<{
    readonly pluginId: string;
    readonly plugin: ReturnType<typeof createMoltzapChannelPlugin>;
    readonly source: string;
    readonly origin: string;
  }>;
}

/** The OpenClaw functions the tests drive, as loaded from its dist. */
interface OpenClawInternals {
  readonly runMessageAction: (input: MessageActionRunInput) => unknown;
  readonly createEmptyPluginRegistry: () => PluginRegistry;
  readonly setActivePluginRegistry: (registry: PluginRegistry) => void;
}

type RunAction = (
  input: MessageActionRunInput,
) => Effect.Effect<
  typeof messageActionRunResultSchema.Type,
  RunnerTestError | ParseResult.ParseError
>;

class RunnerTestError extends Data.TaggedError("RunnerTestError")<{
  readonly operation: string;
  readonly detail: string;
}> {
  override get message(): string {
    return `${this.operation} failed: ${this.detail}`;
  }
}

const openClawInternals = Effect.runSync(
  Effect.cached(loadOpenClawInternals()),
);

describe("OpenClaw message action runner with the MoltZap send and reply actions", () => {
  it(
    "delivers a reply on a MoltZap turn to the plugin, not the source-reply sink",
    replyBypassesSourceReplySink,
  );
  it(
    "fills a reply's missing target with the turn's conversation and sends the answer there",
    replyTakesTurnConversationAsTarget,
  );
  it(
    "refuses a reply without a target when no MoltZap turn supplies one",
    replyOutsideTurnNeedsTarget,
  );
  it(
    "sends a reply with an explicit target to that conversation",
    replyWithExplicitTargetSendsThere,
  );
  it(
    "sends answer text with send and a target the same as with reply",
    sendCarriesAnswerText,
  );
  it(
    "delivers a send to the turn's own conversation to the plugin in message_tool_only mode",
    sendOnTurnReachesPlugin,
  );
  it("sends gather text with send to a group target", sendCarriesGatherText);
  it("sends plain text with reply as a multicast", replyCarriesPlainText);
  it(
    "refuses an invalid operation text, sending nothing",
    refusesInvalidOperationText,
  );
  it("refuses a send carrying targets", sendRefusesTargets);
});

/**
 * `shouldUseInternalSourceReplySink` diverts only a `send` in
 * `message_tool_only` mode; this turn is in that mode with a current source.
 */
function replyBypassesSourceReplySink() {
  return expectSent(
    {
      cfg: SIMULATOR_CONFIG,
      action: "reply",
      params: { message: ANSWER_TEXT },
      agentId: ACCOUNT_ID,
      sessionKey: MAIN_SESSION_KEY,
      sourceReplyDeliveryMode: "message_tool_only",
      toolContext: MOLTZAP_TURN_CONTEXT,
    },
    answerTo(REQUESTER),
  );
}

function replyTakesTurnConversationAsTarget() {
  return expectSent(
    {
      cfg: SIMULATOR_CONFIG,
      action: "reply",
      params: { message: ANSWER_TEXT },
      toolContext: MOLTZAP_TURN_CONTEXT,
    },
    answerTo(REQUESTER),
  );
}

function replyOutsideTurnNeedsTarget() {
  return expectRefused(
    {
      cfg: SIMULATOR_CONFIG,
      action: "reply",
      params: { channel: "moltzap", message: ANSWER_TEXT },
    },
    REPLY_NEEDS_TARGET,
  );
}

function replyWithExplicitTargetSendsThere() {
  return expectSent(
    {
      cfg: SIMULATOR_CONFIG,
      action: "reply",
      params: { channel: "moltzap", target: GROUP, message: ANSWER_TEXT },
    },
    answerTo(GROUP),
  );
}

function sendCarriesAnswerText() {
  return expectSent(
    {
      cfg: SIMULATOR_CONFIG,
      action: "send",
      params: { channel: "moltzap", target: REQUESTER, message: ANSWER_TEXT },
    },
    answerTo(REQUESTER),
  );
}

function sendOnTurnReachesPlugin() {
  return expectSent(
    {
      cfg: SIMULATOR_CONFIG,
      action: "send",
      params: { target: REQUESTER, message: ANSWER_TEXT },
      agentId: ACCOUNT_ID,
      sessionKey: MAIN_SESSION_KEY,
      sourceReplyDeliveryMode: "message_tool_only",
      toolContext: MOLTZAP_TURN_CONTEXT,
    },
    answerTo(REQUESTER),
  );
}

function sendCarriesGatherText() {
  return withConnectedPlugin((run, sends) =>
    run({
      cfg: SIMULATOR_CONFIG,
      action: "send",
      params: { channel: "moltzap", target: GROUP, message: GATHER_TEXT },
    }).pipe(
      Effect.tap((result) => {
        expect(result.handledBy).toBe(HANDLED_BY_PLUGIN);
        expect(sends).toMatchObject([
          {
            to: GROUP,
            text: "Which day?",
            collective: { op: "gather", deadline: 60 },
          },
        ]);
      }),
    ),
  );
}

function replyCarriesPlainText() {
  return expectSent(
    {
      cfg: SIMULATOR_CONFIG,
      action: "reply",
      params: { message: "Monday works." },
      toolContext: MOLTZAP_TURN_CONTEXT,
    },
    { to: REQUESTER, text: "Monday works." },
  );
}

function refusesInvalidOperationText() {
  return expectRefused(
    {
      cfg: SIMULATOR_CONFIG,
      action: "reply",
      params: { message: '{"action":"accept"}' },
      toolContext: MOLTZAP_TURN_CONTEXT,
    },
    "reply failed: invalid answer: content: is missing",
  );
}

/** OpenClaw demands a singular target beside `targets` before the plugin runs. */
function sendRefusesTargets() {
  return expectRefused(
    {
      cfg: SIMULATOR_CONFIG,
      action: "send",
      params: {
        channel: "moltzap",
        target: REQUESTER,
        targets: [REQUESTER, "agent:bob"],
        message: "hello",
      },
    },
    "targets is not supported",
  );
}

/**
 * Runs one action and expects the plugin to perform it as exactly one
 * endpoint send of `expected`.
 * @param input The runner input.
 * @param expected The one send the endpoint must record.
 * @returns The test's effect.
 */
function expectSent(input: MessageActionRunInput, expected: object) {
  return withConnectedPlugin((run, sends) =>
    run(input).pipe(
      Effect.tap((result) => {
        expect(result.handledBy).toBe(HANDLED_BY_PLUGIN);
        expect(sends).toEqual([expected]);
      }),
    ),
  );
}

/**
 * Runs one action and expects it to fail with `refusal` before anything
 * reaches the endpoint.
 * @param input The runner input.
 * @param refusal Text the tool error must contain.
 * @returns The test's effect.
 */
function expectRefused(input: MessageActionRunInput, refusal: string) {
  return withConnectedPlugin((run, sends) =>
    run(input).pipe(
      Effect.flip,
      Effect.tap((failure) => {
        expect(failure.message).toContain(refusal);
        expect(sends).toEqual([]);
      }),
    ),
  );
}

/**
 * Registers a MoltZap plugin with a recording endpoint as OpenClaw's active
 * channel plugin, connects its account, and runs `body` with OpenClaw's
 * `runMessageAction`.
 * @param body The test, given the runner and the endpoint's recorded sends.
 * @returns The test's effect, which disconnects the account when it ends.
 */
function withConnectedPlugin<A, E>(
  body: (run: RunAction, sends: readonly SendInput[]) => Effect.Effect<A, E>,
) {
  const sends: SendInput[] = [];
  const plugin = createMoltzapChannelPlugin({
    harnessEndpointForAccount: () => recordingEndpoint(sends),
  });
  const controller = new AbortController();
  return Effect.gen(function* () {
    const internals = yield* openClawInternals;
    const registry = internals.createEmptyPluginRegistry();
    registry.channels.push({
      pluginId: "openclaw-channel",
      plugin,
      source: "test",
      origin: "workspace",
    });
    internals.setActivePluginRegistry(registry);
    const fiber = yield* connectAccount(plugin, controller.signal);
    const result = yield* body(runner(internals), sends);
    controller.abort();
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
    return result;
  });
}

function recordingEndpoint(sends: SendInput[]): HarnessEndpoint {
  return {
    send: (input) =>
      Effect.sync(() => {
        sends.push(input);
        return {};
      }),
    messages: Stream.never,
  };
}

function runner(internals: OpenClawInternals): RunAction {
  return (input) =>
    Effect.tryPromise({
      try: () => Promise.resolve(internals.runMessageAction(input)),
      catch: (cause) =>
        new RunnerTestError({
          operation: "runMessageAction",
          detail: String(cause),
        }),
    }).pipe(Effect.flatMap(Schema.decodeUnknown(messageActionRunResultSchema)));
}

function connectAccount(
  plugin: ReturnType<typeof createMoltzapChannelPlugin>,
  abortSignal: AbortSignal,
) {
  const start = plugin.gateway?.startAccount;
  const setStatus = vi.fn();
  return Effect.gen(function* () {
    if (start === undefined) {
      return yield* new RunnerTestError({
        operation: "startAccount",
        detail: "missing gateway start",
      });
    }
    const fiber = yield* Effect.tryPromise({
      try: () => start(gatewayContext(abortSignal, setStatus)),
      catch: (cause) =>
        new RunnerTestError({
          operation: "startAccount",
          detail: String(cause),
        }),
    }).pipe(Effect.fork);
    yield* Effect.tryPromise({
      try: () =>
        vi.waitFor(() => {
          expect(setStatus).toHaveBeenCalledWith(
            expect.objectContaining({ connected: true }),
          );
        }),
      catch: (cause) =>
        new RunnerTestError({ operation: "connect", detail: String(cause) }),
    });
    return fiber;
  });
}

function gatewayContext(
  abortSignal: AbortSignal,
  setStatus: (next: ChannelAccountSnapshot) => void,
) {
  let snapshot: ChannelAccountSnapshot = { accountId: ACCOUNT_ID };
  return {
    cfg: SIMULATOR_CONFIG,
    accountId: ACCOUNT_ID,
    account: { id: ACCOUNT_ID, mode: "shared" as const },
    abortSignal,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    channelRuntime: idleChannelRuntime(),
    getStatus: () => snapshot,
    setStatus: (next: ChannelAccountSnapshot) => {
      snapshot = next;
      setStatus(next);
    },
  };
}

/**
 * A channel runtime for an account that receives nothing: the endpoint's
 * inbound stream never emits, so no inbound or routing call is made.
 */
function idleChannelRuntime(): ChannelRuntimeSurface {
  const unused = () => {
    throw new Error("the idle account received a turn");
  };
  return {
    runtimeContexts: {
      register: () => ({ dispose: () => undefined }),
      get: () => undefined,
      watch: () => () => undefined,
    },
    inbound: { buildContext: unused, run: unused },
    routing: { resolveAgentRoute: unused },
  };
}

function loadOpenClawInternals(): Effect.Effect<
  OpenClawInternals,
  RunnerTestError
> {
  return Effect.all({
    runMessageAction: openClawInternal(
      "runMessageAction",
      (value): value is OpenClawInternals["runMessageAction"] =>
        typeof value === "function",
    ),
    createEmptyPluginRegistry: openClawInternal(
      "createEmptyPluginRegistry",
      (value): value is OpenClawInternals["createEmptyPluginRegistry"] =>
        typeof value === "function",
    ),
    setActivePluginRegistry: openClawInternal(
      "setActivePluginRegistry",
      (value): value is OpenClawInternals["setActivePluginRegistry"] =>
        typeof value === "function",
    ),
  });
}

/**
 * Loads one function from OpenClaw's bundled dist: the chunk that defines
 * `name` and exports it under a minified alias.
 * @param name The function's source name.
 * @param guard Checks the export is the function the test expects.
 * @returns The function, or a failure naming it unless exactly one chunk exports it.
 */
function openClawInternal<F>(
  name: string,
  guard: (value: unknown) => value is F,
): Effect.Effect<F, RunnerTestError> {
  const located = exportingChunks(name);
  const [chunk] = located;
  const missing = new RunnerTestError({
    operation: `load OpenClaw ${name}`,
    detail: `expected one dist chunk exporting it, found ${located.length}`,
  });
  if (located.length !== 1 || chunk === undefined) {
    return Effect.fail(missing);
  }
  return Effect.tryPromise({
    try: () => import(pathToFileURL(chunk.path).href),
    catch: (cause) =>
      new RunnerTestError({
        operation: `load OpenClaw ${name}`,
        detail: String(cause),
      }),
  }).pipe(
    Effect.flatMap((module: unknown) => {
      const value: unknown =
        typeof module === "object" && module !== null
          ? Object.getOwnPropertyDescriptor(module, chunk.exported)?.value
          : undefined;
      return guard(value) ? Effect.succeed(value) : Effect.fail(missing);
    }),
  );
}

/**
 * Finds the dist chunks that define `name` and export it, with the alias each
 * exports it under.
 * @param name The function's source name.
 * @returns Each such chunk's path and export alias.
 */
function exportingChunks(name: string) {
  const dist = join(
    dirname(
      createRequire(import.meta.url).resolve(
        "openclaw/plugin-sdk/channel-actions",
      ),
    ),
    "..",
  );
  const alias = new RegExp(`\\b${name} as (\\w+)\\b`, "u");
  return readdirSync(dist)
    .filter((file) => file.endsWith(".js"))
    .map((file) => join(dist, file))
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => source.includes(`function ${name}(`))
    .flatMap(({ path, source }) => {
      const exported = alias.exec(source)?.[1];
      return exported === undefined ? [] : [{ path, exported }];
    });
}
