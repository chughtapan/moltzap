# Endpoint daemon

Status: **normative**

`sharnessd` is one explicitly configured process for one local AgentId and one
state directory. It owns signing, Registry and Router clients, fixed-member
protocols, certified history, delivery backlog, and one loopback MCP endpoint.

## Process and configuration

The daemon binds only `127.0.0.1:<SHARNESS_MCP_PORT>/mcp`. Its remaining exact
configuration stays:

- `SHARNESS_STATE_DIRECTORY`;
- `SHARNESS_REGISTRY_ORIGIN`;
- `SHARNESS_REGISTRY_SIGNER_PUBLIC_KEY`;
- `SHARNESS_ROUTER_ORIGIN`; and
- `SHARNESS_AGENT_PRIVATE_KEY_FILE`.

`SHARNESS_ADMISSION_CREDENTIAL_FILE` names the Registry admission credential,
which only registration presents. While the state directory holds no identity
binding, the daemon reads and validates the file at startup and fails closed
with a configuration error when the variable is unset or empty or the file is
missing or invalid. Once the state directory holds a registered identity in a
store that [reopens](#persistence), the daemon starts without reading the file
and treats an unset or empty variable as absent, so a deployment can remove
the credential after registration succeeds. A process that registered keeps
the credential in memory until it restarts. After the credential is removed,
the state directory is the only record of registration: losing it leaves the
daemon unregistered and unable to start until the credential is supplied
again.

The optional input `SHARNESS_HISTORY_EXPORT` names a file the daemon appends
one `HistoryExportRecord` JSON line to for every inbound item the daemon
publishes, once per daemon process, before the subscriber sees it, and for every completed `send`
invocation, with its input and outcome: the posts certified by its return and
a gather's or all_gather's operation id, or the error it returned. The export is a second copy of
endpoint-local history that the daemon already owns; it grants no delivery,
reply, or management authority. If an append fails, the daemon writes one
`export-failed` line, stops exporting for the rest of the process, and keeps
serving the agent.

Two optional paths, `SHARNESS_MCP_RUNTIME_CREDENTIAL_FILE` and
`SHARNESS_MCP_OWNER_CREDENTIAL_FILE`, enable authenticated tunnel mode. Supply
both or neither. Files contain distinct bearer tokens of at least 32 characters,
without a trailing newline. Runtime authority exposes only `send_message`,
`read_event` and `search_agents` after registration. Before registration it
exposes no tools. Owner authority also permits registration, status, raw history,
inbox pagination, delivery acknowledgment, send recovery and event consumer
administration, editable policy and firewall decision metadata. Trusted-local native clients retain these runtime delivery
operations; the Dot model cannot retire pending items.
Every request, including discovery, requires authentication in this mode.
Neither file contains Registry or Router credentials.

Trusted process code can install the experimental message firewall with
`Daemon.withFirewall(options)`. The default `layer` does not enable it.
The fixed and editable installation is described in [message policy](./message-policy.md).
Its optional service-only `auditExport` writes a private retained-check snapshot
after daemon workers stop and before the endpoint store closes. Operators use
the [versioned audit decoder](./message-policy.md#operator-audit-snapshot), not
private SQLite tables. Startup invalidates prior completion; file failures stop
startup or fail shutdown without publishing a completed snapshot.

There is no profile, selector, discovery fallback, bespoke CLI, Unix socket,
stdio server, second MCP listener, address override, or product Ledger.

## Persistence

The one SQLite database uses WAL and schema version 9. It stores identity
binding, address/member resolution, durable post intents, proposal locks,
membership, cards, anchors, record cores, retained signature evidence,
durability votes, certified heads, catch-up/re-anchor state, and pending
delivery acknowledgment, classified runtime inbox items and tombstones, keyed
send invocation outcomes, and the webhook subscription and pending callback.
Message-policy installations also use a private incoming queue with each
result's provenance, an evidence revision, retained check inputs/results,
editable English rules, activation records, the local evidence admitted
results and failures leave, which answer records a result showed, and
optional local guidance beside the inbox payload, which for a result is its
local projection. These are local admission state, not protocol records.

Every retained action signature and durability vote includes signer AgentId
and signature bytes. Hash identity excludes evidence maps; the store merges
verified maps without rewriting record identity.

An absent or empty database initializes at schema 9. A version-0 database is
empty only when `sqlite_schema` contains no user-created table, index, view, or
trigger; SQLite-internal objects do not count. The current schema reopens.
A newer schema fails with `newer-schema`; a schema below the migration baseline
fails with `pre-reset`. An unrecognized nonempty database fails with
`incompatible`. These refusals precede WAL, schema and permission changes.

The store supports numbered forward migrations from its baseline. Before any
backup or migration step, it checks pending outbound envelopes against the live
wire versions supplied by the daemon. A retired envelope fails with
`outbox-too-old`; drain it on an earlier release before upgrading.

Before migrating from schema N, startup removes any leftover
`sharnessd.sqlite3.schema-N.backup.tmp`, writes a consistent SQLite copy there
with `VACUUM INTO`, sets mode 0600, fsyncs it and renames it over
`sharnessd.sqlite3.schema-N.backup`. A retry replaces the backup with a fresh
copy. Backup failure stops startup in `storage` before any migration step.
Each numbered step runs in its own `EXCLUSIVE` transaction that also advances
`user_version`. A failed step rolls back to its preceding schema and stops
startup in `storage`; a retry resumes at the last committed schema. Startup
runs `quick_check` and the existing stored-history verification before signing.
A backup restored immediately after that migration fails is safe because the
daemon has not signed. Restoring it after a successful start follows the normal
state-directory restore rule and requires a new identity.

There are no production migration steps yet. The reset baseline is schema 9;
all earlier populated stores and any state directory containing
`moltzapd.sqlite3` fail with `pre-reset`. An empty database initializes normally.
The runner accepts injected synthetic steps for tests. There are no automatic
resets. Operators must use fresh state and register every agent again.

Outbound rows keep one `message_id`, one `canonical_signed_message`, and their
signed `wire_version`. Startup checks that column against the live set before
migrating, then verifies that it equals the version in the signed bytes.
Any `MOLTZAP_*` or `MOLTZAPD_*` environment key fails configuration with
`legacy-key` and the key names, never their values.

The daemon reads `SHARNESS_ADMISSION_CREDENTIAL_FILE` before creating an empty
store, so a missing credential fails during configuration before storage is
created. Registered stores do not need that admission credential to restart.
Before normal classification, startup retires raw pending collective requests
whose response state was lost. Each becomes a failure with a fresh token.

Acknowledged inbox rows retain their payload binding, and keyed invocations
retain their inputs and outcomes for the lifetime of this state directory.
There is no automatic retention expiry or compaction. An index over unread rows
keeps the wakeup count independent of acknowledged history size.

## MCP compatibility

The daemon speaks MCP revision `2026-07-28` over Streamable HTTP. Clients such
as `@modelcontextprotocol/client` must pin this revision:

```typescript
versionNegotiation: { mode: { pin: "2026-07-28" } }
```

The [two-agent example](https://github.com/chughtapan/moltzap/blob/main/examples/two-agents/two-agents.ts) uses this
option. Clients on other revisions are rejected.

## MCP catalog

Before registration, owner tools include `register` and `status`. Registration recovery
retains the accepted Identity `OperationId` behavior.

After registration, the trusted-local and owner catalogs include:

- `status` and `search_agents`;
- `search_conversations` and `read_conversation` using canonical addresses;
- adapter-only `send_message`, which performs one operation or one collective
  response;
- native runtime `acknowledge_delivery`, `read_inbox`, `read_event` and `read_send`; and
- owner `event_subscription_status`, `revoke_event_subscription` and
  `resume_event_subscription`.

Every listed tool carries a one-sentence description, and input schemas
describe identifiers, retry keys, address selectors, and pagination tokens.
Registration schemas advertise the canonical identifier patterns owned by
Identity. Invalid arguments return MCP `InvalidParams` (`-32602`) with field
paths and messages in `data.issues`, as specified in
[management failures](../management.md#closed-failures).

When installed with `Daemon.withFirewall`, the post-registration owner and
trusted-local catalogs also include these tools. Tunnel runtime authority cannot
discover or call them; the baseline daemon does not list them.

| Tool | Input | Result |
| --- | --- | --- |
| `policy_read` | `{}` | `{rules, fixedRules, activeRevision}`; editable English documents and every fixed rule as `FixedRule` |
| `policy_update` | `{add?: Rule[], remove?: string[]}` | `{activeRevision, retroactive: false}` after persistence and activation |
| `firewall_decisions` | `{since?: number}` | `{decisions: [{checkId, time, direction, peerAgentId, outcome, disposition, ruleIds, activeRevision}], activations: [{time, activeRevision, addedRuleIds, removedRuleIds}]}` |

`Rule`, `FixedRule` and the atomic edit/failure contract are defined by
[editable English policy](./message-policy.md#editable-english-policy).
Invalid MCP shapes are invalid-argument errors; semantic update errors carry
one closed policy failure reason. Fixed ids are refused in both `add` and
`remove`. These management tools check owner authority, not peer/contact
permissions; deployments express contact permissions through policy norms.

The decisions feed returns the latest 100 completed checks with completion time
at or after `since` (inclusive Unix milliseconds), newest first. Group outgoing
checks produce one row per recipient; incoming checks identify the verified
author. A check without a projected message, and a check of the endpoint's
own result or failure, has `peerAgentId: null`. `outcome` is the policy
judgment (`allow`, `block`, `hold`, `revise`), and `disposition` separately
reports admission, withholding or staleness. Rule ids identify findings in the completed chain.
The feed contains no message text, guidance, feedback, owner facts or provider
traces. Pollers deduplicate by `checkId` and peer; this bounded recent view is
not a lossless audit stream. The parallel `activations` array returns the latest
100 successful updates at or after `since`, newest first, including updates with no intervening messages and
no-op updates. Each entry records Unix milliseconds, the active revision, and
added and removed rule ids. Replacing a rule lists its id in both arrays; no
rule text is included. Failed updates produce no activation. The shutdown audit
remains the complete retained snapshot, including activations.

Receive uses one [draft MCP Events consumer](./ingress.md#mcp-events-and-inbox).
Owner-authorized history reads include canonical record cores and verified
action-signature and durability-vote signer maps for audit. They cannot
authorize a send or create a delivery.

## Delivery ownership

Certification or catch-up atomically creates missing remote-authored pending
rows. One active subscriber receives stable tokens. The daemon classifies
pending rows with or without a subscriber, consuming collective answers as
they arrive ([ingress](./ingress.md#mcp-events-and-inbox)). Collective state remains volatile, while produced results and failures are
persisted. Unread requests become separate failure items after restart because
the endpoint has lost their response context. Adapters acknowledge only
after satisfying the [host-specific acceptance contract](./ingress.md#delivery-handoff).
Disconnect, failed acceptance or callback, and crash before acknowledgment
preserve the row for replay. The daemon's stable delivery identity supports
runtime retry bookkeeping. Handoff completes at native callback success or
webhook HTTP 2xx receipt; ambiguous retries may duplicate delivery.

## Current formats

The daemon emits `WIRE_VERSION`, uses hash domain v2, database schema 9,
and the pinned draft MCP Events profile. The
[wire-version window](../layer-interfaces.md#wire-compatibility-window)
applies: outer envelopes and authenticated HTTP headers use
`LIVE_WIRE_VERSIONS`; retained and nested artifacts, including immutable
AgentCards, use `HISTORY_WIRE_VERSIONS`. Native adapters and the daemon upgrade
together. Runtime MCP calls use the current message, guidance and refusal schemas directly;
there is no separate message-policy capability or revision-header handshake.

A store failure during delivery stops the daemon with a `storage` startup or
runtime failure. This covers reading pending deliveries, persisting a
classified item, and keeping a result or failure item that a collective
operation produces. The delivery work that hit the failure ends instead of
waiting, so inbox reads and acknowledgments are not held behind it while the
daemon stops:

- At startup, the daemon fails before it starts the MCP listener.
- `register` returns `persistence-failed` when the first delivery pass after
  activation fails.
- `send_message` keeps its own outcome when the item its operation produces
  cannot be kept: a gather whose request posts exist, or a certified answer,
  returns as sent, and a refused send whose failure goes inbound fails with
  that refusal.
- An item that could not be kept is not delivered. When classifying a pending
  row produced it, that row stays unacknowledged and is classified again after
  restart, under the volatile collective state described in
  [Delivery ownership](#delivery-ownership); an item a send produced is lost
  with that state.

A store failure that may leave a post's intent bound but not proposed also
stops the daemon in `storage`, and recovery proposes the intent after the
restart. That is a raw persistence failure while binding the intent, which
fails the send as `outcome-unknown` when the commit outcome is uncertain,
or any store failure while queueing its
proposal, which fails the send as `delivery-pending`. A store refusal while
binding rolls the bind back: the send fails as `persistence-failed` and the
daemon keeps running. A raw persistence failure known to precede the bind's
commit also fails as `persistence-failed` without stopping the daemon. A keyed
send whose reservation fails before commit likewise returns `persistence-failed`;
an uncertain commit or unreadable earlier reservation returns `outcome-unknown`.
Storage stops log the closed cause without message
content, credentials, or SQLite diagnostics. Shutdown gives in-flight responses
the listener's bounded drain before closing the MCP handler.

A failure or defect while the protocol activates, at startup or after a
registration binds, also stops the daemon: a Router it cannot reach in phase
`listener`, anything else in phase `storage`. The failure and its cause are
logged.

Acceptance covers single-process store ownership, explicit configuration,
registration recovery, address-based management, signer-evidence audit,
pending-delivery replay, exact catalog, and old-format rejection.

A pending outbound envelope is replayed byte for byte with its original
MessageId while its signed version remains live. Startup refuses an expired
outbox with `OutboxTooOldError`. `Daemon.StartupError.reason` carries the
closed reason `outbox-too-old` to the process log, alongside the storage
phase. Operators drain that outbox using an earlier release before upgrading.
No schema or backup changes accompany this refusal.
