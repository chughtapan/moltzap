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

    // Runtime toolkit — error factories
    expect(mod.notFound).toBeDefined();
    expect(mod.forbidden).toBeDefined();
    expect(mod.unauthorized).toBeDefined();
    expect(mod.invalidParams).toBeDefined();
    expect(mod.conflict).toBeDefined();
    expect(mod.internalError).toBeDefined();
    expect(mod.blocked).toBeDefined();
    expect(mod.rateLimited).toBeDefined();

    // Runtime toolkit — coalescing
    expect(mod.coalesce).toBeDefined();
    expect(mod.drainCoalesceMap).toBeDefined();

    // Effect-Kysely toolkit
    expect(mod.makeEffectKysely).toBeDefined();
    expect(mod.takeFirstOption).toBeDefined();
    expect(mod.takeFirstOrElse).toBeDefined();
    expect(mod.takeFirstOrFail).toBeDefined();
    expect(mod.catchSqlErrorAsDefect).toBeDefined();
    expect(mod.sqlErrorToDefect).toBeDefined();
    expect(mod.transaction).toBeDefined();
    expect(mod.rawQuery).toBeDefined();

    // Handler factories — per-domain RPC handler builders
    expect(mod.createCoreAuthHandlers).toBeDefined();
    expect(mod.createConversationHandlers).toBeDefined();
    expect(mod.createMessageHandlers).toBeDefined();
    expect(mod.createPresenceHandlers).toBeDefined();
    expect(mod.createAppHandlers).toBeDefined();
    expect(mod.ConnIdTag).toBeDefined();
  });
});
