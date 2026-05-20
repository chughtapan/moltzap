/**
 * @file Behavioral-export flow-coverage report.
 *
 * Walks the typedoc cache filtered to behavioral exports (functions,
 * methods, Effect-returning constants), then lists those with neither
 * a JSDoc summary nor a fenced ```mermaid block. Exit code 0 — the
 * report is the visible todo queue, not a gate.
 */
import { Effect } from "effect";
import { ReflectionKind, type TypeDocCache, type TypeDocExport } from "./typedoc-load.js";

export interface FlowCoverageGap {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly reason: "no-summary" | "no-flow" | "no-summary-or-flow";
}

const EFFECT_LIKE_TYPE_NAMES = new Set([
  "Effect",
  "Layer",
  "Stream",
  "Scope",
  "Schedule",
  "Fiber",
]);

/**
 * Return true when `ex` carries observable runtime behavior worth
 * documenting with prose or a flow diagram. Functions and methods
 * qualify directly. Variables only qualify when their declared type
 * resolves to an Effect-family constructor (`Effect`, `Layer`,
 * `Stream`, `Scope`, `Schedule`, `Fiber`).
 */
export function isBehavioralExport(ex: TypeDocExport): boolean {
  if (ex.kind === ReflectionKind.Function) return true;
  if (ex.kind === ReflectionKind.Method) return true;
  if (ex.kind === ReflectionKind.Variable) {
    const typeName = ex.signatureReturnTypeName;
    return typeName !== null && EFFECT_LIKE_TYPE_NAMES.has(typeName);
  }
  return false;
}

/**
 * Return the list of behavioral exports lacking either a JSDoc summary
 * or a fenced ```mermaid block in their JSDoc body. Sorted by file
 * path then line.
 */
export function computeFlowCoverage(
  cache: TypeDocCache,
): ReadonlyArray<FlowCoverageGap> {
  const out: FlowCoverageGap[] = [];
  for (const ex of cache.all) {
    if (!isBehavioralExport(ex)) continue;
    const src = ex.sources[0];
    if (!src) continue;
    const hasSummary = (ex.comment?.summary ?? "").trim().length > 0;
    const hasFlow = hasMermaidBlock(ex);
    if (hasSummary && hasFlow) continue;
    const reason = classifyReason(hasSummary, hasFlow);
    out.push({
      file: src.fileName,
      line: src.line,
      symbol: ex.name,
      reason,
    });
  }
  out.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
  return out;
}

function classifyReason(
  hasSummary: boolean,
  hasFlow: boolean,
): FlowCoverageGap["reason"] {
  if (!hasSummary && !hasFlow) return "no-summary-or-flow";
  if (!hasSummary) return "no-summary";
  return "no-flow";
}

function hasMermaidBlock(ex: TypeDocExport): boolean {
  if (!ex.comment) return false;
  if (ex.comment.summary.includes("```mermaid")) return true;
  for (const tag of ex.comment.tags) {
    if (tag.content.includes("```mermaid")) return true;
  }
  return false;
}

/**
 * Print the gap list to stderr in the form
 * `<file>:<line> <symbol> — <reason>`. Returns the count.
 */
export const printFlowCoverage = (
  gaps: ReadonlyArray<FlowCoverageGap>,
): Effect.Effect<number, never, never> =>
  Effect.sync(() => {
    if (gaps.length === 0) {
      process.stderr.write("Flow coverage: every behavioral export documented.\n");
      return 0;
    }
    process.stderr.write(
      `\nFlow coverage gaps (${gaps.length} behavioral export${gaps.length === 1 ? "" : "s"} without summary or flow):\n`,
    );
    for (const g of gaps) {
      process.stderr.write(`  ${g.file}:${g.line} ${g.symbol} — ${g.reason}\n`);
    }
    return gaps.length;
  });
