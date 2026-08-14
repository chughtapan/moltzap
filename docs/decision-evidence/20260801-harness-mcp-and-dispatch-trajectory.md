# Harness MCP and dispatch decision trajectory

This is a non-normative, source-faithful event ledger. It does not make
an architecture decision and does not reconstruct rationale that the
source does not state. Current contracts live in the admitted ADRs and
their normative specification owners.

## Source record and compaction method

- Source system: Codex CLI rollout JSONL, recorded with source `cli` and
  originator `codex-tui`.
- Source session:
  `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Source file:
  `rollout-2026-07-31T14-20-17-019fba0c-9f1e-7911-9496-45b305a00cb5.jsonl`.
- Session metadata event: event kind `session_meta`, UTC
  `2026-07-31T21:35:19.305Z`; the payload records session creation time
  `2026-07-31T21:20:17.221Z`, branch
  `agent/v2-identity-foundation`, commit
  `c1b77fc4d19161b7c1e3301b1a0dadb0d766b97e`, and repository
  `https://github.com/chughtapan/moltzap.git`.
- The session metadata event has no native message ID, enclosing turn,
  parent locator, or stored actor role. It does not identify the human
  using the session.

Quoted message text is literal. In retained assistant option prompts,
`[omitted: ...]` marks prose removed between complete option labels.
System and developer instructions, hidden reasoning, private research,
unrelated tool output, and unrelated conversation were omitted. No
secret, personal data, or authentication-bound session URL is retained.
The gstack first-use checkpoint-mode and prose-style answers and the choice to
skip an optional office-hours pass are omitted as workflow configuration, not
#926 architecture or implementation decisions. Requests to persist or update
the issue, run a plan or ADR review, show or finalize the plan, continue, choose
a worktree, or begin implementation are likewise omitted as process direction,
not contract outcomes. Exploratory questions and terse acknowledgements are
compacted when a later retained event states the resulting choice; reversals
retain the event needed to identify the earlier answer they replace.
Every retained response item lacks a parent-message field; each event
therefore says that its parent locator is absent rather than inventing
one.

## Early #926 engineering-review decisions

### Verification categories corrected

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba2a-2307-71c0-868d-283d8a74a85e`.
- Enclosing turn: `019fba20-f93a-7901-9efe-1b783961862a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:52:31.495Z`.
- Stored actor role: `user`.

Literal excerpt:

> we - CLI tests proving no Unix-socket dependency and direct short-lived
>     WebSocket operation.
>
>   - OpenClaw and NanoClaw unit tests proving neither imports or
>     constructs MoltZapService/MoltZapChannelCore.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba2a-230b-7a83-90b7-c46f61c4eeed`.
- Enclosing turn: `019fba20-f93a-7901-9efe-1b783961862a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:52:31.499Z`.
- Stored actor role: `user`.

Literal excerpt:

> These are not valid unit tests

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d192633bc8195b81e8a2d3966aacc`.
- Enclosing turn: `019fba20-f93a-7901-9efe-1b783961862a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:52:40.783Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> You’re right on both points.
>
> - There should be no separate “human CLI” implementation path. The daemon
> exposes MCP tools; an MCP CLI can discover and invoke them.
> - “Does not import/construct X” is an architecture-boundary assertion, not a
> unit test. Runtime-adapter tests should verify observable MCP behavior;
> dependency rules belong in the architecture checker.
>
> I’ll revise the plan around one MCP surface as the endpoint interface and
> reclassify the verification accordingly.

This is an agent response to the human correction. The correction fixes test
classification; it does not itself prescribe a test framework or exact test
fixture.

### Existing production behavior is translated, not redesigned

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d1ebd5aac81959bf2d1ccfc598142`.
- Enclosing turn: `019fba3c-8138-7ab2-b8c9-d0150e2e0721`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:16:31.588Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> The local evidence already shows a large reusable seam: v1 has closed
> command schemas and handlers for every retained CLI operation. I’m checking
> the pinned MCP revision and runtime built-ins now, because the main scope
> question is whether to translate that seam or replace it wholesale.

This is an agent framing prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba40-ae7c-7161-8888-d15c5aa2d5b9`.
- Enclosing turn: `019fba3c-8138-7ab2-b8c9-d0150e2e0721`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:17:08.988Z`.
- Stored actor role: `user`.

Literal excerpt:

> translate

The answer is limited to the immediately preceding retained scope fork. It
keeps the production handler and business-logic seam authoritative while the
transport and adapter boundary change. The final scope correction later in
this trajectory reinforces that existing implementation mechanics are not to
be redesigned.

### Atomic cutover was selected before the later two-slice correction

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d1f5d50f48195816d224ddc04ff9c`.
- Enclosing turn: `019fba3c-8138-7ab2-b8c9-d0150e2e0721`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:19:20.352Z`.
- Stored actor role: `assistant`.

Literal excerpt with effort estimates and option detail omitted:

> D4 — How should the translation land?
>
> **A — Staged translation (recommended)**
>
> [omitted: effort estimate and option detail]
>
> **B — Atomic cutover**
>
> [omitted: effort estimate and option detail]
>
> Choose A or B.

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba43-6ad2-7272-8d60-5503628210a9`.
- Enclosing turn: `019fba43-6a2f-7f52-98e5-0c8a8c4c6567`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:20:08.274Z`.
- Stored actor role: `user`.

Literal excerpt:

> B

The meaning of `B` is limited to the immediately preceding retained prompt.
The later retained two-slice correction replaces the one-revision execution
shape; this event does not override that later correction.

### Official MCP SDK boundary

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d1fe7b70881958a0e47fc87a150e1`.
- Enclosing turn: `019fba43-6a2f-7f52-98e5-0c8a8c4c6567`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:21:35.552Z`.
- Stored actor role: `assistant`.

Literal excerpt with findings and option detail omitted:

> D5 — Architecture issue 1: MCP protocol ownership
>
> [omitted: finding, explanation, and stakes]
>
> **1A — Official SDK boundary (recommended)**
>
> [omitted: option detail]
>
> **1B — Custom Effect MCP server**
>
> [omitted: option detail]
>
> Choose **1A** or **1B**.

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba44-f4b7-7d01-ae51-72b67db93e26`.
- Enclosing turn: `019fba44-f41c-7d82-b5eb-392dd5808163`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:21:49.112Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained prompt.
The later FastMCP rejection leaves this official-SDK boundary current.

## Harness vocabulary and one profile-slot daemon

### Initial endpoint MCP compatibility request

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba1a-652a-7431-b15d-8a6ad99258c9`.
- Enclosing turn: `019fba1a-60e9-7603-9e94-3e1e8f5d7e6a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:35:19.850Z`.
- Stored actor role: `user`.

Literal excerpt:

> can you pull in #924 which has simplified the v1 control plane. I want to
> now start working on the cleaning up the endpoints based on the previous
> ADRs that look at how to define the endpoints better: I want to  start
> working on that. We should MCPify the endpoint interface now so that both
> v1 and v2 might be compatible and the migration becomes easier. can we
> start planning towards that

This is the source request that scopes the endpoint work following #924 and
asks for compatibility. It does not itself decide that compatibility must be
raw-wire identity; the later compile-time and different-wires decisions define
that term more narrowly.

### Per-AgentId daemon and MCP-only adapters

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba20-fa77-7382-883d-eac56b1fbde6`.
- Enclosing turn: `019fba20-f93a-7901-9efe-1b783961862a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:42:31.287Z`.
- Stored actor role: `user`.

Literal excerpt:

> opology and interface: create a standalone v1 per-AgentId daemon that
>      owns MoltZapService; both adapters become MCP-only clients

### CLI access moved to MCP before the CLI was removed

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba28-c685-7a62-95a8-9034bf601391`.
- Enclosing turn: `019fba20-f93a-7901-9efe-1b783961862a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:51:02.278Z`.
- Stored actor role: `user`.

Literal excerpt:

> actually lets keep the CLI through MCP too? many of those things can become
> MCP tools as well instead of / in-additon to being CLI calls.

This first keeps a CLI as an MCP caller. The later retained registration-path
event says the CLI can be entirely removed in favor of `mcp-cli`; that later
event replaces the continued bespoke-CLI part while retaining MCP as the
operation boundary.

### Exact two-tool surface was accepted, then expanded

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba2c-4507-73c0-8a5e-b89ec291d76a`.
- Enclosing turn: `019fba2c-4401-7453-98be-a20e8bd6c70c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:54:51.271Z`.
- Stored actor role: `user`.

Literal excerpt:

> - start_conversation: other-agent names plus initial content.
>           - send_message: explicit send into an existing conversation.
>           - reply: consume one live turn/dispatch lease.?

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba2c-575f-7d82-8191-94c2c398a652`.
- Enclosing turn: `019fba2c-566b-7d51-ba92-f29a895bfdbf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:54:55.967Z`.
- Stored actor role: `user`.

Literal excerpt:

> v2 does not have all of these

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d19ce8cc08195931271fa5dbb11eb`.
- Enclosing turn: `019fba2c-566b-7d51-ba92-f29a895bfdbf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:55:31.597Z`.
- Stored actor role: `assistant`.

Literal excerpt with following explanation omitted:

> You’re right. I incorrectly carried v1’s old CLI surface into MCP.
>
> The compatible endpoint surface should remain exactly:
>
> - `start_conversation`: starts a conversation with initial content.
> - `reply`: commits the response associated with a live turn.
>
> There is no `send_message`.
>
> [omitted: following explanation]

This is an agent proposal, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba2d-7eae-7e70-96ba-bff6d5ed7a8e`.
- Enclosing turn: `019fba2d-7e22-7731-8165-b4726a19c171`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:56:11.566Z`.
- Stored actor role: `user`.

Literal excerpt:

> do that

The answer accepts the immediately preceding exact two-tool proposal. The
next retained human events add registration and other former CLI workflows as
MCP tools, so they replace exact tool-set equality. The later complete-send
removal retains the absence of generic `send_message`; it does not remove the
separately accepted management tools.

### Registration becomes a separate MCP path

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba2e-63df-73c0-af5b-d2016097d12e`.
- Enclosing turn: `019fba2e-62a1-73e3-801d-e70f16cfca02`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T21:57:10.239Z`.
- Stored actor role: `user`.

Literal excerpt:

> lets also make registration a separate MCP path? so the CLI can be
> entirely removed; and everything becomes mcp-cli

### All former CLI workflows become MCP tools

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba32-28f6-79b2-bef8-c42d47b36b9f`.
- Enclosing turn: `019fba32-279f-76d3-ab52-47c54f0461d7`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:01:17.302Z`.
- Stored actor role: `user`.

Literal excerpt:

> the other CLI features should also become MCP tools bro.

### FastMCP option prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d214a5e508195b5383abdfa5a7fe9`.
- Enclosing turn: `019fba3c-8138-7ab2-b8c9-d0150e2e0721`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:27:38.279Z`.
- Stored actor role: `assistant`.

Literal excerpt with option descriptions omitted:

> ### D6 — Where should FastMCP-TS enter the design?
>
> **2A) Official SDK runtime; FastMCP CLI interoperability only
> (recommended)**
>
> [omitted: option description]
>
> **2B) Adopt FastMCP for daemon and adapter clients**
>
> [omitted: option description]
>
> **2C) Do not use FastMCP anywhere**
>
> [omitted: option description]
>
> Reply with **2A**, **2B**, or **2C**.

This is an agent prompt, not a human decision.

### FastMCP answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba4a-f475-7261-bdfc-3b8d7c97993f`.
- Enclosing turn: `019fba4a-f3d8-7c00-881e-d7fedb28ab61`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:28:22.261Z`.
- Stored actor role: `user`.

Literal excerpt:

> C

The meaning of `C` is limited to the immediately preceding retained
prompt.

### Compatibility is compile-time

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba4d-d5b1-7fe3-a7bd-757b1c6c2af1`.
- Enclosing turn: `019fba4d-d4b9-7f33-9990-e3827e1c86cf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:31:30.994Z`.
- Stored actor role: `user`.

Literal excerpt:

> 3A; but we want to cleanup these to become like Effect services or
> layers (see how v2 is exposing identity and co); compile time inter-op
> not runtime

### Initial runtime and administration capability split

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d22edd0448195a5cbdcc0168c0da9`.
- Enclosing turn: `019fba4d-d4b9-7f33-9990-e3827e1c86cf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:34:39.124Z`.
- Stored actor role: `assistant`.

Literal excerpt with findings and most option detail omitted:

> ### D8 — How should the endpoint Effect capabilities be divided?
>
> [omitted: finding, explanation, and stakes]
>
> **4A) Portable runtime capability plus separate v1 administration capability
> (recommended)**
>
> [omitted: most option detail]
>
> - ✅ `EndpointRuntime` exposes only `startConversation`, a scoped turn
> `Stream`, and `reply`; OpenClaw and NanoClaw require only this tag.
> - ✅ `V1EndpointAdmin` separately owns registration, status, agent lookup,
> messages, and history without pretending those exist in v2.
>
> **4B) One broad endpoint capability containing every v1 tool**
>
> [omitted: option detail]
>
> **4C) One Effect capability per MCP tool**
>
> [omitted: option detail]
>
> Reply with **4A**, **4B**, or **4C**.

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba54-e3aa-7bb1-8b80-189bbd290c74`.
- Enclosing turn: `019fba54-e2ea-7903-b772-b8a17f87b86d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:39:13.322Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained prompt.
The later one-server decision and approved Harness vocabulary replace the
public `EndpointRuntime`/`V1EndpointAdmin` names and leave only
`HarnessClient` public; the portable adapter boundary and the separation of
daemon-internal responsibilities remain the retained part of this choice.

### Production registration must recover a lost success

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d24ab6394819599c646a271f9be4a`.
- Enclosing turn: `019fba54-e2ea-7903-b772-b8a17f87b86d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:42:01.638Z`.
- Stored actor role: `assistant`.

Literal excerpt with explanation and most option detail omitted:

> ### D9 — How recoverable must v1 MCP registration be?
>
> [omitted: explanation, stakes, and recommendation]
>
> **5A) Make v1 HTTP registration fully idempotent and recoverable**
>
> - ✅ Introduce an OperationId and client-owned recoverable credential so the
> daemon can persist intent before contacting the server.
> - ✅ Identical retries recover the same AgentId and credential after either
> process or machine failure.
>
> [omitted: remaining option detail]
>
> **5B) Preserve v1 semantics with a documented crash window (recommended)**
>
> [omitted: option detail]
>
> **5C) Keep remote registration out of the daemon**
>
> [omitted: option detail]
>
> Reply with **5A**, **5B**, or **5C**.

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba57-a25b-7523-9edf-3d95313162e1`.
- Enclosing turn: `019fba57-a1b3-73f1-9935-dff473d1c6c6`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:42:13.211Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained prompt.
It is a production-line #926 decision that the existing v1 HTTP registration
uses a stable OperationId and client-owned recoverable credential, persists
the registration intent before contacting the server, and lets identical
retries recover the same AgentId and credential after process or machine
failure. It does not change v2 branch authority or itself admit a clean-slate
Registry mechanism.

### Exact production credential mechanism remains qualified

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d250870a081959a7c5aaa06d994dc`.
- Enclosing turn: `019fba57-a1b3-73f1-9935-dff473d1c6c6`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:43:34.410Z`.
- Stored actor role: `assistant`.

Literal excerpt with explanation and most option detail omitted:

> ### D10 — Who should generate the recoverable v1 credential?
>
> [omitted: explanation, stakes, and recommendation]
>
> **6A) Daemon-generated credential plus server idempotency receipt
> (recommended)**
>
> - ✅ `register` accepts a stable OperationId; the daemon generates the API key
> and durably stages it before making the HTTP request.
> - ✅ The server stores only key ID, secret hash, request fingerprint,
> OperationId, and AgentId—never recoverable plaintext.
> - ✅ Identical retries return the same AgentId; changed name, description, or
> credential under that OperationId returns an idempotency conflict.
>
> [omitted: remaining option detail]
>
> **6B) Server-generated credential with an encrypted replay receipt**
>
> [omitted: option detail]
>
> **6C) Server derives the credential deterministically from OperationId**
>
> [omitted: option detail]
>
> Reply with **6A**, **6B**, or **6C**.

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba58-dfbc-7fb3-adc0-c8bce97eba41`.
- Enclosing turn: `019fba57-a1b3-73f1-9935-dff473d1c6c6`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:43:34.461Z`.
- Stored actor role: `user`.

Literal excerpt:

> minimal change; borrow v2 semantics if we can.

This answer does not name `6A`, `6B`, or `6C`. It qualifies the mechanism by
requiring a minimal change and borrowing existing v2 semantics only where
possible.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d252e4a9c81959fd6f52e0e07d799`.
- Enclosing turn: `019fba57-a1b3-73f1-9935-dff473d1c6c6`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:44:01.398Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> I’m taking that as **6A, constrained to the smallest v2-shaped change**: the
> endpoint generates the existing v1 bearer credential, persists it before the
> call, and sends only its verifier plus an OperationId. The server continues
> storing the same key ID/hash columns, adds idempotency metadata to the agent
> row, and returns AgentId—not secret material. We borrow v2’s endpoint-owned
> authority and idempotent registration semantics, without importing v2 code
> or adopting AgentCards/keypairs in v1.

This is the agent’s interpretation, not a human `6A` answer. The `5A`
OperationId, client-owned recoverable credential, pre-call intent persistence,
and identical-retry recovery requirements are explicit. Who generates the
credential and the exact staging or storage representation, server receipt,
verifier, request fingerprint, and changed-input conflict behavior remain
qualified and cannot be silently promoted into this v2 ADR candidate.

### Existing ADR authority ordered after the production review

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba5b-576b-7c40-8c23-d230b3bc955f`.
- Enclosing turn: `019fba5b-5660-75c3-8333-b0e688e1e3ab`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:46:16.172Z`.
- Stored actor role: `user`.

Literal excerpt:

> look at the exsiting ADRs

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba60-d881-75d1-92b7-ba6e54a3da5b`.
- Enclosing turn: `019fba60-d795-7a11-ad01-8b906f5dda7c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:52:16.897Z`.
- Stored actor role: `user`.

Literal excerpt:

> again, look at existing ADRs

These human instructions make the accepted ADRs the required reconciliation
input. They do not by themselves rescind the production `5A` choice, and they
do not authorize importing that production mechanism into the clean-slate
track.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d275637d88195b228b92ffccc100b`.
- Enclosing turn: `019fba60-d795-7a11-ad01-8b906f5dda7c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:53:14.249Z`.
- Stored actor role: `assistant`.

Literal excerpt with supervision detail omitted:

> The ADR lineage gives a firm answer:
>
> - Registration remains a direct Registry bootstrap operation and never
> enters the per-AgentId daemon’s `/mcp`.
> - Local profile creation happens before daemon startup.
> - The daemon starts only from a complete registered profile.
>
> [omitted: harness supervision detail]

This is an agent reconciliation result, not a human decision. The later human
one-server and `/register/mcp` decisions replace its process/presentation
conclusion, while the accepted Registry remains the clean-slate authority
behind that presentation.

### The listen contract is fixed, with later correlation correction

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d2668b96081958b7d99af358aad67`.
- Enclosing turn: `019fba5d-af77-7342-a596-2532b9500f17`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:49:16.143Z`.
- Stored actor role: `assistant`.

Literal excerpt with an illustrative flow omitted:

> `listen` is the daemon-to-runtime event stream. It is not an MCP tool.
>
> The adapter opens one long-lived MCP `subscriptions/listen` request to the
> local daemon. When the daemon obtains a live reply/dispatch grant, it emits a
> `turn_ready` notification containing the incoming context and the token
> required by `reply`.
>
> [omitted: illustrative production flow]
>
> So OpenClaw/NanoClaw never open MoltZap’s WebSocket or own dispatch leases.
> The daemon does. Only one adapter may hold the listen stream at a time.
>
> In the v2 ADR, this is loopback HTTP with an SSE response—not WebSocket—and it
> deliberately has no replay or acknowledgement.

This is an agent explanation, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba5e-6b12-7103-b529-1e8c84e6bbeb`.
- Enclosing turn: `019fba5e-6a1d-7f53-8e0d-b1e6f48b690f`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T22:49:37.810Z`.
- Stored actor role: `user`.

Literal excerpt:

> okay, so that contract should be fixed

The answer is limited to the immediately preceding retained explanation. The
later payload-only-reply correction removes the proposed public token, and
the later one-server decision changes the process presentation. The retained
listen mechanics are the scoped MCP subscription, daemon-owned network and
reply authority, sole listener, loopback HTTP/SSE, and no replay or delivery
acknowledgement; the later transient-delivery prompt and answer make the last
point explicit.

### One server handles both responsibilities

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba99-8166-7972-9c7c-6419c6ed7e7e`.
- Enclosing turn: `019fba99-8008-7c30-a450-1bab63ff4ddc`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T23:54:10.151Z`.
- Stored actor role: `user`.

Literal excerpt:

> i think it's fine to actualy have one MCP server instead of two now
> that I think about it. The other separation might be good that v1 has
> clean things for when to trigger, that is separate from the actual
> ledger mechanisms and the open group v1 and all that. we should keep
> that.

### The daemon handles both responsibilities

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba9b-e490-75a0-b0a6-d5496e090c4d`.
- Enclosing turn: `019fba99-8008-7c30-a450-1bab63ff4ddc`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T23:56:46.608Z`.
- Stored actor role: `user`.

Literal excerpt:

> the daemon can handle both the things

### Backings retain their native grant mechanics

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbaa3-7017-7fb1-bfb3-e1f829f685c9`.
- Enclosing turn: `019fbaa3-6ead-7c93-989b-1992be3ceb78`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:05:01.079Z`.
- Stored actor role: `user`.

Literal excerpt:

> basically I think listen mechanics and cross conv mechanics should cnverge;
> for v1; the existing dispatch leases work, for v2, we can keep the ledger
> things for now

The production and clean-slate labels are retained as source wording only;
later human text rejects them as public implementation names.

### Clients converge above backing mechanics

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbaa4-0194-7173-892b-018f4c4cb2cb`.
- Enclosing turn: `019fbaa3-6ead-7c93-989b-1992be3ceb78`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:05:38.324Z`.
- Stored actor role: `user`.

Literal excerpt:

> apart from that the clients should start looking identical

### Search replaces list

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbab4-3642-7811-88ab-f3e61e4619a1`.
- Enclosing turn: `019fbab4-3452-77c2-8288-fd0f2217501d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:23:20.387Z`.
- Stored actor role: `user`.

Literal excerpt:

> I think v1 and v2 tool surfaces should be reconciled further; also we
> should not use list_* but search_* for agents and conversations and
> those return paginated results and empty queries can be allowed?
> search for how agents like hermes etc., handle this right now

### Search contract proposed for the issue update

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d413c93708195be7dee01d48b9bb2`.
- Enclosing turn: `019fbab4-3452-77c2-8288-fd0f2217501d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:44:29.244Z`.
- Stored actor role: `assistant`.

Literal excerpt from an assistant-proposed plan, with intervening
candidate-only matching, ordering, and cursor rules omitted:

> ```ts
> search_agents({
>   query?: string
>   cursor?: string
> }): {
>   agents: readonly EndpointAgent[]
>   nextCursor?: string
> }
>
> search_conversations({
>   query?: string
>   cursor?: string
> }): {
>   conversations: readonly EndpointConversationSummary[]
>   nextCursor?: string
> }
> ```
>
> [omitted: the remainder of the proposed schemas and intervening rules]
>
> - Omitted, empty, or whitespace-only `query` means browse.

This is an agent proposal, not a human decision. The proposed
`EndpointConversationSummary` is later challenged in the retained
conversation-result exchange below.

### Issue update requested after the search plan

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbacb-19f3-7770-8ece-eeb8b91db8cf`.
- Enclosing turn: `019fbacb-07e5-7013-9940-f904782731f3`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:48:20.467Z`.
- Stored actor role: `user`.

Literal excerpt:

> can you update the issue with all of this; then I want to go deeper into
> what the MCP extension we talked about which allows us to recieve messages
> in the previous ADRs? we should discuss that too

The phrase `all of this` follows the retained assistant plan. This ledger
does not use it to infer separate human wording for every plan detail, and
the later scope correction excludes candidate-only details that were not
otherwise decided.

### Transient receive contract prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d4d9688448195aed7fb139cac595b`.
- Enclosing turn: `019fbacb-07e5-7013-9940-f904782731f3`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T01:36:45.185Z`.
- Stored actor role: `assistant`.

Literal excerpt with the preceding receive-contract analysis and FastMCP
discussion omitted:

> The remaining architectural choice is therefore explicit:
>
> - Keep `listen` as an at-most-once, transient granted-turn dispatch for
> #926—the minimal path.
> - Or make it reliable now, which requires persisted pending turns, private
> delivery correlation, acknowledgment, redelivery/deduplication, expiry rules,
> and restart recovery:
>
> ```text
> grant → persist pending turn → emit/redeliver
>       → EndpointClient accepts and acknowledges → consume attention
> ```
>
> My recommendation is the first for #926, with reliable delivery handled by a
> focused replacement ADR. But if “receive messages” means “a locally correct
> agent must not lose a reply opportunity across disconnect,” then we should
> reopen the delivery decision now rather than preserve the current contract.

This is an agent prompt, not a human decision.

### Transient receive contract retained

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbaff-641a-7db0-81e3-e5119af5b3a0`.
- Enclosing turn: `019fbaff-5fde-7210-8c56-36bfe1237ae2`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T01:45:27.322Z`.
- Stored actor role: `user`.

Literal excerpt:

> okay lets keep that

The meaning of `that` is limited to the immediately preceding retained choice:
keep the existing at-most-once, transient granted-turn dispatch. It does not
select the reliable-delivery alternative or its proposed mechanisms.

### Backing-specific applications and similar clients requested

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb11-604a-7123-b8ef-93d73a04626a`.
- Enclosing turn: `019fbb11-5eaf-7253-8eca-e3ab765c4ee4`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:05:05.995Z`.
- Stored actor role: `user`.

Literal excerpt:

> we should separate parts that separate for v1 and v2 that are shared, and
> break it down into further abstractions. I think the inbound path needs to
> generalize maybe and then v1 and v2 should become two specific applications

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb11-e370-7722-aa41-af6dc4e7c8c0`.
- Enclosing turn: `019fbb11-e1fc-7d60-a078-d06972973023`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:05:39.568Z`.
- Stored actor role: `user`.

Literal excerpt:

> like the MCP server serving those extensions for v1 and v2 can be different
> but the clients shuold be similar (closer to B I'm guessing)

These statements request a generalized inbound boundary with backing-specific
applications and allow backing-specific server extensions while clients
converge. The later `C` answer temporarily selects a shared raw extension; the
later client-side correction and explicit “A for now” restore different MCP
wires behind an identical client interface.

### Shared raw extension was selected, then replaced

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d55b06f148195a789ba6017a10e27`.
- Enclosing turn: `019fbb11-e1fc-7d60-a078-d06972973023`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:11:10.058Z`.
- Stored actor role: `assistant`.

Literal excerpt with architecture explanation and option detail omitted:

> ### D3 — Should the shared inbound layer be shared source code or a shared
> contract?
>
> [omitted: explanation, stakes, and recommendation]
>
> A) **Shared contract and conformance, independent implementations**
> (recommended)
>
> [omitted: option detail]
>
> B) **Create a neutral shared runtime package**
>
> [omitted: option detail]
>
> C) **Share one raw MCP extension and client implementation**
>
> [omitted: option detail]
>
> **Pick A, B, or C.**

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb18-5225-7571-8850-9e542d059bd1`.
- Enclosing turn: `019fbb18-50ad-7b12-bfb2-8edad772aae6`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:12:41.125Z`.
- Stored actor role: `user`.

Literal excerpt:

> C I think we need this decoupling; this is important

The `C` selects the immediately preceding shared-raw-extension option. The
later retained human correction that compatibility is client-side, followed
by “okay lets do A for now,” replaces this raw-wire choice with different MCP
wires and an identical client interface.

### Public turnId proposal rejected

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d569b2c848195a59055f32ac56b6e`.
- Enclosing turn: `019fbb19-faac-77e0-8489-1a5080e9cbf6`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:15:03.840Z`.
- Stored actor role: `assistant`.

Literal excerpt with architecture explanation and option detail omitted:

> ### D4 — How does the shared extension correlate concurrent replies?
>
> [omitted: explanation, stakes, and recommendation]
>
> A) **Introduce an opaque local `turnId`** (recommended)
>
> [omitted: option detail]
>
> B) **Allow exactly one outstanding turn per daemon**
>
> [omitted: option detail]
>
> C) **Keep generation-specific raw reply correlation**
>
> [omitted: option detail]
>
> **Pick A, B, or C.**

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb1c-15c1-7a52-a45c-dcd5cf1c9abe`.
- Enclosing turn: `019fbb1c-1427-7ac1-99a7-6d8d7a5c8c23`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:16:47.810Z`.
- Stored actor role: `user`.

Literal excerpt:

> I don't like turnId; maybe conversationId?

This rejects `turnId`. The mention of `conversationId` is a question, not an
accepted replacement correlation field.

### Subscription identity was raised as a question

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb1c-8dd3-7611-9bc2-c0f34cd3958b`.
- Enclosing turn: `019fbb1c-8c38-7512-ac6e-b3c64833c47e`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:17:18.548Z`.
- Stored actor role: `user`.

Literal excerpt:

> or we do actually know clients when they create subscriptions, so that
> should work. can you look through if previous ADRs discussed this

This is a question and an instruction to reconcile with prior ADRs, not an
accepted choice that a subscription identifies an individual reply. The later
different-wires answer avoids introducing a shared raw correlation field.

### Compatibility corrected to the client side

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb35-b27d-7cb0-9ff8-3530ccf5a252`.
- Enclosing turn: `019fbb35-b0ad-70a1-967a-47f418920708`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:44:46.333Z`.
- Stored actor role: `user`.

Literal excerpt:

> but then this isn't on the wire, this is just different implementations on
> the client isde

This correction directly precedes the retained different-wires/identical-client
prompt and answer.

### Different wires, identical client interface prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d5db534c08195968f487cb44d1d3b`.
- Enclosing turn: `019fbb0e-729d-7292-ad20-df5126663439`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:45:16.696Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> So the real choice is:
>
> - **A: Different MCP wires, identical client interface.**
> - **B: One shared MCP wire, which requires designing explicit per-turn
> correlation.**
>
> Your earlier “extensions can be different but clients should be
> similar” describes **A**.

This is an agent prompt, not a human decision.

### Different wires, identical client interface answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb36-cbcc-7df2-9f56-0c75af07ca60`.
- Enclosing turn: `019fbb36-ca5f-7992-9aee-c1091f72f420`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:45:58.348Z`.
- Stored actor role: `user`.

Literal excerpt:

> okay lets do A for now

The meaning of `A` is limited to the immediately preceding retained
prompt. The words `for now` are retained and not strengthened.

### EndpointClient meaning was clarified and approved

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb3b-7345-78f3-90d2-ea9a58e64d68`.
- Enclosing turn: `019fbb3b-68ff-72d2-b0ce-ce03e4232d1c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:51:03.374Z`.
- Stored actor role: `user`.

Literal excerpt:

> what do you mean client here

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d5f22f798819591eab8caffc81b83`.
- Enclosing turn: `019fbb3b-68ff-72d2-b0ce-ce03e4232d1c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:51:21.045Z`.
- Stored actor role: `assistant`.

Literal excerpt with diagram detail omitted:

> By “client,” I meant the **EndpointClient library running inside OpenClaw or
> NanoClaw**, not the daemon.
>
> [omitted: three-piece diagram]
>
> The EndpointClient SDK only:
>
> - Opens the subscription.
> - Decodes the generation-specific event.
> - Presents the stable Effect interface to OpenClaw/NanoClaw.
>
> The runtime adapter only:
>
> - Gives the context to the model.
> - Keeps the bound reply function with that model invocation.

This is an agent clarification, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb3c-2311-77b0-a980-719ce4e433cc`.
- Enclosing turn: `019fbb3c-210d-7731-b431-522a3f2573d1`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:51:48.370Z`.
- Stored actor role: `user`.

Literal excerpt:

> okay this looks good

The answer approves the immediately preceding definition: the client is the
library inside the runtimes, between the daemon MCP wire and the runtime
adapter. The later vocabulary changes its public name to `HarnessClient`
without moving that boundary.

### Independently owned implementation prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d69f877fc8195b9f67746b32c8c42`.
- Enclosing turn: `019fbb63-0ea1-7082-9b15-cc45b5710901`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:37:34.334Z`.
- Stored actor role: `assistant`.

Literal excerpt with option descriptions and an illustrative path block
omitted:

> ### D9 — Where should the generalized inbound implementation live?
>
> A) **Implement the same deep abstraction inside each endpoint owner**
> (recommended)
>
> [omitted: illustrative paths and option description]
>
> B) **Create a new shared production package**
>
> [omitted: option description]
>
> C) **Put the shared implementation in v2 and import it from v1**
>
> [omitted: option description]
>
> I recommend **A**: one contract and conformance suite, with two
> independently owned implementations. The duplication disappears when v1 is
> retired.

This is an agent prompt, not a human decision.

### Track labels rejected as public implementation names

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb66-804c-70f3-844a-5d0f056699a3`.
- Enclosing turn: `019fbb66-7dbc-7752-a407-47d7d727d7fc`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:38:04.748Z`.
- Stored actor role: `user`.

Literal excerpt:

> A; don't call them v1 or v2. those are internal names

The `A` selected the immediately preceding assistant option to keep the
same deep abstraction independently inside each endpoint owner. The
public naming correction is explicit in the retained human text.

### First application names were rejected

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d6a4427448195bb1296fb06e74879`.
- Enclosing turn: `019fbb66-7dbc-7752-a407-47d7d727d7fc`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:38:49.636Z`.
- Stored actor role: `assistant`.

Literal excerpt with the following decision prompt omitted:

> I’ll use:
>
> - `InboundApplication`: shared deep contract.
> - `DispatchLeaseApplication`: current production implementation.
> - `OpenFloorApplication`: Transcript/OpenFloor implementation.
>
> [omitted: following decision prompt]

This is an agent naming proposal, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb69-7ce9-72b2-a4a6-cd285404b7ed`.
- Enclosing turn: `019fbb69-7b95-7db2-b5dc-61d04710b557`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:41:20.489Z`.
- Stored actor role: `user`.

Literal excerpt:

> I also don't like those names BTW. those names are wrong

This rejects the three immediately preceding proposed application names. The
later retained vocabulary proposal and approval establish the replacement
names; this event supplies no additional replacement name by itself.

### Harness rename

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbba9-30b7-74f0-899c-73896c527e86`.
- Enclosing turn: `019fbba9-2f75-7601-9b0b-5d0515733e18`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:50:55.287Z`.
- Stored actor role: `user`.

Literal excerpt:

> I think we should rename v2/endpoint to v2/harness

### Deep rename

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbbae-51c3-7803-abfd-71b4c01c112b`.
- Enclosing turn: `019fbbae-4f2c-7d62-b5d9-d01a46466f65`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:56:31.427Z`.
- Stored actor role: `user`.

Literal excerpt:

> go deep and replace

### Umbrella Harness service was rejected as confusing

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbbbb-cd04-7ae1-835e-52cc2c29629d`.
- Enclosing turn: `019fbbbb-cb8a-7280-b6c1-6d3068d33a91`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:11:14.948Z`.
- Stored actor role: `user`.

Literal excerpt:

> - Harness — daemon-side Effect capability owning active agent semantics.
>   - HarnessClient — public adapter-facing client used by OpenClaw and NanoClaw.?

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d8010df108195b43502ffd0a1a26e`.
- Enclosing turn: `019fbbbb-cb8a-7280-b6c1-6d3068d33a91`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:11:48.408Z`.
- Stored actor role: `assistant`.

Literal excerpt with implementation detail omitted:

> Use one public Effect capability:
>
> - `Harness` — adapter-facing `Context.Tag`, analogous to `Registry` and
> `Router`.
>
> [omitted: implementation detail]

This is an agent proposal, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbbbc-4fe9-7d52-886f-2ff092539d50`.
- Enclosing turn: `019fbbbb-cb8a-7280-b6c1-6d3068d33a91`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:11:48.457Z`.
- Stored actor role: `user`.

Literal excerpt:

> confusing

This rejects the immediately preceding one-public-`Harness`-service proposal.
The next retained proposal separates `Harness` as the package/subsystem name
from public `HarnessClient`, and the human approves that replacement.

### Final vocabulary proposal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d802ed0588195a50e44b7257c390f`.
- Enclosing turn: `019fbbb8-67fe-7692-b183-159dc1c071ea`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:12:18.433Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> - `Harness` is the subsystem/package name only: `v2/harness`.
> - `HarnessClient` is the public adapter-facing Effect capability.
> - `moltzapd` is the daemon process.
> - There is no `Harness` service, `HarnessApplication`,
> `HarnessBootstrap`, or `HarnessManagement`.
> - Daemon internals use narrowly named private services based on their
> actual responsibility.

This is an agent proposal, not a human decision.

### Vocabulary approval

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbbc8-8810-7670-a0ba-6a02d6b08e53`.
- Enclosing turn: `019fbbc8-84e1-76f3-80ed-6906ff35486c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:25:09.264Z`.
- Stored actor role: `user`.

Literal excerpt:

> yes that looks good

The meaning of this answer is limited to the immediately preceding
retained vocabulary proposal.

## HarnessClient owns runtime context

### Custom client and cross-conversation context

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba76-81b9-7481-a39f-2b50c544bcdd`.
- Enclosing turn: `019fba74-fc3a-7640-9862-9c8887c65a98`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T23:15:56.473Z`.
- Stored actor role: `user`.

Literal excerpt:

> I think the server side is fine: to work with NanoClaw and OpenClaw
> we also need the custom client side? that client handle this and the
> other stuff like cross conversation context management that we
> discussed.

### Context ownership correction

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb68-fe7b-7103-a5d3-ac5ca1e8b626`.
- Enclosing turn: `019fbb68-fbc7-7c02-9d22-ee0f54bf877d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:40:48.123Z`.
- Stored actor role: `user`.

Literal excerpt:

> waut, the context should be on the client side rightwhy is that an SSE
> write

### Notifications name their source conversation

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb70-7315-7b32-b6fd-f2df0c84426d`.
- Enclosing turn: `019fbb70-70e4-7a40-ab62-dbd893b4470c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:48:56.725Z`.
- Stored actor role: `user`.

Literal excerpt:

> I think the point is the notification should basically tell you which
> conversation what came from; and the client can know if the message was
> from it's own conversation then it can talk right now, else not

### Restart choices prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d77f8520c8195bc15eea39fbfc01a`.
- Enclosing turn: `019fbb98-9a8a-7d41-97d9-097b9900f993`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:37:27.150Z`.
- Stored actor role: `assistant`.

Literal excerpt with option descriptions omitted:

> ### D13 — What happens to buffered context after EndpointClient
> restart?
>
> A) **Start with an empty context buffer** (recommended for this slice)
>
> [omitted: option description]
>
> B) **Persist the EndpointClient context buffer locally**
>
> [omitted: option description]
>
> C) **Rebuild context using search/read tools**
>
> [omitted: option description]

This is an agent prompt, not a human decision.

### Empty-on-restart answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb9d-03e4-7511-bfa1-1f273eb0865a`.
- Enclosing turn: `019fbb9d-0319-77f3-bb4e-b506d55b1d9f`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:37:37.381Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained restart
prompt. The next retained human event begins with `actually`, adds local
cursor storage, and selects `C`; it reverses this empty-on-restart answer.

### Local cursors and history rebuild answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb9d-59cc-7683-a137-4c9c8abe48c8`.
- Enclosing turn: `019fbb9d-57bd-7c22-81a9-199e478129a6`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:37:59.372Z`.
- Stored actor role: `user`.

Literal excerpt:

> actually store the cursors etc. locally and then use C

The reference to `C` is limited to the immediately preceding retained
prompt. The request also adds local cursor persistence to that option.

### Checkpoint advancement prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d7851b37481958d31718145f6ac38`.
- Enclosing turn: `019fbb98-9a8a-7d41-97d9-097b9900f993`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:38:48.488Z`.
- Stored actor role: `assistant`.

Literal excerpt with setup, other-option detail, and recommendation omitted:

> ### D14 — When should context cursors advance?
>
> A) **Immediately before emitting the constructed turn to the runtime**
> (recommended)
>
> - Context is presented at most once under normal operation.
> - A crash after the cursor update but before runtime receipt can lose that
> context.
>
> B) **After the runtime accepts the turn**
>
> C) **After the model replies**
>
> [omitted: setup, descriptions of options B and C, and recommendation]

This is an agent prompt, not a human decision.

### Checkpoint advancement answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb9e-4488-7573-a2ac-937b951dd411`.
- Enclosing turn: `019fbb9e-43d1-7021-9bbe-437f2b23762d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:38:59.464Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained
prompt.

### Stable checkpoint prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d788a30988195a02201507124486f`.
- Enclosing turn: `019fbb98-9a8a-7d41-97d9-097b9900f993`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:39:42.795Z`.
- Stored actor role: `assistant`.

Literal excerpt with the preceding D14 confirmation, other-option detail, and
recommendation omitted:

> ### D15 — What exactly should be stored locally?
>
> A pagination cursor and a durable reading position are different:
>
> - `nextCursor`: “fetch the next page of this current read.”
> - `checkpoint`: “I have already used messages through this position.”
>
> A) **Persist a stable per-conversation checkpoint** (recommended)
>
> ```text
> target conversation A
>   source conversation B → consumed through position 42
>   source conversation C → consumed through position 19
> ```
>
> `read_conversation` always returns a stable checkpoint. Temporary
> `nextCursor` values are used only while paging through one rebuild.
>
> B) **Persist `nextCursor` directly**
>
> C) **Persist the last MessageId**
>
> [omitted: the preceding D14 confirmation, descriptions of options B and C,
> and recommendation]

This is an agent prompt, not a human decision.

### Stable checkpoint answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbba1-47b7-7f22-9b2d-e30a36011bc5`.
- Enclosing turn: `019fbba0-1279-7873-b5f3-ece3eab61928`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:42:16.888Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained
prompt.

### Redundant conversation wrapper rejected

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbe12-4f63-7143-b38a-372277a4ac84`.
- Enclosing turn: `019fbe12-4d8d-7c83-b3ff-0898c0351c97`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T16:04:58.851Z`.
- Stored actor role: `user`.

Literal excerpt:

> ```ts
> interface HarnessConversationSummary {
>   readonly conversationId: string
>   readonly members: readonly HarnessAgent[]
> }
> ```

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbe12-6676-77a1-a3c3-ee0c5fa09564`.
- Enclosing turn: `019fbe12-640f-7202-b557-afcbf7cb6a65`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T16:05:04.758Z`.
- Stored actor role: `user`.

Literal excerpt:

> i don't understand this

These events identify the exact candidate wrapper being challenged. The next
retained human event rejects the need for that interface rather than merely
requesting a prose explanation.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbe13-4e72-7311-a85a-f21aea703e3d`.
- Enclosing turn: `019fbe13-4d2d-7e92-aae2-5b220b8b16bb`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T16:06:04.147Z`.
- Stored actor role: `user`.

Literal excerpt:

> so why do you even need that interface. conversationId types alreayd
> exist

### ID-only result proposed after wrapper rejection

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6e19788e88819582f84362a7ab9ef8`.
- Enclosing turn: `019fbe13-4d2d-7e92-aae2-5b220b8b16bb`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T16:06:19.810Z`.
- Stored actor role: `assistant`.

Literal excerpt with the following `read_conversation` prose and implementation
commitment omitted:

> We don’t need it. It was an unnecessary wrapper introduced only to give
> `search_conversations` a uniform result shape, but it invents a second
> conversation model and weakens the existing `ConversationId` contract.
>
> I’ll remove `HarnessConversationSummary` entirely. The shared surface will
> paginate existing IDs:
>
> ```ts
> search_conversations(...) -> {
>   conversationIds: readonly ConversationId[]
>   nextCursor?: string
> }
> ```
>
> [omitted: following `read_conversation` prose and implementation commitment]

This is an agent proposal, not a human decision. The next retained human event
questions the ID-only result.

### Conversation results question

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbe14-008c-7b92-a9f5-6174dc3a84a2`.
- Enclosing turn: `019fbe13-fccc-7b62-bc59-fa7b5e669817`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T16:06:49.740Z`.
- Stored actor role: `user`.

Literal excerpt:

> conversationIds: readonly ConversationId[] should be conversation[]
> not conversastionId[]?

This event is a question. No later human event in the located session
explicitly answers it.

### Conversation result answer proposed by the agent

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6e19a67bc88195860a7be701bab483`.
- Enclosing turn: `019fbe13-fccc-7b62-bc59-fa7b5e669817`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T16:07:04.523Z`.
- Stored actor role: `assistant`.

Literal excerpt with the `read_conversation` example omitted:

> Yes. If the existing `Conversation` type is the bounded conversation
> descriptor, search should return it directly:
>
> ```ts
> search_conversations(...) -> {
>   conversations: readonly Conversation[]
>   nextCursor?: string
> }
> ```
>
> [omitted: `read_conversation` example]
>
> No `HarnessConversationSummary`, no replacement `HarnessConversation`, and
> no ID-only result invented for the MCP layer. The shared surface should
> reuse the existing domain types.

This is an agent answer to a human question, not a later human acceptance.

### In-memory turn serialization challenged

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbe98-201e-7303-86a1-f30459b3d938`.
- Enclosing turn: `019fbe98-1eff-7532-8a25-db3938fcb5fa`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T18:31:08.574Z`.
- Stored actor role: `user`.

Literal excerpt:

> `turnEncodedBytes` measures the UTF-8 length of the JCS encoding of that value
> under the track-owned closed Conversation, HarnessAgent, ContextEntry, and
> ContentPartV1 Schemas. It excludes the non-serializable `reply` closure and all
> private backing authority. A grant-only turn whose empty-context
> `HarnessTurnData` cannot fit fails the listen stream with
> `HarnessResultTooLargeError`, emits no turn, and advances no checkpoint.
> why do we need all this

The excerpt omits the immediately preceding line-numbered copy of the
`HarnessTurnData` interface, whose fields were `conversation`,
`currentContext`, and `crossConversationContext`. The omission is explicit;
spelling and punctuation in the retained question are literal. This event is a
question. The later scope-correction events below answer it by excluding the
proposed second serialization contract.

### First simplification response still proposes new limits

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6e3b857f708195b71eb0a0f8299528`.
- Enclosing turn: `019fbe98-1eff-7532-8a25-db3938fcb5fa`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T18:31:36.379Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> We don’t need it. I added that only to make an invented
> `turnEncodedBytes` limit mechanically testable, but it creates a second
> serialization contract for an in-memory value—and `HarnessTurn` is not a
> wire value.
>
> The cleaner contract is:
>
> - MCP request/response/event byte limits bound the raw wire.
> - Per-turn entry/source counts bound client context assembly.
> - Each entry is already complete and individually bounded.
> - Model-context/token budgeting belongs to the runtime adapter, not
> `HarnessClient`.
>
> I’m removing `turnEncodedBytes`, `HarnessTurnData`, and the corresponding
> grant-only size failure.

This is an agent proposal, not a human decision. Its replacement
entry/source-count limits are among the later candidate-only details excluded
by the retained scope correction.

### Overcomplication challenged

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbeae-771e-7d83-9856-814bc926c104`.
- Enclosing turn: `019fbeae-7629-7160-a08b-4028fc32b631`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T18:55:32.638Z`.
- Stored actor role: `user`.

Literal excerpt:

> are you overcomplicating this

### Stable-contract scope correction prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6e414afbcc81959d6b578760fdb360`.
- Enclosing turn: `019fbeae-7629-7160-a08b-4028fc32b631`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T18:56:14.764Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Yes. I crossed from defining the stable interface into prematurely designing
> buffering, byte accounting, cursor recovery, and cache internals.
>
> The stable contract only needs:
>
> - one `moltzapd` with `/register/mcp` and `/mcp`;
> - backing-specific MCP wires;
> - structurally compatible `HarnessClient` implementations;
> - notifications identify the conversation and may carry reply authority;
> - client-owned presentation checkpoints and cross-conversation context;
> - one live authority per conversation;
> - `startConversation(...)` and turn-bound `reply(payload)`;
> - no generic send or bespoke CLI.
>
> `HarnessTurnData`, turn serialization, reconciliation-marker algorithms,
> exhaustive config keys, and most exact internal overflow mechanics do not
> belong in this ADR. They should be implementation choices or explicitly
> deferred. I should collapse the candidate back to that boundary before
> review.

This is an agent proposal, not a human decision.

### Stable-contract scope correction answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbeaf-8633-7e42-bf60-c9db136f911b`.
- Enclosing turn: `019fbeaf-8574-7633-93a4-9207ddcb23d0`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T18:56:42.035Z`.
- Stored actor role: `user`.

Literal excerpt:

> yes.

The meaning of `yes.` is limited to the immediately preceding retained
prompt.

### Existing implementation decisions must not be redesigned

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbeaf-deea-73a0-9e4e-383182d74ab0`.
- Enclosing turn: `019fbeaf-de30-7862-bee3-73ace0bf2d03`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T18:57:04.747Z`.
- Stored actor role: `user`.

Literal excerpt:

> yes, implementation is something we already decided and I feel you are
> changing things again

### Agent commits to preserve settled mechanics

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6e418e8d648195bed9725ab3fc69fa`.
- Enclosing turn: `019fbeaf-de30-7862-bee3-73ace0bf2d03`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T18:57:20.393Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> You’re right. I treated already-settled implementation mechanics as gaps
> and started redesigning them. I’m backing out that invention now: I’ll
> preserve the existing implementation decisions and limit this change to the
> agreed vocabulary, process boundary, MCP/client interface, and explicit
> supersessions. No new buffering, retry, byte-budget, persistence, or
> configuration design.

This is an agent execution commitment, not an additional human decision.

### Transcript is the implementation-scope boundary

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbeb3-0e41-7e62-89a4-5b543e31c546`.
- Enclosing turn: `019fbeb2-04d9-7882-a27a-13a942551f75`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T19:00:33.473Z`.
- Stored actor role: `user`.

Literal excerpt:

> compare against the actual transcripts too. if we have not discussed some
> design decisions or failure modes THOSE ARE NOT IN SCOPE for this
> implementation

### Agent applies the transcript boundary

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6e4257071c81958acd91690bfc829f`.
- Enclosing turn: `019fbeb2-04d9-7882-a27a-13a942551f75`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T19:00:41.218Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Yes. I’ll treat the actual transcript as the scope boundary: a failure
> mode, limit, retry rule, storage algorithm, wire field, or configuration
> choice stays out unless the transcript explicitly decided it or an
> already-accepted ADR already owns it. I’m now reconciling the candidate
> against both sources and will preserve settled implementation mechanics
> instead of redesigning them.

This is an agent execution commitment, not an additional human decision.

## Inbound content and reply authority are separate

### Mega-PR answer immediately replaced by two slices

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d528ef55081959cd934ee8ef700bc`.
- Enclosing turn: `019fbb01-7e8e-7e00-b8dd-f2012ed631db`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T01:57:51.394Z`.
- Stored actor role: `assistant`.

Literal excerpt with findings and option detail omitted:

> ### D1 — How should we land the operational program?
>
> [omitted: findings, explanation, and stakes]
>
> A) **Stacked slices, one public cutover** (recommended)
>
> [omitted: option detail]
>
> B) **Ship a read/control vertical first**
>
> [omitted: option detail]
>
> C) **One complete mega-PR**
>
> [omitted: option detail]
>
> **Pick A, B, or C.**

This is an agent prompt, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb0d-9b6e-7aa3-86d6-e077cb4605a9`.
- Enclosing turn: `019fbb0d-9749-7362-b0a1-e88dfd7f83f9`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:00:58.990Z`.
- Stored actor role: `user`.

Literal excerpt:

> C

The meaning of `C` is limited to the immediately preceding retained prompt.
The next retained human event starts with `actually` and specifies two slices;
it replaces this mega-PR answer.

### Dispatch and model output split

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb0e-73c5-7b13-8d10-529103db8952`.
- Enclosing turn: `019fbb0e-729d-7292-ad20-df5126663439`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:01:54.373Z`.
- Stored actor role: `user`.

Literal excerpt:

> actually lets do two slices: one which is the model output side that
> we have already discussed, one is the dispatch size which we should
> focus o n now. \

### Same-conversation concurrency rejected

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb3e-d7cc-7322-9b78-97b290060a8b`.
- Enclosing turn: `019fbb3c-210d-7731-b431-522a3f2573d1`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:54:45.710Z`.
- Stored actor role: `user`.

Literal excerpt:

> The server already permits multiple simultaneous leases, even in the
> same conversation; this should not be possible actually

### Busy behavior prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d605b05b48195a5fb2c38ecaa8ab7`.
- Enclosing turn: `019fbb0e-729d-7292-ad20-df5126663439`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:56:35.076Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> ### D6 — What happens to a second request for the same conversation?
>
> A) **Return `conversation_busy` without creating another lease**
> (recommended)
>
> B) **Attach the request to the existing lease**
>
> C) **Queue the second request inside the server**

This is an agent prompt, not a human decision.

### Busy behavior answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb43-0d32-77f0-8f4f-b51e3582614c`.
- Enclosing turn: `019fbb43-0c01-70c0-aca2-f42d0aaf8bc0`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:59:21.522Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained
prompt.

### Busy behavior answer repeated after interruption

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb43-7396-7901-b59e-817d26e6d6cb`.
- Enclosing turn: `019fbb43-7284-7672-b25d-dacf55a2181e`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T02:59:47.735Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The preceding `A` turn was interrupted. This repeated `A` selects the same
retained `conversation_busy` option and does not add a second decision.

### Local retry prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d6169f8708195a000fca378cbaedf`.
- Enclosing turn: `019fbb0e-729d-7292-ad20-df5126663439`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:01:03.264Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> ### D7 — How should the daemon handle `conversation_busy`?
>
> A) **Park locally and retry when the conversation becomes available**
> (recommended)
>
> B) **Retry every few seconds**
>
> C) **Drop the blocked inbound work**

This is an agent prompt, not a human decision.

### Local retry first answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb63-155b-7fc3-b84d-bad989c0bf72`.
- Enclosing turn: `019fbb63-0ea1-7082-9b15-cc45b5710901`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:34:20.763Z`.
- Stored actor role: `user`.

Literal excerpt:

> C

The meaning of `C` is limited to the immediately preceding retained
prompt.

### Local retry reversal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb63-f985-79a1-abb2-3ce77adb2512`.
- Enclosing turn: `019fbb63-f5b3-7f93-975a-8c647a93ee82`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:35:19.174Z`.
- Stored actor role: `user`.

Literal excerpt:

> fine to keep A

The reference to `A` reverses the directly preceding `C` answer and is
limited to the retained local-retry prompt.

### Separate-ADR prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d69a24d908195b38440a080915b52`.
- Enclosing turn: `019fbb63-0ea1-7082-9b15-cc45b5710901`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:36:07.643Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> ### D8 — How should we record the two runtime slices?
>
> A) **Separate dispatch and model-output ADRs** (recommended)
>
> B) **One combined runtime-interface ADR**
>
> C) **Only update the endpoint specification**

This is an agent prompt, not a human decision.

### Separate-ADR answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb65-c2d7-70b0-bce7-6c322ea4635a`.
- Enclosing turn: `019fbb65-c210-7803-8016-ba11f105c8d9`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T03:37:16.248Z`.
- Stored actor role: `user`.

Literal excerpt:

> A

The meaning of `A` is limited to the immediately preceding retained
prompt.

### Content-only notification prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d775244888195b6cd27dbf8a7026a`.
- Enclosing turn: `019fbb98-9a8a-7d41-97d9-097b9900f993`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:34:34.268Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> ### D12 — Notify about messages without a reply grant?
>
> I recommend **yes**. Otherwise the EndpointClient never learns about
> messages that should later become cross-conversation context.
>
> - Granted notification: remember messages and invoke the model.
> - Ungranted notification: remember messages only.
> - Repeated MessageIds: deduplicate client-side.

This is an agent prompt, not a human decision.

### Content-only notification answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbb9b-6c03-7840-a79c-efbebcfbe608`.
- Enclosing turn: `019fbb9b-6a1f-7dc2-b76b-85f9ea2645ce`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T04:35:52.963Z`.
- Stored actor role: `user`.

Literal excerpt:

> yes

The meaning of `yes` is limited to the immediately preceding retained
prompt.

## Model output is start or bound reply

The heading matches the admitted decision that links here. The source events
below directly support conversation start, bound reply, and complete send
removal; they do not make atomic START a new session decision, as the
source-gap section records. Clean-slate atomic START remains inherited from its
earlier accepted owner.

### Reply carries only payload

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fba74-fd35-78a1-9b93-b9df0cf50989`.
- Enclosing turn: `019fba74-fc3a-7640-9862-9c8887c65a98`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T23:14:17.013Z`.
- Stored actor role: `user`.

Literal excerpt:

> replyToken is not a field that we have right now. neither is action
> id; so for now reply can just be payload?

This event is a question and includes the qualifier `for now`.

### Payload-only reply answer proposed by the agent

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d2c50390881958e1127a45a085cd3`.
- Enclosing turn: `019fba74-fc3a-7640-9862-9c8887c65a98`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-31T23:14:25.945Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Yes—that is the better minimal v1 contract. I’ll revise the plan so
> correlation remains internal to the scoped `listen` turn: the consumer
> receives a turn-specific reply function/capability and calls
> `reply(payload)`, while the v1 Layer privately consumes the associated
> dispatch lease. I’m checking the exact ADR wording before updating the
> persisted issue.

This is an agent answer, not a human decision. The later retained
stable-contract prompt includes turn-bound `reply(payload)`, and the human
answers that complete prompt with `yes.`; the original `for now` qualifier is
still preserved in this ledger.

### Generic send removal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbaa1-1e06-7cb3-8011-92d5de109a9a`.
- Enclosing turn: `019fbaa0-453f-7e63-842e-15d65d77c08e`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:02:28.998Z`.
- Stored actor role: `user`.

Literal excerpt:

> lets remove send from v1 too

### Generic send removal clarified

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbaa2-8c81-7f51-a106-7b92d66c1679`.
- Enclosing turn: `019fbaa2-8b7e-72a2-826c-69c07a6bcb43`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:04:02.818Z`.
- Stored actor role: `user`.

Literal excerpt:

> remove it completely

### Atomic-start formulation

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d3b967a8081959a010f454498057e`.
- Enclosing turn: `019fbaa0-453f-7e63-842e-15d65d77c08e`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T00:20:14.670Z`.
- Stored actor role: `assistant`.

Literal excerpt from an assistant-proposed plan, with unrelated plan sections
omitted:

> - Remove generic send completely from MoltZap: no CLI command, local
> RPC, MCP tool, client method, compatibility alias,
> `agent/message/send`, or arbitrary existing-conversation send.
>
> - `agent/conversation/start`
>   - Input: existing `appId`, optional name, nonempty participant
>   AgentIds, and required message parts.
>   - Creates the fixed initial membership and initial message
>   atomically.
>   - Authorization deny/timeout, validation failure, or database failure
>   commits neither.

This is an agent proposal, not a human decision. No later located human
event states the all-or-nothing start formulation in those words.

### ADR process requested

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbe11-c676-7983-877c-e18ce6afa88d`.
- Enclosing turn: `019fbe11-c4a8-7a03-9393-fdf18efab47c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T16:04:23.799Z`.
- Stored actor role: `user`.

Literal excerpt:

> run the ADR process and review now

### Behavior-first test boundary approved before later simplification

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d8390869881959e326b27dfc8bdaf`.
- Enclosing turn: `019fbbc8-84e1-76f3-80ed-6906ff35486c`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:26:49.805Z`.
- Stored actor role: `assistant`.

Literal excerpt with the flow diagram and most table rows omitted:

> The behavior-first test boundary is now:
>
> [omitted: flow diagram]
>
> | Level | What it proves |
> |---|---|
> | Unit | Conversation reservation, mailbox retry, context grouping,
> content/grant deduplication, bound-reply state, checkpoint updates |
> | Server integration | Same-conversation requests yield one lease plus
> `conversation_busy`; different conversations progress concurrently |
> | MCP integration | Real loopback HTTP/SSE, acknowledgment ordering, one
> listener, complete frames, disconnect cleanup |
> | Restart integration | Real atomic checkpoint file, paginated history
> rebuild, and no grant/model invocation from history |
> [omitted: remaining test-level rows]
>
> Import or constructor inspection will not be presented as unit testing. Those
> restrictions belong to static architecture checks.
>
> The output/reply round trip remains in the model-output slice; this ingress
> slice stops after the runtime receives a valid bound turn. The remaining
> review items are finite queue/frame/checkpoint bounds, overload behavior,
> crash semantics, and rollout ordering.

This is an agent proposal, not a human decision.

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator: `msg_019fbbe2-ff58-74c0-98ca-ae067337ac44`.
- Enclosing turn: `019fbbe2-fbc7-7512-9f58-cd367eff5222`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:54:03.736Z`.
- Stored actor role: `user`.

Literal excerpt:

> looks good

The answer approves the immediately preceding test boundary, not the finite
profile proposed three minutes later. The later stable-contract correction
still retains behavior-level unit/integration/architecture classification but
scope-excludes the candidate-only atomic checkpoint-file, bound-reply-state,
and exhaustive failure-mechanism detail.

### Finite ingress profile proposed without human acceptance

- Source system: Codex CLI rollout JSONL.
- Source session: `019fba0c-9f1e-7911-9496-45b305a00cb5`.
- Native locator:
  `msg_071e099ee77164a6016a6d8aaf66208195ab7a61de0a1f34a0`.
- Enclosing turn: `019fbbb8-67fe-7692-b183-159dc1c071ea`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-08-01T05:57:11.797Z`.
- Stored actor role: `assistant`.

Literal excerpt with the proposed numeric table and its following prose
omitted:

> The performance pass recommends this finite ingress profile as new
> ADR-level behavior:
>
> [omitted: proposed numeric ingress-profile table and following prose]

This is an agent proposal. No later located human event accepts its values.
The latest scope instruction makes the proposed profile out of scope for this
implementation.

## Source gaps, inherited mechanics, and excluded candidate detail

- The exact `/register/mcp` plus `/mcp` formulation appears in the retained
  stable-contract assistant prompt, and the human answers that complete prompt
  with `yes.`. Earlier human events separately call for one MCP server, a
  separate registration MCP path, and one daemon that handles both
  responsibilities. This ledger does not add lifecycle states, transition
  timing, or route-specific failure behavior to that boundary.
- The human first accepts an exact `{start_conversation, reply}` tool proposal
  with “do that.” The immediately following registration-path decision and the
  later instruction that the other former CLI features become MCP tools expand
  that inventory, while complete send removal preserves the absence of generic
  `send_message`. The bespoke CLI is replaced by standard MCP tooling; the
  early exact-two-tool equality is not current for the combined management and
  runtime server.
- The human correction classifies import/constructor bans as architecture
  checks and real transport/process behavior as observable integration work,
  not unit tests. The later approved behavior-first test boundary preserves
  that classification; its candidate-only checkpoint-file and bound-reply
  internals are removed by the final simplification.
- The human `translate` answer keeps existing production handlers and business
  logic authoritative while the transport and adapter boundary change. The
  official-SDK `A` answer and later FastMCP `C` answer select the official MCP
  SDK boundary. No retained later event reverses either choice.
- The early atomic-cutover `B` and later mega-PR `C` are both followed by the
  explicit human correction “actually lets do two slices.” The current
  execution shape is therefore the dispatch/ingress and model-output split,
  not a one-revision mega-PR. This trajectory does not infer a separate public
  rollout strategy beyond those two implementation slices.
- The initial `4A` answer selected a portable runtime capability separated
  from production administration. The later one-server and vocabulary answers
  replace the public `EndpointRuntime` and `V1EndpointAdmin` names with one
  public `HarnessClient` and private, responsibility-named daemon services.
  They do not collapse the adapter-facing portability boundary into daemon
  internals.
- The production-registration `5A` answer explicitly requires the existing v1
  HTTP registration flow to use a stable OperationId and client-owned
  recoverable credential, persist intent before contacting the server, and let
  identical retries recover the same AgentId and credential after process or
  machine failure. That #926 decision is not a clean-slate Registry decision
  and belongs on `main`. The following human response to D10 says only
  “minimal change; borrow v2 semantics if we can”; the agent, not the human,
  interprets it as exact `6A`. Therefore credential generation, the exact
  staging or storage representation, server receipt, verifier, request
  fingerprint, and changed-input conflict behavior are not admitted by this v2
  candidate. The production execution issue must retain all selected `5A`
  requirements while resolving those exact main-branch mechanics under
  production authority.
- The human explicitly says to replace `list_*` with `search_*` and says the
  results are paginated. Empty-query behavior is phrased as a question. The
  assistant then proposes omitted/empty-query browsing and a cursor-shaped
  page, and the human asks to update the issue “with all of this”; no human
  event separately restates the browse rule. Exact matching, whitespace
  normalization, ordering, page sizing, cursor authentication or binding,
  query/cursor exclusion, and search-specific error behavior are not decided
  by a retained human event and are out of this implementation.
- The rejection of `HarnessConversationSummary` and any other redundant
  Harness conversation wrapper is explicit. Returning existing
  `Conversation[]` is a human question followed by an assistant answer, with
  no later human acceptance in the located source. The ledger does not turn
  that question into a human decision. A new `Conversation` DTO, timestamps,
  Ledger read-view persistence, or an ID-only replacement wrapper is not
  supported by this source and is out of this implementation.
- The retained events select the semantic `HarnessClient` operations and
  boundary plus management tool names, ownership, and pagination, but no
  complete Effect method/stream/result/error signatures or complete
  `register`, `status`, `search_*`, and `read_conversation` MCP request/result
  Schemas; the exact structural canary and those wires therefore remain
  outside implementation scope until their owners admit them.
- The first payload-only reply event retains the qualifier `for now`. The
  agent answers it with a turn-bound `reply(payload)` proposal, and the later
  stable-contract prompt repeats turn-bound `reply(payload)` before the human
  answers `yes.`. That supports the portable client boundary. It does not
  support a new client-side join, single-assignment, disconnect-invalidation,
  changed-payload, or outcome-unknown state machine.
- The retained clean-slate grant may advertise multiple legal actions, while
  the selected portable boundary exposes only `reply(payload)`. No retained
  human event decides how that closure selects an action when more than one is
  legal. This trajectory therefore does not authorize a default, ordering
  rule, inferred mapping, or new selector; action selection remains an
  unresolved contract gap rather than implementation scope.
- Atomic START appears only in retained assistant plan text; no located human
  event states its all-or-nothing or failure semantics in those words. The
  later human instruction says implementation mechanics were already decided.
  This session therefore does not create a new START contract or authorize a
  redesign of the START mechanics owned by current accepted ADRs and specs.
- The retained events choose backing-specific MCP wires behind compatible
  clients. The human first asks for backing-specific applications and allows
  different server extensions with similar clients, later approves the
  definition of that client as the library inside OpenClaw or NanoClaw, and
  finally selects different MCP wires behind an identical client interface
  “for now.” They do not assign a replacement discovery key, listen filter,
  notification method, wire field set, terminal result, or error envelope.
  The earlier `C` answer selecting one shared raw extension is expressly
  replaced by the later client-side correction and “okay lets do A for now.”
  The proposed public `turnId` is rejected, while `conversationId` is posed as
  a question rather than accepted as replacement reply correlation.
  The retained receive-contract prompt and answer explicitly keep the existing
  at-most-once, transient granted-turn dispatch and reject reliable delivery
  for this work. The exact accepted MCP framing, listener, acknowledgment, raw
  reply-correlation, receipt, and reconciliation mechanics remain inherited
  from their current ADR/spec owners. That includes the accepted
  `xyz.moltzap/events-v1` discovery extension,
  `{"xyz.moltzap/turnReady": true}` filter, and
  `notifications/xyz.moltzap/turn_ready` method, plus the existing clean-slate
  raw `reply(TxnId, actionId, payload)` and its
  `(TxnId, actionId, payload)` reply fingerprint. The portable
  `reply(payload)` closure does not replace them. A new raw MCP extension, an
  added raw reply `ConversationId`, or any other changed raw reply tuple is out
  of this implementation.
- No retained human event reopens the accepted OpenFloor action semantics,
  Registry bootstrap contract, Ledger/Transcript representations, daemon
  protocol recovery state, or resource-limit deferrals. They remain inherited
  mechanics; this trajectory supplies no basis for changing them.
- The human decisions reach stable local presentation checkpoints, local
  cursor storage, history-based context rebuild, and advancement immediately
  before client emission. The initial empty-on-restart `A` is explicitly
  reversed by “actually store the cursors etc. locally and then use C.” They
  do not reach a checkpoint file format,
  sharding or single-file layout, temporary-file protocol, `fsync`/rename
  sequence, locking, quota, corruption policy, reconciliation marker,
  rescan/backfill algorithm, or exact checkpoint encoding. Those mechanisms
  are out of this implementation.
- The retained same-conversation exchange selects `conversation_busy` without
  a second lease and later reverses to local park-and-retry. It does not select
  retry intervals, safety timers, queue bounds, cleanup deadlines, capacity
  registries, or other retry and overload mechanics. Those additional choices
  are out of this implementation.
- No located human event accepts the retained finite ingress-profile proposal.
  Exact request, frame, result, context, cache, mailbox, lease-registry, or
  active-turn limits; N+1 refusal; byte accounting; safe-integer refinements;
  backpressure; fit-at-startup checks; and overflow behavior are therefore out
  of this implementation. Existing accepted resource-limit deferrals remain
  inherited rather than silently closed here.
- No located human event assigns exact Effect Config keys,
  `HarnessProfileRef` fields, Layer constructor dependencies, daemon lifecycle
  states, activation deadlines, readiness categories, network timeout scopes,
  exhaustive portable error unions, or per-tool error matrices. Those design
  and failure-mode choices are out of this implementation. This v2 candidate
  does not introduce a clean-slate registration staging or recovery algorithm;
  the accepted Registry contract remains authoritative, while the distinct
  production `5A` requirement stays with #926 on `main`.
- The source session discusses production and clean-slate applications, but it
  does not alter branch authority. Production-line changes remain owned by
  `main`; this v2-track trajectory cannot admit them.
- The source metadata does not identify the human account holder. The ADR
  `decision-makers` field records accountable maintainers and is not proof
  that the session account authored every rationale in an ADR.
- No motive, confidence, urgency, or rationale is inferred for any source gap
  above.
