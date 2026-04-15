import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestServer, stopTestServer, resetTestDb } from "./helpers.js";
import { registerAndConnect } from "./helpers.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Presence Lifecycle", () => {
  it("subscribe returns online status for connected agent", async () => {
    const alice = await registerAndConnect("alice-pres");
    const bob = await registerAndConnect("bob-pres");

    const result = (await alice.client.rpc("presence/subscribe", {
      agentIds: [bob.agentId],
    })) as { statuses: Array<{ agentId: string; status: string }> };

    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]!.status).toBe("online");
  });

  it("presence/update pushes PresenceChanged to subscribers", async () => {
    const alice = await registerAndConnect("alice-away");
    const bob = await registerAndConnect("bob-away");

    await alice.client.rpc("presence/subscribe", {
      agentIds: [bob.agentId],
    });

    const presPromise = alice.client.waitForEvent("presence/changed");
    await bob.client.rpc("presence/update", { status: "away" });

    const event = await presPromise;
    const data = event.data as {
      agentId: string;
      status: string;
    };
    expect(data.agentId).toBe(bob.agentId);
    expect(data.status).toBe("away");
  });

  it("presence cycles through online → away → offline", async () => {
    const alice = await registerAndConnect("alice-cycle");
    const bob = await registerAndConnect("bob-cycle");

    await alice.client.rpc("presence/subscribe", {
      agentIds: [bob.agentId],
    });

    // away
    const awayPromise = alice.client.waitForEvent("presence/changed");
    await bob.client.rpc("presence/update", { status: "away" });
    const awayEvent = await awayPromise;
    expect((awayEvent.data as { status: string }).status).toBe("away");

    // back online
    const onlinePromise = alice.client.waitForEvent("presence/changed");
    await bob.client.rpc("presence/update", { status: "online" });
    const onlineEvent = await onlinePromise;
    expect((onlineEvent.data as { status: string }).status).toBe("online");

    // offline
    const offlinePromise = alice.client.waitForEvent("presence/changed");
    await bob.client.rpc("presence/update", { status: "offline" });
    const offlineEvent = await offlinePromise;
    expect((offlineEvent.data as { status: string }).status).toBe("offline");
  });
});
