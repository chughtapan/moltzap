/**
 * Core test helpers — drop-in replacement for the app server's helpers.ts.
 * Uses the shared testcontainers Postgres from vitest globalSetup.
 */
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
  getCoreDb,
  getCoreApp,
  getCoreEncryptionEnvelope,
} from "../../test-utils/index.js";
import type { SessionValidator } from "../../identity/services/session-validator.js";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { NotificationFrame } from "@moltzap/protocol";
import type { JsonRpcMethod } from "@moltzap/protocol/testing";
import {
  awaitOneNotification,
  registerAndConnect,
  registerOnly,
  setupAgentPair,
  setupAgentGroup,
  closeAllClients,
  trackClient,
  registerAgent,
  connectTestClient,
  postJson,
  type ServerTestClient,
} from "../../test-utils/helpers.js";
import type { CoreApp } from "../../app/types.js";
import { Data, Effect, Either } from "effect";
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
  connectTestClient,
  postJson,
  registerAgent,
  registerAndConnect,
  registerOnly,
  setupAgentPair,
  setupAgentGroup,
  trackClient,
};
export type { ServerTestClient };

export function notificationParams<T>(notification: NotificationFrame): T {
  return notification.params as T;
}

export function notificationMatches(
  method: JsonRpcMethod,
): (notification: NotificationFrame) => boolean {
  return (notification) => notification.method === method;
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
  /** Optional validator forwarded to `startCoreTestServer` — see its docs. */
  sessionValidator?: SessionValidator;

  /** Optional secret forwarded to `startCoreTestServer` — see its docs. */
  registrationSecret?: string;

  /**
   * Optional dev-mode owner id. When set, every agent registered via the
   * public `/api/v1/auth/register` endpoint is implicitly owned by this
   * UserId. Tests that exercise contact-scoped surface (#481) on a
   * single-owner cohort use this to avoid an admin-register dance just to
   * bind owners.
   */
  devModeUserId?: string;
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

export interface AdminRegisterResponse {
  agentId: string;
  apiKey: string;
}

class AdminRegisterDecodeError extends Data.TaggedError(
  "AdminRegisterDecodeError",
)<{
  readonly message: string;
  readonly json: unknown;
}> {}

class AdminRegisterStatusError extends Data.TaggedError(
  "AdminRegisterStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly json: unknown;
}> {}

function isAdminRegisterResponse(json: unknown): json is AdminRegisterResponse {
  if (typeof json !== "object" || json === null) return false;
  if (!("agentId" in json) || typeof json.agentId !== "string") return false;
  if (!("apiKey" in json) || typeof json.apiKey !== "string") return false;
  return true;
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
        sessionValidator: opts.sessionValidator,
        registrationSecret: opts.registrationSecret,
        devModeUserId: opts.devModeUserId,
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

export function adminRegisterAgent(opts: {
  baseUrl: string;
  inviteCode: string;
  name: string;
  ownerUserId: string;
  description?: string;
}) {
  const body: Record<string, unknown> = {
    name: opts.name,
    inviteCode: opts.inviteCode,
    ownerUserId: opts.ownerUserId,
  };
  if (opts.description !== undefined) body.description = opts.description;

  return postJson(opts.baseUrl, "/api/v1/admin/register-agent", body).pipe(
    Effect.flatMap(({ status, json }) => {
      if (status !== HTTP_CREATED && status !== HTTP_OK) {
        return Effect.fail(
          new AdminRegisterStatusError({
            message: `admin register failed: ${status}`,
            status,
            json,
          }),
        );
      }
      return isAdminRegisterResponse(json)
        ? Effect.succeed(json)
        : Effect.fail(
            new AdminRegisterDecodeError({
              message: "admin register response did not match expected shape",
              json,
            }),
          );
    }),
  );
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

export function createTestUser(displayName: string) {
  return {
    id: crypto.randomUUID(),
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

export function claimTestAgent(claimToken: string, userId: string): void {
  if (claimToken.length === 0 || userId.length === 0) return;
  // No-op — agents are active immediately in core
}
