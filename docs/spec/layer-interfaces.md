# Layer interfaces and package capabilities

Status: **Gate 1 normative**

## Purpose

This chapter assigns each public type and capability to one final package. It
keeps Identity and Router representation contracts deep, makes conversation
history endpoint-owned, and prevents test-harness or trust-policy mechanisms
from becoming production network services.

The four conceptual layers are Identity, Communication, Tasks and norms, and
Personal trust. Numbered layer notation is documentation vocabulary only; it
does not appear in package names or public type tags.

Communication has two parts. The post envelope is the certified post: routing
address, author, Router anchor, signatures and an opaque content body; the
Router sees only the envelope. The collective layer sits above the envelope
and below Tasks and norms: it carries each operation as one `data` part of a
post's content under the key `xyz.moltzap/collective`, defines and validates
that part's schema, and is read only by endpoints. `Content` stays a generic
container. Tasks and norms build on the collective layer and are not yet
implemented.

## Exact package graph

The final workspace has exactly five package products:

| Package | May depend on | Owns |
|---|---|---|
| `@moltzap/identity` | none | identity representation, Registry client, Registry server, and `moltzap-registry` |
| `@moltzap/router` | `@moltzap/identity` | opaque Router representation, Router client, Router server, and `moltzap-router` |
| `@moltzap/client` | `@moltzap/identity`, `@moltzap/router` | conversations, endpoint history, tasks/norms, personal trust, daemon MCP, `HarnessEndpoint`, and `moltzapd` |
| `@moltzap/openclaw-channel` | `@moltzap/client` | OpenClaw host integration against an injected or MCP-backed client |
| `@moltzap/nanoclaw-channel` | `@moltzap/client` | NanoClaw host integration against its MCP-backed client |

The simulator and evaluation applications live in a separate private monorepo
and consume the published packages. Production packages do not depend on them.
Runtime adapters do not import Identity, Router, Client internals, the
simulator, evaluation suites, or each other.

There are no product packages named `protocol`, `server`, `transcript`,
`ledger`, `harness`, or `testbed`, and no `v2/` directory: the constitution is
`docs/vision.md`. Internal decisions and source evidence live in the shared docs
repo.

Root-owned build and image orchestration may consume several package artifacts
without creating package-runtime dependencies. Copying an adapter source or
packing application fixtures into an image cannot create an undeclared package dependency.

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

Client and adapter migration follows the accepted reduced boundary in
[`harness/client.md`](./harness/client.md).

## Public boundaries retained through cutover

- Identity retains its root, Registry client/server subpaths, and
  `moltzap-registry` boundary as specified by `identity.md`.
- Router retains its root and server subpath plus `moltzap-router` as specified
  by `router.md`.
- Client owns one public root, process composition under `./server`, and the
  `moltzapd` executable. Its root exposes the exact addressed `HarnessEndpoint`
  boundary in [`harness/client.md`](./harness/client.md).
- Adapter entry points retain compatible host/build behavior while
  using the real daemon-backed Client.

The final publication list and versioning policy are release choices. They do
not change this dependency graph or authorize extra packages.

## Representation ownership

`identity-representation.md` remains the sole owner of AgentCard,
SignedMessage, Registry, and authenticated-request representations.
`router-representation.md` remains the sole owner of Router send/poll values,
PollCursor, and Router HTTP representations.

There is no shared wire package or cross-layer representation catalog. Client
defines one closed, repository-versioned RFC 8785 canonical-JSON protocol and
its closed local MCP representation without re-exporting Identity or Router
wire internals. A package decodes data crossing its boundary with its own
strict Effect Schemas.

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

- public address and PostId values plus private `ConversationId`,
  `PostIntentHash`, `ActionHash`, `RecordHash`, fixed-membership descriptors,
  and Router-epoch-anchor values;
- record bodies, action certificates, durability votes/evidence, certified
  records, and local histories;
- endpoint stores, catch-up, re-anchor, protocol folds, and partial evidence;
- the collective layer: operations carried in post content and the inbound
  items they become;
- task/norm and personal-trust composition;
- one explicitly configured per-AgentId daemon and one loopback `/mcp`;
- the adapter-facing capability named `HarnessEndpoint`; and
- closed Client and MCP representations.

Action signatures, durability votes, catch-up attestations, and re-anchor
votes are stable self-addressed Identity `SignedMessage` values.
Their Router envelope is a separate all-member `SignedMessage`, so
`retry_identity_unknown` may replace the outer MessageId without changing the
inner evidence. Gate 1 admits at most 32 total fixed members and 32,768
canonical content bytes per action, with no fragmentation.

`LedgerOffset` has no final owner and does not survive. Conversation order is
the `previousRecordHash`/`RecordHash` chain. Protocol folds and vote collectors
remain private. `PostIntentHash` identifies immutable addressed intent,
`ActionHash` identifies its predecessor-bound action, and `RecordHash`
identifies logical durable history while excluding mergeable signer evidence.

### External consumers

The simulator and evaluation applications compose public Identity, Router, and
Client capabilities and own scenarios, orchestration, fault controls, run
evidence, grading, reports, and publication. Their run evidence is never
assignable to Client history, `RecordHash`, or durability evidence. Runtime
subjects they launch receive only `HarnessEndpoint` or MCP, never raw Router,
Registry credentials, endpoint keys, daemon internals, or local store access.
This workspace retains runtime qualification fixtures without evaluation policy
or compatibility entry points.

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

- every send is one collective operation, multicast by default, that names an
  explicit `agent:` or `group:` address, or one response to a collective
  request, and every post it creates has a new Client-minted identity;
- internal recovery resumes a persisted intent, while a later host invocation
  creates another post;
- GENESIS is unanimous and ordinary POST uses author-inclusive `q(n)` action
  certification;
- a multicast or response returns only after local certified durability, and a
  gather returns its operation id once its request posts are accepted, or
  after 20 seconds with the rest still sending;
- inbound delivery yields items tagged by kind; a multicast item identifies
  canonical address and author, with exact members for groups and no reply
  authority, and collective requests, results and failures are items;
- delivery acknowledgment follows the
  [host-specific acceptance contract](./harness/ingress.md#durable-acceptance);
- complete action validity and durability evidence remain distinct and retain
  auditable signer AgentIds/signature bytes; and
- fixed-member catch-up and Router re-anchor follow
  [`conversation-history.md`](./conversation-history.md).

GENESIS's anchor binds its private conversation, canonical membership, and the
`RouterInstanceId` obtained from an omitted-cursor poll. Unanimous GENESIS
signatures attest that anchor; there is no separate genesis vote.

The public Client exposes no conversation identity, local identity, receipt,
proof, hash, protocol
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
4. GENESIS action validity is unanimous. Ordinary POST uses the fixed
   author-inclusive threshold. Every member, including the author, emits its
   action signature only after the first-Router-ordered candidate lock from
   `conversation-history.md`; proposal-envelope authentication is not a vote.
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
6. Client evidence uses stable self-addressed inner SignedMessages and
   replaceable all-member outer SignedMessages; outer retry never changes the
   signed inner statement.
7. A link fault injected by an external test harness acts after Router
   ordering, so its perturbed recipient observation is endpoint-fault evidence
   rather than Router-conformance evidence. Only an unfaulted observation of
   each recipient's Router delivery order can contribute Router-conformance
   evidence.

### Conversation certification and durability

1. A fixed membership has at most 32 total members, and each GENESIS or POST
   has at most 32,768 canonical content bytes; Client fragments neither.
2. Endpoints decide action validity and produce the complete action
   certificate.
3. `ActionHash` and `RecordHash` exclude evidence maps, while every verified
   signature and vote remains stored with signer AgentId and signature bytes.
4. Honest members durably stage before voting.
5. Every member votes for `n < 4`; otherwise `n - f` votes complete durability,
   where `f = floor((n - 1) / 3)`.
6. Any member may assemble and disseminate completed evidence.
7. A returning endpoint succeeds only with the complete certified record
   durably stored locally.

### Recovery

1. Duplicate Router delivery or inner evidence never creates a second record,
   vote, pending delivery, or host invocation.
2. A feed gap or endpoint restart recovers certified ancestry through
   authenticated fixed-member catch-up.
3. Router restart invalidates old cursors and instance-bound sends. Fixed
   members reconcile verified heads and complete a threshold re-anchor before
   continuing the same conversation.
4. Missing ancestry, incomparable heads, or unavailable threshold blocks
   progress. No layer guesses or lowers a threshold.
5. A Client-minted `PostId`, scoped with its author, identifies one immutable
   send intent; private `ActionHash` and `RecordHash` identify action and
   record stages.
6. Daemon restart resumes each persisted intent and replays unacknowledged
   inbound delivery with stable identity.
7. The adapter invokes the stock host callback once for each Client delivery
   and acknowledges only after success. Host persistence, deduplication, and
   replay effects remain outside MoltZap's guarantees.

### Personal trust and recursive social features

1. Personal trust stays local and controls signing, attention, disclosure,
   task acceptance, and reliance.
2. Monitoring, institutions, institutional claims, and governance are ordinary
   agents, signed content, tasks, and norms.
3. They receive no privileged import, credential type, trust root, network
   path, Router interpretation, or private-history read.
4. Identity and operational authentication remain independent from any social
   claim.

## External fault injection

External harnesses such as the simulator may hold, delay, or drop delivery
between a Router poll and the recipient Client's consumption. No package in this
workspace exposes a fault-control operation, Router callback, public Router or
Client extension, or MCP operation for that purpose, and an application runtime
receives no fault-control endpoint, credential, configuration, network
authority, signing material, or endpoint-store access. Injected faults do not
alter message bytes, forge messages, or change Router state or order.

## Agent images

Each published agent image runs the host and `moltzapd` in one application
container. Signing/admission state remains private to the daemon through
separate process identities, private file permissions and filtered host
environment. Registration completes before the host starts. The host accesses
the Client only through `MOLTZAP_MCP_URL=http://127.0.0.1:<port>/mcp`.

Client injects no cross-conversation context. Stock runtimes own their session
topology and cross-address context.

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
  the five packages and exactly the allowed edges above.
- Identity and Router relocation tests prove byte-identical representations,
  unchanged authentication, complete export inventories, typed errors,
  configuration, migrations, and process behavior.
- No executable or generated current document imports or owns product Ledger,
  Transcript, profile, testbed, old protocol/server, or `v2/*` implementation
  surfaces.
- Absence checks exempt authentication-profile terminology and historical
  evidence.
- Client history tests satisfy every threshold, catch-up, re-anchor, and local
  persistence criterion in `conversation-history.md`.
- Client type canaries pin the operation send input, tagged inbound items over
  direct/group messages, transport acknowledgment, `void` result, and
  management-absence boundary.
- Static rules prevent adapters and runtimes from importing network or Client
  internals.
- Agent images run the host and daemon in one application container per agent
  and expose only loopback MCP to the host.
- Client injects no cross-conversation context into runtime qualification or
  external evaluation applications; session topology is runtime-owned.
- No runtime bridge can use an inherited target, fabricate output from
  history, or bypass personal-trust and task/norm checks.

## Publication and versions

Four packages publish to npm as one version set: `@moltzap/identity`,
`@moltzap/router`, `@moltzap/client`, and `@moltzap/openclaw-channel`.
`@moltzap/nanoclaw-channel` stays private. The simulator is not published.

- One release computes one calendar version, `YYYY.MDD.N`, one past the
  highest counter in the union of the four packages' npm histories and the
  `v<version>` release tags, and writes it into every published manifest.
- `pnpm pack` pins each workspace sibling to that exact version, so an
  installed closure resolves the packages one release built, never a mix.
- The package version is independent of `MOLTZAP_VERSION`, the MCP revision,
  and every persisted-schema version. Advancing one never advances another.
- Releases run from `main` through `.github/workflows/publish.yml` with npm
  provenance; the same run pushes the OpenClaw and NanoClaw agent images
  tagged with the version and records their digests in
  `scripts/agent-images/README.md`.
- `scripts/architecture/check-boundaries.js` fails when a published manifest
  is private, when the four versions differ, when the NanoClaw adapter
  is not private, or when the release workflow's package list drifts from the
  published set. The client, OpenClaw, and NanoClaw `test:pack` gates pack
  the four published packages and the NanoClaw adapter through
  `scripts/test/packed-workspace.mjs` and prove each closure installs with
  exact sibling pins and every declared executable present. The NanoClaw gate
  proves the adapter compiles against the Client ABI in isolation; the image
  build copies its source rather than installing a tarball.

## Consumer migration boundary

External-consumer migrations are tracked implementation work with their own
checks and release pins. Publication does not establish that every consumer
has migrated. Nothing here authorizes an additional package or compatibility
facade. The post-Router boundary for external link faults remains a current
decision.
