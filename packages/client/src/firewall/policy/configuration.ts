/** @file Inputs the daemon supplies to policy loading without granting bootstrap authority. */

import type { Redacted } from "effect";

/** Closed reasons the policy settings cannot start the daemon. */
export type MessagePolicyConfigurationFailure =
  | "message-policy-file"
  | "message-policy"
  | "message-policy-required"
  | "message-policy-composed"
  | "firewall-audit-export"
  | "decision-provider-key-file"
  | "decision-provider-key";

/** Only policy and provider file locations enter the loader. */
export interface PolicyConfiguration {
  readonly messagePolicyFile?: string;
  readonly decisionProviderKeyFile?: Redacted.Redacted;
  readonly firewallAuditExport?: string;
}

/** The caller retains ownership of its configuration error representation. */
export type PolicyConfigurationErrorConstructor<E> = new (fields: {
  readonly reason: MessagePolicyConfigurationFailure;
  readonly message: string;
}) => E;
