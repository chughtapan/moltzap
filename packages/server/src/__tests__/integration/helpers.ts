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
import type { UserService } from "../../services/user.service.js";
import type { TraceCaptureTag } from "../../runtime-surface/trace-capture.js";
import type { JsonRpcMethod, NotificationFrame } from "@moltzap/protocol";
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
import type { Database } from "../../db/database.js";
import type { Kysely } from "kysely";
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
  userService?: UserService;
  /** Optional secret forwarded to `startCoreTestServer` — see its docs. */
  registrationSecret?: string;
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
          userService: _opts?.userService,
          registrationSecret: _opts?.registrationSecret,
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
    }),
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
    }),
  );
}

export function getKyselyDb(): Kysely<Database> {
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
