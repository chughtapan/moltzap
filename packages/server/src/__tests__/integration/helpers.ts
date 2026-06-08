/**
 * Core test helpers — drop-in replacement for the app server's helpers.ts.
 * Uses the shared testcontainers Postgres from vitest globalSetup.
 */
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
  getCoreDb,
  getCoreEncryptionEnvelope,
  getBaseUrl,
} from "../../test-utils/index.js";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { AgentKey } from "@moltzap/protocol/identity";
import { UserId } from "@moltzap/protocol/identity";
import type { AgentId } from "@moltzap/protocol/identity";
import type { Part } from "@moltzap/protocol/message";
import type { TestAgentClient, TestAppClient } from "@moltzap/protocol/testing";
import {
  awaitOneNotification,
  registerAndConnect,
  setupAgentPair,
  setupAgentGroup,
  closeAllClients,
  createTestAgent,
  trackClient,
  registerAgent,
  registerApp,
  connectAppClient,
  connectTestClient,
  postJson,
} from "../../test-utils/helpers.js";
import type { CoreApp } from "#core";
import { Effect, Either, Schema } from "effect";
import { it as effectIt } from "@effect/vitest";
import { inject } from "vitest";

export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_CONFLICT = 409;
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 5_000;
export const it = effectIt.live;

export type { ConnectedAgent } from "../../test-utils/helpers.js";
export {
  awaitOneNotification,
  connectAppClient,
  connectTestClient,
  createTestAgent,
  getBaseUrl,
  postJson,
  registerAgent,
  registerApp,
  registerAndConnect,
  setupAgentPair,
  setupAgentGroup,
  trackClient,
};
export type { TestAgentClient, TestAppClient };

/**
 * Read the text of a `text` part. Throws on a non-text variant — callers
 * assert on text payloads they just sent.
 */
export function textOfPart(part: Part | undefined): string {
  if (part === undefined || part.type !== "text") {
    throw new IntegrationTestHelperError("Expected a text part in message.");
  }
  return part.text;
}

/** Text of the first part. See {@link textOfPart}. */
export function firstTextPart(parts: ReadonlyArray<Part>): string {
  return textOfPart(parts[0]);
}

export function expectEitherLeft<A, E>(value: Either.Either<A, E>): E {
  return Either.match(value, {
    onLeft: (error) => error,
    onRight: () => {
      throw new IntegrationTestHelperError("Expected Either.Left.");
    },
  });
}

let _coreApp: CoreApp | null = null;

type StartTestServerOptions = {
  devMode?: boolean;
  encryption?: boolean;

  /** Optional secret forwarded to `startCoreTestServer` — see its docs. */
  registrationSecret?: string;

  /** Boot admin owner id used by the default registration route. */
  adminUserId?: UserId;
  spanProcessor?: SpanProcessor;
};

class IntegrationTestHelperError extends Error {
  override readonly name = "IntegrationTestHelperError";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface TestUser {
  readonly id: UserId;
  readonly supabaseUid: string;
  readonly displayName: string;
}

export interface ClaimedAgentRegistration {
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
  readonly ownerUserId: UserId;
  readonly user: TestUser;
}

interface RegisterClaimedAgentOptions {
  readonly baseUrl: string;
  readonly inviteCode: string;
  readonly name: string;
  readonly user: TestUser;
  readonly description?: string;
}

/**
 * Start the core test server using the shared Postgres from globalSetup.
 */
export function startTestServerEffect(_opts?: StartTestServerOptions) {
  const opts = _opts ?? {};
  // Get pgHost/pgPort from vitest's globalSetup via inject()
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");

  return Effect.tryPromise({
    try: () =>
      startCoreTestServer({
        pgHost,
        pgPort,
        encryption: opts.encryption,
        registrationSecret: opts.registrationSecret,
        adminUserId: opts.adminUserId,
        spanProcessor: opts.spanProcessor,
      }),
    catch: (cause) =>
      new IntegrationTestHelperError("Core test server failed to start", cause),
  }).pipe(
    Effect.tap((server) =>
      Effect.sync(() => {
        _coreApp = server.coreApp;
      }),
    ),
    Effect.map((server) => ({
      baseUrl: server.baseUrl,
      wsUrl: server.wsUrl,
      coreApp: server.coreApp,
      spanExporter: server.spanExporter,
    })),
    Effect.withSpan("startTestServer"),
  );
}

export function startTestServer(_opts?: StartTestServerOptions) {
  const opts = _opts ?? {};
  return Effect.runPromise(startTestServerEffect(opts));
}

export function getCoreApp(): CoreApp {
  if (!_coreApp)
    throw new IntegrationTestHelperError("Test server not running.");
  return _coreApp;
}

export function stopTestServerEffect() {
  return Effect.gen(function* () {
    yield* closeAllClients();
    _coreApp = null;
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

export function stopTestServer() {
  return Effect.runPromise(stopTestServerEffect());
}

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

export function resetTestDb() {
  return Effect.runPromise(resetTestDbEffect());
}

export function registerClaimedAgent(opts: RegisterClaimedAgentOptions) {
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
  }).pipe(Effect.withSpan("registerClaimedAgent"));
}

export function getKyselyDb(): ReturnType<typeof getCoreDb> {
  return getCoreDb();
}

export function getTestCoreApp() {
  return getCoreApp();
}

export function getEncryptionEnvelope() {
  return getCoreEncryptionEnvelope();
}

export function createTestUser(
  displayName: string,
  id: string = crypto.randomUUID(),
) {
  return {
    id: Schema.decodeUnknownSync(UserId)(id),
    supabaseUid: crypto.randomUUID(),
    displayName,
  };
}

export function createAgentInvite(inviterId: string) {
  return {
    token: "not-needed-in-core",
    inviteId: crypto.randomUUID(),
    inviterId,
  };
}
