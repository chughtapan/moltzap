/** @file The message-policy document `sharnessd` reads and the firewall it builds from one. */

/** Daemon startup decides its firewall; trusted composition installs a decoded document with its own decision provider. */
export {
  type FirewallInstallation,
  firewallInstallation,
  messagePolicyFirewall,
  policyInstallationError,
} from "./compose.js";
/** Writers build documents with the schema the daemon decodes them with. */
export { decodeMessagePolicy, MessagePolicy } from "./policy.js";
