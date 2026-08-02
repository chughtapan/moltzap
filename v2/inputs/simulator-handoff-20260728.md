# Simulator source handoff

Status: pending upstream landing

Decision owner:
[`20260728-simulator-is-the-system-driver.md`](../../docs/decisions/20260728-simulator-is-the-system-driver.md)

Execution owner:
[`docs/architecture/first-implementation.md`](../../docs/architecture/first-implementation.md)

## Purpose

This manifest is the sole source-provenance gate for porting the
code-first simulator kernel into `v2/simulator`. The port may begin only
after this document names a landed, reconstructible source commit and
records green, non-vacuous verification.

The candidate lineage has merged into `v2`, but it has not landed on the
required `main` branch and follow-up correctness and evaluation work remains
unlanded. Neither a `v2` merge, a branch name, nor a dirty-worktree HEAD is a
handoff.

## Source identity

| Field | Required value |
|---|---|
| Source repository | this repository |
| Candidate lineage | `integration/rebase-2026-07-27` plus `evals/check-outcome` |
| Required landing branch | `main` after the Gate 0 architecture freeze |
| Landed source SHA | _unset_ |
| Source tree clean at SHA | _unverified_ |
| Constitution alignment review | _unverified_ |
| Reviewer | _unset_ |
| Verification date | _unset_ |

Do not fill `Landed source SHA` with a dirty-worktree HEAD, merge-base,
patch identity, abbreviated hash, or anticipated commit. It must be the
40-character SHA of the exact landed source state.

## Entry conditions

All boxes must be checked before changing status to `verified`:

- [ ] The Gate 0 repository-native architecture freeze has landed on
      `main`.
- [ ] Candidate work has been rebased onto that `main`.
- [ ] Every simulator, testbed, eval, configuration, fixture, and
      decision file needed to reconstruct the source is tracked.
- [ ] The source no longer assumes a conversation-aware L2,
      Router-owned Transcript, umbrella production server, or
      testbed-owned production implementation.
- [ ] Architecture checks inspect a nonzero set of source files and
      report no violations.
- [ ] Build, typecheck, lint, unit, architecture, and agent-evaluation
      gates pass without Nx cache.
- [ ] The source changes are reviewed and landed on `main`.
- [ ] The exact landed SHA is checked out cleanly and the gates are
      repeated or their immutable CI results are linked.
- [ ] Run evidence and artifact digests below are complete.

## Required verification

Record immutable CI links or paste concise command results. Do not mark a
row passed from a cached or vacuous invocation.

| Gate | Command | Result |
|---|---|---|
| simulator build | `pnpm nx run @moltzap/simulator:build --skip-nx-cache` | pending |
| simulator test typecheck | `pnpm nx run @moltzap/simulator:typecheck:tests --skip-nx-cache` | pending |
| simulator lint | `pnpm nx run @moltzap/simulator:lint --skip-nx-cache` | pending |
| simulator unit tests | `pnpm nx run @moltzap/simulator:test --skip-nx-cache` | pending |
| simulator architecture | `pnpm nx run @moltzap/simulator:arch:check --skip-nx-cache` plus nonzero scanned-file evidence | pending |
| eval build | `pnpm nx run @moltzap/evals:build --skip-nx-cache` | pending |
| eval test typecheck | `pnpm nx run @moltzap/evals:typecheck:tests --skip-nx-cache` | pending |
| eval lint | `pnpm nx run @moltzap/evals:lint --skip-nx-cache` | pending |
| eval unit tests | `pnpm nx run @moltzap/evals:test --skip-nx-cache` | pending |
| semantic-judge calibration | `OPENAI_API_KEY=... pnpm nx run @moltzap/evals:calibrate --skip-nx-cache` | pending |
| live evaluation matrix | `OPENAI_API_KEY=... pnpm nx run @moltzap/evals:eval --skip-nx-cache -- --report-id <report-id> --openclaw-model <model-id> --nanoclaw-model <model-id>` | pending |

## Preserve in the v2 port

The landed source review must identify the exact owning symbols. These
are behavioral requirements, not permission to copy untracked files.

- `Simulator.define` remains the code-first public authoring surface.
- Definition identity, exact catalog tags, provenance, and metadata are
  immutable run evidence.
- EventCatalog is closed, typed, and versioned for persisted replay.
- RunLedger and `LedgerStorage` retain typed append/read and artifact
  digest evidence.
- Runtime roster construction and runtime/process acquisition are
  scoped and release cleanly on success, failure, or interruption.
- The society lifecycle engine stays private to the simulator.
- Deterministic diagnostics make acquisition, readiness, execution, and
  teardown failures attributable.

## Adapt for v2

- Replace v1 Router/provider contracts with one public `StackProvider`
  capability owned and root-exported by `simulator`; `testbed` supplies
  its production Live Layer.
- Give runtime subjects the public `HarnessClient` capability; never give them
  Router, Ledger, database, key, daemon, profile configuration, or platform
  internals.
- Replace v1 protocol and event types with v2-native public contracts.
- Keep platform and external-process constructors in `testbed`.
- Treat the production stack as one black-box subject with separate Registry,
  Router, Ledger, and one `moltzapd` process per named profile slot.
- Keep simulation RunLedger separate from the product Transcript in
  type ownership, persistence, offsets, hashes, and migrations.

## Do not port

- v1 app principals, TaskMasters, leases, hooks, callbacks, or protocol
  wire types;
- a conversation-aware Router or L2 replay/recovery contract;
- `launchTestbed` or another public lifecycle engine;
- a testbed-owned alternative Router, Ledger, daemon, or umbrella
  production server;
- YAML/grading DSLs into the portable simulator kernel;
- Node child-process, container, filesystem, or port-acquisition
  mechanics into `simulator`;
- any second simulator engine.

## Required run evidence

The verified handoff records at least one run containing all four roster
implementations. The exact names and run representation come from the
landed source; no placeholder here defines a new API.

| Evidence | Value |
|---|---|
| Simulator definition ID | pending |
| Run ID | pending |
| Customer-defined `defineRuntime` agent present | pending |
| Effect-native runtime present | pending |
| OpenClaw runtime present | pending |
| NanoClaw runtime present | pending |
| Manifest digest | pending |
| Records digest | pending |
| Ledger format version and exact event catalog tags | pending |
| Clean scoped teardown | pending |

## Status transition

Changing this manifest to `verified` is a reviewed repository change.
That change must fill every identity/evidence field, check every entry
condition, and cite results tied to the landed SHA. Only then may the v2
simulator port consume the named source.
