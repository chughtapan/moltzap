/**
 * Lifecycle-backed conformance clients.
 *
 * The conformance suite talks through the production
 * `MoltZapAgentClient` lifecycle so property runs exercise the same
 * socket machinery real agents use.
 */
import { Effect, type Scope, Stream } from "effect";
import type {
  AnyAgentCallableRpcDefinition,
  AnyNotificationDefinition,
} from "#socket/catalog";
import {
  MoltZapAgentClient,
  type ClientDefinitionPayload,
  type ClientDefinitionSuccess,
  type CloseInfo,
} from "#socket";
import { httpBaseUrl, serverBaseUrl } from "#network";
import {
  NotConnectedError,
  RpcTimeoutError as ProtocolRpcTimeoutError,
  type NotificationDelivery,
} from "#transport";
import type { AgentKey } from "#identity";
import {
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "../errors.js";

const CLOSE_CODE_ABNORMAL = 1006;
const SYNTHETIC_REQUEST_ID = "effect-rpc";

/** Describes agent test client config. */
export interface AgentTestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly defaultTimeoutMs: number;
  readonly autoConnect?: boolean;
}

type SendRpcError =
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError;

/** Describes notification client. */
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

/** Describes agent test client. */
export interface AgentTestClient extends NotificationClient {
  readonly sendRpc: <D extends AnyAgentCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<ClientDefinitionSuccess<D>, SendRpcError>;
}

/** Describes closeable agent test client. */
export interface CloseableAgentTestClient extends AgentTestClient {
  readonly close: Effect.Effect<void>;
}

/**
 * Creates agent test client.
 * @param config Documentation generation configuration.
 * @returns The created agent test client.
 */
export function makeAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<AgentTestClient, SendRpcError, Scope.Scope> {
  return Effect.gen(function* () {
    const client = yield* openAgentTestClient(config);
    yield* Effect.addFinalizer(() => client.close);
    return client;
  }).pipe(Effect.withSpan("makeAgentTestClient"));
}

/**
 * Creates closeable agent test client.
 * @param config Documentation generation configuration.
 * @returns The created closeable agent test client.
 */
export function makeCloseableAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<CloseableAgentTestClient, SendRpcError> {
  return openAgentTestClient(config).pipe(
    Effect.withSpan("makeCloseableAgentTestClient"),
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

function notificationSurface(
  lifecycle: MoltZapAgentClient,
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
  return { timeoutMs: opts?.timeoutMs ?? defaultTimeoutMs };
}

// Conformance fixtures hand out the server's socket endpoint; the client
// takes the base and dials the route itself.
function clientBaseUrl(url: string): string {
  return httpBaseUrl(serverBaseUrl(url));
}

function normalizeRpcError(method: string, error: unknown): SendRpcError {
  let normalized: SendRpcError;
  if (error instanceof ProtocolRpcTimeoutError) {
    normalized = new RpcTimeoutError({
      method,
      requestId: SYNTHETIC_REQUEST_ID,
      timeoutMs: error.timeoutMs,
    });
  } else if (error instanceof NotConnectedError) {
    normalized = closeErrorFromUnknown(error);
  } else {
    const tagged = taggedError(error);
    normalized =
      tagged === null
        ? new TransportIoError({ direction: "inbound", cause: error })
        : new RpcResponseError({
            method,
            requestId: SYNTHETIC_REQUEST_ID,
            tag: tagged._tag,
            message: typeof tagged.message === "string" ? tagged.message : "",
            data: tagged.data,
          });
  }
  return normalized;
}

function closeErrorFromUnknown(error: unknown): TransportClosedError {
  const rawCode = readUnknownProperty(error, "code");
  const rawReason = readUnknownProperty(error, "reason");
  const close: Partial<CloseInfo> & { readonly message?: unknown } = {
    code: typeof rawCode === "number" ? rawCode : undefined,
    reason: typeof rawReason === "string" ? rawReason : undefined,
    message: readUnknownProperty(error, "message"),
  };
  return new TransportClosedError({
    direction: "inbound",
    code: typeof close.code === "number" ? close.code : CLOSE_CODE_ABNORMAL,
    reason: closeReason(error, close),
  });
}

function readUnknownProperty(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function closeReason(
  error: unknown,
  close: Partial<CloseInfo> & { readonly message?: unknown },
): string {
  if (typeof close.reason === "string") {
    return close.reason;
  }
  if (typeof close.message === "string") {
    return close.message;
  }
  return String(error);
}

function taggedError(value: unknown): {
  readonly _tag: string;
  readonly message?: unknown;
  readonly data?: unknown;
} | null {
  const tag = readUnknownProperty(value, "_tag");
  return typeof tag === "string"
    ? {
        _tag: tag,
        message: readUnknownProperty(value, "message"),
        data: readUnknownProperty(value, "data"),
      }
    : null;
}
