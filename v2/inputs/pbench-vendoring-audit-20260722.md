# moltzap-propagation-bench — Vendoring + Tech-Debt Audit — 2026-07-22

Deep-dive follow-up to `case-study-audits-20260718.md` (bench section), focused on:
what the bench vendors, what debt it carries, and which moltzap interface changes
turn it into a direct customer of published packages. Bench repo audited at
`VidushiS/moltzap-propagation-bench` main (`3712789`, essentially unchanged since
the 2026-07-18 audit — 2 experiment-data commits). Upstream compared against
moltzap main `840353fd` and published npm lines (server-core 2026.722.1, client
2026.721.2, protocol 2026.721.1, openclaw-channel 2026.718.0; `@moltzap/runtimes`
npm 404).

## 1. Vendoring inventory (five layers)

**1a. `vendor/runtimes/` — hand-copied fork of unpublished `@moltzap/runtimes`.**
9 `.ts` files, 1,993 lines, copied 2026-05-05 from a teammate's private checkout
(`/home/singh/moltzap-arena/lib/moltzap/...`) at moltzap `a2a7e97`. Three-way drift
(vendored vs copy-time vs HEAD):

| File | vs copy-time | vs HEAD | Class |
|---|---|---|---|
| errors.ts | 0 lines | 93 | identical → upstream rewrote (Data.TaggedError) |
| await-agent-ready.ts | 0 | 16 | identical |
| channel-plugin-install.ts | 0 | 378 | identical → upstream rewrote |
| index.ts | 26 | 37 | trivially diverged |
| runtime.ts | 12 | 28 | trivial: +`SpawnInput.contextAdapter`, +`Runtime.getStateDir` |
| fleet.ts | 67 | 403 | trivial: openclaw-only + contextAdapter + getStateDir |
| openclaw-adapter.ts | 437/809 | 1,094 | **heavily forked** |
| child-env.ts (102) / sandbox-launcher.ts (274) | — | — | **bench-authored**, no upstream counterpart |

The openclaw-adapter fork carries: fail-closed OS sandbox (bwrap/seatbelt),
host-secret env allowlist, `sun_path` socket-path budgeting, bench-capture plugin
install, four openclaw config knobs (gateway auth `none`, mDNS off, `tools.exec`
policy, keep-state-dir), and an `allExplicit` factory fix so it works outside a
monorepo. `vendor/runtimes/README.md`'s refresh procedure is stale and dangerous:
it lists 7 files (not 9) and "re-apply local edits" understates a 437-line fork —
a naive refresh silently deletes the entire safety layer.

Upstream `packages/runtimes` was meanwhile rewritten end-to-end: @effect/platform
I/O, branded `AgentId`/`AgentKey` (Redacted) from `@moltzap/protocol`, tagged
errors, and a **breaking auth cutover** — credentials moved out of
`openclaw.json` accounts into a `.moltzap/config.json` profile
(`serializeMoltZapProfileConfig`, `MOLTZAP_CONFIG_HOME`/`MOLTZAP_SERVER_URL`).
The vendored adapter and the pinned channel are a version-locked pair via
behavioral contracts (config shape, dist layout, stdout format, socket paths) —
zero direct imports, four behavioral locks.

**1b. `bench-server/` — a reimplemented server from deleted internals.** ~720
lines composing 17 `@moltzap/server-core@2026.329` internals (AuthService,
ConversationService, MessageService, ParticipantService, DeliveryService,
ConnectionManager, Broadcaster, EnvelopeEncryption, createDb, createRpcRouter,
defineMethod, RpcError, logger, seedInitialKek + 3 types) + 3 vendored SQL
migrations. Every one of those imports is gone from server-core 2026.722.1 — the
server barrel is literally `export {}` (bin-only since `83b73da9`, 2026-05-21);
the wire protocol is now an Effect-RPC catalog with a new namespace. Schema
drift: 17 vendored tables vs 10 canonical (`core-schema.sql`); 7 names overlap,
all 7 changed shape, and a task layer was added. bench-server also carries silent
behavioral forks experiments may depend on: `contacts/list` hardwired to `[]`,
no server-side contact gating (topology confinement is harness convention),
`to`-only sends rejected, no rate limits/heartbeats, unread counts only grow.

**1c. `patches/` — three pnpm dist patches, two upstream stories.** The two
client patches (407 and 411 — byte-identical; 411 exists only because
openclaw-channel@411 drags in its own client) rewrite `getContext` from a lossy
last-message/120-char recap to a full-transcript recap — **measurement-critical**
(cross-conversation context is the paper's experimental lever). Already fixed
upstream via `peekFullMessages` → `formatCrossConv` (`99f3e90d`, 2026-04-13,
two days after the 411 pin). The openclaw patch strips the `isControlUi` guard so
headless operator gateway calls skip device pairing under auth.mode `none` — NOT
fixed in openclaw 2026.6.33, and moltzap's own runtimes still uses the flaky
auth.mode `token`.

**1d. openclaw-channel consumed as an on-disk dist copy, not a module** — copied
into every agent's `<stateDir>/extensions/`, with a per-fleet fake-monorepo
symlink farm (`.bench-runtime-root/<pid>-<uuid8>/packages/{protocol,client}`)
because `installChannelPlugin`/`linkWorkspacePackages` hardcodes
`repoRoot/packages/{protocol,client}` — still true at upstream HEAD. Upstream
already has the right primitive (`resolveChannelDependency` uses
`createRequire().resolve()` for the effect link, fix #285) but doesn't apply it
to protocol/client. The per-fleet farm exists because a shared one caused
cross-run corruption (bench#36).

**1e. Mirrored DB layer.** Hand-mirrored Kysely schema (`src/db/schema.ts`),
direct Postgres identity seeding (`generateApiKey` + `hashPhone` +
`status='active'` forged inserts), DB tailing + re-implemented KEK→DEK envelope
decryption (`src/observer/db-poll.ts`, `ENCRYPTION_MASTER_SECRET` custody
sprawl), and an FK-ordered bash cleanup script.

Also coupling, not vendoring: hand-typed RPC wrappers over untyped
`sendRpc` (`src/rpcs.ts`), manual `HelloOk` validation, raw `EventFrame`
sniffing, stdout `"connected as "` readiness scraping + fixed sleeps, orchestrator
DM pre-creation per contact edge, `moltzap send conv:` CLI syntax baked into
persona prompts, K-full-docker-stack parallelism because run isolation is a
whole-DB wipe.

## 2. What upstream ALREADY fixed (behind the 408→721 rewrite)

The bench's hand-rolled layer is mostly obsolete at current main/npm:

- Typed RPC client: `MoltZapAgentClient.call` over the Effect RpcGroup catalog →
  deletes `src/rpcs.ts`; `HelloOk` is now an empty struct → deletes
  `readAgentIdFromHelloOk`.
- `MoltZapService.sendToAgent` + `resolveTarget("agent:<name>")` → deletes DM
  pre-creation.
- `AgentPresenceSubscribe` + `awaitAgentReadyByPolling` → deletes stdout
  readiness scraping.
- Invite-gated `POST /api/v1/auth/register` + RPC registration → replaces most
  DB seeding.
- Embeddable/dev server exists in three forms: npx-able `bin/moltzap-server`
  standalone (YAML config with env interpolation — arena's #352 fixed; embedded
  PGlite or `DATABASE_URL` — #356 fixed), the published
  `@moltzap/server-core/test-utils` subpath (`startCoreTestServer` /
  `resetCoreTestDb` / `createTestAgent(ownerUserId)` / `getCoreDb` /
  `getCoreEncryptionEnvelope` / span exporter), and `packages/server/Dockerfile`
  (the moltzap-network image) → deletes `bench-server/` and the cleanup script.
- Cross-conversation full recap (`peekFullMessages`/`formatCrossConv`) → deletes
  both client patches; `MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR` context-log covers
  bench-capture's observation job.

But the migration delta is total: every RPC renamespaced (`auth/connect` →
`agent/network/connect`; contacts → `agent/identity/contacts/*` with a new
`ContactSchema`), everything task-scoped (`MessagesSend` requires
taskId+conversationId+parts array), conversation creation is app-principal-only
with agents going through `agent/task/request` against a boot-installed
auto-accepting `DEFAULT_APP_ID` app, and `phone-hash`/`validators`/`EventNames`/
`ErrorCodes`/`RequestFrame`/`EventFrame` deleted. **Nothing the bench pins can be
upgraded incrementally — the port is a one-time rewrite of its moltzap layer that
deletes `rpcs.ts`, `bench-server/`, `patches/`, and most of `vendor/`.**

## 3. Genuinely missing interfaces (the work on our side)

1. **Publish `@moltzap/runtimes`** — the umbrella cause of 1a/1c/1d and all three
   patches. `.github/workflows/publish.yml` hardcodes only
   `protocol server client openclaw-channel` (naming runtimes in
   workflow_dispatch silently no-ops — documented in #755's body);
   `packages/runtimes/package.json` is 0.2.0, no license/repository fields. No
   open issue owns this. Publishing alone deletes only ~230 of ~1,990 vendored
   lines; deleting `vendor/` entirely needs six named absorptions:
   1. `allExplicit` factory fix — upstream `createWorkspaceOpenClawAdapter`
      still calls `resolveWorkspacePackageRoot()` unconditionally and dies
      (`WorkspaceRootNotFound` defect) under any npm install, even with all
      paths explicit. Cheapest highest-value fix; unblocks npm consumption at all.
   2. `require.resolve` protocol/client links in `linkWorkspacePackages` (same
      mechanism as `resolveChannelDependency`) — kills the symlink farm;
      `repoRoot` leaves the consumer contract.
   3. `getStateDir` (Runtime + Fleet) — artifact/calendar harvest surface.
   4. Capture/extension hook (`extraExtensionDirs`) + headless config knobs
      (gateway auth, mDNS, tools.exec, keep-state-dir) + `sun_path` budgeting.
   5. Sandbox + env-allowlist as options (child-env.ts / sandbox-launcher.ts are
      generic adversarial-fleet safety modules that belong upstream — #365).
   6. Channel `contextAdapter` as a supported API instead of a patched dist.
   Plus: a supported headless gateway-auth story for openclaw (the operator-auth
   bypass patch has no upstream fix anywhere), and publishing
   runtimes+channel+client as a version-matched set (they are pairwise
   version-locked via the profile-config contract).
2. **Content-carrying observation/trace API** (#364, open, carried to v2
   2026-07-20). Main's OTel spans (`moltzap.message.delivered/blocked`) are
   metadata-only by design; a propagation bench needs message bodies per run.
   Interim on main: bless `test-utils` `getCoreDb`+`getCoreEncryptionEnvelope`
   as a stable observation contract or expose a read-only transcript stream —
   deletes `src/observer/db-poll.ts`. In v2: drive data-plane open question 9
   (the eval-middleware seam) to a recorded decision and land #364's schema
   (infection events, hop number, parent vector, reproduction rate).
3. **Multi-owner topology/fixture bootstrap + out-of-process reset.** HTTP
   registration is single-owner (defeats owner-level contact topology);
   `createTestAgent(ownerUserId)` covers it only in-process. No supported
   out-of-process reset API (bench's whole-DB wipe → K docker stacks for
   parallelism).
4. **Contact-gating semantics.** The standalone's contact policy is OFF by
   default (no-ops for in_process); bench-server never enforced it either — the
   bench's owner-level gating invariant lives harness-side. The #360 carry
   decision moves edge enforcement to endpoint gates in v2 (#361/#362 not
   carried); the bench needs the endpoint-gate story to preserve its invariant.
5. **Skill/workspace mount contract** (#198). `src/skills.ts` mounts
   per-scenario `skills/` trees (SKILL.md + scripts/) into agent workspaces via
   the vendored adapter's workspace-file seeding; 4 experiments ship executable
   skill trees. Coupling is layout-only today; when runtimes is published, the
   workspace-file/skills contract should be part of the published
   `Runtime`/`SpawnInput` surface (constitution L4 adjacency).
6. **Open blocker on the standalone path:** #277 (server-core zero-env boot
   regression); also note `admin_user_id` is required-or-boot-fails and the
   3000-vs-41973 port mismatch between defaults, example YAML, and Dockerfile.

## 4. Bench-internal tech debt (survives perfect upstream interfaces)

Source is clean of TODO/FIXME markers — the debt is structural:

- **Zero engineering infrastructure**: no CI (`.github/` absent), no
  linter/formatter (14 cargo-culted eslint-disable directives), live
  orchestration layer entirely untested (fleet, bench, run-scenario, seed,
  stacks, all of bench-server) vs 231 tests on the pure compile/verdict layers.
- **Dual authoring stacks, both live**: 25 legacy manual-JSON scenario dirs vs
  17 params.yaml dirs — two validators, two error taxonomies.
  `compile-experiment.ts` is a 1,225-line god-module mixing roster expansion, a
  calendar-math library, hardcoded university-domain fixtures, persona
  templating, and answer-key derivation; calendar-slot parsing is implemented
  3+ times (compiler, verdict, viewer).
- **Docs contradict code in all three top-level documents**: README caveat #3
  claims "no verdict is computed"; CLAUDE.md documents a nonexistent `paper/`
  dir and only the legacy path; CONTRIBUTING's repo layout omits ~60% of `src/`.
- **Repo weight**: 84 MB / 5,164 committed run-artifact files (one scenario dir
  is 36 MB / 2,064 files); generated website HTML committed despite its own
  "do NOT hand-edit" header. Condition-hash slugs couple code to committed
  folder names (append-only fragility).
- **Tooling**: `scripts/*.ts` excluded from typecheck; `viewer.js` and
  `build-website.js` are untyped single-file JS duplicating run-layout
  knowledge; broken `exports` path in package.json; tests compiled into dist.

## 5. Recommended sequence

1. File the two missing standalone issues (none exist today): "publish
   `@moltzap/runtimes`" (sub-issue under #755; fix publish.yml + version/license)
   and "supported observation API on main" (interim contract while #364/v2
   decides the real seam). Close #362 as superseded per the #360 carry decision.
2. Land the two one-function unblockers: `allExplicit` factory fix +
   `require.resolve` package links.
3. Absorb the fork's features in order: getStateDir + workspace/skills contract
   (#198) → extension-dir/capture hook + headless config knobs → sandbox/env
   allowlist as options (#365) → contextAdapter as channel API.
4. Bench does the one-time 408→721 port (agents connect to the published
   standalone/moltzap-network image; delete `rpcs.ts`, `bench-server/`,
   `patches/`, symlink farm, DB seeding, DM pre-creation, readiness scraping) —
   after which the bench is a direct customer of five published packages plus
   its own genuinely-local code (scenario DSL, verdicts, viewer, website).

## Method note

Produced by a 7-agent workflow (vendor drift three-way diff, bench-server vs
current server-core, patch archaeology, src coupling catalog, internal-debt
sweep, upstream capability/issue map, adversarial completeness critique). The
critique pass adjudicated four inter-agent contradictions against source; the
corrected verdicts are what appears above (notably: `linkWorkspacePackages` does
NOT work outside the monorepo; the recap fix IS upstream; `AgentPresenceSubscribe`
IS published; openclaw-channel's context-log covers bench-capture's role). Full
structured findings: workflow run `wf_19e207ba-3a9` (session
`f65f61ef`, task `w35lx7yhu.output`).
