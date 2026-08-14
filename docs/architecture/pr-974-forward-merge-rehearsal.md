# PR 974 final forward-merge record

Status: **RESOLVED CANDIDATE — NON-NORMATIVE**

This records the exact final `main`-to-cutover integration. PR #974 landed on
`main`; the cutover integrated that commit and every earlier `main` commit in
one merge. Routine forward merges are now frozen. Later v1 fixes move only by
an explicit, reviewed port.

## Integrated inputs

- Cutover pre-merge head: `94e5183999cc4fba7319aa5804f1aa2b20f3d349`
- Landed `main` head and PR #974 merge commit:
  `102f110436bedbba828591c1b97fd4e322abcf76`
- PR #974 source head: `7e67ed6e97c215dd6f169111b1e6805783fce88c`
- Merge base: `18ba443d28451e41540c54d29480d9a23c2c5815`

The exact pre-merge rehearsal reported 119 conflict records because the
cutover had already deleted or reorganized v1 Client, Protocol, Server, docs,
and test surfaces that the landed main line still changed.

## Rehearsed inputs

- Cutover head: `bcc3911ed99ed35060bb6eec77a8145e01ab2ee4`
- PR #974 head: `7e67ed6e97c215dd6f169111b1e6805783fce88c`
- Merge base: `18ba443d28451e41540c54d29480d9a23c2c5815`
- Synthetic unresolved tree:
  `af140951faddc60c3adbfa87365e6514d82ab8d7`

Neither head is an ancestor of the other. `git merge-tree --write-tree`
returned 1 because five paths conflict.

Relative to the merge base, the PR changes 307 paths and the cutover changes
97. Ten paths overlap: five auto-merge and five conflict. The 297 PR-only paths
apply cleanly and the 87 cutover-only paths remain unchanged.

## Semantic auto-merges to inspect

| Path | Combined result |
|---|---|
| `knip.json` | Combines the v2 Harness dependency rename with PR removal of retired integration/dependency declarations. |
| `packages/protocol/scripts/docs/typedoc-load.ts` | Combines private source-path normalization with support for both `src` and `dist` declaration roots. |
| `pnpm-lock.yaml` | Combines the Harness importer rename with PR dependency removals and the NanoClaw workspace edge. |
| `scripts/architecture/check-boundaries.js` | Combines current v2 package constraints with transitional production adapter, client export, and daemon-binary checks. |
| `scripts/architecture/gen-configs.mjs` | Combines v2 architecture refinements with the transitional production client/Harness facade. |

These results are appropriate for the one final transitional merge. The
wholesale cutover later replaces the v1-specific assertions with the exact
seven-package graph.

## Conflict resolutions

### `docs/decisions/README.md`

Keep both decision families. The three 2026-08-05 production rows precede the
four 2026-08-01 v2 Harness rows. Preserve the v2 status and lineage edits
elsewhere. Do not supersede either family during the merge: the four-layer
replacement remains non-normative until its authority gate passes.

### `docs/spec/cli.md`

Keep the cutover deletion. Restoring the stale main-resident CLI chapter would
recreate a lower-authority contradiction; current v2 management authority is
under `docs/spec/harness/*` and `docs/spec/management.md`.

### `docs/spec/endpoints/daemon.md`

Keep the cutover deletion. Current v2 daemon authority is
`docs/spec/harness/daemon.md`, which the eventual four-layer candidate will
replace explicitly.

### `packages/protocol/scripts/docs/__tests__/module-exports.test.ts`

Keep the cutover deletion. The surviving `module-docs.test.ts` covers its
export/folder behavior; do not restore a superseded test shell only for fixture
renaming.

### `packages/protocol/scripts/docs/__tests__/typedoc-load.test.ts`

Keep the cutover deletion and port its unique `dist/*.d.ts` worktree-path
regression into the public `loadTypeDoc` integration coverage in
`module-docs.test.ts`. Do not re-export private `normalizeSourcePath` for a
unit test.

The exact test fixture uses a separate cache whose source is:

```text
/workspace/moltzap-worktree/packages/protocol/dist/socket/agent-client.d.ts
```

It asserts these public-loader projections:

```text
packages/protocol/dist/socket/agent-client.d.ts
packages/protocol/dist/socket
```

Using a separate cache prevents `generateModuleDocs` from treating
`dist/socket` as a renderable source module. Existing fixtures already cover
Unix `src`, Windows `src`, and permalink recovery.

## Resolved integration policy

- Intentional cutover deletions remain deleted: the v1 conformance workflow,
  quickstart/testbed, CLI and daemon-profile process plane, retired protocol
  docs, forwarding facades, Snowflake sequencing, generated database schema,
  and obsolete documentation tests were not revived.
- The compatible production changes from `main` were ported: Streamable HTTP
  MCP support, Kubernetes call timeouts and worker-roll safety, hosted Phoenix
  evaluation support, bounded evaluation diagnostics, database-owned message
  order, message-body evidence, and the agent/conversation/message read plane.
- The landed profile-slot and profile-selected daemon implementation was not
  kept. The accepted four-layer outcome had already removed named profiles,
  and the maintainer subsequently accepted the smaller Client boundary. Its
  authority update lands after this mechanical merge rather than being
  invented during conflict resolution.
- Generated module documentation was regenerated from the resolved source,
  and the unique worktree `dist/*.d.ts` normalization regression from the
  retired TypeDoc test was ported to the root module-doc integration suite.

The merge candidate is complete only after its package, architecture,
documentation, and decision-lineage gates pass. The resulting merge commit is
the recorded final base; routine `main`-to-cutover merges remain frozen even
when later v1 commits appear.
