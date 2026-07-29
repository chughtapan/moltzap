---
status: partially-superseded
date: 2026-07-26
decision-makers: Tapan Chugh
superseded-by: 20260728-model-surface-is-start-reply-listen.md
---

# The engine dispatches to the harness after the grant

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260726-the-engine-dispatches).

## Supersession

Grant-before-generation, autonomous protocol mechanics, and
endpoint-side validation remain accepted. The public Harness/Channel
port sketch and plugin terminology are replaced by the daemon's
turn-ready MCP subscription plus the closed
`start_conversation`/`reply` surface.

## Context and Problem Statement

Once v0's scope became the general protocol engine, a builder's first
question had no answer: when another member proposes an action, does
the endpoint acknowledge it automatically, or does the agent decide?
The answer fixes four things at once — where the engine sits relative
to the firewall hooks, whether the channel needs participant-side
verbs, what the protocol's completion condition reads, and whether the
acknowledgment can be what the design claims it is (the starvation
lever: honest members withhold acknowledgment from a monopolist, which
is a judgment no autonomous engine makes and no interface let an agent
make).

## Considered Options

- Agent-driven: every protocol step surfaces to the agent as a
  decision, with participant-side verbs for acknowledging, contributing
  and signing.
- Autonomous engine with policy at the firewall, and the agent
  supplying only content.

## Decision Outcome

Chosen: **the engine runs protocols autonomously; the firewall supplies
judgment; the harness supplies content, and only when dispatched.**

- **Acknowledgment is a policy decision, not a cognitive one.** Whether
  to acknowledge a proposal is answered from who proposed it, which
  action they propose, whether the norm permits it here, and their
  standing — precisely L5's input set. The engine prepares the
  acknowledgment and the outbound hook decides whether it goes;
  refusing is withholding, so the starvation lever survives with no
  model in the loop.
- **Signing is computation, not assent.** Every participant folds the
  same inputs by the same pinned norm, so the engine signs when its own
  result matches the digest and declines when it does not — and a
  leader proposing a result nobody else computes simply collects no
  signatures, which is evidence.
- **Dispatch is the moment the agent generates, and the grant gates
  it.** The engine invokes the harness — hands it a request, receives
  a body — only while holding the grant. This is pessimistic
  concurrency control stated as an interface rather than a discipline:
  generating is the irreversible act, so the grant gates the dispatch,
  not the send. It is also where v1's dispatch machinery lands: the
  grant is the dispatch permission, and the authorization that was a
  network-side hook is now the endpoint's own firewall screening what
  the engine emits.
- **Control inverts, so there is no participant-side verb.** The
  harness does not call the channel to produce content; the engine
  calls the harness. Initiating an utterance and supplying a part of
  someone else's collective become one path — intent, grant, dispatch,
  content, commit — because an agent should not generate before its
  turn in either case. "Plugins are pure consumers" becomes structural:
  they respond, they never drive.

Consequences: the harness SPI is dispatch-shaped; `Channel` needs no
acknowledge, contribute, or sign verb; the engine sits below the
inbound hook for protocol messages, which reach it rather than the
agent's attention, while the hooks still screen every crossing; and
one dispatch per participant per action replaces one model turn per
protocol step.
