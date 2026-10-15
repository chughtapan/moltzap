# Message policy execution

Status: **proposal under discussion; not implemented or admitted**

Client assesses application messages before outgoing intent publication and
incoming runtime admission. The proposed evaluator separates safety and autonomy
from contextual norms. Norm violations return actionable send errors; incoming
items carry local guidance about whether to respond and what to address.

The [architecture and experiment proposal](https://github.com/social-harness/docs-internal/pull/97)
compares an in-process evaluator with an isolated evaluator worker. It recommends
the in-process implementation first. Configuration interfaces, live policy
activation and authenticated human approval channels are deferred. Current
normative contracts remain the implementation baseline.

## Ownership and scope

Client owns snapshot construction, admission, retained dispositions and recovery.
A value-oriented evaluator consumes a snapshot and calls an injected decision
provider. It cannot access the host, sign or send messages, invoke agent tools,
activate policy, or approve a candidate. Adapters only project the result.

The first live slice covers direct and group multicast, matching the paper's
message primitives. An enabled enforcement gate holds an unsupported application
operation before any send intent or runtime admission; it must not silently
allow it. Complete collective-operation support is a subsequent qualification
step. Internal certification, catch-up, collective answers/folds and closes
continue through their existing protocol paths.

The threat model is adversarial peers communicating with an endpoint whose
composition is controlled by its operator. It does not claim isolation from a
compromised privileged host. Agents in the first experiment receive messaging
and fixture tools, not owner management tools.

## Proposed composition interfaces

These values belong to service composition, not the agent-facing endpoint.

| Capability | Contract |
| --- | --- |
| Policy bundle | Immutable digest and English rule documents, question edition, owner facts and visibility-qualified advice/feedback. The first composition loads files and freezes them for the run. |
| Evidence snapshot | Exact candidate and direction, verified participant attribution, authorized local history with source references and visibility, required evidence gaps, and version binding. |
| Decision provider | State and named bounded-choice questions to validated distributions, provider/model identity, usage and latency, or a typed operational failure. Names of external providers/models remain data. |
| Message evaluator | Snapshot to safety, autonomy, norms, projected guidance/feedback and a complete stage trace. Its contract does not expose a store or execution capability. |
| Authorization evidence | Verified exact-candidate evidence supplied by a trusted integration, or absent. The first live implementation supplies absent evidence; tests may supply explicitly simulated evidence. |
| Admission store | Retain the assessment and atomically compare its binding before exposing an incoming item or creating an outgoing intent. Preserve existing identity, history, pending deliveries and invocation outcomes. |

Evaluator construction is exposed through the existing service composition
subpath so offline experiments can exercise the same code. It is not a new
method on HarnessEndpoint and does not introduce a new npm package.

Native and MCP schemas, discovery and error decoding change together. A
mixed-version connection that cannot carry guidance or policy errors fails
explicitly through the compatibility boundary. The first pilot uses matching
Client and adapter versions; peer wire formats remain unchanged.

Human authentication is upstream of authorization evidence. A peer claim,
runtime-generated token or assessment reference is not approval. Future evidence
must bind owner, candidate, recipients and applicable validity/version
constraints. This proposal does not select an approval transport or release API.

## Fixed execution chains

1. Validate the candidate and capture the policy/evidence snapshot.
2. Assess applicability across every active document. The first implementation
   records relevance but does not prune active rules.
3. Assess safety: compliant, prohibited or unresolved for each safety rule.
4. Assess autonomy: autonomous, approval-required, prohibited or unresolved.
5. Assess norm expectations: required response, permitted response, wait or no
   response, with selected rule and subject references.
6. For outgoing messages, assess the candidate's conformance to those norms.
7. Validate all outputs, compose the result, project permitted feedback, and
   fence admission.

All configured stages run even after a semantic rejection, except that a
dependent stage with invalid input is explicitly unavailable. Diagnostics never
override a rejection. Missing required evidence, invalid output and provider
failure cannot produce admission. They remain distinct in the audit.

No model call runs inside a database transaction, the delivery semaphore or
Router consumption. A stale result is reassessed within a bounded refresh
budget or held. Provider timeouts and cancellation are explicit.

The initial bounded catalog and authorized history are supplied in full within
the configured budget. Required omitted context causes a hold. Retrieval
pruning, summaries, caching and dynamic chains are later experiments.

## Incoming projection

Extend the existing delivery envelope with optional local guidance while
preserving its original InboundItem. The proposed guidance contains:

- response expectation: required, permitted, wait or none;
- subject references to runtime-visible messages or operations; and
- selected runtime-visible English instructions.

The guidance is locally attributed, not part of a peer's signed content. Its
references and text must come from supplied, authorized values. Neither private
assessor evidence nor peer instructions may be elevated into local guidance.

Persist disposition and guidance before runtime exposure. Native subscriptions,
inbox pages, read-event and webhooks read the same admitted view; replay retains
the guidance and delivery identity. A held item cannot be retrieved through a
different runtime path. Owner-authorized history remains an audit capability.

For OpenClaw, the first projection uses the stock agent-facing body alongside a
separately delimited original message, preserving the raw body. This is
contextual guidance, not a claim of a new system-role capability. Qualify the
actual model-visible prompt for DMs and groups. Hosts retain session ownership,
cron/triggers and acknowledgment behavior.

A safe incoming message may arrive with guidance to remain silent. Guidance
does not force a response or establish a distributed speaking-turn protocol.
In enforcement mode, a held candidate's norm outputs are diagnostic only; they
create no runtime obligation and are not delivered instead of the message.

## Outgoing projection

Add a typed PolicySendError to the semantic send error union and carry it
through the MCP error channel. It contains an opaque assessment reference, a
reason and permitted feedback. The proposed reasons distinguish:

- prohibited message;
- unresolved required evidence;
- unavailable assessment;
- norm violation; and
- required approval absent.

Feedback gives a useful next action: revise, wait, stop or seek approval.
The error's message reaches the host tool result. It does not include raw
provider output, credentials or private evidence.

Compose decisions in this order: known safety/autonomy prohibition; required
operational/evidence hold; norm repair; missing approval; otherwise admission.
Approval satisfies an approval-required condition only and cannot override a
prohibition or an independent norm violation.

An error before admission means the candidate created no send intent. The agent
can revise and issue a new invocation, which runs the full chain. Client does
not rewrite the draft, automatically retry, wait for a human on the send call
or submit a later approval on the agent's behalf.

Existing idempotency remains: a keyed retry returns its retained outcome, and
changed input under the same key fails. A fresh attempt after revision or new
evidence is a new invocation. Once an intent is bound, existing
delivery-pending/outcome-unknown and protocol recovery semantics take over;
policy code cannot report that already pending send as an unsent refusal.

## State and protocol invariants

Capture and compare the exact candidate, recipients, policy digest and relevant
evidence versions. Comparison and new intent binding must share the admission
transaction; an asynchronous preflight check alone is insufficient.

Retain admission state separately from canonical records. Recovering a process
cannot admit a previously held item. The first implementation retains holds
for inspection and does not implement human review/resumption. Future release
must reassess and define how an older item is presented.

Preserve incoming order with a retained per-conversation admission frontier.
Assess a successor after its predecessor's disposition settles, including a
settled hold; do not wait for a human release. Other conversations and protocol
processing remain independent. Restart restores the frontier before exposing
later items. An unfinished predecessor assessment is not missing evidence.

Protocol processing continues independently of local runtime admission.
Withheld peer statements are marked as such and cannot silently establish
obligations as though the runtime received them. Later items are assessed
against explicit visibility and evidence gaps.

Semantic assessment does not run in action/durability voting. Local disagreement
must not change shared history or the answers in a canonical all_gather result.
Collective qualification must retain request identity, whole-result attribution,
deadline validity and restart loss of volatile response context.

## Required contract reconciliation

| Current contract | Required change before implementation |
| --- | --- |
| [Screening](/spec/harness/screening) and [tasks](/spec/harness/tasks) | Distinguish personal semantic admission from structural protocol signing; do not put provider calls in voting. |
| [Client](/spec/harness/client) | Extend the send error union and delivery envelope; define refusal, guidance and unsupported-operation behavior. |
| [Ingress](/spec/harness/ingress) | Define one admitted runtime view across subscriptions, lookups and webhooks, including replay and withheld items. |
| [Output](/spec/harness/output) | Place policy refusal before intent binding while preserving retries and uncertain outcomes. |
| [Channels](/spec/harness/channels) | Permit local norm-context projection and actionable send errors through stock host APIs. |
| [Daemon](/spec/harness/daemon) and storage contracts | Compose the evaluator and retain policy state with a preserving migration; do not introduce policy CRUD or human authentication as incidental requirements. |
| [Management](/spec/management) | Preserve the distinction between owner audit access and runtime delivery; this proposal adds no policy-management catalog. |

The implementation must update these contracts together and test their public
behavior. The private plan records exact integration points and bounded live
experiments. A subsequent production boundary change still follows the
repository's decision process.

## Validation and limits

Deterministic tests cover actual Client storage and message paths: no intent on
refusal, no alternate delivery bypass, stale snapshot conflicts, provider
failures, visibility-safe projections, same-key outcomes and restart recovery.
Provider fakes supply decisions; they do not replace those mechanisms.
Include a slow predecessor, a settled held predecessor and restart ordering,
plus migration of existing identity, history, deliveries and invocation data.

Real OpenClaw tests must retain a model's attempted send, actual tool error,
model-authored revision, rendered incoming guidance and actual peer delivery.
The paper-derived cohort compares the same owner instructions under baseline,
contextual guidance and enforcement. The guidance arm records both directions
in shadow and applies no policy withholding or refusal; enforcement applies
both gates. Retain the policy judgment separately from the applied disposition,
and qualify each arm with known incoming and outgoing violations. This first
comparison does not isolate the contribution of each direction.

A message gate cannot undo a prior tool action, prove an unseen calendar change,
guarantee that an agent follows a reminder, or detect hidden collusion without
evidence. Measure those outcomes separately. Approval fixtures do not qualify
human authentication. Dynamic chains, live configuration, human approval UX and
other client integrations are follow-up work.
