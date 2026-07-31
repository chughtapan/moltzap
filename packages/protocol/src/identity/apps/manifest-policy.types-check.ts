/**
 * @file Compile-time canaries for required manifest hook policies.
 *
 * The manifest's `hooks` block and each of its policy slots are required
 * discriminated unions. That is the load-bearing invariant: an authored
 * manifest cannot leave a gate unspecified, so a dropped or typo'd policy is a
 * compile error rather than a silent runtime grant. These canaries pin the
 * invariant with conditional-type proofs:
 *
 *   1. Omitting the whole `hooks` block fails (TS2741).
 *   2. Omitting one policy from `hooks` fails (TS2741).
 *   3. A static `deny` without `reason` fails (TS2741).
 *   4. A `hook` policy without `timeoutMs` fails (TS2741).
 *   5. The known `MessagePolicy["kind"]` arms cover the entire union.
 *
 * Each proof resolves to literal `true` today. If a field becomes optional
 * or an arm loses a required property, its `ExpectTrue` constraint fails.
 */
import type { AppManifest } from "./manifest.js";

type DispatchPolicy = AppManifest["hooks"]["dispatch_authorize"];
type MessagePolicy = AppManifest["hooks"]["message_authorize"];
type ExpectTrue<T extends true> = T;

// Positive control: a manifest declaring both policies compiles.
const valid: AppManifest = {
  appId: "app",
  name: "App",
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
  },
};

type HooksAreRequired = ExpectTrue<
  object extends Pick<AppManifest, "hooks"> ? false : true
>;
type MessageAuthorizePolicyIsRequired = ExpectTrue<
  object extends Pick<AppManifest["hooks"], "message_authorize"> ? false : true
>;
type DenyReasonIsRequired = ExpectTrue<
  object extends Pick<Extract<DispatchPolicy, { kind: "deny" }>, "reason">
    ? false
    : true
>;
type HookTimeoutIsRequired = ExpectTrue<
  object extends Pick<Extract<DispatchPolicy, { kind: "hook" }>, "timeoutMs">
    ? false
    : true
>;
type MessagePolicyKindsAreExhaustive = ExpectTrue<
  Exclude<
    MessagePolicy["kind"],
    "forwardAllExceptSender" | "deny" | "hook"
  > extends never
    ? true
    : false
>;
const manifestPolicyProofs: readonly [
  HooksAreRequired,
  MessageAuthorizePolicyIsRequired,
  DenyReasonIsRequired,
  HookTimeoutIsRequired,
  MessagePolicyKindsAreExhaustive,
] = [true, true, true, true, true];

/**
 * Canary 5: a `switch (policy.kind)` with no `default` is exhaustive. The
 * post-switch `never` binding type-checks today; feeding an extra arm to
 * the same shape fails the assignment (TS2322), so adding a policy kind
 * breaks every evaluator until it handles the new arm.
 * @param policy Value supplied to the operation.
 * @returns The evaluate message policy result.
 */
function evaluateMessagePolicy(policy: MessagePolicy): string {
  switch (policy.kind) {
    case "forwardAllExceptSender":
      return "forwardAllExceptSender";
    case "deny":
      return policy.reason;
    case "hook":
      return `hook:${policy.timeoutMs}`;
    default: {
      return policy satisfies never;
    }
  }
}

/** Aggregate whose annotation retains every compile-time policy proof. */
export const manifestPolicyCanaries = {
  valid,
  evaluateMessagePolicy,
  proofs: manifestPolicyProofs,
} as const;
