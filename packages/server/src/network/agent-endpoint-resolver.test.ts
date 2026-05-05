/**
 * Unit tests for {@link AgentEndpointResolver}.
 *
 * Each test covers exactly one behavior named in plan §2.11 or issue #426
 * acceptance: multimap semantics, atomic add/remove, idempotence, fan-out
 * snapshot, reverse-index lookup. Tests run synchronously via
 * `Effect.runSync` because the resolver is a pure in-memory `Ref`.
 */
import { describe, expect, it } from "vitest";
import { Effect, HashSet, Option } from "effect";
import { agentId } from "@moltzap/protocol/network";
import {
  AgentEndpointResolver,
  agentConnectionEndpointAddress,
} from "./agent-endpoint-resolver.js";

// Test agent ids — UUIDs that pass the `agentId` brand predicate.
const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const BOB = agentId("00000000-0000-4000-8000-00000000b0b0");

// Test connection ids — UUIDs so the derived address satisfies the
// EndpointAddress brand predicate (`tm:<kind>:<uuid>`).
const CONN_A = "00000000-0000-4000-8000-00000000c001";
const CONN_B = "00000000-0000-4000-8000-00000000c002";
const CONN_C = "00000000-0000-4000-8000-00000000c003";

const makeResolver = (): AgentEndpointResolver =>
  Effect.runSync(AgentEndpointResolver.make);

describe("AgentEndpointResolver", () => {
  it("starts empty: resolveAll returns the empty set for any agent", () => {
    const resolver = makeResolver();
    const set = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(set)).toBe(0);
  });

  it("starts empty: connectionForAddress returns Option.none()", () => {
    const resolver = makeResolver();
    const out = Effect.runSync(
      resolver.connectionForAddress(agentConnectionEndpointAddress(CONN_A)),
    );
    expect(Option.isNone(out)).toBe(true);
  });

  it("add: a single (agent, address, conn) tuple is queryable both ways", () => {
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    Effect.runSync(resolver.add(ALICE, addr, CONN_A));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(1);
    expect(HashSet.has(fan, addr)).toBe(true);

    const conn = Effect.runSync(resolver.connectionForAddress(addr));
    expect(conn).toEqual(Option.some(CONN_A));
  });

  it("add: multimap holds multiple connections for the same agent", () => {
    const resolver = makeResolver();
    const addrA = agentConnectionEndpointAddress(CONN_A);
    const addrB = agentConnectionEndpointAddress(CONN_B);

    Effect.runSync(resolver.add(ALICE, addrA, CONN_A));
    Effect.runSync(resolver.add(ALICE, addrB, CONN_B));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(2);
    expect(HashSet.has(fan, addrA)).toBe(true);
    expect(HashSet.has(fan, addrB)).toBe(true);

    expect(Effect.runSync(resolver.connectionForAddress(addrA))).toEqual(
      Option.some(CONN_A),
    );
    expect(Effect.runSync(resolver.connectionForAddress(addrB))).toEqual(
      Option.some(CONN_B),
    );
  });

  it("add: same address twice is idempotent on the forward set", () => {
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    Effect.runSync(resolver.add(ALICE, addr, CONN_A));
    Effect.runSync(resolver.add(ALICE, addr, CONN_A));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(1);
  });

  it("add: distinct agents do not see each other's entries", () => {
    const resolver = makeResolver();
    const addrA = agentConnectionEndpointAddress(CONN_A);
    const addrB = agentConnectionEndpointAddress(CONN_B);

    Effect.runSync(resolver.add(ALICE, addrA, CONN_A));
    Effect.runSync(resolver.add(BOB, addrB, CONN_B));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(1);
    expect(HashSet.size(Effect.runSync(resolver.resolveAll(BOB)))).toBe(1);
  });

  it("remove: drops the entry from both indices", () => {
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    Effect.runSync(resolver.add(ALICE, addr, CONN_A));
    Effect.runSync(resolver.remove(ALICE, addr));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
    expect(
      Option.isNone(Effect.runSync(resolver.connectionForAddress(addr))),
    ).toBe(true);
  });

  it("remove: leaves sibling entries intact for the same agent", () => {
    const resolver = makeResolver();
    const addrA = agentConnectionEndpointAddress(CONN_A);
    const addrB = agentConnectionEndpointAddress(CONN_B);

    Effect.runSync(resolver.add(ALICE, addrA, CONN_A));
    Effect.runSync(resolver.add(ALICE, addrB, CONN_B));
    Effect.runSync(resolver.remove(ALICE, addrA));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(1);
    expect(HashSet.has(fan, addrB)).toBe(true);
    expect(Effect.runSync(resolver.connectionForAddress(addrB))).toEqual(
      Option.some(CONN_B),
    );
  });

  it("remove: dropping the last entry clears the agent key entirely", () => {
    // Emptying the bucket should not leave a phantom key behind that would
    // make `resolveAll` produce an empty `HashSet` in a way that surprises
    // a caller doing `HashSet.size === 0` checks.
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    Effect.runSync(resolver.add(ALICE, addr, CONN_A));
    Effect.runSync(resolver.remove(ALICE, addr));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(0);
  });

  it("remove: mis-targeted remove cannot evict a sibling's reverse entry", () => {
    // Regression guard for the resolver-tear bug: BOB owns `addr`, but a
    // mis-targeted `remove(ALICE, addr)` (programmer error or a re-issued
    // lifecycle hook on the wrong agent id) must not silently drop
    // `byAddress[addr]`. Otherwise a subsequent `network.send(addr)` would
    // see an inconsistent state — `resolveAll(BOB)` still returns `addr`
    // but `connectionForAddress(addr)` is gone.
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    Effect.runSync(resolver.add(BOB, addr, CONN_A));
    Effect.runSync(resolver.remove(ALICE, addr));

    const fan = Effect.runSync(resolver.resolveAll(BOB));
    expect(HashSet.size(fan)).toBe(1);
    expect(HashSet.has(fan, addr)).toBe(true);
    expect(Effect.runSync(resolver.connectionForAddress(addr))).toEqual(
      Option.some(CONN_A),
    );
  });

  it("remove: idempotent on never-added pairs (defensive disconnect path)", () => {
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    // No prior add; mirrors a never-authed disconnect that still calls
    // remove. Resolver state must stay consistent.
    Effect.runSync(resolver.remove(ALICE, addr));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
    expect(
      Option.isNone(Effect.runSync(resolver.connectionForAddress(addr))),
    ).toBe(true);
  });

  it("connectionForAddress: each address resolves to its own connection id", () => {
    // Reverse-index correctness: a single agent with multiple connections
    // must produce distinct lookups. Regression guard for "same agent
    // overwrites the reverse index" bug.
    const resolver = makeResolver();
    const addrA = agentConnectionEndpointAddress(CONN_A);
    const addrB = agentConnectionEndpointAddress(CONN_B);
    const addrC = agentConnectionEndpointAddress(CONN_C);

    Effect.runSync(resolver.add(ALICE, addrA, CONN_A));
    Effect.runSync(resolver.add(ALICE, addrB, CONN_B));
    Effect.runSync(resolver.add(BOB, addrC, CONN_C));

    expect(Effect.runSync(resolver.connectionForAddress(addrA))).toEqual(
      Option.some(CONN_A),
    );
    expect(Effect.runSync(resolver.connectionForAddress(addrB))).toEqual(
      Option.some(CONN_B),
    );
    expect(Effect.runSync(resolver.connectionForAddress(addrC))).toEqual(
      Option.some(CONN_C),
    );
  });
});

describe("agentConnectionEndpointAddress", () => {
  it("produces a tm:agent:<connId> address satisfying the EndpointAddress brand", () => {
    const addr = agentConnectionEndpointAddress(CONN_A);
    expect(String(addr)).toBe(`tm:agent:${CONN_A}`);
  });

  it("rejects a non-UUID connection id at construction", () => {
    expect(() => agentConnectionEndpointAddress("not-a-uuid")).toThrow();
  });
});
