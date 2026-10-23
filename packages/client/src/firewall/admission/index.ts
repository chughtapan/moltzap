/** @file Firewall installation, checking and incoming admission ports. */

// safer-arch-ignore no-inventory-barrel: Admission exposes installation, the shared environment, retained check decoding and the incoming worker as the ports policy, audit and delivery consume.

/** Trusted composition installs immutable chains and captures their registrations. */
export {
  captureRegistration,
  collectiveAdmission,
  type FirewallOptions,
  installFirewall,
} from "./firewall.js";
/** Checking and delivery share the installed firewall and its execution environment. */
export {
  type FirewallEnvironment,
  type InstalledFirewall,
} from "./firewall-checks.js";
/** Audit readers decode the retained checks independently of private storage. */
export {
  decodeFirewallAuditEntry,
  FirewallAuditRecord,
} from "./firewall-values.js";
/** Delivery supplies verified context to the incoming admission worker. */
export { type AdmissionContext, runAdmission } from "./admission.js";
