import { FileSystem, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeContext, NodeHttpServer } from "@effect/platform-node";
import * as Reactivity from "@effect/experimental/Reactivity";
import { PgClient } from "@effect/sql-pg";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- NodeHttpServer.make requires the platform listener constructor at this adapter boundary.
import { createServer } from "node:http";
import { Cause, Data, Duration, Effect, Layer, Redacted } from "effect";
import { AgentSigningAuthority } from "../agent-signing-authority.js";
import {
  loadRegistryConfiguration,
  type RegistryConfiguration,
} from "./configuration.js";
import { makeRegistryHttpApp } from "./http.js";
import { makeRegistryRpcClient, makeRegistryRpcHandlersLayer } from "./rpc.js";
import { registryAdmissionLayer } from "./request-context.js";
import {
  initializeRegistryStorage,
  makeRegistryStorage,
  type RegistryStorage,
} from "./storage.js";

/** Closed Registry startup failure. */
export class StartupError extends Data.TaggedError(
  "RegistryServerStartupError",
)<{
  readonly phase: "configuration" | "storage" | "listener";
}> {}

const configurationFailure = () => new StartupError({ phase: "configuration" });
const storageFailure = () => new StartupError({ phase: "storage" });
const listenerFailure = () => new StartupError({ phase: "listener" });

const loadSigningAuthority = (configuration: RegistryConfiguration) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const privateKeyText = yield* fileSystem
      .readFileString(Redacted.value(configuration.signingPrivateKeyPath))
      .pipe(Effect.mapError(configurationFailure));
    return yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(privateKeyText),
    ).pipe(Effect.mapError(configurationFailure));
  });

const connectStorage = (
  configuration: RegistryConfiguration,
  registrySignerPublicKey: ReturnType<typeof AgentSigningAuthority.publicKey>,
) =>
  Effect.gen(function* () {
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

const buildRegistryApp = (input: {
  readonly configuration: RegistryConfiguration;
  readonly storage: RegistryStorage;
  readonly registrySigningAuthority: AgentSigningAuthority;
}) =>
  Effect.gen(function* () {
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

const guardRegistryApp = (app: ReturnType<typeof makeRegistryHttpApp>) =>
  app.pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError(
        "Registry HTTP application failed",
        Cause.squash(cause),
      ).pipe(Effect.as(HttpServerResponse.empty({ status: 500 }))),
    ),
  );

const serveRegistry = (
  configuration: RegistryConfiguration,
  app: ReturnType<typeof guardRegistryApp>,
) =>
  Effect.gen(function* () {
    const httpServer = yield* NodeHttpServer.make(createServer, {
      host: configuration.host,
      port: configuration.port,
    }).pipe(Effect.mapError(listenerFailure));
    yield* HttpServer.serveEffect(app).pipe(
      // The server capability owns listener acquisition and release.
      Effect.provideService(HttpServer.HttpServer, httpServer),
    );
  });

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

/** Complete production Registry process composition. */
export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
  runRegistryServer.pipe(Effect.provide(NodeContext.layer)),
);
