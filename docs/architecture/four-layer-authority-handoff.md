# Four-layer authority handoff

Status: **SUPERSESSION INVENTORY — NON-NORMATIVE**

This handoff identifies the authority that the approved four-layer cutover
must replace, retain, or re-own. It is not an ADR, does not change any current
status, and is not permission to implement against the proposed design.

The replacement must land atomically with its source-faithful trajectory,
decision index and lineage, `v2/VISION.md`, stable manifest rows, normative
specifications, architecture orientation, and a passing isolated blind review.

## Retention guard

Removing institutional credentials as an architectural layer does not remove
identity or operational credentials. The following remain current unless the
replacement decision says otherwise:

- immutable AgentIds and AgentCards;
- agent signing keys and normal Ed25519 verification;
- Registry bootstrap admission and proof of possession;
- Registry and Router authenticated HTTP contracts, including RFC 9421 where
  currently owned;
- layer-owned identity and Router representations;
- deep Identity and Router Effect capabilities; and
- deployment admission credentials outside the product trust model.

Gate 1 does not yet ship a privileged institution product. The proposed
replacement must supersede the architectural commitment to such a future
layer and prohibit introducing privileged institutional credential types,
services, imports, or read paths. It must not remove authentication.

## Decision lineage

### Stack, storage, and conversations

| Current record | Retain | Replace or re-own |
|---|---|---|
| `20260723-eight-layer-stack.md` | Guarantees flow upward, configuration flows downward, and lower layers do not interpret higher concepts. | Replace eight layers and two trust regions with identity, communication, tasks/norms, and personal trust. |
| `20260728-layer-boundaries-and-fault-model.md` | Registry/Router boundaries, Byzantine endpoints, endpoint interpretation, and separate safety/liveness claims. | Remove the sibling Ledger service and L5–L8/L7 fault domains. State quorum-storage assumptions directly. |
| `20260728-transcript-is-mechanical-atomic-commit.md` | A canonical record is closed, mechanically verifiable evidence. | Replace central atomic append with endpoint staging, independent action and durability certificates, quorum completion, local success, and catch-up. |
| `20260724-collectives-are-ledger-transactions.md` | One accepted action becomes one hash-linked canonical record; volatile protocol traffic is not history. | Remove central append and author-only submission. |
| `20260723-lifecycle-rides-l3.md` | START is in-band genesis with fixed membership. | Replace central conversation index, offsets, and store ownership with local certified histories. |
| `20260728-open-floor-v1.md` | Unanimous action validity and the accepted contention law. | Separate unanimous action signatures from `n-f` durability votes and remove Ledger/author-only append progress dependencies. |

The replacement must say that `n-f` is a storage threshold only. It does not
weaken OpenFloorV1 action unanimity or silently decide a future non-unanimous
action certificate.

### Router and network recovery

| Current record | Retain | Replace or re-own |
|---|---|---|
| `20260720-the-network-is-a-router.md` | Content-blind Router and endpoint interpretation. | Remove the independent-Ledger storage qualifier. |
| `20260721-physical-plane-split.md` | Registry/Router separation and loopback MCP as a local boundary. | Replace the three-network-process topology and Ledger transcript recovery. |
| `20260722-data-plane-layering.md` | Opaque L2; conversations, records, and recovery belong above it. | Move L3 durability from an independent Ledger to endpoint-local replicas. |
| `20260729-router-order-is-opaque.md` | Volatile opaque order, feed/cursor laws, and a correct non-equivocating Router assumption. | Replace Ledger reconciliation and permanent restart fencing with certified-head catch-up and a defined Router-instance epoch anchor. |
| `20260728-network-wire-is-http-post-polling.md` | Current Registry and Router POST/polling contracts. | Remove Ledger routes, versions, and reconciliation references. |

The re-anchor contract must specify head selection, quorum, signed binding,
conflicting and Byzantine votes, persistence, partial dissemination, and
recovery. “Members re-anchor” is not yet an implementable protocol.

### Daemon and runtime interface

| Current record | Retain | Replace or re-own |
|---|---|---|
| `20260801-harness-is-one-profile-slot-daemon.md` | One daemon represents at most one AgentId; Registry owns admission; one loopback listener; MCP replaces bespoke CLI. | Remove profiles, split MCP paths, dual backings, Ledger dependency, and `v2/harness`; define explicit state-directory/config ownership and one state-dependent `/mcp`. |
| `20260728-endpoint-daemon-speaks-modern-mcp.md` | Re-admit only the modern MCP framing, discovery, subscription ownership, and supervision mechanics still needed. | Retire profile/Ledger state and explicitly select the event extension, attention, completion, and recovery semantics that survive. |
| `20260801-harness-client-owns-runtime-context.md` | A runtime turn and history read remain different capabilities. | The reduced Client projects one certified action from the current conversation. Universal cross-conversation context and checkpoints do not survive. |
| `20260801-inbound-notifications-separate-content-from-grants.md` | Content/history and live reply authority are independent; one live authority per conversation. | Re-own notification, history, and recovery under the endpoint store without Ledger mechanics. |
| `20260801-model-output-is-start-or-bound-reply.md` | Start with initial content, turn-bound reply, and no generic send. | A pre-minted `ConversationId` identifies START retry. Start and bound reply return `void` after local certification, with proof available only through MCP management. |
| `20260728-model-surface-is-start-reply-listen.md` | Retain start, bound reply, and receive only where compatible. | Remove `LedgerOffset`, central receipts, and obsolete raw tool/reconciliation shapes. |

The candidate must use one term for each receive surface:

- MCP `subscriptions/listen` is the transport subscription;
- `HarnessClient.turns` is its typed runtime projection; and
- neither is a seventh MCP tool.

The accepted semantic surface uses a pre-minted `ConversationId` as START's
only public retry identity. START and bound reply return `void` after local
certification, and each turn projects one current-conversation action. Search,
history, status, registration, and proof inspection remain MCP-only. `TxnId`
is absent; BEGIN-message digests, `ActionHash`, `RecordHash`, certificates, and
recovery state stay behind the semantic Client boundary.

### Trust features become recursive protocols

| Current record | Retain | Replace or re-own |
|---|---|---|
| `20260724-monitors-are-deterministic-contracts.md` | A deterministic finding and attributed testimony may remain distinct concepts. | Remove monitor runtime/layer and privileged Ledger read. Monitoring becomes an ordinary task over disclosed certified history. |
| `20260724-firewall-two-directions.md` | Local inbound/outbound signing, attention, disclosure, and reliance decisions. | Rename the boundary to four-layer personal trust and replace institution-layer inputs with ordinary signed claims/task protocols. |

The replacement needs an explicit negative law: monitors, institutions,
credentials, and governance gain no privileged import, trust root, network
path, or private-history read. An institutional statement is ordinary signed
conversation content until a later task/norm protocol gives it additional
local meaning.

### Packages, simulator, and branch authority

| Current record | Retain | Replace or re-own |
|---|---|---|
| `20260728-six-deep-packages-one-version.md` | Deep package ownership remains useful. | Replace six `v2/*` packages, `v2/VERSION`, testbed/transcript ownership, exports, binaries, version policy, and DAG with the seven final `packages/*` products. |
| `20260728-simulator-is-the-system-driver.md` | One simulator and a distinct simulation evidence ledger. | Remove separate v2 simulator/testbed contracts and adopt the preserved latest-main simulator API. |
| `20260723-eval-plane-is-testbed.md` | Substitution, fault injection, and black-box composition remain simulation concerns. | Move ownership into `@moltzap/simulator`; delete a standalone testbed product. |
| `20260727-code-first-simulator-kernel.md` | Main `@moltzap/simulator`, closed events, and `RunLedger`. | Remove stale v2/testbed and old production-protocol handoff claims. |
| `20260801-main-simulator-runs-container-societies-on-kubernetes.md` | `Run.execute(RunSpec)`, one simulator, Kubernetes execution, and non-conflicting facades remain the preservation baseline. | Resolve the discovered open/send/message/runtime-authority and persisted Router-evidence conflicts explicitly; blanket behavior identity cannot coexist with the final communication law. |
| `20260721-v2-lives-top-level.md` | Historical pre-cutover isolation. | Supersede when accepted code moves to final `packages/*` homes and obsolete `v2/*` roots are deleted. |
| `20260729-v2-authority-lives-with-v2.md` | Repository-native authority and atomic decision changes. | Decide cutover, retirement, publishing, and branch consolidation that this record currently defers. |
| `20260728-gate-1-architecture-freeze.md` | Stable traceability, authority order, and the blind-review gate. | Partially supersede the eight-layer manifest and re-own every affected stable row. |

The product-Ledger removal checks must exempt the simulator's `RunLedger` and
`@moltzap/simulator/ledger` export.

## Stable manifest impact

The replacement manifest must explicitly replace, retain, or re-own these
existing `G1-DEC-*` rows. A range is not permission to discard row-level
lineage.

| Family | Rows requiring disposition |
|---|---|
| Authority and architecture | `002`, `100–112` |
| Identity rows with stale path/Ledger qualifiers | `209`, `223` |
| Router recovery | `309–314` |
| Central storage | `400–415` |
| OpenFloor and storage interaction | `500–519` |
| Daemon, client, model surface, and MCP | `600–642` |
| Package, simulator, and construction graph | `700–722` |
| Deferred surface | `800–824` |

Rows `401`, `404–405`, `407–410`, and `414` contain reusable record and
verification guarantees whose owner moves from Ledger to `@moltzap/client`.
Row `816` can retain that Router itself provides no restart-transparent replay
while dropping permanent fencing. Row `824` continues to defer
non-unanimous action certificates.

Rows `709`, `713`, `718`, and `720` contain retention anchors but are not
verbatim survivors: simulator schema versions remain independent of the new
product-version owner; final `@moltzap/simulator` owns the one kernel; two
simulator engines never coexist; and adapters consume `HarnessClient`.

Rows `624` and the cross-conversation portion of `819` are obsolete because
the accepted turn contains only its current conversation. Row `717` needs new
landed-source provenance for the preserved latest-main simulator. Row `804`
and row `824` must distinguish the still-deferred non-unanimous action quorum
from the newly selected non-unanimous durability quorum. Row `806` must
distinguish obsolete central append takeover from any action-author recovery
that remains deferred.

## Normative chapter work

| Owner | Required replacement work |
|---|---|
| `docs/spec/README.md` | Replace central L3 storage, profile daemon, six-package, and testbed readiness rows; index the new history/durability/re-anchor/client owners. |
| `docs/spec/layer-interfaces.md` | Rewrite the package DAG, type ownership, cross-layer laws, retry identity, storage owner, trust assumptions, testbed references, and acceptance checks. |
| `docs/spec/control-plane.md` | Retain Registry control-plane orientation and retire Ledger operations. Move endpoint history and durability to a new communication-owned chapter. |
| `docs/spec/enforcement.md` | Remove L6/L7 infrastructure. Preserve identity/institution separation, Router policy blindness, and local interpretation of ordinary signed claims. |
| `docs/spec/router.md` | Retain the Router wire and ordering contract; replace Ledger catch-up and permanent fencing with endpoint catch-up/re-anchor. |
| `docs/spec/harness/tasks.md` | Separate unanimous action validity from durability quorum; specify staging, vote dissemination, certificate assembly, author failure, catch-up, and progress. |
| `docs/spec/harness/daemon.md` | Remove profiles, split paths, Ledger state, and dual backings; specify explicit process config and one state-dependent MCP endpoint. |
| `docs/spec/management.md` | Define local-history authorization, search/read projections, stable positions, pagination, status, and registration recovery on `/mcp`. |
| `docs/spec/harness/client.md` | Define the reduced service: pre-minted `ConversationId`, current-conversation turn, void START/reply completion, MCP-only management, and closed errors. |
| `docs/spec/harness/output.md` | Define atomic START, `ConversationId` retry and changed-intent conflict, bound reply, and void local success without offsets or receipts. |
| `docs/spec/harness/ingress.md` | Retain content/authority separation if selected and assign the new notification/attention owner. |
| `docs/spec/harness/screening.md` | Rename to personal trust, remove L5/L7/Ledger structure, and retain fail-closed local signing/attention/disclosure decisions. |
| `docs/spec/harness/contacts.md` | Recast optional contacts as local trust data without profile or L7-service vocabulary. |
| `docs/spec/router-representation.md` and `identity*.md` | Retain exact L1/L2 contracts except stale layer, Ledger, and local-registration-path references. |

Current architecture orientation must change in the same candidate:

- `docs/architecture/components.md` for the two network services, endpoint
  store, exact seven-package ownership, and runtime topology;
- `docs/architecture/layers.md` for four-layer flows, proof production,
  catch-up, and removal of `LedgerOffset`; and
- `docs/architecture/first-implementation.md` for the final cutover sequence,
  simulator provenance, deleted testbed, and branch/release transition.

## Protocol gaps to close before implementation

1. **Durability meaning.** A quorum certificate cannot preserve the old claim
   that every member can read the record at acknowledgment. Define local
   success and signed attestations separately from actual storage. Under the
   selected fault bound and honest-stage-before-sign law, state the resulting
   `n - 2f` honest-replica guarantee, small-conversation Byzantine assumption,
   retention, failure tolerance, and catch-up.
2. **Byzantine wording.** “Every member stages before voting” is not a valid
   assumption about Byzantine endpoints. Require honest voters to stage and
   never double-vote; state what safety follows from quorum intersection.
3. **Completion.** Define vote dissemination, any-member assembly, full
   certificate convergence or equivalence, canonical signer-map encoding,
   author failure, duplicate/partial certificate handling, and when callers
   may succeed.
4. **Canonical position.** Assign `previousRecordHash`/`RecordHash` to ordering,
   stale-head detection, catch-up, stable history reads, presentation anchors,
   and idempotent recovery. Do not recreate a hidden Ledger offset.
5. **Router restart.** Define how members compare certified heads, select one
   anchor, reject conflicting or stale votes, persist the anchor, and recover
   after partial dissemination.
6. **Runtime context.** The final turn projects one certified action from its
   current conversation. Universal cross-conversation presentation and its
   checkpoints are superseded; runtime hosts own any wider session memory.
7. **Daemon ownership.** Define one state directory/AgentId, duplicate identity
   detection, registration versus local commit points, crash recovery, bind
   collisions, and status without recreating profiles.
8. **Recursive trust features.** State the absence of privileged imports,
   credentials, trust roots, and history paths for monitors, institutions, and
   governance.
9. **Branch cutover.** Admit the final forward merge, routine-merge freeze,
   publishing transition, v1 retirement, and branch consolidation rather than
   leaving them only in the execution plan.
10. **Hash and proof closure.** Define the canonical action-certified record,
    make `RecordHash` commit to the action certificate and verification
    context, and attach durability evidence only after that hash exists.
11. **Local store recovery.** Define an atomic staged-to-certified transition,
    restart recovery for partial votes/evidence, durable retention and disk
    loss assumptions, pruning, and garbage collection.
12. **Member catch-up.** Define authenticated peer selection, authorization,
    invalid/duplicate data handling, ancestry withholding, and the exact honest
    availability required for automatic fixed-member repair.
13. **Outage matrix.** State Registry, Router, local disk, endpoint, and quorum
    outages separately for safety, verification, catch-up, and progress.

The accepted reduced public shape and its private-boundary consequences live
in `four-layer-interface-slate.md`.
