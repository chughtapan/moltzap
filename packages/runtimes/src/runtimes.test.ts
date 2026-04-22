import { describe, it, expect } from "vitest";
import { Effect } from "effect";

import {
  OpenClawAdapter,
  type OpenClawAdapterDeps,
} from "./openclaw-adapter.js";
import {
  NanoclawAdapter,
  type NanoclawAdapterDeps,
} from "./nanoclaw-adapter.js";
import type {
  Runtime,
  RuntimeServerHandle,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed } from "./errors.js";

// Minimal stub for the live server surface the adapters poll for readiness.
function stubServer(): RuntimeServerHandle {
  return {
    connections: {
      getByAgent: (_agentId: string) => [],
    },
  };
}

function stubDeps(): OpenClawAdapterDeps {
  return {
    server: stubServer(),
    openclawBin: "/bin/false",
    channelDistDir: "/nonexistent/channel",
    repoRoot: "/nonexistent/repo",
  };
}

function brand<T extends string>(
  value: string,
  _tag: T,
): string & { readonly __brand: T } {
  return value as string & { readonly __brand: T };
}

function stubSpawnInput(overrides?: Partial<SpawnInput>): SpawnInput {
  return {
    agentName: brand("test-agent", "AgentName"),
    apiKey: brand("test-api-key", "ApiKey"),
    agentId: "agent-001",
    serverUrl: brand("ws://localhost:9999/ws", "ServerUrl"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Runtime interface contract
// ---------------------------------------------------------------------------

describe("Runtime interface", () => {
  it("OpenClawAdapter satisfies the Runtime interface (structural typing)", () => {
    const adapter: Runtime = new OpenClawAdapter(stubDeps());

    expect(typeof adapter.spawn).toBe("function");
    expect(typeof adapter.waitUntilReady).toBe("function");
    expect(typeof adapter.teardown).toBe("function");
    expect(typeof adapter.getLogs).toBe("function");
    expect(typeof adapter.getInboundMarker).toBe("function");
  });

  it("exposes exactly the five Runtime interface methods publicly", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const runtimeMethods = [
      "spawn",
      "waitUntilReady",
      "teardown",
      "getLogs",
      "getInboundMarker",
    ] as const;
    for (const m of runtimeMethods) {
      // #ignore-sloppy-code-next-line[as-unknown-as]: dynamic method-name lookup in exhaustiveness check — no other way to index by string
      expect(typeof (adapter as unknown as Record<string, unknown>)[m]).toBe(
        "function",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — spawn
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.spawn", () => {
  it("fails with SpawnFailed when bin does not exist", async () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const result = await Effect.runPromise(
      Effect.either(adapter.spawn(stubSpawnInput())),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("SpawnFailed");
      expect(result.left.agentName).toBe("test-agent");
      expect(result.left.cause).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — getLogs / getInboundMarker (no spawn)
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.getLogs", () => {
  it("returns empty slice when no process has been spawned", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const slice: LogSlice = adapter.getLogs(0);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });

  it("returns empty slice for non-zero offset when no process has been spawned", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const slice: LogSlice = adapter.getLogs(100);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });
});

describe("OpenClawAdapter.getInboundMarker", () => {
  it("returns a non-empty string", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const marker = adapter.getInboundMarker();
    expect(typeof marker).toBe("string");
    expect(marker.length).toBeGreaterThan(0);
  });

  it("returns the expected openclaw-channel inbound log prefix", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    expect(adapter.getInboundMarker()).toBe("inbound from agent:");
  });
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — teardown (idempotent, no spawn)
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.teardown", () => {
  it("completes without error when no process has been spawned", async () => {
    const adapter = new OpenClawAdapter(stubDeps());
    await Effect.runPromise(adapter.teardown());
  });

  it("is idempotent — calling twice has same effect as once", async () => {
    const adapter = new OpenClawAdapter(stubDeps());
    await Effect.runPromise(adapter.teardown());
    await Effect.runPromise(adapter.teardown());
  });
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — waitUntilReady (no spawn)
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.waitUntilReady", () => {
  it("returns Ready when no process has been spawned", async () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const outcome: ReadyOutcome = await Effect.runPromise(
      adapter.waitUntilReady(1000),
    );
    expect(outcome._tag).toBe("Ready");
  });
});

// ---------------------------------------------------------------------------
// ReadyOutcome discriminated union exhaustiveness
// ---------------------------------------------------------------------------

describe("ReadyOutcome", () => {
  it("all variants are distinguishable by _tag", () => {
    const outcomes: ReadyOutcome[] = [
      { _tag: "Ready" },
      { _tag: "Timeout", timeoutMs: 60000 },
      { _tag: "ProcessExited", exitCode: 1, stderr: "err" },
    ];

    const tags = outcomes.map((o) => o._tag);
    expect(tags).toEqual(["Ready", "Timeout", "ProcessExited"]);
  });

  it("switch over ReadyOutcome is exhaustive with absurd", () => {
    function matchOutcome(o: ReadyOutcome): string {
      switch (o._tag) {
        case "Ready":
          return "ready";
        case "Timeout":
          return `timeout:${o.timeoutMs}`;
        case "ProcessExited":
          return `exit:${o.exitCode}`;
        default:
          return absurd(o);
      }
    }

    expect(matchOutcome({ _tag: "Ready" })).toBe("ready");
    expect(matchOutcome({ _tag: "Timeout", timeoutMs: 5000 })).toBe(
      "timeout:5000",
    );
    expect(
      matchOutcome({ _tag: "ProcessExited", exitCode: null, stderr: "" }),
    ).toBe("exit:null");
  });
});

// ---------------------------------------------------------------------------
// Branded types — compile-time contract verification
// ---------------------------------------------------------------------------

describe("branded types", () => {
  it("AgentName brand compiles and round-trips", () => {
    const name = brand("alice", "AgentName");
    expect(name).toBe("alice");
  });

  it("ApiKey brand compiles and round-trips", () => {
    const key = brand("sk-abc", "ApiKey");
    expect(key).toBe("sk-abc");
  });

  it("ServerUrl brand compiles and round-trips", () => {
    const url = brand("ws://localhost:9999/ws", "ServerUrl");
    expect(url).toBe("ws://localhost:9999/ws");
  });
});

// ---------------------------------------------------------------------------
// SpawnFailed error tag
// ---------------------------------------------------------------------------

describe("SpawnFailed", () => {
  it("carries agentName and cause", () => {
    const cause = new Error("ENOENT");
    const err = new SpawnFailed("alice", cause);
    expect(err._tag).toBe("SpawnFailed");
    expect(err.agentName).toBe("alice");
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// NanoclawAdapter — interface contract
// ---------------------------------------------------------------------------

function stubNanoclawDeps(): NanoclawAdapterDeps {
  return { server: stubServer() };
}

describe("NanoclawAdapter", () => {
  it("satisfies the Runtime interface (structural typing)", () => {
    const adapter: Runtime = new NanoclawAdapter(stubNanoclawDeps());

    expect(typeof adapter.spawn).toBe("function");
    expect(typeof adapter.waitUntilReady).toBe("function");
    expect(typeof adapter.teardown).toBe("function");
    expect(typeof adapter.getLogs).toBe("function");
    expect(typeof adapter.getInboundMarker).toBe("function");
  });

  it("getLogs returns empty slice when not spawned", () => {
    const adapter = new NanoclawAdapter(stubNanoclawDeps());
    const slice: LogSlice = adapter.getLogs(0);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });

  it("getInboundMarker returns non-empty string", () => {
    const adapter = new NanoclawAdapter(stubNanoclawDeps());
    const marker = adapter.getInboundMarker();
    expect(typeof marker).toBe("string");
    expect(marker.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
