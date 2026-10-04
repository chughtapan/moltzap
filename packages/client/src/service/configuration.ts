/** @file Loads the daemon process configuration and its redacted bootstrap material from the environment. */

import { AgentSigningAuthority, Ed25519PublicKey } from "@moltzap/identity";
import { Config, Effect, Redacted, Schema } from "effect";
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
  Schema.compose(Schema.URL),
);
const compactPublicKeyJson = Schema.String.pipe(
  Schema.pattern(/^\{"crv":"Ed25519","kty":"OKP","x":"[A-Za-z0-9_-]{43}"\}$/u),
  Schema.compose(Schema.parseJson(Ed25519PublicKey)),
);

const configuredValues = Config.all({
  stateDirectory: Schema.Config("MOLTZAPD_STATE_DIRECTORY", configuredPath),
  mcpPort: Schema.Config("MOLTZAPD_MCP_PORT", port),
  registryOrigin: Schema.Config("MOLTZAPD_REGISTRY_ORIGIN", origin),
  registrySignerPublicKey: Schema.Config(
    "MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY",
    compactPublicKeyJson,
  ),
  routerOrigin: Schema.Config("MOLTZAPD_ROUTER_ORIGIN", origin),
  agentPrivateKeyFile: Config.redacted(
    Schema.Config("MOLTZAPD_AGENT_PRIVATE_KEY_FILE", configuredPath),
  ),
  admissionCredentialFile: Schema.Config(
    "MOLTZAPD_ADMISSION_CREDENTIAL_FILE",
    optionalConfiguredPath,
  ).pipe(
    Config.withDefault(""),
    Config.map((path) => (path === "" ? undefined : Redacted.make(path))),
  ),
  historyExport: Schema.Config("MOLTZAPD_HISTORY_EXPORT", configuredPath).pipe(
    Config.withDefault(undefined),
  ),
  mcpRuntimeCredentialFile: Config.redacted(
    Schema.Config("MOLTZAPD_MCP_RUNTIME_CREDENTIAL_FILE", configuredPath),
  ).pipe(Config.withDefault(undefined)),
  mcpOwnerCredentialFile: Config.redacted(
    Schema.Config("MOLTZAPD_MCP_OWNER_CREDENTIAL_FILE", configuredPath),
  ).pipe(Config.withDefault(undefined)),
});

const configurationError = (
  reason: DaemonConfigurationFailure,
): DaemonConfigurationError => new DaemonConfigurationError({ reason });

/** Loads explicit daemon inputs with optional export and MCP authority separation. */
export const loadDaemonProcessConfiguration: Effect.Effect<
  DaemonProcessConfiguration,
  DaemonConfigurationError
> = configuredValues.pipe(
  Effect.map((configuration): DaemonProcessConfiguration => configuration),
  Effect.mapError(() => configurationError("environment")),
  Effect.withSpan("loadDaemonProcessConfiguration"),
);

const credentialFailure =
  (
    fileReason: DaemonConfigurationFailure,
    valueReason: DaemonConfigurationFailure,
  ) =>
  (error: CredentialError): DaemonConfigurationError =>
    configurationError(error.stage === "file" ? fileReason : valueReason);

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
