/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data } from "effect";
import type { JsonValue } from "../schema-primitives.js";

/** JSON-RPC 2.0 reserved codes. Emitted by TypedDispatcher; never raised by handlers. */
export const JSON_RPC_RESERVED_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * A `Data.TaggedError`-derived class with static wire metadata
 * (`code` + `message`). The typed dispatcher reads
 * `err.constructor.code` to encode outbound error responses; the
 * originator looks up the class by code via `errorClassFor` for inbound
 * response decode.
 */
export type RpcErrorClass = (new (
  ...args: never[]
) => {
  readonly _tag: string;
}) & {
  readonly code: number;
  readonly message: string;
};

const codeToClass = new Map<number, RpcErrorClass>();
const registeredClasses = new Set<RpcErrorClass>();

class DuplicateErrorCodeError extends Error {
  override readonly name = "DuplicateErrorCodeError";
}

/**
 * Register a tagged-error class so the originator can resurrect it
 * from a wire `error` payload by code. Each registered class carries
 * `static readonly code: number` and `static readonly message:
 * string`; both are read at registration time. Throws
 * `DuplicateErrorCodeError` at module-load if two classes claim the
 * same code.
 *
 * ```mermaid
 * flowchart LR
 *   A["domain module load:<br>class FooError extends Data.TaggedError(...)<br>static code = -32019<br>registerErrorClass(FooError)"]
 *   A --> B["codeToClass.set(-32019, FooError)"]
 *   B --> C["client side: errorClassFor(code)<br>→ FooError instance | undefined"]
 *   C --> D["caller: Effect.catchTag('Foo', ...)"]
 *   B --> E["server side: wireErrorFromInstance<br>→ wire 'error' sub-object"]
 * ```
 *
 * `JSON_RPC_RESERVED_CODES` covers only the five JSON-RPC 2.0 spec
 * codes (-32700, -32600, -32601, -32602, -32603). Every other code
 * lives in the runtime registry, not in a central table. The
 * `RegisteredTaggedError` union in `rpc-registry.ts` mirrors the
 * registered classes and must be hand-kept in sync — the TS type
 * system cannot enumerate the static-side registry into a union.
 */
export function registerErrorClass(cls: RpcErrorClass): void {
  const existing = codeToClass.get(cls.code);
  if (existing !== undefined && existing !== cls) {
    throw new DuplicateErrorCodeError(
      `Duplicate wire error code ${cls.code}: ${cls.name} conflicts with ${existing.name}`,
    );
  }
  codeToClass.set(cls.code, cls);
  registeredClasses.add(cls);
}

/** Returns the registered class for a wire code, or `undefined`. */
export function errorClassFor(code: number): RpcErrorClass | undefined {
  return codeToClass.get(code);
}

/** Returns true iff `value`'s constructor is in the registered class set. */
export function isRegisteredErrorInstance(value: object): boolean {
  return registeredClasses.has(value.constructor as RpcErrorClass);
}

/**
 * Optional per-instance overrides for tagged-error classes. The static
 * `message` on the class is the default; instances may carry a more
 * specific message and/or supplemental `data` payload that TypedDispatcher
 * forwards to the wire response.
 */
export interface RpcErrorPayload {
  readonly message?: string;
  readonly data?: JsonValue;
}

// Transport-layer cross-cutting tagged errors. Domain errors live in their
// owning layer's `errors.ts`.

export class UnauthorizedError extends Data.TaggedError(
  "Unauthorized",
)<RpcErrorPayload> {
  static readonly code = -32000;
  static readonly message = "Not authenticated. Send network/connect first.";
}
registerErrorClass(UnauthorizedError);

/** Authenticated but not authorized for this resource. */
export class ForbiddenError extends Data.TaggedError(
  "Forbidden",
)<RpcErrorPayload> {
  static readonly code = -32001;
  static readonly message = "Forbidden";
}
registerErrorClass(ForbiddenError);

/** Resource not found (cross-cutting variant; domain-specific NotFound errors live with their domain). */
export class NotFoundError extends Data.TaggedError(
  "NotFound",
)<RpcErrorPayload> {
  static readonly code = -32002;
  static readonly message = "Not found";
}
registerErrorClass(NotFoundError);

/** Conflict on a resource (cross-cutting; e.g., duplicate registration). */
export class ConflictError extends Data.TaggedError(
  "Conflict",
)<RpcErrorPayload> {
  static readonly code = -32003;
  static readonly message = "Conflict";
}
registerErrorClass(ConflictError);

/**
 * Boundary validation error — JSON-RPC reserved code -32602. Raised by
 * protocol- and server-layer handlers when params fail schema validation;
 * registered with the wire-error registry so handler-raised instances map
 * to a `-32602 InvalidParams` wire response via `wireErrorFromInstance`.
 */
export class InvalidParamsError extends Data.TaggedError("InvalidParamsError")<{
  readonly message: string;
}> {
  static readonly code = JSON_RPC_RESERVED_CODES.InvalidParams;
  static readonly message = "Invalid params";
}
registerErrorClass(InvalidParamsError);

/** Inbound frame failed to parse as JSON or did not match the expected shape. */
export class MalformedFrameError extends Data.TaggedError(
  "MalformedFrameError",
)<{
  readonly raw: string;
  readonly cause?: unknown;
}> {}

/**
 * A principal (agent or app) already holds an active connection. Fires at
 * the Connect handler's per-connection preflight/atomic gate (a socket
 * already authenticated as either arm) and at the per-principal gate
 * (`AgentEndpointResolver.add` / `AppRegistry.register` rejecting a second
 * binding). The `principal` discriminator names which arm the conflict is
 * on; the wire code is shared.
 */
export class AlreadyConnected extends Data.TaggedError("AlreadyConnected")<
  RpcErrorPayload & {
    readonly principal: "agent" | "app";
  }
> {
  static readonly code = -32010;
  static readonly message =
    "Principal already has an active connection. Disconnect the prior session first.";
}
registerErrorClass(AlreadyConnected);
