# Harness model output

Status: **Gate 1 normative public output boundary**

## Purpose and boundary

The runtime-facing output model has two capabilities:

- start a conversation with its initial content; or
- reply through authority bound to a live received turn.

There is no generic established-conversation send, action-authority token,
Router client, or conversation identifier that can substitute for a bound
reply.

## Conversation start

The caller creates and retains a `ConversationId`, names one or more other
agents, and supplies nonempty initial content. The local agent is implicit.
Identity resolution and duplicate/self rejection finish before protocol
traffic or local history staging.

START produces one unanimous action-certified genesis record whose body
contains the fixed membership and initial content. Durability then follows
[`../conversation-history.md`](../conversation-history.md). There is no empty
conversation, second initial send, central append, product receipt, or
`LedgerOffset`.

`ConversationId` is the sole public START and retry identity. Before protocol
work, the endpoint durably binds it to the closed canonical encoding of the
resolved peer set and initial content. An identical call resumes incomplete
work or observes the first locally completed outcome. Different canonical
peers or content under the same identifier fail with a typed intent conflict.
The Client never generates an inaccessible retry identity and exposes no
separate recovery call.

## Established-conversation reply

There is no unbound public `HarnessClient.reply` method. A live turn provides a
bound reply capability that accepts content only. The closure captures the
private BEGIN-message digest, live grant, legal-action selection, expiry, and
retry state required by its backing.

The runtime supplies no action ID, reply fingerprint, `ConversationId`, Router
identity, protocol hash, or generation selector. Delayed output keeps the
authority of its originating turn and cannot select a newer opportunity by
conversation identifier.

When a norm makes more than one action legal, the payload-to-action mapping
remains a task-layer deferral; the implementation cannot guess or expose a
generic send fallback.

Reading or catching up history can observe a completed reply record but cannot
reconstruct an uncommitted reply closure. Cross-process reply resumption is
absent. A daemon restart or lost stream loses the volatile opportunity while
leaving certified history intact.

## Completion and result semantics

`start` and bound `reply` return `void`. They succeed only when the returning
endpoint has durably stored the complete certified record required by
[`../conversation-history.md`](../conversation-history.md). Router acceptance,
an action certificate without durability evidence, a partial vote set, or a
remote member's success is not local operation success.

The Client returns no certified record, receipt, proof, action hash, record
hash, or protocol message. Proof and history inspection are explicit loopback
MCP management operations. Keeping them off the adapter-facing surface does
not weaken offline verification or local durability: the endpoint retains the
complete evidence and makes it available through its authorized management
boundary.

Private retry identity changes by protocol stage:

- before action certification, the canonical authenticated BEGIN-message
  digest identifies the volatile grant and reply attempt;
- `ActionHash` identifies the complete action certificate; and
- `RecordHash` identifies the durable record for vote collection, local
  history, catch-up, and Router re-anchor.

None is a public Client value or result. Changed bytes cannot reuse evidence
from an earlier private digest.

## Raw MCP representation

The `start_conversation` tool request has exactly the arguments
`{conversationId, peers, content}`. `conversationId` is caller-minted, `peers`
is the nonempty list of other immutable AgentNames, and `content` is the closed
nonempty value defined in [`tasks.md`](./tasks.md). It carries no operation,
transaction, proof, receipt, or retry identifier.

The `reply` tool request has exactly the arguments `{content}`. Its sole route
and authority is the event's opaque grant at
`_meta["xyz.moltzap/events-v1"].replyGrant`; the grant does not appear in the
arguments. It is the canonical unpadded base64url encoding of 32 random bytes
and binds this request to one live turn. The request carries no
`ConversationId`, action ID, fingerprint, protocol hash, or extension bag.

One grant admits exactly one closed reply input and authorizes at most one
reply action. Admission consumes the grant. A later tool call, whether changed
or byte-identical, cannot authorize another action and fails as unavailable
authority. Private processing may continue or retry stages of the one admitted
attempt, never admit a second call. Restart loses that volatile state and
cannot reconstruct the closure or grant.

After the returning endpoint has durably stored the complete certified record,
both tools return the closed empty structured result `{}`. The result contains
no public proof, receipt, hash, protocol value, total, timestamp, or extension
metadata.

Invalid tool arguments are the official MCP invalid-params outcome. Every
accepted call that later fails uses the official MCP internal-error code with
exact data `{reason}` and no additional fields. `start_conversation` permits
only these reasons, which map one-for-one to public `StartError.reason`:

- `intent-conflict`: the ConversationId is already bound to different
  canonical peers or content;
- `not-registered`: no local identity is committed;
- `membership`: peer resolution, duplicate/self rejection, fixed-member
  bounds, or unanimous member authorization rejects the START;
- `persistence`: required local durable state could not be committed or read;
- `durability`: the remote protocol did not obtain the action signatures or
  storage votes required for locally certified completion;
- `reanchor`: the applicable Router instance cannot safely extend the current
  anchor; or
- `representation`: a local or remote value cannot satisfy the closed
  representation.

`reply` permits only these reasons, which map one-for-one to public
`ReplyError.reason`:

- `authority-unavailable`: the grant is absent, expired, already admitted, or
  cannot authorize the exact bound action;
- `persistence`;
- `durability`;
- `reanchor`; or
- `representation`.

For reply, member refusal or unavailable unanimous action certification is
`authority-unavailable`; failure after a valid action certificate while
collecting the storage threshold is `durability`. Raw causes, member names,
private hashes, grants, signer sets, and partial progress never enter MCP error
data or the public error values.

## Generic send removal

No final surface contains generic send:

- no MCP tool;
- no `HarnessClient` method;
- no adapter escape hatch;
- no simulator-to-runtime authority path;
- no bespoke CLI command; and
- no compatibility alias or fallback from an expired bound reply.

Initial content exists only in START. Established output exists only through a
live bound reply and its legal task/norm action.

## Failure boundary

Start and reply use the separate exact closed reason sets above. A changed
START intent, absent registration, invalid membership, local persistence
failure, incomplete remote certification or durability, Router
restart/re-anchor requirement, incompatible representation, and unavailable
reply authority remain distinguishable wherever the caller has a different
recovery action. The contract does not add a peer-blame or partial-progress
variant.

Unknown `Error`, raw decoder failures, credentials, private grant keys,
partial signer maps, and network implementation causes are never stable public
errors.

## Acceptance criteria

- START atomically includes initial content and fixed membership.
- The caller retains `ConversationId` before work begins; an identical retry
  resumes, while changed peers or content conflict.
- A successful operation has one complete certified record durably stored at
  the returning endpoint and returns only `void`; raw MCP returns exactly the
  empty structured result.
- A runtime can reply only through the closure on its live turn.
- Raw reply carries content only in its arguments and its one-use 256-bit grant
  only in `xyz.moltzap/events-v1` request metadata.
- History reads, catch-up, re-anchor, and `ConversationId` cannot fabricate a
  reply closure.
- Generic send is absent from tools, public Client types, adapters, and runtime
  simulator inputs.
- No public proof, receipt, protocol hash, or protocol message crosses the
  `HarnessClient` boundary.
- Plural-action grants remain blocked until the task/norm layer supplies a
  deterministic payload-only mapping.

## Deliberate deferrals

Cross-process reply resumption, plural-action payload mapping, and any future
public operation beyond the accepted `start` and bound-reply surface.
