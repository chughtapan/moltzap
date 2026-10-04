/** @file The daemon's loaded configuration and bootstrap authority, and the closed failure that loading them returns. */

import type {
  AgentSigningAuthority,
  Ed25519PublicKey as Ed25519PublicKeyValue,
} from "@moltzap/identity";
import { Data, type Effect, type Redacted } from "effect";
import type { HarnessMcpCredentials } from "../endpoint/mcp/index.js";

/** Closed reason that daemon configuration cannot become startup authority. */
export type DaemonConfigurationFailure =
  | "environment"
  | "agent-private-key-file"
  | "agent-private-key"
  | "admission-credential-file"
  | "admission-credential"
  | "mcp-runtime-credential-file"
  | "mcp-owner-credential-file"
  | "mcp-credential";

/** One non-diagnostic daemon configuration failure. */
export class DaemonConfigurationError extends Data.TaggedError(
  "DaemonConfigurationError",
)<{
  readonly reason: DaemonConfigurationFailure;
}> {}

/** Exact non-secret values and redacted secret-file locations for one daemon. */
export interface DaemonProcessConfiguration {
  readonly stateDirectory: string;
  readonly mcpPort: number;
  readonly registryOrigin: URL;
  readonly registrySignerPublicKey: Ed25519PublicKeyValue;
  readonly routerOrigin: URL;
  readonly agentPrivateKeyFile: Redacted.Redacted;
  /**
   * Admission credential file an unregistered daemon requires; a daemon whose
   * state directory holds a registered identity never reads it. An empty
   * value is the same as an unset one.
   */
  readonly admissionCredentialFile?: Redacted.Redacted;
  /**
   * File the daemon appends its delivered and sent messages to, one JSON
   * line each, when the operator asks for that record.
   */
  readonly historyExport?: string;
  readonly mcpRuntimeCredentialFile?: Redacted.Redacted;
  readonly mcpOwnerCredentialFile?: Redacted.Redacted;
}

/** Loaded private authority required by daemon registration and network calls. */
export interface DaemonBootstrap {
  readonly configuration: DaemonProcessConfiguration;
  readonly signingAuthority: AgentSigningAuthority;
  readonly agentPublicKey: Ed25519PublicKeyValue;
  /**
   * Reads and validates the admission credential file on first use, then
   * replays that outcome. Loading the bootstrap never reads the file.
   */
  readonly admissionCredential: Effect.Effect<
    Redacted.Redacted,
    DaemonConfigurationError
  >;
  readonly mcpCredentials?: HarnessMcpCredentials;
}
