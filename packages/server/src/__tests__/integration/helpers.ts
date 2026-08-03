/**
 * Core test helpers — drop-in replacement for the app server's helpers.ts.
 * Uses the shared testcontainers Postgres from vitest globalSetup.
 */
import {
  startCoreTestServerFull,
  stopCoreTestServer,
  resetCoreTestDb,
  getCoreDb,
  getBaseUrl,
} from "../../test-utils/server.js";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  type AgentKey,
  type UserId,
  userId,
  type AgentId,
} from "@moltzap/protocol/identity";
import type { Part } from "@moltzap/protocol/message";
import type { TestAgentClient } from "@moltzap/protocol/testing";
import {
  awaitOneNotification,
  registerAndConnect,
  setupAgentPair,
  setupAgentGroup,
  closeAllClients,
  createTestAgent,
  trackClient,
  registerAgent,
  connectTestClient,
  postJson,
} from "../../test-utils/helpers.js";
import type { CoreApp } from "#core";
import { Effect, Either, Schema } from "effect";
import { it as effectIt } from "@effect/vitest";
import { inject } from "vitest";

/** Provides the http ok runtime value. */
export const HTTP_OK = 200;
/** Provides the http created runtime value. */
export const HTTP_CREATED = 201;
/** Provides the http bad request runtime value. */
export const HTTP_BAD_REQUEST = 400;
/** Provides the http unauthorized runtime value. */
export const HTTP_UNAUTHORIZED = 401;
/** Provides the http forbidden runtime value. */
export const HTTP_FORBIDDEN = 403;
/** Provides the http conflict runtime value. */
export const HTTP_CONFLICT = 409;
/** Default value for notification timeout ms. */
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 5_000;
/** Provides the it runtime value. */
export const it = effectIt.live;

/** Re-exports the public API from `../../test-utils/helpers.js`. */
export type { ConnectedAgent } from "../../test-utils/helpers.js";
/** Re-exports the public API from `current module`. */
export {
  awaitOneNotification,
  connectTestClient,
  createTestAgent,
  getBaseUrl,
  postJson,
  registerAgent,
  registerAndConnect,
  setupAgentPair,
  setupAgentGroup,
  trackClient,
};
/** Re-exports the public API from `current module`. */
export type { TestAgentClient };

class IntegrationTestHelperError extends Error {
  override readonly name = "IntegrationTestHelperError";

  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Read the text of a `text` part. Throws on a non-text variant — callers
 * assert on text payloads they just sent.
 * @param part Value supplied to the operation.
 * @returns The text of part result.
 */
export function textOfPart(part?: Part): string {
  if (part === undefined || part.type !== "text") {
    throw new IntegrationTestHelperError("Expected a text part in message.");
  }
  return part.text;
}

/**
 * Text of the first part. See {@link textOfPart}.
 * @param parts Value supplied to the operation.
 * @returns The first text part result.
 */
export function firstTextPart(parts: readonly Part[]): string {
  return textOfPart(parts[0]);
}

/**
 * Executes the expect either left operation.
 * @param value Value to process.
 * @returns The expect either left result.
 */
export function expectEitherLeft<A, E>(value: Either.Either<A, E>): E {
  return Either.match(value, {
    onLeft: (error) => error,
    onRight: () => {
      throw new IntegrationTestHelperError("Expected Either.Left.");
    },
  });
}

let coreAppValue: CoreApp | null = null;

interface StartTestServerOptions {
  devMode?: boolean;

  /** Optional registration secret forwarded to the core test server. */
  registrationSecret?: string;

  /** Boot admin owner id used by the default registration route. */
  adminUserId?: UserId;
  spanProcessor?: SpanProcessor;
}

/** Describes test user. */
export interface TestUser {
  readonly id: UserId;
  readonly supabaseUid: string;
  readonly displayName: string;
}

/** Describes owned agent registration. */
export interface OwnedAgentRegistration {
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
  readonly ownerUserId: UserId;
  readonly user: TestUser;
}

interface RegisterOwnedAgentOptions {
  readonly baseUrl: string;
  readonly inviteCode: string;
  readonly name: string;
  readonly user: TestUser;
  readonly description?: string;
}

/**
 * Start the core test server using the shared Postgres from globalSetup.
 * @param optsValue Value supplied to the operation.
 * @returns The start test server effect result.
 */
export function startTestServerEffect(optsValue?: StartTestServerOptions) {
  const opts = optsValue ?? {};
  // Get pgHost/pgPort from vitest's globalSetup via inject()
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");

  return Effect.tryPromise({
    try: () =>
      startCoreTestServerFull({
        pgHost,
        pgPort,
        registrationSecret: opts.registrationSecret,
        adminUserId: opts.adminUserId,
        spanProcessor: opts.spanProcessor,
      }),
    catch: (cause) =>
      new IntegrationTestHelperError("Core test server failed to start", cause),
  }).pipe(
    Effect.tap((server) =>
      Effect.sync(() => {
        coreAppValue = server.coreApp;
      }),
    ),
    Effect.map((server) => ({
      baseUrl: server.baseUrl,
      wsUrl: server.wsUrl,
      coreApp: server.coreApp,
      spanExporter: server.testPort.spanExporter,
    })),
    Effect.withSpan("startTestServer"),
  );
}

/**
 * Executes the start test server operation.
 * @param optsValue Value supplied to the operation.
 * @returns The start test server result.
 */
export function startTestServer(optsValue?: StartTestServerOptions) {
  const opts = optsValue ?? {};
  return Effect.runPromise(startTestServerEffect(opts));
}

/**
 * Returns core app.
 * @returns The get core app result.
 */
export function getCoreApp(): CoreApp {
  if (!coreAppValue) {
    throw new IntegrationTestHelperError("Test server not running.");
  }
  return coreAppValue;
}

/**
 * Executes the stop test server effect operation.
 * @returns The stop test server effect result.
 */
export function stopTestServerEffect() {
  return Effect.gen(function* () {
    yield* closeAllClients();
    coreAppValue = null;
    yield* Effect.tryPromise({
      try: () => stopCoreTestServer(),
      catch: (cause) =>
        new IntegrationTestHelperError(
          "Core test server failed to stop",
          cause,
        ),
    });
  }).pipe(Effect.withSpan("stopTestServer"));
}

/**
 * Executes the stop test server operation.
 * @returns The stop test server result.
 */
export function stopTestServer() {
  return Effect.runPromise(stopTestServerEffect());
}

/**
 * Executes the reset test db effect operation.
 * @returns The reset test db effect result.
 */
export function resetTestDbEffect() {
  return Effect.gen(function* () {
    yield* closeAllClients();
    yield* Effect.tryPromise({
      try: () => resetCoreTestDb(),
      catch: (cause) =>
        new IntegrationTestHelperError("Core test DB failed to reset", cause),
    });
  }).pipe(Effect.withSpan("resetTestDb"));
}

/**
 * Executes the reset test db operation.
 * @returns The reset test db result.
 */
export function resetTestDb() {
  return Effect.runPromise(resetTestDbEffect());
}

/**
 * Registers owned agent.
 * @param opts Value supplied to the operation.
 * @returns The register owned agent result.
 */
export function registerOwnedAgent(opts: RegisterOwnedAgentOptions) {
  return Effect.gen(function* () {
    const reg = yield* createTestAgent(opts.name, {
      ownerUserId: opts.user.id,
      description: opts.description,
    });
    return {
      agentId: reg.agentId,
      apiKey: reg.apiKey,
      ownerUserId: opts.user.id,
      user: opts.user,
    };
  }).pipe(Effect.withSpan("registerOwnedAgent"));
}

/**
 * Returns kysely db.
 * @returns The get kysely db result.
 */
export function getKyselyDb(): ReturnType<typeof getCoreDb> {
  return getCoreDb();
}

/**
 * Returns test core app.
 * @returns The get test core app result.
 */
export function getTestCoreApp() {
  return getCoreApp();
}

/**
 * Creates test user.
 * @param displayName Value supplied to the operation.
 * @param id Value supplied to the operation.
 * @returns The created test user.
 */
export function createTestUser(displayName: string, id?: string) {
  return {
    id: Schema.decodeUnknownSync(userId)(id ?? crypto.randomUUID()),
    supabaseUid: crypto.randomUUID(),
    displayName,
  };
}

/**
 * Creates agent invite.
 * @param inviterId Value supplied to the operation.
 * @returns The created agent invite.
 */
export function createAgentInvite(inviterId: string) {
  return {
    token: "not-needed-in-core",
    inviteId: crypto.randomUUID(),
    inviterId,
  };
}
