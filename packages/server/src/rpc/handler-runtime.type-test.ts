/**
 * Negative type tests for the handler-runtime per-surface constraints.
 *
 * Stub status — `it.todo` placeholders; implement-* fills each one with a
 * concrete `@ts-expect-error` snippet. CI running `tsc --noEmit` (or
 * vitest's type-check mode) on this file fails if the boundary ever
 * regresses.
 *
 * The entries exercise both directions:
 *   - A network handler that yields a task-surface tag → `R ⊉ NetworkRequiredContext`.
 *   - A task handler that yields an identity-only tag → `R ⊉ TaskRequiredContext`.
 *   - An allowed network → allowed path (positive canary).
 *   - An allowed task   → allowed path (positive canary).
 */

import { describe, it } from "vitest";

describe("handler-runtime boundary", () => {
  it.todo("network handler yielding TaskServiceTag fails to typecheck");
  it.todo("network handler yielding AppHostTag fails to typecheck");
  it.todo("network handler yielding HumanContactTag fails to typecheck");
  it.todo("task handler yielding an identity-only tag fails to typecheck");
  it.todo(
    "network handler yielding NetworkDeliveryServiceTag typechecks (positive)",
  );
  it.todo(
    "task handler yielding NetworkDeliveryServiceTag typechecks (network subset)",
  );
  it.todo("task handler yielding TaskServiceTag typechecks (positive)");
});
