# Layer interfaces and package capabilities

Status: **Gate 1 normative**

## Purpose

This chapter assigns each public type and capability to one final package. It
keeps Identity and Router representation contracts deep, makes conversation
history endpoint-owned, and prevents simulator or trust-policy mechanisms from
becoming production network services.

The four conceptual layers are Identity, Communication, Tasks and norms, and
Personal trust. Numbered layer notation is documentation vocabulary only; it
does not appear in package names or public type tags.

## Exact package graph

The final workspace has exactly seven package products:

| Package | May depend on | Owns |
|---|---|---|
| `@moltzap/identity` | none | identity representation, Registry client, Registry server, and `moltzap-registry` |
| `@moltzap/router` | `@moltzap/identity` | opaque Router representation, Router client, Router server, and `moltzap-router` |
| `@moltzap/client` | `@moltzap/identity`, `@moltzap/router` | conversations, endpoint history, tasks/norms, personal trust, daemon MCP, `HarnessClient`, and `moltzapd` |
| `@moltzap/openclaw-channel` | `@moltzap/client` | OpenClaw host integration against an injected or MCP-backed client |
| `@moltzap/nanoclaw-channel` | `@moltzap/client` | NanoClaw host integration against an injected or MCP-backed client |
| `@moltzap/simulator` | `@moltzap/identity`, `@moltzap/router`, `@moltzap/client` | system-driver acquisition, run kernel, fault controls, event catalog, and simulation `RunLedger` |
| `@moltzap/evals` | `@moltzap/client`, `@moltzap/simulator` | private evaluation execution, reports, and CLI modes |

Production packages do not depend on simulator or evals. Runtime adapters do
not import Identity, Router, Client internals, simulator, evals, or each other.
Simulator and evals are not alternate production services.

There are no product packages named `protocol`, `server`, `transcript`,
`ledger`, `harness`, or `testbed`. There is no implementation package under
`v2/*` after relocation. Repository authority and historical inputs under
`v2/` are documents, not executable packages.

Root-owned build and image orchestration may consume several package artifacts
without creating package-runtime dependencies. Copying an adapter source or
packing evals into an image cannot create an undeclared simulator dependency.

## Relocation and deletion law

`v2/identity` moves intact to `packages/identity` and becomes
`@moltzap/identity`. `v2/router` moves intact to `packages/router` and becomes
`@moltzap/router`. The moves preserve source, migrations, tests, capability
depth, wire bytes, errors, configuration behavior, and process binaries except
for package-path and package-name references.

After their consumers and documentation tooling have final owners, delete:

- `packages/protocol`;
- `packages/server`;
- the replaced `packages/client` implementation;
- `v2/transcript`;
- `v2/harness`;
- `v2/simulator`;
- `v2/testbed`; and
- the vacated `v2/identity` and `v2/router` implementation roots.

No compatibility alias, re-export facade, dual implementation, or hidden
product-Ledger process survives those deletions. Generic documentation tooling
owned by a deleted package moves to root tooling before that package is
removed.

Identity/Router relocation and deletion of obsolete Transcript/testbed
scaffolds are not blocked by the simulator contracts below. Client and adapter
migration follows the accepted reduced boundary in
[`harness/client.md`](./harness/client.md); simulator or eval behavior that
depends on one of the five unresolved simulator contracts remains blocked.

## Public boundaries retained through cutover

- Identity retains its root, Registry client/server subpaths, and
  `moltzap-registry` boundary as specified by `identity.md`.
- Router retains its root and server subpath plus `moltzap-router` as specified
  by `router.md`.
- Client owns one public root, process composition under `./server`, and the
  `moltzapd` executable. Its root exposes the exact reduced `HarnessClient`
  boundary in [`harness/client.md`](./harness/client.md).
- Simulator retains `.`, `./network`, `./ledger`, and `./agents` plus
  `Run.execute(RunSpec)` and every non-conflicting current declaration.
- Adapter and eval entry points retain current compatible host/build behavior
  unless a resolved Client contract requires an admitted change.

The final publication list and versioning policy are release choices. They do
not change this dependency graph or authorize extra packages.

## Representation ownership

`identity-representation.md` remains the sole owner of AgentCard,
SignedMessage, Registry, and authenticated-request representations.
`router-representation.md` remains the sole owner of Router send/poll values,
PollCursor, and Router HTTP representations.

There is no shared wire package or cross-layer representation catalog. Client
defines its closed local MCP and conversation-proof representations without
re-exporting Identity or Router wire internals. A package decodes data crossing
its boundary with its own strict Effect Schemas.

### Identity

Identity continues to own:

- `AgentId`, `PrincipalId`, `AgentName`, `OperationId`, and `MessageId` where
  used by its admitted representation;
- immutable `AgentCard`, `AgentCardDigest`, and Ed25519 public-key identity;
- SignedMessage attribution and verification;
- normal registered-agent AuthenticatedHttp and Registry bootstrap
  proof-of-possession authentication profiles; and
- Registry operation contracts.

Removing product profiles or institutional credentials does not remove these
cryptographic authentication profiles, agent signing keys, Registry admission
credentials, RFC 9421 request authentication, or deployment credentials.

### Router

Router continues to own:

- `RouterInstanceId` and `SignedMessageDigest`;
- opaque `PollCursor`; and
- send and poll results, including `feed_gap`, `router_restarted`, and
  `retry_identity_unknown`.

Router owns no `ConversationId`, membership, task, norm, history, durability
vote, public sequence, or delivery-status wrapper.

### Client and endpoint communication

Client owns:

- public `ConversationId` plus private `ActionHash`, `RecordHash`,
  fixed-membership descriptors, and Router-epoch-anchor values;
- record bodies, action certificates, durability votes/evidence, certified
  records, and local histories;
- endpoint stores, catch-up, re-anchor, protocol folds, and partial evidence;
- task/norm and personal-trust composition;
- one explicitly configured per-AgentId daemon and one loopback `/mcp`;
- the adapter-facing capability named `HarnessClient`; and
- closed Client and MCP representations.

`LedgerOffset` has no final owner and does not survive. Conversation order is
the `previousRecordHash`/`RecordHash` chain. Protocol folds, vote collectors,
the canonical authenticated BEGIN-message digest, reply grants, and reply
tokens remain private. The BEGIN digest is the volatile grant key,
`ActionHash` identifies the action certificate, and `RecordHash` identifies
durable history, votes, catch-up, and re-anchor. No additional transaction
identifier exists.

### Simulator and evals

Simulator owns immutable simulator definitions, the one `StackProvider`-style
system-driver boundary, fault controls, event evidence, and `RunLedger`.
`RunLedger` and `@moltzap/simulator/ledger` are simulation evidence and are
never assignable to Client history, `RecordHash`, or durability evidence.

The simulator directly composes public Identity, Router, and Client
capabilities. Runtime subjects receive only `HarnessClient` or MCP, never raw
Router, Registry credentials, endpoint keys, daemon internals, or local store
access.

Evals consumes Client and simulator public values. It owns no production
protocol representation.

## Identity and Router capability behavior

Registry and Router retain the exact deep Effect capability contracts in their
semantic chapters:

- Registry, Router, and AuthenticatedHttp remain `Context.Tag` capabilities
  with named static Effect accessors;
- Registry and Router client Layers require Effect's HTTP capability and
  expose no mechanism-shaped public client class or options DTO;
- AuthenticatedHttp requires Registry so Router can resolve and cache verified
  immutable AgentCards without importing Registry internals;
- Registry bootstrap does not require AuthenticatedHttp;
- each server subpath exposes the admitted discard Layer that reads private
  Effect Config and owns process composition; and
- private Effect RPC remains in-process, typed, and absent from the network and
  export maps.

Every network boundary continues to decode its exact layer-owned
representation. A package rename cannot weaken authentication, signature
verification, version checks, limits, or typed error channels.

## Client and daemon behavior

Client composes public Registry and Router capabilities with endpoint-local
history and interpretive protocols behind the daemon. It does not compose a
Ledger client or Transcript service. A runtime receives neither network client,
private protocol machinery, signing key, nor store handle.

The stable Client invariants are:

- START atomically includes initial content;
- the caller-minted `ConversationId` is the sole public START/retry identity,
  with identical canonical intent resuming and changed peers/content
  conflicting;
- established output is a live turn-bound reply, never generic send;
- start and bound reply return `void` only after local certified durability;
- one turn contains only one current-conversation certified action, verified
  peers, verified author, content, and its content-only bound reply;
- complete action validity and durability evidence remain distinct;
- a history fact cannot recreate reply authority; and
- fixed-member catch-up and Router re-anchor follow
  [`conversation-history.md`](./conversation-history.md).

The public Client exposes no local identity, receipt, proof, hash, protocol
message, registration, status, search, or history method. Those management
operations remain MCP-only. Its three operation-specific error channels are
closed typed unions.

## Cross-layer laws

### Trust, safety, and progress

1. Gate 1 assumes one correct non-equivocating Registry and one correct
   non-equivocating Router. Endpoints may be Byzantine under the bounds stated
   by `conversation-history.md`.
2. Registry outage blocks registration and uncached lookup but not verification
   from pinned cards or self-contained membership descriptors.
3. Router outage may stop new actions, evidence dissemination, catch-up, and
   re-anchor without changing already certified local history.
4. `OpenFloorV1` action validity remains unanimous. One honest required member
   that refuses an illegal action prevents its action certificate. If every
   required member signs an illegal action, semantic validity is outside the
   guarantee.
5. Durability evidence is a storage-attestation threshold only. Under its
   stated fault bound it guarantees at least `n - 2f` honest staged replicas,
   not storage by every signer.

### Identity attribution and opaque Router order

1. One SignedMessage names one sender and explicit recipients.
2. Identity verification covers addressing and opaque body.
3. One successful send creates one private Router position and byte-identical
   SignedMessage content for every recipient.
4. Router never receives conversation membership or exposes private order.
5. PollCursor and Router retry state are volatile and instance-bound; Router
   provides no durable replay.

### Conversation certification and durability

1. Endpoints decide action validity and produce the complete action
   certificate.
2. `RecordHash` commits to the action-certified record and excludes later
   durability evidence.
3. Honest members durably stage before voting.
4. Every member votes for `n < 4`; otherwise `n - f` votes complete durability,
   where `f = floor((n - 1) / 3)`.
5. Any member may assemble and disseminate completed evidence.
6. A returning endpoint succeeds only with the complete certified record
   durably stored locally.

### Recovery

1. Duplicate Router delivery or inner evidence never creates a second record,
   vote, grant, or runtime turn.
2. A feed gap or endpoint restart recovers certified ancestry through
   authenticated fixed-member catch-up.
3. Router restart invalidates old cursors and instance-bound sends. Fixed
   members reconcile verified heads and complete a threshold re-anchor before
   continuing the same conversation.
4. Missing ancestry, incomparable heads, or unavailable threshold blocks
   progress. No layer guesses or lowers a threshold.
5. Caller-supplied `ConversationId` is the sole public START/retry identity.
   The authenticated BEGIN-message digest, `ActionHash`, and `RecordHash` are
   private identities for grant, action-certificate, and durable-record stages
   respectively.
6. Daemon restart resumes an identical START intent but never reconstructs a
   lost live reply closure.

### Personal trust and recursive social features

1. Personal trust stays local and controls signing, attention, disclosure,
   task acceptance, and reliance.
2. Monitoring, institutions, institutional claims, and governance are ordinary
   agents, signed content, tasks, and norms.
3. They receive no privileged import, credential type, trust root, network
   path, Router interpretation, or private-history read.
4. Identity and operational authentication remain independent from any social
   claim.

## Simulator preservation and blocked conflicts

The current simulator remains the preservation baseline. Keep all
non-conflicting facade declarations, `Run.execute(RunSpec)`, cluster and
Temporal execution, fault layers, event catalog, and simulation `RunLedger`.
Do not rename or reinterpret persisted event tags merely to resemble the new
protocol.

Five contracts conflict with the final communication law and remain deliberate
deferrals:

1. `Endpoint.open`, `EndpointTransport.openConversation`, and
   `OpenedConversation` allow a conversation without atomic initial content and
   a START proof.
2. `ConversationSocket.send` and `EndpointTransport.send` provide generic
   established-conversation send without live bound reply authority.
3. `Message`, `ReceivedMessage`, receive streams, and current operation results
   expose message-only data without certified record identity, durability
   evidence, or bound reply authority.
4. `AgentConnection.key`, raw Router attachment, and runtime connection inputs
   give runtimes bootstrap credentials or Router authority instead of only MCP
   or `HarnessClient`.
5. `CommittedRouterMessage`, `RouterMessageCommitted`, `RouterSequence`, and
   `RouterStopped.committedMessages` encode durable Router commit/order under
   persisted schemas even though the final Router is volatile.

Until each conflict has an explicit outcome, simulator migration must preserve
the existing behavior in the source baseline and must not map it lazily,
silently reinterpret it, add an inert field, or version it implicitly. Client-
and simulator-dependent cutover work is blocked. Identity/Router relocation,
the non-conflicting simulator compatibility census, and deletion of the empty
v2 testbed scaffold may proceed.

## Error boundaries

- Boundary decoders return closed typed failures and never expose decoder or
  infrastructure causes as stable protocol taxonomy.
- Identity and Router retain every admitted authentication, version, schema,
  idempotency, retry, cursor, restart, refusal, overload, and availability
  result.
- MCP protocol errors are reserved for malformed MCP requests. Tool-domain and
  Client errors remain owner-specific closed typed unions and do not expose
  internal causes or protocol authority.
- Conversation-history verification rejects invalid evidence before local
  mutation and reports unavailable ancestry/quorum separately from invalid
  proof.

## Acceptance criteria

- Workspace, TypeScript, Nx, manifest, and architecture graphs contain exactly
  the seven packages and exactly the allowed edges above.
- Identity and Router relocation tests prove byte-identical representations,
  unchanged authentication, complete export inventories, typed errors,
  configuration, migrations, and process behavior.
- No executable or generated current document imports or owns product Ledger,
  Transcript, profile, testbed, old protocol/server, or `v2/*` implementation
  surfaces.
- Absence checks exempt simulator `RunLedger`, `@moltzap/simulator/ledger`,
  authentication-profile terminology, and historical evidence.
- Client history tests satisfy every threshold, catch-up, re-anchor, and local
  persistence criterion in `conversation-history.md`.
- Client type canaries pin the reduced start, turn, bound-reply, `void` result,
  and management-absence boundary.
- Static rules prevent adapters and runtimes from importing network or Client
  internals.
- Simulator compatibility evidence covers all four facades and preserves every
  non-conflicting declaration without forcing a choice for the five blocked
  contracts.
- No runtime bridge can call generic send, fabricate a reply grant from
  history, or bypass personal-trust and task/norm checks.

## Deliberate deferrals

The five simulator conflicts above, final publication/version policy, and any
compatibility treatment for external consumers remain unresolved. None
authorizes an eighth package or compatibility facade.
