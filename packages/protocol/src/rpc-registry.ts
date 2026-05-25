/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data, Effect } from "effect";
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
  TaskRejectedError,
  ConversationArchivedError,
  ConversationFullError,
  HookBlockedError,
  nonTmAuthorityTaskRpcMethods,
  tmOnlyTaskRpcMethods,
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

/**
 * Closed union of every wire-registered tagged-error class instance.
 * Drives `RpcCallError` so consumers can `Effect.catchTag(...)` against
 * concrete tags (e.g. "Forbidden", "NotInContacts"). Mirrors the static
 * registry built by `registerErrorClass` — keep in sync if a new class
 * lands.
 */
export type RegisteredTaggedError =
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | ConflictError
  | InvalidParamsError
  | NotInContactsError
  | TaskClosedError
  | TaskRejectedError
  | ConversationArchivedError
  | ConversationFullError
  | HookBlockedError;

// Spec D3 R11 — per-kind outbound catalogs.
//   `agentClientRpcMethods` — callable from `MoltZapAgentClient`.
//   `taskMasterRpcMethods`  — superset; adds TM-only operations.
//   `serverRpcMethods`      — server inbound; full union (still
//     includes the legacy `Conversations*` / plural `Tasks*` that
//     retire across Commits 6-10).
export const agentClientRpcMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...nonTmAuthorityTaskRpcMethods,
  ...appRpcMethods,
] as const;

export const taskMasterRpcMethods = [
  ...agentClientRpcMethods,
  ...tmOnlyTaskRpcMethods,
] as const;

export const serverRpcMethods = [
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

export type AnyServerRpcDefinition = (typeof serverRpcMethods)[number] &
  RpcDefinition<string, any, any>;
export type AnyAgentClientRpcDefinition =
  (typeof agentClientRpcMethods)[number] & RpcDefinition<string, any, any>;
export type AnyTaskMasterRpcDefinition = (typeof taskMasterRpcMethods)[number] &
  RpcDefinition<string, any, any>;

export type AnyTaskCallbackRpcDefinition = (typeof taskCallbackMethods)[number];

export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];

/** Discriminated success arm of a decoded JSON-RPC response. */
export class DecodedResponseSuccess extends Data.TaggedClass(
  "ResponseSuccess",
)<{
  readonly frame: ResponseFrame;
  readonly id: JsonRpcId;
  readonly result: unknown;
}> {}

/**
 * Discriminated error arm of a decoded JSON-RPC response — wire-frame
 * decoder discriminator, not an Effect tagged error (the wire `error`
 * sub-object carries `code`/`message`/`data`, no Effect machinery).
 */
export class DecodedResponseError extends Data.TaggedClass("ResponseError")<{
  readonly frame: ResponseFrame;
  readonly id: JsonRpcId;
  readonly error: Extract<ResponseFrame, { error: unknown }>["error"];
}> {}

/**
 * Decoded shape of a frame inbound to the client (from server):
 * a response (success XOR error), a server-initiated task-callback
 * request, or a notification.
 */
export type DecodedServerInbound =
  | DecodedResponseSuccess
  | DecodedResponseError
  | ({
      readonly _tag: "ServerRequest";
    } & DecodedRpcRequest<AnyTaskCallbackRpcDefinition>)
  | ({
      readonly _tag: "Notification";
    } & DecodedNotification<AnyNotificationDefinition>);

/**
 * Decoded shape of a frame inbound to the server (from client):
 * a client RPC request, a response (success XOR error) to a
 * server-initiated callback, or a notification.
 */
export type DecodedClientInbound =
  | ({
      readonly _tag: "ClientRequest";
    } & DecodedRpcRequest<AnyServerRpcDefinition>)
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
    return Effect.succeed(
      new DecodedResponseError({
        frame,
        id: frame.id,
        error: frame.error,
      }),
    );
  }
  if ("result" in frame) {
    return Effect.succeed(
      new DecodedResponseSuccess({
        frame,
        id: frame.id,
        result: frame.result,
      }),
    );
  }
  return Effect.fail(new MalformedFrameError({ raw }));
}

/**
 * Typed entry point for client-inbound frames (used by the client to
 * decode what the server sends). Fails closed with
 * `MalformedFrameError` on any wire-level mismatch.
 *
 * ```mermaid
 * flowchart TD
 *   A["raw socket payload<br>(JSON.parse happens before this call)"]
 *   A --> B["decodeFrame(parsed)"]
 *   B --> C{tag?}
 *   C -->|Request| D["decodeRpcRequest(taskCallbackMethods)<br>→ ServerRequest"]
 *   C -->|Response| E["decodeResponseFrame<br>→ ResponseSuccess | ResponseError"]
 *   C -->|Notification| F["decodeNotification(notificationDefs)<br>→ Notification"]
 *   D --> G[DecodedServerInbound]
 *   E --> G
 *   F --> G
 * ```
 *
 * Client-inbound `Request` frames are restricted to
 * `taskCallbackMethods` (the subset the server is allowed to call
 * back into the client — `dispatch/authorize`, etc.). Response
 * frames with `id === null` fail closed since a null id has no
 * pending call to resolve.
 *
 * Sibling: {@link decodeClientInbound} — same pipeline, but admits
 * the full `rpcMethods` set on the request arm (server-side use).
 */
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

/**
 * Typed entry point for server-inbound frames (used by the server to
 * decode what a client sends). Same shape as
 * {@link decodeServerInbound} but admits the FULL `rpcMethods` set
 * on the request arm.
 *
 * Fails closed with `MalformedFrameError` on any mismatch, including
 * a response frame whose `id` is `null` (no pending call to settle).
 */
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
          return decodeRpcRequest(serverRpcMethods, decoded.frame).pipe(
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
