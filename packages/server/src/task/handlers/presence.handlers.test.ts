/**
 * Unit tests for createPresenceHandlers — covers the presence/subscribe
 * NotInContactsError path added in #508.
 *
 * Uses PGlite so the contact-graph visibility query runs against a real
 * schema. The test focuses on the reject-if-non-empty invariant: any
 * agentId outside the caller's visibility set must surface in the error's
 * `data.agentIds` field.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { NotInContactsError } from "@moltzap/protocol";
import { wireErrorFromInstance } from "@moltzap/protocol/testing";
import type { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEffectKysely } from "../../db/effect-kysely-toolkit.js";
import type { Database } from "../../db/database.js";
import { userId } from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";
import type { AgentId } from "../../app/types.js";
import { PresenceService } from "../../services/presence.service.js";
import type { PresenceEventSink } from "../../services/presence-event-sink.js";
import { ConnIdTag, DbTag, PresenceServiceTag } from "../../app/layers.js";
import { presenceHandlers } from "./presence.handlers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  join(__dirname, "..", "..", "app", "core-schema.sql"),
  "utf-8",
);
const DB_HOOK_TIMEOUT_MS = 30_000;

const ALICE_OWNER = userId("00000000-0000-4000-8000-00000000a11c") as UserId;
const CAROL_OWNER = userId("00000000-0000-4000-8000-00000000ca20") as UserId;

const noopSink: PresenceEventSink = { publish: () => {} };

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

/** Run the PresenceSubscribe handler body directly against a PGlite db. */
function runSubscribe(opts: {
  callerAgentId: AgentId;
  callerOwnerUserId: UserId | null;
  requestedIds: AgentId[];
}) {
  // Phase 2A r2 DI migration: handlers are top-level registries that pull
  // their service Tags from Context. Tests provide a service `Layer` rather
  // than constructing the handler via a factory; the binding body sees a
  // real DB + real PresenceService via the Layer-merge below.
  const binding = presenceHandlers.find(
    (h) => h.definition.name === "presence/subscribe",
  );
  if (!binding) throw new Error("presence/subscribe handler not found");

  const ctx = {
    auth: {
      agentId: opts.callerAgentId,
      agentStatus: "active",
      ownerUserId: opts.callerOwnerUserId,
    },
    connId: "test-conn-1",
  };

  const TestServices = Layer.mergeAll(
    Layer.succeed(DbTag, db),
    Layer.succeed(PresenceServiceTag, new PresenceService(noopSink)),
  );

  return Effect.runPromise(
    Effect.exit(
      (
        binding.handle({ agentIds: opts.requestedIds }, ctx) as Effect.Effect<
          unknown,
          unknown,
          DbTag | PresenceServiceTag
        >
      ).pipe(
        Effect.provideService(ConnIdTag, "test-conn-1"),
        Effect.provide(TestServices),
      ),
    ),
  );
}

describe("presence/subscribe — NotInContactsError (#508)", () => {
  beforeEach(async () => {
    await freshDb();
  }, DB_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await pglite.close();
  }, DB_HOOK_TIMEOUT_MS);

  it("throws NotInContactsError when caller subscribes to an agentId outside their visibility set", async () => {
    const alice = await insertAgent("alice-508", ALICE_OWNER);
    const carol = await insertAgent("carol-508", CAROL_OWNER);
    // alice and carol have no contact relationship → carol not visible to alice

    const exit = await runSubscribe({
      callerAgentId: alice.id as AgentId,
      callerOwnerUserId: ALICE_OWNER,
      requestedIds: [carol.id as AgentId],
    });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;

    const failureOpt = Cause.failureOption(exit.cause);
    expect(failureOpt._tag).toBe("Some");
    if (failureOpt._tag !== "Some") return;

    const wire = wireErrorFromInstance(failureOpt.value);
    expect(wire).not.toBeNull();
    expect(wire!.code).toBe(NotInContactsError.code);
    const data = wire!.data as { agentIds: string[] };
    expect(data.agentIds).toContain(carol.id);
  });

  it("throws NotInContactsError with only the rejected subset when some IDs are visible", async () => {
    const alice = await insertAgent("alice-mix", ALICE_OWNER);
    const alice2 = await insertAgent("alice-sib", ALICE_OWNER);
    const carol = await insertAgent("carol-mix", CAROL_OWNER);
    // alice2 is a sibling (same owner) → visible; carol is not

    const exit = await runSubscribe({
      callerAgentId: alice.id as AgentId,
      callerOwnerUserId: ALICE_OWNER,
      requestedIds: [alice2.id as AgentId, carol.id as AgentId],
    });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;

    const failureOpt = Cause.failureOption(exit.cause);
    expect(failureOpt._tag).toBe("Some");
    if (failureOpt._tag !== "Some") return;

    const wire = wireErrorFromInstance(failureOpt.value);
    expect(wire).not.toBeNull();
    expect(wire!.code).toBe(NotInContactsError.code);
    const data = wire!.data as { agentIds: string[] };
    // Only carol is rejected; alice2 (sibling) is visible
    expect(data.agentIds).toEqual([carol.id]);
    expect(data.agentIds).not.toContain(alice2.id);
  });

  it("succeeds when all requested IDs are in the caller's visibility set", async () => {
    const alice = await insertAgent("alice-ok", ALICE_OWNER);
    const alice2 = await insertAgent("alice-sib2", ALICE_OWNER);

    const exit = await runSubscribe({
      callerAgentId: alice.id as AgentId,
      callerOwnerUserId: ALICE_OWNER,
      requestedIds: [alice2.id as AgentId],
    });

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
