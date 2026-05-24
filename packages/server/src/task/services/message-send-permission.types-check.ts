/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors layer-boundary.types-check.ts convention). */

/**
 * Type-canary for the composite-capability drain (architect plan #606
 * Decision A). The successor to the Decision-A Canary 1 that lived in
 * the deleted `app/capabilities/capability-r-channel.types-check.ts` —
 * relocated next to the surviving composite helper so it tracks live
 * code.
 *
 * Asserts: ONE `Effect.provideServiceEffect(MessageSendPermission,
 * obtainMessageSendPermission(...))` drains the composite capability
 * from a handler body and leaves only the obtain helper's residual R
 * (the source-service Tags it composes). The dispatcher-side lockstep
 * gate (`protocol/transport/typed-dispatcher.types-check.ts` Canary 7)
 * proves the inverse: a handler yielding a capability NOT declared in
 * its descriptor fails to compile.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */
import { Effect } from "effect";
import { MessageSendPermission } from "@moltzap/protocol/task";
import { obtainMessageSendPermission } from "./message-send-permission.js";

declare const serviceBodyComposite: Effect.Effect<
  void,
  never,
  MessageSendPermission
>;
declare const obtainInput: Parameters<typeof obtainMessageSendPermission>[0];

const composite_OK: Effect.Effect<
  void,
  // E channel propagates the obtain helper's error union.
  Effect.Effect.Error<ReturnType<typeof obtainMessageSendPermission>>,
  // R drains to the obtain helper's own R (residual service Tags).
  Effect.Effect.Context<ReturnType<typeof obtainMessageSendPermission>>
> = serviceBodyComposite.pipe(
  Effect.provideServiceEffect(
    MessageSendPermission,
    obtainMessageSendPermission(obtainInput),
  ),
);
void composite_OK;
