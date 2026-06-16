/**
 * Lifecycle-backed conformance clients.
 *
 * The conformance suite talks through the production
 * `MoltZapAgentClient` / `MoltZapAppClient` lifecycles. Agent and app
 * principals are separate surfaces so the type checker rejects
 * principal-incompatible RPCs at the call site.
 */
import {
  Data,
  Deferred,
  Duration,
  Effect,
  HashMap,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";
import type {
  AnyAgentCallableRpcDefinition,
  AnyAppCallableRpcDefinition,
  AnyAppCallbackRpcDefinition,
  AnyNotificationDefinition,
} from "#socket/catalog";
import { MessagesAuthorize } from "#message";
import { TaskCreate } from "#task";
import { DispatchAuthorize } from "#message/dispatch";
import { MoltZapAgentClient } from "#socket";
import { MoltZapAppClient, type AppCallbackContext } from "#socket";
import type { AppCallbackHandlers } from "#socket";
import type { ClientDefinitionPayload, ClientDefinitionSuccess } from "#socket";
import type { CloseInfo } from "#socket";
import {
  NotConnectedError,
  type NotificationDelivery,
  type ParamsOf,
  type ResultOf,
} from "#transport";
import { AgentKey, AppKey } from "#identity";
import { RpcTimeoutError as ProtocolRpcTimeoutError } from "#transport";
import {
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "../errors.js";

const CLOSE_CODE_ABNORMAL = 1006;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 5_000;
const SYNTHETIC_REQUEST_ID = "effect-rpc";

export interface AgentTestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly defaultTimeoutMs: number;
  readonly autoConnect?: boolean;
}

export interface AppTestClientConfig {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly defaultTimeoutMs: number;
  readonly autoConnect?: boolean;
}

type SendRpcError =
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError;

export interface NotificationClient {
  readonly subscribe: <D extends AnyNotificationDefinition>(
    definition: D,
  ) => Stream.Stream<NotificationDelivery<D>, TransportClosedError>;

  readonly subscribeAll: (
    refinement?: (
      notification: NotificationDelivery<AnyNotificationDefinition>,
    ) => boolean,
  ) => Stream.Stream<
    NotificationDelivery<AnyNotificationDefinition>,
    TransportClosedError
  >;
}

export interface AgentTestClient extends NotificationClient {
  readonly sendRpc: <D extends AnyAgentCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<ClientDefinitionSuccess<D>, SendRpcError>;
}

export interface AppTestClient extends NotificationClient {
  readonly sendRpc: <D extends AnyAppCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<ClientDefinitionSuccess<D>, SendRpcError>;

  readonly onAppCallback: <D extends ServerRpcDefinition>(
    definition: D,
    handler: (
      params: ServerRpcParams<D>,
      ctx: ServerRpcContext,
    ) => Effect.Effect<ServerRpcResult<D>, RpcResponseError>,
  ) => Effect.Effect<void>;

  readonly awaitServerRequest: <D extends ServerRpcDefinition>(
    definition: D,
    predicate?: (params: ServerRpcParams<D>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError>;
}

export interface CloseableAgentTestClient extends AgentTestClient {
  readonly close: Effect.Effect<void, never>;
}

export interface CloseableAppTestClient extends AppTestClient {
  readonly close: Effect.Effect<void, never>;
}

export class ServerRequestWaitError extends Data.TaggedError(
  "TestingServerRequestWaitError",
)<{
  readonly message: string;
  readonly definition: ServerRpcDefinition;
  readonly reason: "timeout";
}> {}

export type ServerRpcDefinition = AnyAppCallbackRpcDefinition;
export type ServerRpcParams<D extends ServerRpcDefinition> = ParamsOf<D>;
export type ServerRpcResult<D extends ServerRpcDefinition> = ResultOf<D>;

export interface ServerRpcContext {
  readonly requestId: string;
  readonly definition: ServerRpcDefinition;
}

type CallbackHandler = (
  params: unknown,
  ctx: ServerRpcContext,
) => Effect.Effect<unknown, RpcResponseError>;

type CallbackHandlers = HashMap.HashMap<ServerRpcDefinition, CallbackHandler>;

interface AwaitEntry {
  readonly predicate?: (params: unknown) => boolean;
  readonly deferred: Deferred.Deferred<unknown, ServerRequestWaitError>;
}

type Awaiters = HashMap.HashMap<ServerRpcDefinition, ReadonlyArray<AwaitEntry>>;

export function makeAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<AgentTestClient, SendRpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const client = yield* openAgentTestClient(config);
    yield* Effect.addFinalizer(() => client.close);
    return client;
  }).pipe(Effect.withSpan("makeAgentTestClient"));
}

export function makeCloseableAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<CloseableAgentTestClient, SendRpcError> {
  return openAgentTestClient(config).pipe(
    Effect.withSpan("makeCloseableAgentTestClient"),
  );
}

export function makeAppTestClient(
  config: AppTestClientConfig,
): Effect.Effect<AppTestClient, SendRpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const client = yield* openAppTestClient(config);
    yield* Effect.addFinalizer(() => client.close);
    return client;
  }).pipe(Effect.withSpan("makeAppTestClient"));
}

export function makeCloseableAppTestClient(
  config: AppTestClientConfig,
): Effect.Effect<CloseableAppTestClient, SendRpcError> {
  return openAppTestClient(config).pipe(
    Effect.withSpan("makeCloseableAppTestClient"),
  );
}

function openAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<CloseableAgentTestClient, SendRpcError> {
  return Effect.gen(function* () {
    const lifecycle = new MoltZapAgentClient({
      serverUrl: clientBaseUrl(config.serverUrl),
      agentKey: config.agentKey,
    });
    if (config.autoConnect !== false) {
      yield* lifecycle
        .connect()
        .pipe(Effect.mapError((error) => normalizeRpcError("connect", error)));
    }
    return {
      ...notificationSurface(lifecycle),
      sendRpc: (definition, params, opts) =>
        lifecycle
          .callDefinition(
            definition,
            params,
            rpcCallOptions(config.defaultTimeoutMs, opts),
          )
          .pipe(
            Effect.mapError((error) =>
              normalizeRpcError(definition.name, error),
            ),
          ),
      close: Effect.suspend(() => lifecycle.close()),
    } satisfies CloseableAgentTestClient;
  });
}

function openAppTestClient(
  config: AppTestClientConfig,
): Effect.Effect<CloseableAppTestClient, SendRpcError> {
  return Effect.gen(function* () {
    const handlersRef = yield* Ref.make<CallbackHandlers>(
      HashMap.empty<ServerRpcDefinition, CallbackHandler>(),
    );
    const awaitersRef = yield* Ref.make<Awaiters>(
      HashMap.empty<ServerRpcDefinition, ReadonlyArray<AwaitEntry>>(),
    );
    const lifecycle = new MoltZapAppClient({
      serverUrl: clientBaseUrl(config.serverUrl),
      appKey: config.appKey,
      handlers: makeDynamicAppHandlers(handlersRef, awaitersRef),
    });
    if (config.autoConnect !== false) {
      yield* lifecycle
        .connect()
        .pipe(Effect.mapError((error) => normalizeRpcError("connect", error)));
    }
    return {
      ...notificationSurface(lifecycle),
      sendRpc: (definition, params, opts) =>
        lifecycle
          .callDefinition(
            definition,
            params,
            rpcCallOptions(config.defaultTimeoutMs, opts),
          )
          .pipe(
            Effect.mapError((error) =>
              normalizeRpcError(definition.name, error),
            ),
          ),
      onAppCallback: (definition, handler) =>
        Ref.update(handlersRef, (handlers) =>
          HashMap.set(handlers, definition, handler as CallbackHandler),
        ),
      awaitServerRequest: (definition, predicate, timeoutMs) =>
        awaitServerRequest(awaitersRef, definition, predicate, timeoutMs),
      close: Effect.suspend(() => lifecycle.close()),
    } satisfies CloseableAppTestClient;
  });
}

function notificationSurface(
  lifecycle: MoltZapAgentClient | MoltZapAppClient,
): NotificationClient {
  return {
    subscribe: <D extends AnyNotificationDefinition>(
      definition: D,
    ): Stream.Stream<NotificationDelivery<D>, TransportClosedError> => {
      return lifecycle.subscribe(definition).pipe(
        Stream.map((params) => ({
          definition,
          method: definition.name,
          params,
        })),
        Stream.mapError(closeErrorFromUnknown),
      );
    },
    subscribeAll: (refinement) =>
      lifecycle
        .subscribeAll(
          refinement === undefined
            ? undefined
            : (definition, params) =>
                refinement({
                  definition,
                  method: definition.name,
                  params,
                }),
        )
        .pipe(Stream.mapError(closeErrorFromUnknown)),
  };
}

function rpcCallOptions(
  defaultTimeoutMs: number,
  opts?: { readonly timeoutMs?: number },
): { readonly timeoutMs: number } {
  if (opts !== undefined && opts.timeoutMs !== undefined) {
    return { timeoutMs: opts.timeoutMs };
  }
  return { timeoutMs: defaultTimeoutMs };
}

function clientBaseUrl(url: string): string {
  return url.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
}

function makeDynamicAppHandlers(
  handlersRef: Ref.Ref<CallbackHandlers>,
  awaitersRef: Ref.Ref<Awaiters>,
): AppCallbackHandlers<AppCallbackContext> {
  return {
    [DispatchAuthorize.name]: {
      definition: DispatchAuthorize,
      handle: (params: ParamsOf<typeof DispatchAuthorize>) =>
        runAppCallback(handlersRef, awaitersRef, DispatchAuthorize, params),
    },
    [MessagesAuthorize.name]: {
      definition: MessagesAuthorize,
      handle: (params: ParamsOf<typeof MessagesAuthorize>) =>
        runAppCallback(handlersRef, awaitersRef, MessagesAuthorize, params),
    },
    [TaskCreate.name]: {
      definition: TaskCreate,
      handle: (params: ParamsOf<typeof TaskCreate>) =>
        runAppCallback(handlersRef, awaitersRef, TaskCreate, params),
    },
  };
}

function runAppCallback<D extends ServerRpcDefinition>(
  handlersRef: Ref.Ref<CallbackHandlers>,
  awaitersRef: Ref.Ref<Awaiters>,
  definition: D,
  params: ServerRpcParams<D>,
): Effect.Effect<ServerRpcResult<D>, unknown> {
  return Effect.gen(function* () {
    yield* notifyAwaiter(awaitersRef, definition, params);
    const handlers = yield* Ref.get(handlersRef);
    const handler = Option.getOrUndefined(HashMap.get(handlers, definition));
    if (handler === undefined) return yield* Effect.never;
    return (yield* handler(params, {
      requestId: SYNTHETIC_REQUEST_ID,
      definition,
    })) as ServerRpcResult<D>;
  });
}

function awaitServerRequest<D extends ServerRpcDefinition>(
  awaitersRef: Ref.Ref<Awaiters>,
  definition: D,
  predicate?: (params: ServerRpcParams<D>) => boolean,
  timeoutMs = DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
): Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError> {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<unknown, ServerRequestWaitError>();
    const entry: AwaitEntry =
      predicate === undefined
        ? { deferred }
        : {
            deferred,
            predicate: (params) => predicate(params as ServerRpcParams<D>),
          };
    yield* Ref.update(awaitersRef, (awaiters) =>
      appendAwaiter(awaiters, definition, entry),
    );
    const result = yield* Deferred.await(deferred).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () =>
          new ServerRequestWaitError({
            message: `Timeout waiting for server-initiated request ${definition.name}`,
            definition,
            reason: "timeout",
          }),
      }),
      Effect.ensuring(
        Ref.update(awaitersRef, (awaiters) =>
          removeAwaiter(awaiters, definition, entry),
        ),
      ),
    );
    return result as ServerRpcParams<D>;
  });
}

function appendAwaiter(
  awaiters: Awaiters,
  definition: ServerRpcDefinition,
  entry: AwaitEntry,
): Awaiters {
  const existing = Option.getOrUndefined(HashMap.get(awaiters, definition));
  return HashMap.set(awaiters, definition, [...(existing ?? []), entry]);
}

function removeAwaiter(
  awaiters: Awaiters,
  definition: ServerRpcDefinition,
  entry: AwaitEntry,
): Awaiters {
  const existing = Option.getOrUndefined(HashMap.get(awaiters, definition));
  if (existing === undefined) return awaiters;
  const next = existing.filter((candidate) => candidate !== entry);
  return next.length === 0
    ? HashMap.remove(awaiters, definition)
    : HashMap.set(awaiters, definition, next);
}

function notifyAwaiter(
  awaitersRef: Ref.Ref<Awaiters>,
  definition: ServerRpcDefinition,
  params: unknown,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const matched = yield* Ref.modify(awaitersRef, (awaiters) =>
      takeMatchingAwaiter(awaiters, definition, params),
    );
    if (matched !== undefined) {
      yield* Deferred.succeed(matched.deferred, params).pipe(Effect.ignore);
    }
  });
}

function takeMatchingAwaiter(
  awaiters: Awaiters,
  definition: ServerRpcDefinition,
  params: unknown,
): readonly [AwaitEntry | undefined, Awaiters] {
  const existing = Option.getOrUndefined(HashMap.get(awaiters, definition));
  if (existing === undefined) return [undefined, awaiters];
  const index = existing.findIndex(
    (entry) => entry.predicate === undefined || entry.predicate(params),
  );
  if (index < 0) return [undefined, awaiters];
  const entry = existing[index]!;
  const next = [...existing.slice(0, index), ...existing.slice(index + 1)];
  return [
    entry,
    next.length === 0
      ? HashMap.remove(awaiters, definition)
      : HashMap.set(awaiters, definition, next),
  ];
}

function normalizeRpcError(method: string, error: unknown): SendRpcError {
  if (error instanceof ProtocolRpcTimeoutError) {
    return new RpcTimeoutError({
      method,
      requestId: SYNTHETIC_REQUEST_ID,
      timeoutMs: error.timeoutMs,
    });
  }
  if (error instanceof NotConnectedError) {
    return closeErrorFromUnknown(error);
  }
  const tagged = taggedError(error);
  if (tagged !== null) {
    return new RpcResponseError({
      method,
      requestId: SYNTHETIC_REQUEST_ID,
      tag: tagged._tag,
      message: typeof tagged.message === "string" ? tagged.message : "",
      data: tagged.data,
    });
  }
  return new TransportIoError({ direction: "inbound", cause: error });
}

function closeErrorFromUnknown(error: unknown): TransportClosedError {
  const close = error as Partial<CloseInfo> & { readonly message?: unknown };
  return new TransportClosedError({
    direction: "inbound",
    code: typeof close.code === "number" ? close.code : CLOSE_CODE_ABNORMAL,
    reason: closeReason(error, close),
  });
}

function closeReason(
  error: unknown,
  close: Partial<CloseInfo> & { readonly message?: unknown },
): string {
  if (typeof close.reason === "string") return close.reason;
  if (typeof close.message === "string") return close.message;
  return String(error);
}

function taggedError(value: unknown): {
  readonly _tag: string;
  readonly message?: unknown;
  readonly data?: unknown;
} | null {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly _tag?: unknown })._tag === "string"
    ? (value as {
        readonly _tag: string;
        readonly message?: unknown;
        readonly data?: unknown;
      })
    : null;
}
