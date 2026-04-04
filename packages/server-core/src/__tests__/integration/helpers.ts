/**
 * Core test helpers — drop-in replacement for the app server's helpers.ts.
 * Uses the shared testcontainers Postgres from vitest globalSetup.
 */
import {
  startCoreTestServer,
  stopCoreTestServer,
  resetCoreTestDb,
  getCoreDb,
} from "../../test-utils/index.js";
import {
  registerAndConnect,
  registerOnly,
  setupAgentPair,
  setupAgentGroup,
  closeAllClients,
  type ConnectedAgent,
} from "../../test-utils/helpers.js";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import type { Database } from "../../db/database.js";
import type { Kysely } from "kysely";

export type { ConnectedAgent } from "../../test-utils/helpers.js";
export { MoltZapTestClient } from "@moltzap/protocol/test-client";
export { registerAndConnect, registerOnly, setupAgentPair, setupAgentGroup };

/**
 * Start the core test server using the shared Postgres from globalSetup.
 */
export async function startTestServer(_opts?: { devMode?: boolean }): Promise<{
  baseUrl: string;
  wsUrl: string;
}> {
  // Get pgHost/pgPort from vitest's globalSetup via inject()
  const { inject } = await import("vitest");
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");

  const server = await startCoreTestServer({ pgHost, pgPort });
  return { baseUrl: server.baseUrl, wsUrl: server.wsUrl };
}

export async function stopTestServer(): Promise<void> {
  closeAllClients();
  await stopCoreTestServer();
}

export async function resetTestDb(): Promise<void> {
  closeAllClients();
  await resetCoreTestDb();
}

export function getKyselyDb(): Kysely<Database> {
  return getCoreDb();
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
