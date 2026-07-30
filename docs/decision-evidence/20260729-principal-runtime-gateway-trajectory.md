# Principal runtime gateway source-event ledger

This is a curated, non-normative ledger of stored user events in Codex session
`019fa613-7f9a-7103-99b0-a42fda0754de`. The primary handoff is in turn
`39d5505f-efa9-417d-b97f-14af5a270f73`. Its stored `user` message event is
timestamped `2026-07-30T02:08:47.726Z`; the source supplies no separate message
id or parent locator. The attachment locator is id
`f4eee480-6d7d-4bb2-b8e7-0d6c57e60b6e`, filename `pasted-text-1.txt`, SHA-256
`23a57ba9d5b83e186006dcfa43960e70d734fec3b3cf3fc25f2be98008b71622`.
Its filesystem birth and modification timestamp is
`2026-07-30T02:08:46Z`; this storage observation is not substituted for the
native message timestamp.

Excerpts below are literal. The source bullet glyph and Markdown indentation
are normalized. Entries 1–6 reproduce every substantive source line; their
entry labels represent the omitted section-heading lines. No substantive line
is omitted. The linked ADR is normative. This trajectory records what the
source states without adding rationale.

<a id="principal-io-uses-each-runtime-gateway"></a>

## Principal I/O uses each runtime gateway

[ADR: `20260729-principal-io-uses-runtime-gateways.md`](../decisions/20260729-principal-io-uses-runtime-gateways.md)

1. **Stored user attachment: system boundary.** Locator: the Codex session,
   turn, user message event timestamp, stored actor role, attachment id,
   filename, and digest above. The source supplies no separate message id or
   parent locator.

   > ## Handoff — Principal I/O uses each agent’s gateway
   >
   > ### Decision
   >
   > The simulator must model the real system boundary:
   >
   > Principal / evaluation program
   >           │
   >           │ runtime-native gateway
   >           ▼
   >  OpenClaw / NanoClaw / code agent
   >           │
   >           │ installed MoltZap skills
   >           ▼
   >        MoltZap router
   >           │
   >           ▼
   >        Other agents
   >
   > Principals do not interact with agents by pretending to be MoltZap
   > participants. They interact through each runtime’s native gateway.
   > MoltZap carries social traffic between agents.
   >
   > Code-based agents remain first-class. Their principal-facing gateway can
   > be an in-process Effect service, but their social actions must still use
   > MoltZap skills and traverse the same router as real agents.

2. **Stored user attachment: runtime contract.** Same locator.

   > AgentRuntime should expose its runtime-specific gateway after
   > acquisition:
   >
   > interface RunningAgent<Gateway> {
   >   readonly gateway: Gateway;
   >   readonly termination: Effect.Effect<RuntimeTermination>;
   > }
   >
   > The keyed roster preserves exact gateway types:
   >
   > agents.alice.gateway; // OpenClawGateway
   > agents.bob.gateway;   // NanoClawGateway
   > agents.carol.gateway; // EffectGateway
   >
   > There is no simulator-wide gateway union. Evaluation or customer code
   > supplies the adapter that knows how to drive each gateway.

3. **Stored user attachment: scenario ownership.** Same locator.

   > A behavioral evaluation may:
   >
   > - Start the router and runtime roster.
   > - Install or provision each agent’s MoltZap skills.
   > - Send principal instructions through native gateways.
   > - Observe gateway responses, runtime lifecycle, and ledger evidence.
   > - Apply network faults uniformly through the router.
   >
   > It must not:
   >
   > - Create an eval-sender MoltZap participant.
   > - Create tasks or conversations for agents.
   > - Preallocate task or conversation IDs.
   > - Send social messages on an agent’s behalf.
   > - Give code agents a shortcut around the router.
   >
   > If a scenario wants Alice to contact Bob, it instructs Alice through
   > Alice’s gateway. Alice must use her installed MoltZap skills to create
   > the required task or conversation and send the message. Whether she does
   > so is observable agent behavior, not work the harness performs for her.

4. **Stored user attachment: evidence and correlation.** Same locator.

   > The run ledger should distinguish:
   >
   > - Principal input recorded through a runtime gateway.
   > - Principal output returned through that gateway.
   > - Agent-created task and conversation activity.
   > - Router-committed agent-to-agent messages.
   > - Runtime readiness, termination, and infrastructure failures.
   >
   > Gateway input/output correlation uses the gateway’s own session or turn
   > semantics. The simulator does not impose a universal cross-runtime
   > correlation ID.

5. **Stored user attachment: `replyToId`.** Same locator.

   > Remove replyToId end-to-end from:
   >
   > - Protocol message and send schemas.
   > - Server validation and storage.
   > - Client and channel-facing types.
   > - Simulator events.
   > - Evaluation transcript selection and grading.
   >
   > Any channel edits should be mechanical fallout from removing the field,
   > not behavioral changes intended to force evaluations to pass.

6. **Stored user attachment: evaluation classification and implementation
   order.** Same locator.

   > The existing 32-run sweep should be classified as a network/channel
   > diagnostic, not behavioral acceptance evidence. It prompted agents
   > through a synthetic MoltZap peer and therefore exercised the wrong
   > principal boundary.
   >
   > Rebuild the evaluations so that:
   >
   > 1. The principal prompt enters through the target runtime’s gateway.
   > 2. Agents autonomously create their social workspace using MoltZap
   >    skills.
   > 3. All inter-agent communication traverses the production router.
   > 4. The judge receives gateway input/output plus the resulting ledger
   >    transcript.
   > 5. Real and code-based agents can participate together in the same
   >    society.
   >
   > The first implementation step is to update the durable architecture
   > decision before changing code.

7. **Stored user message: v0 runtime lifecycle scope.** Locator: the same
   Codex session; enclosing turn
   `019fa7af-1431-7c52-897e-e9371a23984a`; message event; stored actor role
   `user`; `2026-07-28T07:44:58.076Z`. The source supplies no separate message
   id or parent locator.

   > no: replacement and restart are stretch goals; not scope for v0

8. **Stored user message: compatibility cleanup.** Locator: the same Codex
   session; enclosing turn `abe428a0-3b20-4730-8b40-58f34b290145`; message
   event; stored actor role `user`; `2026-07-28T21:21:18.802Z`. The source
   supplies no separate message id or parent locator.

   > don't worry about existing compatibility API -- lets clean that up too

Repository effect at this candidate: the feature branch was first rebased onto
`origin/main` revision `791d0f68` at the user's later request. The gateway
decision, prior-record supersession, decision-log index, and this trajectory
were then prepared before gateway or `replyToId` implementation changes. These
are mechanical repository events, not quotations or independent rationale.

Source gaps, stated plainly:

- The source supplies no separate message id or parent locator. The native
  session, turn, event timestamp, stored actor role, attachment locator and
  digest are retained; no missing locator is invented.
- The handoff does not identify the preceding conversation events from which
  it was assembled and does not state independent rationale for each contract
  detail.
- It does not choose concrete OpenClaw or NanoClaw gateway APIs, commands,
  transports, session identifiers, or response shapes. Customer or evaluation
  adapters own those runtime-specific mechanisms.
- It shows `agents.<name>.gateway` and a runtime result containing `gateway`
  and `termination`, but it does not name the composite roster-entry type or
  the property that carries the router-issued agent handle.
- It permits skill installation or provisioning but does not separately assign
  the provisioning mechanism to a layer.
- It requires the ledger to distinguish gateway input and output but does not
  prescribe one universal event payload or content-retention policy. The
  existing closed event-catalog and customer-policy decisions still govern
  those schemas.
- It calls for `replyToId` removal and compatibility cleanup but does not
  prescribe a database migration mechanism or historical event-tag treatment.
- Irrelevant tool output, private system and developer instructions, hidden
  reasoning, and environment diagnostics are omitted. No credential values
  are retained.
