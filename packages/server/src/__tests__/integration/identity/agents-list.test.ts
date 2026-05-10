import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  getKyselyDb,
  trackClient,
  connectTestClient,
} from "../helpers.js";
import type { AgentCard } from "@moltzap/protocol";
import { userId } from "@moltzap/protocol/testing";
import type { UserId } from "@moltzap/protocol/identity";

import {
  AgentsList,
  AgentsLookup,
  AgentsLookupByName,
  ContactsAdd,
  ContactsAccept,
} from "@moltzap/protocol";

type AgentsListResult = { agents: Record<string, AgentCard> };
type AgentsArrayResult = { agents: AgentCard[] };

// agents/list is contact-scoped per #481; admin-register is used to bind
// explicit owners so the cross-owner visibility cases can be exercised.
const REGISTRATION_SECRET = "agents-list-test-secret-zxcv";
const ALICE_USER_ID = userId("00000000-0000-4000-8000-00000000a11c");
const BOB_USER_ID = userId("00000000-0000-4000-8000-00000000b0b0");
const CAROL_USER_ID = userId("00000000-0000-4000-8000-00000000ca60");

let baseUrl: string;
let wsUrl: string;
let pairCounter = 0;

beforeAll(async () => {
  const server = await startTestServer({
    registrationSecret: REGISTRATION_SECRET,
  });
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  pairCounter = 0;
});

interface AdminRegisterResponse {
  agentId: string;
  apiKey: string;
}

async function adminRegister(
  name: string,
  ownerUserId: UserId,
  description?: string,
): Promise<AdminRegisterResponse> {
  const res = await fetch(`${baseUrl}/api/v1/admin/register-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      inviteCode: REGISTRATION_SECRET,
      ownerUserId,
      ...(description !== undefined ? { description } : {}),
    }),
  });
  const json = (await res.json()) as AdminRegisterResponse;
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `admin register failed: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

interface OwnedConnectedAgent {
  agentId: string;
  ownerUserId: UserId;
  client: Awaited<
    ReturnType<typeof connectTestClient> extends Effect.Effect<
      infer A,
      infer _E
    >
      ? A
      : never
  >;
}

function registerAndConnectOwned(opts: {
  name: string;
  ownerUserId: UserId;
  description?: string;
}): Effect.Effect<OwnedConnectedAgent, Error> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const reg = yield* Effect.tryPromise(() =>
      adminRegister(`${opts.name}-${idx}`, opts.ownerUserId, opts.description),
    );
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);
    return {
      agentId: reg.agentId,
      ownerUserId: opts.ownerUserId,
      client,
    };
  });
}

describe(`${AgentsList.name} — contact-scoped per #481`, () => {
  it.live(
    "returns own agents (siblings under same ownerUserId), without contacts setup",
    () =>
      Effect.gen(function* () {
        const alice1 = yield* registerAndConnectOwned({
          name: "alice-sib1",
          ownerUserId: ALICE_USER_ID,
        });
        const alice2 = yield* registerAndConnectOwned({
          name: "alice-sib2",
          ownerUserId: ALICE_USER_ID,
        });

        const result = (yield* alice1.client.sendRpc(
          AgentsList,
          {},
        )) as AgentsListResult;
        const ids = Object.keys(result.agents);
        expect(ids).toContain(alice1.agentId);
        expect(ids).toContain(alice2.agentId);
      }),
  );

  it.live(
    "does NOT return agents owned by users the caller is not in contact with",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnectOwned({
          name: "alice-iso",
          ownerUserId: ALICE_USER_ID,
        });
        const carol = yield* registerAndConnectOwned({
          name: "carol-iso",
          ownerUserId: CAROL_USER_ID,
        });

        const result = (yield* alice.client.sendRpc(
          AgentsList,
          {},
        )) as AgentsListResult;
        expect(result.agents[carol.agentId]).toBeUndefined();
        expect(result.agents[alice.agentId]).toBeDefined();
      }),
  );

  it.live(
    "returns agents whose owner is an accepted contact of the caller's owner",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnectOwned({
          name: "alice-x",
          ownerUserId: ALICE_USER_ID,
        });
        const bob = yield* registerAndConnectOwned({
          name: "bob-x",
          ownerUserId: BOB_USER_ID,
        });
        const carol = yield* registerAndConnectOwned({
          name: "carol-x",
          ownerUserId: CAROL_USER_ID,
        });

        const added = yield* alice.client.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID,
        });
        yield* bob.client.sendRpc(ContactsAccept, {
          contactId: added.contact.id,
        });

        const aliceList = (yield* alice.client.sendRpc(
          AgentsList,
          {},
        )) as AgentsListResult;
        const aliceIds = Object.keys(aliceList.agents);
        expect(aliceIds).toContain(alice.agentId);
        expect(aliceIds).toContain(bob.agentId);
        expect(aliceIds).not.toContain(carol.agentId);

        // contacts/accept inserts the reverse edge — Bob sees Alice too.
        const bobList = (yield* bob.client.sendRpc(
          AgentsList,
          {},
        )) as AgentsListResult;
        const bobIds = Object.keys(bobList.agents);
        expect(bobIds).toContain(bob.agentId);
        expect(bobIds).toContain(alice.agentId);
        expect(bobIds).not.toContain(carol.agentId);
      }),
  );

  it.live(
    "pending contact request does NOT yet expose the requester's agents to the recipient (and vice versa)",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnectOwned({
          name: "alice-pending",
          ownerUserId: ALICE_USER_ID,
        });
        const bob = yield* registerAndConnectOwned({
          name: "bob-pending",
          ownerUserId: BOB_USER_ID,
        });

        // Pending status (no accept) must not unlock visibility.
        yield* alice.client.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID,
        });

        const aliceList = (yield* alice.client.sendRpc(
          AgentsList,
          {},
        )) as AgentsListResult;
        const bobList = (yield* bob.client.sendRpc(
          AgentsList,
          {},
        )) as AgentsListResult;
        expect(aliceList.agents[bob.agentId]).toBeUndefined();
        expect(bobList.agents[alice.agentId]).toBeUndefined();
      }),
  );

  it.live(
    "returns the AgentCard fields correctly for contact-visible agents",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnectOwned({
          name: "alice-card",
          ownerUserId: ALICE_USER_ID,
        });
        const bob = yield* registerAndConnectOwned({
          name: "bob-card",
          ownerUserId: BOB_USER_ID,
          description: "A test agent",
        });
        const added = yield* alice.client.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID,
        });
        yield* bob.client.sendRpc(ContactsAccept, {
          contactId: added.contact.id,
        });

        const result = (yield* alice.client.sendRpc(
          AgentsList,
          {},
        )) as AgentsListResult;
        const card = result.agents[bob.agentId];
        expect(card).toBeDefined();
        expect(card!.id).toBe(bob.agentId);
        expect(card!.description).toBe("A test agent");
        expect(card!.status).toBe("active");
        expect(card!.ownerUserId).toBe(BOB_USER_ID);
      }),
  );
});

describe(`${AgentsLookup.name} — NOT contact-scoped per #481`, () => {
  it.live("returns agent cards by ID", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnectOwned({
        name: "alice-lookup",
        ownerUserId: ALICE_USER_ID,
      });

      const result = (yield* alice.client.sendRpc(AgentsLookup, {
        agentIds: [alice.agentId],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.id).toBe(alice.agentId);
      expect(result.agents[0]!.status).toBe("active");
    }),
  );

  it.live("returns empty array for unknown IDs", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnectOwned({
        name: "alice-lookup-empty",
        ownerUserId: ALICE_USER_ID,
      });

      const result = (yield* alice.client.sendRpc(AgentsLookup, {
        agentIds: ["00000000-0000-0000-0000-000000000000"],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(0);
    }),
  );

  it.live("includes description in lookup results", () =>
    Effect.gen(function* () {
      const described = yield* registerAndConnectOwned({
        name: "desc-agent",
        ownerUserId: ALICE_USER_ID,
        description: "Has a description",
      });

      const result = (yield* described.client.sendRpc(AgentsLookup, {
        agentIds: [described.agentId],
      })) as AgentsArrayResult;

      expect(result.agents[0]!.description).toBe("Has a description");
    }),
  );

  // Per architect #481: dereference-by-known-key. The client uses this RPC to
  // resolve peer `AgentCard`s for UI rendering of conversation messages
  // (`packages/client/src/service.ts:resolveAgentName` and the bulk-history
  // lookup); contact-scoping it would render conversation peers as UUIDs.
  it.live("returns cross-owner cards regardless of contact relationship", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnectOwned({
        name: "alice-lookup-xowner",
        ownerUserId: ALICE_USER_ID,
      });
      const carol = yield* registerAndConnectOwned({
        name: "carol-lookup-xowner",
        ownerUserId: CAROL_USER_ID,
      });

      const result = (yield* alice.client.sendRpc(AgentsLookup, {
        agentIds: [carol.agentId],
      })) as AgentsArrayResult;
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.id).toBe(carol.agentId);
    }),
  );
});

describe(`${AgentsLookupByName.name} — contact-scoped per #481/#506`, () => {
  it.live("returns agent cards by name", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnectOwned({
        name: "alice-lbyn",
        ownerUserId: ALICE_USER_ID,
      });
      // adminRegister appends a suffix; resolve the persisted name.
      const db = getKyselyDb();
      const row = yield* Effect.tryPromise(() =>
        db
          .selectFrom("agents")
          .select("name")
          .where("id", "=", alice.agentId)
          .executeTakeFirstOrThrow(),
      );

      const result = (yield* alice.client.sendRpc(AgentsLookupByName, {
        names: [row.name],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.id).toBe(alice.agentId);
    }),
  );

  it.live("only returns active agents", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnectOwned({
        name: "alice-active",
        ownerUserId: ALICE_USER_ID,
      });

      const db = getKyselyDb();
      const aliceRow = yield* Effect.tryPromise(() =>
        db
          .selectFrom("agents")
          .select("name")
          .where("id", "=", alice.agentId)
          .executeTakeFirstOrThrow(),
      );

      yield* Effect.tryPromise(() =>
        db
          .updateTable("agents")
          .set({ status: "suspended" })
          .where("id", "=", alice.agentId)
          .execute(),
      );

      // Bob is in contact with Alice, but Alice is suspended — should drop.
      const bob = yield* registerAndConnectOwned({
        name: "bob-active",
        ownerUserId: BOB_USER_ID,
      });
      const added = yield* bob.client.sendRpc(ContactsAdd, {
        contactUserId: ALICE_USER_ID,
      });
      yield* alice.client.sendRpc(ContactsAccept, {
        contactId: added.contact.id,
      });

      const result = (yield* bob.client.sendRpc(AgentsLookupByName, {
        names: [aliceRow.name],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(0);
    }),
  );

  it.live("returns empty array for unknown names", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnectOwned({
        name: "alice-unknown",
        ownerUserId: ALICE_USER_ID,
      });

      const result = (yield* alice.client.sendRpc(AgentsLookupByName, {
        names: ["nonexistent"],
      })) as AgentsArrayResult;

      expect(result.agents).toHaveLength(0);
    }),
  );

  it.live(
    "drops a cross-owner name match when the caller is not in contact with the owner",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnectOwned({
          name: "alice-lbyn-iso",
          ownerUserId: ALICE_USER_ID,
        });
        const carol = yield* registerAndConnectOwned({
          name: "carol-lbyn-iso",
          ownerUserId: CAROL_USER_ID,
        });

        const db = getKyselyDb();
        const carolRow = yield* Effect.tryPromise(() =>
          db
            .selectFrom("agents")
            .select("name")
            .where("id", "=", carol.agentId)
            .executeTakeFirstOrThrow(),
        );

        const result = (yield* alice.client.sendRpc(AgentsLookupByName, {
          names: [carolRow.name],
        })) as AgentsArrayResult;
        expect(result.agents).toHaveLength(0);
      }),
  );

  it.live(
    "returns the card when the name belongs to an accepted-contact-owned agent",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnectOwned({
          name: "alice-lbyn-c",
          ownerUserId: ALICE_USER_ID,
        });
        const bob = yield* registerAndConnectOwned({
          name: "bob-lbyn-c",
          ownerUserId: BOB_USER_ID,
        });

        const added = yield* alice.client.sendRpc(ContactsAdd, {
          contactUserId: BOB_USER_ID,
        });
        yield* bob.client.sendRpc(ContactsAccept, {
          contactId: added.contact.id,
        });

        const db = getKyselyDb();
        const bobRow = yield* Effect.tryPromise(() =>
          db
            .selectFrom("agents")
            .select("name")
            .where("id", "=", bob.agentId)
            .executeTakeFirstOrThrow(),
        );

        const result = (yield* alice.client.sendRpc(AgentsLookupByName, {
          names: [bobRow.name],
        })) as AgentsArrayResult;
        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]!.id).toBe(bob.agentId);
      }),
  );
});
