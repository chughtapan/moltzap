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
  AppsInputError,
  appsAttestSkillHandler,
  appsCloseHandler,
  appsCreateHandler,
  appsGetHandler,
  appsListHandler,
  appsRegisterHandler,
} from "./apps.js";
import {
  Transport,
  TransportRpcError,
  type Transport as TransportSurface,
  type TransportError,
} from "../transport.js";

type Call = { method: string; params: Record<string, unknown> };

const makeFakeTransport = (
  respond: (call: Call) => unknown | Error,
): { calls: Array<Call>; transport: TransportSurface } => {
  const calls: Array<Call> = [];
  const transport: TransportSurface = {
    kind: "test",
    rpc: <Result>(
      method: string,
      params: Record<string, unknown>,
    ): Effect.Effect<Result, TransportError> => {
      calls.push({ method, params });
      const out = respond({ method, params });
      if (out instanceof Error) {
        return Effect.fail(
          new TransportRpcError({
            method,
            code: -32000,
            message: out.message,
          }),
        );
      }
      return Effect.succeed(out as Result);
    },
  };
  return { calls, transport };
};

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
    writeFileSync(manifestPath, JSON.stringify({ name: "demo-app" }));
    const { calls, transport } = makeFakeTransport(() => ({
      appId: "app-xyz",
    }));
    await Effect.runPromise(
      appsRegisterHandler({ manifestPath }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls).toEqual([
      { method: "apps/register", params: { manifest: { name: "demo-app" } } },
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
    const { calls, transport } = makeFakeTransport(() => ({
      session: { id: "sess-1" },
    }));
    await Effect.runPromise(
      appsCreateHandler({
        appId: "app-1",
        invitedAgentIds: ["agent-a", "agent-b"],
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls).toEqual([
      {
        method: "apps/create",
        params: { appId: "app-1", invitedAgentIds: ["agent-a", "agent-b"] },
      },
    ]);
    expect(stdout).toHaveBeenCalledWith("sess-1");
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
    const { calls, transport } = makeFakeTransport(() => ({
      sessions: [
        { id: "s1", appId: "app-1", status: "active" },
        { id: "s2", appId: "app-1", status: "closed" },
      ],
    }));
    await Effect.runPromise(
      appsListHandler({ appId: "app-1", status: "active", limit: 10 }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls).toEqual([
      {
        method: "apps/listSessions",
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
    const sessionObj = { id: "s1", appId: "app-1", status: "active" };
    const { calls, transport } = makeFakeTransport(() => ({
      session: sessionObj,
    }));
    await Effect.runPromise(
      appsGetHandler({ sessionId: "s1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: "apps/getSession",
      params: { sessionId: "s1" },
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

  it("calls apps/closeSession and prints the closed session id", async () => {
    const { calls, transport } = makeFakeTransport(() => ({ closed: true }));
    await Effect.runPromise(
      appsCloseHandler({ sessionId: "s-42" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: "apps/closeSession",
      params: { sessionId: "s-42" },
    });
    expect(stdout).toHaveBeenCalledWith("s-42");
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("nope"));
    const result = await Effect.runPromiseExit(
      appsCloseHandler({ sessionId: "s-42" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("apps attest-skill", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls apps/attestSkill with challengeId, skillUrl, version and emits no stdout", async () => {
    const { calls, transport } = makeFakeTransport(() => ({}));
    await Effect.runPromise(
      appsAttestSkillHandler({
        challengeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        skillUrl: "https://example.com/skills/my-skill",
        version: "1.0.0",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls).toEqual([
      {
        method: "apps/attestSkill",
        params: {
          challengeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          skillUrl: "https://example.com/skills/my-skill",
          version: "1.0.0",
        },
      },
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("surfaces TransportRpcError on RPC failure", async () => {
    const { transport } = makeFakeTransport(
      () => new Error("attestation rejected"),
    );
    const result = await Effect.runPromiseExit(
      appsAttestSkillHandler({
        challengeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        skillUrl: "https://example.com/skills/my-skill",
        version: "1.0.0",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });
});
