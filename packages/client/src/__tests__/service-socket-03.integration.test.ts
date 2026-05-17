import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "./service.integration-support.js";

H.setupServiceIntegration();

// ─── Group 4: Socket Server ──────────────────────────────────────────────────

it("different sessions have independent read markers", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("wm3-a");
    const regB = yield* H.registerAgent("wm3-b");
    const regC = yield* H.registerAgent("wm3-c");
    const regD = yield* H.registerAgent("wm3-d");
    yield* H.connectClients(regB.client, regC.client, regD.client);
    const service = yield* H.connectService(regA.apiKey);
    yield* service.startSocketServer();
    try {
      const convB = yield* H.createDm(service, regB.agentId);
      const convC = yield* H.createDm(service, regC.agentId);
      const convD = yield* H.createDm(service, regD.agentId);

      // Message in conv C
      yield* H.sendAndSettle(
        regC.client,
        convC.conversation.id,
        H.SHARED_UPDATE,
      );

      // Conv B reads history → advances lastRead for convB→convC
      const histB = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(histB.newCount).toBe(1); // first read

      // Conv B reads again → 0 new
      const histB2 = yield* H.socketHistory(
        convC.conversation.id,
        convB.conversation.id,
      );
      expect(histB2.newCount).toBe(0);

      // Conv D reads same conversation → still 1 new (independent markers)
      const histD = yield* H.socketHistory(
        convC.conversation.id,
        convD.conversation.id,
      );
      expect(histD.newCount).toBe(1);
    } finally {
      service.close();
      yield* H.closeClients(regA.client, regB.client, regC.client, regD.client);
    }
  }));

it("socket request resolves without 10s hang (timer leak regression)", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-timer");
    const service = yield* H.connectService(reg.apiKey);
    yield* service.startSocketServer();
    try {
      const start = performance.now();
      yield* H.requestLocalService(H.LocalServiceCommands.Ping);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(H.SOCKET_RESPONSE_TIMEOUT_MS);
    } finally {
      service.close();
      yield* reg.client.close();
    }
  }));

it("two services use separate socket paths", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-multi-a");
    const regB = yield* H.registerAgent("sock-multi-b");
    const serviceA = yield* H.connectService(regA.apiKey);
    const serviceB = yield* H.connectService(regB.apiKey);
    yield* serviceA.startSocketServer();
    yield* serviceB.startSocketServer();
    try {
      expect(serviceA.socketPath).not.toBe(serviceB.socketPath);

      // Both respond via their own socket path
      const resultA = yield* H.requestLocalService(
        H.LocalServiceCommands.Ping,
        undefined,
        serviceA.socketPath,
      );
      const resultB = yield* H.requestLocalService(
        H.LocalServiceCommands.Ping,
        undefined,
        serviceB.socketPath,
      );
      expect(resultA.agentId).toBe(regA.agentId);
      expect(resultB.agentId).toBe(regB.agentId);
    } finally {
      serviceA.close();
      serviceB.close();
      yield* regA.client.close();
      yield* regB.client.close();
    }
  }));
