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
import { Effect } from "effect";
import { toClaudeChannelNotification } from "./event.js";
import { createRoutingState } from "./routing.js";
import { bootChannelMcpServer, type ServerHandle } from "./server.js";
import type { BootOptions, Handle } from "./types.js";
import type { BootError, ReplyError } from "./errors.js";
import { stringifyCause } from "./utils.js";

export type BootResult =
  | { readonly _tag: "Ok"; readonly value: Handle }
  | { readonly _tag: "Err"; readonly error: BootError };

const DEFAULT_SERVER_NAME = "@moltzap/claude-code-channel";
const DEFAULT_INSTRUCTIONS =
  'MoltZap messages arrive as <channel source="moltzap" chat_id="..." message_id="..." user="..." ts="...">. ' +
  "Reply with the reply tool. Pass reply_to=<message_id> to target a specific conversation; omit to reply to the most recent inbound.";

/**
 * Boot a Claude Code channel. Single public entry point of the package.
 *
 * Error channel is tagged (Principle 3). Internals run on Effect; the
 * `Promise` wrapper lives only at this boundary.
 */
// #ignore-sloppy-code-next-line[async-keyword]: public API boundary — callers are not Effect-native; wraps Effect internals
export async function bootClaudeCodeChannel(
  opts: BootOptions,
  // #ignore-sloppy-code-next-line[promise-type]: public API boundary — callers are not Effect-native; wraps Effect internals
): Promise<BootResult> {
  if (typeof opts.agentKey !== "string" || opts.agentKey.trim().length === 0) {
    return {
      _tag: "Err",
      error: {
        _tag: "AgentKeyInvalid",
        cause: "agentKey must be a non-empty string",
      },
    };
  }
  if (
    typeof opts.serverUrl !== "string" ||
    opts.serverUrl.trim().length === 0
  ) {
    return {
      _tag: "Err",
      error: {
        _tag: "AgentKeyInvalid",
        cause: "serverUrl must be a non-empty string",
      },
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

  const sendReply = (chatId: string, text: string) =>
    core.sendReply(chatId, text).pipe(
      Effect.mapError(
        (cause): ReplyError => ({
          _tag: "SendFailed",
          cause: stringifyCause(cause),
        }),
      ),
    );

  const serverBoot = await bootChannelMcpServer(
    {
      serverName: opts.serverName ?? DEFAULT_SERVER_NAME,
      instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
    },
    { sendReply, routing, logger },
  );
  if (serverBoot._tag === "Err") {
    return {
      _tag: "Err",
      error: {
        _tag: "McpTransportFailed",
        cause: `${serverBoot.error._tag}: ${serverBoot.error.cause}`,
      },
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
      yield* serverHandle
        .push(translated.value)
        .pipe(
          Effect.catchAll((err) =>
            Effect.sync(() =>
              logger.error?.(
                { err, messageId: enriched.id },
                "claude-code-channel: notification push failed",
              ),
            ),
          ),
        );
    }),
  );

  const connectResult = await Effect.runPromise(Effect.either(core.connect()));
  if (connectResult._tag === "Left") {
    // Best-effort: tear down MCP transport before reporting to the caller.
    await Effect.runPromise(serverHandle.stop());
    return {
      _tag: "Err",
      error: {
        _tag: "ServiceConnectFailed",
        cause: stringifyCause(connectResult.left),
      },
    };
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
}
