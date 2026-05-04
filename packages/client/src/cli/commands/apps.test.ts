/**
 * Unit tests for `moltzap apps <subcommand>` handlers. Provides a fake
 * `Transport` via `Effect.provideService(Transport, fake)`; asserts on
 * (method, params) tuples recorded by the fake.
 *
 * Spec test-coverage floor (sbd#177 §"Cross-cutting acceptance floors"):
 * at least one success path and one RPC-failure path per handler.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  appsCloseHandler,
  appsCreateHandler,
  appsGetHandler,
  appsListHandler,
  appsRegisterHandler,
} from "./apps.js";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";

import {
  AppsCloseSession,
  AppsCreate,
  AppsGetSession,
  AppsListSessions,
  AppsRegister,
} from "@moltzap/protocol";

describe("apps register", () => {
  let tmp: string;
  let stdout: MockInstance;
  let stderr: MockInstance;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "moltzap-apps-"));
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("calls apps/register with the manifest body and prints appId", async () => {
    const manifestPath = join(tmp, "m.json");
    const manifest = {
      appId: "demo-app",
      name: "Demo App",
      conversations: [
        { key: "main", name: "Main", participantFilter: "all" as const },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const { calls, transport } = makeFakeTransport(() => ({
      appId: "app-xyz",
    }));
    await Effect.runPromise(
      appsRegisterHandler({ manifestPath }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls).toEqual([
      { method: AppsRegister.name, params: { manifest } },
    ]);
    expect(stdout).toHaveBeenCalledWith("app-xyz");
  });

  it("rejects a missing manifest file with AppsInputError", async () => {
    const { transport } = makeFakeTransport(() => ({ appId: "never" }));
    const result = await Effect.runPromiseExit(
      appsRegisterHandler({ manifestPath: join(tmp, "missing.json") }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      // Effect failure cause wraps the AppsInputError.
      const s = JSON.stringify(result.cause);
      expect(s).toMatch(/AppsInputError/);
    }
  });

  it("surfaces TransportRpcError as a failure", async () => {
    const manifestPath = join(tmp, "m.json");
    writeFileSync(manifestPath, JSON.stringify({}));
    const { transport } = makeFakeTransport(
      () => new Error("invalid manifest"),
    );
    const result = await Effect.runPromiseExit(
      appsRegisterHandler({ manifestPath }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("apps create", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls apps/create with appId and invitedAgentIds and prints session.id", async () => {
    const SESS_ID = "00000000-0000-4000-8000-0000000005e5";
    const AGENT_A = "00000000-0000-4000-8000-00000000000a";
    const AGENT_B = "00000000-0000-4000-8000-00000000000b";
    const INITIATOR = "00000000-0000-4000-8000-000000001717";
    const CONV_MAIN = "00000000-0000-4000-8000-000000000c01";
    const { calls, transport } = makeFakeTransport(() => ({
      session: {
        id: SESS_ID,
        appId: "app-1",
        initiatorAgentId: INITIATOR,
        status: "active",
        conversations: { main: CONV_MAIN },
        createdAt: "2026-05-04T00:00:00.000Z",
      },
    }));
    await Effect.runPromise(
      appsCreateHandler({
        appId: "app-1",
        invitedAgentIds: [AGENT_A, AGENT_B],
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls).toEqual([
      {
        method: AppsCreate.name,
        params: { appId: "app-1", invitedAgentIds: [AGENT_A, AGENT_B] },
      },
    ]);
    expect(stdout).toHaveBeenCalledWith(SESS_ID);
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("nope"));
    const result = await Effect.runPromiseExit(
      appsCreateHandler({ appId: "app-1", invitedAgentIds: [] }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("apps list", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls apps/listSessions with optional filters and prints one per line", async () => {
    const SESS_1 = "00000000-0000-4000-8000-000000000501";
    const SESS_2 = "00000000-0000-4000-8000-000000000502";
    const INITIATOR = "00000000-0000-4000-8000-000000001717";
    const CONV_MAIN = "00000000-0000-4000-8000-000000000c01";
    const baseSession = {
      appId: "app-1",
      initiatorAgentId: INITIATOR,
      conversations: { main: CONV_MAIN },
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const { calls, transport } = makeFakeTransport(() => ({
      sessions: [
        { ...baseSession, id: SESS_1, status: "active" },
        { ...baseSession, id: SESS_2, status: "closed" },
      ],
    }));
    await Effect.runPromise(
      appsListHandler({ appId: "app-1", status: "active", limit: 10 }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls).toEqual([
      {
        method: AppsListSessions.name,
        params: { appId: "app-1", status: "active", limit: 10 },
      },
    ]);
    expect(stdout).toHaveBeenCalledTimes(2);
  });

  it("omits absent filters from the params object", async () => {
    const { calls, transport } = makeFakeTransport(() => ({ sessions: [] }));
    await Effect.runPromise(
      appsListHandler({}).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls[0]?.params).toEqual({});
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("boom"));
    const result = await Effect.runPromiseExit(
      appsListHandler({}).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("apps get", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls apps/getSession and prints session as JSON", async () => {
    const SESS_1 = "00000000-0000-4000-8000-000000000501";
    const INITIATOR = "00000000-0000-4000-8000-000000001717";
    const CONV_MAIN = "00000000-0000-4000-8000-000000000c01";
    const sessionObj = {
      id: SESS_1,
      appId: "app-1",
      initiatorAgentId: INITIATOR,
      status: "active",
      conversations: { main: CONV_MAIN },
      createdAt: "2026-05-04T00:00:00.000Z",
    };
    const { calls, transport } = makeFakeTransport(() => ({
      session: sessionObj,
    }));
    await Effect.runPromise(
      appsGetHandler({ sessionId: SESS_1 }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: AppsGetSession.name,
      params: { sessionId: SESS_1 },
    });
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(sessionObj, null, 2));
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("404"));
    const result = await Effect.runPromiseExit(
      appsGetHandler({ sessionId: "s1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("apps close", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  const SESS_42 = "00000000-0000-4000-8000-000000000042";

  it("calls apps/closeSession and prints the closed session id", async () => {
    const { calls, transport } = makeFakeTransport(() => ({ closed: true }));
    await Effect.runPromise(
      appsCloseHandler({ sessionId: SESS_42 }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: AppsCloseSession.name,
      params: { sessionId: SESS_42 },
    });
    expect(stdout).toHaveBeenCalledWith(SESS_42);
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("nope"));
    const result = await Effect.runPromiseExit(
      appsCloseHandler({ sessionId: SESS_42 }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});
