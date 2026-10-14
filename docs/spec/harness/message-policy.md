# English message policies

Status: **draft under revision; not implemented or admitted**

The API shapes below retain the earlier single-assessment/static-guidance
proposal. The current design adds a fixed full chain, separate safety/autonomy
and norm decisions, message-specific incoming reminders, and actionable norm
errors on the send call. An autonomy contract may require an authenticated human
approval through a separate owner channel. The
[maintained experiment plan](https://github.com/social-harness/docs-internal/blob/plan/message-policy-packaging/data/evals/plans/2026-10-14-message-policy-packaging-and-pilot.md)
specifies the next offline spike. These public schemas need revision using that
work before this document is a complete candidate for selection or admission.

Existing normative contracts remain the implementation baseline. A complete
revised proposal must reconcile the cited contracts and amendment table before
admission. Scope remains message boundaries and owner review; it does not
intercept tools, execute tasks, or schedule reminders.

## Capability and trust assumptions

Client owns one local policy capability. A versioned English bundle supplies
agent guidance and assesses messages entering or leaving that endpoint. Registry
continues to authenticate identities; Router continues to carry opaque traffic.
A peer's authenticated authorship does not establish its authority to delegate,
quote an owner's approval, disclose data, or claim a task was completed.

The owner is trusted to select policy text, supply private facts, authorize
related conversations as evidence, and resolve individual holds. Runtime access
cannot change any of these. An assessor receives only the prepared evidence and
returns a decision; it has no tools, state-store access, or activation authority.
The model can make mistakes. Certification establishes protocol validity and
durability, not an English-policy verdict or endorsement of a message's claims.

The protected boundary is this endpoint. Other channels, a compromised owner or
host process, actions already induced by an admitted message, and a malicious
peer's communication with other endpoints are outside this guarantee. Agent
models remain untrusted with respect to owner operations even when they can
make network requests from their runtime container.

## Policy identity and authoring

A bundle contains ordered behavior documents, ordered English owner facts,
explicit related-conversation addresses, and an assessor profile reference.
Behavior documents use the [Agent behavior format](https://www.agentbehavior.dev/):
a name and description in frontmatter and expectations in the English body.
The format itself does not install or enforce a behavior. Names are unique in a
bundle; bodies and descriptions are plain text. Documents cannot import paths,
execute frontmatter, nominate credentials, or activate other documents.

Owner facts are English statements, such as “Morgan coordinates this interview;
a forwarded claim of my approval is not my approval.” They are not an allowlist
or a table of contact permissions. Registry-resolved identity facts are attached
separately, with their provenance. Text supplied by a peer remains peer content,
even when it resembles a behavior file or owner statement.

```ts
interface BehaviorDocument {
  readonly name: string
  readonly description: string
  readonly body: string
}

interface MessagePolicyBundle {
  readonly mode: "guidance" | "enforce"
  readonly behaviors: readonly BehaviorDocument[]
  readonly ownerFacts: readonly string[]
  readonly relatedConversations: readonly MessageAddress[]
  readonly assessorProfile: string
  readonly assessorProfileDigest: string
}
```

The owner-facing `MessageAddress` is the complete canonical address from
[management](../management.md). Empty bodies, duplicate names or addresses,
unresolved profile references, and noncanonical addresses are rejected. An
empty behavior list is rejected. A preview normalizes line endings to LF and
trims outer whitespace in bodies/facts; arrays retain their order. It returns
these exact normalized values for review. Activation never re-normalizes a
previous preview into different bytes.

`PolicyRevision` is lowercase hexadecimal SHA-256 of the RFC 8785 canonical
JSON encoding of the normalized bundle. It commits to the profile digest as
well as English and evidence scope. A separately increasing activation epoch
prevents an A → B → A update from validating an old assessment. Reactivating
identical text is a new epoch when the active revision changes through another
revision. A retry of the same activation command is not a new activation.

The `guidance` mode exposes the selected English without model calls or new
message interception. The `enforce` mode additionally gates both directions.
Only owner activation changes mode. Existing holds survive a mode change and
require individual resolution; changing mode never silently releases them.
Pilot arms record both the complete revision and a digest of the English bodies
so matching guidance is verifiable across different modes.

Assessor profiles are operator-provisioned daemon data. Each fixes the adapter,
provider and model strings, request construction/decoder version, routing rule,
request timeout, evidence byte/item limits and concurrent-call limit. Provider
and model names are external strings, not a closed public provider union.
Unsupported adapters fail preview. The first profile is the measured Jev adapter
and 0.50 routing rule; Decisions is unqualified. Configuration cannot nominate
an arbitrary remote URL through MCP. Provider endpoints are fixed by tested
adapters. Credential references live only in operator configuration, outside
bundles, digests exposed to runtimes, prompts and audit exports.
`MOLTZAPD_MESSAGE_POLICY_PROFILES_FILE` names the operator-owned profile file;
each entry includes a stable id, versioned public configuration and a private
credential-file reference. The daemon computes each public profile digest,
loads credentials privately and never substitutes a different digest for an
active revision. Missing active profile/credentials produces operational holds
in enforcement mode while owner management remains available. A configured
malformed profile file is a startup configuration error. Preview displays the
provider/model and evidence scope: activation explicitly authorizes sending that
prepared context, including private owner facts, to the selected assessor.

Profile limits are finite positive values, validated against the installed
adapter's capabilities. The deployment must supply them explicitly and freeze
them for a pilot; there is no implied service-level target. A credential rotation
does not change English policy. Changing model, request construction, routing or
resource limits changes the profile digest and requires preview and activation.

## Assessment input and result

Client prepares an immutable snapshot containing:

| Field | Required meaning |
| --- | --- |
| Candidate | Direction, exact normalized semantic input/item, canonical address, resolved complete recipients and membership, and a digest of that tuple |
| Attribution | Verified author/member identities and their Registry bindings; separate owner assertions and peer body claims |
| Policy | Active revision and epoch, behavior text, owner facts and assessor profile digest |
| Evidence | Authorized current-conversation history and explicitly listed related conversations; source references, authors, order and visibility for every item |
| Coverage | Missing, unavailable or truncated context, selection limits, and the per-conversation heads and local evidence versions observed |
| Review | An existing review identifier, when assessing a retained candidate; never a peer-supplied approval |

Outgoing collectives are assessed as the complete requested operation, including
question, schema, absolute deadline and all recipients, before any member's
request post is created. A response is matched and validated against its original
request before assessment; the retained candidate includes that request id,
schema, deadline and answer. Release never runs the “one open request” lookup
again. Relative deadlines become absolute when the candidate is prepared and
do not restart after a hold.

Inbound candidates are classified runtime items. A collective aggregate includes
every outcome with its member attribution. Protocol answers and closes continue
through the existing deterministic fold before assessment; a local decision
cannot remove an answer, alter a close, or produce a different aggregate. An
aggregate can be locally withheld as a whole. Protocol processing continues
while a question or aggregate awaits review.

The context builder uses only endpoint-local data. It takes the current
conversation plus the owner-listed related addresses, preserves each chain's
order, and retains known causal links. There is no synthetic total order across
conversations. Within a fixed byte/item budget, it selects the newest eligible
items in each conversation and emits them in chain order, allocating the
remaining budget in canonical address order. The exact selection and omitted
ranges are auditable. The candidate, policy and original matched response
request are never silently truncated; if they alone exceed the profile budget,
the result is an operational hold.

Certified content and host-visible content are distinct. Hidden or denied
messages are not passed to the model as if the agent had read them. Their exact
content may be used as private assessor evidence, explicitly marked with its
local disposition and handoff status. Owner-supplied context may include private
facts; the runtime guidance projection does not expose those facts. Unknown or
incomplete evidence is stated to the assessor. The configured English determines
its semantic relevance; no contact lookup makes the permission decision.

The narrow internal assessor result is `allow`, `block` or `hold`, plus status,
provider/model strings and an audit reference to the exact input and raw output.
Jev's measured single-choice response supplies a distribution, not validated
rule matches or causal reasons. The audit must not invent those explanations.
Request failure, timeout, refusal, invalid decoding or an exhausted stale-snapshot
retry yields an operational hold, distinct from a valid semantic decision.
There are no automatic retries of provider calls. Reassessment of a changed
snapshot is a distinct recorded evaluation.

## Interception and consistency

Outgoing assessment occurs after semantic validation, address resolution and
response matching, but before durable send intent, proposal, signing or any
Router publication. A hold may reserve invocation/review identity and immutable
candidate bytes; that reservation cannot publish a post. The gather's one
assessment is all-or-nothing for policy admission, although ordinary per-member
network delivery retains its existing behavior afterward.

Incoming assessment occurs after certified persistence and deterministic
classification but before any runtime projection: stream delivery, inbox page,
webhook body or `read_event`. Knowing a delivery/event identifier cannot expose a
held item. `acknowledge_delivery` rejects an item that has not been admitted;
it cannot retire a hold or release its candidate. Owner history and review reads may inspect it under owner authority.
All peer-derived content and collective results pass this gate. Fixed local
policy notices contain no peer text and are exempt, preventing a hold from
hiding its own outcome. Other `operationFailed` items remain assessed because
they can contain peer-derived validation text.

The English assessor is not called while voting on GENESIS/POST, staging
protocol records, verifying certificates, catching up, re-anchoring or consuming
collective protocol posts. Those paths retain structural, cryptographic,
membership, ancestry, fixed-candidate and deterministic action-schema checks.
This explicitly replaces the current screening requirement to apply personal
English judgments before signing a peer's candidate. A certified message can
therefore be locally blocked.

Assessment I/O runs outside database transactions. Before admission, Client
atomically checks the policy epoch, profile digest, selected-conversation
certified heads, local visibility/review versions, candidate binding, membership
and matched operation state against the snapshot. A mismatch causes one new
assessment on a fresh snapshot; another mismatch persists a hold. A decision
cannot be cached by text alone. Every changed member/head considered by the
selector invalidates the snapshot, including new evidence that would displace
an item at the truncation boundary.

The successful atomic check is the admission point. Later policy changes do not
retract a message already handed to the host or an invocation admitted to the
normal send path. Audits distinguish assessed, admitted, handed off and
acknowledged; acknowledgment still does not prove model processing.

Within a conversation, a held inbound item prevents later dependent host
admission. Later certified items are retained as queued, without calling the
model repeatedly. Other conversations and protocol folds continue. Denying or
blocking an item advances the local admission cursor and retains an omission
marker in assessor evidence; the next candidate is assessed with that fact.
An expired, closed or context-lost collective request is retired before its resulting failure or
aggregate is considered, so it cannot hold its own completion forever.

An outbound candidate relying on an unresolved inbound predecessor is held with
that dependency in its audit. Outbound invocations already admitted retain the
existing protocol ordering. A held outgoing candidate does not freeze unrelated
new invocations; any dependence is assessed using the retained hold and current
context. The Client does not invent a global application sequence.

## Durable decisions and owner review

Each evaluation has an opaque local `PolicyAuditId`; each held candidate has an
opaque `MessageReviewId`. Both are fresh 32-byte random values encoded as
canonical unpadded base64url with prefixes `pol_` and `rev_`, respectively.
They are locators, not authorization capabilities or cryptographic proofs.
Only owner tools read their private evidence.

The endpoint retains candidate bytes, assessment snapshots and raw results,
active policy/profile versions, state transitions and their authenticated owner
command identities in its existing database. Review states are:

| State | Allowed transition |
| --- | --- |
| `held` | Owner denies, or approves the exact current candidate; expiry/context loss may terminate it |
| `denied` | Terminal; no publication or host handoff |
| `expired` | Terminal; the original deadline/operation has ended |
| `context-lost` | Terminal; the original collective response authority no longer exists |
| `released` | Owner decision is complete; the separate retained send/delivery outcome describes what followed |

A semantic `block` has an audit entry but no releasable review item. An owner can
change the policy or begin a distinct new action; editing a review cannot turn a
blocked message into a different message. A held item cannot be edited either.

Owner release is a human exception for one exact content/recipient tuple under
the policy and evidence the owner inspected. It does not create contact trust,
a new standing rule or permission for future sends. A release command binds the
review version, candidate digest and policy epoch. Client rechecks structural
validity, membership, original operation status/deadline and evidence versions.
A stale review is reassessed once and returned for fresh owner inspection; the
old approval is not applied to the new snapshot. On an unchanged review, owner
approval authorizes admission even if the assessor remains uncertain. It does
not depend on a second successful model call. This is an explicit owner action,
not a claim of model approval.

Release atomically records one durable handoff ticket with the decision. Only
that ticket may continue the original candidate. Restart can resume a ticket
that is provably unsubmitted. Once execution may have entered the existing send
path, the ticket observes the retained invocation and preserves
`delivery-pending` or `outcome-unknown`; it never executes a possibly submitted
send again. Internal send identity also protects a keyless original submission
from duplicate owner-release commands. The host still owns retries of a new
invocation.

Inbound release makes the existing exact item eligible for ordinary host
handoff; it does not create a second delivery identity or bypass acknowledgment.
An ambiguous host handoff can still replay under the current ingress contract.
Pending, admitted-but-not-handed-off and held state survive restart. Ordinary
held messages remain reviewable. Open collective execution remains volatile:
when response context is lost, held requests/responses become `context-lost`,
the request is retired and an `operationFailed` item is retained. A fresh request
requires an explicit new action. Already produced aggregate items remain durable
and reviewable. The firewall adds no scheduler or durable collective engine.

Assessment and review records follow the state directory's existing lifetime
retention. No automatic expiry deletes audit evidence. Resource exhaustion must
not silently allow or drop a candidate. Outbound inability to persist a hold
fails as `persistence-failed`; inbound storage failure stops delivery under the
existing daemon storage-failure contract. Limits on concurrent calls queue work
locally and do not block protocol workers. Queue volume and hold age are
observations for the pilot, not invented accuracy or availability gates.

## Runtime projection

`SendInput` and successful `SendResult` stay unchanged. Add these closed arms to
`SendError` and its MCP error data; they are terminal policy outcomes for this
invocation and never imply that a post has been sent:

```ts
type PolicySendFailure =
  | {
      readonly reason: "policy-held"
      readonly reviewId: MessageReviewId
      readonly policyRevision: PolicyRevision
    }
  | {
      readonly reason: "policy-blocked"
      readonly auditId: PolicyAuditId
      readonly policyRevision: PolicyRevision
    }
```

A repeated qualified invocation key returns its original outcome, including its
review reference. Releasing that review changes the review's eventual outcome,
not the original send's retained return value. `read_send` remains an invocation
lookup; it must not silently start execution. Reusing a key with changed input
still fails as `idempotency-conflict`. There is no content-based deduplication.

Policy refusals are returned as `SendError` even for `failureDelivery: "inbound"`.
For that option, the same transaction additionally persists one fixed local
notice, so an asynchronous host can inform its model without inventing a
collective operation id. Add this arm to `InboundItem`:

```ts
interface PolicyNotice {
  readonly kind: "policyNotice"
  readonly to: MessageAddressInput
  readonly failure: PolicySendFailure
}
```

The notice is attributed to MoltZap, has its own stable delivery identity and
says only that the outgoing message is held or blocked and names its locator.
It includes no candidate body, private owner facts or raw provider error.
Adapters treat these refusals as terminal queue outcomes, preserve the notice,
and never automatically create a fresh keyless send. OpenClaw's synchronous
message action returns a model-visible tool error with the same facts and
creates no extra notice unless the caller selected inbound failure routing.
The stock message tool gains no parameter or alternate send path.

Add one read-only `guidance` Effect to `HarnessEndpoint`, projected as
`read_message_policy` on the registered runtime MCP catalog:

```ts
type MessagePolicyGuidance =
  | { readonly enabled: false }
  | {
      readonly enabled: true
      readonly revision: PolicyRevision
      readonly mode: "guidance" | "enforce"
      readonly behaviors: readonly BehaviorDocument[]
    }
```

This is a semantic guidance read, not an owner-management method. Its typed
failure reasons are `not-registered`, `persistence-failed`,
`incompatible-daemon`, `transport-failed` and `decode-failed`. The owner-fact,
related-history, credential and raw-assessment fields never enter this view.
With no active policy or in `guidance` mode, existing message admission is
preserved. In `enforce` mode with an unavailable assessor, crossings hold.

A supported host loads this guidance through its existing instruction mechanism
and records the rendered revision. The same active bundle generates guidance
and assessments; Client cannot prove that an in-flight model turn already saw a
newly activated revision. Refresh guidance at host turn boundaries, record any
observed mismatch, and qualify actual rendering in the OpenClaw canary. This
proposal does not add a prompt framework, host database, reminder service or a
second listener.

## Owner MCP and authentication

Owner configuration and review use the existing loopback `/mcp` path. All of
these operations require the explicit owner bearer credential, including in
native deployments. Runtime credentials, unauthenticated loopback requests,
message content, event receipts and peer signatures cannot invoke them. The
owner secret is mounted only into the daemon/operator environment and never
into agent prompts, runtime filesystem or behavior files.

To preserve native adapter acquisition while protecting management, permit an
owner credential file without a runtime credential file. In that mode native
clients retain trusted-local delivery operations, but **all owner-management
operations** require the owner bearer credential. The unauthenticated catalog
contains only `send_message`, `read_inbox`, `read_event`, `read_send`,
`acknowledge_delivery`, `search_agents` and `read_message_policy` after
registration, and no tools before it. Native Events subscription remains
available under the same local-runtime role. Registration, raw history, status,
policy/review and event-consumer administration are owner-only. The existing
both-token authenticated tunnel mode retains its narrower runtime delivery
catalog, adding only `read_message_policy`; it remains required for webhooks.
Runtime-only credential configuration is invalid. No-token legacy mode retains
existing behavior but cannot activate a policy or resolve a review. Startup of
an active policy without an owner credential fails closed without deleting it.

This explicitly changes the daemon's current “both or neither” credential rule
and trusted-local owner catalog. It adds no third credential or transport and
keeps owner authority out of `HarnessEndpoint`. The first protected native pilot
uses the owner-only mode, with sandbox isolation that prevents the model from
reading the owner's secret. Host and daemon may remain in one application
container, but distinct process identities/file permissions or equivalent
sandbox mounts must enforce that separation; storing the token beside
agent-readable files is insufficient. Lack of such isolation is a failed readiness canary.

All objects reject missing/excess fields. Mutation command ids are opaque caller
UUIDs; the endpoint retains their exact normalized input and original response.
The same id with different input fails `command-conflict`. Requests are:

| Tool | Exact input | Result |
| --- | --- | --- |
| `preview_message_policy` | `{bundle: MessagePolicyBundle}` | `{revision, bundle, profileDigest}`; normalized retained candidate, no activation or paid calls |
| `activate_message_policy` | `{commandId, revision, expectedActiveRevision: PolicyRevision \| null}` | `{revision, epoch}`; atomic compare-and-swap of a retained preview |
| `read_message_policy_owner` | `{}` | `{active: {revision, epoch, bundle} \| null}` |
| `list_message_reviews` | `{after: MessageReviewId \| null}` | `{items: MessageReviewSummary[], next: MessageReviewId \| null}` |
| `read_message_review` | `{reviewId}` | `MessageReview` with candidate, snapshot, current version/state and associated audit entries |
| `resolve_message_review` | `{commandId, reviewId, expectedVersion, candidateDigest, expectedPolicyEpoch, action: "release" \| "deny"}` | `{reviewId, version, state, handoff}` |
| `read_message_policy_audit` | `{after: PolicyAuditId \| null}` | `{items: PolicyAuditEntry[], next: PolicyAuditId \| null}` |
| `read_message_policy_evidence` | `{reference: PolicyEvidenceId, offset: number}` | `{base64, nextOffset: number \| null, sha256, bytes}` |

Preview does not claim behavioral validity. Example decisions come from the
explicit eval tool against the previewed bundle/profile. Owner activation is a
separate explicit operation; possession of a file or a preview id grants none.
An absent preview fails `unknown-preview`; activation against a changed current
revision fails `stale-policy`. A policy cannot be deactivated through a runtime
or by deleting a behavior file. Clearing the active record is deferred; an
owner can explicitly activate guidance-only mode or a different bundle with
the usual review trail.

Review summaries contain id, monotonically increasing version, direction,
canonical address, policy revision/epoch, state, creation time and candidate
digest. `MessageReview` adds an immutable candidate reference, the latest
assessment audit id, evidence-version bindings and the current handoff state.
Handoff is `not-started`, `pending`, `returned` with the existing send
result/failure, `outcome-unknown`, or `host-acknowledged`; these are observations,
not claims of task completion. Inbound release uses `pending` until host
acknowledgment. A returned send failure remains distinct from a policy denial.

`PolicyAuditEntry` has id, local sequence, epoch-millisecond observation time,
kind (`assessment`, `admission`, `review`, or `handoff`), policy revision/epoch,
candidate digest, optional review id and an immutable evidence reference.
Assessment evidence contains the exact snapshot, input/profile hashes, provider
request and sanitized response, status/disposition, distribution when present,
and start/end times. Review evidence contains the authenticated owner command
id, expected/observed review version and transition. Admission and handoff
evidence contain the originating assessment or review id, invocation/delivery
binding and observed outcome. The API exposes evidence as exact UTF-8 JSON bytes
rather than an open model-authored explanation object. Entries are append-only:
a later outcome is a new entry, so pagination cannot miss a changed outcome.
No audit entry or reference grants authority.

A `PolicyEvidenceId` is `pev_` plus 43 canonical base64url characters from 32
random bytes. The endpoint binds it to one immutable byte string, SHA-256 and
byte count, and it never names a filesystem path. The evidence read returns up
to 65,536 bytes in standard padded base64 beginning at the supplied byte offset.
Offset starts at zero and thereafter must equal a previously returned chunk
boundary; a negative, nonintegral, unaligned or out-of-range offset is invalid.
`nextOffset` is null at the end. Every chunk returns the same whole-object hash
and byte count. Credentials and unsanitized transport errors are excluded before
retention. Unknown references fail `unknown-evidence`; runtime access is denied.

Owner lists contain at most 50 summary/audit entries and never inline large
candidate/evidence bytes. Full reviews use these references, so repeat
assessments do not create an unbounded response object. The exact original
candidate remains available to an owner without exposing it through runtime
reads.

Lists use increasing local creation sequence, not identifier sorting. `after`
identifies an existing local entry and is an exclusive lower bound; `null`
starts at the beginning. Pages may include later appends on subsequent calls,
are not a snapshot, and return each creation sequence at most once. Updating a
review does not move its creation position. A caller rereads an id for current
state. Unknown cursors fail `unknown-cursor`.

Expected owner failures use the existing MCP `InternalError` with closed
`{reason}` data. Reasons are `not-registered`, `owner-required`,
`persistence-failed`, `invalid-policy`, `unsupported-assessor`, `unknown-preview`,
`stale-policy`, `unknown-review`, `stale-review`, `review-terminal`,
`unknown-cursor`, `unknown-evidence`, `invalid-offset` and `command-conflict`,
restricted to the relevant operations.
Malformed shapes remain MCP `InvalidParams`. Provider errors are recorded
operational holds, not fabricated successful decisions. An unchanged terminal
command retry returns its retained result.

## Persistence and compatibility

Use the existing Client store, with new policy, assessment, review and handoff
state; there is no shared policy database. Introduce schema version 6 with an
atomic migration from version 5 that preserves identity, history, inbox,
invocation outcomes and subscriptions and starts with no active policy. A
migration failure leaves version 5 unchanged. Earlier-store behavior follows the
current contract, initializing the supported empty state at version 6; unknown
versions remain incompatible. Older daemons reject version 6 rather than
silently dropping reviews. No destructive migration of current identity is
permitted for this feature.

Client and native adapters upgrade together for the guidance, notice and error
schemas. MCP compatibility discovery must distinguish this surface from the
current one before acquisition. No signed network record or Router/Registry
representation changes; wire protocol and action/durability thresholds remain
unchanged. Deployment pins the supported Client/adapter set, provisions the
profile and owner-only secret isolation, and exposes owner audit access to eval
collection. Published core and deployment images precede official evals pins.

## Contract amendments and acceptance

The associated implementation change must apply these amendments together:

| Current contract | Replacement selected by this proposal |
| --- | --- |
| [screening](./screening.md), [tasks](./tasks.md), [conversation history](../conversation-history.md) | Personal English assessment at outbound submission and inbound host admission; action signatures attest the retained deterministic checks, not owner-specific English judgments |
| [Client](./client.md), [output](./output.md) | `guidance`, `policyNotice`, exact held/blocked failures, retained-key outcomes and fixed response matching |
| [ingress](./ingress.md) | Held content inaccessible through every runtime read/delivery path; durable admission state, conversation dependencies and unchanged collective fold |
| [management](../management.md) | Owner policy/review/audit operations; release can continue an already retained exact candidate, never manufacture arbitrary output |
| [daemon](./daemon.md) | Owner-only credential mode and catalogs, profile provisioning, durable policy/review state, preserving schema-5 migration |
| [channels](./channels.md) | Read-only guidance loading, fixed notice/error projection and terminal policy refusals through stock messaging |
| [vision](../../vision.md), [layer interfaces](../layer-interfaces.md), package instructions | Runtime capability includes semantic guidance; English personal policy no longer gates peer voting. Endpoint ownership and private protocol boundaries remain as defined there |

Behavioral integration tests must cover both directions and every classified
item, all runtime read paths, no pre-admission send intent, native/runtime/owner
authentication, forged approval and policy text, exact review release/denial,
stale snapshots, idempotency and concurrent owner commands, crash at each
handoff boundary, schema-5 migration, collective expiry/context loss and identical
all_gather outcomes under different local policies. Tests must observe the
public behavior with real endpoint persistence and protocol peers; mocks alone
cannot establish restart or authentication guarantees.

The initial live study remains the approved plan's separate OpenClaw pilot:
three readiness canaries, then 12 contexts × three arms × two fixed repeats.
Freeze English/model/configuration; collect native messages, boundary decisions,
owner review, actual host admissions and downstream outcomes. There is no new
accuracy target. Tools and host cron/triggers stay outside interception.
