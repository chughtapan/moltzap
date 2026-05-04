/**
 * Unit tests for `moltzap permissions <subcommand>` handlers. Spec
 * test-coverage floor: one success + one RPC-failure per handler.
 */
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
  permissionsGrantHandler,
  permissionsListHandler,
  permissionsRevokeHandler,
} from "./permissions.js";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";

import {
  PermissionsGrant,
  PermissionsList,
  PermissionsRevoke,
} from "@moltzap/protocol";

describe("permissions grant", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls permissions/grant with { sessionId, agentId, resource, access[] }", async () => {
    const { calls, transport } = makeFakeTransport(() => ({}));
    await Effect.runPromise(
      permissionsGrantHandler({
        sessionId: "sess-1",
        agentId: "agent-a",
        resource: "res-1",
        access: ["read", "write"],
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls).toEqual([
      {
        method: PermissionsGrant.name,
        params: {
          sessionId: "sess-1",
          agentId: "agent-a",
          resource: "res-1",
          access: ["read", "write"],
        },
      },
    ]);
  });

  it("rejects empty access with PermissionsInputError", async () => {
    const { transport } = makeFakeTransport(() => ({}));
    const result = await Effect.runPromiseExit(
      permissionsGrantHandler({
        sessionId: "s",
        agentId: "a",
        resource: "r",
        access: [],
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("denied"));
    const result = await Effect.runPromiseExit(
      permissionsGrantHandler({
        sessionId: "s",
        agentId: "a",
        resource: "r",
        access: ["read"],
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("permissions list", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls permissions/list with optional appId filter and prints one grant per line", async () => {
    const { calls, transport } = makeFakeTransport(() => ({
      grants: [
        {
          appId: "app-1",
          resource: "r1",
          access: ["read"],
          grantedAt: "2026-01-01T00:00:00Z",
        },
      ],
    }));
    await Effect.runPromise(
      permissionsListHandler({ appId: "app-1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: PermissionsList.name,
      params: { appId: "app-1" },
    });
    expect(stdout).toHaveBeenCalledTimes(1);
  });

  it("omits appId when absent", async () => {
    const { calls, transport } = makeFakeTransport(() => ({ grants: [] }));
    await Effect.runPromise(
      permissionsListHandler({}).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]?.params).toEqual({});
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      permissionsListHandler({}).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("permissions revoke", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls permissions/revoke with { appId, resource }", async () => {
    const { calls, transport } = makeFakeTransport(() => ({}));
    await Effect.runPromise(
      permissionsRevokeHandler({ appId: "app-1", resource: "r1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: PermissionsRevoke.name,
      params: { appId: "app-1", resource: "r1" },
    });
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      permissionsRevokeHandler({ appId: "a", resource: "r" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});
