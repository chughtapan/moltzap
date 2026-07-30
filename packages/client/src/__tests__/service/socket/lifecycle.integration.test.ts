import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The two-session comparison and shared cleanup are one atomic integration scenario.
it("different sessions have independent read markers", () =>
  // eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- Splitting the Effect generator would hide the independent marker sequence.
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("wm3-a");
    const regB = yield* H.registerAgent("wm3-b");
    const regC = yield* H.registerAgent("wm3-c");
    const regD = yield* H.registerAgent("wm3-d");
    yield* H.connectClients(regB.client, regC.client, regD.client);
    const service = yield* H.connectService(regA.apiKey, regA.agentId);
    yield* service.startSocketServer();
    // Cleanup must be Effect.ensuring: a gen-body finally is skipped when a yielded effect fails.
    yield* Effect.gen(function* () {
      const convB = yield* H.createDm(service, regB.agentId);
      const convC = yield* H.createDm(service, regC.agentId);
      const convD = yield* H.createDm(service, regD.agentId);

      // Message in conv C
      yield* H.sendAndSettle(
        regC.client,
        convC.task.id,
        /* Safe because the test fixture establishes this asserted shape. */ convC
          .conversation!.id,
        H.SHARED_UPDATE,
      );

      // Conv B reads history → advances lastRead for convB→convC
      const histB = yield* H.socketHistory(
        convC.task.id,
        /* Safe because the test fixture establishes this asserted shape. */ convC
          .conversation!.id,
        /* Safe because the test fixture establishes this asserted shape. */ convB
          .conversation!.id,
      );
      expect(histB.newCount).toBe(1); // first read

      // Conv B reads again → 0 new
      const histB2 = yield* H.socketHistory(
        convC.task.id,
        /* Safe because the test fixture establishes this asserted shape. */ convC
          .conversation!.id,
        /* Safe because the test fixture establishes this asserted shape. */ convB
          .conversation!.id,
      );
      expect(histB2.newCount).toBe(0);

      // Conv D reads same conversation → still 1 new (independent markers)
      const histD = yield* H.socketHistory(
        convC.task.id,
        /* Safe because the test fixture establishes this asserted shape. */ convC
          .conversation!.id,
        /* Safe because the test fixture establishes this asserted shape. */ convD
          .conversation!.id,
      );
      expect(histD.newCount).toBe(1);
    }).pipe(
      Effect.ensuring(
        H.closeAll(
          [service],
          [regA.client, regB.client, regC.client, regD.client],
        ),
      ),
    );
  }));

it("socket request resolves without 10s hang (timer leak regression)", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("sock-timer");
    const service = yield* H.connectService(reg.apiKey, reg.agentId);
    yield* service.startSocketServer();
    yield* Effect.gen(function* () {
      const start = performance.now();
      yield* H.requestDaemonCommand(H.localDaemonCommands.status, {});
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(H.SOCKET_RESPONSE_TIMEOUT_MS);
    }).pipe(Effect.ensuring(H.closeAll([service], [reg.client])));
  }));

it("two services use separate socket paths", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("sock-multi-a");
    const regB = yield* H.registerAgent("sock-multi-b");
    const serviceA = yield* H.connectService(regA.apiKey, regA.agentId);
    const serviceB = yield* H.connectService(regB.apiKey, regB.agentId);
    yield* serviceA.startSocketServer();
    yield* serviceB.startSocketServer();
    yield* Effect.gen(function* () {
      expect(serviceA.socketPath).not.toBe(serviceB.socketPath);

      // Both respond via their own socket path
      const resultA = yield* H.requestDaemonCommand(
        H.localDaemonCommands.status,
        {},
        serviceA.socketPath,
      );
      const resultB = yield* H.requestDaemonCommand(
        H.localDaemonCommands.status,
        {},
        serviceB.socketPath,
      );
      expect(resultA.agentId).toBe(regA.agentId);
      expect(resultB.agentId).toBe(regB.agentId);
    }).pipe(
      Effect.ensuring(
        H.closeAll([serviceA, serviceB], [regA.client, regB.client]),
      ),
    );
  }));
