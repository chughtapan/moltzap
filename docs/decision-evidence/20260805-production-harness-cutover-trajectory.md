# Production harness cutover source-event ledger

This is a curated, non-normative ledger of stored events. Timestamps are
UTC. Excerpts are literal; spelling, capitalization, typographic errors,
backticks, and hedges are preserved exactly as stored.

Three source systems appear.

**Repository events.** GitHub pull requests and issue comments in
`chughtapan/moltzap`, with native numeric identifiers, stored author
accounts, and creation timestamps. These are durable and resolvable by
anyone with repository access.

**Claude Code session events.** Session
`b48667a3-8edc-4cb4-9525-b21c9a43e8ee`, stored as a local transcript.
Each event carries that session's identifier, the stored message
identifier's first eight characters, and the stored timestamp.

**Codex session events.** Session
`019fba0c-9f1e-7911-9496-45b305a00cb5`, whose stored input history
carries the text and epoch timestamp of each user turn. Timestamps
below are that epoch converted to UTC.

Neither session is checked in. Their locators are verifiable on the
maintainer's machine and nowhere else. See [Source gaps](#source-gaps)
before relying on them.

The stored account on a repository event does not independently
authenticate a person, and several retained pull-request bodies are
agent-authored under the maintainer's account. Agent proposals are
recorded as agent events; repository changes are recorded as separate
mechanical events. The linked ADRs name their accountable
decision-maker separately.

Where a terse human reply is retained, the agent turn it answers is
retained immediately above it, because the reply has no meaning apart
from that prompt.

<a id="the-profile-slot-is-the-unit-of-local-identity"></a>

## The profile slot is the unit of local identity

[ADR: `20260805-profile-slot-is-the-unit-of-local-identity.md`](../decisions/20260805-profile-slot-is-the-unit-of-local-identity.md)

1. **Agent turn, session `b48667a3`.** Locator: message `3fdf75a2`;
   `2026-08-04T21:09:36Z`. Agent-authored. The turn reports a planning
   result and raises open questions; the excerpt retains only the
   opening finding, `[omitted: the remainder of the turn, including two
   further findings and the question list]`.

   > Plan written to `/home/tapanc/.claude/plans/create-a-plan-then-glimmering-quilt.md`. ## What the workflow found 12 agents, 1.13M tokens. Three findings reshaped the plan: **1. Your D2 decision gates nothing mechanically.**

2. **Stored user turn, session `b48667a3`.** Locator: message
   `846eb3e5`; `2026-08-04T21:15:30Z`.

   > Required mcpPort: not a concern -- pre-launch
   >
   > Proactive DMs; that's fine. lets deal with that later

   This reply addresses two of the questions raised in the preceding
   agent turn. The ledger records what it says. It does not record why,
   because no retained event states a reason.

3. **Mechanical repository event.** Pull request
   [`#954`](https://github.com/chughtapan/moltzap/pull/954), author
   account `chughtapan`, `2026-08-05T00:03:04Z`, titled *feat(client):
   the profile slot carries its own loopback port*. Agent-authored body.

4. **Mechanical repository event.** Pull request
   [`#955`](https://github.com/chughtapan/moltzap/pull/955), author
   account `chughtapan`, `2026-08-05T00:48:32Z`, titled *feat(client):
   compose the production HarnessClient from a profile name*.
   Agent-authored body.

No retained event states a checkpoint file format, fsync policy, quota,
or corruption-recovery choice. The ADR's declining of those is a
deliberate deferral, not a summary of a decision.

<a id="harness-client-is-the-production-adapter-contract"></a>

## HarnessClient is the production adapter contract

[ADR: `20260805-harness-client-is-the-production-adapter-contract.md`](../decisions/20260805-harness-client-is-the-production-adapter-contract.md)

1. **Stored user turn, session `b48667a3`.** Locator: message
   `39159e1d`; `2026-08-04T20:15:14Z`.

   > why are we keeping the legacy stuff?

2. **Agent turn, session `b48667a3`.** Locator: message `836728c5`;
   `2026-08-04T21:46:43Z`. Agent-authored; quotes a clean-slate ADR.
   `[omitted: the remainder of the turn, which covers three further
   questions]`.

   > Here's what the ADRs actually say, sorted by whether they settle the question. ## Settled by ADR **#4 — directory: the ADR is directly against porting it.** `20260801-harness-client-owns-runtime-context.md`: > Registration, status, agent and conversation search, and conversation history remain MCP **management operations, not adapter-facing service methods**.

3. **Stored user turn, session `b48667a3`.** Locator: message
   `5a444536`; `2026-08-04T21:47:14Z`. Answers the preceding turn.

   > keep status as a tool; docker suites? simplify as much as possible

4. **Stored user turn, session `b48667a3`.** Locator: message
   `6ca4d0c9`; `2026-08-04T21:49:28Z`.

   > reviews should be checked in; if there is a confision ADR wins always

5. **Mechanical repository events.** Pull requests
   [`#959`](https://github.com/chughtapan/moltzap/pull/959)
   (`2026-08-05T07:29:22Z`, *refactor(openclaw): drive the adapter only
   through HarnessClient*),
   [`#960`](https://github.com/chughtapan/moltzap/pull/960)
   (`2026-08-05T18:23:05Z`, *refactor(nanoclaw): own one Harness client
   for the adapter's lifetime*), and
   [`#972`](https://github.com/chughtapan/moltzap/pull/972)
   (`2026-08-05T22:43:05Z`, *test(simulator): prove the OpenClaw plugin
   acquires its own client*). Author account `chughtapan`;
   agent-authored bodies.

6. **Stored issue comment.** Locator: repository `chughtapan/moltzap`;
   issue `#926`; comment `5185240471`; author account `chughtapan`;
   `2026-08-04T22:17:18Z`. Agent-authored. Records the classification
   sweep the divergence ledger rests on.

No retained event states the restart guarantee in the words the ADR
uses. The ADR's *at most once* presentation and *never recreate reply
authority* are transcribed from
`20260801-harness-client-owns-runtime-context.md`, a clean-slate record
whose own text says production adoption is `main`-owned. Treat the ADR
as adopting that text for production, not as reporting a separate
human choice.

<a id="the-daemon-serves-one-loopback-mcp-path"></a>

## The daemon serves one loopback MCP path

[ADR: `20260805-daemon-serves-one-loopback-mcp-path.md`](../decisions/20260805-daemon-serves-one-loopback-mcp-path.md)

1. **Stored user turn, session `b48667a3`.** Locator: message
   `97d842db`; `2026-08-04T21:26:47Z`.

   > what is /register/mcp?

2. **Agent turn, session `b48667a3`.** Locator: message `657c5378`;
   `2026-08-04T21:27:14Z`. Agent-authored description of the shipped
   two-path shape. `[omitted: the remainder of the turn]`.

   > ## What `/register/mcp` is `moltzapd` binds **one** loopback HTTP listener and serves **two** MCP endpoints on it:

3. **Stored user turns, session `b48667a3`.** Locators: messages
   `0ed9a11f` (`2026-08-04T21:28:29Z`) and `4b93bb9e`
   (`2026-08-04T21:28:41Z`), consecutive.

   > I think we discussed it's just one MCP server not two

   > we never accepted two mcps

4. **Stored user turn, codex session `019fba0c`.** Locator: codex
   session `019fba0c-9f1e-7911-9496-45b305a00cb5`; stored input history
   entry; `2026-07-31T21:57:09Z`.

   > lets also make registration a separate MCP path? so the CLI can be entirely removed; and everything becomes mcp-cli

5. **Stored user turn, codex session `019fba0c`.** Locator: the same
   session; `2026-07-31T23:54:09Z`. Retained in full.

   > i think it's fine to actualy have one MCP server instead of two now that I think about it. The other separation might be good that v1 has clean things for when to trigger, that is separate from the actual ledger mechanisms and the open group v1 and all that. we should keep that.

6. **Stored user turn, codex session `019fba0c`.** Locator: the same
   session; `2026-07-31T23:54:40Z`.

   > the daemon can handle both the things

7. **Agent turn, session `b48667a3`.** Locator: message `6dcea6f6`;
   `2026-08-04T21:30:03Z`. Agent-authored. It quotes the three turns
   above from a session it had read. Retained because the reply at
   `8fd049fd` answers this turn, not the originals.
   `[omitted: the remainder of the turn]`.

   > You're right that there's an unratified drift here. The transcript shows three distinct positions: **1. You asked for it** — 2026-07-31T21:57:10:

   **Correction, 2026-08-05.** This ledger's author located the codex
   session and read the three turns directly. Two defects in the
   quoting turn are recorded rather than propagated: it dates the third
   turn `23:56:46` where the stored entry is `2026-07-31T23:54:40Z`,
   and it ends the second quotation at "now that I think about it.",
   dropping the remainder retained in event 5 above — including "we
   should keep that." Events 4 through 6 supersede that turn's
   quotations as the source of record.

8. **Stored user turn, session `b48667a3`.** Locator: message
   `8fd049fd`; `2026-08-04T21:30:21Z`. Answers the preceding turn.

   > yes that should be corrected too

9. **Stored user turn, session `b48667a3`.** Locator: message
   `5a444536`; `2026-08-04T21:47:14Z`. The same turn retained above;
   the `status` clause bears on this decision.

   > keep status as a tool; docker suites? simplify as much as possible

10. **Mechanical repository event.** Pull request
    [`#961`](https://github.com/chughtapan/moltzap/pull/961), author
   account `chughtapan`, `2026-08-05T20:08:27Z`, titled *feat(client):
   register on the daemon, and delete the CLI and socket plane*.
   Agent-authored body.

The agent turn at `6dcea6f6` characterizes the two-path shape as
"unratified drift". A later agent finding contradicts that
characterization for the clean-slate branch, where two paths are
admitted. No retained user event addresses that contradiction. The ADR
resolves it on branch-ownership grounds and does not rely on the
"drift" framing.

Event 5 retains a clause the quoting turn dropped: the same reply that
accepts one MCP server also says another separation "might be good" and
"we should keep that". Read in place, that clause is about v1 trigger
semantics being distinct from ledger mechanisms, not about MCP paths.
It is retained in full so a reader can judge that for themselves rather
than take this note's word for it.

Registration's non-idempotence is recorded in the ADR as a property of
the existing server, not as a choice. No retained event states a
decision to make it idempotent or to leave it so.

<a id="source-gaps"></a>

## Source gaps

1. **The interactive session is not checked in.** Every user event in
   this ledger cites session `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`, a
   transcript stored locally on the maintainer's machine. A reviewer
   without that machine cannot resolve those locators or confirm the
   excerpts. The excerpts were extracted from the stored transcript
   rather than recalled, but that assurance is the author's, not a
   checkable property of this repository. **Closing this gap requires
   either a durable locator for those turns or the maintainer's
   confirmation that the excerpts are accurate.** Until then, treat
   every session-sourced excerpt as attested rather than verifiable.

2. **Closed, 2026-08-05.** The one-versus-two MCP server exchange was
   previously retained only as a second-hand quotation. The codex
   session `019fba0c-9f1e-7911-9496-45b305a00cb5` was located on the
   maintainer's machine and its stored input history read directly, so
   those three turns are now first-hand events with stored timestamps.
   Two defects in the earlier quotation are recorded at that event.
   The session remains local to that machine, so the locator carries
   the same resolvability limit as gap 1.

3. **No retained event states a reason for any call.** The user turns
   are terse and none gives a rationale. Where the ADRs explain a
   choice, that explanation is the record's own reasoning about the
   code, not a paraphrase of a stated motive. Nothing here should be
   read as reporting what the decision-maker was thinking.

4. **The restart and reply-authority guarantees have no main-side
   human source.** They are adopted from a clean-slate record. See the
   note in that section.

5. **The checkpoint store's durability properties are undecided, not
   deferred by a stated decision.** No retained event discusses them.
