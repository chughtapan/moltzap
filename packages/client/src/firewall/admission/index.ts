/** @file Firewall installation, checking and incoming admission ports. */

// safer-arch-ignore no-inventory-barrel: Admission exposes installation, the shared environment, retained check decoding and the incoming worker as the ports policy, audit and delivery consume.

/** Admission and retained checks share one installation. */
export {
  captureRegistration,
  collectiveAdmission,
  type FirewallOptions,
  installFirewall,
} from "./firewall.js";
/** Admission and retained checks share one installation. */
export {
  type FirewallEnvironment,
  type InstalledFirewall,
} from "./firewall-checks.js";
/** Admission and retained checks share one installation. */
export {
  decodeFirewallAuditEntry,
  FirewallAuditRecord,
} from "./firewall-values.js";
/** Admission and retained checks share one installation. */
export { type AdmissionContext, runAdmission } from "./admission.js";
