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
    onSessionActive?: unknown;
    onJoin?: unknown;
    onClose?: unknown;
  }
>;

// ─────────────────────────────────────────────────────────────────────
// AppHost hook registration
// ─────────────────────────────────────────────────────────────────────
//
// These tests exercise the in-process hook registration surface directly
// on a bare `AppHost` instance. No DB, no broadcaster side effects — we
// just verify the hooks get stored on the internal Map and that
// duplicate registration overwrites the handler (last-writer-wins, same
// behaviour as onBeforeMessageDelivery / onAppJoin / onSessionClose).

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

describe("AppHost.onSessionActive (registration surface)", () => {
  it("stores the handler keyed by appId", () => {
    const { host } = makeAppHost();
    const handler = () => {};
    host.onSessionActive("my-app", handler);

    const hooks = privateField<HookRegistry>(host, "hooks");
    expect(hooks.get("my-app")?.onSessionActive).toBe(handler);
  });

  it("overwrites a prior handler for the same appId (last-writer-wins)", () => {
    const { host } = makeAppHost();
    const first = () => {};
    const second = () => {};
    host.onSessionActive("app-x", first);
    host.onSessionActive("app-x", second);

    const hooks = privateField<HookRegistry>(host, "hooks");
    expect(hooks.get("app-x")?.onSessionActive).toBe(second);
  });

  it("coexists with onAppJoin and onSessionClose on the same appId", () => {
    const { host } = makeAppHost();
    const active = () => {};
    const join = () => {};
    const close = () => {};

    host.onAppJoin("combo-app", join);
    host.onSessionClose("combo-app", close);
    host.onSessionActive("combo-app", active);

    const hooks = privateField<HookRegistry>(host, "hooks");
    const entry = hooks.get("combo-app")!;
    expect(entry.onSessionActive).toBe(active);
    expect(entry.onJoin).toBe(join);
    expect(entry.onClose).toBe(close);
  });
});
