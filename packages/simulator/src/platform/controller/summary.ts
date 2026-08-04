/** @file Closed, bounded result projection emitted by one controller process. */

import { Either, Schema } from "effect";
import {
  CompletedLedgerReceipt,
  LedgerReceipt,
  type IncompleteLedgerReceipt,
} from "../../kernel/run.js";

/** Prefix distinguishing the controller-owned final line from application logs. */
export const CONTROLLER_SUMMARY_PREFIX = "moltzap.controller-result/v1 ";
/** Upper bound for the complete UTF-8 result line read from controller logs. */
export const CONTROLLER_SUMMARY_MAX_BYTES = 4_096;

const programFinishedSummarySchema = Schema.Struct({
  _tag: Schema.Literal("ProgramFinished"),
  receipt: CompletedLedgerReceipt,
});

const runInfrastructureFailedSummarySchema = Schema.Struct({
  _tag: Schema.Literal("RunInfrastructureFailed"),
  receipt: LedgerReceipt,
});

const ledgerAllocationFailedSummarySchema = Schema.Struct({
  _tag: Schema.Literal("LedgerAllocationFailed"),
});

/** Complete result information permitted to leave the controller process. */
const controllerRunSummarySchema = Schema.Union(
  programFinishedSummarySchema,
  runInfrastructureFailedSummarySchema,
  ledgerAllocationFailedSummarySchema,
);
/** Decoded controller result projection. */
export type ControllerRunSummary = typeof controllerRunSummarySchema.Type;

/** Successful customer-program projection, deliberately excluding its Exit. */
export type ControllerProgramFinishedSummary = Extract<
  ControllerRunSummary,
  { readonly _tag: "ProgramFinished" }
>;
/** Failed controller projection that carries no customer failure value. */
export type ControllerFailedRunSummary = Exclude<
  ControllerRunSummary,
  ControllerProgramFinishedSummary
>;

const parseSummary = Schema.decodeUnknownEither(
  Schema.parseJson(controllerRunSummarySchema),
);

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Project program completion without serializing the program's value or error.
 * @param receipt Complete durable evidence returned by the kernel.
 * @returns The closed successful controller summary.
 */
export function programFinishedSummary(
  receipt: CompletedLedgerReceipt,
): ControllerProgramFinishedSummary {
  return Object.freeze({ _tag: "ProgramFinished", receipt });
}

/**
 * Project an infrastructure outcome without serializing its Cause.
 * @param receipt Durable evidence retained by the kernel.
 * @returns The closed failed controller summary.
 */
export function runInfrastructureFailedSummary(
  receipt: CompletedLedgerReceipt | IncompleteLedgerReceipt,
): ControllerFailedRunSummary {
  return Object.freeze({ _tag: "RunInfrastructureFailed", receipt });
}

/**
 * Record that ledger allocation failed before the kernel owned a receipt.
 * @returns The closed allocation-failure summary.
 */
export function ledgerAllocationFailedSummary(): ControllerFailedRunSummary {
  return Object.freeze({ _tag: "LedgerAllocationFailed" });
}

/**
 * Encode the one controller-owned result line accepted by the host activity.
 * @param summary Closed result projection.
 * @returns One newline-free, size-bounded log line, or undefined when it exceeds the boundary.
 */
export function encodeControllerRunSummary(
  summary: ControllerRunSummary,
): string | undefined {
  const payload = Schema.encodeSync(
    Schema.parseJson(controllerRunSummarySchema),
  )(summary, { onExcessProperty: "error" });
  const line = `${CONTROLLER_SUMMARY_PREFIX}${payload}`;
  return encodedByteLength(line) <= CONTROLLER_SUMMARY_MAX_BYTES
    ? line
    : undefined;
}

/**
 * Decode the final controller-owned result marker from bounded Pod logs.
 * @param output Raw bounded controller log tail.
 * @returns A valid closed summary, or undefined when the marker is absent or invalid.
 */
export function decodeControllerRunSummary(
  output: string,
): ControllerRunSummary | undefined {
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
