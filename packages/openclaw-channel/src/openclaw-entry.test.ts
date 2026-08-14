/** @file Contract tests for the OpenClaw projection of HarnessClient. */

import { live as it } from "@effect/vitest";
import {
  AgentName,
  type Content,
  ConversationId,
  type HarnessClient,
  type HarnessTurn,
  ReplyError,
  type StartInput,
  type VerifiedAgentCard,
} from "@moltzap/client";
import { Data, Effect, Fiber, Schema, Stream } from "effect";
import { describe, expect, vi, it as vitestIt } from "vitest";

import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  createMoltzapChannelPlugin,
  makeMoltZapChannelConfigJsonSchema,
  type OpenClawReplyDispatcher,
  type OpenClawStartAccountContext,
} from "./openclaw-entry.js";

const ACCOUNT_ID = "primary";
const FIRST_CONVERSATION_ID = decodeConversationId(
  "550e8400-e29b-41d4-a716-446655440101",
);
const SECOND_CONVERSATION_ID = decodeConversationId(
  "550e8400-e29b-41d4-a716-446655440102",
);
const ALICE = fakeVerifiedCard("alice");
const BOB = fakeVerifiedCard("bob");
const CAROL = fakeVerifiedCard("carol");

/* eslint-disable agent-code-guard/prefer-stepdown-function-order -- Shared structural fixtures stay together before the scenarios that combine them. */

class OpenClawTestError extends Data.TaggedError("OpenClawTestError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

interface DispatchCall {
  readonly ctx: Readonly<Record<string, string | undefined>>;
  readonly dispatcherOptions: {
    readonly deliver: (
      payload: { readonly text?: string; readonly body?: string },
      info?: { readonly kind?: string },
    ) => PromiseLike<boolean>;
  };
}

interface FakeHarnessClient {
  readonly client: HarnessClient;
  readonly starts: readonly StartInput[];
}

function decodeConversationId(value: string): ConversationId {
  return Schema.decodeUnknownSync(ConversationId)(value);
}

function decodeAgentName(value: string): AgentName {
  return Schema.decodeUnknownSync(AgentName)(value);
}

function fakeVerifiedCard(name: string): VerifiedAgentCard {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- HarnessClient deliberately exports a verified nominal type without a public test constructor.
  return /* Safe because the adapter reads only the public agentName view and this fixture isolates that projection. */ {
    agentName: decodeAgentName(name),
  } as VerifiedAgentCard;
}

function turn(input: {
  readonly conversationId: ConversationId;
  readonly author: VerifiedAgentCard;
  readonly peers: readonly [VerifiedAgentCard, ...VerifiedAgentCard[]];
  readonly content: Content;
  readonly reply: HarnessTurn["reply"];
}): HarnessTurn {
  return input;
}

function makeClient(turns: readonly HarnessTurn[]): FakeHarnessClient {
  const starts: StartInput[] = [];
  return {
    starts,
    client: {
      start: (input) =>
        Effect.sync(() => {
          starts.push(input);
        }),
      turns: Stream.fromIterable(turns),
    },
  };
}

function makeNeverClient(): FakeHarnessClient {
  const starts: StartInput[] = [];
  return {
    starts,
    client: {
      start: (input) =>
        Effect.sync(() => {
          starts.push(input);
        }),
      turns: Stream.never,
    },
  };
}

function makeConfig() {
  return {
    channels: { moltzap: { accounts: [{ id: ACCOUNT_ID }] } },
  };
}

function gatewayContext(
  abortSignal: AbortSignal,
  dispatch: OpenClawReplyDispatcher,
  setStatus: ReturnType<typeof vi.fn>,
): OpenClawStartAccountContext {
  return {
    cfg: makeConfig(),
    accountId: ACCOUNT_ID,
    account: { id: ACCOUNT_ID },
    abortSignal,
    setStatus,
    channelRuntime: {
      reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
    },
  };
}

function startAccount(
  plugin: ReturnType<typeof createMoltzapChannelPlugin>,
  ctx: OpenClawStartAccountContext,
) {
  return Effect.tryPromise({
    try: () => plugin.gateway.startAccount(ctx),
    catch: (cause) =>
      new OpenClawTestError({ operation: "startAccount", cause }),
  });
}

function stopAccount(plugin: ReturnType<typeof createMoltzapChannelPlugin>) {
  return Effect.tryPromise({
    try: () => plugin.gateway.stopAccount({ accountId: ACCOUNT_ID }),
    catch: (cause) =>
      new OpenClawTestError({ operation: "stopAccount", cause }),
  });
}

function sendText(
  plugin: ReturnType<typeof createMoltzapChannelPlugin>,
  to: string,
  text: string,
) {
  return Effect.tryPromise({
    try: () =>
      plugin.outbound.sendText({
        cfg: makeConfig(),
        accountId: ACCOUNT_ID,
        to,
        text,
      }),
    catch: (cause) => new OpenClawTestError({ operation: "sendText", cause }),
  });
}

function dispatchCall(
  calls: readonly DispatchCall[],
  index: number,
): DispatchCall {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`missing dispatch call ${index}`);
  }
  return call;
}

function replyRecorder() {
  const replies: Content[] = [];
  const reply: HarnessTurn["reply"] = (content) =>
    Effect.sync(() => {
      replies.push(content);
    });
  return { replies, reply };
}

function semanticTurnsBindTheirOwnReplies() {
  const first = replyRecorder();
  const second = replyRecorder();
  const fake = makeClient(semanticTurnFixture(first.reply, second.reply));
  const calls: DispatchCall[] = [];
  const dispatch: OpenClawReplyDispatcher = (input) => {
    calls.push(input);
    return Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          Promise.resolve(
            input.dispatcherOptions.deliver(
              { text: `reply:${input.ctx.Body ?? ""}` },
              { kind: "final" },
            ),
          ),
        catch: (cause) =>
          new OpenClawTestError({ operation: "deliver", cause }),
      }).pipe(Effect.as({ queuedFinal: true })),
    );
  };
  const plugin = createMoltzapChannelPlugin({
    harnessClientForAccount: () => fake.client,
  });
  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, dispatch, vi.fn()),
    );
    expect(calls).toHaveLength(2);
    expectDirectProjection(dispatchCall(calls, 0));
    expectGroupProjection(dispatchCall(calls, 1));
    expect(first.replies).toEqual([
      [{ type: "text", text: 'reply:hello\n{"count":2}' }],
    ]);
    expect(second.replies).toEqual([
      [{ type: "text", text: "reply:group turn" }],
    ]);
  });
}

function semanticTurnFixture(
  firstReply: HarnessTurn["reply"],
  secondReply: HarnessTurn["reply"],
): readonly HarnessTurn[] {
  return [
    turn({
      conversationId: FIRST_CONVERSATION_ID,
      author: ALICE,
      peers: [ALICE],
      content: [
        { type: "text", text: "hello" },
        { type: "data", value: { count: 2 } },
      ],
      reply: firstReply,
    }),
    turn({
      conversationId: SECOND_CONVERSATION_ID,
      author: BOB,
      peers: [BOB, CAROL],
      content: [{ type: "text", text: "group turn" }],
      reply: secondReply,
    }),
  ] as const;
}

function expectDirectProjection(call: DispatchCall): void {
  expect(call.ctx).toMatchObject({
    Body: 'hello\n{"count":2}',
    BodyForAgent: 'hello\n{"count":2}',
    From: "agent:alice",
    To: ACCOUNT_ID,
    ChatType: "direct",
    SenderName: "alice",
    OriginatingTo: `conv:${FIRST_CONVERSATION_ID}`,
  });
  expect(call.ctx.GroupMembers).toBeUndefined();
  expect(call.ctx.ConversationLabel).toBeUndefined();
}

function expectGroupProjection(call: DispatchCall): void {
  expect(call.ctx).toMatchObject({
    Body: "group turn",
    BodyForAgent: "group turn",
    From: "agent:bob",
    ChatType: "group",
    GroupMembers: "agent:bob,agent:carol",
    SenderName: "bob",
    OriginatingTo: `conv:${SECOND_CONVERSATION_ID}`,
  });
}

function agentOutboundStartsConversation() {
  const fake = makeNeverClient();
  const connected = vi.fn();
  const plugin = createMoltzapChannelPlugin({
    harnessClientForAccount: () => fake.client,
  });
  const abortController = new AbortController();
  const dispatch = vi.fn<OpenClawReplyDispatcher>();
  const running = startAccount(
    plugin,
    gatewayContext(abortController.signal, dispatch, connected),
  ).pipe(Effect.fork);
  return Effect.gen(function* () {
    const fiber = yield* running;
    yield* waitForConnected(connected);
    const result = yield* sendText(plugin, "agent:nova", "hello nova");
    expect(result.ok).toBe(true);
    expect(fake.starts).toHaveLength(1);
    const start = fake.starts[0];
    if (start === undefined) {
      return yield* new OpenClawTestError({
        operation: "missing start input",
        cause: new Error("HarnessClient.start was not called"),
      });
    }
    expectStartInput(start);
    yield* stopAccount(plugin);
    yield* Effect.timeout(Fiber.join(fiber), "1 second");
  });
}

function waitForConnected(setStatus: ReturnType<typeof vi.fn>) {
  return Effect.tryPromise({
    try: () =>
      vi.waitFor(() => {
        expect(setStatus).toHaveBeenCalledWith(
          expect.objectContaining({ connected: true }),
        );
      }),
    catch: (cause) =>
      new OpenClawTestError({ operation: "waitForConnected", cause }),
  });
}

function expectStartInput(input: StartInput): void {
  expect(Schema.is(ConversationId)(input.conversationId)).toBe(true);
  expect(input.peers).toEqual([decodeAgentName("nova")]);
  expect(input.content).toEqual([{ type: "text", text: "hello nova" }]);
}

function replyFailureReturnsFalse() {
  const failedTurn = turn({
    conversationId: FIRST_CONVERSATION_ID,
    author: ALICE,
    peers: [ALICE],
    content: [{ type: "text", text: "hello" }],
    reply: () => Effect.fail(new ReplyError({ reason: "durability" })),
  });
  const fake = makeClient([failedTurn]);
  let deliveryResult = true;
  const dispatch: OpenClawReplyDispatcher = (input) =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          Promise.resolve(
            input.dispatcherOptions.deliver(
              { text: "cannot persist" },
              { kind: "final" },
            ),
          ),
        catch: (cause) =>
          new OpenClawTestError({ operation: "deliver", cause }),
      }).pipe(
        Effect.tap((delivered) =>
          Effect.sync(() => {
            deliveryResult = delivered;
          }),
        ),
        Effect.as({ queuedFinal: true }),
      ),
    );
  const plugin = createMoltzapChannelPlugin({
    harnessClientForAccount: () => fake.client,
  });
  return Effect.gen(function* () {
    yield* startAccount(
      plugin,
      gatewayContext(new AbortController().signal, dispatch, vi.fn()),
    );
    expect(deliveryResult).toBe(false);
  });
}

function targetAndDirectoryCut() {
  const plugin = createMoltzapChannelPlugin();
  const resolver = plugin.messaging.targetResolver;
  expect(resolver.looksLikeId("agent:alice")).toBe(true);
  expect(resolver.looksLikeId("alice")).toBe(false);
  expect(plugin.outbound.resolveTarget({ to: "alice" })).toMatchObject({
    ok: true,
    to: "agent:alice",
  });
  expect(plugin.outbound.resolveTarget({ to: "conv:abc" }).ok).toBe(false);
  expect("directory" in plugin).toBe(false);
}

function manifestMatchesRuntimeSchema() {
  const { $schema, ...generated } = makeMoltZapChannelConfigJsonSchema();
  expect($schema).toBeDefined();
  if (!("required" in generated)) {
    throw new Error("expected an object schema");
  }
  const { required, ...embedded } = generated;
  expect(required).toHaveLength(0);
  expect(manifest.channelConfigs.moltzap.schema).toEqual(embedded);
}

describe("OpenClaw HarnessClient adapter", () => {
  it(
    "projects semantic turns and preserves each bound reply",
    semanticTurnsBindTheirOwnReplies,
  );
  it("maps agent sendText to START", agentOutboundStartsConversation);
  it("reports a bound reply failure to OpenClaw", replyFailureReturnsFalse);
  vitestIt(
    "cuts conversation targets and directory callbacks",
    targetAndDirectoryCut,
  );
  vitestIt(
    "keeps the OpenClaw manifest schema in sync",
    manifestMatchesRuntimeSchema,
  );
});

/* eslint-enable agent-code-guard/prefer-stepdown-function-order -- Restore the source ordering rule outside this fixture-oriented test module. */
