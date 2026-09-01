/** @file Raw HTTP acceptance for the Simulator's post-Router fault boundary. */

import { assert, effect as test } from "@effect/vitest";
import {
  AgentCardDigest,
  AgentId,
  type AgentId as AgentIdValue,
  MessageId,
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import {
  PollCursor,
  type RouterPollResult as PollResult,
  RouterInstanceId,
  RouterPollResult,
} from "@moltzap/router";
import canonicalize from "canonicalize";
import {
  Deferred,
  Duration,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Schema,
  Scope,
  TestClock,
} from "effect";
import { Buffer } from "node:buffer";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- These tests assert raw Node HTTP octets and Host forwarding at the proxy transport boundary.
import * as Http from "node:http";
import { afterEach, vi } from "vitest";
import { linkPolicy } from "../network/link.js";
import { makeLinkFabric } from "./link-fabric.js";
import { makeRouterFaultProxy } from "./router-fault-proxy.js";

const httpBoundary = vi.hoisted(
  (): { onServer?: (server: Http.Server) => void } => ({}),
);

vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof Http>();
  return {
    ...original,
    createServer: (listener?: Http.RequestListener) => {
      if (listener === undefined) {
        const server = original.createServer();
        httpBoundary.onServer?.(server);
        return server;
      }
      const server = original.createServer(listener);
      httpBoundary.onServer?.(server);
      return server;
    },
  };
});

afterEach(() => {
  httpBoundary.onServer = undefined;
});

/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-invalid-void-type, agent-code-guard/effect-promise, agent-code-guard/prefer-stepdown-function-order, agent-code-guard/require-assertion-rationale, max-lines-per-function, sonarjs/max-lines-per-function, sonarjs/no-clear-text-protocols, sonarjs/no-nested-functions -- Regression-only raw-HTTP acceptance uses canonical fixtures, loopback Promise callbacks, and exact hardcoded wire values to pin the private proxy boundary. */

const encoder = new TextEncoder();
const signature =
  "KDxTl7gpBIOcp3KzWrPaXGOI8uSNov6xWPXKa421caAinNAc-_pYc_kzBuUde6eY0Ayp21se-jZdCvMGLlbYDg";

function identifier(prefix: string, seed: number): string {
  return `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`;
}

function agent(seed: number): AgentIdValue {
  return Schema.decodeUnknownSync(AgentId)(identifier("agt_", seed));
}

const alice = agent(1);
const bob = agent(2);
const carol = agent(3);

function canonical(value: unknown): Buffer {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new Error("test fixture is not canonical JSON");
  }
  return Buffer.from(text, "utf8");
}

function encodedCanonical(value: unknown): string {
  return Encoding.encodeBase64Url(canonical(value));
}

function signedMessage(sender: AgentIdValue, seed: number): SignedMessageValue {
  const digest = Schema.decodeUnknownSync(AgentCardDigest)(
    `acd_${Encoding.encodeBase64Url(new Uint8Array(32).fill(9))}`,
  );
  return Schema.decodeUnknownSync(SignedMessage)({
    payload: encodedCanonical({
      kind: "signedMessage",
      moltzapVersion: MOLTZAP_VERSION,
      senderAgentId: sender,
      agentCardDigest: digest,
      recipientAgentIds: [bob],
      messageId: Schema.decodeUnknownSync(MessageId)(identifier("msg_", seed)),
      body: Encoding.encodeBase64Url(encoder.encode(String(seed))),
    }),
    signatures: [
      {
        protected: encodedCanonical({
          alg: "Ed25519",
          kid: "urn:test:sender",
          typ: "application/vnd.moltzap.signed-message+jws",
        }),
        signature,
      },
    ],
  });
}

function cursor(seed: number) {
  return Schema.decodeUnknownSync(PollCursor)(
    `plc_eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm1vbHR6YXAucG9sbC1jdXJzb3IrandlIn0..${Encoding.encodeBase64Url(new Uint8Array(12).fill(seed))}.${Encoding.encodeBase64Url(new Uint8Array(120).fill(seed))}.${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );
}

function instance(seed: number) {
  return Schema.decodeUnknownSync(RouterInstanceId)(identifier("rti_", seed));
}

function pollBody(
  routerInstanceId: ReturnType<typeof instance>,
  pollCursor: ReturnType<typeof cursor>,
  messages: readonly SignedMessageValue[],
): Buffer {
  return canonical(
    Schema.encodeSync(RouterPollResult)({
      kind: "batch",
      routerInstanceId,
      pollCursor,
      signedMessages: messages,
    }),
  );
}

function requestBody(): Buffer {
  return canonical({ callerAgentId: bob, request: {} });
}

interface ScriptedResponse {
  readonly body: Buffer;
  readonly contentType?: string;
  readonly status?: number;
}

interface Upstream {
  readonly origin: URL;
  readonly requests: Array<{
    readonly body: Buffer;
    readonly host?: string;
    readonly path?: string;
  }>;
}

function close(server: Http.Server): Effect.Effect<void> {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
}

function scriptedUpstream(
  responses: readonly ScriptedResponse[],
): Effect.Effect<Upstream, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = [...responses];
    const received: Upstream["requests"] = [];
    const server = Http.createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => {
        received.push({
          body: Buffer.concat(chunks),
          host: incoming.headers.host,
          path: incoming.url,
        });
        const next = queue.shift() ?? { body: Buffer.from("missing") };
        outgoing.writeHead(next.status ?? 200, {
          "content-type": next.contentType ?? "application/json",
          "content-length": String(next.body.byteLength),
        });
        outgoing.end(next.body);
      });
    });
    const origin = yield* Effect.async<URL>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.die("upstream did not bind"));
          return;
        }
        resume(
          Effect.succeed(new URL(`http://127.0.0.1:${String(address.port)}`)),
        );
      });
      return Effect.sync(() => server.close());
    });
    yield* Effect.addFinalizer(() => close(server));
    return { origin, requests: received };
  });
}

function blockingUpstream(): Effect.Effect<
  { readonly origin: URL; readonly received: Deferred.Deferred<void> },
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const received = yield* Deferred.make<void>();
    const server = Http.createServer((incoming) => {
      incoming.resume();
      incoming.once("end", () => {
        Effect.runSync(Deferred.succeed(received, undefined));
      });
    });
    const origin = yield* Effect.async<URL>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.die("blocking upstream did not bind"));
          return;
        }
        resume(
          Effect.succeed(new URL(`http://127.0.0.1:${String(address.port)}`)),
        );
      });
      return Effect.sync(() => server.close());
    });
    yield* Effect.addFinalizer(() => close(server));
    return { origin, received };
  });
}

interface HttpResult {
  readonly body: Buffer;
  readonly headers: Http.IncomingHttpHeaders;
  readonly status: number;
}

interface AbandonableCall {
  readonly close: () => void;
  readonly request: Http.ClientRequest;
  readonly responses: () => number;
}

function call(
  origin: URL,
  path = "/v1/messages:poll",
  body?: Buffer,
): Effect.Effect<HttpResult> {
  const requestBytes = body ?? requestBody();
  return Effect.tryPromise({
    try: () =>
      new Promise<HttpResult>((resolve, reject) => {
        const outgoing = Http.request(
          new URL(path, origin),
          {
            method: "POST",
            headers: {
              host: "signed-router.example:4318",
              "content-type": "application/json",
              "content-length": String(requestBytes.byteLength),
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.once("end", () =>
              resolve({
                body: Buffer.concat(chunks),
                headers: incoming.headers,
                status: incoming.statusCode ?? 0,
              }),
            );
          },
        );
        outgoing.once("error", reject);
        outgoing.end(requestBytes);
      }),
    catch: (cause) => cause,
  }).pipe(Effect.orDie);
}

function abandonableCall(origin: URL): Effect.Effect<AbandonableCall> {
  return Effect.sync(() => {
    const body = requestBody();
    let responses = 0;
    const outgoing = Http.request(
      new URL("/v1/messages:poll", origin),
      {
        method: "POST",
        headers: {
          host: "signed-router.example:4318",
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
      },
      (incoming) => {
        responses += 1;
        incoming.resume();
      },
    );
    outgoing.on("error", () => undefined);
    outgoing.end(body);
    return {
      close: () => outgoing.destroy(),
      request: outgoing,
      responses: () => responses,
    };
  });
}

function blockedRouteFabric() {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const base = yield* makeLinkFabric();
    return {
      entered,
      fabric: Object.freeze({
        ...base,
        drain: () => Effect.succeed([]),
        needsInterception: () => Effect.succeed(true),
        route: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
            ),
          ),
      }) satisfies typeof base,
      interrupted,
    };
  });
}

function decodeMessages(body: Buffer): readonly SignedMessageValue[] {
  const decoded: PollResult = Schema.decodeUnknownSync(
    Schema.parseJson(RouterPollResult),
  )(body.toString("utf8"));
  return decoded.kind === "batch" ? decoded.signedMessages : [];
}

function messageIds(body: Buffer): readonly string[] {
  return decodeMessages(body).map(({ messageId }) => messageId);
}

function messageRepresentations(body: Buffer): readonly unknown[] {
  const parsed = JSON.parse(body.toString("utf8")) as {
    readonly signedMessages?: readonly unknown[];
  };
  return parsed.signedMessages ?? [];
}

test("inactive poll and non-poll traffic preserve exact upstream octets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const expected = pollBody(instance(1), cursor(1), [
        signedMessage(alice, 1),
        signedMessage(carol, 2),
      ]);
      const health = Buffer.from("ready\n", "utf8");
      const upstream = yield* scriptedUpstream([
        { body: expected, contentType: "application/json; charset=utf-8" },
        { body: health, contentType: "text/plain" },
      ]);
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bob);
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      const poll = yield* call(proxy.routerOrigin);
      const nonPoll = yield* call(
        proxy.routerOrigin,
        "/healthz",
        Buffer.alloc(0),
      );

      assert.strictEqual(poll.status, 200);
      assert.deepStrictEqual(poll.body, expected);
      assert.strictEqual(
        poll.headers["content-type"],
        "application/json; charset=utf-8",
      );
      assert.deepStrictEqual(nonPoll.body, health);
      assert.strictEqual(
        upstream.requests[0]?.host,
        "signed-router.example:4318",
      );
      assert.deepStrictEqual(upstream.requests[0]?.body, requestBody());
    }),
  ));

test("advertised and controller-local origins remain distinct", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* scriptedUpstream([]);
      const fabric = yield* makeLinkFabric();
      const advertisedOrigin = new URL(
        "http://moltzap-simulator-router-proxy.run.svc:4318",
      );
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: {
          bindHost: "0.0.0.0",
          port: 0,
          advertisedOrigin,
        },
        fabric,
      });

      assert.strictEqual(proxy.routerOrigin.href, advertisedOrigin.href);
      assert.strictEqual(proxy.localRouterOrigin.hostname, "127.0.0.1");
      assert.notStrictEqual(
        proxy.localRouterOrigin.href,
        proxy.routerOrigin.href,
      );
    }),
  ));

test("an interruption during listener ownership handoff cannot orphan it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* scriptedUpstream([]);
      const fabric = yield* makeLinkFabric();
      const registeringListenerFinalizer = yield* Deferred.make<void>();
      const releaseRegistration = yield* Deferred.make<void>();
      const listenerFinalized = yield* Deferred.make<void>();
      const listenerScope = yield* Scope.make();
      const instrumentedScope = new Proxy(listenerScope, {
        get: (target, property, receiver) => {
          if (property !== "addFinalizer") {
            return Reflect.get(target, property, receiver) as unknown;
          }
          return (finalizer: Scope.Scope.Finalizer) =>
            Deferred.succeed(registeringListenerFinalizer, undefined).pipe(
              Effect.zipRight(Deferred.await(releaseRegistration)),
              Effect.zipRight(
                Scope.addFinalizerExit(target, (exit) =>
                  finalizer(exit).pipe(
                    Effect.ensuring(
                      Deferred.succeed(listenerFinalized, undefined),
                    ),
                  ),
                ),
              ),
            );
        },
      });
      const acquiring = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      }).pipe(
        Effect.provideService(Scope.Scope, instrumentedScope),
        Effect.fork,
      );

      yield* Deferred.await(registeringListenerFinalizer);
      yield* Fiber.interruptFork(acquiring);
      yield* Deferred.succeed(releaseRegistration, undefined);
      yield* Fiber.await(acquiring);
      yield* Scope.close(listenerScope, Exit.void);

      assert.isTrue(yield* Deferred.isDone(listenerFinalized));
    }),
  ));

test("cancelling before the deferred listen call closes a later-bound listener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* scriptedUpstream([]);
      const fabric = yield* makeLinkFabric();
      const listenRequested = yield* Deferred.make<void>();
      let proxyServer: Http.Server | undefined;
      let beginListening: (() => void) | undefined;
      httpBoundary.onServer = (server) => {
        proxyServer = server;
        const listen = server.listen.bind(server);
        server.listen = ((...listenArguments: unknown[]) => {
          beginListening = () => {
            Reflect.apply(listen, undefined, listenArguments);
          };
          Effect.runSync(Deferred.succeed(listenRequested, undefined));
          return server;
        }) as Http.Server["listen"];
      };
      const acquiring = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      }).pipe(Effect.fork);

      yield* Deferred.await(listenRequested);
      yield* Fiber.interrupt(acquiring);
      beginListening?.();
      const observed = proxyServer;
      if (observed === undefined) {
        return yield* Effect.die("proxy server was not observed");
      }
      yield* Effect.async<void>((resume) => {
        observed.once("close", () => resume(Effect.void));
      }).pipe(
        Effect.timeoutFail({
          duration: Duration.seconds(1),
          onTimeout: () => new Error("abandoned proxy listener stayed open"),
        }),
      );

      assert.isFalse(observed.listening);
    }),
  ));

test("post-bind listener errors fail the proxy lifecycle signal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* scriptedUpstream([]);
      const fabric = yield* makeLinkFabric();
      let proxyServer: Http.Server | undefined;
      httpBoundary.onServer = (server) => {
        proxyServer = server;
      };
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });
      httpBoundary.onServer = undefined;
      if (proxyServer === undefined) {
        return yield* Effect.die("proxy server was not observed");
      }

      proxyServer.emit("error", new Error("listener failed after bind"));
      const failure = yield* Effect.flip(proxy.failure);

      assert.strictEqual(failure.operation, "receive");
      assert.include(failure.detail, "listener failed after bind");
    }),
  ));

test("unexpected post-bind listener close fails the proxy lifecycle signal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* scriptedUpstream([]);
      const fabric = yield* makeLinkFabric();
      let proxyServer: Http.Server | undefined;
      httpBoundary.onServer = (server) => {
        proxyServer = server;
      };
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });
      httpBoundary.onServer = undefined;
      if (proxyServer === undefined) {
        return yield* Effect.die("proxy server was not observed");
      }
      const observedProxyServer = proxyServer;

      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            observedProxyServer.close(() => resolve());
          }),
      );
      const failure = yield* Effect.flip(proxy.failure);

      assert.strictEqual(failure.operation, "receive");
      assert.include(failure.detail, "closed unexpectedly");
    }),
  ));

test("a held sender cannot stop unrelated ordered traffic and releases later", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstAlice = signedMessage(alice, 3);
      const secondAlice = signedMessage(alice, 4);
      const firstCarol = signedMessage(carol, 5);
      const secondCarol = signedMessage(carol, 6);
      const releaseCursor = cursor(4);
      const releaseInstance = instance(2);
      const upstream = yield* scriptedUpstream([
        { body: pollBody(instance(2), cursor(2), [firstAlice, firstCarol]) },
        { body: pollBody(instance(2), cursor(3), [secondAlice, secondCarol]) },
        { body: pollBody(releaseInstance, releaseCursor, []) },
      ]);
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bob);
      const held = yield* fabric.driver.apply(
        alice,
        bob,
        linkPolicy.hold,
        "hold alice",
      );
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [firstCarol.messageId],
      );
      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [secondCarol.messageId],
      );
      yield* held.clear;
      yield* Effect.yieldNow();
      const released = yield* call(proxy.routerOrigin);
      assert.deepStrictEqual(messageIds(released.body), [
        firstAlice.messageId,
        secondAlice.messageId,
      ]);
      assert.deepStrictEqual(messageRepresentations(released.body), [
        Schema.encodeSync(SignedMessage)(firstAlice),
        Schema.encodeSync(SignedMessage)(secondAlice),
      ]);
      const decoded = Schema.decodeUnknownSync(
        Schema.parseJson(RouterPollResult),
      )(released.body.toString("utf8"));
      assert.strictEqual(decoded.kind, "batch");
      if (decoded.kind === "batch") {
        assert.strictEqual(decoded.pollCursor, releaseCursor);
        assert.strictEqual(decoded.routerInstanceId, releaseInstance);
      }
    }),
  ));

test("a Router discontinuity discards buffered old-instance deliveries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const old = signedMessage(alice, 7);
      const current = signedMessage(carol, 8);
      const gap = canonical(
        Schema.encodeSync(RouterPollResult)({
          kind: "feed_gap",
          routerInstanceId: instance(3),
        }),
      );
      const upstream = yield* scriptedUpstream([
        { body: pollBody(instance(3), cursor(5), [old]) },
        { body: gap },
        { body: pollBody(instance(4), cursor(6), [current]) },
      ]);
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bob);
      const held = yield* fabric.driver.apply(
        alice,
        bob,
        linkPolicy.hold,
        "hold old instance",
      );
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [],
      );
      assert.deepStrictEqual((yield* call(proxy.routerOrigin)).body, gap);
      yield* held.clear;
      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [current.messageId],
      );
    }),
  ));

test("same-instance recovery responses preserve held deliveries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const heldMessage = signedMessage(alice, 16);
      const routerInstance = instance(9);
      const gap = canonical(
        Schema.encodeSync(RouterPollResult)({
          kind: "feed_gap",
          routerInstanceId: routerInstance,
        }),
      );
      const invalid = canonical(
        Schema.encodeSync(RouterPollResult)({ kind: "cursor_invalid" }),
      );
      const upstream = yield* scriptedUpstream([
        { body: pollBody(routerInstance, cursor(13), [heldMessage]) },
        { body: gap },
        { body: invalid },
        { body: pollBody(routerInstance, cursor(14), []) },
      ]);
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bob);
      const lease = yield* fabric.driver.apply(
        alice,
        bob,
        linkPolicy.hold,
        "hold across same-instance recovery",
      );
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [],
      );
      assert.deepStrictEqual((yield* call(proxy.routerOrigin)).body, gap);
      assert.deepStrictEqual((yield* call(proxy.routerOrigin)).body, invalid);
      yield* lease.clear;
      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [heldMessage.messageId],
      );
    }),
  ));

test("a new instance after cursor invalidation discards held deliveries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oldMessage = signedMessage(alice, 17);
      const currentMessage = signedMessage(carol, 18);
      const invalid = canonical(
        Schema.encodeSync(RouterPollResult)({ kind: "cursor_invalid" }),
      );
      const upstream = yield* scriptedUpstream([
        { body: pollBody(instance(10), cursor(15), [oldMessage]) },
        { body: invalid },
        { body: pollBody(instance(11), cursor(16), [currentMessage]) },
      ]);
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bob);
      const lease = yield* fabric.driver.apply(
        alice,
        bob,
        linkPolicy.hold,
        "hold across cursor invalidation",
      );
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [],
      );
      assert.deepStrictEqual((yield* call(proxy.routerOrigin)).body, invalid);
      yield* lease.clear;
      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [currentMessage.messageId],
      );
    }),
  ));

test("drop and delay affect only their selected directed link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dropped = signedMessage(alice, 9);
      const passing = signedMessage(carol, 10);
      const delayed = signedMessage(alice, 11);
      const stillPassing = signedMessage(carol, 12);
      const upstream = yield* scriptedUpstream([
        { body: pollBody(instance(5), cursor(7), [dropped, passing]) },
        { body: pollBody(instance(5), cursor(8), [delayed, stillPassing]) },
        { body: pollBody(instance(5), cursor(9), []) },
      ]);
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bob);
      const drop = yield* fabric.driver.apply(
        alice,
        bob,
        linkPolicy.dropAll("test drop"),
        "drop alice",
      );
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [passing.messageId],
      );
      yield* drop.clear;
      yield* fabric.driver.apply(
        alice,
        bob,
        linkPolicy.delay(Duration.millis(10)),
        "delay alice",
      );
      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [stillPassing.messageId],
      );
      yield* TestClock.adjust(Duration.millis(10));
      assert.deepStrictEqual(
        messageIds((yield* call(proxy.routerOrigin)).body),
        [delayed.messageId],
      );
    }),
  ));

test("closing the acquisition scope closes the listener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* blockingUpstream();
      const fabric = yield* makeLinkFabric();
      const listenerScope = yield* Scope.make();
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      }).pipe(Scope.extend(listenerScope));

      const pending = yield* call(proxy.routerOrigin).pipe(Effect.fork);
      yield* Deferred.await(upstream.received);
      yield* Scope.close(listenerScope, Exit.void);
      const closed = yield* pending.await;
      assert.isTrue(Exit.isFailure(closed));
    }),
  ));

test("a closed response interrupts routing after upstream completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* scriptedUpstream([
        {
          body: pollBody(instance(7), cursor(11), [signedMessage(alice, 14)]),
        },
      ]);
      const blocked = yield* blockedRouteFabric();
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric: blocked.fabric,
      });
      const pending = yield* abandonableCall(proxy.routerOrigin);

      yield* Deferred.await(blocked.entered);
      assert.lengthOf(upstream.requests, 1);
      pending.close();
      yield* Deferred.await(blocked.interrupted);
      assert.isTrue(pending.request.destroyed);
    }),
  ));

test("proxy finalization interrupts routing after upstream completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* scriptedUpstream([
        {
          body: pollBody(instance(8), cursor(12), [signedMessage(alice, 15)]),
        },
      ]);
      const blocked = yield* blockedRouteFabric();
      const listenerScope = yield* Scope.make();
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric: blocked.fabric,
      }).pipe(Scope.extend(listenerScope));
      const pending = yield* abandonableCall(proxy.routerOrigin);

      yield* Deferred.await(blocked.entered);
      assert.lengthOf(upstream.requests, 1);
      yield* Scope.close(listenerScope, Exit.void);
      yield* Deferred.await(blocked.interrupted);
      assert.strictEqual(pending.responses(), 0);
      pending.close();
    }),
  ));

test("malformed poll identity and unattached discontinuity remain transparent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const invalid = Buffer.from("not-json", "utf8");
      const cursorInvalid = canonical(
        Schema.encodeSync(RouterPollResult)({ kind: "cursor_invalid" }),
      );
      const upstream = yield* scriptedUpstream([
        { body: invalid, contentType: "application/json" },
        { body: cursorInvalid },
      ]);
      const fabric = yield* makeLinkFabric();
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      assert.deepStrictEqual((yield* call(proxy.routerOrigin)).body, invalid);
      assert.deepStrictEqual(
        (yield* call(proxy.routerOrigin)).body,
        cursorInvalid,
      );
    }),
  ));

test("noncanonical results and malformed caller envelopes bypass active faults", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const selected = signedMessage(alice, 13);
      const encodedBatch = Schema.encodeSync(RouterPollResult)({
        kind: "batch",
        routerInstanceId: instance(6),
        pollCursor: cursor(10),
        signedMessages: [selected],
      });
      const noncanonical = Buffer.from(JSON.stringify(encodedBatch), "utf8");
      const canonicalBatch = canonical(encodedBatch);
      assert.notDeepEqual(noncanonical, canonicalBatch);
      const upstream = yield* scriptedUpstream([
        { body: noncanonical },
        { body: canonicalBatch },
      ]);
      const fabric = yield* makeLinkFabric();
      yield* fabric.interceptor.attach(bob);
      yield* fabric.driver.apply(
        alice,
        bob,
        linkPolicy.dropAll("must not affect malformed input"),
        "drop alice",
      );
      const proxy = yield* makeRouterFaultProxy({
        upstreamRouterOrigin: upstream.origin,
        listener: { bindHost: "127.0.0.1", port: 0 },
        fabric,
      });

      assert.deepStrictEqual(
        (yield* call(proxy.routerOrigin)).body,
        noncanonical,
      );
      assert.deepStrictEqual(
        (yield* call(proxy.routerOrigin, undefined, Buffer.from("not-json")))
          .body,
        canonicalBatch,
      );
    }),
  ));

/* eslint-enable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-invalid-void-type, agent-code-guard/effect-promise, agent-code-guard/prefer-stepdown-function-order, agent-code-guard/require-assertion-rationale, max-lines-per-function, sonarjs/max-lines-per-function, sonarjs/no-clear-text-protocols, sonarjs/no-nested-functions -- restore project limits after raw proxy acceptance. */
