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
Each event carries that session's identifier, the full stored message and
parent identifiers, and the stored timestamp.

**Codex session events.** Session
`019fba0c-9f1e-7911-9496-45b305a00cb5`, whose stored input history
carries the text and epoch timestamp of each user turn. Timestamps
below are that epoch converted to UTC.

Neither session is checked in, so a session locator alone is verifiable
only on the maintainer's machine. Every decision directive cited in the three
2026-08-05 ADR sections below is therefore **also** transcribed into a durable
repository event: issue `#926`, comment `5198672021`,
`2026-08-05T23:46:22Z`, agent-authored under the maintainer's account.
That comment is the resolvable locator; the session identifiers say where
each turn came from. The later source-attestation exchange postdates that
comment and remains local-only. See [Source gaps](#source-gaps) for what
those limits do and do not establish.

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

1. **Agent turn, Claude Code session `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.**
   Locator: message `3fdf75a2-5707-40e7-8403-e95dee71ac83`;
   parent `3690b084-4130-495d-88c4-e898aea7b23f`;
   `2026-08-04T21:09:36.697Z`. Stored role: `assistant`;
   agent-authored. `[omitted: the opening plan report, three findings,
   corrections, lane shape, and six other pending decisions]`. The literal
   excerpt retains the two highlighted concerns the next event addresses and
   the separate closing execution question.

   > ## Before step 5 can start
   >
   > Eight decisions need you; three gate the ADR bundle. The two I'd flag hardest:
   >
   > - **Required `mcpPort` invalidates every existing `~/.moltzap/config.json` with no shim.** That's real breakage on a published package, and nothing in-repo will catch it because all fixtures get regenerated. It needs a release note, and it belongs in the ADR's Consequences rather than being discovered during step 8.
   > - **Proactive DMs currently reuse a conversation** via `sendToAgent`'s cache; `start_conversation` creates unconditionally. Dropping `conv:<id>` outbound without a reuse lookup ships a user-visible regression hidden inside a refactor.
   >
   > Want me to start Lane V and steps 1–2 now (both unblocked, neither waits on any decision), or work the eight decisions first?

2. **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `846eb3e5-3a93-4b6e-b33c-213102377717`; parent
   `2d98ddc7-b868-4f43-8c93-8f8017f99882`;
   `2026-08-04T21:15:30.606Z`. Stored role: `user`.

   > Required mcpPort: not a concern -- pre-launch
   >
   > Proactive DMs; that's fine. lets deal with that later

   This reply addresses the two highlighted concerns raised in the preceding
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

1. **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `39159e1d-a69f-466b-82a3-028d01816ee8`; parent
   `9fe5be11-f2d4-432c-bb4b-87488e18971b`;
   `2026-08-04T20:15:14.931Z`. Stored role: `user`.

   > why are we keeping the legacy stuff?

2. **Stored user turn, Codex session
   `019fba0c-9f1e-7911-9496-45b305a00cb5`.** Locator: stored input
   history entry; event kind: user turn; `2026-08-04T07:51:13Z`.
   Stored role: `user`. The source exposes no separate message identifier,
   enclosing turn locator, or parent locator. The same literal turn is
   durably transcribed in repository `chughtapan/moltzap`, issue `#926`,
   comment `5198672021`, posted at `2026-08-05T23:46:22Z` by stored account
   `chughtapan`; that repository copy is agent-authored.

   > we can include participants in conversation passed by mcp to harness client but not on the main wire

3. **Agent turn, Claude Code session `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.**
   Locator: message `836728c5-1a19-41e2-bbd2-51145b0ab17c`;
   parent `8b3c1616-93e0-4ef7-996d-9d66db1e72df`;
   `2026-08-04T21:46:43.133Z`. Stored role: `assistant`;
   agent-authored. The turn quotes a clean-slate ADR and then distinguishes
   settled from open questions. `[omitted: the membership DTO, MCP-path,
   profile-port, and blind-review findings]`. The literal excerpts retain the
   directory finding and both open questions answered by the next event.

   > Here's what the ADRs actually say, sorted by whether they settle the question.
   >
   > ## Settled by ADR
   >
   > **#4 — directory: the ADR is directly against porting it.**
   > `20260801-harness-client-owns-runtime-context.md`:
   > > Registration, status, agent and conversation search, and conversation history remain MCP **management operations, not adapter-facing service methods**. `HarnessClient` may call search and history internally to rebuild its presentation context.
   >
   > Promoting `searchAgents`/`searchConversations` onto `HarnessClientService` — the only way to serve `listPeers`/`listGroups` — contradicts an accepted outcome. **Drop** is ADR-aligned; port needs an amendment plus its own reviewer. The external-plugin-contract check is still worth doing, but it can only argue for *amending*, not for porting quietly.
   >
   > ## Genuinely open — no ADR authority
   >
   > **#9 — `status` pre-registration.** `docs/spec/harness/daemon.md:105` explicitly declines: it "does not add a registration-state tool catalog or decide that `status` is also exposed on the registration path." Nothing else touches it. Zero authority either way.
   >
   > **#6 — docker suites.** No ADR. Pure engineering call.

4. **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `5a444536-1723-4d8b-8633-9b0af7c78166`; parent
   `06fff468-741f-42dc-a347-32b48e6097ba`;
   `2026-08-04T21:47:14.351Z`. Stored role: `user`. Answers the
   preceding retained questions.

   > keep status as a tool; docker suites? simplify as much as possible

5. **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `6ca4d0c9-07b1-446d-80e6-11aebd3c3c7e`; parent
   `93de7e93-a798-412b-b7d8-2f90039137a3`;
   `2026-08-04T21:49:28.466Z`. Stored role: `user`.

   > reviews should be checked in; if there is a confision ADR wins always

6. **Mechanical repository events.** Pull requests
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

7. **Stored issue comment.** Locator: repository `chughtapan/moltzap`;
   issue `#926`; comment `5185240471`; author account `chughtapan`;
   `2026-08-04T22:17:18Z`. Agent-authored. Records the classification
   sweep the divergence ledger rests on. `[omitted: the ownership table,
   six-row divergence ledger, four divergence analyses, detailed coverage
   gaps, and dropped findings]`. Literal excerpt:

   > **Coverage: 52 records examined (53 files in `docs/decisions/` minus `README.md`). 5 main-governing. 1 binding divergence.**
   >
   > Every record was classified and every load-bearing claim re-verified against code; sweeper findings that did not reproduce were dropped. Ownership was decided by probing **both** branches (`git cat-file -e origin/main:<path>` and the same against `origin/v2`) plus reading what each record actually governs — presence on `main` was never treated as proof.

No retained event states the restart guarantee in the words the ADR
uses. The ADR's *at most once* presentation and *never recreate reply
authority* are transcribed from
`20260801-harness-client-owns-runtime-context.md`, a clean-slate record
whose own text says production adoption is `main`-owned. Treat the ADR
as adopting that text for production, not as reporting a separate
human choice.

No retained user event directly selects the complete statement that
`HarnessClient` is the sole production adapter-facing capability. The
question in event 1 rejects keeping unspecified legacy machinery, the direct
event 2 selects the membership projection boundary, and the later events
settle narrower tool and review questions. The accepted ADR makes the
sole-capability outcome current, but this ledger has no separate human
selection event for that broader adoption.

<a id="the-daemon-serves-one-loopback-mcp-path"></a>

## The daemon serves one loopback MCP path

[ADR: `20260805-daemon-serves-one-loopback-mcp-path.md`](../decisions/20260805-daemon-serves-one-loopback-mcp-path.md)

1. **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `97d842db-f24b-4912-8b82-3b829ce509d5`; parent
   `4b7c18b4-e47c-43a6-b6cf-b17f603c9ad1`;
   `2026-08-04T21:26:47.117Z`. Stored role: `user`.

   > what is /register/mcp?

2. **Agent turn, Claude Code session `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.**
   Locator: message `657c5378-0317-4399-b01d-9dce2c410bf4`;
   parent `0bd81fcf-b9c7-4346-8a05-818c9b8ff7c6`;
   `2026-08-04T21:27:14.322Z`. Stored role: `assistant`;
   agent-authored description of the shipped
   two-path shape. `[omitted: the remainder of the turn]`.

   > ## What `/register/mcp` is
   >
   > `moltzapd` binds **one** loopback HTTP listener and serves **two** MCP endpoints on it:

3. **Stored user turns, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locators: message
   `0ed9a11f-2c36-4df9-8bfe-e7f1a01d5484`, parent
   `fec1cd47-ac53-45a0-b8bd-25815f2b663b`,
   `2026-08-04T21:28:29.903Z`; and message
   `4b93bb9e-965b-4a62-85ae-b520c98a4bbb`, parent
   `33ebd241-f295-47ea-b692-b023da09e98f`,
   `2026-08-04T21:28:41.674Z`. Stored role for both: `user`. The turns
   are consecutive.

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

7. **Agent turn, Claude Code session `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.**
   Locator: message `6dcea6f6-a3c2-4522-af24-224ef1c6760f`;
   parent `57062bfa-2df2-47c6-a105-ee83e4a42dc6`;
   `2026-08-04T21:30:03.281Z`. Stored role: `assistant`;
   agent-authored. It quotes the three turns above from a session it had read.
   Retained because the reply at `8fd049fd` answers this turn, not the
   originals. `[omitted: the opening chronology and the explanation of what
   "two" meant]`. The literal excerpt retains the options, recommendation,
   consequences, and closing question answered by the next event.

   > ## The actual choice
   >
   > The bootstrapping problem is genuine — pre-registration there's no AgentId, so the active tools can't be served. But that doesn't require two servers. Three shapes:
   >
   > | Shape | Pre-registration | After | Cost |
   > |---|---|---|---|
   > | **Two paths** (shipped) | `/register/mcp` → `register` | `/mcp` → 6 tools | Two `McpServer`s; clients must know which URL to hit and when |
   > | **One path, state-gated catalog** | `/mcp` → `register` only | `/mcp` → 6 tools, `register` gone | One `McpServer`, one URL; catalog changes with slot state via `notifications/tools/list_changed` |
   > | **Defer entirely** | keep HTTP bootstrap + CLI | — | `moltzap` bin keeps shipping; two completion criteria stay open |
   >
   > I'd go with **one path, state-gated catalog**. It matches the 00:00:51 proposal you actually accepted, it's what "the daemon can handle both the things" most plainly means, and it deletes a URL rather than adding one. The spec sentence *"`/register/mcp` presents `register` while the slot has no committed identity"* already describes state-gating — it just attaches it to a second path instead of a second catalog state.
   >
   > This changes open decision #3 from "implement or defer" to "**one path or two**", and it makes step 12 smaller: no `REGISTER_MCP_PATH`, no `makeRegistrationServer`, just a conditional catalog on the one server that already exists.
   >
   > Worth flagging: the ADR and `docs/spec/harness/daemon.md` both currently encode two paths, so changing this means those need amending through Lane V. Want me to add that to the Lane V candidate and rework step 12, or do you want to keep the two-path split now that you've seen where it came from?

   **Correction, 2026-08-05.** This ledger's author located the codex
   session and read the three turns directly. Three defects in the
   quoting turn are recorded rather than propagated: it dates the third
   turn `23:56:46` where the stored entry is `2026-07-31T23:54:40Z`; it
   dates the first turn `21:57:10` where the stored entry is
   `2026-07-31T21:57:09Z`; and it ends the second quotation at "now
   that I think about it.", dropping the remainder retained in event 5
   above — including "we should keep that." Events 4 through 6
   supersede that turn's quotations as the source of record.

8. **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `8fd049fd-2f65-4f29-bde8-76e2a4700643`; parent
   `124178b9-bc17-40fd-b38d-181d93135fea`;
   `2026-08-04T21:30:21.790Z`. Stored role: `user`. Answers the
   preceding retained question.

   > yes that should be corrected too

9. **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `5a444536-1723-4d8b-8633-9b0af7c78166`; parent
   `06fff468-741f-42dc-a347-32b48e6097ba`;
   `2026-08-04T21:47:14.351Z`. Stored role: `user`. The same turn retained above;
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

1. **Narrowed, then attested, 2026-08-05.** Every decision directive in
   the three 2026-08-05 ADR sections is transcribed verbatim into issue `#926`,
   comment `5198672021`, so a reader can resolve and quote it from the
   repository alone. The later attestation exchange is retained below
   from its local session. The repository comment cannot prove the
   transcription faithful — both sessions
   remain local to the maintainer's machine, and the comment is
   agent-authored — so the transcription was put to the maintainer
   directly.

   **Agent turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `14af5fc6-a38d-4bcc-a7a3-f590197d2238`; parent
   `4f6d41b6-06cf-478b-8ba6-9ad67404f654`;
   `2026-08-05T23:47:54.691Z`. Stored role: `assistant`;
   agent-authored. `[omitted: the repository-comment summary, defects table,
   and description of the remaining source-verifiability limit]`. The
   closing request is retained literally:

   > **Confirming those twelve blocks match what you actually wrote is now the one thing standing between #974 and the blind gate** — and it's a check only you can perform. After that: a fresh reviewer, six verbatim questions, and per the rerun rule a different reviewer from #958's.

   **Stored user turn, Claude Code session
   `b48667a3-8edc-4cb4-9525-b21c9a43e8ee`.** Locator: message
   `434933a2-d750-4cb1-ac3f-07399deef3c5`; parent system event
   `8989d469-a9df-48f7-9f95-105b6d1e4aa8`;
   `2026-08-05T23:48:37.720Z`. Stored role: `user`. The system event
   falls between this input and the immediately preceding public agent turn;
   it does not supply a different public prompt. Retained literally:

   > hes

   Read as an affirmative answering the preceding request. The reading
   is recorded rather than the normalization: the stored characters are
   `hes`, and this ledger does not silently repair them. A terse reply
   has no meaning beyond its prompt, so if that prompt was misread the
   attestation does not stand and this entry is the thing to correct.

   On that reading the excerpts are maintainer-attested. They remain
   not independently verifiable, and no later reconciliation should
   claim otherwise.

2. **Closed, 2026-08-05.** The one-versus-two MCP server exchange was
   previously retained only as a second-hand quotation. The codex
   session `019fba0c-9f1e-7911-9496-45b305a00cb5` was located on the
   maintainer's machine and its stored input history read directly, so
   those three turns are now first-hand events with stored timestamps.
   Three defects in the earlier quotation are recorded at that event.
   The `Known defects` table in comment `5198672021` predates discovery
   of the incorrect `21:57:10` timestamp and lists only the other two
   defects in message `6dcea6f6`; its third row concerns a different plan
   citation. That external table remains an incomplete historical artifact.
   The three source-verified corrections in event 7 are the current account.
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

5. **The sole production `HarnessClient` adoption has no direct human
   selection event.** The accepted ADR is current, but the retained events in
   that section select only narrower parts of its contract. See the note in
   that section.

6. **The checkpoint store's durability properties are undecided, not
   deferred by a stated decision.** No retained event discusses them.
