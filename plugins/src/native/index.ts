/** @file Provider handoff failures are private to native plugins, not Client transport or message semantics. */

import type { HttpClient } from "@effect/platform";
import type { InboundDelivery } from "@moltzap/client";
import { Data, type Effect } from "effect";

/** A refused or uncertain native wake retains Client's unread delivery. */
export class NativeWakeError extends Data.TaggedError("NativeWakeError")<{
  readonly reason:
    | "invalid-configuration"
    | "transport-failed"
    | "refused"
    | "decode-failed"
    | "timed-out";
}> {
  override get message(): string {
    return this.reason;
  }
}

/** Only immutable work references leave Client; acceptance is not model processing or an explicit peer send. */
export type NativeWakeup = (
  delivery: Pick<InboundDelivery, "eventId">,
) => Effect.Effect<void, NativeWakeError, HttpClient.HttpClient>;
