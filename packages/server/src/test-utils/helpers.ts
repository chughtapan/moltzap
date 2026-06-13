import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { Data, Duration, Effect, Either, Option, Stream } from "effect";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type { NotificationDelivery } from "@moltzap/protocol/rpc";
import {
  makeTestAgentClient,
  makeTestAppClient,
  mintTestAppCredential,
  registerTestAgent,
  type TestAgent,
  type TestAgentClient,
  type TestAppClient,
} from "@moltzap/protocol/testing";
import { DEFAULT_TEST_ADMIN_USER_ID, getCoreDb, getWsUrl } from "./server.js";
import { AuthService } from "#identity/agents";

import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AgentKey, AppKey } from "@moltzap/protocol/identity";
import type { AgentId } from "@moltzap/protocol/identity";
import type { UserId } from "@moltzap/protocol/identity";
import type { AppManifest } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AppId, TaskId } from "@moltzap/protocol/task";

/** Default ceiling for `awaitOneNotification`. */
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
 * Stream-based one-shot waiter. Consumes `client.subscribe(def)` via
 * `Stream.runHead`, failing with `AwaitNotificationTimeoutError` on timeout
 * and `AwaitNotificationClosedError` when the transport closed before a
 * matching frame arrived. Distinguishing close from timeout keeps a dead
 * connection from masquerading as a missing notification.
 */
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  client: Pick<TestAgentClient, "subscribe">,
  definition: D,
  timeoutMs: number = DEFAULT_AWAIT_NOTIFICATION_TIMEOUT_MS,
): Effect.Effect<NotificationDelivery<D>, AwaitNotificationError> {
  const closed = () =>
    new AwaitNotificationClosedError({
      definition: definition.name,
    });
  return client.subscribe(definition).pipe(
    Stream.map(
      (params): NotificationDelivery<D> => ({
        definition,
        method: definition.name,
        params,
      }),
    ),
    Stream.runHead,
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: () => Effect.fail(closed()),
        onRight: Option.match({
          onNone: () => Effect.fail(closed()),
          onSome: (notification) => Effect.succeed(notification),
        }),
      }),
    ),
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new AwaitNotificationTimeoutError({
          definition: definition.name,
          durationMs: timeoutMs,
        }),
    }),
  );
}

export interface ConnectedAgent {
  client: TestAgentClient;
  agentId: AgentId;
  apiKey: AgentKey;
  name: string;
}

const openClients: Array<{ close(): Effect.Effect<void, never> }> = [];
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

export function trackClient(client: TestAgentClient | TestAppClient): void {
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

interface CreateTestAgentOptions {
  readonly description?: string;
  readonly ownerUserId?: UserId;
}

export function createTestAgent(
  name: string,
  opts?: CreateTestAgentOptions,
): Effect.Effect<TestAgent, never> {
  return Effect.gen(function* () {
    const authService = new AuthService(getCoreDb());
    const params =
      opts?.description === undefined
        ? { name }
        : { name, description: opts.description };
    const registered = yield* authService.registerAgent(
      params,
      opts?.ownerUserId ?? DEFAULT_TEST_ADMIN_USER_ID,
    );

    return {
      agentId: registered.agentId,
      apiKey: registered.apiKey,
      name,
    };
  }).pipe(Effect.withSpan("createTestAgent"));
}

export function connectTestClient(opts: {
  agentId: AgentId;
  apiKey: AgentKey;
  wsUrl?: string;
}): Effect.Effect<TestAgentClient, Error> {
  return Effect.gen(function* () {
    return yield* makeTestAgentClient(opts.agentId, {
      serverUrl: testClientServerUrl(opts.wsUrl ?? getWsUrl()),
      agentKey: opts.apiKey,
    }).pipe(Effect.mapError(toError));
  }).pipe(Effect.withSpan("connectTestClient"));
}

function testClientServerUrl(wsUrl: string): string {
  return wsUrl.replace(/\/ws$/, "").replace(/^ws:/, "http:");
}

class AppRegistrationError extends Data.TaggedError("AppRegistrationError")<{
  readonly message: string;
  readonly status: number;
  readonly json: unknown;
}> {}

function appRegistrationError(error: {
  readonly status: number;
  readonly body: string;
}) {
  return new AppRegistrationError({
    message: `app registration failed: ${error.status}`,
    status: error.status,
    json: error.body,
  });
}

export function registerApp(
  baseUrl: string,
  manifest: AppManifest,
  inviteCode?: string,
): Effect.Effect<
  { readonly appId: AppId; readonly appKey: AppKey },
  AppRegistrationError
> {
  const credential = mintTestAppCredential(
    inviteCode === undefined
      ? { baseUrl, manifest }
      : { baseUrl, manifest, inviteCode },
  );
  return credential.pipe(
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (error) => Effect.fail(appRegistrationError(error)),
        onRight: Effect.succeed,
      }),
    ),
    Effect.withSpan("registerApp"),
  );
}

export function connectAppClient(
  appId: AppId,
  appKey: AppKey,
  handlers: AppCallbackHandlers<AppCallbackContext>,
): Effect.Effect<TestAppClient, Error> {
  return Effect.gen(function* () {
    const client = yield* makeTestAppClient(appId, {
      serverUrl: testClientServerUrl(getWsUrl()),
      appKey,
      handlers,
    }).pipe(Effect.mapError(toError));
    openClients.push(client);
    return client;
  }).pipe(Effect.withSpan("connectAppClient"));
}

/** Register and connect an agent. Tracked for automatic cleanup. */
export function registerAndConnect(
  name: string,
): Effect.Effect<ConnectedAgent, Error> {
  return Effect.gen(function* () {
    const { agentId, apiKey } = yield* createTestAgent(name);
    const client = yield* connectTestClient({ agentId, apiKey });
    openClients.push(client);
    return { client, agentId, apiKey, name };
  }).pipe(Effect.withSpan("registerAndConnect"));
}

/**
 * POST `body` as JSON to `${baseUrl}${path}` and resolve with
 * `{status, json}`. HTTP integration tests import this helper to avoid
 * repeated request/JSON boilerplate.
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

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
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
