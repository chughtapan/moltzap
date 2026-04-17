/**
 * Regression: ConversationService.create + addParticipant must subscribe
 * every participant's open sockets to the conversation id.
 *
 * Why: broadcaster iterates connections and checks `conn.conversationIds`.
 * A participant whose connection isn't in the set silently misses every
 * event on the conversation. Before the service auto-subscribed, every
 * downstream caller (the conversations/create RPC handler, moltzap-arena's
 * werewolf-app role DM creation, agent-manager createConversation) had to
 * reimplement the same loop. Some did; some didn't. The werewolf-app's
 * role-DM flow didn't, so 4-player evals ran with three of four players
 * asking "I haven't received my secret role in any DM" every game.
 *
 * These tests exercise the service directly against PGlite so the contract
 * is locked at the service boundary — dropping the subscribe calls causes
 * these tests to fail regardless of whether any handler also loops.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Kysely } from "kysely";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEffectKysely } from "../db/effect-kysely-toolkit.js";
import type { Database } from "../db/database.js";
import { AuthService } from "./auth.service.js";
import { ConversationService } from "./conversation.service.js";
import { ParticipantService } from "./participant.service.js";
import { ConnectionManager, type MoltZapConnection } from "../ws/connection.js";
import type { AuthenticatedContext } from "../rpc/context.js";
import type { AgentId, UserId } from "../app/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Track the PGlite client between tests so we can reset state cleanly.
let db: Kysely<Database>;
let pglite: {
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function freshDb(): Promise<void> {
  const { KyselyPGlite } = await import("kysely-pglite");
  const kpg = await KyselyPGlite.create();
  // kysely-pglite returns a typed client that exposes a wider interface than
  // the handful of methods (exec/close) these tests need.
  // #ignore-sloppy-code-next-line[as-unknown-as]: narrowing the PGlite client to the test-scoped subset.
  pglite = kpg.client as unknown as typeof pglite;
  db = makeEffectKysely<Database>({ dialect: kpg.dialect });
  const srcPath = join(__dirname, "..", "app", "core-schema.sql");
  const schema = readFileSync(srcPath, "utf-8");
  await pglite.exec(schema);
}

const noopWrite: MoltZapConnection["write"] = () => Effect.void;
const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;

function makeConn(connId: string, agentId: string): MoltZapConnection {
  const auth: AuthenticatedContext = {
    agentId: agentId as AgentId,
    agentStatus: "active",
    ownerUserId: null,
  };
  return {
    id: connId,
    write: noopWrite,
    shutdown: noopShutdown,
    auth,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
  };
}

async function seedAgent(
  authService: AuthService,
  name: string,
): Promise<string> {
  const { agentId } = await Effect.runPromise(
    authService.registerAgent({ name }),
  );
  return agentId;
}

describe("ConversationService.create auto-subscribes participants", () => {
  beforeEach(freshDb);
  afterEach(async () => {
    await pglite?.close();
  });

  it("subscribes creator + every participant agent's open connections", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");
    const carol = await seedAgent(authService, "carol");

    const aliceConn = makeConn("c-alice", alice);
    const bobConn = makeConn("c-bob", bob);
    const carolConn = makeConn("c-carol", carol);
    connections.add(aliceConn);
    connections.add(bobConn);
    connections.add(carolConn);

    const conv = await Effect.runPromise(
      service.create("group", "planning", [bob, carol], alice),
    );

    expect(aliceConn.conversationIds.has(conv.id)).toBe(true);
    expect(bobConn.conversationIds.has(conv.id)).toBe(true);
    expect(carolConn.conversationIds.has(conv.id)).toBe(true);
  });

  it("subscribes every socket of an agent that has multiple connections", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");

    const aliceConn = makeConn("c-alice", alice);
    const bob1 = makeConn("c-bob-1", bob);
    const bob2 = makeConn("c-bob-2", bob);
    connections.add(aliceConn);
    connections.add(bob1);
    connections.add(bob2);

    const conv = await Effect.runPromise(
      service.create("dm", undefined, [bob], alice),
    );

    expect(bob1.conversationIds.has(conv.id)).toBe(true);
    expect(bob2.conversationIds.has(conv.id)).toBe(true);
  });

  it("is a no-op for agents without any open connection", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");

    // Only alice is connected. Creating the DM with bob as participant
    // should succeed + subscribe alice; bob just has no connection to touch.
    const aliceConn = makeConn("c-alice", alice);
    connections.add(aliceConn);

    const conv = await Effect.runPromise(
      service.create("dm", undefined, [bob], alice),
    );

    expect(aliceConn.conversationIds.has(conv.id)).toBe(true);
  });
});

describe("ConversationService.addParticipant auto-subscribes the new member", () => {
  beforeEach(freshDb);
  afterEach(async () => {
    await pglite?.close();
  });

  it("subscribes the new participant's open sockets to the existing conversation", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");
    const carol = await seedAgent(authService, "carol");

    // Alice creates a group with Bob. Carol isn't connected yet at create
    // time — she joins the conversation later via addParticipant.
    const aliceConn = makeConn("c-alice", alice);
    const bobConn = makeConn("c-bob", bob);
    connections.add(aliceConn);
    connections.add(bobConn);

    const conv = await Effect.runPromise(
      service.create("group", "planning", [bob], alice),
    );

    // Carol connects AFTER conversation creation.
    const carolConn = makeConn("c-carol", carol);
    connections.add(carolConn);
    expect(carolConn.conversationIds.has(conv.id)).toBe(false);

    await Effect.runPromise(service.addParticipant(conv.id, carol, alice));

    expect(carolConn.conversationIds.has(conv.id)).toBe(true);
  });

  it("is idempotent — re-adding an already-member agent does not duplicate", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");

    const aliceConn = makeConn("c-alice", alice);
    const bobConn = makeConn("c-bob", bob);
    connections.add(aliceConn);
    connections.add(bobConn);

    const conv = await Effect.runPromise(
      service.create("group", "team", [bob], alice),
    );

    const bobConvCountBefore = bobConn.conversationIds.size;
    await Effect.runPromise(service.addParticipant(conv.id, bob, alice));

    // Set semantics — still one copy of the conversationId.
    expect(bobConn.conversationIds.size).toBe(bobConvCountBefore);
    expect(bobConn.conversationIds.has(conv.id)).toBe(true);
  });
});
