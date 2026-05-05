import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import type { ConnectionManager } from "../ws/connection.js";
import { makeFakeService } from "../test-utils/fakes.js";
import { AppHost } from "./app-host.js";

function privateField<T>(target: object, key: string): T {
  return Reflect.get(target, key) as T;
}

type HookRegistry = Map<
  string,
  {
    taskAuthorizeDispatch?: unknown;
  }
>;

// ─────────────────────────────────────────────────────────────────────
// AppHost hook registration
// ─────────────────────────────────────────────────────────────────────
//
// Phase 9b consumer-migration (sub-issue #460): the lifecycle hooks
// (`onSessionActive`, `onSessionClose`) and the receive-side gate hook
// (`onBeforeMessageDelivery`) retired with the wire RPC deletions; only
// `task/authorizeDispatch` remains. These tests exercise the in-process
// hook registration surface directly on a bare `AppHost` instance.

function makeAppHost(): {
  host: AppHost;
  sent: Array<{ agentId: string; event: unknown }>;
} {
  const sent: Array<{ agentId: string; event: unknown }> = [];
  const broadcaster = makeFakeService<Broadcaster>({
    sendToAgent: (agentId: string, event: unknown) => {
      sent.push({ agentId, event });
    },
  } as Partial<Broadcaster>);
  const connections = makeFakeService<ConnectionManager>(
    {} as Partial<ConnectionManager>,
  );
  // No DB methods are exercised by pure registration tests.
  const db = makeFakeService<Kysely<Database>>({} as Partial<Kysely<Database>>);

  const host = new AppHost(db, broadcaster, connections, null);
  return { host, sent };
}

describe("AppHost.onTaskAuthorizeDispatch (registration surface)", () => {
  it("stores the handler keyed by appId", () => {
    const { host } = makeAppHost();
    const handler = () => ({ decision: "grant" as const });
    host.onTaskAuthorizeDispatch("my-app", handler);

    const hooks = privateField<HookRegistry>(host, "hooks");
    expect(hooks.get("my-app")?.taskAuthorizeDispatch).toBe(handler);
  });

  it("overwrites a prior handler for the same appId (last-writer-wins)", () => {
    const { host } = makeAppHost();
    const first = () => ({ decision: "grant" as const });
    const second = () => ({ decision: "deny" as const });
    host.onTaskAuthorizeDispatch("app-x", first);
    host.onTaskAuthorizeDispatch("app-x", second);

    const hooks = privateField<HookRegistry>(host, "hooks");
    expect(hooks.get("app-x")?.taskAuthorizeDispatch).toBe(second);
  });
});
