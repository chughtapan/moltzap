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
import { agentId, makeEndpointAddress } from "@moltzap/protocol/network";
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

// Durable agent-id form: `tm:agent:<agentId>`. Phase 9 split (per
// `actor-model.ts > ENDPOINT_ADDRESS_KINDS` doc): the `agent` kind is
// reserved for task-manager registration; the resolver routes both
// kinds, but durable addresses live on `tasks.tm_endpoint_address`
// rather than the resolver's reverse index.
const ALICE_DURABLE = makeEndpointAddress("agent", ALICE);

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
  it("produces a tm:agent-conn:<connId> address satisfying the EndpointAddress brand", () => {
    // Phase 9 namespace split (plan §2.4.a + Phase 8 codex deferral on
    // PR #458): the volatile per-WS-connection address lives in the
    // `agent-conn` kind so it cannot collide with the durable
    // `tm:agent:<agentId>` form used for task-manager registration.
    const addr = agentConnectionEndpointAddress(CONN_A);
    expect(String(addr)).toBe(`tm:agent-conn:${CONN_A}`);
  });

  it("rejects a non-UUID connection id at construction", () => {
    expect(() => agentConnectionEndpointAddress("not-a-uuid")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 8 codex-deferral test cases (folded into Phase 9 #427
// acceptance per the issue body's "additional acceptance items"
// section). Each test names exactly one deferral.
// ─────────────────────────────────────────────────────────────────────

describe("AgentEndpointResolver — Phase 8 codex deferrals", () => {
  it("cross-agent add conflict: new add evicts the prior agent's forward entry atomically", () => {
    // Defense-in-depth (deferral 2): if the same address ends up under
    // two agents (UUID collision or programmer error), the new add
    // takes ownership inside the same Ref.update so the forward and
    // reverse views stay invariant. Without this, the prior agent
    // would keep the address in its forward set even though the
    // reverse index points at the new owner — a `network.send` that
    // hit the prior agent's resolveAll would silently route to the
    // wrong connection.
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    Effect.runSync(resolver.add(ALICE, addr, CONN_A));
    Effect.runSync(resolver.add(BOB, addr, CONN_A));

    // BOB owns the address now.
    const bobFan = Effect.runSync(resolver.resolveAll(BOB));
    expect(HashSet.size(bobFan)).toBe(1);
    expect(HashSet.has(bobFan, addr)).toBe(true);

    // ALICE no longer owns it — the eviction inside `add` removed it.
    const aliceFan = Effect.runSync(resolver.resolveAll(ALICE));
    expect(HashSet.size(aliceFan)).toBe(0);

    // Reverse index points at the new owner's connection id.
    expect(Effect.runSync(resolver.connectionForAddress(addr))).toEqual(
      Option.some(CONN_A),
    );
  });

  it("durable tm:agent:<agentId> survives in the resolver alongside volatile tm:agent-conn:<connId>", () => {
    // Deferral 1 (namespace split): the resolver MUST be able to hold
    // both the durable and volatile forms without confusion. A
    // consumer that mints `tm:agent:<agentId>` (TM registration) and
    // `network.send`-routes to it relies on the kinds being distinct
    // — pre-Phase-9, the durable form silently collapsed into the
    // per-connection reverse lookup and `network.send` failed with
    // `RecipientNotResolved`.
    const resolver = makeResolver();
    const volatileAddr = agentConnectionEndpointAddress(CONN_A);
    Effect.runSync(resolver.add(ALICE, volatileAddr, CONN_A));

    // Durable form points at the agent-id, not the connection-id, so
    // the brand predicate accepts it (UUID tail) but the resolver's
    // reverse index does not get a mapping until something registers
    // it explicitly. Verify the two forms are not aliased: looking up
    // the durable form must NOT return the connection bound to the
    // volatile form.
    expect(volatileAddr).not.toBe(ALICE_DURABLE);
    expect(
      Option.isNone(
        Effect.runSync(resolver.connectionForAddress(ALICE_DURABLE)),
      ),
    ).toBe(true);
    expect(Effect.runSync(resolver.connectionForAddress(volatileAddr))).toEqual(
      Option.some(CONN_A),
    );
  });

  it("auth-handler failure after resolver.add: idempotent remove cleans up the entry", () => {
    // Deferral 3 (auth-lifecycle transactional registration): the
    // auth handler now defers `add` to AFTER all fallible setup, so
    // the most-likely failure window is closed by construction. This
    // test pins the disconnect-side guarantee: even if `add` did
    // fire and the handler then failed, the WS scope's onExit
    // finalizer calls `remove`, which is idempotent and leaves the
    // resolver in a consistent state.
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    // Simulate the worst-case ordering: `add` succeeded, the auth
    // handler failed, the disconnect finalizer fires `remove` even
    // though the request was reported as failed.
    Effect.runSync(resolver.add(ALICE, addr, CONN_A));
    Effect.runSync(resolver.remove(ALICE, addr));

    // No leaks in either index.
    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
    expect(
      Option.isNone(Effect.runSync(resolver.connectionForAddress(addr))),
    ).toBe(true);
  });

  it("close-during-auth race: remove without prior add is a clean no-op", () => {
    // Deferral 3 (auth-lifecycle transactional registration): the
    // auth handler may not have called `add` yet when the WS scope
    // closes. The disconnect finalizer cannot tell whether `add`
    // fired, and it does not need to — `remove` on a never-added
    // pair is documented idempotent. This is the worst-case ordering:
    // never-added → finalizer → remove → resolver stays empty.
    const resolver = makeResolver();
    const addr = agentConnectionEndpointAddress(CONN_A);

    // The handler set conn.auth but the connection closed before the
    // resolver.add re-check fired (the explicit `connections.get`
    // pre-check returned undefined). The finalizer still runs remove.
    Effect.runSync(resolver.remove(ALICE, addr));

    expect(HashSet.size(Effect.runSync(resolver.resolveAll(ALICE)))).toBe(0);
    expect(
      Option.isNone(Effect.runSync(resolver.connectionForAddress(addr))),
    ).toBe(true);
  });
});
