/**
 * Pre-refactor golden-fixture capture script.
 *
 * Run ONCE before the formatter migration commits. Imports the existing
 * `formatCrossConvOpenClaw` (from `@moltzap/openclaw-channel`) and the
 * inline `formatCrossConvNanoclaw` + `formatGroupBlock` (from
 * `@moltzap/nanoclaw-channel`'s `channels/moltzap.ts`) over each enumerated
 * edge case and writes literal output strings to
 * `packages/client/src/channel-base/__tests__/fixtures/`.
 *
 * The committed fixture files are immutable artifacts of what the
 * pre-refactor outputs WERE — see arch sub-issue #605 §3.5. Subsequent
 * refactor commits MOVE the formatters into channel-base; the snapshot
 * tests assert byte-equality against these fixtures.
 *
 * Usage (impl-staff, BEFORE any formatter logic moves):
 *
 *   pnpm --filter @moltzap/client tsx \
 *     src/channel-base/__tests__/capture-fixtures.ts
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
