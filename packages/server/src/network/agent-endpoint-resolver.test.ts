/**
 * Unit tests for {@link AgentEndpointResolver}.
 *
 * Each test covers one resolver behavior: multimap semantics, atomic
 * add/remove, idempotence, and fan-out snapshots. Tests run synchronously via
 * `Effect.runSync` because the resolver is a pure in-memory `Ref`.
 */
import { describe, expect, it } from "vitest";
import { Effect, HashSet } from "effect";
import { agentId } from "@moltzap/protocol/testing";
import {
  AgentEndpointResolver,
  connectionId,
} from "./agent-endpoint-resolver.js";

// Test agent ids — UUIDs that pass the `agentId` brand predicate.
const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const BOB = agentId("00000000-0000-4000-8000-00000000b0b0");

// Test connection ids. The resolver does not enforce UUID shape on connection
// Socket sessions mint connection ids via `crypto.randomUUID()`.
const CONN_A = connectionId("00000000-0000-4000-8000-00000000c001");
const CONN_B = connectionId("00000000-0000-4000-8000-00000000c002");
const CONN_C = connectionId("00000000-0000-4000-8000-00000000c003");

const makeResolver = (): AgentEndpointResolver =>
  Effect.runSync(AgentEndpointResolver.make);

describe("AgentEndpointResolver — initial add", () => {
  it("starts empty: resolveAll returns the empty set for any agent", () => {
    const resolver = makeResolver();
    const set = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(set)).toBe(0);
  });

  it("add: a single (agent, connId) pair appears in the agent's resolveAll set", () => {
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(1);
    expect(HashSet.has(fan, CONN_A)).toBe(true);
  });

  it("add: multimap holds multiple connections for the same agent", () => {
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.add(ALICE, CONN_B));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(2);
    expect(HashSet.has(fan, CONN_A)).toBe(true);
    expect(HashSet.has(fan, CONN_B)).toBe(true);
  });
});

describe("AgentEndpointResolver — add isolation", () => {
  it("add: same connection twice is idempotent on the forward set", () => {
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.add(ALICE, CONN_A));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(1);
  });

  it("add: distinct agents do not see each other's entries", () => {
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.add(BOB, CONN_B));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(1);
    expect(HashSet.size(Effect.runSync(resolver.resolveAll(BOB)))).toBe(1);
  });
});

describe("AgentEndpointResolver — remove basics", () => {
  it("remove: drops the entry from the agent's set", () => {
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.remove(ALICE, CONN_A));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
  });

  it("remove: leaves sibling entries intact for the same agent", () => {
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.add(ALICE, CONN_B));
    Effect.runSync(resolver.remove(ALICE, CONN_A));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(1);
    expect(HashSet.has(fan, CONN_B)).toBe(true);
  });

  it("remove: dropping the last entry clears the agent key entirely", () => {
    // Emptying the bucket should not leave a phantom key behind that would
    // make `resolveAll` produce an empty `HashSet` in a way that surprises
    // a caller doing `HashSet.size === 0` checks.
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.remove(ALICE, CONN_A));

    const fan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(fan)).toBe(0);
  });
});

describe("AgentEndpointResolver — remove edge cases", () => {
  it("remove: mis-targeted remove cannot evict a sibling's reverse entry", () => {
    // Regression guard for the resolver-tear bug: BOB owns `CONN_A`, but a
    // mis-targeted `remove(ALICE, CONN_A)` (programmer error or a re-issued
    // lifecycle hook on the wrong agent id) must not silently drop the
    // reverse entry. Otherwise a subsequent `network.send` that resolves
    // BOB would observe an inconsistent state — `resolveAll(BOB)` still
    // returns `CONN_A` but BOB's reverse entry was destroyed.
    const resolver = makeResolver();

    Effect.runSync(resolver.add(BOB, CONN_A));
    Effect.runSync(resolver.remove(ALICE, CONN_A));

    const fan = Effect.runSync(resolver.resolveAll(BOB));
    expect(HashSet.size(fan)).toBe(1);
    expect(HashSet.has(fan, CONN_A)).toBe(true);
  });

  it("remove: idempotent on never-added pairs (defensive disconnect path)", () => {
    const resolver = makeResolver();

    // No prior add; mirrors a never-authed disconnect that still calls
    // remove. Resolver state must stay consistent.
    Effect.runSync(resolver.remove(ALICE, CONN_A));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
  });
});

describe("AgentEndpointResolver — multi-connection", () => {
  it("multi-connection per agent: each connection is independently tracked", () => {
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.add(ALICE, CONN_B));
    Effect.runSync(resolver.add(BOB, CONN_C));

    const aliceFan = Effect.runSync(resolver.resolveAll(ALICE));
    const bobFan = Effect.runSync(resolver.resolveAll(BOB));
    expect(HashSet.size(aliceFan)).toBe(2);
    expect(HashSet.size(bobFan)).toBe(1);
  });
});

describe("AgentEndpointResolver — ownership invariants", () => {
  it("cross-agent add conflict: new add evicts the prior agent's forward entry atomically", () => {
    // Defense-in-depth (deferral 2): if the same connection ends up under
    // two agents (UUID collision or programmer error), the new add takes
    // ownership inside the same Ref.update so the forward and reverse
    // views stay invariant. Without this, the prior agent would keep the
    // connection in its forward set even though the reverse index
    // points at the new owner — a `network.send` that hit the prior
    // agent's resolveAll would silently route to the wrong connection.
    const resolver = makeResolver();

    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.add(BOB, CONN_A));

    // BOB owns the connection now.
    const bobFan = Effect.runSync(resolver.resolveAll(BOB));
    expect(HashSet.size(bobFan)).toBe(1);
    expect(HashSet.has(bobFan, CONN_A)).toBe(true);

    // The eviction inside `add` removes Alice's forward entry.
    const aliceFan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(aliceFan)).toBe(0);
  });

  it("add+remove sequence is symmetric", () => {
    // Resolver-contract guard: pins the disconnect-side guarantee the
    // auth handler's transactional flow relies on. Even if `add`
    // succeeded and the handler then failed, the WS scope's onExit
    // finalizer calls `remove`, which is idempotent and leaves the
    // resolver in a consistent state.
    const resolver = makeResolver();

    // Simulate the worst-case ordering: `add` succeeded, the auth
    // handler failed, the disconnect finalizer fires `remove` even
    // though the request was reported as failed.
    Effect.runSync(resolver.add(ALICE, CONN_A));
    Effect.runSync(resolver.remove(ALICE, CONN_A));

    // No leaks in the forward index.
    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
  });

  it("idempotent remove on never-added pairs", () => {
    // Resolver-contract guard: the auth handler's transactional flow
    // skips `add` when `connections.get(connId)` returns undefined at
    // re-check time (close-during-auth). The WS scope's onExit
    // finalizer cannot tell whether `add` fired, and it does not need
    // to — `remove` on a never-added pair is documented idempotent.
    const resolver = makeResolver();

    // The handler set conn.auth but the connection closed before the
    // resolver.add re-check fired (the explicit `connections.get`
    // pre-check returned undefined). The finalizer still runs remove.
    Effect.runSync(resolver.remove(ALICE, CONN_A));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
  });
});
