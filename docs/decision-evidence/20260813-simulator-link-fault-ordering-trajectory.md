# Simulator link-fault ordering trajectory

This non-normative ledger compacts the public exchange that selected the
Simulator's post-Router link-fault boundary. It is evidence for a human
decision, not design authority.

## Source and omissions

- Source system: Codex TUI rollout JSONL (`originator: codex-tui`,
  `thread_source: user`).
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.
- Source file at compaction time:
  `/home/tapanc/.codex/sessions/2026/08/06/rollout-2026-08-06T12-42-44-019fd899-779c-7e70-a8e4-338727b13e6c.jsonl`.
- The root session has no parent thread. Each retained message carries an
  enclosing `turn_id`; the source supplies no parent-message or parent-turn
  locator.
- This ledger omits unrelated implementation status, tool output, hidden
  reasoning, and repeated summaries. The first retained excerpt carries the
  marker `[omitted: four leading implementation-status bullets]` and preserves
  every word of the decision question and its options. No retained wording is
  normalized. In particular, the human phrase `life-level` remains literal.

## Simulator link-fault ordering

The agent presented the ordering conflict and two options:

- Message locator:
  `msg_0fe7c1dd2e31cd97016a7dd586aa0c819380b891ef21a26512`.
- Enclosing turn: `91688af0-2bc6-4e2b-a5ea-22363172f084`.
- Parent locator: absent.
- UTC: `2026-08-13T14:32:47.690Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> [omitted: four leading implementation-status bullets]
>
> One maintainer-gated Simulator choice remains. The legacy fault API allows holding `A→B` while `C→B` progresses. If A’s message precedes C’s, that contradicts Router’s guarantee that B observes one global order. The existing in-process `LinkPolicy` closures also cannot cross the daemon boundary.
>
> Choose one:
>
> 1. **Order-safe faults — recommended:** retain controlled endpoints using simulator-owned daemons. Replace arbitrary link callbacks with closed fault controls. Dropping may omit a message; delaying/holding one message stalls that recipient’s feed at that global position. Keep lifecycle evidence.
> 2. **Deletion-first:** remove controlled `Endpoint`/`Network`/`context.network` and directed-link controls/events. Keep `./network` for participant handles and Router lifecycle, then defer a replacement fault model.
>
> Please choose **1 or 2**. I will then record the public-contract decision, finish Simulator, unblock Evals, and run the final gates.

The human replied in two consecutive stored messages:

- Message locator: `msg_019ffc35-0352-7773-8385-27cd5007f44a`.
- Enclosing turn: `d98677a7-b311-438a-847f-eb1da57292ee`.
- Parent locator: absent.
- UTC: `2026-08-13T17:39:20.530Z`.
- Stored actor role: `user`.

Literal message:

> I think life-level ordering is fine for the simulator. that

- Message locator: `msg_019ffc35-0365-7dc3-bede-dd08ccfb4e38`.
- Enclosing turn: `d98677a7-b311-438a-847f-eb1da57292ee`.
- Parent locator: absent.
- UTC: `2026-08-13T17:39:20.549Z`.
- Stored actor role: `user`.

Literal message:

> that's the point of testing right

The agent stated the interpretation used by the authority packet:

- Message locator:
  `msg_0fe7c1dd2e31cd97016a7e01710a1c8193b46e90aaf91bdc8e`.
- Enclosing turn: `d98677a7-b311-438a-847f-eb1da57292ee`.
- Parent locator: absent.
- UTC: `2026-08-13T17:40:05.109Z`.
- Stored actor role: `assistant`.

Literal message:

> Yes—interpreting “life-level” as “link-level.” That’s the right testing boundary: the production Router still guarantees one global order, while an explicitly faulted Simulator run may perturb a recipient’s post-Router delivery—drop, delay, hold, or reorder it—to test endpoint recovery. Such a run is evidence about fault tolerance, not Router conformance.
>
> I’m recording that narrow exception first, then I’ll wire the Simulator-only interception path and keep normal runs byte/order faithful.

The two human messages above are the decision events. The assistant message
immediately after them is retained only to state the interpretation applied by
the authority packet. No source event selects an inter-process transport,
authentication scheme, port, deployment object, or wire representation for
the private interception path; this ledger attributes none of those mechanisms
to the human.
