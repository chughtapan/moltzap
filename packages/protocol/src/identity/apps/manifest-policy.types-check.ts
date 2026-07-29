/**
 * @file Compile-time canaries for required manifest hook policies.
 *
 * The manifest's `hooks` block and each of its three policy slots are
 * required discriminated unions. That is the load-bearing invariant: an
 * authored manifest cannot leave a gate unspecified, so a dropped or
 * typo'd policy is a compile error rather than a silent runtime grant.
 * These canaries pin the invariant by asserting that the omitting
 * constructions DO NOT compile:
 *
 *   1. omitting the whole `hooks` block fails (TS2741);
 *   2. omitting one policy from `hooks` fails (TS2741);
 *   3. a static `deny` / `reject` without `reason` fails (TS2741);
 *   4. a `hook` policy without `timeoutMs` fails (TS2741);
 *   5. a `switch (policy.kind)` with no `default` is exhaustive — feeding
 *      an unhandled arm to the same shape fails at the `never` assignment
 *      (TS2322), which is what breaks every evaluator when a kind is added.
 *
 * Each must-error construction is guarded by `@ts-expect-error`, so this
 * file compiles clean iff every guarded line genuinely errors. A guard
 * over a line that compiles would itself raise `TS2578: Unused
 * '@ts-expect-error' directive', failing the build — that is what makes
 * the canary non-vacuous. The exported aggregate references each binding
 * so the unused-variable lint does not flag them.
 */
import type { AppManifest } from "./manifest.js";

type DispatchPolicy = AppManifest["hooks"]["dispatch_authorize"];
type TaskPolicy = AppManifest["hooks"]["task_create"];

// Positive control: a manifest declaring all three policies compiles.
const valid: AppManifest = {
  appId: "app",
  name: "App",
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
    task_create: { kind: "accept" },
  },
};

// Canary 1: omitting the whole `hooks` block fails to compile.
// @ts-expect-error — `hooks` is required (TS2741).
const noHooks: AppManifest = {
  appId: "app",
  name: "App",
};

// Canary 2: omitting one policy from `hooks` fails to compile.
const missingPolicy: AppManifest = {
  appId: "app",
  name: "App",
  // @ts-expect-error — `task_create` is required (TS2741).
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
  },
};

// Canary 3: a static `deny` without `reason` fails to compile.
// @ts-expect-error — `reason` is required on the static deny arm (TS2741).
const denyNoReason: DispatchPolicy = { kind: "deny" };

// Canary 4: a `hook` policy without `timeoutMs` fails to compile.
// @ts-expect-error — `timeoutMs` is required on the hook arm (TS2741).
const hookNoTimeout: DispatchPolicy = { kind: "hook" };

/**
 * Canary 5: a `switch (policy.kind)` with no `default` is exhaustive. The
 * post-switch `never` binding type-checks today; feeding an extra arm to
 * the same shape fails the assignment (TS2322), so adding a policy kind
 * breaks every evaluator until it handles the new arm.
 * @param policy Value supplied to the operation.
 * @returns The evaluate task policy result.
 */
function evaluateTaskPolicy(policy: TaskPolicy): string {
  switch (policy.kind) {
    case "accept":
      return "accept";
    case "reject":
      return policy.reason;
    case "hook":
      return `hook:${policy.timeoutMs}`;
    default: {
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
}

type TaskPolicyPlusFuture = TaskPolicy | { readonly kind: "future" };
function rejectsUnhandledArm(policy: TaskPolicyPlusFuture): string {
  switch (policy.kind) {
    case "accept":
    case "reject":
    case "hook":
      return "handled";
    default: {
      // @ts-expect-error — `{ kind: "future" }` is not assignable to `never` (TS2322).
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
}

/** Aggregate so each binding is referenced (no unused-variable lint). */
export const manifestPolicyCanaries = {
  valid,
  noHooks,
  missingPolicy,
  denyNoReason,
  hookNoTimeout,
  evaluateTaskPolicy,
  rejectsUnhandledArm,
} as const;
