/** @file Real-daemon acceptance for both public runtime adapters. */

import {
  acquireHarnessClient,
  type Content,
  type ConversationId,
  createConversationId,
  type HarnessTurn,
} from "@moltzap/client";
import { MoltZapAdapter } from "@moltzap/nanoclaw-channel";
import { createMoltzapChannelPlugin } from "@moltzap/openclaw-channel";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  type Scope,
  Stream,
} from "effect";
import { expect, it } from "vitest";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  ProcessTestError,
} from "../../packages/client/integration/daemon-process-harness.js";

const TURN_TIMEOUT = Duration.seconds(60);
const ACCOUNT_ID = "adapter-target";
const OPENCLAW_REPLY = "reply from the real OpenClaw adapter";
const NANOCLAW_REPLY = "reply from the real NanoClaw adapter";

const textContent = (text: string): Content => [{ type: "text", text }];

const effectFromPromise = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, ProcessTestError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new ProcessTestError({ message: `${operation} failed`, cause }),
  });

const nextTurn = <E>(stream: Stream.Stream<HarnessTurn, E>) =>
  Stream.runHead(stream).pipe(
    Effect.timeoutFail({
      duration: TURN_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({ message: "timed out awaiting certified turn" }),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ProcessTestError({ message: "certified turn stream ended" }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

const registerFixture = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.status()).toEqual({ kind: "unregistered" });
      expect(
        (yield* management.register(makeRegistrationRequest(fixture))).kind,
      ).toBe("registered");
    }),
  );

const assertDurableExchange = (
  fixture: DaemonProcessFixture,
  conversationId: ConversationId,
  initial: Content,
  reply: Content,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      const history = yield* management.readConversation(conversationId);
      expect(history.continuation).toBeNull();
      expect(
        history.records.map(
          ({ actionCertifiedRecord }) => actionCertifiedRecord.action.actionId,
        ),
      ).toEqual(["START", "MULTICAST"]);
      expect(
        history.records.map(
          ({ actionCertifiedRecord }) => actionCertifiedRecord.action.content,
        ),
      ).toEqual([initial, reply]);
    }),
  );

interface Scenario {
  readonly caller: DaemonProcessFixture;
  readonly target: DaemonProcessFixture;
}

const acquireScenario = (
  prefix: string,
): Effect.Effect<Scenario, ProcessTestError, Scope.Scope> =>
  Effect.gen(function* () {
    const infrastructure = yield* acquireProcessInfrastructure;
    const [caller, target] = yield* Effect.all(
      [
        makeDaemonProcessFixture(infrastructure, `${prefix}-caller`),
        makeDaemonProcessFixture(infrastructure, `${prefix}-target`),
      ] as const,
      { concurrency: 2 },
    );
    yield* Effect.all(
      [acquireDaemonProcess(caller), acquireDaemonProcess(target)] as const,
      { concurrency: 2 },
    );
    yield* Effect.all(
      [registerFixture(caller), registerFixture(target)] as const,
      { concurrency: 2, discard: true },
    );
    return { caller, target };
  });

const runOpenClawScenario = Effect.scoped(
  Effect.gen(function* () {
    const scenario = yield* acquireScenario("openclaw");
    const caller = yield* acquireHarnessClient(scenario.caller.endpoint);
    const conversationId = yield* createConversationId();
    const initial = textContent("hello through the real OpenClaw adapter");
    const reply = textContent(OPENCLAW_REPLY);
    const callerTurn = yield* Effect.forkScoped(nextTurn(caller.turns));
    const connected = yield* Deferred.make<void>();
    const dispatched = yield* Deferred.make<void>();
    const plugin = createMoltzapChannelPlugin();
    const abortController = new AbortController();
    const previousEndpoint = process.env.MOLTZAP_MCP_URL;
    process.env.MOLTZAP_MCP_URL = scenario.target.endpoint.href;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousEndpoint === undefined) {
          Reflect.deleteProperty(process.env, "MOLTZAP_MCP_URL");
        } else {
          process.env.MOLTZAP_MCP_URL = previousEndpoint;
        }
      }),
    );

    const running = yield* effectFromPromise("OpenClaw gateway", () =>
      plugin.gateway.startAccount({
        cfg: {
          channels: { moltzap: { accounts: [{ id: ACCOUNT_ID }] } },
        },
        accountId: ACCOUNT_ID,
        account: { id: ACCOUNT_ID },
        abortSignal: abortController.signal,
        setStatus: (status) => {
          if (status.connected === true) {
            Effect.runSync(Deferred.succeed(connected, undefined));
          }
        },
        channelRuntime: {
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: (input) => {
              expect(input.ctx.Body).toBe(
                "hello through the real OpenClaw adapter",
              );
              expect(input.ctx.SenderName).toBe(scenario.caller.agentName);
              return Promise.resolve(
                input.dispatcherOptions.deliver(
                  { text: OPENCLAW_REPLY },
                  { kind: "final" },
                ),
              ).then((delivered) => {
                expect(delivered).toBe(true);
                Effect.runSync(Deferred.succeed(dispatched, undefined));
                return { queuedFinal: true };
              });
            },
          },
        },
      }),
    ).pipe(Effect.forkScoped);

    yield* Deferred.await(connected).pipe(Effect.timeout(TURN_TIMEOUT));
    yield* caller.start({
      conversationId,
      peers: [scenario.target.agentName],
      content: initial,
    });
    yield* Deferred.await(dispatched).pipe(Effect.timeout(TURN_TIMEOUT));
    const returned = yield* Fiber.join(callerTurn);
    expect(returned.conversationId).toBe(conversationId);
    expect(returned.author.agentName).toBe(scenario.target.agentName);
    expect(returned.content).toEqual(reply);

    yield* effectFromPromise("OpenClaw gateway stop", () =>
      plugin.gateway.stopAccount({ accountId: ACCOUNT_ID }),
    );
    yield* Fiber.join(running).pipe(Effect.timeout(TURN_TIMEOUT));
    yield* assertDurableExchange(
      scenario.target,
      conversationId,
      initial,
      reply,
    );
  }),
);

const runNanoClawScenario = Effect.scoped(
  Effect.gen(function* () {
    const scenario = yield* acquireScenario("nanoclaw");
    const caller = yield* acquireHarnessClient(scenario.caller.endpoint);
    const conversationId = yield* createConversationId();
    const initial = textContent("hello through the real NanoClaw adapter");
    const reply = textContent(NANOCLAW_REPLY);
    const callerTurn = yield* Effect.forkScoped(nextTurn(caller.turns));
    const inbound = yield* Deferred.make<void>();
    const adapter = MoltZapAdapter.fromEndpoint(scenario.target.endpoint.href);
    yield* Effect.acquireRelease(
      effectFromPromise("NanoClaw setup", () =>
        adapter.setup({
          onMetadata: () => {},
          onInbound: (platformId, _threadId, message) => {
            expect(message.content).toMatchObject({
              text: "hello through the real NanoClaw adapter",
              sender: scenario.caller.agentName,
            });
            return adapter
              .deliver(platformId, null, {
                kind: "chat",
                content: { text: NANOCLAW_REPLY },
              })
              .then(() => {
                Effect.runSync(Deferred.succeed(inbound, undefined));
              });
          },
        }),
      ),
      () =>
        effectFromPromise("NanoClaw teardown", () => adapter.teardown()).pipe(
          Effect.ignore,
        ),
    );
    expect(adapter.isConnected()).toBe(true);

    yield* caller.start({
      conversationId,
      peers: [scenario.target.agentName],
      content: initial,
    });
    yield* Deferred.await(inbound).pipe(Effect.timeout(TURN_TIMEOUT));
    const returned = yield* Fiber.join(callerTurn);
    expect(returned.conversationId).toBe(conversationId);
    expect(returned.author.agentName).toBe(scenario.target.agentName);
    expect(returned.content).toEqual(reply);
    yield* assertDurableExchange(
      scenario.target,
      conversationId,
      initial,
      reply,
    );
  }),
);

it("routes START and a bound reply through real OpenClaw and NanoClaw adapters", () => {
  expect.hasAssertions();
  return Effect.runPromise(
    Effect.zipRight(runOpenClawScenario, runNanoClawScenario),
  );
}, 300_000);
