import {
  type AuthenticationFailedError,
  InternalServerError,
  OverloadedError,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/v2-identity";
import { Rpc, RpcClient, RpcGroup, RpcServer } from "@effect/rpc";
import canonicalize from "canonicalize";
import { Data, Deferred, Effect, type Scope, Schema } from "effect";
import type { RouterPoll } from "./poll.js";
import {
  RegisteredAgentRequest,
  VerifiedRouterRequest,
  registeredAgentRequestLayer,
} from "./request-context.js";
import type { RouterSend } from "./send.js";
import {
  maximumPollCursorLength,
  PollCursor,
  RouterInstanceId,
  SignedMessageDigest,
} from "./values.js";

const exact = {
  exact: true,
  onExcessProperty: "error" as const,
};

const closedStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({ parseOptions: exact });

const utf8Encoder = new TextEncoder();
const signedMessagePlaceholder = "__signed_message__";
const signedMessagePlaceholderByteLength = utf8Encoder.encode(
  JSON.stringify(signedMessagePlaceholder),
).byteLength;
const maximumAgentId = "agt_AAAAAAAAAAAAAAAAAAAAAA";
const maximumRouterInstanceId = "rti_AAAAAAAAAAAAAAAAAAAAAA";

/** A Router enclosing representation cannot be measured safely. */
export class RouterRepresentationLengthError extends Data.TaggedError(
  "RouterRepresentationLengthError",
) {}

/** Exact maxima for the Router-owned enclosing representations. */
export interface RouterRepresentationLimits {
  readonly sendRequestBodyBytes: number;
  readonly pollRequestBodyBytes: number;
  readonly oneMessageBatchBytes: number;
}

const canonicalByteLength = (
  value: unknown,
): Effect.Effect<number, RouterRepresentationLengthError> => {
  const encoded = canonicalize(value);
  if (encoded === undefined) {
    return Effect.fail(new RouterRepresentationLengthError());
  }
  return Effect.succeed(utf8Encoder.encode(encoded).byteLength);
};

const supportedLength = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const checkedAdd = (
  left: number,
  right: number,
): Effect.Effect<number, RouterRepresentationLengthError> => {
  const result = left + right;
  if (
    !supportedLength(left) ||
    !supportedLength(right) ||
    !supportedLength(result)
  ) {
    return Effect.fail(new RouterRepresentationLengthError());
  }
  return Effect.succeed(result);
};

const maximumSendBody = {
  callerAgentId: maximumAgentId,
  request: {
    expectedRouterInstanceId: maximumRouterInstanceId,
    mode: "initial",
    signedMessage: signedMessagePlaceholder,
  },
};
const maximumPollBody = {
  callerAgentId: maximumAgentId,
  request: {
    pollCursor: "A".repeat(maximumPollCursorLength),
  },
};
const maximumOneMessageBatch = {
  kind: "batch",
  pollCursor: "A".repeat(maximumPollCursorLength),
  routerInstanceId: maximumRouterInstanceId,
  signedMessages: [signedMessagePlaceholder],
};

/**
 * Calculates exact enclosing limits while treating SignedMessage as an
 * identity-owned byte sequence.
 *
 * @param maximumSignedMessageByteLength Identity-owned complete message limit.
 * @returns Exact maximum Router request and one-message result byte lengths.
 */
export const calculateRouterRepresentationLimits = (
  maximumSignedMessageByteLength: number,
): Effect.Effect<RouterRepresentationLimits, RouterRepresentationLengthError> =>
  Effect.gen(function* () {
    const sendTemplateBytes = yield* canonicalByteLength(maximumSendBody);
    const pollRequestBodyBytes = yield* canonicalByteLength(maximumPollBody);
    const batchTemplateBytes = yield* canonicalByteLength(
      maximumOneMessageBatch,
    );
    const sendFixedBytes =
      sendTemplateBytes - signedMessagePlaceholderByteLength;
    const batchFixedBytes =
      batchTemplateBytes - signedMessagePlaceholderByteLength;
    return Object.freeze({
      sendRequestBodyBytes: yield* checkedAdd(
        sendFixedBytes,
        maximumSignedMessageByteLength,
      ),
      pollRequestBodyBytes,
      oneMessageBatchBytes: yield* checkedAdd(
        batchFixedBytes,
        maximumSignedMessageByteLength,
      ),
    });
  }).pipe(Effect.withSpan("calculateRouterRepresentationLimits"));

/** Exact limits derived from the current closed Router representations. */
export const routerRepresentationLimits = Effect.runSync(
  calculateRouterRepresentationLimits(SignedMessage.maximumEncodedByteLength),
);

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare --
 * Named Effect Schemas share their domain names with the types they decode.
 */

/** One authenticated request to accept or recover an opaque message. */
export interface RouterSendRequest {
  readonly expectedRouterInstanceId: RouterInstanceId;
  readonly mode: "initial" | "retry";
  readonly signedMessage: SignedMessageValue;
}

type RouterSendRequestEncoded = Readonly<{
  expectedRouterInstanceId: string;
  mode: "initial" | "retry";
  signedMessage: unknown;
}>;

/** Private send shape before the identity-owned artifact is decoded. */
export interface RawRouterSendRequest {
  readonly expectedRouterInstanceId: RouterInstanceId;
  readonly mode: "initial" | "retry";
  readonly signedMessage: unknown;
}

/** Exact private send shape that preserves instance-fence precedence. */
export const RawRouterSendRequest = closedStruct({
  expectedRouterInstanceId: RouterInstanceId,
  mode: Schema.Literal("initial", "retry"),
  signedMessage: Schema.Unknown,
}).annotations({ identifier: "RawRouterSendRequest" });

/** Exact Schema for one send request. */
export const RouterSendRequest: Schema.Schema<
  RouterSendRequest,
  RouterSendRequestEncoded
> = closedStruct({
  expectedRouterInstanceId: RouterInstanceId,
  mode: Schema.Literal("initial", "retry"),
  signedMessage: SignedMessage,
}).annotations({ identifier: "RouterSendRequest" });

const accepted = closedStruct({
  kind: Schema.Literal("accepted"),
  routerInstanceId: RouterInstanceId,
  signedMessageDigest: SignedMessageDigest,
});
const routerRestarted = closedStruct({
  kind: Schema.Literal("router_restarted"),
  routerInstanceId: RouterInstanceId,
});
const messageInvalid = closedStruct({
  kind: Schema.Literal("message_invalid"),
});
const idempotencyConflict = closedStruct({
  kind: Schema.Literal("idempotency_conflict"),
});
const retryIdentityUnknown = closedStruct({
  kind: Schema.Literal("retry_identity_unknown"),
});

/** Closed outcome of accepting or recovering an opaque message. */
export type RouterSendResult =
  | Readonly<{
      kind: "accepted";
      routerInstanceId: RouterInstanceId;
      signedMessageDigest: SignedMessageDigest;
    }>
  | Readonly<{
      kind: "router_restarted";
      routerInstanceId: RouterInstanceId;
    }>
  | Readonly<{ kind: "message_invalid" }>
  | Readonly<{ kind: "idempotency_conflict" }>
  | Readonly<{ kind: "retry_identity_unknown" }>;

type RouterSendResultEncoded =
  | Readonly<{
      kind: "accepted";
      routerInstanceId: string;
      signedMessageDigest: string;
    }>
  | Readonly<{
      kind: "router_restarted";
      routerInstanceId: string;
    }>
  | Readonly<{ kind: "message_invalid" }>
  | Readonly<{ kind: "idempotency_conflict" }>
  | Readonly<{ kind: "retry_identity_unknown" }>;

/** Exact Schema for every closed send outcome. */
export const RouterSendResult: Schema.Schema<
  RouterSendResult,
  RouterSendResultEncoded
> = Schema.Union(
  accepted,
  routerRestarted,
  messageInvalid,
  idempotencyConflict,
  retryIdentityUnknown,
).annotations({ identifier: "RouterSendResult" });

/** One authenticated endpoint-wide poll request. */
export interface RouterPollRequest {
  readonly pollCursor?: PollCursor;
}

type RouterPollRequestEncoded = Readonly<{
  pollCursor?: string;
}>;

/** Exact Schema for one endpoint-wide poll request. */
export const RouterPollRequest: Schema.Schema<
  RouterPollRequest,
  RouterPollRequestEncoded
> = closedStruct({
  pollCursor: Schema.optional(PollCursor),
}).annotations({ identifier: "RouterPollRequest" });

const batch = closedStruct({
  kind: Schema.Literal("batch"),
  routerInstanceId: RouterInstanceId,
  signedMessages: Schema.Array(SignedMessage),
  pollCursor: PollCursor,
});
const feedGap = closedStruct({
  kind: Schema.Literal("feed_gap"),
  routerInstanceId: RouterInstanceId,
});
const cursorInvalid = closedStruct({
  kind: Schema.Literal("cursor_invalid"),
});

/** Closed outcome of one endpoint-wide bounded poll. */
export type RouterPollResult =
  | Readonly<{
      kind: "batch";
      routerInstanceId: RouterInstanceId;
      signedMessages: readonly SignedMessageValue[];
      pollCursor: PollCursor;
    }>
  | Readonly<{
      kind: "feed_gap";
      routerInstanceId: RouterInstanceId;
    }>
  | Readonly<{ kind: "cursor_invalid" }>;

type RouterPollResultEncoded =
  | Readonly<{
      kind: "batch";
      routerInstanceId: string;
      signedMessages: readonly unknown[];
      pollCursor: string;
    }>
  | Readonly<{
      kind: "feed_gap";
      routerInstanceId: string;
    }>
  | Readonly<{ kind: "cursor_invalid" }>;

/** Exact Schema for every closed poll outcome. */
export const RouterPollResult: Schema.Schema<
  RouterPollResult,
  RouterPollResultEncoded
> = Schema.Union(batch, feedGap, cursorInvalid).annotations({
  identifier: "RouterPollResult",
});

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- restore the shared project rules */

const handlerErrors = Schema.Union(OverloadedError, InternalServerError);
const sendRpc = Rpc.make("send", {
  payload: { request: RawRouterSendRequest },
  success: RouterSendResult,
  error: handlerErrors,
}).middleware(RegisteredAgentRequest);
const pollRpc = Rpc.make("poll", {
  payload: { request: RouterPollRequest },
  success: RouterPollResult,
  error: handlerErrors,
}).middleware(RegisteredAgentRequest);

const routerRpcGroup = RpcGroup.make(sendRpc, pollRpc);

type RouterHandlerError =
  | AuthenticationFailedError
  | OverloadedError
  | InternalServerError;

/** Typed package-private client used by the HTTP adapter. */
export interface RouterRpcClient {
  readonly send: (input: {
    readonly request: RawRouterSendRequest;
  }) => Effect.Effect<RouterSendResult, RouterHandlerError>;
  readonly poll: (input: {
    readonly request: RouterPollRequest;
  }) => Effect.Effect<RouterPollResult, RouterHandlerError>;
}

const makeRouterRpcHandlersLayer = (input: {
  readonly send: RouterSend;
  readonly poll: RouterPoll;
}) =>
  routerRpcGroup.toLayer({
    send: ({ request }) =>
      Effect.gen(function* () {
        const verifiedRequest = yield* VerifiedRouterRequest;
        return yield* input.send.handle(request, verifiedRequest);
      }),
    poll: ({ request }) =>
      Effect.gen(function* () {
        const verifiedRequest = yield* VerifiedRouterRequest;
        return yield* input.poll.handle(request, verifiedRequest);
      }),
  });

/**
 * Connects private typed operations directly to their handlers.
 *
 * @param input Domain handlers for both correlated operations.
 * @param input.send Send domain handler.
 * @param input.poll Poll domain handler.
 * @returns A scoped in-process client with typed failures.
 */
export const makeRouterRpcClient = (input: {
  readonly send: RouterSend;
  readonly poll: RouterPoll;
}): Effect.Effect<RouterRpcClient, never, Scope.Scope> => {
  const handlerLayer = makeRouterRpcHandlersLayer(input);
  return Effect.gen(function* () {
    type ClientConnection = Effect.Effect.Success<
      ReturnType<
        typeof RpcClient.makeNoSerialization<
          typeof sendRpc | typeof pollRpc,
          never
        >
      >
    >;
    const clientReady = yield* Deferred.make<ClientConnection>();
    const server = yield* RpcServer.makeNoSerialization(routerRpcGroup, {
      onFromServer: (message) =>
        Deferred.await(clientReady).pipe(
          Effect.flatMap((client) => client.write(message)),
        ),
    });
    const client = yield* RpcClient.makeNoSerialization(routerRpcGroup, {
      supportsAck: true,
      onFromClient: ({ message }) => server.write(0, message),
    });
    yield* Deferred.succeed(clientReady, client);
    return client.client;
  }).pipe(
    Effect.provide(handlerLayer),
    Effect.provide(registeredAgentRequestLayer),
    Effect.withSpan("makeRouterRpcClient"),
  );
};
