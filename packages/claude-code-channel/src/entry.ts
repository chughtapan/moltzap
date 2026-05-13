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
import { bootChannelMcpServer, type ServerHandle } from "./server.js";
import type { BootOptions, Handle } from "./types.js";
import {
  AgentKeyInvalid,
  LeaseAlreadyConsumed,
  McpTransportFailed,
  SendFailed,
  ServiceConnectFailed,
  type BootError,
  type ReplyError,
} from "./errors.js";
import { RpcServerError } from "@moltzap/protocol";
import { stringifyCause } from "./utils.js";

export type BootResult =
  | { readonly _tag: "Ok"; readonly value: Handle }
  | { readonly _tag: "Err"; readonly error: BootError };

const DEFAULT_SERVER_NAME = "@moltzap/claude-code-channel";
const DEFAULT_INSTRUCTIONS =
  'MoltZap messages arrive as <channel source="moltzap" chat_id="..." message_id="..." user="..." ts="...">. ' +
  "Reply with the reply tool. Pass reply_to=<message_id> to target a specific conversation; omit to reply to the most recent inbound.";

function logNotificationPushFailure(
  logger: BootOptions["logger"],
  messageId: string,
  err: unknown,
): Effect.Effect<void> {
  return Effect.sync(() =>
    logger.error?.(
      { err, messageId },
      "claude-code-channel: notification push failed",
    ),
  );
}

function pushInboundNotification(
  serverHandle: ServerHandle,
  notification: Parameters<ServerHandle["push"]>[0],
  logger: BootOptions["logger"],
  messageId: string,
): Effect.Effect<void> {
  return serverHandle
    .push(notification)
    .pipe(
      Effect.catchAll((err) =>
        logNotificationPushFailure(logger, messageId, err),
      ),
    );
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
    if (
      typeof opts.agentKey !== "string" ||
      opts.agentKey.trim().length === 0
    ) {
      return {
        _tag: "Err",
        error: new AgentKeyInvalid({
          cause: "agentKey must be a non-empty string",
        }),
      };
    }
    if (
      typeof opts.serverUrl !== "string" ||
      opts.serverUrl.trim().length === 0
    ) {
      return {
        _tag: "Err",
        error: new AgentKeyInvalid({
          cause: "serverUrl must be a non-empty string",
        }),
      };
    }

    const logger = opts.logger;
    const service = new MoltZapService({
      serverUrl: opts.serverUrl,
      agentKey: opts.agentKey,
      logger,
    });

    const core = new MoltZapChannelCore({ service, logger });
    const routing = createRoutingState();

    const projectLeaseInvalid = (
      err: RpcServerError,
    ): LeaseAlreadyConsumed | RpcServerError => {
      const data = err.data;
      if (
        typeof data === "object" &&
        data !== null &&
        (data as { reason?: unknown }).reason === "LeaseInvalid"
      ) {
        const dataLeaseId = (data as { leaseId?: unknown }).leaseId;
        return new LeaseAlreadyConsumed({
          leaseId: typeof dataLeaseId === "string" ? dataLeaseId : "(unknown)",
        });
      }
      return err;
    };
    const sendReply = (conversationId: string, text: string) =>
      core.sendReply(conversationId, text).pipe(
        // Cutover #533 single-use lease semantics: the server returns
        // a typed `RpcServerError` whose `data.reason === "LeaseInvalid"`
        // when the recipient tries to consume an already-consumed
        // lease (multi-turn agent calls reply twice in one dispatch).
        // Project that path onto `LeaseAlreadyConsumed` BEFORE the
        // generic `mapError` collapses everything else into
        // `SendFailed`. Server.ts surfaces the typed error as
        // `toolErrorResult("LeaseAlreadyConsumed: ...")`.
        Effect.catchTag("RpcServerError", (err) => {
          const projected = projectLeaseInvalid(err);
          return Effect.fail(projected);
        }),
        Effect.mapError(
          (cause): ReplyError =>
            cause instanceof LeaseAlreadyConsumed
              ? cause
              : new SendFailed({
                  cause: stringifyCause(cause),
                }),
        ),
      );

    const serverBoot = yield* Effect.tryPromise({
      try: () =>
        bootChannelMcpServer(
          {
            serverName: opts.serverName ?? DEFAULT_SERVER_NAME,
            instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
          },
          {
            sendReply,
            routing,
            logger,
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
      Effect.catchAll((error) =>
        Effect.succeed({ _tag: "Err" as const, error }),
      ),
    );
    if (serverBoot._tag === "Err") {
      return {
        _tag: "Err",
        error: new McpTransportFailed({
          cause: `${serverBoot.error._tag}: ${serverBoot.error.cause}`,
        }),
      };
    }
    const serverHandle: ServerHandle = serverBoot.value;

    // Inbound: gate → translate → record → push. Failures log and drop —
    // spec I5 (pure, drop on failure) + A3.
    core.onInbound((enriched: EnrichedInboundMessage) =>
      Effect.gen(function* () {
        const gated = opts.gateInbound
          ? opts.gateInbound(enriched)
          : ({ _tag: "Success", value: enriched } as const);
        if (gated._tag === "Failure") {
          logger.info?.(
            { error: gated.error },
            "claude-code-channel: gateInbound dropped event",
          );
          return;
        }
        const translated = toClaudeChannelNotification(gated.value);
        if (translated._tag === "Err") {
          logger.warn?.(
            { error: translated.error, messageId: enriched.id },
            "claude-code-channel: translation failed, dropping event",
          );
          return;
        }
        routing.recordInbound(
          translated.value.params.meta.message_id,
          translated.value.params.meta.chat_id,
        );
        yield* pushInboundNotification(
          serverHandle,
          translated.value,
          logger,
          enriched.id,
        );
      }),
    );

    const connectResult = yield* Effect.either(core.connect());
    const connectFailure = Either.match(connectResult, {
      onLeft: (error) =>
        ({
          _tag: "Err",
          error: new ServiceConnectFailed({
            cause: stringifyCause(error),
          }),
        }) as const,
      onRight: () => null,
    });
    if (connectFailure !== null) {
      yield* serverHandle.stop();
      return connectFailure;
    }

    const handle: Handle = {
      push: serverHandle.push,
      stop: () =>
        Effect.gen(function* () {
          yield* core.disconnect();
          yield* serverHandle.stop();
        }),
    };

    return { _tag: "Ok", value: handle };
  });
}
