# PR 974 forward-merge rehearsal

Status: **EXACT-SHA MECHANICAL HANDOFF — NON-NORMATIVE**

This records the read-only rehearsal for the final `main`-to-cutover merge. It
does not merge the pull request, accept its review evidence, or replace the
requirement to merge landed `main`. Repeat the rehearsal if either relevant
head changes.

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

## Actual merge gate

The real merge occurs only after PR #974 lands and uses the landed `main` head.
Then:

1. repeat `merge-tree` against the exact heads;
2. resolve every conflict explicitly and inspect all semantic auto-merges;
3. regenerate and check the lockfile and documentation outputs;
4. run the affected architecture, docs, package, and Nx targets;
5. freeze the resolved semantic candidate; and
6. run a fresh isolated blind review because decision-index conflict
   resolution produces a new candidate.
