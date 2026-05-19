/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types like `ReadonlyArray<...>` use natural angle-bracket form inside backtick spans; matches filter-equivalence.test.ts precedent. */
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { Chunk, Data, Duration, Effect, Option, Ref, Stream } from "effect";
import {
  isDecodedNotification,
  type AnyNotificationDefinition,
  type DecodedNotification,
} from "@moltzap/protocol";
import {
  agentId,
  makeCloseableTestClient,
  registerTestAgent,
  TransportClosedError,
  type CloseableTestClient,
  type TestAgent,
} from "@moltzap/protocol/testing";
import { getBaseUrl, getWsUrl } from "./index.js";

import { ConversationsCreate } from "@moltzap/protocol";

/**
 * Spec B (#596): the legacy `waitForNotification(def, timeoutMs?)` /
 * `drainNotifications(): ReadonlyArray<...>` synchronous wrappers were
 * deleted. Consumers reach typed-payload Streams via
 * `client.subscribeTo(def)` and snapshot the buffered queue via the
 * passthrough `client.drainNotifications` Effect (`yield*` it).
 * Ergonomic one-shot test sites use the top-level `awaitOneNotification`
 * helper below.
 */
export interface ServerTestClient
  extends Omit<CloseableTestClient, "close" | "waitForNotification"> {
  close(): Effect.Effect<void, never>;
  subscribeTo<D extends AnyNotificationDefinition>(
    definition: D,
  ): Stream.Stream<DecodedNotification<D>, TransportClosedError>;
}

/**
 * Default ceiling for `awaitOneNotification`; matches the legacy
 * `TestClient.waitForNotification` default.
 */
const DEFAULT_AWAIT_NOTIFICATION_TIMEOUT_MS = 5_000;

class AwaitNotificationTimeoutError extends Data.TaggedError(
  "AwaitNotificationTimeoutError",
)<{
  readonly definition: string;
  readonly durationMs: number;
}> {}

class AwaitNotificationClosedError extends Data.TaggedError(
  "AwaitNotificationClosedError",
)<{
  readonly definition: string;
}> {}

export type AwaitNotificationError =
  | AwaitNotificationTimeoutError
  | AwaitNotificationClosedError;

/**
 * Stream-based one-shot waiter. Consumes `client.subscribeTo(def)` via
 * `Stream.runHead`, failing with a tagged error on timeout or stream
 * exhaustion. Replaces the deleted `client.waitForNotification(def)` shape
 * at integration-test call sites; preserves the `yield* …` ergonomic but
 * runs entirely on the new `Stream.async`-backed subscription API.
 */
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  client: Pick<ServerTestClient, "subscribeTo">,
  definition: D,
  timeoutMs: number = DEFAULT_AWAIT_NOTIFICATION_TIMEOUT_MS,
): Effect.Effect<
  DecodedNotification<D>,
  AwaitNotificationError | TransportClosedError
> {
  return client.subscribeTo(definition).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new AwaitNotificationTimeoutError({
          definition: definition.name,
          durationMs: timeoutMs,
        }),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new AwaitNotificationClosedError({
              definition: definition.name,
            }),
          ),
        onSome: (notification) => Effect.succeed(notification),
      }),
    ),
  );
}

export interface ConnectedAgent {
  client: ServerTestClient;
  agentId: string;
  apiKey: string;
  name: string;
}

const openClients: ServerTestClient[] = [];
const MIN_AGENT_GROUP_SIZE = 2;
const POST_METHOD = "POST";

class PostJsonRequestError extends Data.TaggedError("PostJsonRequestError")<{
  readonly message: string;
  readonly method: "POST";
  readonly path: string;
  readonly reason: string;
  readonly url: string;
  readonly cause?: unknown;
}> {}

class PostJsonResponseError extends Data.TaggedError("PostJsonResponseError")<{
  readonly message: string;
  readonly method: "POST";
  readonly path: string;
  readonly reason: string;
  readonly status: number;
  readonly url: string;
  readonly cause?: unknown;
}> {}

class PostJsonDecodeError extends Data.TaggedError("PostJsonDecodeError")<{
  readonly message: string;
  readonly method: "POST";
  readonly path: string;
  readonly reason: string;
  readonly url: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

class AgentGroupSizeError extends Data.TaggedError("AgentGroupSizeError")<{
  readonly message: string;
  readonly minimumAgents: number;
  readonly requestedAgents: number;
}> {}

type PostJsonError =
  | PostJsonRequestError
  | PostJsonResponseError
  | PostJsonDecodeError;

interface PostJsonResult {
  readonly status: number;
  readonly json: unknown;
}

type HttpResponse = Effect.Effect.Success<
  ReturnType<HttpClient.HttpClient["execute"]>
>;

export function trackClient(client: ServerTestClient): void {
  openClients.push(client);
}

export function closeAllClients(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    for (const c of openClients) yield* c.close();
    openClients.length = 0;
  }).pipe(Effect.withSpan("closeAllClients"));
}

export function registerAgent(
  baseUrl: string,
  name: string,
  opts?: { description?: string; inviteCode?: string },
): Effect.Effect<TestAgent, Error> {
  return registerTestAgent({
    baseUrl,
    name,
    description: opts?.description,
    inviteCode: opts?.inviteCode,
    uniqueSuffix: false,
  });
}

// IMPL-DELETION-TARGET (#645): the `NotificationBuffer` + `pullOneMatching`
// + `makeSubscribeStream` per-client dedup-ring + 5ms poll loop exist only
// because the underlying `TestClient` exposes polling-shape
// `drainNotifications`. Once `TestClient.subscribe` lands (Stream.async +
// registry), `subscribeTo<D>(def)` collapses to a one-line passthrough
// `testClient.subscribe(def)`; this entire block (`NotificationBuffer`
// type, `SUBSCRIBE_POLL_INTERVAL_MS`, `pullOneMatching`,
// `makeSubscribeStream`, and the `helperBuffer` Ref allocation in
// `connectTestClient`) deletes.

/**
 * Spec B (#596) r2 cleanup: per-client buffer for notifications that a
 * `subscribeTo(def)` pull drained from the underlying queue but did NOT
 * match the requested definition. The underlying test client exposes
 * `drainNotifications` as `Ref.getAndSet(queue, [])`, so a `Stream.filter`
 * over `client.notifications` (the old `subscribeTo` shape) DROPS
 * unmatched chunk elements forever — they vanish from the wire view of
 * any subsequent subscriber. By round-tripping unmatched frames through
 * `helperBuffer`, a concurrent `subscribeTo(A)` + `subscribeTo(B)` pair
 * cannot race-lose each other's frames: the loser of a `drainNotifications`
 * race finds its match in `helperBuffer` on the next poll.
 *
 * This buffer is per-client (owned by the `connectTestClient` closure)
 * and shared across every `subscribeTo` call made via this client.
 */
type NotificationBuffer = Ref.Ref<
  ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
>;

const SUBSCRIBE_POLL_INTERVAL_MS = 5;

/**
 * Pull at most one notification matching `definition`. Any frames that
 * arrived in the same `drainNotifications` chunk but did not match are
 * appended to `helperBuffer` so other (current or future) subscribers
 * see them. Returns `null` if nothing is available right now.
 */
function pullOneMatching<D extends AnyNotificationDefinition>(
  client: CloseableTestClient,
  helperBuffer: NotificationBuffer,
  definition: D,
): Effect.Effect<DecodedNotification<D> | null> {
  return Effect.gen(function* () {
    // 1. Check the helper buffer first — earlier pulls may have parked
    //    matching frames here when their own definition did not match.
    const fromBuffer = yield* Ref.modify(
      helperBuffer,
      (
        buf,
      ): readonly [
        DecodedNotification<D> | null,
        ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>,
      ] => {
        const idx = buf.findIndex((frame) =>
          isDecodedNotification(definition, frame),
        );
        if (idx < 0) return [null, buf];
        const matched = buf[idx] as DecodedNotification<D>;
        const rest = [...buf.slice(0, idx), ...buf.slice(idx + 1)];
        return [matched, rest];
      },
    );
    if (fromBuffer !== null) return fromBuffer;

    // 2. Drain the client queue and split it: keep the first match for
    //    this pull, park the rest in the helper buffer.
    const drained = yield* client.drainNotifications;
    if (drained.length === 0) return null;
    let matched: DecodedNotification<D> | null = null;
    const rest: DecodedNotification<AnyNotificationDefinition>[] = [];
    for (const frame of drained) {
      if (matched === null && isDecodedNotification(definition, frame)) {
        matched = frame;
      } else {
        rest.push(frame);
      }
    }
    if (rest.length > 0) {
      yield* Ref.update(helperBuffer, (buf) => [...buf, ...rest]);
    }
    return matched;
  });
}

function makeSubscribeStream<D extends AnyNotificationDefinition>(
  client: CloseableTestClient,
  helperBuffer: NotificationBuffer,
  definition: D,
): Stream.Stream<DecodedNotification<D>, TransportClosedError> {
  // Emit chunks of size 1 so that downstream consumers using
  // `Stream.runHead` (or `Stream.take(N)`) never silently drop sibling
  // elements bundled into the same chunk.
  return Stream.repeatEffectChunk(
    pullOneMatching(client, helperBuffer, definition).pipe(
      Effect.flatMap((maybe) =>
        maybe === null
          ? Effect.sleep(Duration.millis(SUBSCRIBE_POLL_INTERVAL_MS)).pipe(
              Effect.as(Chunk.empty<DecodedNotification<D>>()),
            )
          : Effect.succeed(Chunk.of(maybe)),
      ),
    ),
  );
}

export function connectTestClient(opts: {
  agentId: string;
  apiKey: string;
  wsUrl?: string;
  autoConnect?: boolean;
}): Effect.Effect<ServerTestClient, Error> {
  return Effect.gen(function* () {
    const client = yield* makeCloseableTestClient({
      serverUrl: opts.wsUrl ?? getWsUrl(),
      agentId: agentId(opts.agentId),
      agentKey: opts.apiKey,
      defaultTimeoutMs: 5000,
      captureCapacity: 1024,
      autoConnect: opts.autoConnect,
    });
    const helperBuffer: NotificationBuffer = yield* Ref.make<
      ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
    >([]);
    return {
      sendRpc: client.sendRpc.bind(client),
      sendMalformed: client.sendMalformed.bind(client),
      sendResponseFrame: client.sendResponseFrame.bind(client),
      subscribeTo: <D extends AnyNotificationDefinition>(definition: D) =>
        makeSubscribeStream(client, helperBuffer, definition),
      // ARCHITECT STUB (#645): forward the new Stream-shape surface from
      // the underlying TestClient. After impl-staff lands the cutover,
      // `subscribeTo` collapses into a direct `subscribe(def)` passthrough
      // and the `helperBuffer`/`makeSubscribeStream` block above deletes.
      subscribe: client.subscribe.bind(client),
      subscribeAll: client.subscribeAll.bind(client),
      onAppCallback: client.onAppCallback.bind(client),
      awaitServerRequest: client.awaitServerRequest.bind(client),
      notifications: client.notifications,
      captures: client.captures,
      snapshot: client.snapshot,
      close: () => client.close,
      drainNotifications: client.drainNotifications,
    };
  }).pipe(Effect.withSpan("connectTestClient"));
}

/** Register and connect an agent. Tracked for automatic cleanup. */
export function registerAndConnect(
  name: string,
): Effect.Effect<ConnectedAgent, Error> {
  return Effect.gen(function* () {
    const { agentId, apiKey } = yield* registerAgent(getBaseUrl(), name);
    const client = yield* connectTestClient({ agentId, apiKey });
    openClients.push(client);
    return { client, agentId, apiKey, name };
  }).pipe(Effect.withSpan("registerAndConnect"));
}

/**
 * POST `body` as JSON to `${baseUrl}${path}` and resolve with
 * `{status, json}`. The endpoints under test (`/api/v1/auth/register`,
 * `/api/v1/auth/claim`, `/api/v1/admin/register-agent`) all use this
 * same wire envelope, so each integration test importing this helper
 * can drop the repeated request/JSON boilerplate.
 */
export function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Effect.Effect<PostJsonResult, PostJsonError> {
  const url = `${baseUrl}${path}`;
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* executePostJson(
      client,
      postJsonRequest(url, body),
      path,
      url,
    );
    return yield* decodePostJsonResponse(response, path, url);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.withSpan("postJson"));
}

function postJsonRequest(url: string, body: Record<string, unknown>) {
  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.bodyUnsafeJson(body),
  );
}

function executePostJson(
  client: HttpClient.HttpClient,
  request: ReturnType<typeof postJsonRequest>,
  path: string,
  url: string,
): Effect.Effect<HttpResponse, PostJsonRequestError | PostJsonResponseError> {
  return client.execute(request).pipe(
    Effect.catchTags({
      RequestError: (cause) =>
        Effect.fail(
          new PostJsonRequestError({
            message: `POST ${path} request failed: ${cause.reason}`,
            method: POST_METHOD,
            path,
            reason: cause.reason,
            url,
            cause,
          }),
        ),
      ResponseError: (cause) =>
        Effect.fail(
          new PostJsonResponseError({
            message: `POST ${path} response failed: ${cause.reason}`,
            method: POST_METHOD,
            path,
            reason: cause.reason,
            status: cause.response.status,
            url,
            cause,
          }),
        ),
    }),
  );
}

function decodePostJsonResponse(
  response: HttpResponse,
  path: string,
  url: string,
): Effect.Effect<PostJsonResult, PostJsonDecodeError> {
  return response.json.pipe(
    Effect.map((json) => ({ status: response.status, json })),
    Effect.catchTag("ResponseError", (cause) =>
      Effect.fail(
        new PostJsonDecodeError({
          message: `POST ${path} response body failed to decode: ${cause.reason}`,
          method: POST_METHOD,
          path,
          reason: cause.reason,
          url,
          status: response.status,
          cause,
        }),
      ),
    ),
  );
}

/** Register an agent without connecting (for tests that need the raw client). */
export function registerOnly(name: string): Effect.Effect<
  {
    client: ServerTestClient;
    agentId: string;
    apiKey: string;
    claimToken: string | undefined;
  },
  Error
> {
  return Effect.gen(function* () {
    const reg = yield* registerAgent(getBaseUrl(), name);
    const client = yield* connectTestClient({
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      autoConnect: false,
    });
    openClients.push(client);
    return {
      client,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      claimToken: reg.claimToken,
    };
  }).pipe(Effect.withSpan("registerOnly"));
}

/** Create two agents, both connected. No contacts needed (core has open access). */
export function setupAgentPair(): Effect.Effect<
  { alice: ConnectedAgent; bob: ConnectedAgent },
  Error
> {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice");
    const bob = yield* registerAndConnect("bob");
    return { alice, bob };
  }).pipe(Effect.withSpan("setupAgentPair"));
}

/** Create N agents, all connected. Optionally create a group conversation. */
export function setupAgentGroup(
  count: number,
  opts?: { groupName?: string },
): Effect.Effect<{ agents: ConnectedAgent[]; conversationId?: string }, Error> {
  return Effect.gen(function* () {
    if (count < MIN_AGENT_GROUP_SIZE) {
      return yield* Effect.fail(
        new AgentGroupSizeError({
          message: `Agent group requires at least ${MIN_AGENT_GROUP_SIZE} agents`,
          minimumAgents: MIN_AGENT_GROUP_SIZE,
          requestedAgents: count,
        }),
      );
    }

    const agents: ConnectedAgent[] = [];
    for (let i = 0; i < count; i++) {
      agents.push(yield* registerAndConnect(`agent-${i}`));
    }

    let conversationId: string | undefined;
    if (opts?.groupName) {
      const creator = agents[0]!;
      const others = agents.slice(1).map((a) => ({
        type: "agent" as const,
        id: a.agentId,
      }));
      const conv = (yield* creator.client.sendRpc(ConversationsCreate, {
        type: "group",
        name: opts.groupName,
        participants: others,
      })) as { conversation: { id: string } };
      conversationId = conv.conversation.id;
    }

    return { agents, conversationId };
  }).pipe(Effect.withSpan("setupAgentGroup"));
}
