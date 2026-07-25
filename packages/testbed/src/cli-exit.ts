/**
 * @file The instrument's tag-to-exit-code mapping. Exit codes key on
 * stable error tags, never on messages, so a script can branch on what
 * happened without parsing prose.
 *
 * Two bands share the space. The instrument owns `2`-`5` (what happened
 * to a run) and `10`-`12` (what is wrong with a recording it is reading).
 * The grading convention owns `13`-`14` (what is wrong with using this
 * recording as evidence). `1` stays the residual: a failure the mapping
 * does not name is reported as unexpected rather than dressed up as one
 * of the known refusals.
 */

/**
 * Every exit code the CLI produces, by the name a caller branches on.
 * The codes are contract: scripts and CI jobs key on them, so they are
 * named here once rather than repeated as literals wherever they appear.
 */
export const EXIT_CODE = {
  ok: 0,
  unexpected: 1,
  rejected: 2,
  runFailed: 3,
  noRecording: 4,
  sealFailed: 5,
  notSealed: 10,
  schemaMismatch: 11,
  invalidRecording: 12,
  conditionMismatch: 13,
  runNotCompleted: 14,
} as const;

/** Every exit code the CLI produces. */
export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

/**
 * Tags with a considered exit code. Adding a member here without a code
 * below is a compile error, which is what keeps the mapping total as the
 * error taxonomy grows.
 */
export type MappedTag =
  | "RunSpecInvalid"
  | "AdapterConfigRejected"
  | "IsolationViolation"
  | "FaultUnsupported"
  | "UnknownDriver"
  | "DriverConfigRejected"
  | "ManifestPersistFailed"
  | "RecordingStoreFailed"
  | "SealFailed"
  | "RecordingUnsealed"
  | "RecordingSchemaMismatch"
  | "RecordingInvalid"
  | "ConditionMismatch"
  | "RunNotCompleted";

const EXIT_CODES: Readonly<Record<MappedTag, ExitCode>> = {
  // Config-time rejections: nothing ran.
  RunSpecInvalid: EXIT_CODE.rejected,
  AdapterConfigRejected: EXIT_CODE.rejected,
  IsolationViolation: EXIT_CODE.rejected,
  FaultUnsupported: EXIT_CODE.rejected,
  UnknownDriver: EXIT_CODE.rejected,
  DriverConfigRejected: EXIT_CODE.rejected,
  // No recording exists.
  ManifestPersistFailed: EXIT_CODE.noRecording,
  RecordingStoreFailed: EXIT_CODE.noRecording,
  // A recording exists but the seal path itself failed.
  SealFailed: EXIT_CODE.sealFailed,
  // Reader refusals over an existing recording.
  RecordingUnsealed: EXIT_CODE.notSealed,
  RecordingSchemaMismatch: EXIT_CODE.schemaMismatch,
  RecordingInvalid: EXIT_CODE.invalidRecording,
  // Grading-convention refusals.
  ConditionMismatch: EXIT_CODE.conditionMismatch,
  RunNotCompleted: EXIT_CODE.runNotCompleted,
};

const BY_TAG: ReadonlyMap<string, ExitCode> = new Map(
  Object.entries(EXIT_CODES),
);

/** Map one tagged failure to its exit code; unnamed tags exit `1`. */
export function exitCodeFor(tag: string): ExitCode {
  return BY_TAG.get(tag) ?? EXIT_CODE.unexpected;
}

/**
 * A run that seals an infrastructure failure exits `3`: the recording is
 * real and complete, and the run still did not produce agent behaviour.
 */
export const RUN_FAILED_WITH_RECORDING: ExitCode = EXIT_CODE.runFailed;
