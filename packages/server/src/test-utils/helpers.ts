/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types like `ReadonlyArray<...>` use natural angle-bracket form inside backtick spans; matches filter-equivalence.test.ts precedent. */
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import {
  Chunk,
  Data,
  Duration,
  Effect,
  Fiber,
  Option,
  Ref,
  Stream,
} from "effect";
import type {
  AnyNotificationDefinition,
  DecodedNotification,
} from "@moltzap/protocol";
import {
  agentId,
  appId as protocolAppId,
  makeCloseableTestClient,
  registerTestAgent,
  TransportClosedError,
  type CloseableTestClient,
  type TestAgent,
} from "@moltzap/protocol/testing";
import { getBaseUrl, getWsUrl } from "./index.js";

import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol";
import type { AppManifest } from "@moltzap/protocol/app";
import type { AgentId as ProtocolAgentId } from "@moltzap/protocol/identity";
import type { AppId, ConversationId, TaskId } from "@moltzap/protocol/task";

/**
 * Spec B (#596) + #645: the legacy `waitForNotification(def, timeoutMs?)`,
 * `drainNotifications(): ReadonlyArray<...>`, and `notifications` Stream
 * wrappers were deleted. Consumers reach typed-payload Streams via
 * `client.subscribeTo(def)` (a one-line passthrough to
 * `TestClient.subscribe(def)`) or the broad-union `client.subscribeAll()`.
 * Ergonomic one-shot test sites use the top-level `awaitOneNotification`
 * helper below.
 */
export interface ServerTestClient extends Omit<CloseableTestClient, "close"> {
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
  agentId: ProtocolAgentId;
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

/**
 * Per-client broad-union pump (#645): integration tests follow the
 * `send → awaitOneNotification` pattern that the deleted polling
 * `drainNotifications` shape implicitly supported via a historical
 * notification queue. The new `Stream.async`-backed `subscribe` only
 * emits frames that arrive AFTER materialisation, so a sequential
 * `send → subscribe → runHead` races the response frame.
 *
 * Solution: install a long-lived broad-union pump at handle creation
 * that appends every inbound notification to a `Ref<Array<...>>`
 * snapshot. `subscribeTo<D>(def)` (and consumers like
 * `awaitOneNotification`) build a Stream that polls the snapshot,
 * emits the first matching frame, and removes it from the snapshot —
 * mirroring the legacy semantic without resurrecting the
 * per-definition dedup ring inside the protocol-side `TestClient`.
 */
const PUMP_POLL_INTERVAL_MS = 5;

interface NotificationBuffer {
  readonly snapshot: Ref.Ref<
    ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
  >;
  readonly pumpFiber: Fiber.RuntimeFiber<void, never>;
}

function makeNotificationBuffer(
  client: CloseableTestClient,
): Effect.Effect<NotificationBuffer> {
  return Effect.gen(function* () {
    const snapshot = yield* Ref.make<
      ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
    >([]);
    const pumpEffect = client.subscribeAll().pipe(
      Stream.runForEach((frame) =>
        Ref.update(snapshot, (xs) => [...xs, frame]),
      ),
      Effect.catchAll(() => Effect.void),
    );
    const pumpFiber = yield* Effect.fork(pumpEffect);
    return { snapshot, pumpFiber };
  });
}

function pullMatchingFromBuffer<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
): Effect.Effect<DecodedNotification<D> | null> {
  return Ref.modify(buffer.snapshot, (frames) => {
    const idx = frames.findIndex((frame) => frame.definition === definition);
    if (idx < 0) return [null, frames];
    const matched = frames[idx] as DecodedNotification<D>;
    const rest = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
    return [matched, rest];
  });
}

function bufferedSubscribeStream<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
): Stream.Stream<DecodedNotification<D>, TransportClosedError> {
  // Poll the broad-union buffer; emit each matching frame as a
  // singleton chunk so `Stream.runHead`/`Stream.take(N)` callers never
  // silently drop sibling chunk elements. Empty chunks on cache miss
  // back off the poll without terminating the stream.
  return Stream.repeatEffectChunk(
    pullMatchingFromBuffer(buffer, definition).pipe(
      Effect.flatMap((maybe) =>
        maybe === null
          ? Effect.sleep(Duration.millis(PUMP_POLL_INTERVAL_MS)).pipe(
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
    const buffer = yield* makeNotificationBuffer(client);
    const close: Effect.Effect<void, never> = Effect.gen(function* () {
      yield* Fiber.interrupt(buffer.pumpFiber);
      yield* client.close;
    });
    return {
      sendRpc: client.sendRpc.bind(client),
      sendMalformed: client.sendMalformed.bind(client),
      sendResponseFrame: client.sendResponseFrame.bind(client),
      // #645: `subscribeTo<D>(def)` reads from the per-client
      // broad-union buffer maintained by the pump above so existing
      // `send → awaitOneNotification` test sites observe frames that
      // arrived between the RPC return and the subscription pull —
      // mirroring the legacy polling semantic without resurrecting the
      // deleted per-definition dedup ring.
      subscribeTo: <D extends AnyNotificationDefinition>(definition: D) =>
        bufferedSubscribeStream(buffer, definition),
      subscribe: client.subscribe.bind(client),
      subscribeAll: client.subscribeAll.bind(client),
      onAppCallback: client.onAppCallback.bind(client),
      awaitServerRequest: client.awaitServerRequest.bind(client),
      captures: client.captures,
      snapshot: client.snapshot,
      close: () => close,
    };
  }).pipe(Effect.withSpan("connectTestClient"));
}

const HTTP_CREATED = 201;

export interface RegisteredApp {
  readonly appId: AppId;
  readonly appKey: string;
  readonly manifest: AppManifest;
}

class AppRegistrationError extends Data.TaggedError("AppRegistrationError")<{
  readonly message: string;
  readonly status: number;
  readonly json: unknown;
}> {}

function isAppRegisterResponse(
  json: unknown,
): json is { readonly appId: string; readonly appKey: string } {
  if (typeof json !== "object" || json === null) return false;
  if (!("appId" in json) || typeof json.appId !== "string") return false;
  if (!("appKey" in json) || typeof json.appKey !== "string") return false;
  return true;
}

/**
 * D #705 CP9 — mint an app credential via the `/api/v1/apps/register` HTTP
 * endpoint. The App-principal sibling of {@link registerAgent}: returns the
 * server-minted `{ appId, appKey }` (the `appId` is `gen_random_uuid()`, NOT
 * `manifest.appId`). The `appKey` is then handed to {@link connectAppClient}
 * to open an `AppConnection`, whose implicit registration binds it as the
 * app's moderator endpoint. Replaces the cross-principal WS `apps/register`
 * RPC.
 *
 * `inviteCode` is required when the server boots with a `registrationSecret`
 * (the HTTP route gates app registration behind the same secret as agent
 * registration); omit it for the default open-registration server.
 */
export function registerApp(
  baseUrl: string,
  manifest: AppManifest,
  inviteCode?: string,
): Effect.Effect<RegisteredApp, PostJsonError | AppRegistrationError> {
  const body =
    inviteCode === undefined ? { manifest } : { manifest, inviteCode };
  return postJson(baseUrl, "/api/v1/apps/register", body).pipe(
    Effect.flatMap(({ status, json }) => {
      if (status !== HTTP_CREATED || !isAppRegisterResponse(json)) {
        return Effect.fail(
          new AppRegistrationError({
            message: `apps/register failed: ${status}`,
            status,
            json,
          }),
        );
      }
      return Effect.succeed({
        appId: protocolAppId(json.appId),
        appKey: json.appKey,
        manifest,
      } satisfies RegisteredApp);
    }),
    Effect.withSpan("registerApp"),
  );
}

/**
 * D #705 CP9 — open an `AppConnection` from a minted `appKey`. The Connect
 * handler's `appKey` arm authenticates the app principal AND implicitly
 * registers the live connection as the app's moderator endpoint, so the
 * returned client receives server→client `dispatch/authorize` /
 * `messages/authorize` / `task/create` callbacks. Tracked for cleanup.
 */
export function connectAppClient(
  appKey: string,
): Effect.Effect<ServerTestClient, Error> {
  return Effect.gen(function* () {
    const client = yield* makeCloseableTestClient({
      serverUrl: getWsUrl(),
      // The agent-arm fields are unused on the appKey arm but the config
      // shape requires `agentId` + `agentKey`; the autoConnect dispatcher
      // selects the appKey arm when `appKey` is present.
      agentId: agentId(crypto.randomUUID()),
      agentKey: "unused-app-arm",
      appKey,
      defaultTimeoutMs: 5000,
      captureCapacity: 1024,
    });
    const buffer = yield* makeNotificationBuffer(client);
    const close: Effect.Effect<void, never> = Effect.gen(function* () {
      yield* Fiber.interrupt(buffer.pumpFiber);
      yield* client.close;
    });
    const wrapped: ServerTestClient = {
      sendRpc: client.sendRpc.bind(client),
      sendMalformed: client.sendMalformed.bind(client),
      sendResponseFrame: client.sendResponseFrame.bind(client),
      subscribeTo: <D extends AnyNotificationDefinition>(definition: D) =>
        bufferedSubscribeStream(buffer, definition),
      subscribe: client.subscribe.bind(client),
      subscribeAll: client.subscribeAll.bind(client),
      onAppCallback: client.onAppCallback.bind(client),
      awaitServerRequest: client.awaitServerRequest.bind(client),
      captures: client.captures,
      snapshot: client.snapshot,
      close: () => close,
    };
    openClients.push(wrapped);
    return wrapped;
  }).pipe(Effect.withSpan("connectAppClient"));
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
): Effect.Effect<
  {
    agents: ConnectedAgent[];
    conversationId?: ConversationId;
    taskId?: TaskId;
  },
  Error
> {
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

    let conversationId: ConversationId | undefined;
    let taskId: TaskId | undefined;
    if (opts?.groupName) {
      const creator = agents[0]!;
      const otherAgentIds = agents.slice(1).map((a) => a.agentId);
      const created = yield* creator.client.sendRpc(TaskRequest, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: otherAgentIds,
        initialConversation: {
          name: opts.groupName,
          participants: otherAgentIds,
        },
      });
      taskId = created.task.id;
      conversationId = created.conversation?.id;
    }

    return { agents, conversationId, taskId };
  }).pipe(Effect.withSpan("setupAgentGroup"));
}
