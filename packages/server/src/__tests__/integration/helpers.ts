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
import {
  registerAndConnect,
  registerOnly,
  setupAgentPair,
  setupAgentGroup,
  closeAllClients,
  trackClient,
  registerAgent,
  connectTestClient,
  type ConnectedAgent,
  type ServerTestClient,
} from "../../test-utils/helpers.js";
import type { Database } from "../../db/database.js";
import type { Kysely } from "kysely";
import type { CoreApp } from "../../app/types.js";
import type { Layer } from "effect";

export type { ConnectedAgent } from "../../test-utils/helpers.js";
export {
  connectTestClient,
  registerAgent,
  registerAndConnect,
  registerOnly,
  setupAgentPair,
  setupAgentGroup,
  trackClient,
};
export type { ServerTestClient };

let _coreApp: CoreApp | null = null;

/**
 * Start the core test server using the shared Postgres from globalSetup.
 */
export async function startTestServer(_opts?: {
  devMode?: boolean;
  encryption?: boolean;
  /** Optional validator forwarded to `startCoreTestServer` — see its docs. */
  userService?: UserService;
  traceCaptureLayer?: Layer.Layer<TraceCaptureTag>;
}): Promise<{
  baseUrl: string;
  wsUrl: string;
  coreApp: CoreApp;
}> {
  // Get pgHost/pgPort from vitest's globalSetup via inject()
  const { inject } = await import("vitest");
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");

  const server = await startCoreTestServer({
    pgHost,
    pgPort,
    encryption: _opts?.encryption,
    userService: _opts?.userService,
    traceCaptureLayer: _opts?.traceCaptureLayer,
  });
  _coreApp = server.coreApp;
  return {
    baseUrl: server.baseUrl,
    wsUrl: server.wsUrl,
    coreApp: server.coreApp,
  };
}

export function getCoreApp(): CoreApp {
  if (!_coreApp) throw new Error("Test server not running.");
  return _coreApp;
}

export async function stopTestServer(): Promise<void> {
  const { Effect } = await import("effect");
  await Effect.runPromise(closeAllClients());
  _coreApp = null;
  await stopCoreTestServer();
}

export async function resetTestDb(): Promise<void> {
  const { Effect } = await import("effect");
  await Effect.runPromise(closeAllClients());
  await resetCoreTestDb();
}

export function getKyselyDb(): Kysely<Database> {
  return getCoreDb();
}

export function getTestCoreApp() {
  return getCoreApp();
}

export async function createTestUser(
  _displayName: string,
): Promise<{ id: string; supabaseUid: string }> {
  return { id: crypto.randomUUID(), supabaseUid: crypto.randomUUID() };
}

export async function createAgentInvite(
  _inviterId: string,
): Promise<{ token: string; inviteId: string }> {
  return { token: "not-needed-in-core", inviteId: crypto.randomUUID() };
}

export async function claimTestAgent(
  _claimToken: string,
  _userId: string,
): Promise<void> {
  // No-op — agents are active immediately in core
}
