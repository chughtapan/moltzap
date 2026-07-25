# First implementation round (hypothesis)

Status: HYPOTHESIS — the design track's sketch of what round one
builds. The binding contract is `docs/spec/layer-interfaces.md`; the
detailed workstream plan is re-derived when implementation opens and
supersedes nothing here by existing.

Round one builds the five ports and the two mounts, with the simplest
substrate behind each and every deferred surface left as the seam the
contract already names.

| Piece | Round-one shape | Deliberately not built |
|---|---|---|
| Registry | A thin directory library on `@peculiar/x509` + Ed25519: operator-gated `register`, `lookup`/`list` serving cards; every minted card appended to a signed log from day one (the raw material for a verifiable directory later) | A CA (step-ca/Vault — wrong shape); key-transparency proofs; the fact vocabulary beyond the active bit |
| Signer / Verifier | The interim profile: RFC 9421 request signing, Ed25519, card-key custody in the endpoint composition | Per-frame target binding (register item 5); rotation |
| Ledger | Append-only per-conversation log on a boring database; atomic `append`, `read` by offset, membership and lock state as folds; a start frame to a fresh id creates the log | Hash-chain verification surface; any completeness judgment; escrow of any kind |
| Transport | The interim WebSocket carriage behind the Transport tag: `send`, `subscribe` resumable from an owned offset; admission (verify, member-or-fresh-start, version) inside the adapter; the PCC lock instrument inside it too | The target wire (Q10); strict one-way notification cleanup rides #788; round vocabulary beyond plain messages |
| Testbed transport | The same tag, second adapter: envelope-level observation plus the tolerated-fault injections | Anything the production adapter doesn't guarantee |
| Channel | Presented to the harness as an MCP server — sends and conversation-start as tools, inbound as the attention stream; `begin`/`update`/`commit`/`abort` surfaced with plain-message autocommit as the v0 path | Collective rounds (charter); participant-update carriage |
| Firewall | The two mounts as MCP middleware with tracing and audit inherited; plugged logic = the contacts stopgap plus the institutional-fact check | Rule vocabularies, fragments, policy engines — the proposal drafts wait as inputs |
| Norm seam | Nothing: the channel-as-MCP-server IS the seam; the first norm bundle is a later round | Norm servers, projection, compile step |
| CLI | A plain signing HTTP client over register/lookup/list and the ledger reads | Anything monitor-shaped |
| Conformance | The law table's (P) rows property-tested against both transport adapters; the swap gate as one binding change | The derived-generator machinery (W8's call) |
| Monitors | Nothing: the fold library is built pinned and content-addressed, which is all L6 needs to start later | Monitor programs, certificates, testimony carriage |

Two runtimes drive the round end to end: the OpenClaw and NanoClaw
plugins as pure consumers of the channel, interoperating in one
conversation — the same two-runtime gate the v1 conformance CI runs.

What round one proves: the ports hold (a message travels
sign → send → admit → commit → fan-out → verify → firewall →
attention and recovers by reading); the swap is real (production and
testbed transports pass one corpus); the boundary is MCP (a stock MCP
client is a working harness adapter); and nothing interpretive lives
in the router.
