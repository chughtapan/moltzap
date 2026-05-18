import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { Data, Effect } from "effect";

import { bootChannelMcpServer, type ServerHandle } from "../server.js";
import { createRoutingState, type RoutingState } from "../routing.js";
import type { ReplyError } from "../errors.js";

export class ServerHarnessError extends Data.TaggedError("ServerHarnessError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface ServerHarnessOptions {
  readonly onSendReply?: (
    conversationId: string,
    text: string,
  ) => Effect.Effect<void, ReplyError>;
}

export interface ServerHarness {
  readonly serverHandle: ServerHandle;
  readonly client: Client;
  readonly routing: RoutingState;
  readonly notifications: Notification[];
}

export function tryHarnessPromise<A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, ServerHarnessError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ServerHarnessError({ operation, cause }),
  });
}

function failHarness(
  operation: string,
  cause: unknown,
): Effect.Effect<never, ServerHarnessError> {
  return Effect.fail(new ServerHarnessError({ operation, cause }));
}

export function setupHarness(
  opts: ServerHarnessOptions = {},
): Effect.Effect<ServerHarness, ServerHarnessError> {
  return Effect.gen(function* () {
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const routing = createRoutingState();

    const sendReply =
      opts.onSendReply ??
      ((_conversationId: string, _text: string) =>
        Effect.succeed(undefined as void));

    const boot = yield* tryHarnessPromise("bootChannelMcpServer", () =>
      bootChannelMcpServer(
        {
          serverName: "test-channel",
          instructions: "test-instructions",
        },
        {
          sendReply,
          routing,
          transportFactory: () => serverTransport,
        },
      ),
    );
    if (boot._tag === "Err") {
      return yield* failHarness("bootChannelMcpServer", boot.error);
    }

    const client = new Client(
      { name: "test-client", version: "0.1.0" },
      { capabilities: {} },
    );
    const notifications: Notification[] = [];
    client.fallbackNotificationHandler = (notification: Notification) => {
      notifications.push(notification);
      return Promise.resolve();
    };

    yield* tryHarnessPromise("client.connect", () =>
      client.connect(clientTransport),
    );

    return {
      serverHandle: boot.value,
      client,
      routing,
      notifications,
    };
  }).pipe(Effect.withSpan("setupHarness"));
}

function ignoreCleanupError(
  operation: string,
): (error: unknown) => Effect.Effect<void> {
  return (error) =>
    Effect.logDebug("claude-code-channel test cleanup failed").pipe(
      Effect.annotateLogs({ operation, error }),
    );
}

export function cleanupHarness(harness: ServerHarness): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* tryHarnessPromise("client.close", () => harness.client.close()).pipe(
      Effect.catchAll(ignoreCleanupError("client.close")),
    );
    yield* harness.serverHandle
      .stop()
      .pipe(Effect.catchAll(ignoreCleanupError("serverHandle.stop")));
  }).pipe(Effect.withSpan("cleanupHarness"));
}

export function withHarness<A>(
  use: (harness: ServerHarness) => Effect.Effect<A, ServerHarnessError>,
  opts?: ServerHarnessOptions,
): Effect.Effect<A, ServerHarnessError> {
  const resolvedOpts = opts ?? {};
  return Effect.gen(function* () {
    const harness = yield* setupHarness(resolvedOpts);
    return yield* use(harness).pipe(Effect.ensuring(cleanupHarness(harness)));
  }).pipe(Effect.withSpan("withHarness"));
}

export function listTools(
  client: Client,
): Effect.Effect<Awaited<ReturnType<Client["listTools"]>>, ServerHarnessError> {
  return tryHarnessPromise("client.listTools", () => client.listTools());
}

export function callTool(
  client: Client,
  request: Parameters<Client["callTool"]>[0],
): Effect.Effect<Awaited<ReturnType<Client["callTool"]>>, ServerHarnessError> {
  return tryHarnessPromise("client.callTool", () => client.callTool(request));
}

export function waitForTransportTick(): Effect.Effect<void, never> {
  return Effect.async<void>((resume) => {
    globalThis.queueMicrotask(() => resume(Effect.void));
  });
}
