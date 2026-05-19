/**
 * @file Fail-CLOSED default registry — Spec F G4 / `slotDisposition`.
 *
 * Each `RpcDefinition` may declare an OPTIONAL `slotDisposition` that
 * tells the handler-table type and the dispatcher how to treat a missing
 * slot. Required slots have no disposition and produce a `tsc` error
 * (TS2741) when omitted from the factory call's `handlers` literal.
 * Optional slots carry a `FailClosedDefault` (the wire-coded outcome
 * the dispatcher returns when the slot is absent at construction).
 *
 * The disposition is fixed at protocol-definition time. Callers cannot
 * change a slot's disposition by what they pass to the factory.
 */
import type { ForbiddenError } from "./wire-errors.js";

/**
 * Closed union of fail-CLOSED default outcomes a slot may carry. The
 * dispatcher reads the slot's `slotDisposition.optional` value and
 * synthesizes the wire response without invoking a handler.
 *
 * - `Forbidden`: the slot fails with `ForbiddenError` (wire code
 *   `-32001`, LSP-verified from `wire-errors.ts → ForbiddenError`). Used
 *   for authorization-shaped methods (`DispatchAuthorize`,
 *   `MessagesAuthorize`).
 * - `NoOpNotification`: the slot is a notification receiver; the
 *   dispatcher records a `recordMalformedFrame`-equivalent breadcrumb
 *   but emits no response (notifications have no response by JSON-RPC
 *   2.0).
 *
 * Spec F's impl-staff PR populates each optional `defineRpc` call with
 * the appropriate variant; the stub branch declares no slots optional,
 * which makes every catalog member REQUIRED in the handler-table type
 * (the impl-staff PR relaxes the two TM-callback methods to OPTIONAL).
 */
export type FailClosedDefault =
  | { readonly kind: "Forbidden" }
  | { readonly kind: "NoOpNotification" };

/**
 * Slot-disposition tag carried on a definition. Absent → REQUIRED.
 * `{ optional }` → OPTIONAL with the given fail-CLOSED default.
 */
export type SlotDisposition = { readonly optional: FailClosedDefault };

/**
 * Convenience factories for impl-staff PRs to pass to `defineRpc(...)`.
 *
 * Usage (impl-staff):
 *
 *   export const MessagesAuthorize = defineRpc({
 *     name: "messages/authorize",
 *     params: ...,
 *     result: ...,
 *     slotDisposition: optionalForbidden,
 *   });
 */
export const optionalForbidden: SlotDisposition = {
  optional: { kind: "Forbidden" },
};

export const optionalNoOp: SlotDisposition = {
  optional: { kind: "NoOpNotification" },
};

/**
 * Type-level boolean: `true` if `D`'s `slotDisposition` is present and
 * marks it OPTIONAL; `false` otherwise (REQUIRED is the default).
 */
export type IsOptionalSlot<D> = D extends {
  readonly slotDisposition: { readonly optional: FailClosedDefault };
}
  ? true
  : false;

/**
 * Marker — re-exported so handler-table consumers don't import the
 * concrete error class for type-only use.
 */
export type FailClosedForbidden = ForbiddenError;
