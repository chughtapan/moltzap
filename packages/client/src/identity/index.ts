/** @file Agent key and secret credential loading, below every other Client domain. */

/** Fail-closed loaders for the agent key and secret credential files, and their one error. */
export {
  CredentialError,
  credentialText,
  loadAdmissionCredential,
  loadSigningAuthority,
  readCredential,
} from "./credentials.js";
