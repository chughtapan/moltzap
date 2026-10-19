/** @file One service's delivery, for the service to compose. */

/** The service's host operations, inbox writes and delivery pass. */
export { type HostDelivery, makeHostDelivery } from "./host-delivery.js";

/** Trusted daemon composition installs fixed policy and invokes checked application sends. */
export {
  collectiveAdmission,
  type FirewallOptions,
  installFirewall,
} from "./firewall.js";
/** The installed firewall daemon composition holds for its lifetime. */
export type { InstalledFirewall } from "./firewall-checks.js";
/** Operator snapshots contain retained judgments and applied dispositions. */
export { beginFirewallAudit } from "./firewall-audit.js";
/** Versioned operator evidence stays outside the agent-facing root. */
export { FirewallAuditRecord } from "./firewall-values.js";

/** Owner edits preserve the daemon resource lifetime. */
export { installEditableFirewall } from "./policy.js";
