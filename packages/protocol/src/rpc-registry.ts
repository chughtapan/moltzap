import { Effect } from "effect";
import {
  identityRpcMethods,
  identityNotifications,
  NotInContactsError,
} from "./identity/methods.js";
import { networkRpcMethods, networkNotifications } from "./network/methods.js";
import {
  taskRpcMethods,
  taskNotifications,
  TaskClosedError,
  ConversationArchivedError,
  ConversationFullError,
  HookBlockedError,
} from "./task/methods.js";
import {
  appRpcMethods,
  taskCallbackMethods,
  appNotifications,
} from "./app/methods.js";
import type { RpcDefinition } from "./transport/method.js";
import {
  decodeFrame,
  type JsonRpcId,
  type ResponseFrame,
} from "./transport/wire.js";
import {
  decodeNotification,
  decodeRpcRequest,
  type DecodedNotification,
  type DecodedRpcRequest,
} from "./transport/rpc-groups.js";
import {
  MalformedFrameError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidParamsError,
} from "./transport/wire-errors.js";

export { taskCallbackMethods };

/** Closed union of every wire-registered tagged-error class instance.
 * Drives `RpcCallError` so consumers can `Effect.catchTag(...)` against
 * concrete tags (e.g. "Forbidden", "NotInContacts"). Mirrors the static
 * registry built by `registerErrorClass` — keep in sync if a new class
 * lands. */
export type RegisteredTaggedError =
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | ConflictError
  | InvalidParamsError
  | NotInContactsError
  | TaskClosedError
  | ConversationArchivedError
  | ConversationFullError
  | HookBlockedError;

export const rpcMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...taskRpcMethods,
  ...appRpcMethods,
] as const;

export const notificationDefinitions = [
  ...networkNotifications,
  ...identityNotifications,
  ...taskNotifications,
  ...appNotifications,
] as const;

export type AnyRpcDefinition = (typeof rpcMethods)[number] &
  RpcDefinition<string, any, any>;

export type AnyTaskCallbackRpcDefinition = (typeof taskCallbackMethods)[number];

export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];

/** Discriminated success arm of a decoded JSON-RPC response. */
export type DecodedResponseSuccess = {
  readonly _tag: "ResponseSuccess";
  readonly id: JsonRpcId;
  readonly result: unknown;
};

/** Discriminated error arm of a decoded JSON-RPC response — wire-frame
 * decoder discriminator, not an Effect tagged error (the wire `error`
 * sub-object carries `code`/`message`/`data`, no Effect machinery). */
// eslint-disable-next-line agent-code-guard/manual-tagged-error -- frame-decoder discriminator, not a Data.TaggedError
export type DecodedResponseError = {
  readonly _tag: "ResponseError";
  readonly id: JsonRpcId;
  readonly error: Extract<ResponseFrame, { error: unknown }>["error"];
};

/** Decoded shape of a frame inbound to the client (from server):
 * a response (success XOR error), a server-initiated task-callback
 * request, or a notification. */
export type DecodedServerInbound =
  | DecodedResponseSuccess
  | DecodedResponseError
  | ({
      readonly _tag: "ServerRequest";
    } & DecodedRpcRequest<AnyTaskCallbackRpcDefinition>)
  | ({
      readonly _tag: "Notification";
    } & DecodedNotification<AnyNotificationDefinition>);

/** Decoded shape of a frame inbound to the server (from client):
 * a client RPC request, a response (success XOR error) to a
 * server-initiated callback, or a notification. */
export type DecodedClientInbound =
  | ({ readonly _tag: "ClientRequest" } & DecodedRpcRequest<AnyRpcDefinition>)
  | DecodedResponseSuccess
  | DecodedResponseError
  | ({
      readonly _tag: "Notification";
    } & DecodedNotification<AnyNotificationDefinition>);

function decodeResponseFrame(
  frame: ResponseFrame,
  raw: string,
): Effect.Effect<
  DecodedResponseSuccess | DecodedResponseError,
  MalformedFrameError
> {
  if (frame.id === null) {
    return Effect.fail(new MalformedFrameError({ raw }));
  }
  if ("error" in frame && frame.error !== undefined) {
    return Effect.succeed({
      _tag: "ResponseError",
      id: frame.id,
      error: frame.error,
    });
  }
  if ("result" in frame) {
    return Effect.succeed({
      _tag: "ResponseSuccess",
      id: frame.id,
      result: frame.result,
    });
  }
  return Effect.fail(new MalformedFrameError({ raw }));
}

/** Typed entry point for client-inbound frames. Fails closed with
 * `MalformedFrameError` on any wire-level mismatch. */
export function decodeServerInbound(
  parsed: unknown,
): Effect.Effect<DecodedServerInbound, MalformedFrameError> {
  const raw = typeof parsed === "string" ? parsed : safeStringify(parsed);
  const wrap = (cause: unknown) => new MalformedFrameError({ raw, cause });
  return decodeFrame(parsed).pipe(
    Effect.mapError(wrap),
    Effect.flatMap(
      (decoded): Effect.Effect<DecodedServerInbound, MalformedFrameError> => {
        if (decoded._tag === "Response")
          return decodeResponseFrame(decoded.frame, raw);
        if (decoded._tag === "Request")
          return decodeRpcRequest(taskCallbackMethods, decoded.frame).pipe(
            Effect.mapError(wrap),
            Effect.map((req) => ({ ...req, _tag: "ServerRequest" as const })),
          );
        return decodeNotification(notificationDefinitions, decoded.frame).pipe(
          Effect.mapError(wrap),
          Effect.map((n) => ({ ...n, _tag: "Notification" as const })),
        );
      },
    ),
  );
}

/** Typed entry point for server-inbound frames. Fails closed with
 * `MalformedFrameError` on any wire-level mismatch. */
export function decodeClientInbound(
  parsed: unknown,
): Effect.Effect<DecodedClientInbound, MalformedFrameError> {
  const raw = typeof parsed === "string" ? parsed : safeStringify(parsed);
  const wrap = (cause: unknown) => new MalformedFrameError({ raw, cause });
  return decodeFrame(parsed).pipe(
    Effect.mapError(wrap),
    Effect.flatMap(
      (decoded): Effect.Effect<DecodedClientInbound, MalformedFrameError> => {
        if (decoded._tag === "Response")
          return decodeResponseFrame(decoded.frame, raw);
        if (decoded._tag === "Request")
          return decodeRpcRequest(rpcMethods, decoded.frame).pipe(
            Effect.mapError(wrap),
            Effect.map((req) => ({ ...req, _tag: "ClientRequest" as const })),
          );
        return decodeNotification(notificationDefinitions, decoded.frame).pipe(
          Effect.mapError(wrap),
          Effect.map((n) => ({ ...n, _tag: "Notification" as const })),
        );
      },
    ),
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[unstringifiable: ${String(error)}] ${String(value)}`;
  }
}
