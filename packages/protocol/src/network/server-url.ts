/**
 * @file The MoltZap server base URL and the socket endpoint derived from it.
 *
 * `webSocketUrl` appends the socket route unconditionally, so the two halves
 * of that invariant live together: a value that already carries a path would
 * dial `/ws/ws`, and the resulting socket never opens. `ServerBaseUrl` is the
 * type that makes such a value unconstructible.
 */
import { ParseResult, Schema, type Brand } from "effect";

/** Route the server serves the WebSocket upgrade on. */
const SOCKET_ROUTE = "/ws";

const SOCKET_ROUTE_SUFFIX = /\/ws\/?$/;
const TRAILING_SLASH = /\/$/;
const WS_SCHEME_PREFIX = /^http/;

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
 */
function toOrigin(value: string): string | null {
  const trimmed = value
    .replace(SOCKET_ROUTE_SUFFIX, "")
    .replace(TRAILING_SLASH, "");
  // `URL.canParse` rather than `URL.parse`: the package's engine floor is Node
  // 22.0 and `parse` only exists from 22.1.
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (!SERVER_SCHEMES.has(url.protocol)) return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * A MoltZap server address carrying no path, query, or fragment, over
 * `http`, `https`, `ws`, or `wss`.
 */
export type ServerBaseUrl = string & Brand.Brand<"ServerBaseUrl">;

/**
 * Decodes either address a caller is likely to hold — the base URL or the
 * socket endpoint — into the path-free base. Any other path fails.
 */
export const ServerBaseUrl: Schema.Schema<ServerBaseUrl, string> =
  Schema.transformOrFail(
    Schema.String,
    Schema.String.pipe(Schema.brand("ServerBaseUrl")),
    {
      strict: true,
      decode: (value, _options, ast) => {
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
export const serverBaseUrl = Schema.decodeSync(ServerBaseUrl);

/** The socket endpoint a client dials for the given server. */
export const webSocketUrl = (base: ServerBaseUrl): string =>
  base.replace(WS_SCHEME_PREFIX, "ws") + SOCKET_ROUTE;
