import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  inject,
} from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import { createCoreApp } from "../../../examples/server.js";
import { seedInitialKek } from "../../crypto/key-rotation.js";
import { EnvelopeEncryption } from "../../crypto/envelope.js";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import type { CoreApp } from "../../../examples/types.js";
import type { Database } from "../../db/database.js";

const MASTER_SECRET = randomBytes(32).toString("base64");

let coreApp: CoreApp;
let baseUrl: string;
let wsUrl: string;
let adminPool: pg.Pool;
let resetPool: pg.Pool;
let resetDb: Kysely<Database>;
let dbName: string;

beforeAll(async () => {
  const host = inject("testPgHost");
  const port = inject("testPgPort");

  // Create an isolated test database from the migrated template
  dbName = `test_${crypto.randomUUID().replace(/-/g, "")}`;
  adminPool = new pg.Pool({
    host,
    port,
    user: "test",
    password: "test",
    database: "postgres",
    max: 2,
  });
  await adminPool.query(
    `CREATE DATABASE "${dbName}" TEMPLATE moltzap_template`,
  );

  const connString = `postgresql://test:test@${host}:${port}/${dbName}`;

  // Shared pool + Kysely for resetDb() across all tests
  resetPool = new pg.Pool({ connectionString: connString, max: 2 });
  resetDb = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: resetPool }),
  });

  // Seed encryption key
  const envelope = new EnvelopeEncryption(MASTER_SECRET);
  await seedInitialKek(resetDb, envelope);

  // Boot core server
  coreApp = createCoreApp({
    databaseUrl: connString,
    encryptionMasterSecret: MASTER_SECRET,
    port: 0,
    corsOrigins: ["*"],
    devMode: true,
  });

  await new Promise((r) => setTimeout(r, 200));

  const assignedPort = coreApp.port;
  baseUrl = `http://localhost:${assignedPort}`;
  wsUrl = `ws://localhost:${assignedPort}/ws`;
}, 60_000);

afterAll(async () => {
  await coreApp?.close();
  await resetDb?.destroy();
  if (adminPool && dbName) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  }
  await adminPool?.end();
});

async function truncateAndReseed(): Promise<void> {
  await resetPool.query(`
    TRUNCATE TABLE
      reactions, message_delivery, messages,
      conversation_participants, conversation_keys, conversations,
      agents, users, encryption_keys
    CASCADE;
  `);
  const envelope = new EnvelopeEncryption(MASTER_SECRET);
  await seedInitialKek(resetDb, envelope);
}

const openClients: MoltZapTestClient[] = [];

async function registerAndConnect(
  name: string,
): Promise<{ client: MoltZapTestClient; agentId: string; apiKey: string }> {
  const client = new MoltZapTestClient(baseUrl, wsUrl);
  openClients.push(client);
  const reg = await client.register(name);
  await client.connect(reg.apiKey);
  return { client, agentId: reg.agentId, apiKey: reg.apiKey };
}

describe("core-server integration", () => {
  beforeEach(async () => {
    await truncateAndReseed();
  });

  afterEach(() => {
    for (const c of openClients) c.close();
    openClients.length = 0;
  });

  it("health check returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("registers an agent without invite code", async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-agent" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agentId: string; apiKey: string };
    expect(body.agentId).toBeDefined();
    expect(body.apiKey).toMatch(/^moltzap_agent_/);
  });

  it("agent connects via WebSocket with API key", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("ws-agent");
    const hello = (await client.connect(reg.apiKey)) as {
      protocolVersion: string;
      policy: { rateLimits: { messagesPerMinute: number } };
    };
    expect(hello.protocolVersion).toBeDefined();
    expect(hello.policy.rateLimits.messagesPerMinute).toBe(60);
    client.close();
  });

  it("two agents exchange messages", async () => {
    const alice = new MoltZapTestClient(baseUrl, wsUrl);
    const bob = new MoltZapTestClient(baseUrl, wsUrl);

    const aliceReg = await alice.register("alice-msg");
    const bobReg = await bob.register("bob-msg");

    await alice.connect(aliceReg.apiKey);
    await bob.connect(bobReg.apiKey);

    // Alice creates DM with Bob
    const conv = (await alice.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bobReg.agentId }],
    })) as { conversation: { id: string } };

    // Bob waits for message BEFORE Alice sends
    const bobMsgPromise = bob.waitForEvent("messages/received");
    await alice.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Hello from core!" }],
    });

    const bobEvent = await bobMsgPromise;
    expect(
      (bobEvent.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("Hello from core!");

    alice.close();
    bob.close();
  });

  it("presence/subscribe returns current status", async () => {
    const alice = new MoltZapTestClient(baseUrl, wsUrl);
    const bob = new MoltZapTestClient(baseUrl, wsUrl);

    const aliceReg = await alice.register("alice-pres");
    const bobReg = await bob.register("bob-pres");

    await alice.connect(aliceReg.apiKey);
    await bob.connect(bobReg.apiKey);

    // Bob is online after connecting. Alice queries his status.
    const result = (await alice.rpc("presence/subscribe", {
      participants: [{ type: "agent", id: bobReg.agentId }],
    })) as { statuses: Array<{ status: string }> };

    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]!.status).toBe("online");

    alice.close();
    bob.close();
  });

  it("presence/update pushes PresenceChanged to subscribers", async () => {
    const alice = new MoltZapTestClient(baseUrl, wsUrl);
    const bob = new MoltZapTestClient(baseUrl, wsUrl);

    const aliceReg = await alice.register("alice-pbcast");
    const bobReg = await bob.register("bob-pbcast");

    await alice.connect(aliceReg.apiKey);
    await bob.connect(bobReg.apiKey);

    // Alice subscribes to Bob's presence (registers for push updates)
    await alice.rpc("presence/subscribe", {
      participants: [{ type: "agent", id: bobReg.agentId }],
    });

    // Set up waiter BEFORE triggering the presence update
    const presencePromise = alice.waitForEvent("presence/changed");

    // Bob updates presence to "away"
    await bob.rpc("presence/update", { status: "away" });

    const presEvent = await presencePromise;
    const data = presEvent.data as {
      participant: { type: string; id: string };
      status: string;
    };
    expect(data.participant.id).toBe(bobReg.agentId);
    expect(data.status).toBe("away");

    alice.close();
    bob.close();
  });

  it("phone-specific RPCs return unknown method", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("method-check");
    await client.connect(reg.apiKey);

    for (const method of [
      "contacts/list",
      "contacts/add",
      "contacts/discover",
      "contacts/sync",
      "push/register",
      "invites/create-agent",
    ]) {
      await expect(client.rpc(method, {})).rejects.toThrow();
    }

    client.close();
  });

  it("claim endpoints return 404", async () => {
    const claimInfo = await fetch(`${baseUrl}/api/v1/claim-info?token=foo`);
    expect(claimInfo.status).toBe(404);

    const preVerify = await fetch(`${baseUrl}/api/v1/auth/pre-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+1555", claimToken: "foo" }),
    });
    expect(preVerify.status).toBe(404);
  });

  it("group conversation with message fan-out", async () => {
    const alice = new MoltZapTestClient(baseUrl, wsUrl);
    const bob = new MoltZapTestClient(baseUrl, wsUrl);
    const eve = new MoltZapTestClient(baseUrl, wsUrl);

    const aliceReg = await alice.register("alice-grp");
    const bobReg = await bob.register("bob-grp");
    const eveReg = await eve.register("eve-grp");

    await alice.connect(aliceReg.apiKey);
    await bob.connect(bobReg.apiKey);
    await eve.connect(eveReg.apiKey);

    const conv = (await alice.rpc("conversations/create", {
      type: "group",
      name: "Core Team",
      participants: [
        { type: "agent", id: bobReg.agentId },
        { type: "agent", id: eveReg.agentId },
      ],
    })) as { conversation: { id: string } };

    const bobPromise = bob.waitForEvent("messages/received");
    const evePromise = eve.waitForEvent("messages/received");

    await alice.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Group hello" }],
    });

    const [bobEvent, eveEvent] = await Promise.all([bobPromise, evePromise]);
    expect(
      (bobEvent.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("Group hello");
    expect(
      (eveEvent.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("Group hello");

    alice.close();
    bob.close();
    eve.close();
  });

  it("agents/lookup resolves by ID", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("lookup-agent");
    await client.connect(reg.apiKey);

    const result = (await client.rpc("agents/lookup", {
      agentIds: [reg.agentId],
    })) as { agents: Array<{ id: string; name: string; status: string }> };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("lookup-agent");
    expect(result.agents[0]!.status).toBe("active");

    client.close();
  });

  it("agents/lookupByName resolves by name", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    const reg = await client.register("named-agent");
    await client.connect(reg.apiKey);

    const result = (await client.rpc("agents/lookupByName", {
      names: ["named-agent"],
    })) as { agents: Array<{ id: string; name: string }> };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.id).toBe(reg.agentId);

    client.close();
  });

  it("rejects duplicate agent name", async () => {
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup-agent" }),
    });
    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup-agent" }),
    });
    expect(res.ok).toBe(false);
  });

  it("rejects suspended agent on auth/connect", async () => {
    const client = new MoltZapTestClient(baseUrl, wsUrl);
    openClients.push(client);
    const reg = await client.register("suspended-agent");

    await resetPool.query(
      `UPDATE agents SET status = 'suspended' WHERE id = $1`,
      [reg.agentId],
    );

    await expect(client.connect(reg.apiKey)).rejects.toThrow();
  });

  it("duplicate DM creation returns existing conversation", async () => {
    const { client: alice, agentId: _ } = await registerAndConnect("alice-dup");
    const bob = new MoltZapTestClient(baseUrl, wsUrl);
    openClients.push(bob);
    const bobReg = await bob.register("bob-dup");

    const conv1 = (await alice.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bobReg.agentId }],
    })) as { conversation: { id: string } };

    const conv2 = (await alice.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bobReg.agentId }],
    })) as { conversation: { id: string } };

    expect(conv2.conversation.id).toBe(conv1.conversation.id);
  });

  it("rejects message send from non-participant", async () => {
    const { client: alice } = await registerAndConnect("alice-np");
    const bob = new MoltZapTestClient(baseUrl, wsUrl);
    openClients.push(bob);
    const bobReg = await bob.register("bob-np");
    const { client: eve } = await registerAndConnect("eve-np");

    const conv = (await alice.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bobReg.agentId }],
    })) as { conversation: { id: string } };

    await expect(
      eve.rpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "I should not be here" }],
      }),
    ).rejects.toThrow();
  });

  it("protocol contact subpath exports resolve", async () => {
    // These are type-level exports; verify they resolve at runtime
    const contactEvents = await import("@moltzap/protocol/contact-events");
    expect(contactEvents.ContactRequestEventSchema).toBeDefined();
    expect(contactEvents.ContactAcceptedEventSchema).toBeDefined();

    const contactMethods = await import("@moltzap/protocol/contact-methods");
    expect(contactMethods.ContactsListParamsSchema).toBeDefined();
    expect(contactMethods.ContactsSyncParamsSchema).toBeDefined();
  });
});
