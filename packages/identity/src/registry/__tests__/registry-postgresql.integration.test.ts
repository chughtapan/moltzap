/** @file PostgreSQL Registry persistence, restart, admission, and outage integration tests. */

import * as Reactivity from "@effect/experimental/Reactivity";
import {
  FileSystem,
  type HttpClientRequest,
  HttpServerRequest,
} from "@effect/platform";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Either,
  Fiber,
  Match,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { join } from "node:path";
import { expect, it } from "vitest";
import { encodeCanonicalJson } from "../../canonical-json.js";
import { AuthenticationFailedError } from "../../http-errors.js";
import {
  AgentCard,
  AgentSigningAuthority,
  type VerifiedAgentCard,
  WIRE_VERSION,
} from "../../index.js";
import { Registry, RegistryRegisterRequest } from "../../registry.js";
import { verifyBootstrapRegistration } from "../admission.js";
import { initializeRegistryStorage, makeRegistryStorage } from "../storage.js";
import {
  ADMISSION_CREDENTIAL,
  LOOPBACK_HOST,
  makePrivateKeyPem,
  makeRegistryRunner,
  makeSigningAuthority,
  makeVersionedBootstrapRequest,
  managedProcess,
  prepareAgent,
  processTestError,
  registerAgent,
  REGISTRY_BINARY,
  registryEnvironment,
  reservePort,
  startReadyRegistry,
  stopProcess,
  waitForExit,
  waitForHealthStatus,
} from "./registry-process.js";

const SERVICE_UNAVAILABLE_STATUS = 503;
const EMPTY_BODY = "";
const FOUND_KIND = "found";
const REGISTERED_KIND = "registered";
const NEWER_SCHEMA_REASON = "newer-schema";

const stopPostgreSql = (container: StartedPostgreSqlContainer) =>
  Effect.tryPromise({
    try: () => container.stop(),
    catch: (cause) =>
      processTestError("could not stop PostgreSQL container", cause),
  }).pipe(Effect.asVoid);

const managedPostgreSql = Effect.acquireRelease(
  Effect.tryPromise({
    try: () =>
      new PostgreSqlContainer("postgres:16-alpine")
        .withDatabase("registry")
        .withUsername("registry")
        .withPassword("registry-password")
        .start(),
    catch: (cause) =>
      processTestError("could not start PostgreSQL container", cause),
  }),
  (container) => stopPostgreSql(container).pipe(Effect.ignore),
);

/**
 * PostgreSQL publishes its host port before the Registry selects a free
 * listener port, keeping container startup out of that allocation window.
 */
const makePostgreSqlRegistrySetup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "sharness-registry-postgresql-",
  });
  const privateKeyPem = makePrivateKeyPem();
  const registryKeyPath = join(temporaryDirectory, "registry-key.pem");
  yield* fileSystem.writeFileString(registryKeyPath, privateKeyPem, {
    mode: 0o600,
  });
  const signingAuthority = yield* makeSigningAuthority(privateKeyPem);
  const registrySignerPublicKey =
    AgentSigningAuthority.publicKey(signingAuthority);
  const container = yield* managedPostgreSql;
  const registryPort = yield* reservePort;
  const origin = new URL(`http://${LOOPBACK_HOST}:${registryPort}`);
  const environment = registryEnvironment({
    port: registryPort,
    postgresqlUrl: container.getConnectionUri(),
    registryKeyPath,
  });
  return {
    container,
    environment,
    origin,
    registrySignerPublicKey,
    signingAuthority,
  };
});

const expectExactCard = (
  actual: VerifiedAgentCard,
  expected: VerifiedAgentCard,
) =>
  Effect.all(
    [
      Schema.encode(AgentCard)(actual),
      Schema.encode(AgentCard)(expected),
    ] as const,
    { concurrency: 2 },
  ).pipe(
    Effect.map(([actualEncoded, expectedEncoded]) => {
      expect(actualEncoded).toStrictEqual(expectedEncoded);
      return actualEncoded;
    }),
  );

const makeExpiryBoundaryClock = (expiresAt: number) =>
  Effect.gen(function* () {
    const liveClock = Clock.make();
    const release = yield* Deferred.make<undefined>();
    const sampled = yield* Deferred.make<undefined>();
    const sampleCount = yield* Ref.make(0);
    const expiresAtMilliseconds = expiresAt * 1_000;
    const expiredMilliseconds = expiresAtMilliseconds + 1_000;
    const currentTimeMillis = Ref.updateAndGet(
      sampleCount,
      (count) => count + 1,
    ).pipe(
      Effect.tap((count) =>
        count === 2 ? Deferred.succeed(sampled, undefined) : Effect.void,
      ),
      Effect.flatMap((count) =>
        count <= 2
          ? Deferred.await(release).pipe(Effect.as(expiresAtMilliseconds))
          : Effect.succeed(expiredMilliseconds),
      ),
    );
    const clock = {
      [Clock.ClockTypeId]: Clock.ClockTypeId,
      unsafeCurrentTimeMillis: () => expiredMilliseconds,
      currentTimeMillis,
      unsafeCurrentTimeNanos: () => BigInt(expiredMilliseconds) * 1_000_000n,
      currentTimeNanos: liveClock.currentTimeNanos,
      sleep: (duration: Parameters<Clock.Clock["sleep"]>[0]) =>
        liveClock.sleep(duration),
    } satisfies Clock.Clock;
    return { clock, release, sampled };
  });

const requestBodyBytes = (
  request: HttpClientRequest.HttpClientRequest,
): Uint8Array =>
  Match.value(request.body).pipe(
    Match.tag("Uint8Array", (body) => Uint8Array.from(body.body)),
    Match.tag("Empty", "Raw", "FormData", "Stream", () => {
      throw new Error("signed registration did not retain its byte body");
    }),
    Match.exhaustive,
  );

const signatureExpiry = (
  request: HttpClientRequest.HttpClientRequest,
): number => {
  const signatureInput = request.headers["signature-input"];
  const match =
    typeof signatureInput === "string"
      ? /;expires=(\d+)/u.exec(signatureInput)
      : null;
  const encodedExpiry = match?.[1];
  if (encodedExpiry === undefined) {
    throw new Error("registration signature is missing its expiry");
  }
  const expiry = Schema.NumberFromString.pipe(
    Schema.int(),
    Schema.nonNegative(),
  );
  return Schema.decodeUnknownSync(expiry)(encodedExpiry);
};

const toServerRequest = (
  request: HttpClientRequest.HttpClientRequest,
): HttpServerRequest.HttpServerRequest => {
  const url = new URL(request.url);
  return HttpServerRequest.fromWeb(
    new Request(url, {
      method: request.method,
      headers: {
        ...request.headers,
        host: url.host,
      },
    }),
  );
};

const makeDirectStorage = (input: {
  readonly container: StartedPostgreSqlContainer;
  readonly registrySignerPublicKey: ReturnType<
    typeof AgentSigningAuthority.publicKey
  >;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.make({
      url: Redacted.make(input.container.getConnectionUri()),
      maxConnections: 2,
      connectTimeout: Duration.seconds(5),
      applicationName: "sharness-registry-replay-boundary",
    }).pipe(Effect.provide(Reactivity.layer));
    return makeRegistryStorage({
      sql,
      registrySignerPublicKey: input.registrySignerPublicKey,
      listPageSize: 100,
      operationTimeoutMilliseconds: 5_000,
    });
  });

const assertDurableReplayBoundary = (input: {
  readonly container: StartedPostgreSqlContainer;
  readonly origin: URL;
  readonly registrySignerPublicKey: ReturnType<
    typeof AgentSigningAuthority.publicKey
  >;
}) =>
  Effect.gen(function* () {
    const prepared = yield* prepareAgent("expiry-boundary");
    const request = yield* makeVersionedBootstrapRequest(
      input.origin,
      prepared,
      WIRE_VERSION,
    );
    const boundaryClock = yield* makeExpiryBoundaryClock(
      signatureExpiry(request),
    );
    const storage = yield* makeDirectStorage(input);
    const verify = verifyBootstrapRegistration({
      httpRequest: toServerRequest(request),
      bodyBytes: requestBodyBytes(request),
      admissionCredential: Redacted.make(ADMISSION_CREDENTIAL),
      nonceCapacity: 10_000,
      storage,
    }).pipe(Effect.either);
    const attempts = Effect.all([verify, verify] as const, {
      concurrency: 2,
    }).pipe(Effect.withClock(boundaryClock.clock));
    const fiber = yield* Effect.fork(attempts);
    yield* Deferred.await(boundaryClock.sampled);
    yield* Deferred.succeed(boundaryClock.release, undefined);
    const outcomes = yield* Fiber.join(fiber);
    const accepted = outcomes.filter(Either.isRight);
    const refused = outcomes.filter(Either.isLeft);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(
      refused.every(
        (outcome) => outcome.left instanceof AuthenticationFailedError,
      ),
    ).toBe(true);
  });

/**
 * Persistence binds the database and signer, independent of the listener origin.
 * Select a port immediately before restart because parallel tests or Docker can
 * claim the first process's port after it stops.
 */
const realPostgreSqlBehavior = Effect.gen(function* () {
  const setup = yield* makePostgreSqlRegistrySetup;
  const firstProcess = yield* startReadyRegistry(
    setup.environment,
    setup.origin,
  );
  const registered = yield* registerAgent(
    "postgresql-agent",
    makeRegistryRunner(setup.origin, setup.registrySignerPublicKey),
  );
  yield* stopProcess(firstProcess);

  const restartPort = yield* reservePort;
  const restartOrigin = new URL(`http://${LOOPBACK_HOST}:${restartPort}`);
  const restarted = yield* startReadyRegistry(
    { ...setup.environment, SHARNESS_REGISTRY_PORT: String(restartPort) },
    restartOrigin,
  );
  const lookup = yield* makeRegistryRunner(
    restartOrigin,
    setup.registrySignerPublicKey,
  )(Registry.lookup({ agentId: registered.agentCard.agentId }));
  expect(lookup.kind).toBe(FOUND_KIND);
  if (lookup.kind === FOUND_KIND) {
    yield* expectExactCard(lookup.agentCard, registered.agentCard);
  }
  yield* assertDurableReplayBoundary({ ...setup, origin: restartOrigin });

  yield* stopPostgreSql(setup.container);
  const unhealthy = yield* waitForHealthStatus({
    runningProcess: restarted,
    origin: restartOrigin,
    expectedStatus: SERVICE_UNAVAILABLE_STATUS,
  });
  expect(unhealthy).toStrictEqual({
    status: SERVICE_UNAVAILABLE_STATUS,
    body: EMPTY_BODY,
  });
  yield* stopProcess(restarted);
}).pipe(
  Effect.scoped,
  Effect.provide(NodeFileSystem.layer),
  Effect.provide(NodeHttpClient.layer),
);

// @agent-code-guard/regression-only: these scenarios cover distinct database restart, outage, and startup refusal contracts against real PostgreSQL.
it("persists across Registry restart on real PostgreSQL and reports a database outage", () => {
  expect.hasAssertions();
  return Effect.runPromise(realPostgreSqlBehavior);
}, 180_000);

it("reopens a known ledger and serves the same card", () => {
  expect.hasAssertions();
  return Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* makePostgreSqlRegistrySetup;
      const sql = yield* PgClient.make({
        url: Redacted.make(setup.container.getConnectionUri()),
      }).pipe(Effect.provide(Reactivity.layer));
      yield* initializeRegistryStorage({
        sql,
        registrySignerPublicKey: setup.registrySignerPublicKey,
      });
      const storage = makeRegistryStorage({
        sql,
        registrySignerPublicKey: setup.registrySignerPublicKey,
        listPageSize: 100,
        operationTimeoutMilliseconds: 5_000,
      });
      const prepared = yield* prepareAgent("ledger-authority");
      const requestBytes = yield* Schema.encode(RegistryRegisterRequest)(
        prepared.request,
      ).pipe(Effect.flatMap(encodeCanonicalJson));
      const registered = yield* storage.register({
        request: prepared.request,
        requestBytes,
        registrySigningAuthority: setup.signingAuthority,
      });
      expect(registered.kind).toBe(REGISTERED_KIND);
      yield* initializeRegistryStorage({
        sql,
        registrySignerPublicKey: setup.registrySignerPublicKey,
      });
      yield* storage.checkReadiness();
      const lookup = yield* storage.lookup({
        agentName: prepared.request.agentName,
      });
      expect(lookup.kind).toBe(FOUND_KIND);
      if (lookup.kind === FOUND_KIND && registered.kind === REGISTERED_KIND) {
        yield* expectExactCard(lookup.agentCard, registered.agentCard);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
}, 180_000);

it.each([{ mismatch: "signer", reason: "signer-mismatch" }])(
  "refuses a metadata $mismatch mismatch through storage and process startup",
  ({ mismatch, reason }) => {
    expect.hasAssertions();
    return Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* makePostgreSqlRegistrySetup;
        const sql = yield* PgClient.make({
          url: Redacted.make(setup.container.getConnectionUri()),
        }).pipe(Effect.provide(Reactivity.layer));
        yield* initializeRegistryStorage({
          sql,
          registrySignerPublicKey: setup.registrySignerPublicKey,
        });
        yield* sql`UPDATE sharness_registry_metadata SET signer_thumbprint = 'different-signer'`;

        const initialized = yield* initializeRegistryStorage({
          sql,
          registrySignerPublicKey: setup.registrySignerPublicKey,
        }).pipe(Effect.either);
        Either.match(initialized, {
          onLeft: (error) => {
            expect(error.reason).toBe(reason);
          },
          onRight: () => {
            expect.fail(`Registry accepted a metadata ${mismatch} mismatch`);
          },
        });
        const process = yield* managedProcess(
          REGISTRY_BINARY,
          [],
          setup.environment,
        );
        yield* waitForExit(process).pipe(
          Effect.timeoutFail({
            duration: Duration.seconds(10),
            onTimeout: () =>
              processTestError(
                `Registry did not refuse the metadata mismatch\n${process.logs()}`,
              ),
          }),
        );
        expect(process.child.exitCode).not.toBe(0);
        expect(process.logs()).toContain(`storage (${reason})`);
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    );
  },
  180_000,
);

it("refuses an unknown applied migration with newer-schema through storage and process startup", () => {
  expect.hasAssertions();
  return Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* makePostgreSqlRegistrySetup;
      const sql = yield* PgClient.make({
        url: Redacted.make(setup.container.getConnectionUri()),
      }).pipe(Effect.provide(Reactivity.layer));
      yield* initializeRegistryStorage({
        sql,
        registrySignerPublicKey: setup.registrySignerPublicKey,
      });
      yield* sql`INSERT INTO sharness_registry_ledger (migration_id, name) VALUES (9999, 'future')`;

      const initialized = yield* initializeRegistryStorage({
        sql,
        registrySignerPublicKey: setup.registrySignerPublicKey,
      }).pipe(Effect.either);
      Either.match(initialized, {
        onLeft: (error) => {
          expect(error.reason).toBe(NEWER_SCHEMA_REASON);
        },
        onRight: () => {
          expect.fail("Registry accepted an unknown applied migration");
        },
      });
      const process = yield* managedProcess(
        REGISTRY_BINARY,
        [],
        setup.environment,
      );
      yield* waitForExit(process).pipe(
        Effect.timeoutFail({
          duration: Duration.seconds(10),
          onTimeout: () =>
            processTestError(
              `Registry did not refuse the newer schema\n${process.logs()}`,
            ),
        }),
      );
      expect(process.child.exitCode).not.toBe(0);
      expect(process.logs()).toContain(NEWER_SCHEMA_REASON);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
}, 180_000);

it.each(["moltzap_registry_migrations", "sharness_registry_migrations"])(
  "refuses a pre-reset %s ledger before creating the reset ledger",
  (preResetLedger) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* makePostgreSqlRegistrySetup;
        const sql = yield* PgClient.make({
          url: Redacted.make(setup.container.getConnectionUri()),
        }).pipe(Effect.provide(Reactivity.layer));
        yield* sql`CREATE TABLE ${sql(preResetLedger)} (migration_id integer PRIMARY KEY)`;
        const initialized = yield* initializeRegistryStorage({
          sql,
          registrySignerPublicKey: setup.registrySignerPublicKey,
        }).pipe(Effect.either);
        const preResetReason = "pre-reset";
        expect(
          Either.match(initialized, {
            onLeft: (error) => error.reason,
            onRight: () => undefined,
          }),
        ).toBe(preResetReason);
        const ledger =
          yield* sql`SELECT to_regclass('sharness_registry_ledger')::text AS ledger`;
        expect(ledger[0]?.ledger).toBeNull();
        const process = yield* managedProcess(
          REGISTRY_BINARY,
          [],
          setup.environment,
        );
        yield* waitForExit(process);
        expect(process.child.exitCode).not.toBe(0);
        expect(process.logs()).toContain(preResetReason);
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    ),
  180_000,
);
