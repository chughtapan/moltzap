import { describe, it, expect } from "vitest";

describe("@moltzap/server-core", () => {
  // Cold-start dynamic import pulls the full server surface in a single
  // module graph — on slower CI hosts this crosses the default 5s vitest
  // timeout. Give it a generous window; the test itself does negligible work.
  it("exports building blocks", { timeout: 30_000 }, async () => {
    const mod = await import("../index.js");

    // Services
    expect(mod.AuthService).toBeDefined();
    expect(mod.ConversationService).toBeDefined();
    expect(mod.MessageService).toBeDefined();
    expect(mod.ParticipantService).toBeDefined();
    expect(mod.PresenceService).toBeDefined();
    expect(mod.DeliveryService).toBeDefined();

    // Infrastructure
    expect(mod.createRpcRouter).toBeDefined();
    expect(mod.RpcFailure).toBeDefined();
    expect(mod.ConnectionManager).toBeDefined();
    expect(mod.Broadcaster).toBeDefined();
    expect(mod.EnvelopeEncryption).toBeDefined();
    expect(mod.seedInitialKek).toBeDefined();
    expect(mod.generateApiKey).toBeDefined();
    expect(mod.logger).toBeDefined();
    expect(mod.createDb).toBeDefined();
    expect(mod.defineMethod).toBeDefined();
    expect(mod.nextSnowflakeId).toBeDefined();
  });
});
