/**
 * Regression: ConversationService.create + addParticipant must subscribe
 * every participant's open sockets to the conversation id.
 *
 * Why: the conversation broadcast path gates on `conn.conversationIds`.
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
import { Cause, Effect, Exit } from "effect";
import { JSON_RPC_RESERVED_CODES, NotInContactsError } from "@moltzap/protocol";
import { wireErrorFromInstance } from "@moltzap/protocol/testing";
import type { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEffectKysely } from "../db/effect-kysely-toolkit.js";
import type { Database } from "../db/database.js";
import { AuthService } from "./auth.service.js";
import { ConversationService } from "./conversation.service.js";
import { ParticipantService } from "./participant.service.js";
import { ConnectionManager, type MoltZapConnection } from "../ws/connection.js";
import { unusedJsonRpcClient } from "../ws/connection.test-utils.js";
import type { AuthenticatedContext } from "../rpc/context.js";
import type { AgentId, ConversationId } from "../app/types.js";
import type { TaskId } from "@moltzap/protocol/task";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  join(__dirname, "..", "app", "core-schema.sql"),
  "utf-8",
);
const dbHookTimeoutMs = 30_000;

// Track the PGlite client between tests so we can reset state cleanly.
let db: Kysely<Database>;
let pglite: {
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function freshDb(): Promise<void> {
  const kpg = await KyselyPGlite.create();
  // kysely-pglite returns a typed client that exposes a wider interface than
  // the handful of methods (exec/close) these tests need.
  pglite = {
    exec: (sql) => kpg.client.exec(sql),
    close: () => kpg.client.close(),
  };
  db = makeEffectKysely<Database>({ dialect: kpg.dialect });
  await pglite.exec(schema);
}

const noopWrite: MoltZapConnection["write"] = () => Effect.void;
const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;

function makeConn(connId: string, agentId: AgentId): MoltZapConnection {
  const auth: AuthenticatedContext = {
    agentId,
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
    jsonRpcClient: unusedJsonRpcClient(),
  };
}

async function seedAgent(
  authService: AuthService,
  name: string,
  ownerUserId?: string,
): Promise<AgentId> {
  const { agentId } = await Effect.runPromise(
    authService.registerAgent({ name }, ownerUserId),
  );
  return agentId;
}

/**
 * Phase 9b consumer-migration (sub-issue #460 round 3 R12+R13):
 * `conversations.task_id` and `tasks.tm_endpoint_address` are both
 * NOT NULL, and `ConversationService.create` requires a task id at
 * insert. Tests that previously called `service.create` directly now
 * mint a fresh task per call via this helper — the TM is the
 * initiator (matches `tasks/create` from a custom-TM caller).
 */
async function seedTask(initiator: AgentId): Promise<TaskId> {
  const row = await db
    .insertInto("tasks")
    .values({
      initiator_agent_id: initiator,
      status: "waiting",
      tm_endpoint_address: `tm:agent:${initiator}`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Wrap `ConversationService.create` so each test seeds a fresh
 * default-TM task and supplies its id without manual plumbing. The
 * helper preserves the wire-shape semantics of `ConversationsCreate`:
 * one task per conversation insert.
 */
async function createConv(
  service: ConversationService,
  type: "dm" | "group",
  name: string | undefined,
  participants: AgentId[],
  initiator: AgentId,
) {
  const taskId = await seedTask(initiator);
  return Effect.runPromise(
    service.create(
      type,
      name,
      participants,
      initiator,
      Effect.succeed({ id: taskId }),
    ),
  );
}

/** Exit-returning twin of {@link createConv} for failure-path tests. */
async function createConvExit(
  service: ConversationService,
  type: "dm" | "group",
  name: string | undefined,
  participants: AgentId[],
  initiator: AgentId,
) {
  const taskId = await seedTask(initiator);
  return Effect.runPromiseExit(
    service.create(
      type,
      name,
      participants,
      initiator,
      Effect.succeed({ id: taskId }),
    ),
  );
}

/** Extract the wire metadata (code, message, data) of any tagged-error
 * class raised by the service. */
interface WireFailure {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}
function expectRpcFailure<A>(exit: Exit.Exit<A, unknown>): WireFailure {
  if (Exit.isSuccess(exit)) {
    throw new Error(
      `Expected tagged failure, got success: ${JSON.stringify(exit.value)}`,
    );
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error(
      `Expected tagged failure, got: ${Cause.pretty(exit.cause)}`,
    );
  }
  const wire = wireErrorFromInstance(failure.value);
  if (wire === null) {
    throw new Error(
      `Expected wire-error class, got: ${JSON.stringify(failure.value)}`,
    );
  }
  return wire;
}

describe("ConversationService.create auto-subscribes participants", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
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

    const conv = await createConv(
      service,
      "group",
      "planning",
      [bob, carol],
      alice,
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

    const conv = await createConv(service, "dm", undefined, [bob], alice);

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

    const conv = await createConv(service, "dm", undefined, [bob], alice);

    expect(aliceConn.conversationIds.has(conv.id)).toBe(true);
  });
});

describe("ConversationService.addParticipant auto-subscribes the new member", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
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

    const conv = await createConv(service, "group", "planning", [bob], alice);

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

    const conv = await createConv(service, "group", "team", [bob], alice);

    const bobConvCountBefore = bobConn.conversationIds.size;
    await Effect.runPromise(service.addParticipant(conv.id, bob, alice));

    // Set semantics — still one copy of the conversationId.
    expect(bobConn.conversationIds.size).toBe(bobConvCountBefore);
    expect(bobConn.conversationIds.has(conv.id)).toBe(true);
  });
});

/**
 * Regression for arena#372: archived DMs must not be reused by
 * conversations/create. Before this fix, `findExistingDm` returned any DM
 * between the two agents — including archived ones. After closeSession
 * archives a DM, the next conversations/create would hand back the archived
 * conversation, but messages/send rejects writes to archived conversations,
 * so the agent ended up with a "live" DM id it could never write to.
 */
describe("ConversationService.create — archived DM lookup (issue #372)", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
  afterEach(async () => {
    await pglite?.close();
  });

  it("does not reuse an archived DM — creates a fresh conversation instead", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");

    // 1. Create a DM between alice and bob.
    const first = await createConv(service, "dm", undefined, [bob], alice);

    // 2. Archive it (alice is the creator/owner, so archive is permitted).
    await Effect.runPromise(service.archive(first.id, alice));

    // 3. Create a DM again with the same participants.
    const second = await createConv(service, "dm", undefined, [bob], alice);

    // 4. The new DM must be a fresh row — not the archived one.
    expect(second.id).not.toBe(first.id);
  });

  it("still dedupes live DMs — repeat create returns the existing live DM", async () => {
    // Positive guard: the archived_at filter must not over-filter and break
    // the dedupe contract for live DMs. Without this guard, a future tweak
    // that turns the filter into `archived_at IS NOT NULL` (or removes the
    // EXISTS subqueries) would silently regress dedupe.
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");

    const first = await createConv(service, "dm", undefined, [bob], alice);
    const second = await createConv(service, "dm", undefined, [bob], alice);

    expect(second.id).toBe(first.id);
  });
});

/**
 * Regression for moltzap#361: direct conversation creation must consult
 * the contact policy. When `ConversationService.create("dm", ...)` ran
 * without the gate, two agents whose owners had no contact edge could
 * still open a DM (and `messages/send { to }` would auto-create one
 * through `createDmByAgentName`).
 *
 * The contact policy is exposed as a lazy resolver because in production
 * it is registered on AppHost AFTER ConversationService has been
 * constructed (`app.setContactService(...)` in `standalone.ts`). These
 * tests inject the resolver directly to keep the contract pinned at the
 * service boundary.
 */
describe("ConversationService.create enforces contact policy on DMs", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
  afterEach(async () => {
    await pglite?.close();
  });

  it("denies DM creation when owners are not in contact (NotInContacts)", async () => {
    const calls: Array<[string, string]> = [];
    const policy = (a: string, b: string) =>
      Effect.sync(() => {
        calls.push([a, b]);
        return false;
      });

    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );

    const exit = await createConvExit(service, "dm", undefined, [bob], alice);
    const failure = expectRpcFailure(exit);

    expect(failure.code).toBe(NotInContactsError.code);
    expect(failure.message).toMatch(/contact policy/i);
    expect(calls).toEqual([
      [
        "00000000-0000-0000-0000-0000000000a1",
        "00000000-0000-0000-0000-0000000000b2",
      ],
    ]);
  });

  it("creates the DM when owners are in contact", async () => {
    const policy = () => Effect.succeed(true);

    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );

    const aliceConn = makeConn("c-alice", alice);
    const bobConn = makeConn("c-bob", bob);
    connections.add(aliceConn);
    connections.add(bobConn);

    const conv = await createConv(service, "dm", undefined, [bob], alice);

    expect(conv.type).toBe("dm");
    expect(aliceConn.conversationIds.has(conv.id)).toBe(true);
    expect(bobConn.conversationIds.has(conv.id)).toBe(true);
  });

  it("denies the DM when either agent has no owner_user_id", async () => {
    const policy = () => Effect.succeed(true); // would allow if reached
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    // Alice has an owner; Bob is owner-less. The policy can't evaluate
    // the edge → fail closed with NotInContacts (matches AppHost's
    // checkIdentity stance for app-session admission).
    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(authService, "bob");

    const exit = await createConvExit(service, "dm", undefined, [bob], alice);
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(NotInContactsError.code);
  });

  it("permits DMs when no policy is configured (default behavior preserved)", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");

    const conv = await createConv(service, "dm", undefined, [bob], alice);
    expect(conv.type).toBe("dm");
  });

  it("returns the existing DM without re-checking policy (idempotent)", async () => {
    const calls: Array<[string, string]> = [];
    const policy = (a: string, b: string) =>
      Effect.sync(() => {
        calls.push([a, b]);
        return true;
      });

    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );

    const first = await createConv(service, "dm", undefined, [bob], alice);
    const second = await createConv(service, "dm", undefined, [bob], alice);

    expect(second.id).toBe(first.id);
    // Policy invoked exactly once — for the create that actually inserted.
    expect(calls.length).toBe(1);
  });

  // `createDmByAgentName` is the path `messages/send { to: "agent:<name>" }`
  // takes when the caller passes an `agent:<name>` target instead of a
  // known conversationId. It funnels through `create("dm", ...)` so the
  // gate fires once — but pinning that contract here means a future
  // refactor that bypasses `create()` (e.g. inlining the insert) can't
  // silently drop the gate. Senior review (PR #378) called this out as
  // missing coverage.
  it("denies messages/send auto-DM when policy denies the edge", async () => {
    const policy = (_a: string, _b: string) => Effect.succeed(false);

    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    await seedAgent(authService, "bob", "00000000-0000-0000-0000-0000000000b2");

    const dmTaskId = await seedTask(alice);
    const exit = await Effect.runPromiseExit(
      service.createDmByAgentName(
        "bob",
        alice,
        Effect.succeed({ id: dmTaskId }),
      ),
    );
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(NotInContactsError.code);
  });
});

/**
 * Group-creation gate (#361 cleanup pass): a creator cannot drop an
 * out-of-contact agent into a group conversation. The policy runs
 * pairwise — every (creator, member) edge must be allowed. Group members
 * are NOT transitively trusted; the creator is the requester for every
 * edge.
 */
describe("ConversationService.create enforces contact policy on groups", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
  afterEach(async () => {
    await pglite?.close();
  });

  it("denies group creation when ANY (creator, member) edge fails", async () => {
    const calls: Array<[string, string]> = [];
    // Allow alice⇄bob, deny alice⇄carol.
    const policy = (a: string, b: string) =>
      Effect.sync(() => {
        calls.push([a, b]);
        return b !== "00000000-0000-0000-0000-0000000000c3";
      });

    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );
    const carol = await seedAgent(
      authService,
      "carol",
      "00000000-0000-0000-0000-0000000000c3",
    );

    const exit = await createConvExit(
      service,
      "group",
      "planning",
      [bob, carol],
      alice,
    );
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(NotInContactsError.code);
    // Policy was checked for both edges before the carol denial fired
    // (fail-fast on the first deny; bob's edge ran first).
    expect(calls).toEqual([
      [
        "00000000-0000-0000-0000-0000000000a1",
        "00000000-0000-0000-0000-0000000000b2",
      ],
      [
        "00000000-0000-0000-0000-0000000000a1",
        "00000000-0000-0000-0000-0000000000c3",
      ],
    ]);
  });

  it("creates the group when every (creator, member) edge is allowed", async () => {
    const policy = () => Effect.succeed(true);
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );
    const carol = await seedAgent(
      authService,
      "carol",
      "00000000-0000-0000-0000-0000000000c3",
    );

    const conv = await createConv(
      service,
      "group",
      "planning",
      [bob, carol],
      alice,
    );
    expect(conv.type).toBe("group");
    expect(conv.name).toBe("planning");
  });

  it("denies the group when any member is owner-less (fail-closed)", async () => {
    const policy = () => Effect.succeed(true);
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );
    // Carol has no owner.
    const carol = await seedAgent(authService, "carol");

    const exit = await createConvExit(
      service,
      "group",
      "planning",
      [bob, carol],
      alice,
    );
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(NotInContactsError.code);
  });
});

/**
 * `addParticipant` gate (#361 cleanup pass): an owner/admin cannot use
 * `conversations/addParticipant` as a side-channel to drag an
 * out-of-contact agent into the conversation. Symmetric with `create`
 * — every (requester, member) edge must be allowed.
 */
describe("ConversationService.addParticipant enforces contact policy", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
  afterEach(async () => {
    await pglite?.close();
  });

  it("denies adding a participant when (requester, target) edge is denied", async () => {
    // Phase 1: open policy so the group can be created.
    let denying = false;
    const policy = (_a: string, b: string) =>
      Effect.sync(
        () => !denying || b !== "00000000-0000-0000-0000-0000000000c3",
      );

    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );
    const carol = await seedAgent(
      authService,
      "carol",
      "00000000-0000-0000-0000-0000000000c3",
    );

    const conv = await createConv(service, "group", "planning", [bob], alice);

    // Phase 2: now policy denies alice⇄carol.
    denying = true;
    const exit = await Effect.runPromiseExit(
      service.addParticipant(conv.id, carol, alice),
    );
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(NotInContactsError.code);
  });

  it("permits addParticipant when policy allows the edge", async () => {
    const policy = () => Effect.succeed(true);
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );
    const carol = await seedAgent(
      authService,
      "carol",
      "00000000-0000-0000-0000-0000000000c3",
    );

    const conv = await createConv(service, "group", "planning", [bob], alice);
    const carolConn = makeConn("c-carol", carol);
    connections.add(carolConn);

    const participant = await Effect.runPromise(
      service.addParticipant(conv.id, carol, alice),
    );
    expect(participant.participant.id).toBe(carol);
    expect(carolConn.conversationIds.has(conv.id)).toBe(true);
  });

  it("denies addParticipant when either side has no owner_user_id", async () => {
    const policy = () => Effect.succeed(true);
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );
    // Carol has no owner.
    const carol = await seedAgent(authService, "carol");

    const conv = await createConv(service, "group", "planning", [bob], alice);

    const exit = await Effect.runPromiseExit(
      service.addParticipant(conv.id, carol, alice),
    );
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(NotInContactsError.code);
  });

  it("permits addParticipant when no policy is configured", async () => {
    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(db, participants, connections);
    const authService = new AuthService(db);

    const alice = await seedAgent(authService, "alice");
    const bob = await seedAgent(authService, "bob");
    const carol = await seedAgent(authService, "carol");

    const conv = await createConv(service, "group", "planning", [bob], alice);
    const participant = await Effect.runPromise(
      service.addParticipant(conv.id, carol, alice),
    );
    expect(participant.participant.id).toBe(carol);
  });
});

/**
 * Regression for moltzap#380 §1: `addParticipant` must explicitly reject
 * type='dm' conversations. The contact-policy gate landed in PR #387
 * covers the (requester, target) edge — but a DM owner who already shares
 * a contact edge with a third agent could still call addParticipant on
 * the DM and silently turn it into a 3-party row with type='dm'. The
 * protocol invariant is that DMs hold exactly two participants, full
 * stop. This test pins the rejection at the service boundary so a
 * future tweak that drops the type check (or moves it behind a flag)
 * fails loudly.
 */
describe("ConversationService.addParticipant rejects DM conversations", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
  afterEach(async () => {
    await pglite?.close();
  });

  it("rejects addParticipant on a DM with InvalidParams; participants table unchanged", async () => {
    // Open policy: alice⇄bob and alice⇄carol are both allowed. The DM
    // rejection must still fire — the gate is the conversation type, not
    // the contact edge.
    const policy = () => Effect.succeed(true);

    const connections = new ConnectionManager();
    const participants = new ParticipantService(db);
    const service = new ConversationService(
      db,
      participants,
      connections,
      undefined,
      () => policy,
    );
    const authService = new AuthService(db);

    const alice = await seedAgent(
      authService,
      "alice",
      "00000000-0000-0000-0000-0000000000a1",
    );
    const bob = await seedAgent(
      authService,
      "bob",
      "00000000-0000-0000-0000-0000000000b2",
    );
    const carol = await seedAgent(
      authService,
      "carol",
      "00000000-0000-0000-0000-0000000000c3",
    );

    // Alice creates a DM with Bob. Both are in contacts; the DM lands.
    const dm = await createConv(service, "dm", undefined, [bob], alice);
    expect(dm.type).toBe("dm");

    // Alice tries to drag Carol into the DM. Policy would allow the
    // edge — but the type='dm' gate fires first.
    const exit = await Effect.runPromiseExit(
      service.addParticipant(dm.id, carol, alice),
    );
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(JSON_RPC_RESERVED_CODES.InvalidParams);
    expect(failure.message).toMatch(/dm/i);

    // Belt-and-suspenders: the database row is unchanged. Only Alice +
    // Bob remain, and Carol was never inserted.
    const rows = await Effect.runPromise(
      db
        .selectFrom("conversation_participants")
        .select("agent_id")
        .where("conversation_id", "=", dm.id),
    );
    const agentIds = rows.map((r) => r.agent_id).sort();
    expect(agentIds).toEqual([alice, bob].sort());
  });
});
