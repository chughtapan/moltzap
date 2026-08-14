/** @file Production Registry process configuration, composition, and startup boundary. */

import * as Reactivity from "@effect/experimental/Reactivity";
import { FileSystem, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  Cause,
  Config,
  type ConfigError,
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
);
const admissionCredential = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9\-._~+/]+=*$/),
);
const absolutePath = Schema.String.pipe(
  Schema.filter((value) => isAbsolute(value)),
);

const configuredValues = Config.all({
  host: Schema.Config("MOLTZAP_REGISTRY_HOST", bindHost).pipe(
    Config.withDefault("127.0.0.1"),
  ),
  port: Schema.Config("MOLTZAP_REGISTRY_PORT", port),
  postgresqlUrl: Config.redacted(
    Schema.Config("MOLTZAP_REGISTRY_POSTGRESQL_URL", postgresqlUrl),
  ),
  admissionCredential: Config.redacted(
    Schema.Config("MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL", admissionCredential),
  ),
  signingPrivateKeyPath: Config.redacted(
    Schema.Config("MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH", absolutePath),
  ),
  listPageSize: Schema.Config(
    "MOLTZAP_REGISTRY_LIST_PAGE_SIZE",
    processInteger,
  ).pipe(Config.withDefault(100)),
  requestConcurrencyLimit: Schema.Config(
    "MOLTZAP_REGISTRY_REQUEST_CONCURRENCY_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(256)),
  liveNonceCapacity: Schema.Config(
    "MOLTZAP_REGISTRY_LIVE_NONCE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(10_000)),
  sqlPoolSize: Schema.Config(
    "MOLTZAP_REGISTRY_SQL_POOL_SIZE",
    processInteger,
  ).pipe(Config.withDefault(10)),
  sqlOperationTimeoutMs: Schema.Config(
    "MOLTZAP_REGISTRY_SQL_OPERATION_TIMEOUT_MS",
    processInteger,
  ).pipe(Config.withDefault(5_000)),
});

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
}> {}

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
      // The server capability owns listener acquisition and release.
      Effect.provideService(HttpServer.HttpServer, httpServer),
    );
  });
}

function configurationFailure() {
  return new StartupError({ phase: "configuration" });
}

function storageFailure() {
  return new StartupError({ phase: "storage" });
}

function listenerFailure() {
  return new StartupError({ phase: "listener" });
}
