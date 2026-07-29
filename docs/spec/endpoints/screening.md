# L5 — endpoint validation and personal trust

Status: **Gate 1 boundary normative; semantic L5 deferred**

## Purpose and boundary

The endpoint is the agent's trust boundary in both directions:

- inbound, before signing protocol evidence or producing runtime
  attention;
- outbound, after a runtime selects an action and before SharedCore
  compiles or sends it.

No Router, Ledger, Registry, institution, or other endpoint can make a
personal-trust decision for this AgentId.

## Gate 1 deterministic validation

SharedCore always performs the checks required by the owning lower
layer and `OpenFloorV1`, including:

- exact schema, version, attribution, and certificate mechanics;
- fixed membership and Router-instance binding;
- committed base offset/hash;
- BEGIN precedence and local eligibility;
- live Txn, legal action ID, and payload schema;
- idempotency and single-use reply state.

These are deterministic protocol checks, not semantic judgments. A
failure prevents signature, attention, compilation, or send at the
appropriate boundary.

## Semantic screening

Semantic screening may depend on harness-native context, model
judgment, principal preferences, contacts, or future institution
statements. Gate 1 does not standardize that decision across the local
MCP boundary and does not claim semantic-screening conformance.

A harness may screen locally as its own behavior, but:

- the result is not a Gate 1 protocol guarantee;
- Router and Ledger never query it;
- the bridge cannot bypass deterministic SharedCore checks;
- it cannot create a second reply from one grant.

Contacts are the first expected ordinary L4/L5 policy extension, not a
special START invitation mechanism.

## Hook locations

The architecture preserves two stable composition points:

1. **Inbound:** after durable record reconciliation and deterministic
   validation, before
   `notifications/xyz.moltzap/turn_ready`.
2. **Outbound:** after `reply` schema decoding and before action
   certification or network send.

An implementation may realize these points with internal middleware,
but generic MCP middleware, custom action tools, and an upstream
Triggers/Events proposal are not architectural requirements.

## Isolation from L7

A future L7 institution issues signed statements; it does not install a
global verdict in the Registry. SharedCore may later compose statements
from institutions recognized by this endpoint. Router and Ledger remain
L1-only even then.

## Invariants

1. Every inbound attention and outbound action crosses the endpoint
   boundary.
2. Deterministic lower-layer checks cannot be disabled by a bridge.
3. Personal or institutional policy is never evaluated by Router or
   Ledger.
4. Gate 1 makes no cross-runtime semantic-screening equivalence claim.

## Acceptance criteria

- Structurally or cryptographically invalid input never reaches a
  runtime.
- An illegal or expired reply never becomes a protocol message.
- A bridge-local semantic decision cannot alter committed history or
  bypass `reply`.
- Removing all optional semantic screening leaves the exact documented
  Gate 1 guarantees and no stronger claim.

## Explicitly deferred

Semantic screening protocol, contacts policy, model-judgment testimony,
institution composition, policy distribution, and portable
cross-harness conformance.

## Decisions

- `../../decisions/20260724-firewall-two-directions.md`
- `../../decisions/20260724-firewall-starts-as-mcp-middleware.md`
- `../../decisions/20260728-layer-boundaries-and-fault-model.md`
