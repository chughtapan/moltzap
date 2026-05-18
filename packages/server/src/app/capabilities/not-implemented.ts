import { Effect } from "effect";

/**
 * Stub-branch shim. The Phase 1 implement-staff PR replaces every body
 * in this directory with the real obtain/refine effect. The shim throws
 * synchronously so an accidental `yield*` of an unimplemented helper
 * surfaces as a defect (not a missing-Tag type error).
 *
 * Delete this file in the Phase 1 implement-staff PR — every consumer
 * site is replaced before this module loses its last importer.
 */
export class NotImplementedError extends Error {
  readonly _tag = "NotImplementedError" as const;
  constructor(symbol: string) {
    super(
      `${symbol} is an architect-stub. Phase 1 implement-staff (#601) supplies the body.`,
    );
  }
}

export const notImplemented = (symbol: string): Effect.Effect<never> =>
  Effect.dieMessage(
    `${symbol} is an architect-stub. Phase 1 implement-staff (#601) supplies the body.`,
  );
