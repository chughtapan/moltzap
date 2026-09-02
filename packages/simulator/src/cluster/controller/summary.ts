/** @file Closed, bounded result projection emitted by one controller process. */

import { Either, Schema } from "effect";
import {
  CompletedLedgerReceipt,
  type IncompleteLedgerReceipt,
  LedgerReceipt,
} from "../../run/execute.js";

// safer-arch-ignore no-cross-domain-sibling-import: Projects run outcomes, which name ledger receipts, into the controller's bounded result.
// safer-arch-ignore shared-kernel-cohesion: The closed controller result is one contract read by three processes — the controller that prints it, the worker that decodes its log line, and the submitter that echoes it — so its readers overlap by design rather than by accident.

/** Prefix distinguishing the controller-owned final line from application logs. */
export const CONTROLLER_SUMMARY_PREFIX = "moltzap.controller-result/v1 ";
/** Upper bound for the complete UTF-8 result line read from controller logs. */
export const CONTROLLER_SUMMARY_MAX_BYTES = 4_096;

/**
 * Project program completion without serializing the program's value or error.
 * @param receipt Complete durable evidence returned by the kernel.
 * @returns The closed successful controller summary.
 */
export function programFinishedSummary(
  receipt: CompletedLedgerReceipt,
): ControllerProgramFinishedSummary {
  return makeProgramFinishedSummary(receipt);
}

/**
 * Project a cluster outcome without serializing its Cause.
 * @param receipt Durable evidence retained by the kernel.
 * @returns The closed failed controller summary.
 */
export function clusterLostSummary(
  receipt: CompletedLedgerReceipt | IncompleteLedgerReceipt,
): ControllerFailedRunSummary {
  return makeClusterLostSummary(receipt);
}

/**
 * Record that ledger allocation failed before the kernel owned a receipt.
 * @returns The closed allocation-failure summary.
 */
export function ledgerAllocationFailedSummary(): ControllerFailedRunSummary {
  return makeLedgerAllocationFailedSummary();
}

/**
 * Encode the one controller-owned result line accepted by the host activity.
 * @param summary Closed result projection.
 * @returns One newline-free, size-bounded log line, or undefined when it exceeds the boundary.
 */
export function encodeControllerRunSummary(
  summary: ControllerRunSummary,
): string | undefined {
  return encodeSummary(summary);
}

/**
 * Decode the final controller-owned result marker from bounded Pod logs.
 * @param output Raw bounded controller log tail.
 * @returns A valid closed summary, or undefined when the marker is absent or invalid.
 */
export function decodeControllerRunSummary(
  output: string,
): ControllerRunSummary | undefined {
  return decodeSummary(output);
}

/** Successful customer-program projection, deliberately excluding its Exit. */
const controllerProgramFinishedSummary = Schema.Struct({
  _tag: Schema.Literal("ProgramFinished"),
  receipt: CompletedLedgerReceipt,
});

/** Failed controller projections, which carry no customer failure value. */
const controllerFailedRunSummary = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("ClusterLost"),
    receipt: LedgerReceipt,
  }),
  Schema.Struct({
    _tag: Schema.Literal("LedgerAllocationFailed"),
  }),
);

/**
 * Coarse outcome of one controller Job: its exit code and the summary it
 * printed, plus the Job's own diagnostic when the run failed and that output
 * was still readable. The worker's activity result and the submitter's final
 * line are this one shape.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- the worker's activity result and the submitter's final line embed this exact closed shape, so it is defined beside the summaries it wraps.
export const controllerRunResult = Schema.Union(
  Schema.Struct({
    exitCode: Schema.Literal(0),
    summary: controllerProgramFinishedSummary,
  }),
  Schema.Struct({
    exitCode: Schema.Literal(1),
    summary: controllerFailedRunSummary,
    diagnostic: Schema.optional(Schema.String),
  }),
);
/** Decoded coarse outcome of one controller Job. */
export type ControllerRunResult = typeof controllerRunResult.Type;

/** Complete result information permitted to leave the controller process. */
const controllerRunSummarySchema = Schema.Union(
  controllerProgramFinishedSummary,
  controllerFailedRunSummary,
);
/** Decoded controller result projection. */
export type ControllerRunSummary = typeof controllerRunSummarySchema.Type;

/** Successful customer-program projection, deliberately excluding its Exit. */
export type ControllerProgramFinishedSummary =
  typeof controllerProgramFinishedSummary.Type;
/** Failed controller projection that carries no customer failure value. */
export type ControllerFailedRunSummary = typeof controllerFailedRunSummary.Type;

const parseSummary = Schema.decodeUnknownEither(
  Schema.parseJson(controllerRunSummarySchema),
);

function makeProgramFinishedSummary(
  receipt: CompletedLedgerReceipt,
): ControllerProgramFinishedSummary {
  return Object.freeze({ _tag: "ProgramFinished", receipt });
}

function makeClusterLostSummary(
  receipt: CompletedLedgerReceipt | IncompleteLedgerReceipt,
): ControllerFailedRunSummary {
  return Object.freeze({ _tag: "ClusterLost", receipt });
}

function makeLedgerAllocationFailedSummary(): ControllerFailedRunSummary {
  return Object.freeze({ _tag: "LedgerAllocationFailed" });
}

function encodeSummary(summary: ControllerRunSummary): string | undefined {
  const payload = Schema.encodeSync(
    Schema.parseJson(controllerRunSummarySchema),
  )(summary, { onExcessProperty: "error" });
  const line = `${CONTROLLER_SUMMARY_PREFIX}${payload}`;
  return encodedByteLength(line) <= CONTROLLER_SUMMARY_MAX_BYTES
    ? line
    : undefined;
}

function decodeSummary(output: string): ControllerRunSummary | undefined {
  const lines = output.split(/\r?\n/u);
  let line: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (candidate?.startsWith(CONTROLLER_SUMMARY_PREFIX) === true) {
      line = candidate;
      break;
    }
  }
  if (
    line === undefined ||
    encodedByteLength(line) > CONTROLLER_SUMMARY_MAX_BYTES
  ) {
    return undefined;
  }
  const decoded = parseSummary(line.slice(CONTROLLER_SUMMARY_PREFIX.length), {
    onExcessProperty: "error",
  });
  return Either.match(decoded, {
    onLeft: () => undefined,
    onRight: (summary) => summary,
  });
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
