/**
 * Pre-refactor golden-fixture capture script.
 *
 * Lives at workspace-root `scripts/` (not inside `@moltzap/client`) because:
 *   1. It imports from `@moltzap/openclaw-channel` and `@moltzap/nanoclaw-channel`
 *      to capture the existing formatter outputs — client cannot depend on
 *      those packages (dep-graph inversion).
 *   2. It is a one-shot side-effecting script (writes .md files), not a
 *      vitest test; keeping it out of any package's `src/` avoids polluting
 *      build/lint surfaces.
 *
 * Run ONCE before the formatter migration commits, BEFORE the existing
 * `formatCrossConvOpenClaw`, `formatCrossConvNanoclaw`, and inline
 * `formatGroupBlock` are deleted/moved. Writes literal output strings to
 * `packages/client/src/__tests__/channel-base/fixtures/`.
 *
 * Impl-staff prerequisite: `formatCrossConvNanoclaw` + `formatGroupBlock` in
 * `packages/nanoclaw-channel/src/channels/moltzap.ts` are file-local at HEAD
 * (declared as `function formatCrossConvNanoclaw(...)` and
 * `function formatGroupBlock(...)`). Before running the capture, impl-staff
 * temporarily exports them (or imports them via a one-off re-export module);
 * the export is reverted in the same commit that deletes both. The capture
 * script MUST run from the worktree state where both old functions still
 * exist.
 *
 * The committed fixture files are immutable artifacts of what the
 * pre-refactor outputs WERE — see arch sub-issue #605 §3.5. Subsequent
 * refactor commits MOVE the formatters into channel-base; the snapshot
 * tests assert byte-equality against these fixtures.
 *
 * Usage (impl-staff, BEFORE any formatter logic moves):
 *
 *   pnpm tsx scripts/capture-channel-base-fixtures.ts
 *
 * The script is checked in so future archaeologists can re-run it. It is
 * NOT a vitest test and NOT wired into CI.
 *
 * Implementation is impl-staff scope. Enumerated edge cases (see spec
 * §"Acceptance criteria" — golden fixtures):
 *   - format-cross-conv: empty, single, multi, own-agent, sender-lookup-none
 *     × { json-header, xml-system-reminder }
 *   - format-group-block: absent, present-name-only, present-with-members
 *     × { json-header, xml-system-reminder }
 *
 * Total: 16 fixture files.
 */

throw new Error(
  "not implemented (arch stub; impl-staff runs this BEFORE moving formatters " +
    "into channel-base — see arch sub-issue #605 §3.5)",
);
