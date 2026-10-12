/** @file Signed native handoff through the real MCP SDK, durable Events owner and scoped HTTP listener. */

import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  Clock,
  Deferred,
  Effect,
  FastCheck as fc,
  Fiber,
  Match,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { describe, expect } from "vitest";
import type { InboundDelivery } from "./capability.js";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { loopbackMcpEndpoint } from "../../__tests__/mcp-http-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import { readRuntimeEvent } from "../../delivery/inbox.js";
import { eventIdOf } from "../../delivery/operations.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  openEndpointStore,
} from "../../store/index.js";
import { InboundItem } from "../../transport/collectives/inbound.js";
import {
  makeHarnessEvents,
  makeWebhookEvents,
  runEventOperation,
} from "../mcp/events/index.js";
import { acquireHarnessEndpoint } from "./index.js";
import { acquireCallbackServer } from "./webhook-http.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed failures, exact native payloads and callback statuses pin the handoff contract. */

const credential = Redacted.make("native-webhook-test-runtime-grant-000001");
const callbackUrl = "https://native.example/events";
const token = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 1));
const item = (error = "retained native item") =>
  Schema.decodeUnknownSync(InboundItem)({
    kind: "operationFailed",
    id: digest("col_", 1),
    to: "agent:bob",
    error,
  });
const until = (condition: () => boolean) =>
  Effect.sleep("10 millis").pipe(
    Effect.repeat({ until: condition }),
    Effect.timeout("3 seconds"),
    Effect.asVoid,
  );

/** Only the public HTTPS routing boundary is substituted; MCP framing, signing, persistence and callback acceptance are real. */
const reservePort = Effect.scoped(
  acquireCallbackServer({
    port: 0,
    path: "/events",
    handle: () => Effect.dieMessage("port reservation received a callback"),
  }),
);
interface RecordedPost {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

const acquireEventOwner = (forwarding: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const store = yield* openEndpointStore(stateDirectory());
    const gate = yield* Effect.makeSemaphore(1);
    const webhook = yield* makeWebhookEvents(store, gate).pipe(
      Effect.provideService(HttpClient.HttpClient, forwarding),
    );
    const events = yield* makeHarnessEvents({
      gate,
      protocolActive: () => true,
      webhook,
      eventStore: store,
      summary: store.readInboxSummary,
    });
    yield* Effect.addFinalizer(() => events.close);
    return { store, events };
  });

function fixtureHandler({
  store,
  events,
}: Effect.Effect.Success<ReturnType<typeof acquireEventOwner>>) {
  return createMcpHandler(
    () => {
      const capabilities = { tools: {}, events: {} };
      const server = new McpServer(
        { name: "native-webhook-fixture", version: "1" },
        { capabilities },
      );
      events.install(server.server, "runtime");
      server.registerTool(
        "read_event",
        {
          inputSchema: fromJsonSchema<{ eventId: string }>({
            type: "object",
            properties: { eventId: { type: "string" } },
            required: ["eventId"],
          }),
        },
        (input, context) =>
          runEventOperation(
            readRuntimeEvent(store, input.eventId).pipe(
              Effect.map((result) => ({
                content: [{ type: "text", text: "event" }],
                structuredContent: result,
              })),
            ),
            context.mcpReq.signal,
          ),
      );
      return server;
    },
    { legacy: "reject", responseMode: "auto" },
  );
}

const acquireFixture = Effect.gen(function* () {
  const port = yield* reservePort;
  const localUrl = `http://127.0.0.1:${String(port)}/events`;
  const http = yield* HttpClient.HttpClient;
  const posts: RecordedPost[] = [];
  const owner = yield* acquireEventOwner(
    captureAndRoute(http, localUrl, posts),
  );
  const handler = fixtureHandler(owner);
  const endpoint = yield* loopbackMcpEndpoint({
    ...handler,
    fetch: (request, options) =>
      request.headers.get("authorization") ===
      `Bearer ${Redacted.value(credential)}`
        ? handler.fetch(request, options)
        : Promise.resolve(new Response("Unauthorized", { status: 401 })),
  });
  return {
    endpoint,
    port,
    localUrl,
    ...owner,
    posts,
    add: (value: InboundItem) =>
      encodeRuntimeValue(value).pipe(
        Effect.flatMap((canonicalItem) =>
          owner.store.putInboxItem({ deliveryToken: token, canonicalItem }),
        ),
      ),
    native: acquireHarnessEndpoint(endpoint, {
      credential,
      delivery: { mode: "webhook", url: callbackUrl, port },
    }),
    post: (body: string, headers: Readonly<Record<string, string>>) =>
      http
        .execute(
          HttpClientRequest.post(localUrl).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyText(body, "application/json"),
          ),
        )
        .pipe(Effect.map((response) => response.status)),
  };
});

function captureAndRoute(
  http: HttpClient.HttpClient,
  url: string,
  posts: RecordedPost[],
) {
  return HttpClient.mapRequest(http, (request) => {
    const body = Match.value(request.body).pipe(
      Match.tag("Uint8Array", (value) => new TextDecoder().decode(value.body)),
      Match.orElse(() => {
        throw new Error("Expected exact signed callback bytes");
      }),
    );
    posts.push({ body, headers: { ...request.headers } });
    return HttpClientRequest.setUrl(request, url);
  });
}

const acceptedHandoff = (
  text?: string,
  wireKind: "item" | "reference" = "item",
) =>
  Effect.gen(function* () {
    const fixture = yield* acquireFixture;
    const native = yield* fixture.native;
    const delivered = yield* Deferred.make<InboundDelivery>();
    const accept = yield* Deferred.make<undefined>();
    const listener = yield* native.messages.pipe(
      Stream.runForEach((delivery) =>
        Deferred.succeed(delivered, delivery).pipe(
          Effect.andThen(Deferred.await(accept)),
          Effect.andThen(delivery.acknowledge),
        ),
      ),
      Effect.forkScoped,
    );
    yield* until(fixture.events.hasActiveSubscription);
    const value = item(text);
    yield* fixture.add(value);
    fixture.events.notifyPending();
    const delivery = yield* Deferred.await(delivered).pipe(
      Effect.timeout("3 seconds"),
    );
    expect(delivery.item).toEqual(value);
    expect(delivery.eventId).toBe(eventIdOf(token));
    expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
    yield* Deferred.succeed(accept, undefined);
    yield* fixture.store.readInboxSummary().pipe(
      Effect.tap(() => Effect.sleep("10 millis")),
      Effect.repeat({ until: ({ pendingCount }) => pendingCount === 0 }),
      Effect.timeout("3 seconds"),
    );
    yield* Fiber.interrupt(listener);
    expect(fixture.events.hasActiveSubscription()).toBe(false);
    expect(fixture.posts[0]?.body).toContain('"type":"verification"');
    expect(fixture.posts[1]?.body).toContain(`"kind":"${wireKind}"`);
  });

describe("native signed webhook endpoint", () => {
  it(
    "signals readiness only after lazy listener acquisition and signed subscription acceptance",
    signalsReadyAfterSubscription,
  );
  it("retains the item until native acceptance and releases the owned subscription", () =>
    acceptedHandoff().pipe(Effect.provide(NodeHttpClient.layer)));
  it("resolves a large immutable reference before native handoff", () =>
    acceptedHandoff("x".repeat(300_000), "reference").pipe(
      Effect.provide(NodeHttpClient.layer),
    ));

  it(
    "failed startup cannot unsubscribe an existing receiver",
    failedStartupPreservesReceiver,
  );
  it(
    "unaccepted work is recovered and the old native receipt is fenced",
    recoversUnacceptedWork,
  );
  it(
    "rejects forged callbacks and routing changes without waking native code",
    rejectsForgedCallbacks,
  );
  it(
    "requires the one runtime grant for signed webhook acquisition",
    requiresRuntimeGrant,
  );
  it.each([
    { ageSeconds: -301, status: 401 },
    { ageSeconds: 301, status: 401 },
    { ageSeconds: -300, status: 200 },
    { ageSeconds: 300, status: 200 },
  ])(
    "a correctly signed callback at $ageSeconds seconds returns $status without waking native code",
    ({ ageSeconds, status }) => signedCallbackFreshness(ageSeconds, status),
  );
  it.prop(
    "preserves generated UTF-8 content and immutable references across acceptance",
    [fc.string({ maxLength: 512 })],
    ([text]) =>
      acceptedHandoff(text).pipe(Effect.provide(NodeHttpClient.layer)),
    { fastCheck: { numRuns: 12 } },
  );
});

function signalsReadyAfterSubscription() {
  return Effect.gen(function* () {
    const fixture = yield* acquireFixture;
    const ready = yield* Deferred.make<undefined>();
    const native = yield* acquireHarnessEndpoint(fixture.endpoint, {
      credential,
      delivery: {
        mode: "webhook",
        url: callbackUrl,
        port: fixture.port,
        onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      },
    });
    expect(yield* Deferred.isDone(ready)).toBe(false);
    expect(fixture.events.hasActiveSubscription()).toBe(false);
    const listener = yield* Stream.runDrain(native.messages).pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
    expect(fixture.events.hasActiveSubscription()).toBe(true);
    expect(fixture.posts[0]?.body).toContain('"type":"verification"');
    expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(0);
    yield* Fiber.interrupt(listener);
    expect(fixture.events.hasActiveSubscription()).toBe(false);
  }).pipe(Effect.provide(NodeHttpClient.layer));
}

function failedStartupPreservesReceiver() {
  return Effect.gen(function* () {
    const fixture = yield* acquireFixture;
    const native = yield* fixture.native;
    const delivered = yield* Deferred.make<InboundItem>();
    const first = yield* native.messages.pipe(
      Stream.runForEach((delivery) =>
        delivery.acknowledge.pipe(
          Effect.andThen(Deferred.succeed(delivered, delivery.item)),
        ),
      ),
      Effect.forkScoped,
    );
    yield* until(fixture.events.hasActiveSubscription);
    const replacement = yield* fixture.native;
    const failure = yield* replacement.messages.pipe(
      Stream.runDrain,
      Effect.flip,
    );
    expect(failure.reason).toBe("transport-failed");
    expect(fixture.events.hasActiveSubscription()).toBe(true);
    yield* fixture.add(item());
    fixture.events.notifyPending();
    expect(yield* Deferred.await(delivered)).toEqual(item());
    yield* Fiber.interrupt(first);
  }).pipe(Effect.provide(NodeHttpClient.layer));
}

function recoversUnacceptedWork() {
  return Effect.gen(function* () {
    const fixture = yield* acquireFixture;
    const native = yield* fixture.native;
    const offered = yield* Deferred.make<InboundDelivery>();
    const first = yield* native.messages.pipe(
      Stream.runForEach((delivery) =>
        Deferred.succeed(offered, delivery).pipe(Effect.asVoid),
      ),
      Effect.forkScoped,
    );
    yield* until(fixture.events.hasActiveSubscription);
    yield* fixture.add(item());
    fixture.events.notifyPending();
    const old = yield* Deferred.await(offered);
    yield* Fiber.interrupt(first);
    expect((yield* old.acknowledge.pipe(Effect.flip)).reason).toBe(
      "consumer-revoked",
    );
    expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
    const replayed = yield* Deferred.make<InboundItem>();
    const second = yield* native.messages.pipe(
      Stream.runForEach((delivery) =>
        delivery.acknowledge.pipe(
          Effect.andThen(Deferred.succeed(replayed, delivery.item)),
        ),
      ),
      Effect.forkScoped,
    );
    expect(yield* Deferred.await(replayed)).toEqual(item());
    yield* fixture.store.readInboxSummary().pipe(
      Effect.tap(() => Effect.sleep("10 millis")),
      Effect.repeat({ until: ({ pendingCount }) => pendingCount === 0 }),
      Effect.timeout("3 seconds"),
    );
    yield* Fiber.interrupt(second);
  }).pipe(Effect.provide(NodeHttpClient.layer));
}

function rejectsForgedCallbacks() {
  return Effect.gen(function* () {
    const fixture = yield* acquireFixture;
    const native = yield* fixture.native;
    let wakes = 0;
    const listener = yield* native.messages.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          wakes += 1;
        }),
      ),
      Effect.forkScoped,
    );
    yield* until(fixture.events.hasActiveSubscription);
    const verification = fixture.posts[0];
    if (verification === undefined) {
      return yield* Effect.dieMessage("verification callback missing");
    }
    expect(yield* fixture.post(verification.body, {})).toBe(401);
    expect(
      yield* fixture.post(verification.body, {
        ...verification.headers,
        "webhook-signature": "v1,Zm9yZ2Vk",
      }),
    ).toBe(401);
    expect(
      yield* fixture.post(`${verification.body} `, verification.headers),
    ).toBe(401);
    yield* fixture.add(item());
    fixture.events.notifyPending();
    yield* until(() => wakes === 1);
    const occurrence = fixture.posts[1];
    if (occurrence === undefined) {
      return yield* Effect.dieMessage("occurrence callback missing");
    }
    expect(
      yield* fixture.post(occurrence.body, {
        ...occurrence.headers,
        "x-mcp-subscription-id": "another-agent",
      }),
    ).toBe(403);
    expect(wakes).toBe(1);
    expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
    yield* Fiber.interrupt(listener);
  }).pipe(Effect.provide(NodeHttpClient.layer));
}

/** Freshness uses controlled wall time; real HTTP and cancellation keep their live scheduler. */
const receiverClockAt = (
  clock: Clock.Clock,
  timestamp: () => number,
): Clock.Clock => ({
  [Clock.ClockTypeId]: Clock.ClockTypeId,
  unsafeCurrentTimeMillis: timestamp,
  currentTimeMillis: Effect.sync(timestamp),
  unsafeCurrentTimeNanos: () => clock.unsafeCurrentTimeNanos(),
  currentTimeNanos: clock.currentTimeNanos,
  sleep: (duration) => clock.sleep(duration),
});

const signedCallbackFreshness = (ageSeconds: number, status: number) =>
  Effect.gen(function* () {
    const fixture = yield* acquireFixture;
    const native = yield* fixture.native;
    const clock = yield* Effect.clock;
    let timestamp = clock.unsafeCurrentTimeMillis();
    let wakes = 0;
    const listener = yield* native.messages.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          wakes += 1;
        }),
      ),
      Effect.withClock(receiverClockAt(clock, () => timestamp)),
      Effect.forkScoped,
    );
    yield* until(fixture.events.hasActiveSubscription);
    const verification = fixture.posts[0];
    if (verification === undefined) {
      return yield* Effect.dieMessage("verification callback missing");
    }
    yield* fixture.add(item());
    fixture.events.notifyPending();
    yield* until(() => wakes === 1);

    timestamp =
      (Number(verification.headers["webhook-timestamp"]) + ageSeconds) * 1000;
    expect(yield* fixture.post(verification.body, verification.headers)).toBe(
      status,
    );
    expect(wakes).toBe(1);
    expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
    yield* Fiber.interrupt(listener);
  }).pipe(Effect.provide(NodeHttpClient.layer));

function requiresRuntimeGrant() {
  return Effect.gen(function* () {
    const failure = yield* acquireHarnessEndpoint(
      new URL("http://127.0.0.1:1/mcp"),
      {
        delivery: { mode: "webhook", url: callbackUrl, port: 1 },
      },
    ).pipe(Effect.flip);
    expect(failure.reason).toBe("incompatible-daemon");
  });
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- The boundary-contract expectations above are complete. */
