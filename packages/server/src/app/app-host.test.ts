import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
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

function makeAppHost(): { host: AppHost } {
  const connections = makeFakeService<ConnectionManager>(
    {} as Partial<ConnectionManager>,
  );
  // No DB methods are exercised by pure registration tests.
  const db = makeFakeService<Kysely<Database>>({} as Partial<Kysely<Database>>);
  const host = new AppHost(db, connections, null);
  return { host };
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
