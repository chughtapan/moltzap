// Auto-bumped by publish workflow.
import { Data, Effect, Schema } from "effect";
import { AgentKey } from "#identity/agents";
import { AppKey } from "#identity/apps";
import { defineRpc } from "#transport";
import {
  UnauthorizedError,
  AlreadyConnected,
  InvalidParamsError,
} from "#transport";

export const PROTOCOL_VERSION = "2026.529.0";

// ═══════════════════════════════════════════════════════════════════
// agent/network/connect + app/network/connect
// ═══════════════════════════════════════════════════════════════════

// The HelloOk carries no payload: a connecting client already knows its own
// identity (an agent registers and stores its `agentId` via the
// `agent/identity/register` HTTP flow; an app holds its appId), the protocol version is
// fixed by the build, and the server policy is not read by any client. The
// handshake's only observable outcome is success vs the typed
// `UnauthorizedError` / `ProtocolMismatchError` failure channel.
const HelloOkSchema = Schema.Struct({});

export type HelloOk = Schema.Schema.Type<typeof HelloOkSchema>;

/**
 * Reason discriminant carried in `ProtocolMismatchError.data.reason`:
 * `server-above-client-max` — the server is newer than the client's
 * `maxProtocol`; the client must update. `server-below-client-min` — the
 * client is newer than the server supports.
 */
export type ProtocolMismatchReason =
  | "server-above-client-max"
  | "server-below-client-min";

/**
 * Raised by connect methods when the client's `[minProtocol, maxProtocol]`
 * range does not bracket the server's `PROTOCOL_VERSION`. The server's connect
 * handlers raise it BEFORE auth resolution
 * so old clients are rejected at the version gate. `data` carries the
 * diagnostic `{ reason, serverVersion, clientMinProtocol, clientMaxProtocol }`,
 * concretely typed so `error.data.reason` narrows at every reader.
 */
export class ProtocolMismatchError extends Schema.TaggedError<ProtocolMismatchError>()(
  "ProtocolMismatchError",
  {
    message: Schema.optional(Schema.String),
    data: Schema.Struct({
      reason: Schema.Literal(
        "server-above-client-max",
        "server-below-client-min",
      ),
      serverVersion: Schema.String,
      clientMinProtocol: Schema.String,
      clientMaxProtocol: Schema.String,
    }),
  },
) {
  static readonly message = "Client protocol version not supported";
}

export class InvalidProtocolVersionError extends Data.TaggedError(
  "InvalidProtocolVersionError",
)<{ readonly version: string; readonly segment: string }> {
  override get message(): string {
    return `compareProtocolVersion: invalid segment ${JSON.stringify(this.segment)} in ${JSON.stringify(this.version)}`;
  }
}

const NUMERIC_SEGMENT_RE = /^\d+$/;

function parseVersionSegments(version: string): readonly number[] {
  const parts = version.split(".");
  const segments: number[] = [];
  for (const part of parts) {
    if (!NUMERIC_SEGMENT_RE.test(part)) {
      throw new InvalidProtocolVersionError({ version, segment: part });
    }
    segments.push(Number(part));
  }
  return segments;
}

export function compareProtocolVersion(a: string, b: string): -1 | 0 | 1 {
  const segmentsA = parseVersionSegments(a);
  const segmentsB = parseVersionSegments(b);
  const len = Math.max(segmentsA.length, segmentsB.length);
  for (let i = 0; i < len; i++) {
    const ai = segmentsA[i] ?? 0;
    const bi = segmentsB[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export function checkProtocolRange(
  params: { readonly minProtocol: string; readonly maxProtocol: string },
  serverVersion: string,
): Effect.Effect<void, ProtocolMismatchError | InvalidProtocolVersionError> {
  return Effect.gen(function* () {
    const high = yield* compareThrough(serverVersion, params.maxProtocol);
    if (high > 0) {
      return yield* failProtocolMismatch(
        params,
        "server-above-client-max",
        serverVersion,
      );
    }
    const low = yield* compareThrough(serverVersion, params.minProtocol);
    if (low < 0) {
      return yield* failProtocolMismatch(
        params,
        "server-below-client-min",
        serverVersion,
      );
    }
  }).pipe(Effect.withSpan("checkProtocolRange"));
}

function compareThrough(
  a: string,
  b: string,
): Effect.Effect<-1 | 0 | 1, InvalidProtocolVersionError> {
  return Effect.try({
    try: () => compareProtocolVersion(a, b),
    catch: (cause): InvalidProtocolVersionError => {
      if (cause instanceof InvalidProtocolVersionError) return cause;
      return new InvalidProtocolVersionError({
        version: `${a} vs ${b}`,
        segment: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });
}

function failProtocolMismatch(
  params: { readonly minProtocol: string; readonly maxProtocol: string },
  reason: ProtocolMismatchReason,
  serverVersion: string,
): Effect.Effect<never, ProtocolMismatchError> {
  return Effect.fail(
    new ProtocolMismatchError({
      data: {
        clientMinProtocol: params.minProtocol,
        clientMaxProtocol: params.maxProtocol,
        serverVersion,
        reason,
      },
    }),
  );
}

/**
 * Authenticate an agent WebSocket connection. Must be the first message on a
 * new agent client connection.
 *
 * - **Principal:** none — the unauthenticated handshake. No principal exists
 *   pre-auth, so `requires` is empty and no gate runs before it.
 * - **Params:** `agentKey`, `minProtocol`, `maxProtocol`.
 * - **Result:** an empty HelloOk; success is the signal (the client holds its
 *   own id).
 * @returns An empty HelloOk; success is the signal (the client holds its own id).
 * @error InvalidParamsError when the params are malformed
 * @error UnauthorizedError when the credential is well-formed but invalid
 * @error ProtocolMismatchError when the client protocol version is not supported
 * @error AlreadyConnected when the principal already holds a live connection
 */
export const AgentConnect = defineRpc({
  name: "agent/network/connect",
  params: Schema.Struct({
    agentKey: AgentKey,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: HelloOkSchema,
  requires: [],
  errors: [
    InvalidParamsError,
    UnauthorizedError,
    ProtocolMismatchError,
    AlreadyConnected,
  ],
});

/**
 * Authenticate an app WebSocket connection. Must be the first message on a new
 * app client connection.
 *
 * - **Principal:** none — the unauthenticated handshake. No principal exists
 *   pre-auth, so `requires` is empty and no gate runs before it.
 * - **Params:** `appKey`, `minProtocol`, `maxProtocol`.
 * - **Result:** an empty HelloOk; success is the signal (the client holds its
 *   own id).
 * @returns An empty HelloOk; success is the signal (the client holds its own id).
 * @error InvalidParamsError when the params are malformed
 * @error UnauthorizedError when the app key is well-formed but invalid
 * @error ProtocolMismatchError when the client protocol version is not supported
 * @error AlreadyConnected when the principal already holds a live connection
 */
export const AppConnect = defineRpc({
  name: "app/network/connect",
  params: Schema.Struct({
    appKey: AppKey,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: HelloOkSchema,
  requires: [],
  errors: [
    InvalidParamsError,
    UnauthorizedError,
    ProtocolMismatchError,
    AlreadyConnected,
  ],
});
