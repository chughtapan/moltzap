/**
 * entry — public boot entry point for `@moltzap/claude-code-channel`.
 *
 * Wires `MoltZapService` + `MoltZapChannelCore` + the MCP stdio server into
 * a single `Handle`. Mirrors `~/moltzap/packages/openclaw-channel/src/openclaw-entry.ts`
 * as the precedent for "wrap client primitives + host plugin shape."
 *
 * Spec A2: `bootClaudeCodeChannel` returns a `BootResult` wrapped in a promise.
 */

import {
  MoltZapChannelCore,
  MoltZapService,
  type EnrichedInboundMessage,
} from "@moltzap/client";
import { Effect, Either } from "effect";
import { toClaudeChannelNotification } from "./event.js";
import { createRoutingState, type RoutingTarget } from "./routing.js";
import {
  bootChannelMcpServer,
  type ServerBootResult,
  type ServerHandle,
} from "./server.js";
import type { BootOptions, Handle } from "./types.js";
import {
  AgentKeyInvalid,
  LeaseAlreadyConsumed,
  McpTransportFailed,
  SendFailed,
  type BootError,
  type ReplyError,
} from "./errors.js";
import { catchLeaseInvalid } from "@moltzap/client/channel-base";
import { stringifyCause } from "./utils.js";

export type BootResult =
  | { readonly _tag: "Ok"; readonly value: Handle }
  | { readonly _tag: "Err"; readonly error: BootError };

const DEFAULT_SERVER_NAME = "@moltzap/claude-code-channel";
const DEFAULT_INSTRUCTIONS =
  'MoltZap messages arrive as <channel source="moltzap" chat_id="..." message_id="..." user="..." ts="...">. ' +
  "Reply with the reply tool. Pass reply_to=<message_id> to target a specific conversation; omit to reply to the most recent inbound.";

function bootErrorResult(error: BootError): BootResult {
  return { _tag: "Err", error };
}

function validateBootOptions(opts: BootOptions): BootError | null {
  if (typeof opts.agentKey !== "string" || opts.agentKey.trim().length === 0) {
    return new AgentKeyInvalid({
      cause: "agentKey must be a non-empty string",
    });
  }
  if (
    typeof opts.serverUrl !== "string" ||
    opts.serverUrl.trim().length === 0
  ) {
    return new AgentKeyInvalid({
      cause: "serverUrl must be a non-empty string",
    });
  }
  return null;
}

function makeSendReply(core: MoltZapChannelCore) {
  return (target: RoutingTarget, text: string) =>
    core.sendReply(target.taskId, target.conversationId, text).pipe(
      // Cutover #533 single-use lease semantics: the server returns
      // a typed `RpcServerError` whose `data.reason === "LeaseInvalid"`
      // when the recipient tries to consume an already-consumed lease
      // (multi-turn agent calls reply twice in one dispatch). The
      // channel-base `catchLeaseInvalid` reads `Clock.currentTimeMillis`
      // and projects onto `LeaseAlreadyConsumed` BEFORE the generic
      // `mapError` collapses everything else into `SendFailed`. Server.ts
      // surfaces the typed error as `toolErrorResult("LeaseAlreadyConsumed: ...")`.
      //
      // No `leaseId` ctx is supplied here; the wire payload does not carry
      // one, so the projected error falls back to "(unknown)".
      catchLeaseInvalid(),
      Effect.mapError(
        (cause): ReplyError =>
          cause instanceof LeaseAlreadyConsumed
            ? cause
            : new SendFailed({
                cause: stringifyCause(cause),
              }),
      ),
    );
}

function logNotificationPushFailure(
  messageId: string,
  err: unknown,
): Effect.Effect<void> {
  const message = "claude-code-channel: notification push failed";
  return Effect.logWarning(message).pipe(
    Effect.annotateLogs({ err: stringifyCause(err), messageId }),
  );
}

function pushInboundNotification(
  serverHandle: ServerHandle,
  notification: Parameters<ServerHandle["push"]>[0],
  messageId: string,
): Effect.Effect<void> {
  return serverHandle
    .push(notification)
    .pipe(Effect.catchAll((err) => logNotificationPushFailure(messageId, err)));
}

function logGateDropped(error: unknown): Effect.Effect<void> {
  const message = "claude-code-channel: gateInbound dropped event";
  return Effect.logInfo(message).pipe(
    Effect.annotateLogs({ error: stringifyCause(error) }),
  );
}

function logTranslationFailed(
  error: unknown,
  messageId: string,
): Effect.Effect<void> {
  const message = "claude-code-channel: translation failed, dropping event";
  return Effect.logWarning(message).pipe(
    Effect.annotateLogs({ error: stringifyCause(error), messageId }),
  );
}

function serverBootFailure(
  error: Extract<ServerBootResult, { readonly _tag: "Err" }>["error"],
): McpTransportFailed {
  return new McpTransportFailed({
    cause: `${error._tag}: ${error.cause}`,
  });
}

function bootMcpServerHandle(
  opts: BootOptions,
  sendReply: ReturnType<typeof makeSendReply>,
  routing: ReturnType<typeof createRoutingState>,
): Effect.Effect<ServerHandle, BootError> {
  return Effect.tryPromise({
    try: () =>
      bootChannelMcpServer(
        {
          serverName: opts.serverName ?? DEFAULT_SERVER_NAME,
          instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
        },
        {
          sendReply,
          routing,
          ...(opts._testTransportFactory !== undefined
            ? { transportFactory: opts._testTransportFactory }
            : {}),
        },
      ),
    catch: (cause): BootError =>
      new McpTransportFailed({
        cause: stringifyCause(cause),
      }),
  }).pipe(
    Effect.flatMap((serverBoot) =>
      serverBoot._tag === "Err"
        ? Effect.fail(serverBootFailure(serverBoot.error))
        : Effect.succeed(serverBoot.value),
    ),
  );
}

/**
 * Inbound MoltZap message → Claude push pipeline. Registered as a
 * `MoltZapChannelCore.onInbound` callback at boot step 7. Drops
 * silently on allowlist failure, schema decode failure, or MCP push
 * failure (per Spec I5).
 *
 * ```mermaid
 * sequenceDiagram
 *   participant WS as MoltZap server
 *   participant client as moltzap-client
 *   participant H as handleInboundMessage
 *   participant ev as event.ts
 *   participant srv as server.ts
 *   participant CC as Claude Code
 *   WS-->>client: WS frame → MoltZapChannelCore
 *   client->>H: onInbound(enriched)
 *   H->>H: [A] opts.gateInbound (if present)&lt;br>Failure → logGateDropped, return
 *   H->>ev: [B] toClaudeChannelNotification
 *   ev-->>H: Err ContentEmpty | MetaInvalid → log, return&lt;br>Ok notification
 *   H->>H: [C] routing.recordInbound(message_id, chat_id)
 *   H->>srv: [D] serverHandle.push(notification)
 *   alt initialized
 *     srv-->>CC: MCP notifications/claude/channel frame
 *   else pre-handshake
 *     note over srv: state.pending.push (flushed at oninitialized)
 *   end
 * ```
 *
 * Step D is the foreign-protocol bridge: moltzap's wire shape
 * (`EnrichedInboundMessage`) becomes an MCP
 * `notifications/claude/channel` frame the MCP SDK serializes over
 * stdio.
 */
function handleInboundMessage(
  opts: BootOptions,
  routing: ReturnType<typeof createRoutingState>,
  serverHandle: ServerHandle,
  enriched: EnrichedInboundMessage,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const gated = opts.gateInbound
      ? opts.gateInbound(enriched)
      : ({ _tag: "Success", value: enriched } as const);
    if (gated._tag === "Failure") {
      yield* logGateDropped(gated.error);
      return;
    }
    const translated = toClaudeChannelNotification(gated.value);
    if (translated._tag === "Err") {
      yield* logTranslationFailed(translated.error, enriched.id);
      return;
    }
    routing.recordInbound(translated.value.params.meta.message_id, {
      taskId: enriched.taskId,
      conversationId: translated.value.params.meta.chat_id,
    });
    yield* pushInboundNotification(serverHandle, translated.value, enriched.id);
  });
}

function connectCore(
  core: MoltZapChannelCore,
  serverHandle: ServerHandle,
): Effect.Effect<void, BootError> {
  return core.connect().pipe(Effect.tapError(() => serverHandle.stop()));
}

/**
 * Construct the `Handle` returned to the caller on successful boot.
 * `Handle.stop()` is the only graceful-shutdown entry point.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Caller as Caller / OS
 *   participant H as Handle
 *   participant cli as moltzap-client
 *   participant srv as server.ts
 *   Caller->>H: Handle.stop()
 *   H->>cli: [1] core.disconnect()&lt;br>WS close, deregister onInbound
 *   cli-->>H: done
 *   H->>srv: [2] serverHandle.stop()&lt;br>closeMcpServer → server.close()&lt;br>MCP SDK closes stdio transport
 *   srv-->>H: done (close failure → log, never propagate)
 *   H-->>Caller: Effect&lt;void> (infallible)
 * ```
 *
 * Boot-time connect failure path: `connectCore()` fails →
 * `serverHandle.stop()` called via `Effect.tapError`, BootResult Err
 * returned before any Handle is issued.
 *
 * CLI SIGTERM path: no explicit signal handler in v1. Node default
 * kills the process; stdio transport closes via process exit; the
 * server observes the WS disconnect and expires the agent's
 * session. Pending notifications in `state.pending[]` are lost if
 * MCP handshake hadn't completed — acceptable because Claude is
 * closing too.
 */
function makeHandle(
  core: MoltZapChannelCore,
  serverHandle: ServerHandle,
): Handle {
  return {
    push: serverHandle.push,
    stop: () =>
      Effect.gen(function* () {
        yield* core.disconnect();
        yield* serverHandle.stop();
      }),
  };
}

/**
 * Boot a Claude Code channel. Single public entry point of the package.
 *
 * Error channel is tagged (Principle 3). Internals run on Effect; the
 * `Promise` wrapper lives only at this boundary.
 */

/**
 * Single public entry point. In production the CLI binary
 * (`cli.ts`) calls this; tests call it directly with an injected
 * in-memory MCP transport.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Caller
 *   participant entry
 *   participant server as server.ts
 *   participant client as moltzap-client
 *   Caller->>entry: bootClaudeCodeChannel(opts)
 *   note over entry: [1] validateBootOptions (agentKey, serverUrl)
 *   entry->>client: [2] new MoltZapService
 *   entry->>client: [3] new MoltZapChannelCore
 *   note over entry: [4] createRoutingState
 *   note over entry: [5] makeSendReply(core)
 *   entry->>server: [6] bootChannelMcpServer
 *   note over server: [6a] makeMcpServer&lt;br>capabilities: tools + experimental claude/channel
 *   note over server: [6b] registerServerHandlers&lt;br>(ListTools, CallTool)
 *   note over server: [6c] connectServer&lt;br>StdioServerTransport.connect
 *   note over server: [6d] server.oninitialized → flush pending buffer
 *   server-->>entry: [6e] ServerHandle { push, stop }
 *   note over entry: [7] core.onInbound(handleInboundMessage)
 *   entry->>client: [8] connectCore — WS auth handshake
 *   note over entry: [9] makeHandle → BootResult Ok
 * ```
 *
 * Foreign-protocol bridge: step 6c is where the MCP stdio transport
 * attaches. From this point on the process owns two concurrent
 * channels — MCP stdio (outbound to Claude) and MoltZap WS (inbound
 * from server). They meet inside the inbound handler and the reply
 * tool.
 * @failure AgentKeyInvalid when opts.agentKey or opts.serverUrl is blank
 * @failure McpTransportFailed when MCP server init or stdio connect rejects (step 6)
 * @failure ServiceRpcError when WS connect / auth rejects (step 8)
 */
export function bootClaudeCodeChannel(opts: BootOptions) {
  return Effect.runPromise(bootClaudeCodeChannelEffect(opts));
}

function bootClaudeCodeChannelEffect(
  opts: BootOptions,
): Effect.Effect<BootResult, never, never> {
  return Effect.gen(function* () {
    const validationError = validateBootOptions(opts);
    if (validationError !== null) return bootErrorResult(validationError);

    const service = new MoltZapService({
      serverUrl: opts.serverUrl,
      agentKey: opts.agentKey,
    });

    const core = new MoltZapChannelCore({
      service,
    });
    const routing = createRoutingState();
    const sendReply = makeSendReply(core);
    const serverBoot = yield* bootMcpServerHandle(
      opts,
      sendReply,
      routing,
    ).pipe(
      Effect.match({
        onFailure: bootErrorResult,
        onSuccess: (value) => ({ _tag: "Ok" as const, value }),
      }),
    );
    if (serverBoot._tag === "Err") return serverBoot;
    const serverHandle = serverBoot.value;

    // Inbound: gate → translate → record → push. Failures log and drop —
    // spec I5 (pure, drop on failure) + A3.
    core.onInbound((enriched: EnrichedInboundMessage) =>
      handleInboundMessage(opts, routing, serverHandle, enriched),
    );

    const connectResult = yield* Effect.either(connectCore(core, serverHandle));
    const connectFailure = Either.match(connectResult, {
      onLeft: bootErrorResult,
      onRight: () => null,
    });
    if (connectFailure !== null) return connectFailure;

    return { _tag: "Ok", value: makeHandle(core, serverHandle) };
  });
}
