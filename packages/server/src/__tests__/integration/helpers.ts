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
} from "../../test-utils/index.js";
import type { SessionValidator } from "../../identity/services/session-validator.js";
import type { TraceCaptureTag } from "../../runtime-surface/trace-capture.js";
import type { NotificationFrame } from "@moltzap/protocol";
import type { JsonRpcMethod } from "@moltzap/protocol/testing";
import {
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
import { Effect, type Layer } from "effect";
import { inject } from "vitest";

export type { ConnectedAgent } from "../../test-utils/helpers.js";
export {
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
  traceCaptureLayer?: Layer.Layer<TraceCaptureTag>;
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

/**
 * Start the core test server using the shared Postgres from globalSetup.
 */
export function startTestServer(_opts?: StartTestServerOptions) {
  // Get pgHost/pgPort from vitest's globalSetup via inject()
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");

  return Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        startCoreTestServer({
          pgHost,
          pgPort,
          encryption: _opts?.encryption,
          sessionValidator: _opts?.sessionValidator,
          registrationSecret: _opts?.registrationSecret,
          devModeUserId: _opts?.devModeUserId,
          traceCaptureLayer: _opts?.traceCaptureLayer,
        }),
      catch: (cause) =>
        new IntegrationTestHelperError(
          "Core test server failed to start",
          cause,
        ),
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
    ),
  );
}

export function getCoreApp(): CoreApp {
  if (!_coreApp)
    throw new IntegrationTestHelperError("Test server not running.");
  return _coreApp;
}

export function stopTestServer() {
  return Effect.runPromise(
    Effect.gen(function* () {
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
    }).pipe(Effect.withSpan("stopTestServer")),
  );
}

export function resetTestDb() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* closeAllClients();
      yield* Effect.tryPromise({
        try: () => resetCoreTestDb(),
        catch: (cause) =>
          new IntegrationTestHelperError("Core test DB failed to reset", cause),
      });
    }).pipe(Effect.withSpan("resetTestDb")),
  );
}

export function getKyselyDb(): ReturnType<typeof getCoreDb> {
  return getCoreDb();
}

export function getTestCoreApp() {
  return getCoreApp();
}

export function createTestUser(displayName: string) {
  void displayName;
  return { id: crypto.randomUUID(), supabaseUid: crypto.randomUUID() };
}

export function createAgentInvite(inviterId: string) {
  void inviterId;
  return { token: "not-needed-in-core", inviteId: crypto.randomUUID() };
}

export function claimTestAgent(claimToken: string, userId: string): void {
  void claimToken;
  void userId;
  // No-op — agents are active immediately in core
}
