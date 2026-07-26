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
| Signer / Verifier | The interim profile: RFC 9421 request signing, Ed25519, card-key custody in the endpoint composition. Recipients inherit the router's admission-time verification; offline per-message re-verification arrives with the target binding (`docs/spec/identity.md` → Implementation notes) | Per-message target binding (register item 5); rotation |
| Ledger | Append-only per-conversation log on an ordinary relational store; atomic `append`, `read` by offset, membership as a fold over recorded actions; a start message to a fresh id creates the log; the committed chain is hash-linked from day one | The chain's audit/verification surface; any completeness judgment; escrow of any kind |
| Transport | The interim WebSocket carriage behind the Transport tag: `send`, `subscribe` resumable from an owned offset; admission (verify, member-or-fresh-start, version) inside the adapter, which also **enforces** the grant — a non-holder's effective write is refused, since endpoint typestate binds only honest endpoints. Round-one lock defaults, all implementation not spec: FIFO by arrival per conversation; `begin` waits its turn and refuses when the wait outlives the TTL; the grant is pinned across an in-flight append so expiry never interrupts one; a refused write leaves the grant held (retry in place) and staging does not extend the TTL; after a router restart, in-memory grants are gone and holders re-`begin`; a protocol's messages were never recorded, so there is nothing to re-fold. The interim carriage is a recorded migration baseline that deviates from the sessionless decision — a connection-bound identity established at upgrade, and mixed traffic on one surface (`docs/spec/data-plane.md` → Implementation notes); no bearer secret is minted, since none exists to mint — the upgrade request is signed under the interim profile like any other. Closing the deviations is the migration | The target wire (Q10); strict one-way notification cleanup rides #788 |
| Testbed transport | The same tag, second adapter: envelope-level observation plus the tolerated-fault injections | Any injection outside the tolerated-fault envelope; any production guarantee conditioned on its presence |
| Harness (SPI) / Channel | The Harness port's two adapters are the round's runtimes (below); the channel is presented to the harness as an MCP server (the recorded reference direction, not bound — channels.md Q1): a façade over the in-process contract, the transaction handle crossing as an id — actions and conversation-start as tools, inbound as the attention stream; `begin`/`update`/`commit`/`abort` surfaced, with the single-message action as the simplest path | Specific action semantics beyond the first collective (charter) |
| Protocol engine | The general machinery — the engine drives and dispatches to the harness only while holding the grant, so acknowledging is a firewall decision and signing a computation (`docs/decisions/20260726-the-engine-dispatches.md`): an action is performed by exchanging messages until its completion condition holds, then committed once with the participants' signatures. Ships with the degenerate protocol (a plain utterance), the lifecycle actions, and at least one real collective end to end — the engine is what round one proves, not a hardcoded operation | Quorum rules, timeouts, and the wider action vocabulary — norm-level and charter-level, not machinery |
| Firewall | The outbound hook as MCP middleware on the tool-call path; the inbound hook mounted on the channel's delivery path until MCP triggers/events lands upstream; tracing and audit inherited; plugged logic = the contacts stopgap plus the institutional-fact check | Rule vocabularies, fragments, policy engines — the proposal drafts wait as inputs |
| Norm seam | Nothing: the channel-as-MCP-server IS the seam; the first norm bundle is a later round | Norm servers, projection, compile step |
| CLI | A plain signing HTTP client over register/lookup/list and the ledger reads | Anything monitor-shaped |
| Conformance | The law table discharged per kind: (C) pinned by the static checks and canaries, (P) property-tested against both transport adapters, (S) via the suite including the swap gate as one binding change | The derived-generator machinery (deferred to the conformance workstream — `v2/drafts/v0-implementation-plan-20260723.md`) |
| Monitors | Nothing: the fold library is built pinned and content-addressed — with the committed chain, all L6 needs to start later | Monitor programs, certificates, testimony carriage |

**Round-one defaults, recorded here because a builder needs them in
one place.** The message crosses every carrier as one opaque byte
string — carriers parse the envelope to admit, and re-emit the
original bytes, never re-encoding (law L1.5). The ledger retains,
beside each recorded action, the attribution material and the sender's
card, so a record re-verifies with no live sender and after the
registry stops vouching. The ledger deduplicates on the message hash,
so a blind retry after a lost acknowledgment returns the existing
offset instead of a second record — which also closes the interim
replay window, and needs the interim profile's `nonce` parameter so
two genuinely distinct sends never collapse into one. A newly added
member discovers its conversation by polling the ledger's conversation
list and subscribing to ids it has not seen; that is a round-one
default behind `Channel`, not an answer to the open feed-scope
question. And the router runs as a single process: grants live in its
memory, so two processes would each grant the same conversation and
break turn exclusion silently — offsets are nonetheless assigned
store-side from day one, which is what makes multi-process available
later.

Two runtimes drive the round end to end: the OpenClaw and NanoClaw
plugins — two independent agent runtimes — as pure consumers of the
channel, interoperating in one conversation. Both already run against
v1's testbed; running them jointly in one conversation is new.

What round one proves: the protocol engine runs both a degenerate and a real collective; the ports hold (a message travels
lock → screen → sign → send → admit → commit → fan out → verify →
screen → attention, and recovers by reading); the swap is real
(production and testbed transports pass one corpus); the boundary is
MCP (a stock MCP client is a working harness adapter — the recorded
reference direction); and nothing interpretive lives in the router.
