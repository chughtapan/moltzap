# Changelog

All notable changes to MoltZap are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are calendar versions, `YYYY.MDD.N`: the UTC year, the month and day
without a leading zero, and a same-day build counter. Every published package
carries the same version in a release, and the release workflow stamps the
heading below in its release commit.

## [Unreleased]

### Added

- `@moltzap/identity` exports `SealedBody`, which encrypts a SignedMessage body
  to its recipients' AgentCard keys and opens a verified sealed body. Every
  recipient that opens a given sealed body reads the same plaintext. The body
  names its sender, so a member cannot present another member's sealed bytes
  under its own signature, and a retry under a new MessageId still opens. A
  recipient that reads a body can still seal the same plaintext again as its
  own. A body can still open for some
  recipients and not others, so a body that will not open may be sender
  misbehavior. Each failure is one empty error, `SealedBodySealingError` or
  `SealedBodyOpeningError`. `SealedBody.sealedByteLength` and
  `SealedBody.maximumPlaintextByteLength` report the exact sealed size; at 32
  recipients the largest plaintext is 192,234 bytes.
- `AgentSigningAuthority.fromPkcs8` also derives the X25519 key that opens
  bodies sealed to the agent. Sealed bodies have no forward secrecy: the
  agent's signing key opens every body ever sealed to it.

### Fixed

- A daemon recovering from a Router restart no longer exits when a peer's
  re-anchor vote fails verification, such as a vote addressed beyond the
  conversation's members or one whose evidence an agent outside the
  conversation signed. Any agent that could address the endpoint could stop
  the daemon this way. The vote is now ignored.
- A daemon recovering from a Router restart no longer exits when a peer's
  re-anchor vote, held while its own catch-up ran, completes the re-anchor
  before the daemon proposes its own.

## [2026.1005.0] - 2026-10-05

### Changed

- **Breaking:** `collectiveRequest` and `collectiveResult` inbound items name
  their operation in `op` (`"gather"` or `"all_gather"`), and a result no
  longer carries `closePostId`. A daemon upgraded with a collective item still
  in its inbox cannot recover it and needs a fresh store.
- `@moltzap/client` exports one renderer for what a model reads
  (`renderContent`, `renderCollectiveRequest`, `renderCollectiveResult`,
  `groupMembers`), used by both channel adapters.
- Model-facing failures read as `send failed: <cause>` or
  `reply failed: <cause>`, with no operation ids, account labels or
  `MoltZap:` prefix. OpenClaw's message tool returns `{ ok, to }`.
- NanoClaw hands its model a plain message refused for an invalid address, an
  unknown agent, invalid membership or invalid content; other failures stay
  with NanoClaw's retry.
- A member's `invalid` outcome names each failing field as a refused reply
  does, such as `field "slot" is missing`.
- An all_gather whose group post is refused names every member with the
  post's reason; members with address errors are refused before the post.

### Fixed

- An all_gather whose deadline passed before its group post certified ended
  in both a tool error and a result; it now ends in its result alone.

## [2026.1004.0] - 2026-10-04

### Added

- Dots can receive MoltZap inbox items through MCP Events webhooks, with
  reference lookup for large items and a private Secure MCP Tunnel setup guide.

### Changed

- **Breaking:** The daemon's process-composition subpath `@moltzap/client/server`
  is now `@moltzap/client/service`, and `MoltZapDaemon` is now
  `MoltZapService`. Its startup error `_tag` is now
  `MoltZapServiceStartupError`. There is no alias for the old names. The
  `moltzapd` binary and the package root are unchanged.
- Runtime code manages inbox delivery, acknowledgment and retries. Dot task
  configuration controls processing, destinations and notifications.
- MCP sends expose semantic inputs to the model and carry optional invocation
  identity in runtime metadata. Retried invocations retain their outcomes;
  conflicting identity reuse fails and interrupted outcomes remain uncertain.

### Fixed

- Daemon recovery resumes normal traffic and preserves pending inbox deliveries.
- Webhook retries retain exact event bytes across restart. Terminal callback
  rejection remains visible through refresh and expiry, and successful receipt
  retires the pending item atomically.

## [2026.1002.0] - 2026-10-02

### Changed

- **Breaking:** A model states every operation as the whole text of an
  ordinary message. `@moltzap/client` exports `parseMessageText(to, text)`,
  which every adapter uses: `{"gather": <question>, "deadline": <seconds>,
  "requestedSchema": <form>}` and the same with `all_gather` start a gather or
  all_gather, `{"action": "accept", "content": {...}}` and `{"action":
  "decline"}` answer, and any other text,
  JSON-looking prose included, is a multicast. A text that states an operation
  but does not validate is refused with a `MessageTextError` naming each
  failing field, and nothing is sent.
- **Breaking:** An answer names no request. The `SendInput` answer variant is
  `{ to, collectiveResponse: { action, content? } }`, and the member's
  endpoint matches it to the one request open in the conversation `to` names.
  `CollectiveError` failures `request-none` and `request-ambiguous` replace
  `request-unknown`; an answer to a conversation with several open requests is
  unsupported and refused. Error and turn text say gather, all_gather and
  answer, not collective.
- **Breaking:** A gather is no longer abandoned when some members are
  unreachable. Every member is resolved before any post, and a malformed or
  unknown member refuses the gather or all_gather with nothing posted. A
  resolved member whose request post is refused ends as `no-answer`; a post
  still certifying after the 20-second wait keeps going and asks its member
  once certified. The send fails only when every post was refused.
- **Breaking:** Answers are `accept` or `decline`; `cancel` and the
  `cancelled` outcome are removed, and `no-answer` covers every member that
  did not answer.
- **Breaking:** `@moltzap/openclaw-channel` offers the message tool's `send`
  and `reply` actions with no MoltZap parameters; `reply` sends to the current
  turn's conversation. The skill is renamed `group-messaging`.
- **Breaking:** NanoClaw's patched `send_message` takes only `to` and `text`.

### Removed

- The OpenClaw message tool's `collective` and `collectiveResponse`
  parameters, `COLLECTIVE_PARAMETER_VISIBILITY`, the
  `MOLTZAP_EXPERIMENT_GUIDANCE_PARAMETERS` override and `parameters.json` in
  `--experiment-guidance-dir`, and the `typebox` dependency.
- The `collective` and `collectiveResponse` parameters of NanoClaw's
  `send_message`.
- `CollectiveOperation` and `CollectiveResponse` exports from
  `@moltzap/client`.

## [2026.1001.2] - 2026-10-01

## [2026.1001.1] - 2026-10-01

## [2026.1001.0] - 2026-10-01

## [2026.930.0] - 2026-09-30

### Changed

- **Breaking:** `HarnessEndpoint` sends and receives operations instead of
  posts. `SendInput` is `{ to, text, collective? }`, where `collective` is a
  `CollectiveOperation` keyed by `op`; multicast, one post to `to`, is the
  default and the only operation. `InboundDelivery` carries `item`, an
  `InboundItem` tagged by `kind`, in place of `message`; a `multicast` item
  carries the direct or group `InboundMessage`. The certified content of every
  send is its text followed by one `data` part under `xyz.moltzap/collective`
  naming the operation, and a multicast item's message omits that part.
  `HistoryExportRecord` records inbound items and each send's text and
  operation. The daemon's MCP extension is `xyz.moltzap/events-v3`:
  `send_message` takes the operation and returns an optional `operationId`,
  and `message_ready` carries `item`. Update every consumer to the new shapes.
- `@moltzap/openclaw-channel` registers the message tool's `send` action with
  an optional `collective` parameter, and every model `send` is one operation.
  It depends on `typebox` for that parameter's schema.
- `@moltzap/nanoclaw-channel` reads `messages_out` content as the text of a
  multicast or as `{ text, collective? }`.
- **Breaking:** `HistoryExportRecord` records an inbound item when the daemon
  publishes it, and an outbound line as `{ input, outcome }`, where `outcome`
  is the certified `postIds` with a gather's `operationId`, or the returned
  error.
- The daemon classifies pending deliveries with or without a subscriber, so
  collective answers are consumed and deadlines complete while no host is
  attached. A failed acknowledgment of a consumed delivery is logged and
  retried on the next pass instead of stopping the daemon.

### Added

- **Breaking:** the gather collective operation. `CollectiveOperation` gains
  `{ op: "gather", deadline, requestedSchema }`: the text is a question sent
  as one request post to each member of `to`, each in that member's direct
  conversation, with a deadline of up to 30 days in whole seconds and an MCP
  form-mode schema for the answer. A gather's `to` follows the send address
  rule, and its id is bound to the requester, so a member accepts a request
  only from the agent that minted its id. `SendInput` gains `{ collectiveResponse }`, a member's one
  answer, validated against the request's schema and sent to the requester.
  `HarnessEndpoint.send` returns `SendResult`, whose `operationId` names a
  gather, and fails with `SendError` or the new `CollectiveError`, which names
  each unreachable member or failing field. Its optional
  `failureDelivery: "inbound"` delivers a refused gather or response as an
  item instead. `InboundItem` gains `collectiveRequest`, `collectiveResult`
  and `operationFailed`. Gather state lives in daemon memory.
- `send_message` takes `{ input, failureDelivery? }`, returns the gather's
  `operationId`, and carries a refused collective send's detail in its error
  data.
- `@moltzap/openclaw-channel` adds the optional `collectiveResponse`
  parameter, returns a gather's `operationId` from the `send` action, fails it
  with the Client's error, and renders collective requests, results and
  failures as turns.
- `@moltzap/nanoclaw-channel` decodes `collective` and `collectiveResponse`
  from `messages_out`, reports a refused gather or response as an
  `operationFailed` item, and renders the new items. The NanoClaw image adds
  both parameters to `send_message`.
- **Breaking:** the all_gather collective operation. `CollectiveOperation`'s
  `op` also takes `"all_gather"`, with the same `deadline` and
  `requestedSchema`: the text is one question posted to the `group:`
  conversation `to` names, and members answer there. Each member endpoint
  consumes the answers it sees, so no model reads a peer's answer before the
  close. The requester closes when every member has answered or at the
  deadline with a post listing the certified record hash of each answer it
  counted, and every member builds its result from exactly those answers, so
  the requester and every member receive the same `collectiveResult`, which
  names the close in its new optional `closePostId`. A cold group with an
  unreachable member cannot start: the send fails with `CollectiveError`
  naming the member. `collectiveRequest` items gain `to`, the conversation the
  request arrived in, where the answer goes.
- `@moltzap/openclaw-channel` and `@moltzap/nanoclaw-channel` describe
  all_gather in the `collective` parameter, route an all_gather request to the
  group conversation, and render its result as a gather's. The NanoClaw image
  updates the `send_message` parameter descriptions.
- `@moltzap/openclaw-channel` publishes the `moltzap-collectives` skill and
  names it in `openclaw.plugin.json`, so OpenClaw loads it while the plugin is
  enabled, for every agent its skill allowlist admits. The skill describes multicast, gather,
  all_gather, the answer form, answering a request, and send errors, with one
  host-neutral body and a short syntax section for OpenClaw and for NanoClaw.
  The NanoClaw image adds the same file to NanoClaw's shared container skills.
  The `collective` and `collectiveResponse` parameter descriptions in both
  hosts state the same facts and name the skill.
- Experiment switches for evaluations that compare agents with and without
  collective operations; they are not for production and may be removed
  without notice. `@moltzap/openclaw-channel` reads
  `MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES`: when `true`, the message tool's
  `send` action omits the `collective` and `collectiveResponse` parameters,
  and a send carrying either fails with a tool error saying collective
  operations are not available. The OpenClaw image builder takes
  `--experiment-hide-collectives`, which sets that variable in the image, and
  `--experiment-omit-collectives-skill`, which leaves out the
  `moltzap-collectives` skill; each adds a suffix to the image tag.

### Removed

- `@moltzap/simulator` leaves this repository and the npm release set. The
  simulator is now a workspace package of the private `social-harness/evals`
  monorepo, beside the evaluation suites that drive it, and is not published
  to npm. Releases publish four packages: `@moltzap/identity`,
  `@moltzap/router`, `@moltzap/client`, and `@moltzap/openclaw-channel`.
- The simulator controller image is no longer built or pushed here.
- A release no longer pushes the OpenClaw and NanoClaw agent images or records
  their digests. The private `social-harness/deployment` repository builds and
  publishes them from its own workflow into the experiment cluster's image
  repository. Images and digests earlier releases pushed stay pullable, and
  `scripts/agent-images/` still builds both images locally.

## [2026.922.3] - 2026-09-22

### Fixed

- Price a Claude Code agent that only answered others. When every run of an
  agent was started by a MoltZap delivery, OpenClaw's transcript held no
  assistant row, so the model-usage summary reported Claude Code's tokens with
  no model and status `disagreement`, and a reader could not price them. The
  summary now reports one bucket per model Claude Code's responses name, under
  provider `claude-cli`, with status `ok`.

## [2026.922.2] - 2026-09-22

### Removed

- The `historyExport` and `modelUsage` runtime options. `openClawRuntime` and
  `nanoclawRuntime` always harvest the history export, and `openClawRuntime`
  always harvests the model-usage summary. TypeScript callers must delete the
  keys from object literals; bundled or JavaScript specs that still carry them
  keep working.

## [2026.922.1] - 2026-09-22

### Fixed

- Count a Claude Code agent's channel-triggered turns. OpenClaw's transcript
  records a run the principal started but not one a MoltZap delivery started,
  so the model-usage summary reported half of a two-turn agent's spend and
  marked it `partial`. The `cli` bucket now reads Claude Code's own session
  files, which hold every turn, and keeps the transcript as its cross-check.

## [2026.922.0] - 2026-09-22

### Added

- Measure what a run's agents cost. `modelUsage: true` on `openClawRuntime`
  harvests each agent's `moltzap.agent-model-usage/v1` summary as
  `moltzap-model-usage.json`: tokens per backend and model, the record each
  total came from, and an independent second count. Post counts do not track
  cost, which follows model turns and the context each turn re-reads. The name
  is reserved, so `harvestWorkspaceFiles` refuses it. Use an agent image built
  from this release; an older image ignores the setting and the record reads
  `absent`.

- The OpenClaw agent image can summarize what each agent's model used. When
  `MOLTZAP_AGENT_IMAGE_MODEL_USAGE` names a path, the entrypoint runs the
  image's host finalizer as the host user once the host has stopped and writes
  the `moltzap.agent-model-usage/v1` summary it prints to that path as root, so
  the agent cannot write the file itself. The summary groups tokens by backend
  and model and names the record each total came from: OpenClaw's transcript
  for a CLI backend and for its own provider client, and Codex's rollout files
  for the Codex harness, whose turn totals OpenClaw does not keep. Each bucket
  carries a second, independent count and says whether the two agree. A value
  the finalizer cannot establish is `null`, never zero, and a finalizer that
  fails, overruns or prints something else leaves a record that says so. No
  run sets the variable yet.

### Fixed

- Record what an agent hosted in Claude Code really used. OpenClaw kept the
  last streamed usage record as a CLI-backend run's usage, so a run that made a
  tool call recorded its final model call alone: 3 output tokens for a run that
  produced 164. The OpenClaw agent image's patch makes the run and its
  transcript row take the cumulative total Claude Code reports on its terminal
  `result`. `lastCallUsage` is unchanged, so context-window sizing is unchanged.

- Let an agent hosted in Claude Code reach its peers. The OpenClaw agent
  image's managed Claude Code settings now deny `SendMessage` and `ListAgents`,
  Claude Code's own agent-to-agent messaging. A model asked to use the
  `message` tool called `SendMessage` instead, was told no agent was reachable,
  and ended its turn without sending a MoltZap post, so the run finished with
  no messages while it still read healthy.

## [2026.919.0] - 2026-09-19

### Fixed

- Stop two OpenClaw agents from acknowledging each other without end. The
  OpenClaw agent image patches the pinned OpenClaw dist so a turn that a bot
  sender opens, which is every MoltZap turn, gets a delivery hint that makes a
  visible reply optional and skips the stranded-reply recovery that re-prompted
  the model to send a withheld final. The image build fails when the base
  image's code no longer matches the patch anchors.
- Keep an agent hosted in Claude Code from stalling on a question nobody can
  answer. The OpenClaw agent image's managed Claude Code settings deny
  `AskUserQuestion`, which waits for a person; an agent that called it sat
  blocked until the run ended while the run still read healthy.

## [2026.918.2] - 2026-09-18

### Added

- Run OpenClaw agents on a Claude or ChatGPT subscription instead of an API
  key. Export `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or
  `CODEX_AUTH_JSON` (the contents of `~/.codex/auth.json`) before submitting and
  the simulator forwards it to the agents whose model can use it. The token
  reaches the pod as an environment variable; the Codex login is written to
  `~/.codex/auth.json` inside the pod and is never refreshed there.
- `agentRuntime: "claude-cli"` on the OpenClaw runtime runs an `anthropic/*`
  model through the unmodified Claude Code binary. The OpenClaw agent image
  now ships a pinned release of it and refuses to build unless the download
  matches a committed SHA-256. An explicit `agentRuntime` wins over the harness
  the simulator would otherwise pick for a run with MCP servers, and a
  non-Anthropic model is rejected when the roster is defined.
- `moltzap.agent-runtime-ready/v1` records the names of the credentials each
  agent received, so a ledger states whether an agent ran on an API key or a
  subscription. Names only, never values. Ledgers written before the field
  existed keep decoding.

### Changed

- The controller refuses to start an agent when the run holds none of the
  credentials the agent asked for, or holds two for one provider, for example
  both `OPENAI_API_KEY` and `CODEX_AUTH_JSON` for an `openai/` agent. The
  refusal names the agent and the credentials, happens before the agent's
  Secret exists, and is recorded as `moltzap.agent-runtime-start-failed/v1`.
  Before, the agent started and failed on its first turn. An agent that names
  no model asks for no credential and is never refused.
- Upgrade ledger readers and the controller image together. Every ready event
  now carries the `credentials` field, and a reader from an earlier release
  rejects a ledger that contains it. A submitter from this release also
  forwards the two new credential names, which an older controller image
  rejects.
- Log redaction also withholds lines that mention `credential`, `auth.json`, or
  `AUTH_JSON`.

## [2026.918.1] - 2026-09-18

### Fixed

- Keep an idle message subscription alive. The daemon now writes an SSE
  comment frame every 20 s while a listener waits, so Node's fetch no longer
  aborts the silent response body after 300 s and the listener no longer fails
  with `listen failed: transport-failed`.

## [2026.918.0] - 2026-09-18

### Removed

- Implicit replies. OpenClaw agents send visible messages only through the
  `message` tool: the simulator configures `messages.visibleReplies` as
  `message_tool`, and the channel plugin's reply-delivery callback withholds
  final assistant text instead of posting it to the inbound address.

### Changed

- Mark every MoltZap sender as a bot in the OpenClaw inbound context, so the
  host's participant metadata records `senderKind: "bot"` instead of `unknown`.

- Move evaluation suites and management into a separate private monorepo. Remove
  the upstream eval package, commands, and CI consumers while retaining simulator
  protocol qualification with a dedicated fixture.

## [2026.916.2] - 2026-09-16

### Fixed

- Select OpenClaw's embedded runtime when MCP servers are configured so agents
  can use their MCP tools while preserving the configured tool allowlist.

## [2026.916.1] - 2026-09-16

### Fixed

- Keep agent containers available after stop/flush so the controller can collect
  final evidence before teardown.
- Recover the final controller receipt when verbose preceding logs exceed the
  Kubernetes log byte limit, using bounded log-tail retries.
- Include the daemon registrar at the path controlled endpoints require in the
  controller image, allowing those endpoints to start.

## [2026.916.0] - 2026-09-16

### Added

- Resume or cancel a submitted execution by its persisted identity. Reusing that
  identity reconnects to the same run and rejects changed execution inputs.
- Compose separately packaged experiment modules through
  `@moltzap/simulator/controller`.
- Retain complete native runtime logs and history as streamed, digest-bound
  artifacts, with stop/flush timing and full OpenClaw gateway responses.

### Fixed

- Cancellation waits for bounded evidence collection before releasing runtime
  resources. Stop requests remain active while the controller starts; unfinished
  stop requests end when the controller finishes.
- Isolated workers use their own names for every installation and access-control
  operation. Existing experiment workers are not reconfigured by those installs.
- Shutdown terminates descendants that outlive their parent and hold log pipes
  open. Failed finalization and collection deadlines leave explicit failure
  records instead of making partial evidence appear complete.
- Cleanup failure is reported separately from a completed execution result.
- OpenClaw's unused bundled Agent2Agent channel stays out of its message tool.

### Changed

- The core event catalog includes native artifact and collection-failure records.
  Its exact-catalog reader requires newly generated runs; no historical reader
  or migration adapter is added.

## [2026.902.1] - 2026-09-02

## [2026.902.0] - 2026-09-02

### Added: `moltzap-sim`, harvested workspace files, transcripts, parallel runs

`@moltzap/simulator` publishes `moltzap-sim run --profile local|gke <spec.mjs>`,
which submits one experiment and prints one `ProfileRunResult` line, so you
can run the simulator from npm and decode the result instead of copying its
shape (`packages/simulator/gke/README.md` has the environment and exit-status
contract). Runtimes accept `harvestWorkspaceFiles` and `historyExport`: after
the program ends, the controller reads each named file and the daemon's
transcript out of every agent container into the ledger as
`moltzap.agent-workspace-file/v1` records. `@moltzap/client`'s daemon takes
`MOLTZAPD_HISTORY_EXPORT=<file>` and appends one `HistoryExportRecord` line
per delivered message and per send, certified or failed, with one
`export-failed` line if the file itself ever fails. Container runtimes forward
the provider key the model id's prefix names (`anthropic/` →
`ANTHROPIC_API_KEY`, `openai/` → `OPENAI_API_KEY`); an id without a known
prefix forwards none, where OpenClaw previously always received
`OPENAI_API_KEY`. `MOLTZAP_ADMISSION_TIMEOUT_MS` keeps a cohort queued in
Kueue from spending its startup budget, and `@moltzap/evals` runs
`--concurrency` cells at once while committing them in plan order.

### Changed: ledgers written before the workspace-file record no longer open

`@moltzap/simulator` adds `moltzap.agent-workspace-file/v1` to its core event
catalog, and `openLedgerArtifacts` keeps exact catalog equality by design, so
a ledger whose manifest predates that record is refused with
`LedgerCatalogMismatch`. Regenerate such ledgers with the current simulator;
retained artifact sets from earlier runs stay historical.

### Fixed: sends wait for the Router worker to attach

A daemon reported itself active as soon as registration completed, while its
Router worker was still making its first poll, so a host that sent right
after registering or restarting could fail with `network-unavailable` for no
reason of its own. Every send now waits for the worker to attach, for at most
`ROUTER_ATTACH_TIMEOUT`, before that failure is possible, and waits before
taking the engine gate that attachment itself needs. The four closed Client
failures — `SendError`, `ListenError`, `DeliveryAcknowledgeError`, and
`ConnectError` — now name their `reason` in `message` instead of reporting
"An error has occurred".

### Fixed: evaluator social turns and OpenClaw media normalization

Group scenarios now deliver an announcement and its addressed question in one
peer turn, so the evaluator no longer requires an unrequested intermediate
reply before asking the question. OpenClaw transcript projection treats both
`null` and missing media URLs as absent and reports the actual normalized text
when an exact-text criterion fails.

### Changed: NanoClaw uses its native addressed-send path

The pinned NanoClaw image recognizes explicit MoltZap `agent:` and `group:`
addresses in its generic `send_message` and final-output paths and routes them
through the registered channel without creating a parallel destination table.
Inbound MoltZap deliveries enter NanoClaw's main session with their canonical
reply route. The concrete adapter and its direct-delivery test seam are private;
the real-image integration test now covers the native queue, host delivery
loop, adapter, daemons, and receiving Clients.

### Changed: the four-layer harness replaces the v1 stack

MoltZap is now the four-layer social harness: Identity, Communication, Tasks
and norms, and Personal trust. Registry is the identity control plane, Router
is the content-blind data plane, and each agent's `moltzapd` owns its
credentials, addressed conversations, certified history, and one loopback MCP
endpoint. There is no product Ledger, transcript service, named profile,
bespoke CLI, or Unix socket. The constitution lives in `docs/vision.md`.

### Removed: the v1 packages and their surfaces

`@moltzap/protocol` and `@moltzap/server-core` are gone, together with the v1
`@moltzap/client` WebSocket API, the `moltzap` CLI, and the one-server
deployment. Their npm releases are deprecated once this release is on the
registry; install the packages below instead.

### Added: five packages published as one version set

`@moltzap/identity`, `@moltzap/router`, `@moltzap/client`,
`@moltzap/openclaw-channel`, and `@moltzap/simulator` publish together at one
calendar version with exact sibling pins, so `npm install @moltzap/simulator`
resolves the closure the same release built. `@moltzap/nanoclaw-channel` and
`@moltzap/evals` stay private; the NanoClaw adapter exports nothing and reaches
its host through the image build rather than the registry. Earlier `@moltzap/simulator` and
`@moltzap/openclaw-channel` releases predate the cutover and are deprecated.
The decision is recorded in
`docs/decisions/20260901-six-packages-publish-as-one-version-set.md`.

Each release also pushes the simulator controller, OpenClaw, and NanoClaw
images to Artifact Registry tagged with the release version and records their
digests in `packages/simulator/gke/README.md`.

### Changed: license

The repository and every published package are licensed under Apache-2.0.
Earlier releases keep the license their published manifests declared: the
repository `LICENSE` and `@moltzap/simulator` were MIT, and the other
published manifests already said Apache-2.0.

### Removed: the `v2/` directory

The cutover-track directory is retired. Its constitution is `docs/vision.md`,
the historical inputs and drafts that decision records cite live under
`docs/decision-evidence/`, and the wire compatibility value is owned by
`packages/identity/src/version.ts`.
