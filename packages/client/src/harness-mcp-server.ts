import {
  type FetchLikeMcpHandler,
  type NodeMcpRequestHandler,
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The official MCP Node adapter supplies a Node RequestListener, so this package-private process boundary must host that exact interface.
import {
  createServer,
  type RequestListener,
  type Server as NodeHttpServer,
} from "node:http";
import { Deferred, Effect, Exit, type Scope } from "effect";

const REGISTER_MCP_PATH = "/register/mcp";
const HARNESS_MCP_PATH = "/mcp";
const POST_METHOD = "POST";
const LOOPBACK_HOST = "127.0.0.1";

interface HarnessMcpHttpServerOptions {
  readonly port: number;
  readonly registrationHandler: McpHttpHandler;
  readonly harnessHandler: McpHttpHandler;
}

interface HarnessMcpRequestListener {
  readonly listener: RequestListener;
  readonly waitForResponses: Effect.Effect<undefined>;
}

interface RunningHarnessMcpHttpServer {
  readonly server: NodeHttpServer;
  readonly waitForResponses: Effect.Effect<undefined>;
}

interface ResponseTracker {
  readonly track: (
    response: ReturnType<NodeMcpRequestHandler>,
    nodeResponse: Parameters<RequestListener>[1],
  ) => void;
  readonly waitForResponses: Effect.Effect<undefined>;
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

const makeResponseTracker = (): ResponseTracker => {
  const inFlight = new Set<ReturnType<NodeMcpRequestHandler>>();
  const responseWaiters = new Set<() => void>();
  const finish = (response: ReturnType<NodeMcpRequestHandler>): void => {
    inFlight.delete(response);
    if (inFlight.size === 0) {
      for (const resume of responseWaiters) {
        resume();
      }
      responseWaiters.clear();
    }
  };

  return {
    track: (response, nodeResponse) => {
      inFlight.add(response);
      Effect.runFork(
        Effect.tryPromise({
          try: () => response,
          catch: (error) => error,
        }).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              nodeResponse.destroy(error instanceof Error ? error : undefined);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              finish(response);
            }),
          ),
        ),
      );
    },
    waitForResponses: Effect.async<undefined>((resume) => {
      if (inFlight.size === 0) {
        resume(Effect.succeed(undefined));
        return;
      }
      const done = (): void => {
        resume(Effect.succeed(undefined));
      };
      responseWaiters.add(done);
      return Effect.sync(() => {
        responseWaiters.delete(done);
      });
    }),
  };
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
): HarnessMcpRequestListener => {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const registrationNodeHandler = toNodeHandler(registrationHandler);
  const harnessNodeHandler = toNodeHandler(harnessHandler);
  const responses = makeResponseTracker();
  const handlers: ReadonlyMap<string, NodeMcpRequestHandler> = new Map([
    [REGISTER_MCP_PATH, registrationNodeHandler],
    [HARNESS_MCP_PATH, harnessNodeHandler],
  ]);

  const listener: RequestListener = (request, response): void => {
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

    responses.track(handler(request, response), response);
  };

  return {
    listener,
    waitForResponses: responses.waitForResponses,
  };
};

const listen = (
  options: HarnessMcpHttpServerOptions,
): Effect.Effect<RunningHarnessMcpHttpServer, Error> =>
  Effect.async<RunningHarnessMcpHttpServer, Error>((resume) => {
    const requests = makeHarnessMcpRequestListener(
      options.registrationHandler,
      options.harnessHandler,
    );
    const server = createServer(requests.listener);
    const onError = (error: Error): void => {
      resume(Effect.fail(error));
    };
    server.once("error", onError);
    server.listen(options.port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resume(
        Effect.succeed({
          server,
          waitForResponses: requests.waitForResponses,
        }),
      );
    });
    return Effect.async<undefined>((cancelResume) => {
      server.off("error", onError);
      const onClose = (): void => {
        cancelResume(Effect.succeed(undefined));
      };
      server.once("close", onClose);
      try {
        server.close();
      } catch (error) {
        server.off("close", onClose);
        cancelResume(
          Effect.logWarning("Harness MCP startup cancellation failed").pipe(
            Effect.annotateLogs({ error: String(error) }),
            Effect.as(undefined),
          ),
        );
      }
    });
  });

const beginClose = (
  server: NodeHttpServer,
): Effect.Effect<Effect.Effect<undefined>> =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<Error | undefined>();
    yield* Effect.sync(() => {
      server.close((error) => {
        Effect.runSync(Deferred.succeed(completion, error));
      });
    });
    return Deferred.await(completion).pipe(
      Effect.flatMap((error) =>
        error === undefined
          ? Effect.succeed(undefined)
          : Effect.logWarning(
              "Harness MCP HTTP server close failed",
              error,
            ).pipe(Effect.as(undefined)),
      ),
    );
  });

const closeHandler = (handler: McpHttpHandler): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => handler.close(),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning("Harness MCP handler close failed").pipe(
        Effect.annotateLogs({ error: String(error) }),
      ),
    ),
    Effect.asVoid,
  );

const closeHandlers = (
  options: HarnessMcpHttpServerOptions,
): Effect.Effect<void> =>
  Effect.forEach(
    new Set([options.registrationHandler, options.harnessHandler]),
    closeHandler,
    { concurrency: 2, discard: true },
  );

const release = (
  running: RunningHarnessMcpHttpServer,
  options: HarnessMcpHttpServerOptions,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const closeCompletion = yield* beginClose(running.server);
    yield* closeHandlers(options);
    // Handler closure finishes the Web stream before the Node adapter drains
    // it. Once every tracked response has drained, only residual keep-alive
    // connections remain, and they must not hold daemon shutdown open.
    yield* running.waitForResponses;
    running.server.closeAllConnections();
    yield* closeCompletion;
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
  Effect.acquireRelease(
    listen(options).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : closeHandlers(options),
      ),
    ),
    (running) => release(running, options),
  ).pipe(Effect.map((running) => running.server));
