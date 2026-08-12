import type { HarnessTurn } from "@moltzap/client/harness-client";
import { Effect } from "effect";

const OUTBOUND_LOG_PREVIEW_CHARS = 80;

interface HarnessReplyLogger {
  readonly info?: (message: string) => void;
  readonly error?: (message: string) => void;
}

/** OpenClaw's Promise-based delivery callback bound to one Harness turn. */
export type HarnessReplyDeliver = (
  payload: { readonly text?: string; readonly body?: string },
  info?: { readonly kind?: string },
) => PromiseLike<boolean>;

const logOutboundReply = (
  turn: HarnessTurn,
  text: string,
  log?: HarnessReplyLogger,
): Effect.Effect<void> =>
  Effect.sync(() => {
    log?.info?.(
      `MoltZap: outbound reply to ${turn.conversationId}: ${text.slice(0, OUTBOUND_LOG_PREVIEW_CHARS)}`,
    );
  });

const handleReplyFailure = (
  turn: HarnessTurn,
  error: Error,
  log?: HarnessReplyLogger,
): Effect.Effect<boolean> =>
  Effect.sync(() => {
    log?.error?.(
      `MoltZap: failed to send reply to ${turn.conversationId}: ${error}`,
    );
    return false;
  });

const sendDeliveredReply = (
  turn: HarnessTurn,
  text: string,
  log?: HarnessReplyLogger,
): Effect.Effect<boolean> =>
  turn.reply(text).pipe(
    Effect.tap(() => logOutboundReply(turn, text, log)),
    Effect.as(true),
    Effect.catchAll((error) => handleReplyFailure(turn, error, log)),
  );

/**
 * Binds OpenClaw model output to the private reply authority carried by one
 * Harness turn. Conversation routing never becomes delivery input.
 *
 * @param params Live turn and optional channel logger.
 * @param params.turn Turn carrying the private reply authority.
 * @param params.log Optional channel logger.
 * @returns OpenClaw's delivery callback for that turn.
 */
export const createHarnessReplyDeliver =
  (params: {
    readonly turn: HarnessTurn;
    readonly log?: HarnessReplyLogger;
  }): HarnessReplyDeliver =>
  (payload, info) => {
    if (info?.kind !== "final") {
      return Promise.resolve(true);
    }
    const text = payload.text ?? payload.body;
    if (!text) {
      return Promise.resolve(true);
    }
    return Effect.runPromise(sendDeliveredReply(params.turn, text, params.log));
  };
