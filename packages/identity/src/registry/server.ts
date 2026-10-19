/** @file Production Registry process configuration, composition, and startup boundary. */

import * as Reactivity from "@effect/experimental/Reactivity";
import { FileSystem, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  Cause,
  Config,
  ConfigError,
  Console,
  Data,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schema,
} from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- NodeHttpServer.make requires the platform listener constructor at this adapter boundary.
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { MOLTZAP_VERSION } from "../version.js";
import { AgentSigningAuthority } from "../agent-key.js";
import { makeRegistryHttpApp } from "./http.js";
import {
  makeRegistryRpcClient,
  makeRegistryRpcHandlersLayer,
  registryAdmissionLayer,
} from "./rpc.js";
import {
  initializeRegistryStorage,
  makeRegistryStorage,
  type RegistryStorage,
} from "./storage.js";

const MAXIMUM_PROCESS_INTEGER = 2_147_483_647;
const canonicalUnsignedDecimal = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)$/),
);
const processInteger = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, MAXIMUM_PROCESS_INTEGER),
);
const port = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, 65_535),
);
const bindHost = Schema.String.pipe(Schema.minLength(1));
const postgresqlUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "postgres:" ||
          parsed.protocol === "postgresql:") &&
        parsed.pathname.length > 1 &&
        parsed.hash === ""
      );
      // eslint-disable-next-line agent-code-guard/bare-catch -- URL parsing failure is the false branch of this Schema predicate. #ignore-sloppy-code-next-line[bare-catch]: The predicate returns false.
    } catch {
      return false;
    }
  }),
  Schema.annotations({
    identifier: "PostgreSQL URL with a database name and no fragment",
  }),
);
const admissionCredential = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9\-._~+/]+=*$/),
);
const absolutePath = Schema.String.pipe(
  Schema.filter((value) => isAbsolute(value)),
  Schema.annotations({ identifier: "absolute file path" }),
);

const configurationFields = {
  host: setting("MOLTZAP_REGISTRY_HOST", bindHost, "127.0.0.1"),
  port: setting("MOLTZAP_REGISTRY_PORT", port),
  postgresqlUrl: setting("MOLTZAP_REGISTRY_POSTGRESQL_URL", postgresqlUrl),
  admissionCredential: setting(
    "MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL",
    admissionCredential,
  ),
  signingPrivateKeyPath: setting(
    "MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH",
    absolutePath,
  ),
  listPageSize: setting("MOLTZAP_REGISTRY_LIST_PAGE_SIZE", processInteger, 100),
  requestConcurrencyLimit: setting(
    "MOLTZAP_REGISTRY_REQUEST_CONCURRENCY_LIMIT",
    processInteger,
    256,
  ),
  liveNonceCapacity: setting(
    "MOLTZAP_REGISTRY_LIVE_NONCE_CAPACITY",
    processInteger,
    10_000,
  ),
  sqlPoolSize: setting("MOLTZAP_REGISTRY_SQL_POOL_SIZE", processInteger, 10),
  sqlOperationTimeoutMs: setting(
    "MOLTZAP_REGISTRY_SQL_OPERATION_TIMEOUT_MS",
    processInteger,
    5_000,
  ),
};

const configuredValues = Config.all({
  host: configurationFields.host.config,
  port: configurationFields.port.config,
  postgresqlUrl: Config.redacted(configurationFields.postgresqlUrl.config),
  admissionCredential: Config.redacted(
    configurationFields.admissionCredential.config,
  ),
  signingPrivateKeyPath: Config.redacted(
    configurationFields.signingPrivateKeyPath.config,
  ),
  listPageSize: configurationFields.listPageSize.config,
  requestConcurrencyLimit: configurationFields.requestConcurrencyLimit.config,
  liveNonceCapacity: configurationFields.liveNonceCapacity.config,
  sqlPoolSize: configurationFields.sqlPoolSize.config,
  sqlOperationTimeoutMs: configurationFields.sqlOperationTimeoutMs.config,
});

/** Usage is generated from the same fields consumed by the process. */
export const processHelp = [
  "Usage: moltzap-registry [--help]",
  "",
  "Environment:",
  ...Object.values(configurationFields).map((field) => `  ${field.usage}`),
].join("\n");

/**
 * Complete validated configuration for one Registry process.
 *
 * @internal
 */
export interface RegistryConfiguration {
  readonly host: string;
  readonly port: number;
  readonly postgresqlUrl: Redacted.Redacted;
  readonly admissionCredential: Redacted.Redacted;
  readonly signingPrivateKeyPath: Redacted.Redacted;
  readonly listPageSize: number;
  readonly requestConcurrencyLimit: number;
  readonly liveNonceCapacity: number;
  readonly sqlPoolSize: number;
  readonly sqlOperationTimeoutMs: number;
}

/**
 * Loads the complete private Registry process configuration.
 *
 * @internal
 */
export const loadRegistryConfiguration: Effect.Effect<
  RegistryConfiguration,
  ConfigError.ConfigError
> = configuredValues.pipe(
  Effect.map((configuration): RegistryConfiguration => configuration),
  Effect.withSpan("loadRegistryConfiguration"),
);

/** Closed Registry startup failure. */
export class StartupError extends Data.TaggedError(
  "RegistryServerStartupError",
)<{
  readonly phase: "configuration" | "storage" | "listener";
  readonly cause?: unknown;
}> {
  /** Operator diagnostics exclude rejected inputs and platform paths. */
  override get message(): string {
    const detail = ConfigError.isConfigError(this.cause)
      ? `: ${configurationMessage(this.cause)}`
      : this.phase === "configuration"
        ? ": MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH must name a readable Ed25519 PKCS#8 key file"
        : "";
    return `moltzap-registry startup failed in phase ${this.phase}${detail}`;
  }
}

const runRegistryServer = Effect.gen(function* () {
  const configuration = yield* loadRegistryConfiguration.pipe(
    Effect.mapError(configurationFailure),
  );
  const registrySigningAuthority = yield* loadSigningAuthority(configuration);
  const registrySignerPublicKey = AgentSigningAuthority.publicKey(
    registrySigningAuthority,
  );
  const storage = yield* connectStorage(configuration, registrySignerPublicKey);
  const app = yield* buildRegistryApp({
    configuration,
    storage,
    registrySigningAuthority,
  });
  yield* serveRegistry(configuration, guardRegistryApp(app));
});

/**
 * Complete production Registry process composition.
 *
 * ```mermaid
 * flowchart TD
 *   Binary["moltzap-registry"] --> Server["runRegistryServer"]
 *   Server --> Configuration["loadRegistryConfiguration"]
 *   Server --> Storage["RegistryStorage"]
 *   Server --> Http["makeRegistryHttpApp"]
 *   Http --> Admission["verifyBootstrapRegistration"]
 *   Http --> Rpc["RegistryRpcClient"]
 *   Admission --> Storage
 *   Rpc --> Storage
 *   Http --> Response["HttpServerResponse"]
 * ```
 */
// safer-arch-ignore require-boundary-owned-types: The declared Layer type is the public boundary; this composition root provides the Node adapter internally.
export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
  runRegistryServer.pipe(Effect.provide(NodeContext.layer)),
);

function loadSigningAuthority(configuration: RegistryConfiguration) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const privateKeyText = yield* fileSystem
      .readFileString(Redacted.value(configuration.signingPrivateKeyPath))
      .pipe(Effect.mapError(configurationFailure));
    return yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(privateKeyText),
    ).pipe(Effect.mapError(configurationFailure));
  });
}

function connectStorage(
  configuration: RegistryConfiguration,
  registrySignerPublicKey: ReturnType<typeof AgentSigningAuthority.publicKey>,
) {
  return Effect.gen(function* () {
    const sql = yield* PgClient.make({
      url: configuration.postgresqlUrl,
      maxConnections: configuration.sqlPoolSize,
      connectTimeout: Duration.millis(configuration.sqlOperationTimeoutMs),
      applicationName: "moltzap-registry",
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(storageFailure));
    yield* initializeRegistryStorage({
      sql,
      registrySignerPublicKey,
    }).pipe(
      Effect.mapError(storageFailure),
      Effect.timeoutFail({
        duration: Duration.millis(configuration.sqlOperationTimeoutMs),
        onTimeout: storageFailure,
      }),
    );
    return makeRegistryStorage({
      sql,
      registrySignerPublicKey,
      listPageSize: configuration.listPageSize,
      operationTimeoutMilliseconds: configuration.sqlOperationTimeoutMs,
    });
  });
}

function buildRegistryApp(input: {
  readonly configuration: RegistryConfiguration;
  readonly storage: RegistryStorage;
  readonly registrySigningAuthority: AgentSigningAuthority;
}) {
  return Effect.gen(function* () {
    const handlers = makeRegistryRpcHandlersLayer({
      storage: input.storage,
      registrySigningAuthority: input.registrySigningAuthority,
    });
    const client = yield* makeRegistryRpcClient.pipe(
      Effect.provide(handlers),
      Effect.provide(registryAdmissionLayer),
    );
    const requestSemaphore = yield* Effect.makeSemaphore(
      input.configuration.requestConcurrencyLimit,
    );
    return makeRegistryHttpApp({
      client,
      storage: input.storage,
      admissionCredential: input.configuration.admissionCredential,
      nonceCapacity: input.configuration.liveNonceCapacity,
      requestSemaphore,
    });
  });
}

function guardRegistryApp(app: ReturnType<typeof makeRegistryHttpApp>) {
  return app.pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError(
        "Registry HTTP application failed",
        Cause.squash(cause),
      ).pipe(Effect.as(HttpServerResponse.empty({ status: 500 }))),
    ),
  );
}

function serveRegistry(
  configuration: RegistryConfiguration,
  app: ReturnType<typeof guardRegistryApp>,
) {
  return Effect.gen(function* () {
    const httpServer = yield* NodeHttpServer.make(createServer, {
      host: configuration.host,
      port: configuration.port,
    }).pipe(Effect.mapError(listenerFailure));
    yield* HttpServer.serveEffect(app).pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
    );
    yield* Console.log(
      `moltzap-registry listening on ${listeningUrl(httpServer.address)} (package ${packageJson.version}; MOLTZAP_VERSION ${MOLTZAP_VERSION})`,
    );
  });
}

function configurationFailure(cause: unknown) {
  return new StartupError({ phase: "configuration", cause });
}

function storageFailure(cause?: unknown) {
  return new StartupError({ phase: "storage", cause });
}

function listenerFailure(cause: unknown) {
  return new StartupError({ phase: "listener", cause });
}

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

/** IPv6 listener addresses need brackets in a URL authority. */
function listeningUrl(address: HttpServer.Address): string {
  if (address._tag === "UnixAddress") {
    return HttpServer.formatAddress(address);
  }
  const host = address.hostname.includes(":")
    ? `[${address.hostname}]`
    : address.hostname;
  return `http://${host}:${address.port}`;
}
