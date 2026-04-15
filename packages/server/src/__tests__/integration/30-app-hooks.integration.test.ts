import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
  getTestCoreApp,
} from "./helpers.js";
import type { AppManifest } from "@moltzap/protocol";
import { ErrorCodes } from "@moltzap/protocol";

let _baseUrl: string;
let _wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  _baseUrl = server.baseUrl;
  _wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

/** Set owner_user_id on an agent so it can participate in app sessions. */
async function setOwner(agentId: string, userId?: string): Promise<string> {
  const db = getKyselyDb();
  const uid = userId ?? crypto.randomUUID();
  await db
    .updateTable("agents")
    .set({ owner_user_id: uid })
    .where("id", "=", agentId)
    .execute();
  return uid;
}

/** Create a minimal app manifest with hooks declared. */
function testManifest(overrides?: Partial<AppManifest>): AppManifest {
  return {
    appId: "test-app",
    name: "Test App",
    permissions: { required: [], optional: [] },
    conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
    hooks: {
      beforeMessageDelivery: { timeoutMs: 2000 },
      onJoin: { timeoutMs: 2000 },
    },
    ...overrides,
  };
}

describe("Scenario 30: App Hooks", () => {
  it("hook blocks a message and returns structured feedback", async () => {
    const app = getTestCoreApp();
    const manifest = testManifest();
    app.registerApp(manifest);

    app.onBeforeMessageDelivery("test-app", (ctx) => {
      const textPart = ctx.parts.find((p) => p.type === "text");
      if (
        textPart &&
        textPart.type === "text" &&
        textPart.text.includes("/kill")
      ) {
        return {
          action: "block",
          reason: "Invalid command format",
          feedback: { hint: "Use /kill <target>" },
          retry: true,
        };
      }
      return { action: "allow" };
    });

    const alice = await registerAndConnect("alice-hook");
    const bob = await registerAndConnect("bob-hook");
    await setOwner(alice.agentId);
    await setOwner(bob.agentId);

    const session = await app.createAppSession("test-app", alice.agentId, [
      bob.agentId,
    ]);

    // Wait for admission to complete
    await alice.client.waitForEvent("app/sessionReady", 5000);

    const convId = session.conversations["main"]!;

    // Send a message that should be blocked
    try {
      await alice.client.rpc("messages/send", {
        conversationId: convId,
        parts: [{ type: "text", text: "/kill" }],
      });
      expect.fail("Expected RpcError to be thrown");
    } catch (err: unknown) {
      const rpcErr = err as { code: number; message: string; data?: unknown };
      expect(rpcErr.code).toBe(ErrorCodes.HookBlocked);
      expect(rpcErr.message).toBe("Invalid command format");
      expect(rpcErr.data).toEqual({
        feedback: { hint: "Use /kill <target>" },
        retry: true,
      });
    }
  });

  it("hook patches message parts before delivery", async () => {
    const app = getTestCoreApp();
    const manifest = testManifest();
    app.registerApp(manifest);

    app.onBeforeMessageDelivery("test-app", (ctx) => {
      const textPart = ctx.parts.find((p) => p.type === "text");
      if (
        textPart &&
        textPart.type === "text" &&
        textPart.text.includes("badword")
      ) {
        return {
          action: "patch",
          parts: [
            { type: "text", text: textPart.text.replace("badword", "***") },
          ],
        };
      }
      return { action: "allow" };
    });

    const alice = await registerAndConnect("alice-patch");
    const bob = await registerAndConnect("bob-patch");
    await setOwner(alice.agentId);
    await setOwner(bob.agentId);

    const session = await app.createAppSession("test-app", alice.agentId, [
      bob.agentId,
    ]);

    await alice.client.waitForEvent("app/sessionReady", 5000);

    const convId = session.conversations["main"]!;

    // Send a message that should be patched
    const result = (await alice.client.rpc("messages/send", {
      conversationId: convId,
      parts: [{ type: "text", text: "hello badword world" }],
    })) as {
      message: {
        parts: Array<{ type: string; text: string }>;
        patchedBy?: string;
      };
    };

    expect(result.message.parts[0]!.text).toBe("hello *** world");
    expect(result.message.patchedBy).toBe("hook");
  });

  it("hook timeout fails open — message delivered", async () => {
    const app = getTestCoreApp();
    const manifest = testManifest({
      hooks: {
        beforeMessageDelivery: { timeoutMs: 100 }, // Very short timeout
      },
    });
    app.registerApp(manifest);

    app.onBeforeMessageDelivery("test-app", async (_ctx, signal) => {
      // Simulate a slow hook that exceeds the timeout
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return { action: "block", reason: "should not reach here" };
    });

    const alice = await registerAndConnect("alice-timeout");
    const bob = await registerAndConnect("bob-timeout");
    await setOwner(alice.agentId);
    await setOwner(bob.agentId);

    const session = await app.createAppSession("test-app", alice.agentId, [
      bob.agentId,
    ]);

    await alice.client.waitForEvent("app/sessionReady", 5000);

    const convId = session.conversations["main"]!;

    // Message should still go through despite hook timing out
    const result = (await alice.client.rpc("messages/send", {
      conversationId: convId,
      parts: [{ type: "text", text: "hello after timeout" }],
    })) as { message: { parts: Array<{ type: string; text: string }> } };

    expect(result.message.parts[0]!.text).toBe("hello after timeout");
  });

  it("on_join hook fires when agent is admitted", async () => {
    const app = getTestCoreApp();
    const manifest = testManifest();
    app.registerApp(manifest);

    let joinCtx: {
      sessionId: string;
      appId: string;
      agentId: string;
      grantedResources: string[];
    } | null = null;

    app.onAppJoin("test-app", (ctx) => {
      joinCtx = { ...ctx };
    });

    const alice = await registerAndConnect("alice-join");
    const bob = await registerAndConnect("bob-join");
    await setOwner(alice.agentId);
    await setOwner(bob.agentId);

    const session = await app.createAppSession("test-app", alice.agentId, [
      bob.agentId,
    ]);

    await alice.client.waitForEvent("app/sessionReady", 5000);

    // on_join should have fired for bob
    expect(joinCtx).not.toBeNull();
    expect(joinCtx!.sessionId).toBe(session.id);
    expect(joinCtx!.appId).toBe("test-app");
    expect(joinCtx!.agentId).toBe(bob.agentId);
  });

  it("non-app conversation messages pass through without hooks", async () => {
    const app = getTestCoreApp();
    const manifest = testManifest();
    app.registerApp(manifest);

    let hookCalled = false;
    app.onBeforeMessageDelivery("test-app", () => {
      hookCalled = true;
      return { action: "block", reason: "should not be called" };
    });

    const alice = await registerAndConnect("alice-noapp");
    const bob = await registerAndConnect("bob-noapp");

    // Create a regular DM conversation (not an app session)
    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    // Send a message — should not trigger hooks
    const result = (await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "regular message" }],
    })) as { message: { parts: Array<{ type: string; text: string }> } };

    expect(result.message.parts[0]!.text).toBe("regular message");
    expect(hookCalled).toBe(false);
  });

  it("hook allows message through explicitly", async () => {
    const app = getTestCoreApp();
    const manifest = testManifest();
    app.registerApp(manifest);

    app.onBeforeMessageDelivery("test-app", () => {
      return { action: "allow" };
    });

    const alice = await registerAndConnect("alice-allow");
    const bob = await registerAndConnect("bob-allow");
    await setOwner(alice.agentId);
    await setOwner(bob.agentId);

    const session = await app.createAppSession("test-app", alice.agentId, [
      bob.agentId,
    ]);

    await alice.client.waitForEvent("app/sessionReady", 5000);

    const convId = session.conversations["main"]!;

    const result = (await alice.client.rpc("messages/send", {
      conversationId: convId,
      parts: [{ type: "text", text: "allowed message" }],
    })) as { message: { parts: Array<{ type: string; text: string }> } };

    expect(result.message.parts[0]!.text).toBe("allowed message");
  });

  it("app without hooks registered passes messages through", async () => {
    const app = getTestCoreApp();
    const manifest = testManifest({ appId: "no-hook-app" });
    app.registerApp(manifest);
    // No hooks registered for "no-hook-app"

    const alice = await registerAndConnect("alice-nohook");
    const bob = await registerAndConnect("bob-nohook");
    await setOwner(alice.agentId);
    await setOwner(bob.agentId);

    const session = await app.createAppSession("no-hook-app", alice.agentId, [
      bob.agentId,
    ]);

    await alice.client.waitForEvent("app/sessionReady", 5000);

    const convId = session.conversations["main"]!;

    const result = (await alice.client.rpc("messages/send", {
      conversationId: convId,
      parts: [{ type: "text", text: "no hook message" }],
    })) as { message: { parts: Array<{ type: string; text: string }> } };

    expect(result.message.parts[0]!.text).toBe("no hook message");
  });
});
