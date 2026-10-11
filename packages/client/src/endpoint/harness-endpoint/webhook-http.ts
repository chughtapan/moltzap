/** @file Scoped, bounded loopback callback listener for a native semantic endpoint. */

import { Data, Effect, Option, Runtime, type Scope } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- A scoped Node callback listener is the native HTTP transport edge; no daemon handler or authority is loaded into the host.
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { ListenError } from "../../transport/messaging/errors.js";
import { maximumEventBytes } from "../event-contract/index.js";

/** Callback failures carry only an HTTP decision, never credentials or upstream diagnostics. */
export class WebhookRequestError extends Data.TaggedError(
  "WebhookRequestError",
)<{
  readonly status: 400 | 401 | 403 | 404 | 405 | 413 | 503;
}> {}

/** Private HTTP transport projection; it grants no MCP or management operation. */
interface CallbackReply {
  readonly status: number;
  readonly body: string;
}

/** The signed callback edge consumes exact UTF-8 bytes before any semantic handoff. */
export interface CallbackInput {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

interface CallbackServerOptions {
  readonly port: number;
  readonly path: string;
  readonly handle: (
    input: CallbackInput,
  ) => Effect.Effect<CallbackReply, WebhookRequestError>;
}

/**
 * Deployment routes public HTTPS to this private listener. Body, connection and
 * request limits bound work even when a caller has not proved its signature.
 * Closing the enclosing scope interrupts callbacks before releasing the port.
 */
export const acquireCallbackServer: (
  options: CallbackServerOptions,
) => Effect.Effect<number, ListenError, Scope.Scope> = Effect.fn(
  "acquireCallbackServer",
)(function* (options: CallbackServerOptions) {
  const lifetime = yield* Effect.scope;
  const runtime = yield* Effect.runtime();
  const requests = yield* Effect.makeSemaphore(16);
  const listener = makeRequestListener(options, lifetime, runtime, requests);
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The caller's explicit Scope requirement owns listener and callback teardown; closing it early would lose native handoffs.
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => createServer({ maxHeaderSize: 8 * 1024 }, listener)),
    closeServer,
  );
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 16;
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  yield* bind(server, options.port);
  const address = server.address();
  return address === null || typeof address === "string"
    ? yield* Effect.fail(new ListenError({ reason: "transport-failed" }))
    : address.port;
});

function makeRequestListener(
  options: CallbackServerOptions,
  lifetime: Scope.Scope,
  runtime: Runtime.Runtime<never>,
  requests: Effect.Semaphore,
): RequestListener {
  const run = Runtime.runFork(runtime);
  return (request, response): void => {
    const control = new AbortController();
    response.once("close", () => {
      control.abort();
    });
    const work = requests
      .withPermitsIfAvailable(1)(
        serveRequest(options, request, response, control.signal),
      )
      .pipe(
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.void : writeBusy(response),
        ),
      );
    run(work.pipe(Effect.forkIn(lifetime)));
  };
}

function writeBusy(response: ServerResponse) {
  return Effect.sync(() => {
    response.writeHead(503, { connection: "close" });
    response.end();
  });
}

function serveRequest(
  options: CallbackServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
) {
  return callbackInput(options, request, signal).pipe(
    Effect.flatMap(options.handle),
    Effect.timeoutFail({
      duration: "4 seconds",
      onTimeout: () => new WebhookRequestError({ status: 503 }),
    }),
    Effect.match({
      onFailure: ({ status }): CallbackReply => ({
        status,
        body: '{"error":"callback-not-accepted"}',
      }),
      onSuccess: (reply) => reply,
    }),
    Effect.flatMap((reply) => writeReply(response, reply)),
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        response.destroy();
      }),
    ),
  );
}

function callbackInput(
  options: CallbackServerOptions,
  request: IncomingMessage,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    if (request.url !== options.path) {
      return yield* Effect.fail(new WebhookRequestError({ status: 404 }));
    }
    if (request.method !== "POST") {
      return yield* Effect.fail(new WebhookRequestError({ status: 405 }));
    }
    if (
      request.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
    ) {
      return yield* Effect.fail(new WebhookRequestError({ status: 400 }));
    }
    const body = yield* readBody(request);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers[name] = value;
      }
    }
    return { body, headers, signal };
  });
}

function writeReply(response: ServerResponse, reply: CallbackReply) {
  return Effect.sync(() => {
    if (!response.destroyed) {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(reply.body);
    }
  });
}

/** Data listeners are removed on every exit, including byte-limit failure and cancellation. */
function readBody(request: IncomingMessage) {
  return Effect.async<string, WebhookRequestError>((resume) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let complete = false;
    const finish = (
      result: Effect.Effect<string, WebhookRequestError>,
    ): void => {
      if (!complete) {
        complete = true;
        cleanup();
        resume(result);
      }
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maximumEventBytes) {
        finish(Effect.fail(new WebhookRequestError({ status: 413 })));
        request.resume();
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = (): void => {
      finish(
        Effect.try({
          try: () =>
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          catch: () => new WebhookRequestError({ status: 400 }),
        }),
      );
    };
    const onError = (): void => {
      finish(Effect.fail(new WebhookRequestError({ status: 400 })));
    };
    function cleanup(): void {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
    return Effect.sync(cleanup);
  });
}

function bind(server: Server, port: number) {
  // #ignore-sloppy-code-next-line[async-keyword]: Effect's callback constructor wraps the scoped listener's bind operation.
  return Effect.async<undefined, ListenError>((resume) => {
    const onError = (): void => {
      resume(Effect.fail(new ListenError({ reason: "transport-failed" })));
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resume(Effect.succeed(undefined));
    });
    return Effect.sync(() => {
      server.off("error", onError);
    });
  });
}

function closeServer(server: Server): Effect.Effect<void> {
  // #ignore-sloppy-code-next-line[async-keyword]: Effect's callback constructor waits for Node to release the listener.
  return Effect.async<undefined>((resume) => {
    server.closeAllConnections();
    server.close(() => {
      resume(Effect.succeed(undefined));
    });
  });
}
