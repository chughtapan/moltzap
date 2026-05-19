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
import { createRoutingState } from "./routing.js";
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
  return (conversationId: string, text: string) =>
    core.sendReply(conversationId, text).pipe(
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
    routing.recordInbound(
      translated.value.params.meta.message_id,
      translated.value.params.meta.chat_id,
    );
    yield* pushInboundNotification(serverHandle, translated.value, enriched.id);
  });
}

function connectCore(
  core: MoltZapChannelCore,
  serverHandle: ServerHandle,
): Effect.Effect<void, BootError> {
  return core.connect().pipe(Effect.tapError(() => serverHandle.stop()));
}

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
