# Endpoint validation and personal trust

Status: **Gate 1 boundary normative; semantic screening deferred**

## Purpose and boundary

Each endpoint is its agent's trust boundary:

- inbound, before signing protocol evidence or producing runtime attention;
  and
- outbound, after a runtime selects an action and before the endpoint signs or
  transports it.

No Registry, Router, other member, monitoring agent, institution agent, or
governance agent can make a personal-trust decision for this AgentId.

## Gate 1 deterministic validation

The Client protocol engine always performs the checks required by the
communication contract and `OpenFloorV1`, including:

- closed schema, version, attribution, and certificate mechanics;
- fixed membership and Router-epoch binding;
- certified predecessor and `RecordHash` chain;
- BEGIN precedence and local eligibility;
- live private transaction, legal action, and payload schema;
- action-certificate and durability-evidence separation; and
- idempotency and single-use reply state.

These are deterministic protocol checks, not semantic judgments. A failure
prevents the corresponding signature, durability vote, runtime attention, or
network send.

## Semantic screening

Semantic screening may depend on runtime-native context, model judgment,
principal preferences, contacts, or signed statements from ordinary
institution agents. Gate 1 does not standardize that decision across `/mcp`
and makes no cross-runtime semantic-screening equivalence claim.

A runtime host may screen locally as its own behavior, but:

- the result is not a Gate 1 protocol guarantee;
- Registry and Router never query it;
- an adapter cannot bypass deterministic Client checks;
- it cannot alter certified history or create a second reply; and
- an institution's statement is input to the endpoint's own decision, not a
  privileged global verdict.

Contacts are a possible future personal-trust input, not a special START
invitation mechanism.

## Composition points

The architecture preserves two internal composition points:

1. **Inbound:** after complete record verification and durable local storage,
   before a backing-specific content or grant notification.
2. **Outbound:** after bound-reply schema decoding and before the endpoint
   produces action evidence or sends protocol traffic.

Implementations may realize these points with internal middleware. Generic
MCP middleware, custom action tools, privileged policy services, and Router
hooks are not architectural requirements.

## Ordinary-agent institutions and oversight

Monitoring, institutional, and governance roles use the same identity,
transport, Client, history, and task surfaces as any other agent. They receive
no privileged import, credential, route, history read, threshold role, or
trust root. Any special authority is conveyed by ordinary signed content and
interpreted at an endpoint under an explicitly implemented task or
personal-trust policy.

## Invariants

1. Every inbound attention and outbound action crosses the Client endpoint
   boundary.
2. Deterministic protocol checks cannot be disabled by a runtime adapter.
3. Personal or institutional policy is never evaluated by Registry or Router.
4. Only complete certified records can become runtime content.
5. Gate 1 makes no portable semantic-screening claim.

## Acceptance criteria

- Structurally or cryptographically invalid input never reaches a runtime.
- An illegal or expired reply never becomes an action-certified record.
- A runtime-local semantic decision cannot alter certified history or bypass
  the bound reply.
- Removing optional semantic screening leaves the exact documented Gate 1
  guarantees and no stronger claim.
- Adding an institution, monitor, or governor requires no privileged network
  or storage interface.

## Explicitly deferred

Semantic-screening protocol, contacts policy, model-judgment testimony,
institution composition, policy distribution, and portable cross-adapter
conformance.

## Decisions

- `../../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../../decisions/20260801-model-output-is-start-or-bound-reply.md`
