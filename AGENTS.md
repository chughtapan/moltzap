# moltzap — agent briefing

This file orients any coding agent (Codex, OpenClaw, or otherwise)
working in this repo. Claude sessions also read `CLAUDE.md`, which
carries the same identity plus Claude-specific conventions.

## What this project is

moltzap is the **social harness** for agentic societies: the layered
infrastructure through which autonomous agents representing different
principals message, coordinate, and collaborate without livelocking,
stalling, or being steered by faulty or malicious peers. The project
is changing architectures — that is what the two tracks below are.

## The two tracks

- **v1** lives on `main`: the production line. It serves current
  consumers, generates experimental baselines, and is clearing its
  mapped debt (tracking epic: moltzap#755). Fix v1 things on v1's own
  terms; do not retrofit v2 architecture onto it.
- **v2** lives on the `v2` branch: a clean-slate rewrite founded on an
  interface spec (`docs/spec/` on that branch). v2 code lives under
  `v2/*` and imports nothing from `packages/*` (CI-enforced).
- main merges forward into v2; v2 never merges back until cutover;
  npm publishes from main only.

## v2 design law (the constitution)

1. Endpoints | control plane + storage | data plane. Everything
   interpretive lives at endpoints.
2. The network is a router: no app principals, no manifest hooks, no
   TaskMasters. Coordination logic lives in endpoint skills.
3. CLI operates the control plane; harness-specific channels handle
   the data plane.
4. Layers are capabilities of each agent's social harness; the router
   is shared substrate. L1 unforgeable identities. L2 per-message
   collective ops (`send(sender, op, participants?, witnesses,
   conversation_id, body)`; semantics charter: moltzap#765). L2.5
   conversations as first-class addressing. L3 per-agent guardrails at
   endpoints only. L4 norms as marketplace-distributed skills. L5
   records/monitors/registries/revocation. L6 governance.
5. Data plane can become content-blind; e2e encryption is a preserved
   possibility, not a requirement.
6. Storage is durable-then-deliver.
7. Spec language states guarantees, never mechanisms. Open questions
   stay open until evidence answers them — do not bind answers early.

Full vision + open-question register: `v2/VISION.md`.

## Issue conventions

- `v2` label: the issue is aligned input to the v2 track.
- `wontfix-v2` label: bound to v1 machinery the constitution retires;
  it will not be carried into v2.
- The v2 bootstrap epic (#755) and its children own infrastructure and
  debt-zero work.

## Ground rules for agents

- Read the relevant package `CLAUDE.md` before editing a package.
- Run tasks through `nx` via the workspace package manager
  (`pnpm nx ...`); never guess CLI flags.
- Cite code by symbol name, not line number. Comments serve a cold
  reader: no change-narration, no issue numbers in code.
- `pnpm lint` must stay green; it includes architecture boundary
  checks (`scripts/check-architecture-boundaries.js`).
- External case studies (`moltzap-propagation-bench`, `moltzap-arena`)
  stay in their own repos. If one needs framework internals, that is
  an interface gap to record, not a reach-in to enable.
