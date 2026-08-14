/** @file Run-private post-Router delivery interception over raw HTTP. */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import {
  type RouterPollResult as PollResult,
  RouterPollResult,
} from "@moltzap/router";
import canonicalize from "canonicalize";
import { Deferred, Effect, Exit, Runtime, Schema, type Scope } from "effect";
import { Buffer } from "node:buffer";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Raw Node HTTP is required to prove byte and signed-Host transparency at this private transport boundary.
import {
  type ClientRequest,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as requestHttp,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as requestHttps } from "node:https"; // eslint-disable-line agent-code-guard/prefer-effect-platform -- The same raw adapter selects HTTPS for an explicitly HTTPS upstream.
import type { LinkFabric, RoutedLinkDelivery } from "./link-fabric.js";
import { networkError, type NetworkError } from "../network/index.js";

/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-invalid-void-type, agent-code-guard/acquire-release-requires-scope, agent-code-guard/bare-catch, agent-code-guard/effect-promise, agent-code-guard/either-discriminant, agent-code-guard/no-raw-throw-new-error, agent-code-guard/prefer-stepdown-function-order, agent-code-guard/promise-type, agent-code-guard/tag-discriminant -- This run-private raw transport adapter contains Node's Promise/callback lifecycle and defensive parse fallbacks; its exported Effect remains scoped and typed. */

const POLL_PATH = "/v1/messages:poll";
const MAXIMUM_REQUEST_BYTES = 1_048_576;

type PollBatch = Extract<PollResult, { readonly kind: "batch" }>;

const registeredAgentEnvelope = Schema.Struct({
  callerAgentId: AgentId,
  request: Schema.Unknown,
});

/** Explicit listener and advertised Service identity for one proxy. */
export interface RouterFaultProxyInput {
  readonly upstreamRouterOrigin: URL;
  readonly listener: {
    readonly bindHost: string;
    readonly port: number;
    readonly advertisedOrigin?: URL;
  };
  readonly fabric: LinkFabric;
}

/** Address exposed to endpoint daemons by one scoped proxy listener. */
export interface RouterFaultProxy {
  /** Fails when the owned listener errors or closes before scope release. */
  readonly failure: Effect.Effect<never, NetworkError>;
  /** Bound controller-local origin used by controlled endpoint daemons. */
  readonly localRouterOrigin: URL;
  /** Endpoint-facing origin, which may be an in-cluster Service address. */
  readonly routerOrigin: URL;
}

// #ignore-sloppy-code-next-line[promise-type]: Raw Node request handlers consume the body before entering the Effect runtime callback.
function readBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    incoming.on("data", (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length > MAXIMUM_REQUEST_BYTES) {
        incoming.destroy(new Error("proxy request body exceeds its bound"));
        return;
      }
      chunks.push(chunk);
    });
    incoming.once("end", () => resolve(Buffer.concat(chunks, length)));
    incoming.once("error", reject);
  });
}

function callerAgentId(body: Buffer): AgentIdValue | undefined {
  try {
    const text = body.toString("utf8");
    const candidate: unknown = JSON.parse(text);
    if (canonicalize(candidate) !== text) {
      return undefined;
    }
    const decoded = Schema.decodeUnknownEither(registeredAgentEnvelope)(
      candidate,
      { exact: true, onExcessProperty: "error" },
    );
    return decoded._tag === "Right" ? decoded.right.callerAgentId : undefined;
  } catch (cause) {
    void cause;
    return undefined;
  }
}

function requestHeaders(
  incoming: IncomingMessage,
  body: Buffer,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    ...incoming.headers,
    "content-length": String(body.byteLength),
    connection: "close",
  };
  // Host is signed as @authority. Preserve it even though the TCP connection
  // terminates at the actual Router Service.
  if (incoming.headers.host !== undefined) {
    headers.host = incoming.headers.host;
  }
  delete headers["proxy-connection"];
  return headers;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const copied = { ...headers };
  delete copied.connection;
  delete copied["keep-alive"];
  delete copied["transfer-encoding"];
  delete copied.trailer;
  delete copied.upgrade;
  return copied;
}

interface UpstreamResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

function localOrigin(address: URL, bindHost: string): URL {
  const origin = new URL(address);
  if (bindHost === "0.0.0.0") {
    origin.hostname = "127.0.0.1";
  } else if (bindHost === "::" || bindHost === "[::]") {
    origin.hostname = "[::1]";
  }
  return origin;
}

interface PendingUpstreamRequest {
  readonly promise: Promise<UpstreamResponse>; // #ignore-sloppy-code[promise-type]: Node's upstream request callback is retained with its abortable ClientRequest until the scoped Effect awaits it.
  readonly request: ClientRequest;
}

type HandlerCanceler = () => void;

function forward(
  upstream: URL,
  incoming: IncomingMessage,
  body: Buffer,
): PendingUpstreamRequest {
  let outgoing: ClientRequest | undefined;
  const promise = new Promise<UpstreamResponse>((resolve, reject) => {
    const options: RequestOptions = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: incoming.method,
      path: incoming.url,
      headers: requestHeaders(incoming, body),
    };
    const invoke = upstream.protocol === "https:" ? requestHttps : requestHttp;
    outgoing = invoke(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () =>
        resolve({
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
      response.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
  if (outgoing === undefined) {
    throw new Error("proxy did not create its upstream request");
  }
  return { promise, request: outgoing };
}

function decodePollResult(body: Buffer): PollResult | undefined {
  try {
    const text = body.toString("utf8");
    const decoded = Schema.decodeUnknownEither(
      Schema.parseJson(RouterPollResult),
    )(text, { exact: true, onExcessProperty: "error" });
    if (decoded._tag === "Left") {
      return undefined;
    }
    const encoded = Schema.encodeSync(RouterPollResult)(decoded.right);
    return canonicalize(encoded) === text ? decoded.right : undefined;
  } catch (cause) {
    void cause;
    return undefined;
  }
}

function encodeBatch(
  batch: PollBatch,
  deliveries: readonly RoutedLinkDelivery[],
): Buffer {
  const encoded = Schema.encodeSync(RouterPollResult)({
    ...batch,
    signedMessages: deliveries.map(({ message }) => message),
  });
  const text = canonicalize(encoded);
  if (text === undefined) {
    throw new Error("faulted Router batch could not be encoded canonically");
  }
  return Buffer.from(text, "utf8");
}

function decodedPollResponse(
  upstream: UpstreamResponse,
): PollResult | undefined {
  const contentType = upstream.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (upstream.status !== 200 || contentType !== "application/json") {
    return undefined;
  }
  return decodePollResult(upstream.body);
}

function resetChangedRouterInstance(
  fabric: LinkFabric,
  to: AgentIdValue,
  routerInstanceId: string,
  instances: Map<AgentIdValue, string>,
): Effect.Effect<void, NetworkError> {
  const priorInstance = instances.get(to);
  const changed =
    priorInstance !== undefined && priorInstance !== routerInstanceId;
  instances.set(to, routerInstanceId);
  return changed ? fabric.reset(to) : Effect.void;
}

interface BatchTransformation {
  readonly batch: PollBatch;
  readonly reset: Effect.Effect<void, NetworkError>;
  readonly upstream: UpstreamResponse;
}

function transformedBatch(
  fabric: LinkFabric,
  to: AgentIdValue,
  input: BatchTransformation,
): Effect.Effect<UpstreamResponse, NetworkError> {
  return Effect.gen(function* () {
    const active = yield* input.reset.pipe(
      Effect.zipRight(fabric.needsInterception(to)),
    );
    if (!active) {
      return input.upstream;
    }
    const released = yield* fabric.drain(to);
    const routed = yield* fabric.route(
      to,
      input.batch.signedMessages.map((message) => ({ message })),
    );
    const completed = yield* fabric.drain(to);
    const body = encodeBatch(input.batch, [
      ...released,
      ...routed,
      ...completed,
    ]);
    return {
      ...input.upstream,
      body,
      headers: {
        ...input.upstream.headers,
        "content-length": String(body.byteLength),
      },
    };
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.fail(networkError("receive", cause)),
    ),
  );
}

function transformedPoll(
  fabric: LinkFabric,
  to: AgentIdValue,
  upstream: UpstreamResponse,
  instances: Map<AgentIdValue, string>,
): Effect.Effect<UpstreamResponse, NetworkError> {
  const result = decodedPollResponse(upstream);
  if (result === undefined || result.kind === "cursor_invalid") {
    return Effect.succeed(upstream);
  }
  const reset = resetChangedRouterInstance(
    fabric,
    to,
    result.routerInstanceId,
    instances,
  );
  if (result.kind === "feed_gap") {
    return reset.pipe(Effect.as(upstream));
  }
  return transformedBatch(fabric, to, { batch: result, reset, upstream });
}

function handleRequest(
  input: RouterFaultProxyInput,
  incoming: IncomingMessage,
  instances: Map<AgentIdValue, string>,
  requests: Set<ClientRequest>,
): Effect.Effect<UpstreamResponse, unknown> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => readBody(incoming),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((body) => {
        const pending = forward(input.upstreamRouterOrigin, incoming, body);
        requests.add(pending.request);
        return { body, pending };
      }),
    ),
    ({ body, pending }) =>
      Effect.tryPromise({
        try: () => pending.promise,
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((upstream) => {
          if (incoming.method !== "POST" || incoming.url !== POLL_PATH) {
            return Effect.succeed(upstream);
          }
          const to = callerAgentId(body);
          return to === undefined
            ? Effect.succeed(upstream)
            : transformedPoll(input.fabric, to, upstream, instances);
        }),
      ),
    ({ pending }) =>
      Effect.sync(() => {
        requests.delete(pending.request);
        pending.request.destroy();
      }),
  );
}

type HandlerState = "running" | "cancelled" | "completed";

interface ServedRequestState {
  cancelFiber?: HandlerCanceler;
  state: HandlerState;
}

interface HandlerAttachment {
  readonly cancel: HandlerCanceler;
  readonly handlers: Set<HandlerCanceler>;
  readonly response: ServerResponse;
}

function detachHandler(
  response: ServerResponse,
  handlers: Set<HandlerCanceler>,
  cancel: HandlerCanceler,
): void {
  response.off("close", cancel);
  handlers.delete(cancel);
}

function cancelHandler(
  state: ServedRequestState,
  response: ServerResponse,
  handlers: Set<HandlerCanceler>,
  cancel: HandlerCanceler,
): void {
  if (state.state !== "running") {
    return;
  }
  state.state = "cancelled";
  detachHandler(response, handlers, cancel);
  state.cancelFiber?.();
}

function completeHandler(
  state: ServedRequestState,
  attachment: HandlerAttachment,
  exit: Exit.Exit<UpstreamResponse, unknown>,
): void {
  const shouldRespond =
    state.state === "running" && !attachment.response.destroyed;
  state.state = "completed";
  detachHandler(attachment.response, attachment.handlers, attachment.cancel);
  if (!shouldRespond) {
    return;
  }
  if (Exit.isSuccess(exit)) {
    writeResponse(attachment.response, exit.value);
    return;
  }
  if (!attachment.response.headersSent) {
    attachment.response.writeHead(502, { "content-length": "0" });
  }
  attachment.response.end();
}

function serve(
  runtime: Runtime.Runtime<never>,
  effect: Effect.Effect<UpstreamResponse, unknown>,
  response: ServerResponse,
  handlers: Set<HandlerCanceler>,
): void {
  const state: ServedRequestState = { state: "running" };
  function cancel(): void {
    cancelHandler(state, response, handlers, cancel);
  }
  response.once("close", cancel);
  const cancelFiber = Runtime.runCallback(runtime, effect, {
    onExit: (exit) => {
      completeHandler(state, { cancel, handlers, response }, exit);
    },
  });
  state.cancelFiber = cancelFiber;
  if (state.state === "running") {
    handlers.add(cancel);
  } else if (state.state === "cancelled") {
    cancelFiber();
  }
}

function writeResponse(response: ServerResponse, upstream: UpstreamResponse) {
  response.writeHead(upstream.status, responseHeaders(upstream.headers));
  response.end(upstream.body);
}

function closeServer(server: Server): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    server.close(() => resume(Effect.void));
    server.closeAllConnections();
  });
}

function abortRequests(requests: Set<ClientRequest>): void {
  for (const request of requests) {
    request.destroy(new Error("Router fault proxy scope closed"));
  }
  requests.clear();
}

function cancelHandlers(handlers: Set<HandlerCanceler>): void {
  const active = [...handlers];
  handlers.clear();
  for (const cancel of active) {
    cancel();
  }
}

type ListenerState = "binding" | "bound" | "closing" | "failed";

type ResumeBinding = (effect: Effect.Effect<URL, NetworkError>) => void;

class ListenerLifecycle {
  private readonly bindHost: string;
  private readonly failed: Deferred.Deferred<never, NetworkError>;
  private readonly port: number;
  private readonly server: Server;
  private resumeBinding: ResumeBinding = () => undefined;
  private state: ListenerState = "binding";

  constructor(
    server: Server,
    failed: Deferred.Deferred<never, NetworkError>,
    listener: RouterFaultProxyInput["listener"],
  ) {
    this.server = server;
    this.failed = failed;
    this.bindHost = listener.bindHost;
    this.port = listener.port;
  }

  bind(): Effect.Effect<URL, NetworkError> {
    return Effect.async<URL, NetworkError>((resume) => {
      this.resumeBinding = resume;
      this.server.on("error", this.onError);
      this.server.on("close", this.onClose);
      this.server.listen(this.port, this.bindHost, this.onListening);
      return Effect.sync(this.abandonUnownedListener);
    });
  }

  release(
    requests: Set<ClientRequest>,
    handlers: Set<HandlerCanceler>,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      this.state = "closing";
      this.removeObservers();
      abortRequests(requests);
      cancelHandlers(handlers);
    }).pipe(Effect.zipRight(closeServer(this.server)));
  }

  private readonly abandonUnownedListener = (): void => {
    this.state = "closing";
    if (this.server.listening) {
      this.server.close();
    }
  };

  private readonly onClose = (): void => {
    if (this.state === "closing") {
      this.removeObservers();
      return;
    }
    if (this.state === "binding") {
      this.state = "failed";
      this.removeObservers();
      this.resumeBinding(
        Effect.fail(
          networkError(
            "acquire-router",
            "Router fault proxy listener closed while binding",
          ),
        ),
      );
      return;
    }
    if (this.state === "bound") {
      this.state = "failed";
      Effect.runSync(
        Deferred.fail(
          this.failed,
          networkError(
            "receive",
            "Router fault proxy listener closed unexpectedly",
          ),
        ),
      );
    }
  };

  private readonly onError = (cause: Error): void => {
    if (this.state === "closing") {
      this.removeObservers();
      return;
    }
    if (this.state === "binding") {
      this.abandonUnownedListener();
      this.resumeBinding(Effect.fail(networkError("acquire-router", cause)));
      return;
    }
    if (this.state === "bound") {
      this.state = "failed";
      Effect.runSync(
        Deferred.fail(this.failed, networkError("receive", cause)),
      );
    }
  };

  private readonly onListening = (): void => {
    if (this.state !== "binding") {
      if (this.server.listening) {
        this.server.close();
      }
      return;
    }
    const bound = this.server.address();
    if (bound === null || typeof bound === "string") {
      this.abandonUnownedListener();
      this.resumeBinding(
        Effect.fail(
          networkError("acquire-router", "proxy did not bind a TCP port"),
        ),
      );
      return;
    }
    this.state = "bound";
    this.resumeBinding(
      Effect.succeed(new URL(`http://${this.bindHost}:${String(bound.port)}`)),
    );
  };

  private removeObservers(): void {
    this.server.off("error", this.onError);
    this.server.off("close", this.onClose);
  }
}

interface ProxyRequestContext {
  readonly handlers: Set<HandlerCanceler>;
  readonly input: RouterFaultProxyInput;
  readonly instances: Map<AgentIdValue, string>;
  readonly requests: Set<ClientRequest>;
  readonly runtime: Runtime.Runtime<never>;
}

function requestListener(
  context: ProxyRequestContext,
): (incoming: IncomingMessage, response: ServerResponse) => void {
  return (incoming, response) => {
    serve(
      context.runtime,
      handleRequest(
        context.input,
        incoming,
        context.instances,
        context.requests,
      ),
      response,
      context.handlers,
    );
  };
}

/**
 * Start one raw reverse proxy in the current run scope.
 * @param input Upstream Router, listener identity, and run-owned fault fabric.
 * @returns The controller-local and endpoint-facing proxy origins.
 */
export function makeRouterFaultProxy(
  input: RouterFaultProxyInput,
): Effect.Effect<RouterFaultProxy, NetworkError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const runtime = yield* restore(Effect.runtime());
      const instances = new Map<AgentIdValue, string>();
      const requests = new Set<ClientRequest>();
      const handlers = new Set<HandlerCanceler>();
      const failed = yield* Deferred.make<never, NetworkError>();
      const server = createServer(
        requestListener({ handlers, input, instances, requests, runtime }),
      );
      const lifecycle = new ListenerLifecycle(server, failed, input.listener);
      const bound = yield* restore(lifecycle.bind()).pipe(Effect.exit);
      if (Exit.isFailure(bound)) {
        return yield* Effect.failCause(bound.cause);
      }
      yield* Effect.addFinalizer(() => lifecycle.release(requests, handlers));
      const address = bound.value;
      return Object.freeze({
        failure: Deferred.await(failed),
        localRouterOrigin: localOrigin(address, input.listener.bindHost),
        routerOrigin: new URL(input.listener.advertisedOrigin ?? address),
      });
    }),
  ).pipe(
    Effect.mapError((cause) => networkError("acquire-router", cause)),
    Effect.withSpan("makeRouterFaultProxy"),
  );
}

/** Acquire the scoped endpoint-facing proxy for one policy fabric. */
export const acquireRouterFaultProxy = makeRouterFaultProxy;

/* eslint-enable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-invalid-void-type, agent-code-guard/acquire-release-requires-scope, agent-code-guard/bare-catch, agent-code-guard/effect-promise, agent-code-guard/either-discriminant, agent-code-guard/no-raw-throw-new-error, agent-code-guard/prefer-stepdown-function-order, agent-code-guard/promise-type, agent-code-guard/tag-discriminant -- restore project limits after the raw transport adapter. */
