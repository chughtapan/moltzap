/** @file Exact daemon process configuration and redacted bootstrap material. */

import {
  AgentSigningAuthority,
  Ed25519PublicKey,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
} from "@moltzap/identity";
import { Config, Data, Effect, Redacted, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Bootstrap reads configured credential files before the daemon composes its platform services.
import { readFile } from "node:fs/promises";
import {
  credentialMatches,
  type HarnessMcpCredentials,
} from "../harness-mcp-auth.js";

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
const admissionCredential = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9\-._~+/]+=*$/u),
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

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const readExactUtf8 = (
  path: Redacted.Redacted,
  reason:
    | "agent-private-key-file"
    | "admission-credential-file"
    | "mcp-runtime-credential-file"
    | "mcp-owner-credential-file",
): Effect.Effect<string, DaemonConfigurationError> =>
  Effect.tryPromise({
    try: () => readFile(Redacted.value(path)),
    catch: () => configurationError(reason),
  }).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => utf8Decoder.decode(bytes),
        catch: () => configurationError(reason),
      }),
    ),
  );

const loadSigningAuthority = (
  configuration: DaemonProcessConfiguration,
): Effect.Effect<AgentSigningAuthority, DaemonConfigurationError> =>
  readExactUtf8(
    configuration.agentPrivateKeyFile,
    "agent-private-key-file",
  ).pipe(
    Effect.flatMap((privateKey) =>
      AgentSigningAuthority.fromPkcs8(Redacted.make(privateKey)),
    ),
    Effect.mapError((error) =>
      error._tag === "DaemonConfigurationError"
        ? error
        : configurationError("agent-private-key"),
    ),
  );

const loadAdmissionCredential = (
  configuration: DaemonProcessConfiguration,
): Effect.Effect<Redacted.Redacted, DaemonConfigurationError> =>
  (configuration.admissionCredentialFile === undefined
    ? Effect.fail(configurationError("admission-credential-file"))
    : readExactUtf8(
        configuration.admissionCredentialFile,
        "admission-credential-file",
      )
  ).pipe(
    Effect.flatMap(Schema.decodeUnknown(admissionCredential)),
    Effect.map(Redacted.make),
    Effect.mapError((error) =>
      error._tag === "DaemonConfigurationError"
        ? error
        : configurationError("admission-credential"),
    ),
  );

const mcpCredential = admissionCredential.pipe(Schema.minLength(32));

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
    const runtime = yield* readExactUtf8(
      runtimePath,
      "mcp-runtime-credential-file",
    ).pipe(
      Effect.flatMap(Schema.decodeUnknown(mcpCredential)),
      Effect.mapError((error) =>
        error._tag === "DaemonConfigurationError"
          ? error
          : configurationError("mcp-credential"),
      ),
      Effect.map(Redacted.make),
    );
    const owner = yield* readExactUtf8(
      ownerPath,
      "mcp-owner-credential-file",
    ).pipe(
      Effect.flatMap(Schema.decodeUnknown(mcpCredential)),
      Effect.mapError((error) =>
        error._tag === "DaemonConfigurationError"
          ? error
          : configurationError("mcp-credential"),
      ),
      Effect.map(Redacted.make),
    );
    if (credentialMatches(Redacted.value(runtime), owner)) {
      return yield* Effect.fail(configurationError("mcp-credential"));
    }
    return { runtime, owner };
  });

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
    const signingAuthority = yield* loadSigningAuthority(configuration);
    const admissionCredential = yield* Effect.cached(
      loadAdmissionCredential(configuration),
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
