/**
 * @file Adds the one Client-owned turn subscription to the official MCP
 * handler while leaving every standard MCP request with the SDK delegate.
 */

import {
  classifyInboundRequest,
  CLIENT_CAPABILITIES_META_KEY,
  type Implementation,
  isJsonContentType,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  MissingRequiredClientCapabilityError,
  type RequestId,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import {
  HARNESS_EVENTS_EXTENSION,
  HARNESS_TURN_READY_FILTER,
  HARNESS_TURN_READY_NOTIFICATION,
} from "./harness-runtime.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The official MCP fetch boundary and retained POST stream are Promise-native. */

const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
const SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION =
  "notifications/subscriptions/acknowledged";
const JSON_RPC_VERSION = "2.0";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const INTERNAL_ERROR = -32603;
const SUBSCRIPTION_IN_USE = -32000;
const BAD_REQUEST_STATUS = 400;
const CONFLICT_STATUS = 409;
const INTERNAL_ERROR_STATUS = 500;
const OK_STATUS = 200;

type JsonObject = Readonly<Record<string, unknown>>;

interface HarnessMcpSubscriptionOptions {
  readonly delegate: McpHttpHandler;
  readonly implementation: Implementation;
  readonly onActiveChange?: (active: boolean) => void;
  readonly onerror?: (error: Error) => void;
}

/** Official MCP handler augmented by the sole daemon attention sink. */
export interface HarnessMcpSubscriptionHandler<Payload extends object>
  extends McpHttpHandler {
  /** Whether one accepted reply-capable listener currently owns the daemon. */
  readonly hasActiveSubscription: () => boolean;
  /** Write one complete event frame to the current listener, if it still exists. */
  readonly publish: (payload: Payload) => boolean;
}

interface CustomListenRequest {
  readonly id: RequestId;
  readonly hasRequiredCapability: boolean;
}

interface ActiveSubscription {
  readonly id: RequestId;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  abortCleanup?: () => void;
  closed: boolean;
}

interface JsonRpcErrorOptions {
  readonly status: number;
  readonly id: RequestId;
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonRpcError = (options: JsonRpcErrorOptions): Response =>
  Response.json(
    {
      jsonrpc: JSON_RPC_VERSION,
      error: {
        code: options.code,
        message: options.message,
        ...(options.data === undefined ? {} : { data: options.data }),
      },
      id: options.id,
    },
    { status: options.status },
  );

// #ignore-sloppy-code-next-line[async-keyword]: The Fetch Request.json boundary is Promise-native.
const readRequestBody = async (
  request: Request,
  options?: McpHandlerRequestOptions,
  // #ignore-sloppy-code-next-line[promise-type]: The Fetch Request.json boundary is Promise-native.
): Promise<unknown> => {
  if (options?.parsedBody !== undefined) {
    return options.parsedBody;
  }
  return await request
    .clone()
    .json()
    .catch(() => undefined);
};

const modernListenMessage = (request: Request, body: unknown) => {
  const outcome = classifyInboundRequest({
    httpMethod: request.method.toUpperCase(),
    protocolVersionHeader:
      request.headers.get("mcp-protocol-version") ?? undefined,
    mcpMethodHeader: request.headers.get("mcp-method") ?? undefined,
    mcpNameHeader: request.headers.get("mcp-name") ?? undefined,
    body,
  });
  if (
    outcome.kind !== "modern" ||
    outcome.messageKind !== "request" ||
    outcome.classification.revision !== MODERN_PROTOCOL_VERSION ||
    outcome.message.method !== SUBSCRIPTIONS_LISTEN_METHOD
  ) {
    return undefined;
  }
  return outcome.message;
};

const requiredCapabilityDeclared = (params: JsonObject): boolean => {
  const metadata = params._meta;
  if (!isJsonObject(metadata)) {
    return false;
  }
  const capabilities = metadata[CLIENT_CAPABILITIES_META_KEY];
  return (
    isJsonObject(capabilities) &&
    isJsonObject(capabilities.extensions) &&
    Object.hasOwn(capabilities.extensions, HARNESS_EVENTS_EXTENSION)
  );
};

const customListenRequest = (
  request: Request,
  body: unknown,
): CustomListenRequest | undefined => {
  const message = modernListenMessage(request, body);
  if (message === undefined || !isJsonObject(message.params)) {
    return undefined;
  }
  const notifications = message.params.notifications;
  const notificationKeys = isJsonObject(notifications)
    ? Object.keys(notifications)
    : [];
  if (
    !isJsonObject(notifications) ||
    notificationKeys.length !== 1 ||
    notificationKeys[0] !== HARNESS_TURN_READY_FILTER ||
    notifications[HARNESS_TURN_READY_FILTER] !== true
  ) {
    return undefined;
  }
  return {
    id: message.id,
    hasRequiredCapability: requiredCapabilityDeclared(message.params),
  };
};

const shouldInspect = (request: Request): boolean =>
  request.method.toUpperCase() === "POST" &&
  isJsonContentType(request.headers.get("content-type")) &&
  request.headers.get("mcp-method") === SUBSCRIPTIONS_LISTEN_METHOD;

class HarnessMcpSubscriptionState<Payload extends object> {
  private readonly delegate: McpHttpHandler;
  private readonly implementation: Implementation;
  private readonly onActiveChange?: (active: boolean) => void;
  private readonly onerror?: (error: Error) => void;
  private readonly encoder = new TextEncoder();
  private active?: ActiveSubscription;
  private closed = false;
  private closePromise?: Promise<void>; // #ignore-sloppy-code[promise-type]: This retains the Promise-native MCP handler close result.

  constructor(options: HarnessMcpSubscriptionOptions) {
    this.delegate = options.delegate;
    this.implementation = options.implementation;
    this.onActiveChange = options.onActiveChange;
    this.onerror = options.onerror;
  }

  // #ignore-sloppy-code-next-line[async-keyword]: The official MCP fetch interface is Promise-native.
  readonly fetch: McpHttpHandler["fetch"] = async (request, options) => {
    if (this.closed || !shouldInspect(request)) {
      return options === undefined
        ? await this.delegate.fetch(request)
        : await this.delegate.fetch(request, options);
    }
    const body =
      options === undefined
        ? await readRequestBody(request)
        : await readRequestBody(request, options);
    const listenRequest = customListenRequest(request, body);
    if (!this.closed && listenRequest !== undefined) {
      return this.serve(request, listenRequest);
    }
    return options === undefined
      ? await this.delegate.fetch(request)
      : await this.delegate.fetch(request, options);
  };

  readonly hasActiveSubscription = (): boolean =>
    this.active !== undefined && !this.active.closed;

  readonly publish = (payload: Payload): boolean => {
    const subscription = this.active;
    if (subscription === undefined || subscription.closed) {
      return false;
    }
    const published = this.enqueueMessage(subscription, {
      jsonrpc: JSON_RPC_VERSION,
      method: HARNESS_TURN_READY_NOTIFICATION,
      params: {
        ...payload,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: subscription.id },
      },
    });
    if (!published) {
      this.teardown(subscription, false);
    }
    return published;
  };

  // #ignore-sloppy-code-next-line[promise-type]: The official MCP close interface requires a Promise.
  readonly close = (): Promise<void> => {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    if (this.active !== undefined) {
      this.teardown(this.active, true);
    }
    this.closePromise = this.delegate.close();
    return this.closePromise;
  };

  asHandler(): HarnessMcpSubscriptionHandler<Payload> {
    return {
      fetch: this.fetch,
      close: this.close,
      hasActiveSubscription: this.hasActiveSubscription,
      publish: this.publish,
      notify: this.delegate.notify,
      bus: this.delegate.bus,
    };
  }

  private serve(
    request: Request,
    listenRequest: CustomListenRequest,
  ): Response {
    const refusal = this.admissionRefusal(listenRequest);
    if (refusal !== undefined) {
      return refusal;
    }
    const subscription: ActiveSubscription = {
      id: listenRequest.id,
      closed: false,
    };
    this.active = subscription;
    const readable = this.makeReadable(request, subscription);
    if (readable === undefined) {
      return jsonRpcError({
        status: INTERNAL_ERROR_STATUS,
        id: listenRequest.id,
        code: INTERNAL_ERROR,
        message: "Internal server error",
      });
    }
    return new Response(readable, {
      status: OK_STATUS,
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
      },
    });
  }

  private admissionRefusal(
    listenRequest: CustomListenRequest,
  ): Response | undefined {
    if (!listenRequest.hasRequiredCapability) {
      const error = new MissingRequiredClientCapabilityError({
        requiredCapabilities: {
          extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
        },
      });
      return jsonRpcError({
        status: BAD_REQUEST_STATUS,
        id: listenRequest.id,
        code: error.code,
        message: error.message,
        data: error.data,
      });
    }
    return this.active === undefined
      ? undefined
      : jsonRpcError({
          status: CONFLICT_STATUS,
          id: listenRequest.id,
          code: SUBSCRIPTION_IN_USE,
          message: "Subscription already active",
          data: { reason: "subscription-in-use" },
        });
  }

  private makeReadable(
    request: Request,
    subscription: ActiveSubscription,
  ): ReadableStream<Uint8Array> | undefined {
    try {
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.start(request, subscription, controller);
        },
        cancel: () => {
          this.teardown(subscription, false);
        },
      });
    } catch (error) {
      this.teardown(subscription, false);
      this.reportError(error);
      return undefined;
    }
  }

  private start(
    request: Request,
    subscription: ActiveSubscription,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    subscription.controller = controller;
    if (request.signal.aborted) {
      this.teardown(subscription, false);
      return;
    }
    const onAbort = (): void => {
      this.teardown(subscription, false);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    subscription.abortCleanup = () => {
      request.signal.removeEventListener("abort", onAbort);
    };
    if (!this.enqueueMessage(subscription, this.ackMessage(subscription.id))) {
      this.teardown(subscription, false);
      return;
    }
    this.notifyActiveChange(true);
  }

  private teardown(subscription: ActiveSubscription, graceful: boolean): void {
    if (subscription.closed) {
      return;
    }
    if (graceful) {
      this.enqueueMessage(subscription, this.completeMessage(subscription.id));
    }
    subscription.closed = true;
    subscription.abortCleanup?.();
    if (this.active === subscription) {
      this.active = undefined;
      this.notifyActiveChange(false);
    }
    try {
      subscription.controller?.close();
    } catch (error) {
      this.reportError(error);
    }
  }

  private enqueueMessage(
    subscription: ActiveSubscription,
    message: JsonObject,
  ): boolean {
    if (subscription.closed || subscription.controller === undefined) {
      return false;
    }
    try {
      subscription.controller.enqueue(
        this.encoder.encode(`data: ${JSON.stringify(message)}\n\n`),
      );
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private notifyActiveChange(active: boolean): void {
    try {
      this.onActiveChange?.(active);
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.onerror === undefined) {
      return;
    }
    try {
      this.onerror(error instanceof Error ? error : new Error(String(error)));
    } catch (reportingError) {
      // Error reporting is observational and cannot own stream lifecycle.
      console.error("Harness MCP error reporter failed", reportingError);
    }
  }

  private ackMessage(id: RequestId): JsonObject {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: SUBSCRIPTIONS_ACKNOWLEDGED_NOTIFICATION,
      params: {
        notifications: { [HARNESS_TURN_READY_FILTER]: true },
        _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
      },
    };
  }

  private completeMessage(id: RequestId): JsonObject {
    return {
      jsonrpc: JSON_RPC_VERSION,
      id,
      result: {
        resultType: "complete",
        _meta: {
          [SUBSCRIPTION_ID_META_KEY]: id,
          [SERVER_INFO_META_KEY]: this.implementation,
        },
      },
    };
  }
}

/**
 * Compose the one custom listen route in front of the official MCP handler.
 * @param options Official delegate, server identity, and lifecycle callbacks.
 * @returns The delegated MCP surface plus the private turn publisher.
 */
export const makeHarnessMcpSubscriptionHandler = <Payload extends object>(
  options: HarnessMcpSubscriptionOptions,
): HarnessMcpSubscriptionHandler<Payload> =>
  new HarnessMcpSubscriptionState<Payload>(options).asHandler();

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore repository defaults after the Promise-native MCP boundary. */
