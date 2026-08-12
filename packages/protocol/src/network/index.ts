/**
 * @file Public network address and connect-protocol surface.
 *
 * `webSocketUrl` appends the socket route unconditionally, so the two halves
 * of that invariant live together: a value that already carries a path would
 * dial `/ws/ws`, and the resulting socket never opens. `ServerBaseUrl` makes
 * such a value unconstructible.
 */
import {
  Data,
  Effect,
  ParseResult,
  Schema,
  String as StringOps,
  type Brand,
} from "effect";
import packageJson from "../../package.json" with { type: "json" };
import { agentKey } from "#identity/agents";
import {
  AlreadyConnected,
  defineRpc,
  InvalidParamsError,
  UnauthorizedError,
} from "#transport";

/** Route the server serves the WebSocket upgrade on. */
const SOCKET_ROUTE = "/ws";

const SOCKET_ROUTE_SUFFIX = /\/ws\/?$/;
const TRAILING_SLASH = /\/$/;
const WS_SCHEME_PREFIX = /^http/;
const HTTP_SCHEME_PREFIX = /^ws/;

const SERVER_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
]);

/**
 * Reduce an address to scheme and authority, or `null` when it is not one this
 * client can dial.
 *
 * Discarding the socket route loses nothing reachable: the route `webSocketUrl`
 * appends is fixed, so a server published under a path prefix is not
 * addressable through this package at all. Every other path is rejected rather
 * than silently dropped, and so are credentials, which the authority form
 * cannot carry.
 *
 * The result is rebuilt from the parsed URL rather than sliced out of the
 * input, so the scheme reaches `webSocketUrl` in the lower-case spelling its
 * swap matches. `HTTP://host` would otherwise survive validation and then dial
 * an `HTTP://` URL that no WebSocket can open.
 * @param value Value to process.
 * @returns The to origin result.
 */
const toOrigin = (value: string): string | null => {
  const withoutSocketRoute = StringOps.replace(SOCKET_ROUTE_SUFFIX, "")(value);
  const trimmed = StringOps.replace(TRAILING_SLASH, "")(withoutSocketRoute);
  // `URL.canParse` rather than `URL.parse`: the package's engine floor is Node
  // 22.0 and `parse` only exists from 22.1.
  if (!URL.canParse(trimmed)) {
    return null;
  }
  const url = new URL(trimmed);
  if (!SERVER_SCHEMES.has(url.protocol)) {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  return `${url.protocol}//${url.host}`;
};

/**
 * A MoltZap server address carrying no path, query, or fragment, over
 * `http`, `https`, `ws`, or `wss`.
 */
export type ServerBaseUrl = string & Brand.Brand<"ServerBaseUrl">;

/**
 * Decodes either address a caller is likely to hold — the base URL or the
 * socket endpoint — into the path-free base. Any other path fails.
 */
export const serverBaseUrlSchema: Schema.Schema<ServerBaseUrl, string> =
  Schema.transformOrFail(
    Schema.String,
    Schema.String.pipe(Schema.brand("ServerBaseUrl")),
    {
      strict: true,
      decode: (...[value, , ast]) => {
        const origin = toOrigin(value);
        return origin === null
          ? ParseResult.fail(
              new ParseResult.Type(
                ast,
                value,
                `Expected a MoltZap server base URL (scheme and host, no path), got ${JSON.stringify(value)}`,
              ),
            )
          : ParseResult.succeed(origin);
      },
      encode: ParseResult.succeed,
    },
  ).pipe(
    Schema.annotations({ description: "Path-free MoltZap server base URL" }),
  );

/**
 * Throwing constructor for addresses a caller already knows are well-formed,
 * such as one a locally started server just reported. Decode with
 * `Schema.decodeEither(ServerBaseUrl)` wherever the value comes from
 * configuration or another package.
 */
export const serverBaseUrl = Schema.decodeSync(serverBaseUrlSchema);

/**
 * The HTTP control-plane origin for the same server.
 * @param base Value supplied to the operation.
 * @returns The http base url result.
 */
export const httpBaseUrl = (base: ServerBaseUrl): string =>
  base.replace(HTTP_SCHEME_PREFIX, "http");

/**
 * The socket endpoint a client dials for the given server.
 * @param base Value supplied to the operation.
 * @returns The web socket url result.
 */
export const webSocketUrl = (base: ServerBaseUrl): string =>
  base.replace(WS_SCHEME_PREFIX, "ws") + SOCKET_ROUTE;

/** The published package version is also the wire-protocol version. */
export const PROTOCOL_VERSION = packageJson.version;

// The HelloOk carries no payload: a connecting client already knows its own
// identity, the protocol version is fixed by the build, and the server policy
// is not read by any client. The handshake's only observable outcome is
// success versus its typed failure channel.
const helloOkSchema = Schema.Struct({});

/** Represents hello ok values. */
export type HelloOk = Schema.Schema.Type<typeof helloOkSchema>;

/** Identifies which side of the client's range excludes the server version. */
export type ProtocolMismatchReason =
  | "server-above-client-max"
  | "server-below-client-min";

/** Raised when the client's version range does not include the server. */
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

/** Reports invalid protocol version failures. */
export class InvalidProtocolVersionError extends Data.TaggedError(
  "InvalidProtocolVersionError",
)<{ readonly version: string; readonly segment: string }> {
  override get message(): string {
    return `compareProtocolVersion: invalid segment ${JSON.stringify(this.segment)} in ${JSON.stringify(this.version)}`;
  }
}

const NUMERIC_SEGMENT_RE = /^\d+$/;

function parseVersionSegments(version: string): readonly number[] {
  const parts = StringOps.split(version, ".");
  const segments: number[] = [];
  for (const part of parts) {
    if (!NUMERIC_SEGMENT_RE.test(part)) {
      throw new InvalidProtocolVersionError({ version, segment: part });
    }
    segments.push(Number(part));
  }
  return segments;
}

/** Compares numeric protocol-version segments. */
export function compareProtocolVersion(a: string, b: string): -1 | 0 | 1 {
  const segmentsA = parseVersionSegments(a);
  const segmentsB = parseVersionSegments(b);
  const len = Math.max(segmentsA.length, segmentsB.length);
  for (let i = 0; i < len; i++) {
    const ai = segmentsA[i] ?? 0;
    const bi = segmentsB[i] ?? 0;
    if (ai < bi) {
      return -1;
    }
    if (ai > bi) {
      return 1;
    }
  }
  return 0;
}

/** Checks whether the server version falls within the client's range. */
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
      if (cause instanceof InvalidProtocolVersionError) {
        return cause;
      }
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
 * Authenticates an agent WebSocket connection as its first RPC. Success carries
 * no payload because the connecting client already knows its identity.
 */
export const agentConnect = defineRpc({
  name: "agent/network/connect",
  params: Schema.Struct({
    agentKey,
    minProtocol: Schema.String,
    maxProtocol: Schema.String,
  }),
  result: helloOkSchema,
  requires: [],
  errors: [
    InvalidParamsError,
    UnauthorizedError,
    ProtocolMismatchError,
    AlreadyConnected,
  ],
});
