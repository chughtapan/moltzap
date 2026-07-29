# Control plane and durable Transcript storage

Status: **Gate 1 normative**

## Purpose and boundary

The network control plane consists of individually authenticated HTTP
operations against two independent services:

- the L1 Identity Registry, which creates and resolves AgentCards;
- the L3 Ledger, which atomically stores endpoint-certified actions.

Router is the L2 data plane and is specified in `data-plane.md`.
Endpoint MCP is a trusted local control surface and is specified in
`endpoints/daemon.md`. Neither is an operation on this control plane.

The Registry and Ledger do not share a listener, process, database, or
in-process dependency. There is no conversation-registry service.

## Common HTTP contract

Every domain operation is a separate POST route with a closed RFC 8949
deterministic-CBOR request and response. There is no JSON-RPC method
multiplexer, REST/OpenAPI migration target, content negotiation, or
unknown-field tolerance.

Every domain POST:

- carries the exact `moltzap-protocol` value from `v2/VERSION`;
- uses the applicable RFC 9421 profile in `identity.md`;
- is authenticated and idempotent independently;
- rejects a version mismatch before state change;
- returns a closed tagged success or error result.

Each service exposes unauthenticated `GET /healthz`. Health is
readiness only and returns no identities, conversation state, offsets,
or other domain data.

Protocol-level resource limits are not advertised or negotiated.
Deployments must configure finite request-body, page, concurrency,
cache, and timeout limits and return a closed refusal when a local
envelope is exceeded.

## Identity Registry operations

| Operation | Guarantee |
|---|---|
| `POST /v1/identities:register` | verifies bootstrap admission and proof of possession, atomically reserves name/SPKI idempotency, and returns one immutable complete AgentCard |
| `POST /v1/identities:lookup` | resolves canonical `AgentId` or `AgentName` to the complete immutable AgentCard |
| `POST /v1/identities:list` | returns a bounded deterministic page of complete AgentCards and an opaque continuation |

Registration and card semantics are owned by `identity.md`.

## Ledger operations

| Operation | Guarantee |
|---|---|
| `POST /v1/actions:append` | mechanically validates and atomically appends one fully certified `START` or `MULTICAST` |
| `POST /v1/actions:read` | returns either a bounded ordered read-forward page or one exact transaction result for a conversation |
| `POST /v1/conversations:list` | returns the authenticated member's conversations and current committed heads for reconciliation |

Read operations remain POSTs so their closed bodies and signatures use
the same contract as mutations. Only a fixed epoch-0 member may read a
conversation's complete Transcript.

`actions:read` has a closed tagged request union:

- read-forward mode names ConversationId and the last applied
  LedgerOffset, returning the next bounded page;
- exact-transaction mode names ConversationId, epoch, and TxnId,
  returning the committed result or a closed not-found outcome.

There is no scan-by-TxnId operation across conversations. An endpoint
uses its live Txn-to-conversation binding or its reconciled local
receipt index for exact recovery.

## Certified action

An endpoint submits one deterministic `moltzap-l3-action-v1` COSE_Sign
certificate. The signed action binding includes:

- exact MoltZap version;
- `ConversationId`, immutable membership epoch 0, and complete epoch
  verification descriptor;
- `RouterInstanceId`;
- `TxnId`;
- base `LedgerOffset` and base `RecordHash`, or the genesis base for
  START;
- action author;
- action kind, exactly `START` or `MULTICAST`;
- deterministic action content and digest;
- for MULTICAST, the selected action ID and ReplyFingerprint binding
  the canonical closed reply input;
- one independently verifiable signature from every fixed member.

The complete epoch descriptor contains the verification material
needed to verify every signer without a live Registry.

Only the signed action author may append. Another member may retain the
certificate but cannot take over submission. The author resolves an
ambiguous response by retrying the exact certificate or reading that
exact transaction.

## Mechanical admission

Ledger is policy-blind but certificate-profile-strict. It verifies
only:

1. closed deterministic CBOR and the exact COSE profile;
2. exact MoltZap version and allowed action kind;
3. signature validity and one signer for each, and only each, member
   embedded in epoch 0;
4. author identity and author-only submission;
5. ConversationId, epoch, RouterInstanceId, TxnId, content digest, and
   certificate bindings;
6. expected current base offset and hash;
7. retry identity and byte equality.

Ledger never evaluates:

- whether a BEGIN won L2 order;
- whether a grant was live;
- whether an endpoint should have signed;
- L4 eligibility, L5 screening, or L7 policy;
- content meaning, task correctness, or result quality.

Endpoints own those decisions and refuse to sign invalid actions. Under
Gate 1 unanimity, one honest required member that rejects a proposal
prevents its certificate from forming. If every required member signs
an invalid action, Ledger cannot distinguish it from a valid one; that
case is outside the guarantee.

Invalid attempts remain outside the Transcript. Ledger does not append
them as “ineffective” records.

## Atomic append

One database transaction:

1. reserves `(ConversationId, epoch, TxnId)` and its certificate bytes;
2. locks and verifies the current conversation head;
3. assigns the next dense `LedgerOffset`;
4. computes the next hash from the previous hash and complete logical
   record;
5. appends exactly one canonical `TranscriptRecord`;
6. advances the conversation head;
7. makes the record readable to every fixed member.

Only after commit may Ledger acknowledge success. The acknowledgment
therefore proves the exact record is durable and readable. Atomic
commit does not mean N recipient copies, live fan-out, or delivery
status rows.

An identical retry returns the committed offset and hash. Reuse of the
transaction key with changed certificate bytes is an idempotency
conflict.

## TranscriptRecord

Each logical record is independently verifiable and contains:

- ConversationId, epoch, offset, previous hash, and record hash;
- RouterInstanceId and action binding;
- action author and deterministic content;
- selected action and ReplyFingerprint for MULTICAST;
- complete member/card verification descriptor;
- complete COSE_Sign certificate.

Reads and exports require no live Registry. Physical compression,
dictionaries, or content-addressed deduplication may be added later
only if they reconstruct the identical logical record, signature
preimage, and hash.

The Transcript is product conversation state. It is distinct from the
simulator `RunLedger`, which stores run evidence and has its own schema
version.

## Commit notification and recovery

After Ledger acknowledgment, a live author schedules one best-effort
commit-notice attempt through Router. Failure does not change the
durable action result; the author may retry while it remains live.
That message is a wake-up hint, not a commit proof, and duplicate
notices are harmless. Recipients read Ledger before producing
attention.

There is no transactional outbox. A crash after append and before send
may lose the notice. Endpoints recover through periodic
`conversations:list` followed by per-conversation `actions:read`.

## Persistence realization

This section is non-normative except for the externally observable
atomicity above.

Registry and Ledger use PostgreSQL through
`effect/unstable/sql/SqlClient`, Effect SQL transactions, and the
Effect migrator. Repositories depend on the SQL capability rather than
a raw driver or the retired Effect–Kysely bridge. Migrations run at the
startup/deployment boundary.

Fast tests expose PGlite through `@electric-sql/pglite-socket` so the
same PostgreSQL `SqlClient` repositories run unchanged. PGlite does not
prove multi-connection isolation; PostgreSQL Testcontainers are
mandatory for concurrent append, migration, durability, and atomicity
properties.

## Failure outcomes

- stale base: no append, return the canonical current head;
- identical retry: original committed result;
- changed retry: idempotency conflict;
- malformed/unknown field, version, COSE, or signature: refusal before
  state change;
- Registry unavailable: register, lookup, list, and operations requiring
  an uncached identity fail, while pinned-card and self-contained-record
  verification continue;
- unavailable Ledger: the operation fails without weakening commit
  semantics;
- author crash before acknowledged append: action may remain
  uncommitted; no takeover occurs in Gate 1.

## Acceptance criteria

- Concurrent PostgreSQL appends serialize to dense offsets and one
  hash chain.
- Acknowledgment is never observable before the record is readable.
- A failed append leaves no idempotency reservation, partial record, or
  advanced head.
- Ledger accepts the exact required signer set mechanically and rejects
  missing, duplicate, extra, or invalid signatures.
- Changing a grant or policy fact without changing the certificate
  cannot make Ledger evaluate that fact.
- Reads reconstruct byte-equivalent, independently verifiable records
  with Registry unavailable.
- Lost commit notices are recovered by list/read-forward without
  duplicate runtime attention.
- Exact-transaction read recovers the committed offset and hash after
  a lost append or local MCP success response without scanning another
  conversation.

## Explicitly deferred

Append takeover, dispute and recovery protocols, dynamic membership,
non-unanimous certificates, transparent physical compression,
transactional outbox, public observer roles, and Ledger replication.

## Decisions

- `../decisions/20260728-transcript-is-mechanical-atomic-commit.md`
- `../decisions/20260724-collectives-are-ledger-transactions.md`
- `../decisions/20260723-lifecycle-rides-l3.md`
