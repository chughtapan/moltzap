import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { userId } from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";
import type { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEffectKysely } from "../db/effect-kysely-toolkit.js";
import type { Database } from "../db/database.js";
import { visibleAgentIds } from "./agent-visibility.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  join(__dirname, "..", "app", "core-schema.sql"),
  "utf-8",
);
const DB_HOOK_TIMEOUT_MS = 30_000;

const ALICE_OWNER = userId("00000000-0000-4000-8000-00000000a11c");
const BOB_OWNER = userId("00000000-0000-4000-8000-00000000b0b0");
const CAROL_OWNER = userId("00000000-0000-4000-8000-00000000ca20");

let db: Kysely<Database>;
let pglite: {
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function freshDb(): Promise<void> {
  const kpg = await KyselyPGlite.create();
  pglite = {
    exec: (sql) => kpg.client.exec(sql),
    close: () => kpg.client.close(),
  };
  db = makeEffectKysely<Database>({ dialect: kpg.dialect });
  await pglite.exec(schema);
}

function insertAgent(name: string, ownerUserId: UserId | null) {
  return db
    .insertInto("agents")
    .values({
      name,
      api_key_id: `${name}-keyid`,
      api_key_secret_hash: `${name}-hash`,
      claim_token: `${name}-claim`,
      status: "active",
      owner_user_id: ownerUserId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function insertAcceptedContact(
  ownerA: UserId,
  ownerB: UserId,
): Promise<void> {
  // The contact-graph predicate matches `owner_user_id = caller AND
  // status = 'accepted'`, so symmetric edges are written explicitly here.
  await db
    .insertInto("contacts")
    .values({
      owner_user_id: ownerA,
      contact_user_id: ownerB,
      status: "accepted",
    })
    .execute();
  await db
    .insertInto("contacts")
    .values({
      owner_user_id: ownerB,
      contact_user_id: ownerA,
      status: "accepted",
    })
    .execute();
}

describe("visibleAgentIds (#481)", () => {
  beforeEach(async () => {
    await freshDb();
  }, DB_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await pglite.close();
  }, DB_HOOK_TIMEOUT_MS);

  it("includes own agent + sibling agents under same owner", async () => {
    const alice1 = await insertAgent("alice-sib1", ALICE_OWNER);
    const alice2 = await insertAgent("alice-sib2", ALICE_OWNER);
    await insertAgent("carol-far", CAROL_OWNER);

    const ids = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: alice1.id,
        callerOwnerUserId: ALICE_OWNER,
      }),
    );
    const set = new Set(ids);
    expect(set.has(alice1.id)).toBe(true);
    expect(set.has(alice2.id)).toBe(true);
    expect(set.size).toBe(2);
  });

  it("includes agents owned by accepted contacts; excludes non-contacts", async () => {
    const alice = await insertAgent("alice", ALICE_OWNER);
    const bob = await insertAgent("bob", BOB_OWNER);
    const carol = await insertAgent("carol", CAROL_OWNER);
    await insertAcceptedContact(ALICE_OWNER, BOB_OWNER);

    const ids = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: alice.id,
        callerOwnerUserId: ALICE_OWNER,
      }),
    );
    const set = new Set(ids);
    expect(set.has(alice.id)).toBe(true);
    expect(set.has(bob.id)).toBe(true);
    expect(set.has(carol.id)).toBe(false);
  });

  it("ignores pending-status contacts", async () => {
    const alice = await insertAgent("alice", ALICE_OWNER);
    const bob = await insertAgent("bob", BOB_OWNER);
    await db
      .insertInto("contacts")
      .values({
        owner_user_id: ALICE_OWNER,
        contact_user_id: BOB_OWNER,
        status: "pending",
      })
      .execute();

    const ids = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: alice.id,
        callerOwnerUserId: ALICE_OWNER,
      }),
    );
    const set = new Set(ids);
    expect(set.has(alice.id)).toBe(true);
    expect(set.has(bob.id)).toBe(false);
  });

  it("intersects with restrictTo when provided", async () => {
    const alice = await insertAgent("alice", ALICE_OWNER);
    const bob = await insertAgent("bob", BOB_OWNER);
    const carol = await insertAgent("carol", CAROL_OWNER);
    await insertAcceptedContact(ALICE_OWNER, BOB_OWNER);

    const ids = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: alice.id,
        callerOwnerUserId: ALICE_OWNER,
        restrictTo: [bob.id, carol.id],
      }),
    );
    const set = new Set(ids);
    expect(set.has(bob.id)).toBe(true);
    expect(set.has(carol.id)).toBe(false);
    expect(set.has(alice.id)).toBe(false);
  });

  it("returns empty when restrictTo is empty", async () => {
    const alice = await insertAgent("alice", ALICE_OWNER);
    const ids = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: alice.id,
        callerOwnerUserId: ALICE_OWNER,
        restrictTo: [],
      }),
    );
    expect(ids).toEqual([]);
  });

  it("unclaimed callers see only their own agentId", async () => {
    const unclaimed = await insertAgent("unclaimed", null);
    await insertAgent("alice", ALICE_OWNER);

    const ids = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: unclaimed.id,
        callerOwnerUserId: null,
      }),
    );
    expect(ids).toEqual([unclaimed.id]);
  });

  it("unclaimed callers, with restrictTo, only keep their own agentId", async () => {
    const unclaimed = await insertAgent("unclaimed", null);
    const alice = await insertAgent("alice", ALICE_OWNER);

    const idsKeepSelf = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: unclaimed.id,
        callerOwnerUserId: null,
        restrictTo: [unclaimed.id, alice.id],
      }),
    );
    expect(idsKeepSelf).toEqual([unclaimed.id]);

    const idsDropAll = await Effect.runPromise(
      visibleAgentIds({
        db,
        callerAgentId: unclaimed.id,
        callerOwnerUserId: null,
        restrictTo: [alice.id],
      }),
    );
    expect(idsDropAll).toEqual([]);
  });
});
