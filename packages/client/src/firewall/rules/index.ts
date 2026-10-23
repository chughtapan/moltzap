/** @file Built-in middleware registrations for policy composition. */

/** Policy composition selects built-ins by their document entries. */
export {
  acknowledgementsPolicy,
  ALLOWED_SENDERS_ID,
  allowedSendersPolicy,
  credentialsPolicy,
  plainLanguagePolicy,
} from "./builtin.js";
/** Policy composition selects built-ins by their document entries. */
export { type CollectiveNorms, collectiveNorms } from "./collective-norms.js";
