/** @file Loads the daemon process configuration and its redacted bootstrap material from the environment. */

import { AgentSigningAuthority, Ed25519PublicKey } from "@moltzap/identity";
import { Config, ConfigError, Effect, Redacted, Schema } from "effect";
import {
  credentialMatches,
  type HarnessMcpCredentials,
} from "../endpoint/mcp/index.js";
import {
  type CredentialError,
  credentialText,
  loadAdmissionCredential,
  loadSigningAuthority,
  readCredential,
} from "../identity/index.js";
import {
  type DaemonBootstrap,
  DaemonConfigurationError,
  type DaemonConfigurationFailure,
  type DaemonProcessConfiguration,
} from "./bootstrap.js";

const canonicalUnsignedDecimal = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)$/u),
);
const port = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, 65_535),
);
const configuredPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter((value) => !value.includes("\u0000")),
);
const optionalConfiguredPath = Schema.Union(Schema.Literal(""), configuredPath);

const isSerializedOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const parsed = new URL(value);
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    value === parsed.origin
  );
};

const origin = Schema.String.pipe(
  Schema.filter(isSerializedOrigin),
  Schema.annotations({
    identifier: "serialized HTTP(S) origin without a path",
  }),
  Schema.compose(Schema.URL),
);
const compactPublicKeyJson = Schema.String.pipe(
  Schema.pattern(/^\{"crv":"Ed25519","kty":"OKP","x":"[A-Za-z0-9_-]{43}"\}$/u),
  Schema.compose(Schema.parseJson(Ed25519PublicKey)),
);

const configurationFields = {
  stateDirectory: setting("MOLTZAPD_STATE_DIRECTORY", configuredPath),
  mcpPort: setting("MOLTZAPD_MCP_PORT", port),
  registryOrigin: setting("MOLTZAPD_REGISTRY_ORIGIN", origin),
  registrySignerPublicKey: setting(
    "MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY",
    compactPublicKeyJson,
  ),
  routerOrigin: setting("MOLTZAPD_ROUTER_ORIGIN", origin),
  agentPrivateKeyFile: setting(
    "MOLTZAPD_AGENT_PRIVATE_KEY_FILE",
    configuredPath,
  ),
  admissionCredentialFile: setting(
    "MOLTZAPD_ADMISSION_CREDENTIAL_FILE",
    optionalConfiguredPath,
    "",
  ),
  historyExport: setting("MOLTZAPD_HISTORY_EXPORT", configuredPath, undefined),
  mcpRuntimeCredentialFile: setting(
    "MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE",
    configuredPath,
    undefined,
  ),
  mcpOwnerCredentialFile: setting(
    "MOLTZAPD_MCP_OWNER_CREDENTIAL_FILE",
    configuredPath,
    undefined,
  ),
};

const configuredValues = Config.all({
  stateDirectory: configurationFields.stateDirectory.config,
  mcpPort: configurationFields.mcpPort.config,
  registryOrigin: configurationFields.registryOrigin.config,
  registrySignerPublicKey: configurationFields.registrySignerPublicKey.config,
  routerOrigin: configurationFields.routerOrigin.config,
  agentPrivateKeyFile: Config.redacted(
    configurationFields.agentPrivateKeyFile.config,
  ),
  admissionCredentialFile:
    configurationFields.admissionCredentialFile.config.pipe(
      Config.map((path) => (path === "" ? undefined : Redacted.make(path))),
    ),
  historyExport: configurationFields.historyExport.config,
  mcpRuntimeCredentialFile: Config.redacted(
    configurationFields.mcpRuntimeCredentialFile.config,
  ).pipe(
    Config.map((secret) => {
      const value = Redacted.value(secret);
      return value === undefined ? undefined : Redacted.make(value);
    }),
  ),
  mcpOwnerCredentialFile: Config.redacted(
    configurationFields.mcpOwnerCredentialFile.config,
  ).pipe(
    Config.map((secret) => {
      const value = Redacted.value(secret);
      return value === undefined ? undefined : Redacted.make(value);
    }),
  ),
});

/** Usage is generated from the same fields consumed by the process. */
export const processHelp = [
  "Usage: moltzapd [--help]",
  "",
  "Environment:",
  "  Admission credential: required only before registration; MCP credential files: supply both or neither.",
  ...Object.values(configurationFields).map((field) => `  ${field.usage}`),
].join("\n");

const configurationError = (
  reason: DaemonConfigurationFailure,
  cause?: unknown,
): DaemonConfigurationError =>
  new DaemonConfigurationError({
    reason,
    cause,
    message: configurationFailureMessages[reason],
  });

const configurationFailureMessages: Readonly<
  Record<DaemonConfigurationFailure, string>
> = {
  environment: "environment configuration is invalid",
  "agent-private-key-file":
    "MOLTZAPD_AGENT_PRIVATE_KEY_FILE must name a readable file",
  "agent-private-key":
    "MOLTZAPD_AGENT_PRIVATE_KEY_FILE must contain an Ed25519 PKCS#8 private key",
  "admission-credential-file":
    "MOLTZAPD_ADMISSION_CREDENTIAL_FILE is required for an unregistered daemon and must name a readable file",
  "admission-credential":
    "MOLTZAPD_ADMISSION_CREDENTIAL_FILE must contain a valid admission credential",
  "mcp-runtime-credential-file":
    "MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE must name a readable file",
  "mcp-owner-credential-file":
    "MOLTZAPD_MCP_OWNER_CREDENTIAL_FILE must name a readable file",
  "mcp-credential":
    "MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE and MOLTZAPD_MCP_OWNER_CREDENTIAL_FILE must both be supplied and contain distinct valid tokens of at least 32 characters",
};

/** Loads explicit daemon inputs with optional export and MCP authority separation. */
export const loadDaemonProcessConfiguration: Effect.Effect<
  DaemonProcessConfiguration,
  DaemonConfigurationError
> = configuredValues.pipe(
  Effect.map((configuration): DaemonProcessConfiguration => configuration),
  Effect.mapError(
    (cause) =>
      new DaemonConfigurationError({
        reason: "environment",
        cause,
        message: configurationMessage(cause),
      }),
  ),
  Effect.withSpan("loadDaemonProcessConfiguration"),
);

const credentialFailure =
  (
    fileReason: DaemonConfigurationFailure,
    valueReason: DaemonConfigurationFailure,
  ) =>
  (error: CredentialError): DaemonConfigurationError =>
    configurationError(
      error.stage === "file" ? fileReason : valueReason,
      error,
    );

const mcpCredential = credentialText.pipe(Schema.minLength(32));

const loadMcpCredentials = (
  configuration: DaemonProcessConfiguration,
): Effect.Effect<HarnessMcpCredentials | undefined, DaemonConfigurationError> =>
  Effect.gen(function* () {
    const runtimePath = configuration.mcpRuntimeCredentialFile;
    const ownerPath = configuration.mcpOwnerCredentialFile;
    if (runtimePath === undefined && ownerPath === undefined) {
      return undefined;
    }
    if (runtimePath === undefined || ownerPath === undefined) {
      return yield* Effect.fail(configurationError("mcp-credential"));
    }
    const runtime = yield* readCredential(runtimePath, mcpCredential).pipe(
      Effect.mapError(
        credentialFailure("mcp-runtime-credential-file", "mcp-credential"),
      ),
    );
    const owner = yield* readCredential(ownerPath, mcpCredential).pipe(
      Effect.mapError(
        credentialFailure("mcp-owner-credential-file", "mcp-credential"),
      ),
    );
    if (credentialMatches(Redacted.value(runtime), owner)) {
      return yield* Effect.fail(configurationError("mcp-credential"));
    }
    return { runtime, owner };
  });

const loadConfiguredAdmissionCredential = (
  configuration: DaemonProcessConfiguration,
): Effect.Effect<Redacted.Redacted, DaemonConfigurationError> =>
  configuration.admissionCredentialFile === undefined
    ? Effect.fail(configurationError("admission-credential-file"))
    : loadAdmissionCredential(configuration.admissionCredentialFile).pipe(
        Effect.mapError(
          credentialFailure(
            "admission-credential-file",
            "admission-credential",
          ),
        ),
      );

/**
 * Reads the agent private key and constructs the configured Ed25519 authority.
 *
 * @param configuration Validated process configuration and optional authority paths.
 * @returns Opaque signing authority, MCP credentials, and deferred admission credential.
 */
export const loadDaemonBootstrap = (
  configuration: DaemonProcessConfiguration,
): Effect.Effect<DaemonBootstrap, DaemonConfigurationError> =>
  Effect.gen(function* () {
    const signingAuthority = yield* loadSigningAuthority(
      configuration.agentPrivateKeyFile,
    ).pipe(
      Effect.mapError(
        credentialFailure("agent-private-key-file", "agent-private-key"),
      ),
    );
    const admissionCredential = yield* Effect.cached(
      loadConfiguredAdmissionCredential(configuration),
    );
    const mcpCredentials = yield* loadMcpCredentials(configuration);
    return Object.freeze({
      configuration,
      signingAuthority,
      agentPublicKey: AgentSigningAuthority.publicKey(signingAuthority),
      admissionCredential,
      ...(mcpCredentials === undefined ? {} : { mcpCredentials }),
    });
  }).pipe(Effect.withSpan("loadDaemonBootstrap"));

/** Config and operator text share the name, schema and default at declaration. */
function setting<A, D = never>(
  name: string,
  schema: Schema.Schema<A, string>,
  ...defaults: [] | [D]
) {
  const config = Schema.Config(name, schema);
  return {
    name,
    reason: `must satisfy ${String(schema)}`,
    config:
      defaults.length === 0
        ? config
        : config.pipe(Config.withDefault(defaults[0])),
    usage: `${name}: ${defaults.length === 0 ? "required; default: none" : `optional; default: ${defaults[0] === undefined ? "unset" : JSON.stringify(defaults[0])}`}`,
  };
}

/** ConfigError trees retain every missing field without printing rejected inputs. */
function configurationMessage(error: ConfigError.ConfigError): string {
  switch (error._op) {
    case "And":
    case "Or":
      return `${configurationMessage(error.left)}; ${configurationMessage(error.right)}`;
    case "MissingData":
      return `${Array.from(error.path).join("_")} is required`;
    case "InvalidData": {
      const name = Array.from(error.path).join("_");
      const field = Object.values(configurationFields).find(
        (candidate) => candidate.name === name,
      );
      return field === undefined ? error.message : `${name} ${field.reason}`;
    }
    case "SourceUnavailable":
    case "Unsupported":
      return `${Array.from(error.path).join("_")} configuration source unavailable`;
  }
}
