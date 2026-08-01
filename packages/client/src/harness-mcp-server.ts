import {
  type FetchLikeMcpHandler,
  type NodeMcpRequestHandler,
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The official MCP Node adapter supplies a Node RequestListener, so this package-private process boundary must host that exact interface.
import {
  createServer,
  type RequestListener,
  type Server as NodeHttpServer,
} from "node:http";
import { Effect, type Scope } from "effect";

const REGISTER_MCP_PATH = "/register/mcp";
const HARNESS_MCP_PATH = "/mcp";
const POST_METHOD = "POST";
const LOOPBACK_HOST = "127.0.0.1";

interface HarnessMcpHttpServerOptions {
  readonly port: number;
  readonly registrationHandler: FetchLikeMcpHandler;
  readonly harnessHandler: FetchLikeMcpHandler;
}

const respond = (
  status: number,
  body: string,
  response: Parameters<RequestListener>[1],
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(body);
};

/**
 * Routes the daemon's two loopback MCP surfaces through one Node listener.
 *
 * @param registrationHandler Official SDK handler for registration.
 * @param harnessHandler Official SDK handler for the active agent surface.
 * @returns A guarded Node request listener for both handlers.
 */
const makeHarnessMcpRequestListener = (
  registrationHandler: FetchLikeMcpHandler,
  harnessHandler: FetchLikeMcpHandler,
): RequestListener => {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const registrationNodeHandler = toNodeHandler(registrationHandler);
  const harnessNodeHandler = toNodeHandler(harnessHandler);
  const handlers: ReadonlyMap<string, NodeMcpRequestHandler> = new Map([
    [REGISTER_MCP_PATH, registrationNodeHandler],
    [HARNESS_MCP_PATH, harnessNodeHandler],
  ]);

  return (request, response): void => {
    if (
      !validateHost(request, response) ||
      !validateOrigin(request, response)
    ) {
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const handler = handlers.get(pathname);

    if (handler === undefined) {
      respond(404, "Not found.", response);
      return;
    }

    if (request.method !== POST_METHOD) {
      respond(405, "Method not allowed.", response, { allow: POST_METHOD });
      return;
    }

    handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  };
};

const listen = (
  options: HarnessMcpHttpServerOptions,
): Effect.Effect<NodeHttpServer, Error> =>
  Effect.async<NodeHttpServer, Error>((resume) => {
    const server = createServer(
      makeHarnessMcpRequestListener(
        options.registrationHandler,
        options.harnessHandler,
      ),
    );
    const onError = (error: Error): void => {
      resume(Effect.fail(error));
    };
    server.once("error", onError);
    server.listen(options.port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      if (server.listening) {
        server.close();
      }
    });
  });

const close = (server: NodeHttpServer): Effect.Effect<undefined> =>
  Effect.async<undefined>((resume) => {
    if (!server.listening) {
      resume(Effect.succeed(undefined));
      return;
    }
    server.close((error) => {
      resume(
        error === undefined
          ? Effect.succeed(undefined)
          : Effect.logWarning(
              "Harness MCP HTTP server close failed",
              error,
            ).pipe(Effect.as(undefined)),
      );
    });
  });

/**
 * Acquires the guarded loopback HTTP server for one explicitly supplied port.
 * The caller owns port selection and keeps the returned server alive by
 * retaining the enclosing Scope.
 *
 * @param options Existing MCP handlers and caller-resolved listener port.
 * @returns The listening Node HTTP server.
 */
export const acquireHarnessMcpHttpServer = (
  options: HarnessMcpHttpServerOptions,
): Effect.Effect<NodeHttpServer, Error, Scope.Scope> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- this package-private helper returns the scoped acquisition to its process owner
  Effect.acquireRelease(listen(options), close);
