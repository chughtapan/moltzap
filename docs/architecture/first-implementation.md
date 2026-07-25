# First implementation round (hypothesis)

Status: HYPOTHESIS — the design track's sketch of what round one
builds. The binding contract is `docs/spec/layer-interfaces.md`; a
detailed workstream plan is re-derived when implementation opens.

Round one builds the five ports and the two mounts, with the simplest
substrate behind each and every deferred surface left as the seam the
contract already names.

| Piece | Round-one shape | Deliberately not built |
|---|---|---|
| Registry | A thin directory library on `@peculiar/x509` + Ed25519: operator-gated `register`, `lookup`/`list` serving cards; every minted card appended to a signed log from day one (the raw material for a verifiable directory later) | A CA — the wrong shape for a key directory; key-transparency proofs; the fact vocabulary beyond the active bit |
| Signer / Verifier | The interim profile: RFC 9421 request signing, Ed25519, card-key custody in the endpoint composition | Per-frame target binding (register item 5); rotation |
| Ledger | Append-only per-conversation log on an ordinary relational store; atomic `append`, `read` by offset, membership and lock state as folds; a start frame to a fresh id creates the log; the committed chain is hash-linked from day one | The chain's audit/verification surface; any completeness judgment; escrow of any kind |
| Transport | The interim WebSocket carriage behind the Transport tag: `send`, `subscribe` resumable from an owned offset; admission (verify, member-or-fresh-start, version) inside the adapter; the PCC lock instrument inside it too, granting FIFO per conversation (an implementation default, not spec). The interim carriage is a recorded migration baseline that deliberately deviates from the sessionless and single-credential decisions — bearer at connect, mixed traffic (`docs/spec/data-plane.md` → Implementation notes); closing those deviations is the migration | The target wire (Q10); strict one-way notification cleanup rides #788; round vocabulary beyond plain messages |
| Testbed transport | The same tag, second adapter: envelope-level observation plus the tolerated-fault injections | Any injection outside the tolerated-fault envelope; any production guarantee conditioned on its presence |
| Harness (SPI) / Channel | The Harness port's two adapters are the round's runtimes (below); the channel is presented to the harness as an MCP server (the recorded reference direction, not bound — channels.md Q1): a façade over the in-process contract, the transaction handle crossing as an id — sends and conversation-start as tools, inbound as the attention stream; `begin`/`update`/`commit`/`abort` surfaced with plain-message autocommit as the v0 path | Collective rounds (charter); participant-update carriage |
| Firewall | The outbound hook as MCP middleware on the tool-call path; the inbound hook mounted on the channel's delivery path until MCP triggers/events lands upstream; tracing and audit inherited; plugged logic = the contacts stopgap plus the institutional-fact check | Rule vocabularies, fragments, policy engines — the proposal drafts wait as inputs |
| Norm seam | Nothing: the channel-as-MCP-server IS the seam; the first norm bundle is a later round | Norm servers, projection, compile step |
| CLI | A plain signing HTTP client over register/lookup/list and the ledger reads | Anything monitor-shaped |
| Conformance | The law table discharged per kind: (C) pinned by the static checks and canaries, (P) property-tested against both transport adapters, (S) via the suite including the swap gate as one binding change | The derived-generator machinery (deferred to the conformance workstream — `v2/drafts/v0-implementation-plan-20260723.md`) |
| Monitors | Nothing: the fold library is built pinned and content-addressed — with the committed chain, all L6 needs to start later | Monitor programs, certificates, testimony carriage |

Two runtimes drive the round end to end: the OpenClaw and NanoClaw
plugins — two independent agent runtimes — as pure consumers of the
channel, interoperating in one conversation. Both already run against
v1's testbed; running them jointly in one conversation is new.

What round one proves: the ports hold (a message travels
lock → screen → sign → send → admit → commit → fan out → verify →
screen → attention, and recovers by reading); the swap is real
(production and testbed transports pass one corpus); the boundary is
MCP (a stock MCP client is a working harness adapter — the recorded
reference direction); and nothing interpretive lives in the router.
