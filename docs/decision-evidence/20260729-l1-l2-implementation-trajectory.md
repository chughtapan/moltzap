# L1 and L2 implementation decision trajectory

This is a non-normative, source-faithful event ledger. It does not make
an architecture decision and does not reconstruct rationale that the
source does not state. Current contracts live in the admitted ADRs and
their normative specification owners.

## Source record and compaction method

- Source system: Codex CLI rollout JSONL, recorded with source `cli` and
  originator `codex-tui`.
- Source session:
  `019fac90-d26a-7e51-8708-06858bd118bd`.
- Source file:
  `rollout-2026-07-28T23-30-00-019fac90-d26a-7e51-8708-06858bd118bd.jsonl`.
- Session metadata event: event kind `session_meta`, UTC
  `2026-07-29T06:32:16.447Z`; the payload records session creation time
  `2026-07-29T06:30:00.151Z`, branch `v2`, and commit
  `ad6c10e5c45c91fbf019e4402c35ba33eb72b957`.
- The session metadata event has no native message ID, enclosing turn,
  parent locator, or stored actor role.

Quoted message text is literal. For `request_user_input` events, the
outer JSON string was decoded for readability: JSON escape sequences
such as `\"` and `\n` are rendered as their represented quote and line
break. This is JSON escape normalization, not a wording change.
Structured question fields are rendered as Markdown questions and
option bullets; the bullet markers and colons are presentation, while
the question, label, and description strings are literal. Answer JSON
is otherwise retained literally. When only one question from a
multi-question call is material, the omission is identified and the
retained question and all of its options are complete.

System and developer instructions, hidden reasoning, private research,
unrelated tool output, and unrelated conversation were omitted.
No secret or authentication-bound URL is retained. Every response item
retained below lacks a parent-message field; each event therefore says
that its parent locator is absent rather than inventing one.

## V2 authority lives with V2

### Authority conflict identified

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a69a6a0b9288190911137e5b8860b79`.
- Enclosing turn: `019fac92-e6af-7d32-8258-9417e3fe0554`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T07:07:14.359Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> There is one governance blocker we cannot solve by naming. An
> accepted decision says all specs/architecture/ADRs land on `main` and
> flow into `v2`, but the Gate 1 freeze and wire profile were
> intentionally landed only on `v2`. The repository currently has two
> incompatible answers about where v2 authority lives.

This is an agent statement, not a human decision.

### Branch-ownership prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a69a6a257948190b51618dda4813aa0`,
  call `call_Ng5f0fLPyIrxjfHwz7biWabP`.
- Enclosing turn: `019fac92-e6af-7d32-8258-9417e3fe0554`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T07:07:18.221Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Which branch should own v2 normative specs and v2 ADRs before
> cutover?
>
> - `Own them on v2 (Recommended)`: Formally supersede the main-first
>   docs decision: v2 authority lands on `v2`, while production v1
>   authority stays on `main`; code from `main` still merges forward.
> - `Keep main-first`: Re-land and review the Gate 1, wire, and
>   vocabulary authority on `main`, then merge it forward into `v2`
>   before implementation.

### Branch-ownership answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019facb5-464c-7ec0-9230-1d147fa2b9ef`, call
  `call_Ng5f0fLPyIrxjfHwz7biWabP`.
- Enclosing turn: `019facae-c899-7422-8e83-c0e1839385f9`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T07:09:49.004Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"v2_authority_branch":{"answers":["Own them on v2 (Recommended)"]}}}
```

## Representations are layer-owned

### Vocabulary and review constraint

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019facba-9099-7372-8a85-ee9af4171e51`.
- Enclosing turn: `019facba-8fe4-7870-8acd-899ea76c6d51`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T07:15:35.705Z`.
- Stored actor role: `user`.

Literal excerpt:

> okay, lets gate vocab changes on huamns. I still don't get wire
> catalog and etst-vector ...not intuitive at all

### One document per layer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fae74-8382-7530-b3b9-1d6dd3ed5e3e`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:18:19.266Z`.
- Stored actor role: `user`.

Literal excerpt:

> separate documents one per layer

### Shared-conventions prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a1a0832408190a4f3efb285a12710`,
  call `call_LA8otttI0rHNqxo8xHkGWTGV`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:19:40.300Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Where should representation rules shared by L1–L4 live?
>
> - `Shared conventions page (Recommended)`: Keep one short
>   encoding-conventions page for deterministic CBOR/JSON, versioning,
>   and casing; each layer document owns only its structures.
> - `Repeat per layer`: Make every layer document self-contained,
>   accepting duplicated rules and requiring cross-document consistency
>   checks.
> - `Put them in L1`: Treat L1 as the lowest-layer owner of shared
>   encoding rules, though several rules are not identity concepts.

### Shared-conventions answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae76-9fff-7043-95be-d074a0b69464`, call
  `call_LA8otttI0rHNqxo8xHkGWTGV`.
- Enclosing turn: `019fae74-dce0-7fa2-bc86-146fac3b861d`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:20:37.631Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"shared_encoding_rules":{"answers":["Repeat per layer"]}}}
```

### Cross-layer premise challenged

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fae76-f1c4-7612-902e-9763718af9ab`.
- Enclosing turn: `019fae76-f127-7aa1-9706-9dfd5cf57bbd`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:20:58.564Z`.
- Stored actor role: `user`.

Literal excerpt:

> actually why do we need cross-layer things

### Cross-layer artifact withdrawn

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a1a8095e08190a6253608dacbdb99`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:21:44.360Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> We don’t need a cross-layer artifact. I introduced one out of
> deduplication instinct, but it weakens the ownership model.
>
> The only cross-layer fact is composition:
>
> `L4 reply choice → L3 protocol action → L1 signed message → L2 ordered
> delivery`
>
> Each handoff is explicit:
>
> - L4 knows how its `ReplyOption` becomes an L3 action.
> - L3 knows its own protocol bytes, but nothing about HTTP delivery.
> - L1 signs opaque L3 bytes and owns identity/authentication.
> - L2 carries opaque signed bytes and never decodes L3 or L4.
> - Local MCP maps runtime JSON to the `HarnessEndpoint`; it is not
>   another network layer.
>
> Using CBOR in several layers is just repeated use of the same external
> standard, not a reason to invent a shared MoltZap abstraction. Each
> layer document will therefore be self-contained, each package will
> own its encoder/decoder privately, and compatibility tests will be
> per layer. The root version constant remains shared because that is
> already the explicit compatibility contract—not a shared wire model.
>
> So: no common encoding page, no cross-layer `wire` package, and no
> monolithic compatibility corpus.

This is an agent reconciliation of the preceding human events. The
current normative record, not this explanation, determines the exact
representation chapter names and retained cross-layer contracts.

## Identity uses JCS, JOSE, and AuthenticatedHttp

### MessagePack raised

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fae7c-8c8d-7802-8c93-a50a36905623`.
- Enclosing turn: `019fae7c-8bdc-78a0-b6df-fc991f0d8437`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:27:05.870Z`.
- Stored actor role: `user`.

Literal excerpt:

> why can't we use MessagePack?

### MessagePack structured choice

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a1c36a8c881909e395785c83ceff5`,
  call `call_Z8qAww0EItVTzh1PcRzr4IE7`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:28:57.499Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Which direction should the public signed protocol take?
>
> - `CBOR + COSE (Recommended)`: Keep the standards-based signed
>   protocol, define one CDDL/schema document per layer, and allow
>   MessagePack only for private non-protocol data.
> - `MessagePack + custom signatures`: Replace CBOR and COSE, define a
>   deterministic MessagePack profile and a new multi-signature
>   container, and supersede the current wire decisions.
> - `COSE + MessagePack payloads`: Keep COSE but encode its payloads with
>   MessagePack; reuses Effect tooling but makes every implementation
>   support two binary formats.

### MessagePack choice aborted

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae7e-7de5-7182-927c-91e3ddc595e4`, call
  `call_Z8qAww0EItVTzh1PcRzr4IE7`.
- Enclosing turn: `019fae7c-8bdc-78a0-b6df-fc991f0d8437`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:29:13.190Z`.
- Stored actor role: absent (`function_call_output`).

Literal excerpt:

> aborted by user after 15.7s

No selection is recorded for this MessagePack prompt.

### Maintenance constraint

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fae7e-e68e-7502-948e-527f704632ba`.
- Enclosing turn: `019fae7e-e5e8-7290-81f3-783ed2dcb200`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:29:39.982Z`.
- Stored actor role: `user`.

Literal excerpt:

> how can we reduce our tech debt minimal not implementing custom
> libraries

### JOSE raised

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fae86-54db-7be0-9bb0-42fe342ccd39`.
- Enclosing turn: `019fae7e-e5e8-7290-81f3-783ed2dcb200`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:37:46.971Z`.
- Stored actor role: `user`.

Literal excerpt:

> why can we not use jose? that seems like the most standard library
> right?

### JOSE proposal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a1e7ff76c81908c5fbc3b8434bcf9`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:38:49.720Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> We can—and I now think we should.
>
> `jose` is the strongest fit for the goal you just stated: it is
> mature, zero-dependency, actively maintained, and supports Ed25519
> plus both single-signature and multi-signature JWS. That maps cleanly
> onto MoltZap:
>
> - L1 `SignedMessage` → flattened JWS
> - L3 `ActionCertificate` → general JWS with one signature per member
> - `AgentCard` → Registry-signed JSON containing the agent’s public JWK
> - future end-to-end encryption → JWE
> - stable hashes/derived IDs → RFC 8785 canonical JSON through a
>   maintained canonicalization package
> - validation → Effect Schema, separately owned by each layer
>
> MoltZap would still enforce its actual domain rules—exact signer
> membership, no duplicate signer, correct `kid`, allowed algorithm, and
> payload shape. Those are product rules, not a home-grown crypto
> library.
>
> The current CBOR/COSE/X.509 choice is what prevents us from simply
> using `jose`. In particular, our AgentCard is already a
> MoltZap-specific X.509 profile with a custom critical extension and
> special DER rules, so we pay ASN.1/X.509 complexity without getting
> normal PKI interoperability. JOSE lets us remove CBOR, COSE, ASN.1,
> DER, and the weak JavaScript COSE dependency story in one move.
>
> I would keep RFC 9421 for HTTP request authentication using its
> maintained library; JOSE handles durable end-to-end signed objects,
> not HTTP component canonicalization. MessagePack can remain an
> internal optimization later, but it should not become the signed
> public contract.

The omitted tail of this message contains three public documentation
links. It contains no additional decision option or human statement.
This event is an agent proposal.

### JOSE/JSON prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a1e89b14c81909e6b518dd9dccdf1`,
  call `call_h0rXCUJMvXgLLOap6g3tuCQe`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:38:52.346Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Should we reopen the accepted byte-profile decision and make
> JOSE/JSON the v2 public representation?
>
> - `Adopt JOSE/JSON (Recommended)`: Supersede CBOR/COSE/X.509, use
>   JWS/JWK/JCS plus Effect Schema, and minimize MoltZap-owned
>   infrastructure.
> - `Keep CBOR/COSE`: Preserve the frozen wire contract and accept
>   several specialized dependencies plus narrow custom profile
>   adapters.

### JOSE/JSON answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae87-669d-7071-a217-67d52b651646`, call
  `call_h0rXCUJMvXgLLOap6g3tuCQe`.
- Enclosing turn: `019fae7e-e5e8-7290-81f3-783ed2dcb200`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:38:57.053Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"wire_stack":{"answers":["Adopt JOSE/JSON (Recommended)"]}}}
```

### Initial JWS and JCS choices

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a1fb6d57081908990bcce8330205e`,
  call `call_Yrjs62p96vwFnW8Cv5sKyHby`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:43:56.944Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Which standard JWS representation should v2 expose?
>
> - `JSON forms only (Recommended)`: Use Flattened JWS for one signer
>   and General JWS for multiple signers; one consistent inspectable
>   representation.
> - `Compact for singles`: Use compact strings for AgentCard and
>   messages, but General JWS JSON for action certificates; smaller but
>   introduces two forms.
>
> Should AgentId remain independent from the agent’s signing key?
>
> - `Keep opaque AgentId (Recommended)`: The Registry mints AgentId; RFC
>   7638 thumbprints identify keys, preserving identity/key separation.
> - `Derive from JWK`: Make AgentId self-certifying from the public key,
>   reducing one mapping but coupling identity permanently to that key.
>
> Where should RFC 8785 canonical JSON be mandatory?
>
> - `Crypto inputs only (Recommended)`: Canonicalize signed payloads,
>   derivations, and record hashes; accept ordinary valid JSON in HTTP
>   envelopes.
> - `Every public body`: Require canonical JSON syntax for all requests
>   and responses, gaining byte uniformity at the cost of stricter
>   clients and more checks.

### Initial JWS and JCS answers

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae8c-c55e-7a11-8e3d-e8b6844146a5`, call
  `call_Yrjs62p96vwFnW8Cv5sKyHby`.
- Enclosing turn: `019fae7e-e5e8-7290-81f3-783ed2dcb200`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:44:48.990Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"jws_serialization":{"answers":["JSON forms only (Recommended)"]},"agent_id_binding":{"answers":["Keep opaque AgentId (Recommended)"]},"jcs_scope":{"answers":["None of the above","user_note: what is trhe cost?"]}}}
```

The JCS question records no option selection.

### JCS scope reconsidered

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a203cefa08190b08f0f72cec08db4`,
  call `call_hIcEaj3vWPvLtxJodYia95eR`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:46:08.957Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Given those costs, which canonicalization boundary should we lock?
>
> - `Crypto inputs only (Recommended)`: Use RFC 8785 for signed
>   payloads, derived identifiers, digests, and Transcript hashes;
>   accept ordinary JSON HTTP bodies.
> - `No JCS`: Sign exact JSON bytes and define separate MoltZap framing
>   for every cross-implementation derivation and hash.
> - `All public JSON`: Require canonical bytes for every HTTP request
>   and response as well as signed and hashed values.

### JCS maintenance note

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae90-a2ae-7ab0-a7c8-6989db26f8d2`, call
  `call_hIcEaj3vWPvLtxJodYia95eR`.
- Enclosing turn: `019fae7e-e5e8-7290-81f3-783ed2dcb200`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:49:02.254Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"jcs_scope_final":{"answers":["None of the above","user_note: does 3 not give us less things to  maintain"]}}}
```

The answer names “3” in a prompt whose third option is `All public
JSON`; it does not itself select the option.

### Canonical-network-JSON prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a212b527081908c8e08b22df40168`,
  call `call_MZJDiDdG1JiUQC9Za3c2tZS7`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:50:07.074Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Should we lock that single canonical-network-JSON rule?
>
> - `Canonical network JSON (Recommended)`: Require RFC 8785 for every
>   Registry, Router, and Ledger JSON body and JOSE JSON fragment; keep
>   local MCP and human-facing JSON ordinary.
> - `Crypto inputs only`: Keep HTTP envelopes permissive and maintain
>   separate ordinary-JSON and canonical-JSON boundary paths.

### Canonical-network-JSON answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae92-c987-7c02-896b-f57d45c730b1`, call
  `call_MZJDiDdG1JiUQC9Za3c2tZS7`.
- Enclosing turn: `019fae7e-e5e8-7290-81f3-783ed2dcb200`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:51:23.271Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"canonical_network_json":{"answers":["Canonical network JSON (Recommended)","user_note: we can implement our custom transport libraries that don't change the other layers"]}}}
```

### General JWS and shared-adapter prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a21c5e0b081908a77d811a87a863a`,
  call `call_EzggdQCzKP70F1qIJbJ4cZzK`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:52:43.428Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Should every signed MoltZap artifact use the same General JWS JSON
> shape?
>
> - `General JWS everywhere (Recommended)`: Use one parser/verifier
>   path; AgentCard and SignedMessage require exactly one signature,
>   ActionCertificate requires the exact member set.
> - `Flattened plus General`: Use Flattened JWS for single signatures
>   and General JWS for multiple signatures, saving a small amount of
>   envelope overhead.
>
> How should the replaceable network adapters be owned?
>
> - `One per layer (Recommended)`: RegistryHttp, RouterHttp, and
>   LedgerHttp stay private to their owning packages; no shared MoltZap
>   transport library.
> - `Shared adapter library`: Centralize canonical JSON and HTTP
>   machinery, reducing duplicated glue but creating a cross-layer
>   dependency.
>
> How should lossless Router sequences and Transcript offsets appear in
> JSON?
>
> - `Decimal strings (Recommended)`: Use canonical unsigned decimal
>   strings, preserving uint64 values across JavaScript and other
>   languages.
> - `Safe JSON numbers`: Use numbers capped at 2^53−1, simpler to read
>   but introduces a protocol ceiling.

The later opaque-order exchange superseded the public-Router-position
premise of the third question; it is retained here to interpret the
complete answer event.

### General JWS and shared-adapter answers

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae97-3f50-73b1-8e30-1b25eeb257db`, call
  `call_EzggdQCzKP70F1qIJbJ4cZzK`.
- Enclosing turn: `019fae7e-e5e8-7290-81f3-783ed2dcb200`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T15:56:15.568Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"json_uint64":{"answers":["Safe JSON numbers"]},"single_jws_shape":{"answers":["General JWS everywhere (Recommended)"]},"http_adapter_ownership":{"answers":["Shared adapter library"]}}}
```

### Deep-module instruction

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fae9b-223b-7792-a78d-016a181937d2`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:00:30.267Z`.
- Stored actor role: `user`.

Literal excerpt:

> you want to use osterhourts principals: deep modules

### Shared-adapter recommendation changed

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a23b06a3c8190beaa9de1c03a43fd`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:00:51.852Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Yes. Ousterhout’s test is the right one here: each package should hide
> substantial complexity behind a small domain interface. That changes
> my recommendation. A seventh “shared adapter” package would mostly
> expose JCS/HTTP/JOSE mechanics and create another dependency boundary,
> so it would be a shallow module.
>
> I’m treating your point as: share mature external libraries, not a
> MoltZap-owned cross-layer abstraction. `identity`, `transport`, and
> `transcript` each keep their network representation code private and
> expose only Registry, Router, and Ledger capabilities. A little
> deliberate glue duplication is cheaper than a permanent generic
> package.

This is an agent interpretation and recommendation, not a human answer.

### Deep-module ownership prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a23bbe4788190b41e7f88e955944c`,
  call `call_ERXPbTvbXN2hYQsa6h5Zi3aq`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:01:04.105Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Should Ousterhout’s deep-module rule replace the earlier shared
> MoltZap adapter-library choice?
>
> - `Private per package (Recommended)`: Share jose/JCS/RFC libraries,
>   but keep thin profile adapters private inside identity, transport,
>   and transcript.
> - `Shared internal package`: Add a seventh cross-layer package,
>   accepting a shallower shared boundary and superseding the
>   six-package decision.

### Deep-module ownership answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019fae9c-b6c7-7860-9dc6-99cc761d20d2`, call
  `call_ERXPbTvbXN2hYQsa6h5Zi3aq`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:02:13.831Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"adapter_ownership":{"answers":["None of the above","user_note: I think shared internal package is reasonably deep (look at what our transport actually has), so either this entirely gets subsuumed into identity / transport ,aybe"]}}}
```

No listed option is selected in this event.

### Authenticated HTTP owner prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a255d4ef88190b6996ed7c7e640e5`,
  call `call_AijVMxKnERJ0F8Y2Gs4xoh3h`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:08:02.174Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Where should the shared canonical authenticated-HTTP boundary live?
>
> - `Inside identity (Recommended)`: Preserves six deep packages and the
>   dependency direction; router and transcript supply only their
>   domain schemas.
> - `New network package`: Makes the boundary explicit as a seventh deep
>   package and revises the frozen package graph.
> - `Private per service`: Shares only third-party dependencies and
>   duplicates the narrow integration in Registry, Router, and Ledger.

### Authenticated HTTP owner answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faea3-ef76-7623-a5a4-08c4221d4071`, call
  `call_AijVMxKnERJ0F8Y2Gs4xoh3h`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:10:07.094Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"http_boundary_owner":{"answers":["Inside identity (Recommended)"]}}}
```

### AuthenticatedHttp name prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a2ce1decc8190b5d3feb7f0a22f04`,
  call `call_oAh8TbwPAX982dfkfCrATWOL`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:40:07.206Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> What should the identity-owned deep module that hides JCS,
> Content-Digest, and RFC 9421 be called?
>
> - `AuthenticatedHttp (Recommended)`: Names the guarantee and boundary
>   without exposing library or codec terminology.
> - `MoltZapHttp`: Names the protocol but not the guarantee it provides.
> - `NetworkRequest`: Names the object being processed but can be
>   confused with domain request types.
>
> How should a normal HTTP request carry the caller AgentCard?
>
> - `Canonical JSON body (Recommended)`: Use one `agentCard` plus
>   route-specific `request` envelope covered by Content-Digest and the
>   HTTP signature.
> - `Custom HTTP header`: Carry encoded AgentCard bytes in a signed
>   `MoltZap-Agent-Card` header.
> - `Registry lookup`: Send only key ID and require each service to
>   resolve the card live or from cache.
>
> How much authentication detail should the public HTTP error expose?
>
> - `One authentication_failed (Recommended)`: Hide missing headers, bad
>   digest, invalid signature, expiry, replay, and card mismatch behind
>   one 401 tag; log causes internally.
> - `Detailed auth tags`: Expose separate digest, signature, expiry,
>   nonce replay, and missing-credential tags.

### AuthenticatedHttp name answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faec0-0da3-7142-a3d0-fcbc6fa4e3d8`, call
  `call_oAh8TbwPAX982dfkfCrATWOL`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:40:49.827Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"identity_http_module_name":{"answers":["AuthenticatedHttp (Recommended)"]},"request_agent_card_carriage":{"answers":["Registry lookup"]},"authentication_error_surface":{"answers":["One authentication_failed (Recommended)"]}}}
```

### AuthenticatedHttp depth prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a45663f748190ad40bdb5fd0cf9fa`,
  call `call_P80jVOMzAasGVj4pa5K0zqEw`.
- Enclosing turn: `019faf0a-b75d-7e21-9800-c88d00d09827`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T18:24:47.619Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> D7 — How deep should `AuthenticatedHttp` be?
>
> [P1] (confidence: 9/10) A signature-only wrapper would duplicate
> security-sensitive request parsing and error precedence in every
> service.
>
> ELI10: Both Registry and Router must perform the same framing,
> canonical JSON, digest, signature, nonce, and version checks in the
> same order. One deep module can hide that policy while still letting
> each service own its request schema and business handler.
>
> Stakes if we pick wrong: Tiny differences between servers become
> authentication bugs and every future fix must be copied.
>
> Recommendation: Make `AuthenticatedHttp` own the complete common
> authenticated boundary while delegating only the closed domain schema
> and handler.
>
> Completeness: deep boundary=10/10, signature-only=6/10, custom
> framework=8/10.
>
> Pros / cons:
>
> A) Deep narrow boundary: ✅ one tested security pipeline; ✅ Router
> sees only authenticated typed input; ❌ identity owns a slightly
> larger module.
>
> B) Signature-only helper: ✅ smallest helper API; ✅ servers control
> every step; ❌ duplicates subtle policy and failure ordering.
>
> C) General HTTP framework: ✅ centralizes all routing and responses;
> ✅ highly reusable; ❌ creates the custom cross-layer framework we are
> avoiding.
>
> Net: This applies deep-module design without inventing a new web
> framework.
>
> - `Deep narrow boundary (Recommended)`: Own framing, JCS, RFC 9421,
>   admission, replay, version, canonical responses, and error collapse
>   while accepting route-specific schemas.
> - `Signature-only helper`: Wrap only RFC 9421 signing and
>   verification, leaving every service to implement the surrounding
>   boundary policy.
> - `General HTTP framework`: Build a reusable MoltZap routing and
>   response framework that owns all service endpoints and domain
>   dispatch.

### AuthenticatedHttp depth answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faf1f-7822-7bc0-aaad-3b69af0d0e25`, call
  `call_P80jVOMzAasGVj4pa5K0zqEw`.
- Enclosing turn: `019faf0a-b75d-7e21-9800-c88d00d09827`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T18:25:03.010Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"authenticated_http_depth":{"answers":["Deep narrow boundary (Recommended)"]}}}
```

The later agent-authored plan event that states Router ownership of
`SignedMessageDigest` and uses `GET /healthz` for both services is
retained once under
[Durable plan corrections for health and digest ownership](#durable-plan-corrections-for-health-and-digest-ownership).

## Router order is opaque

### Control and data paths distinguished

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fae9d-a944-7740-b320-84b6da3225d4`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:03:15.909Z`.
- Stored actor role: `user`.

Literal excerpt:

> I think what I'm realizing is that control and data path are separate;
> right now the transport package is control path? not a router?
> something is weird

### L2 package-name prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a246408b48190bfaf3ef43f6091ed`,
  call `call_8e3Ul8UAN9IYYAMyBnvghszK`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:03:50.255Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> How should we resolve the overloaded `transport` name?
>
> - `Rename to router (Recommended)`: The package directly names the L2
>   data-plane service and removes confusion with HTTP transport.
> - `Keep transport`: Retain the accepted package name and document that
>   it means only L2 Router semantics.
> - `Rework package split`: Reopen the six-package model and separate
>   shared network-boundary machinery from Router semantics.

### L2 package-name answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faea1-3183-74f0-8ff4-250e7bf001fe`, call
  `call_8e3Ul8UAN9IYYAMyBnvghszK`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:07:07.395Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"l2_package_name":{"answers":["Rename to router (Recommended)"]}}}
```

### Public-position premise challenged

#### Counter, key ID, and type prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a261a1abc8190a70f424413721386`,
  call `call_tqGKphpVqu8BFCat5laIhjI6`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:11:12.176Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> What happens at JavaScript’s maximum safe integer?
>
> - `Defined exhaustion (Recommended)`: Router refuses fresh sends until
>   a new Router instance; Ledger returns `offset_exhausted` for that
>   conversation while reads and committed retries continue.
> - `Service failure`: Treat reaching the cap as an internal fatal
>   condition and mark the whole service unhealthy.
> - `Use decimal strings`: Reopen the numeric decision and carry
>   unbounded counters as canonical decimal strings.
>
> What should protected JWS `kid` identify?
>
> - `JWK thumbprint URI (Recommended)`: Use the standard RFC 7638/9278
>   key identifier; AgentId remains independent from the key.
> - `AgentId`: Use the shorter domain identity even though `kid` then
>   identifies an agent rather than a specific key.
> - `No kid`: Infer the key from payload context and signer position,
>   reducing headers but weakening explicit binding.
>
> How explicit should protected JWS `typ` values be?
>
> - `Media types (Recommended)`: Use clear values such as
>   `application/vnd.moltzap.agent-card+jws`, signed-message, and
>   action-certificate.
> - `Short tokens`: Use compact values such as
>   `moltzap-agent-card-v1`.
> - `Payload kind only`: Omit `typ` and rely only on the signed payload’s
>   kind and MoltZap version.

#### Counter, key ID, and type answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faea7-98b8-72b0-a807-fa2c5aaacaf8`, call
  `call_tqGKphpVqu8BFCat5laIhjI6`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:14:07.032Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"counter_exhaustion":{"answers":["None of the above","user_note: do sequence numbers need to be on the wire? or I guess can we separate the wire format from the internal state"]},"jws_kid":{"answers":["JWK thumbprint URI (Recommended)"]},"jws_typ":{"answers":["Media types (Recommended)"]}}}
```

### Opaque-position prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a26faaba88190a02ee3e19061ab83`,
  call `call_EbSdhlZebWDPMxNJCt6H88mQ`.
- Enclosing turn: `019fae74-8279-7700-a9d9-71c08e4455bf`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:14:54.450Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> How should public Router and Ledger positions be represented while
> keeping internal counters separate?
>
> - `Safe integers (Recommended)`: Wire uses checked JSON integers;
>   implementations may use bigint internally and expose explicit,
>   practically unreachable exhaustion behavior.
> - `Decimal strings`: Wire uses canonical decimal strings and
>   implementations use bigint, removing the practical ceiling at the
>   cost of conversion rules.
> - `Redesign as opaque`: Hide positions behind service-owned tokens and
>   reopen L3 ordering, append, reconciliation, and evidence contracts.

### Opaque-position answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faea8-efeb-7523-bf52-a3902b63ddf1`, call
  `call_EbSdhlZebWDPMxNJCt6H88mQ`.
- Enclosing turn: `019fae9b-2167-7a10-b637-f2186dbc2563`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:15:34.891Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"position_representation":{"answers":["Redesign as opaque"]}}}
```

### Poll continuation and send-result prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a2db9b2ac8190ae48cc8cc9e917f5`,
  call `call_61gj8OTHTuSg1mRqWjQi1d8d`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:43:43.856Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> How should Registry and conversation-list pagination continue?
>
> - `After domain ID (Recommended)`: Use `afterAgentId` and
>   `afterConversationId`; remove two custom opaque cursor formats and
>   their keys/state.
> - `Opaque cursors`: Keep service-issued cursors even though ordering
>   is already by public immutable IDs.
>
> What should the Router’s only public continuation expose?
>
> - `Opaque server token (Recommended)`: Expose an uninspectable
>   PollCursor; Router privately maps it to recipient, instance, and
>   internal feed boundary.
> - `Signed structured cursor`: Expose a JOSE/JCS cursor object whose
>   payload contains the internal continuation fields.
>
> What should a successful Router send return after removing public
> positions?
>
> - `Accepted instance only (Recommended)`: Return accepted plus
>   RouterInstanceId; BEGIN authors wait for self-delivery before
>   treating themselves as a contender.
> - `Accepted message digest`: Also return the SignedMessage digest,
>   although the caller can compute it locally.

### Poll continuation and send-result answers

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faec4-022b-7291-a4a1-2a79c4ecefaf`, call
  `call_61gj8OTHTuSg1mRqWjQi1d8d`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:45:09.035Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"poll_cursor_shape":{"answers":["Opaque server token (Recommended)"]},"send_result_without_position":{"answers":["Accepted message digest","user_note: might be good for verification"]},"list_pagination":{"answers":["After domain ID (Recommended)"]}}}
```

### Alternative-recording instruction

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faec4-0251-7d00-ac49-3df4b0c7e1d1`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:45:09.074Z`.
- Stored actor role: `user`.

Literal excerpt:

> record this alternative when you make these ADRs

The referent is not named. The immediately preceding structured answer
covered three questions and their alternatives. The next agent message
interpreted the instruction as referring to the send-result alternative,
but this source contains no later human event confirming that
interpretation.

### Agent interpretation of the alternative

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a2e2373848190b32ae7f0648ea33d`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:45:26.477Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Yes. The Router ADR will record both outcomes:
>
> - Chosen: `accepted` returns `routerInstanceId` plus the SHA-256
>   digest of the exact canonical SignedMessage bytes. The client
>   compares it with its local digest, and an identical retained retry
>   returns the same receipt.
> - Rejected alternative: return only `routerInstanceId` and rely
>   entirely on self-delivery. That is sufficient for ordering safety,
>   but gives the caller no Router-confirmed equality check for the
>   accepted bytes.
>
> The ADR will also state the limit: the digest confirms byte identity
> under the correct-Router/TLS assumptions; it is not a delivery
> position, ordering proof, or replacement for BEGIN self-delivery. I’ll
> include this explicit alternative in the decision provenance and
> blind-review candidate.

This is an agent interpretation, not evidence that the preceding
ambiguous human phrase named this alternative.

### Poll restart deferral prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a2ee5f0e08190bc35aa2bcb451142`,
  call `call_ZNHIAscnc4K7H1jMh0qHkt8g`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:48:40.656Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> How should polling distinguish a Router restart from an invalid or
> evicted opaque cursor?
>
> - `Expected instance field (Recommended)`: The first tail-anchor omits
>   it; every later poll sends `expectedRouterInstanceId` with the opaque
>   cursor, so instance mismatch deterministically returns
>   `router_restarted`.
> - `Fresh-anchor recovery`: An unknown cursor returns `cursor_invalid`;
>   the endpoint must issue a new anchor poll to learn whether the Router
>   restarted.
> - `Self-describing cursor`: Encode and authenticate the Router instance
>   inside the cursor, adding a custom token format and key lifecycle.

### Poll restart initially deferred

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faec7-667a-78f0-94b6-53c6f5ceed82`, call
  `call_ZNHIAscnc4K7H1jMh0qHkt8g`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T16:48:51.322Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"poll_restart_fence":{"answers":["None of the above","user_note: defer"]}}}
```

### Poll restart revisited

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a37c9683481908cc0e0f685f1f883`,
  call `call_N46oLiJSiGmks5AxE3s3pX2L`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:26:36.784Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> For the L2 implementation, may a continuation poll carry
> `expectedRouterInstanceId` alongside its opaque `pollCursor`?
>
> - `Yes (Recommended)`: Initial tail-anchor sends neither; every
>   continuation sends both, so restart is detected before cursor lookup
>   without exposing cursor internals.
> - `No, invalid cursor`: A restarted Router treats the old token as
>   `cursor_invalid`; the endpoint must issue a fresh tail-anchor to
>   discover the new instance.
> - `Defer L2 polling`: Implement identity and send only; keep polling
>   and ordered delivery blocked for a later revision.

### Poll restart answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faeeb-78aa-73c0-9aea-8691300059d6`, call
  `call_N46oLiJSiGmks5AxE3s3pX2L`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:28:15.274Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"poll_restart_fence_revisit":{"answers":["No, invalid cursor"]}}}
```

### Lightweight, no-cursor-record requirement

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faefb-d4dd-7d72-b85d-177f665e9707`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:46:07.453Z`.
- Stored actor role: `user`.

Literal excerpt:

> actually for the last question: make sure that it's design can be
> lightweight and doesnt need maintaining server side state

### Stateless PollCursor prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a3c8570008190b2acfb21e485f1b9`,
  call `call_2xWkWtD69FdrILn2xdOiHLhn`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:46:48.279Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Lock PollCursor as a stateless JOSE token with no per-cursor server
> records?
>
> - `Compact JWE (Recommended)`: Use `plc_` plus `jose` compact JWE
>   (`dir` + `A256GCM`) under one ephemeral per-Router key; payload
>   remains opaque and restart invalidates it.
> - `Signed readable token`: Use compact JWS/HMAC; stateless, but clients
>   can decode the private feed boundary and instance fields.
> - `Expose keyset order`: Send an explicit public continuation
>   position, reversing the decision to hide Router positions.

### Stateless PollCursor answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faefc-cd94-7bb3-a64d-7c0a34fb0c02`, call
  `call_2xWkWtD69FdrILn2xdOiHLhn`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:47:11.124Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"stateless_poll_cursor":{"answers":["Compact JWE (Recommended)"]}}}
```

### Lightweight Router questioned

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faefd-02ef-7c80-83c8-0dc518532327`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:47:24.783Z`.
- Stored actor role: `user`.

Literal excerpt:

> same for the L2 routers too?

### Router state limit explained

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a3cc5fe28819089744bce66c762c2`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:47:54.743Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Yes—the stateless cursor is specifically for the L2 Router. We can
> also keep the Router itself lightweight:
>
> - one bounded in-memory global ordered ring of accepted
>   `SignedMessage`s;
> - one copy of each message plus its explicit recipient set—no
>   per-recipient queues or delivery copies;
> - PollCursor JWE records the private global boundary already scanned,
>   so polling filters the ring for the authenticated AgentId;
> - bounded send-idempotency and nonce-replay caches;
> - no database, cursor table, session table, or durable recovery state.
>
> The Router cannot be completely stateless: globally ordered polling
> requires retaining a bounded message window, and safe
> retries/authentication require the idempotency and nonce caches. Those
> are the guarantee-bearing state; everything else can be derived or
> kept request-scoped. A restart intentionally discards all of it,
> creates a new `RouterInstanceId` and JWE key, and makes old cursors
> invalid.

This is an agent explanation. The later global-ring selection records
the bounded-state choice.

### Initial TLS prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a3cef5a4081909b528ee574d48ba9`,
  call `call_s4fqlOT97lK5FrZoz8dIl0I5`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:48:34.816Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> For the first L1/L2 implementation, where should mandatory
> non-loopback TLS terminate?
>
> - `Deployment edge (Recommended)`: Registry/Router bind loopback or a
>   private interface; clients reject plain HTTP except loopback, while
>   ingress/reverse-proxy TLS and IAM remain deployment concerns.
> - `Built into binaries`: Add certificate/key loading and HTTPS
>   listeners to both services now, increasing configuration and
>   rotation code.
> - `Both modes`: Support built-in TLS and trusted-proxy termination in
>   the first slice, expanding the test matrix.

### Initial TLS answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faefe-d122-7e72-ada6-75469050d7ac`, call
  `call_s4fqlOT97lK5FrZoz8dIl0I5`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:49:23.106Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"l12_tls_termination":{"answers":["Deployment edge (Recommended)"]}}}
```

This selection still includes client-side rejection of non-loopback
plain HTTP.

### Application TLS requirement removed

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faeff-730d-73a3-9343-72b3d40a69d6`.
- Enclosing turn: `019faeff-7235-7b31-acb9-981483c473eb`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:50:04.557Z`.
- Stored actor role: `user`.

Literal excerpt:

> I don't think we have to mandatory non-loopback TLS terminate here
> anywhere in the code. we will spin up containerized envs too. TLS is a
> deployment concern fully

### TLS reversal acknowledged

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a3d57346881909d62ed6661bfae2c`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:50:17.669Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Agreed. I’m removing TLS policy from the L1/L2 code entirely.
>
> Registry and Router will serve ordinary HTTP and accept configured
> HTTP origins; containerized and local environments need no exception
> path. TLS, ingress certificates, IAM, and network exposure belong
> wholly to deployment. The protocol docs will state only the deployment
> assumption: any ingress must preserve the signed method, authority,
> path, query, headers, and body. There will be no scheme rejection,
> certificate loading, proxy-trust mode, or TLS branch in either
> package.

This is an agent restatement of the preceding human instruction.

### TLS significance questioned

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf08-644a-7881-9450-4627681798ae`.
- Enclosing turn: `019faf04-e973-7b52-b007-298dceb7d0ff`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T17:59:50.602Z`.
- Stored actor role: `user`.

Literal excerpt:

> or does it not matter?

### Application/deployment TLS boundary explained

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a3fbe6150819086d46e0d4a0a397b`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T18:00:36.033Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> It matters, but not as an L1/L2 application behavior.
>
> The clean boundary is:
>
> - Registry and Router serve ordinary HTTP and contain no TLS
>   termination, certificate loading, scheme allowlist, loopback
>   exception, or “trust proxy” mode.
> - TLS, mTLS, service-mesh encryption, and ingress policy are deployment
>   choices.
> - RFC 9421 still authenticates the exact method, authority, path,
>   query, headers, and body. An ingress must preserve those covered
>   values; otherwise verification correctly fails.
> - Message signatures provide integrity, caller authentication, and
>   replay protection—not confidentiality. Plain HTTP across an
>   untrusted network exposes bodies, metadata, and the registration
>   admission credential, so a production deployment still needs an
>   appropriately protected channel.
>
> This does matter to the ADR work because today’s accepted text
> explicitly mandates TLS and `https`; we must supersede that requirement
> so a later implementer does not add TLS logic. I’ll record the
> replacement as: “MoltZap imposes no application-level TLS or scheme
> requirement; channel protection belongs to deployment.”
>
> One independent L2 choice is still material: how much private
> recipient-tracking state the Router keeps.

This is an agent explanation; it does not reinstate the earlier
client-side scheme rejection.

### Global-ring prompt

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fc_0d0c5bdb13a3d3c4016a6a3fc401f48190a8488dd47cfae76f`,
  call `call_ZipDMHGa6ZtdDieZoyt4iu1U`.
- Enclosing turn: `019faeb9-b10b-7a91-9e5f-211d9537e425`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T18:00:38.165Z`.
- Stored actor role: absent (`function_call` carrying the public agent
  prompt).

Literal excerpt:

> Which bounded in-memory retention model should the Router use for this
> revision?
>
> - `One global ring (Recommended)`: Stores one message copy and no
>   per-recipient index; gaps can be conservatively reported after
>   unrelated traffic eviction.
> - `Recipient indexes`: Adds per-recipient order references for exact
>   gap detection and faster polling, with more bookkeeping and memory.
> - `Eviction watermarks`: Tracks per-active-recipient eviction
>   boundaries for exact gaps but still scans the global ring and adds
>   lifecycle rules.

### Global-ring answer

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faf09-39ca-7381-aba7-0659ab2d4333`, call
  `call_ZipDMHGa6ZtdDieZoyt4iu1U`.
- Enclosing turn: `019faf04-e973-7b52-b007-298dceb7d0ff`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T18:00:45.258Z`.
- Stored actor role: absent (`function_call_output` returned by the
  public input UI).

Literal excerpt:

```json
{"answers":{"l2_retention":{"answers":["One global ring (Recommended)"]}}}
```

### Durable plan corrections for health and digest ownership

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a4cfef8708190b4cd637780eb1111`.
- Enclosing turn: `019faf2f-1f43-7002-8a34-26c4d39b0ba3`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T18:58:18.984Z`.
- Stored actor role: `assistant`.

The event is an agent-authored `<proposed_plan>`. The following are
literal, non-contiguous excerpts from that event. Omitted material
includes the rest of the identity, Registry, Router, dependency, test,
operational, and execution plan; no omitted text is attributed here to
a human.

Literal excerpt from `L1: Identity and Registry`:

> - `AgentCardDigest`: `acd_` plus SHA-256’s 43-character payload
>
> - `AgentCardDigest` and Router-owned `SignedMessageDigest` are SHA-256
>   over the UTF-8 JCS bytes of the complete General JWS object.

Literal excerpt from the Registry routes:

> Routes:
>
> - `POST /v1/identities:register`
> - `POST /v1/identities:lookup`
> - `POST /v1/identities:list`
> - `GET /healthz`

Literal excerpt from `L2: Router`:

> - Define:
>   - `RouterInstanceId`: `rti_` plus canonical 16-byte base64url
>   - `SignedMessageDigest`: `smd_` plus canonical SHA-256 base64url
>   - `PollCursor`: `plc_` plus the specified Compact JWE

Literal excerpt from the Router routes:

> Routes:
>
> - `POST /v1/messages:send`
> - `POST /v1/messages:poll`
> - `GET /healthz`

This event establishes what the agent proposed in the durable
implementation ask. It is not independently stored as a human
selection.

## L1 and L2 only scope

### Proposed later-layer cleanup

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a5b2251dc81909d3a541a9c652225`.
- Enclosing turn: `0f6be7eb-e789-4b22-a219-0b0560dc70ce`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T19:57:25.704Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> The remaining contradiction is broader than the manifest: several
> high-authority orientation pages still name the old MCP method,
> extension, SSE framing, and exact ID derivation even though the new
> decision deliberately leaves those representations unassigned. I’m
> removing those stale byte-level choices while preserving the
> already-approved semantics: two model tools, one turn-ready
> subscription, at-most-once attention, and deterministic retry
> identity.

### Human limits the implementation candidate

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf74-e678-7ab3-8b27-090394ccf237`.
- Enclosing turn: `019faf74-e54f-7080-a588-86e1983b414e`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T19:58:21.816Z`.
- Stored actor role: `user`.

Literal excerpt:

> keep those, we don't have to litigate them, we focus only on L1 and
> L2; get to the impl

### Human directs restoration of later-layer documents

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf77-25d7-7f41-aa0d-4784aac3162f`.
- Enclosing turn: `019faf77-24b6-7383-893c-7bdb49912497`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T20:00:49.111Z`.
- Stored actor role: `user`.

Literal excerpt:

> make sure to revert if you changed any L3 or L4 docs

### Human rejects the cross-layer wire profile

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf78-2bdf-7113-a819-75d66749f12d`.
- Enclosing turn: `019faf77-24b6-7383-893c-7bdb49912497`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T20:01:56.191Z`.
- Stored actor role: `user`.

Literal excerpt:

> wire profile is junk

### Human retains the agreed later-layer vocabulary

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf79-b813-7583-997f-21a260009256`.
- Enclosing turn: `019faf77-24b6-7383-893c-7bdb49912497`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T20:03:37.619Z`.
- Stored actor role: `user`.

Literal excerpt:

> and whatever vocabulry changes we discussed for l3 and l4

### Human directs the revised plan to become the end-to-end goal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf87-4005-7b21-8899-fa24637414a1`.
- Enclosing turn: `019faf77-24b6-7383-893c-7bdb49912497`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T20:18:24.389Z`.
- Stored actor role: `user`.

Literal excerpt:

> update your original plan and the set that as the new goal and then
> ship this end to end

### Later-layer documents mechanically restored

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faf79-3dbb-7ed2-b538-5bea02edee97`, call
  `call_d7FN02mjZKJlaD35Hsw45u0g`.
- Enclosing turn: `019faf77-24b6-7383-893c-7bdb49912497`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T20:03:06.299Z`.
- Stored actor role: absent (`function_call_output` from a mechanical
  repository command).

Literal excerpt:

```text
Process exited with code 0
```

The omitted command output is a 390-token working-tree status listing.
The command restored the named L3, L4, daemon, model-surface, monitor,
and Transcript specification and ADR files from the candidate's parent
revision. This is a mechanical repository event, not a new design
decision.

## Registration ownership was an open question

### Human questions the current ownership

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb028-eb9d-7ed3-9000-a1f26175ad45`.
- Enclosing turn: `019fb028-e9f2-77f3-b797-a2b42c68b4d7`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T23:14:59.613Z`.
- Stored actor role: `user`.

Literal excerpt:

> registration requests should not live in AuthenticatedHttp? they are
> by design not authenticated?

### Agent proposes Registry ownership

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6a89b2b15c81909263c0e77e01f9c0`.
- Enclosing turn: `019fb028-e9f2-77f3-b797-a2b42c68b4d7`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T23:16:03.896Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Yes—registration is admitted and proves possession of the submitted
> key, but it is not authenticated as an existing AgentId. I’ll correct
> the design so `AuthenticatedHttp` owns only registered-agent
> requests; Registry privately owns registration admission and
> proof-of-possession. I’ll also add a clearly non-normative,
> human-review slate under `docs/architecture/` and link it from the
> implementation ask.

This is an agent proposal, not a human decision.

### Human later resumes the goal

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb0cc-c14e-7e31-b196-e10ee2934da9`.
- Enclosing turn: `019fb0cc-bebe-7793-9a25-20563466f7df`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-30T02:13:56.686Z`.
- Stored actor role: `user`.

Literal excerpt:

> update to latest v2 and resume goal

At this point in the source, no later literal human event accepted or
rejected the proposed registration-ownership replacement. The later
exact-slate approval retained below supplies the explicit maintainer
decision.

## Numbered layer notation stays in documentation

### Human limits layer notation to documentation

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb034-605f-7430-b2b0-2601cbcbb1fe`.
- Enclosing turn: `019fb034-5f61-7db1-8c2b-e30b3788fed3`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T23:27:30.399Z`.
- Stored actor role: `user`.

Literal excerpt:

> we also want to make sure that L1 / L2 language does not slip into
> the code; its only in the docs

## Configuration simplification and Effect Config

### Human questions three independent Router size settings

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb0e7-b8e8-7a41-815e-ed84688d3e2b`.
- Enclosing turn: `66fbaaf6-6183-4897-a44e-1098940037a4`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-30T02:43:24.009Z`.
- Stored actor role: `user`.

Literal excerpt:

> I'm a bit confused about: MOLTZAP_ROUTER_REQU…│maximum received
> POS…│ 524,288 │received body octets;…│no
>    MOLTZAP_ROUTER_OPAQ…│maximum decoded Sign…│ 262,144 │bytes after
> canonical…│no
>    MOLTZAP_ROUTER_SIGN…│maximum complete Sig…│ 491,520 │UTF-8 JCS
> bytes of th…│no

### Human asks why the settings are separate

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb0e7-b8f8-7f01-bda8-7e6823f33cd9`.
- Enclosing turn: `66fbaaf6-6183-4897-a44e-1098940037a4`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-30T02:43:24.025Z`.
- Stored actor role: `user`.

Literal excerpt:

> why do we hav ethese separate constants

These are questions. They do not themselves select fixed primitive
limits, derived enclosing limits, or exact values.

### Human asks for another configuration cleanup and selects Effect
Config

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb0eb-32b1-7c63-91be-4e4e6f8176a0`.
- Enclosing turn: `019fb0eb-30b2-7f03-b3a3-927b02dcd00a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-30T02:47:11.794Z`.
- Stored actor role: `user`.

Literal excerpt:

> do we similar cleanups in other places? vacous config variables? also
> we should use effect for config loading

The request to use Effect for configuration loading is declarative.
The questions about other cleanups and vacuous variables do not select
the agent's later proposed list of retained or excluded keys at this
point in the source.

### Human rejects a complex research detour

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb0ec-9028-7050-b2f6-79071ed5b9ac`.
- Enclosing turn: `019fb0eb-30b2-7f03-b3a3-927b02dcd00a`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-30T02:48:41.256Z`.
- Stored actor role: `user`.

Literal excerpt:

> you don't need complex research for this

This is process direction. It does not approve a configuration-key
table.

## Exact implementation slate approved

### Agent identifies the exact review revision

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a6ac6d7ff208190b1ff303d49534cbb`.
- Enclosing turn: `24814570-3559-4350-ba3a-71e315fb674b`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-30T03:36:58.067Z`.
- Stored actor role: `assistant`.

Literal excerpt:

```text
Implementation is paused at the required human gate. The candidate remains unchanged:

[Review slate](/home/tapanc/moltzap/docs/architecture/l1-l2-human-review-slate.md)
SHA-256: `d1305a44a1b1a8a351e56687d8f2178e202ef64e65b91a5d36f96e481a01161d`

Reply `approve slate` to resume with ADR/spec reconciliation, blind review, and implementation.
```

This is the public agent prompt needed to interpret the terse human
reply. It identifies the candidate by repository path and SHA-256.
The source's two trailing Markdown hard-break spaces after the link
were omitted as presentation-only whitespace normalization.

### Human approves the identified slate

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019fb12b-5068-7541-8b06-6ffe8c6b92bb`.
- Enclosing turn: `019fb12b-4f15-7c70-8a43-2a5318410ff3`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-30T03:57:13.704Z`.
- Stored actor role: `user`.

Literal excerpt:

> approve slate

The reply selects the exact revision identified by the directly
preceding retained prompt. The slate is a non-normative review
artifact; current binding outcomes live in the ADRs and normative
chapters reconciled from this event.

## Cross-cutting source gaps

### Session account identity is absent

The session metadata identifies the source as Codex CLI and the
originator as `codex-tui`, but it contains no human account name or
account-to-person binding. Structured `request_user_input` outputs also
contain no stored actor role. This trajectory therefore does not prove
that the session account is Tapan Chugh. Naming Tapan Chugh as an ADR
decision-maker remains an accountability statement that requires his
review of this linkage; it is not derived from session metadata.

### HarnessEndpoin was normalized by the agent

Human event:

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019facae-c9c4-7b02-9d15-f5a59e642e81`.
- Enclosing turn: `019facae-c899-7422-8e83-c0e1839385f9`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T07:02:43.908Z`.
- Stored actor role: `user`.

Literal excerpt:

> just call it HarnessEndpoin

Agent event:

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `msg_0d0c5bdb13a3d3c4016a69a5a36a848190a43a383c0c7ae347`.
- Enclosing turn: `019fac92-e6af-7d32-8258-9417e3fe0554`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T07:03:02.049Z`.
- Stored actor role: `assistant`.

Literal excerpt:

> Locked as `HarnessEndpoint`—with the final “t.” MoltZap is the social
> harness; each endpoint daemon hosts one `HarnessEndpoint` for one
> `AgentId`. That replaces `SharedCore` everywhere.
>
> I’ll make the remaining low-level naming calls from that hierarchy and
> only bring back choices that affect the public or wire contract.

The final `t` is an agent normalization. This session contains no later
literal human event spelling `HarnessEndpoint`. The L1/L2 decision does
not introduce either spelling.

### Ambiguous alternative referent

The event `msg_019faec4-0251-7d00-ac49-3df4b0c7e1d1` says only “record
this alternative” immediately after one structured answer covering
list pagination, PollCursor shape, and send result. The following agent
message narrows it to the send-result alternative, but the session has
no later human confirmation of that narrowing. The literal instruction
and the relevant alternatives are retained under
[Router order is opaque](#router-order-is-opaque).

### MessagePack selection was aborted

The MessagePack question, its complete option set, and the literal
`aborted by user after 15.7s` output are retained under
[Identity uses JCS, JOSE, and AuthenticatedHttp](#identity-uses-jcs-jose-and-authenticatedhttp).
The later structured event records `Adopt JOSE/JSON (Recommended)`.
The aborted MessagePack prompt records no independent selection.

### Shared-adapter choice was revisited

The structured event at `2026-07-29T15:56:15.568Z` selected `Shared
adapter library`. The later free-form human event invokes deep modules;
the next agent message says its recommendation changed. The follow-up
structured answer selects no listed option and says the capability may
be “subsuumed into identity / transport ,aybe”. The later ownership
prompt records `Inside identity (Recommended)`. These events are
retained in order under
[Identity uses JCS, JOSE, and AuthenticatedHttp](#identity-uses-jcs-jose-and-authenticatedhttp);
the ledger does not attribute an unstated motive to the reversal.

### TLS answer was broadened

The initial `Deployment edge (Recommended)` option still required
clients to reject non-loopback plain HTTP. The later literal user
message says TLS “is a deployment concern fully” and rejects mandatory
non-loopback TLS termination in code. The intervening options and later
free-form instruction are both retained under
[Router order is opaque](#router-order-is-opaque). The later event is
not silently collapsed into the narrower initial option.

### Router is not fully stateless

The source distinguishes a stateless client-held PollCursor from the
Router process. The human selected Compact JWE with no per-cursor
records and later selected one bounded global ring. The agent explicitly
states, “The Router cannot be completely stateless,” and enumerates the
bounded message, retry, and nonce state. This trajectory therefore does
not use “stateless Router” as a synonym for “no durable or
recipient-specific server state.”

## Simulator provenance source gap

This source session contains no located public human event establishing
the original decision outcome, alternatives, or rationale for
`20260727-code-first-simulator-kernel.md`. No original simulator
decision session was supplied as a source for this compaction. The
session’s later implementation planning mentions partial supersession,
but an agent plan or repository history cannot reconstruct the missing
human decision event. This is a source gap, not evidence against the
current admitted outcome.

## Mechanical repository event

### Durable implementation ask requested

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf30-1225-75c1-b6c0-bf1fe7dae82a`.
- Enclosing turn: `019faf2f-1f43-7002-8a34-26c4d39b0ba3`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T18:43:11.013Z`.
- Stored actor role: `user`.

Literal excerpt:

> just one more nit: write this entire plan to durable storage to as an
> implementation ask; update to latest version of acg for the new
> packages before you start working, and check v1 code for design
> pattersn like refined types for ids etc

### ACG upgrade omitted before the commit

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator: `msg_019faf44-02bc-7b91-a782-cbf1c659ab24`.
- Enclosing turn: `019faf44-01b0-71d0-9a37-8ecaceb6ad9e`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T19:04:57.788Z`.
- Stored actor role: `user`.

Literal excerpt:

> install from chughtapan/safer-by-default (there shuold be claude
> install), omit the acg upgrade for now and then continue

### Durable implementation ask committed

- Source system: Codex CLI rollout JSONL.
- Source session: `019fac90-d26a-7e51-8708-06858bd118bd`.
- Native locator:
  `fco_019faf52-1191-79b2-99d0-be2452e26137`, call
  `call_vUKopXWWaNO3agJ6UWbXAqy3`.
- Enclosing turn: `019faf44-01b0-71d0-9a37-8ecaceb6ad9e`.
- Parent locator: absent from the stored event.
- UTC timestamp: `2026-07-29T19:20:19.089Z`.
- Stored actor role: absent (`function_call_output` from a mechanical
  repository command).

Literal excerpt:

```text
[v2 5d0cca97] docs: record L1 and L2 implementation ask
 2 files changed, 1060 insertions(+)
 create mode 100644 docs/architecture/l1-l2-implementation-ask.md
```

This mechanical event records a repository change. It is not a new
human architecture decision and does not make the implementation ask
normative.
