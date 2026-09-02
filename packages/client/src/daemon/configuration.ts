/** @file Exact daemon process configuration and redacted bootstrap material. */

import {
  AgentSigningAuthority,
  Ed25519PublicKey,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
} from "@moltzap/identity";
import { Config, Data, Effect, Option, Redacted, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Bootstrap reads two configured Node files before the daemon composes its platform services.
import { readFile } from "node:fs/promises";

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
  admissionCredentialFile: Config.redacted(
    Schema.Config("MOLTZAPD_ADMISSION_CREDENTIAL_FILE", configuredPath),
  ),
  historyExport: Config.option(
    Schema.Config("MOLTZAPD_HISTORY_EXPORT", configuredPath),
  ),
});

/** Closed reason that daemon configuration cannot become startup authority. */
export type DaemonConfigurationFailure =
  | "environment"
  | "agent-private-key-file"
  | "agent-private-key"
  | "admission-credential-file"
  | "admission-credential";

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
  readonly admissionCredentialFile: Redacted.Redacted;
  /**
   * File the daemon appends its delivered and sent messages to, one JSON
   * line each, when the operator asks for that record.
   */
  readonly historyExport?: string;
}

/** Loaded private authority required by daemon registration and network calls. */
export interface DaemonBootstrap {
  readonly configuration: DaemonProcessConfiguration;
  readonly signingAuthority: AgentSigningAuthority;
  readonly agentPublicKey: Ed25519PublicKeyValue;
  readonly admissionCredential: Redacted.Redacted;
}

const configurationError = (
  reason: DaemonConfigurationFailure,
): DaemonConfigurationError => new DaemonConfigurationError({ reason });

/** Loads exactly the seven required daemon process inputs and the optional export. */
export const loadDaemonProcessConfiguration: Effect.Effect<
  DaemonProcessConfiguration,
  DaemonConfigurationError
> = configuredValues.pipe(
  Effect.map(
    ({ historyExport, ...configuration }): DaemonProcessConfiguration => ({
      ...configuration,
      ...Option.match(historyExport, {
        onNone: () => ({}),
        onSome: (path) => ({ historyExport: path }),
      }),
    }),
  ),
  Effect.mapError(() => configurationError("environment")),
  Effect.withSpan("loadDaemonProcessConfiguration"),
);

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const readExactUtf8 = (
  path: Redacted.Redacted,
  reason: "agent-private-key-file" | "admission-credential-file",
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
  readExactUtf8(
    configuration.admissionCredentialFile,
    "admission-credential-file",
  ).pipe(
    Effect.flatMap(Schema.decodeUnknown(admissionCredential)),
    Effect.map(Redacted.make),
    Effect.mapError((error) =>
      error._tag === "DaemonConfigurationError"
        ? error
        : configurationError("admission-credential"),
    ),
  );

/**
 * Reads exact secret bytes and constructs the configured Ed25519 authority.
 *
 * @param configuration Validated seven-input process configuration.
 * @returns Redacted admission and opaque agent signing authority.
 */
export const loadDaemonBootstrap = (
  configuration: DaemonProcessConfiguration,
): Effect.Effect<DaemonBootstrap, DaemonConfigurationError> =>
  Effect.gen(function* () {
    const signingAuthority = yield* loadSigningAuthority(configuration);
    const loadedAdmissionCredential =
      yield* loadAdmissionCredential(configuration);
    return Object.freeze({
      configuration,
      signingAuthority,
      agentPublicKey: AgentSigningAuthority.publicKey(signingAuthority),
      admissionCredential: loadedAdmissionCredential,
    });
  }).pipe(Effect.withSpan("loadDaemonBootstrap"));
