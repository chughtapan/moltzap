/* eslint-disable agent-code-guard/no-example-only-tests -- the RPC catalog is a fixed finite set, not an input domain; cardinality, disjointness, and membership are invariants over the whole universe (no value to generate). A `fast-check` property would have to enumerate the same const arrays the assertions already read. */
import { describe, expect, it } from "vitest";
import {
  appCallableTaskRpcMethods,
  agentCallableTaskRpcMethods,
} from "./task/methods.js";
import {
  agentClientRpcMethods,
  appCallableRpcMethods,
} from "./rpc-registry.js";

/**
 * Outbound-catalog partition invariant (Spec D3 #600 R11, carried over
 * from the deleted `task-d3-cutover.types-check.ts`). `appCallable` is the
 * union of `agentClient` and the app-only task RPCs:
 *
 *   appCallableRpcMethods = agentClientRpcMethods ∪ appCallableTaskRpcMethods
 *
 * The two source arrays are disjoint by NAME (no method is callable as
 * both an open agent RPC and an app-only one). This is a runtime check
 * over the const catalog arrays rather than a type canary: the old
 * `AssertEquals` aliases never used an `extends true` constraint, so they
 * pinned nothing. Every assertion resolved to a `true | false` type the
 * closed union swallowed without failing compilation. A runtime `expect`
 * cannot be vacuous: a partition regression throws.
 */
const methodNames = (defs: ReadonlyArray<{ readonly name: string }>) =>
  defs.map((d) => d.name);

describe("outbound RPC catalog partition", () => {
  const agentNames = methodNames(agentClientRpcMethods);
  const appOnlyTaskNames = methodNames(appCallableTaskRpcMethods);
  const appCallableNames = methodNames(appCallableRpcMethods);

  it("appCallable cardinality equals agentClient + appCallableTask", () => {
    expect(appCallableRpcMethods.length).toBe(
      agentClientRpcMethods.length + appCallableTaskRpcMethods.length,
    );
  });

  it("agentClient and appCallableTask are disjoint by name", () => {
    const agentSet = new Set(agentNames);
    const overlap = appOnlyTaskNames.filter((name) => agentSet.has(name));
    expect(overlap).toEqual([]);
  });

  it("appCallable membership is exactly agentClient ∪ appCallableTask", () => {
    const expected = new Set([...agentNames, ...appOnlyTaskNames]);
    expect(new Set(appCallableNames)).toEqual(expected);
  });

  it("the agentCallableTask subset is contained in agentClient", () => {
    const agentSet = new Set(agentNames);
    for (const def of agentCallableTaskRpcMethods) {
      expect(agentSet.has(def.name)).toBe(true);
    }
  });

  it("no method name is duplicated within appCallable", () => {
    expect(appCallableNames.length).toBe(new Set(appCallableNames).size);
  });
});
