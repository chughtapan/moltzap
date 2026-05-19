/**
 * @file Fail-CLOSED slot markers — descriptor metadata + handler-table
 * sentinel values share a single Effect `Data.TaggedEnum`.
 *
 * The same value plays two roles:
 *
 *   - As `RpcDefinition.optional`: protocol-level declaration that the
 *     slot is OPTIONAL. Absence => REQUIRED (handler-table type
 *     rejects missing key at TS2741).
 *   - At `makeServerConnection({ handlers })` literal: caller's
 *     explicit decline. Slot value `forbidden` → dispatcher
 *     synthesizes `-32001 Forbidden`; `noOpNotification` → no-op.
 *
 * The slot key is NEVER field-level optional in the handler table —
 * every protocol slot MUST appear in the literal, either as a real
 * `HandlerSlot` or as the matching sentinel. A server can never
 * silently "forget to think about" an optional slot.
 *
 * Disposition is fixed at protocol-definition time; the caller cannot
 * change it via the factory.
 */
import { Data } from "effect";
import type { ForbiddenError } from "./wire-errors.js";

/**
 * Closed union of fail-CLOSED outcomes the dispatcher synthesizes
 * when a slot value is the matching sentinel.
 *
 * - `Forbidden`: returns `ForbiddenError` (-32001). Used for
 *   authorization-shaped methods (`DispatchAuthorize`,
 *   `MessagesAuthorize`).
 * - `NoOpNotification`: emits nothing (notifications have no
 *   response per JSON-RPC 2.0).
 */
export type FailClosedDefault = Data.TaggedEnum<{
  readonly Forbidden: {};
  readonly NoOpNotification: {};
}>;

/**
 * Constructor + type-guard companion. Use `FailClosedDefault.$is("Forbidden")(value)`
 * for runtime discrimination, or `Match.tag("Forbidden", ...)` inside an
 * `Effect.Match` pipeline. The dispatcher's slot-read path is the
 * sole consumer.
 */
export const FailClosedDefault = Data.taggedEnum<FailClosedDefault>();

/**
 * Slot sentinels — singletons descriptor authors put on
 * `optional:` AND that handler-table call sites pass for declined
 * slots. ESM module-instance identity guarantees `===` works across
 * the workspace.
 */
export const forbidden: Forbidden = FailClosedDefault.Forbidden() as Forbidden;
export const noOpNotification: NoOpNotification =
  FailClosedDefault.NoOpNotification() as NoOpNotification;

export type Forbidden = Extract<
  FailClosedDefault,
  { readonly _tag: "Forbidden" }
>;
export type NoOpNotification = Extract<
  FailClosedDefault,
  { readonly _tag: "NoOpNotification" }
>;

/**
 * Type-level boolean: `true` iff `D`'s `optional` field is present and
 * carries a `FailClosedDefault`. The handlers-table mapped type uses
 * this to choose `HandlerSlot | Forbidden` (or `NoOpNotification`) vs
 * plain `HandlerSlot` for the slot's value type.
 */
export type IsOptionalSlot<D> = D extends {
  readonly optional: FailClosedDefault;
}
  ? true
  : false;

/**
 * Marker — re-exported so handler-table consumers don't import the
 * concrete error class for type-only use.
 */
export type FailClosedForbidden = ForbiddenError;
