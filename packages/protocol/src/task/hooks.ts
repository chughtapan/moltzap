/**
 * @file Failure channel for app-side send hooks.
 */

import { Schema } from "effect";
import { errorPayloadFields } from "#transport";

/**
 * The app that authorizes a conversation refused the dispatch. Raised by
 * `agent/message/send` when the app's send hook returns a block verdict (or the
 * fail-closed envelope synthesizes one on timeout, RPC error, or decode
 * failure). The app's reason rides in the `data` arm when present.
 */
export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}
