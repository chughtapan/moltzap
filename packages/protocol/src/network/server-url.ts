/**
 * @file The MoltZap server base URL and the socket endpoint derived from it.
 *
 * `webSocketUrl` appends the socket route unconditionally, so the two halves
 * of that invariant live together: a value that already carries a path would
 * dial `/ws/ws`, and the resulting socket never opens. `ServerBaseUrl` is the
 * type that makes such a value unconstructible.
 */
import { Schema, type Brand } from "effect";

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
 * Reduce a base or socket URL to scheme and authority.
 *
 * Discarding the socket route loses nothing a client could reach: the route
 * this appends is fixed, so a server published under a path prefix is not
 * addressable through this package at all. Every other path survives here and
 * is rejected by the refinement rather than silently dropped.
 */
const toOrigin = (value: string): string =>
  value.replace(SOCKET_ROUTE_SUFFIX, "").replace(TRAILING_SLASH, "");

const isOrigin = (value: string): boolean => {
  const url = URL.parse(value);
  if (url === null) return false;
  return (
    SERVER_SCHEMES.has(url.protocol) &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
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
export const ServerBaseUrl: Schema.Schema<ServerBaseUrl, string> =
  Schema.transform(
    Schema.String.pipe(
      Schema.filter((value) => isOrigin(toOrigin(value)), {
        message: (issue) =>
          `Expected a MoltZap server base URL (scheme and host, no path), got ${JSON.stringify(issue.actual)}`,
      }),
    ),
    Schema.String.pipe(Schema.brand("ServerBaseUrl")),
    { strict: true, decode: toOrigin, encode: (base) => base },
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
