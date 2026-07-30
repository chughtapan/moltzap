/**
 * @file Behavioral-export flow-coverage report.
 *
 * Walks the typedoc cache filtered to behavioral exports (functions,
 * methods, Effect-returning constants), then lists those with neither
 * a JSDoc summary nor a fenced ```mermaid block. Exit code 0 — the
 * report is the visible todo queue, not a gate.
 */
import { Effect } from "effect";
import {
  ReflectionKind,
  type TypeDocCache,
  type TypeDocExport,
} from "./typedoc-load.js";

/** Describes flow coverage gap. */
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
 * @param ex TypeDoc export reflection to inspect.
 * @returns Whether behavioral export.
 */
export function isBehavioralExport(ex: TypeDocExport): boolean {
  if (ex.kind === ReflectionKind.Function) {
    return true;
  }
  if (ex.kind === ReflectionKind.Method) {
    return true;
  }
  if (ex.kind === ReflectionKind.Variable) {
    const typeName = ex.signatureReturnTypeName;
    return typeName !== null && EFFECT_LIKE_TYPE_NAMES.has(typeName);
  }
  return false;
}

/**
 * Return true when `ex` is internal scaffolding the user-facing flow
 * report should ignore. Three signals, any of which suffices:
 *
 * - Source path contains a `__dunder__/` folder segment. Convention
 *   for "internal-only across-file scaffolding" — sibling tests
 *   import the symbols but no consumer outside the folder does.
 * - Source path contains a single-leading-underscore folder segment
 *   (e.g., `_shared/`). The JavaScript convention for "private to
 *   this subtree". Cross-file imports inside the subtree require
 *   `export` for the type system; the leading underscore signals
 *   the export is structural, not part of the public surface.
 * - JSDoc carries an `@internal` tag. Per-export opt-out for cases
 *   where the folder convention doesn't apply.
 * @param ex TypeDoc export reflection to inspect.
 * @returns Whether internal export.
 */
function isInternalExport(ex: TypeDocExport): boolean {
  const src = ex.sources[0];
  if (src && /\/(__[^/]+__|_[^/]+)\//.test(src.fileName)) {
    return true;
  }
  if (!ex.comment) {
    return false;
  }
  return ex.comment.tags.some((tag) => tag.tag === "@internal");
}

/**
 * Return the list of behavioral exports lacking either a JSDoc summary
 * or a fenced `mermaid` block in their JSDoc body. Sorted by file
 * path then line.
 * @param cache Loaded TypeDoc reflection cache.
 * @returns The compute flow coverage result.
 */
export function computeFlowCoverage(
  cache: TypeDocCache,
): readonly FlowCoverageGap[] {
  const out: FlowCoverageGap[] = [];
  for (const ex of cache.all) {
    if (!isBehavioralExport(ex)) {
      continue;
    }
    if (isInternalExport(ex)) {
      continue;
    }
    const src = ex.sources[0];
    if (!src) {
      continue;
    }
    const hasSummary = (ex.comment?.summary ?? "").trim().length > 0;
    const hasFlow = hasMermaidBlock(ex);
    if (hasSummary && hasFlow) {
      continue;
    }
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
  if (!hasSummary && !hasFlow) {
    return "no-summary-or-flow";
  }
  if (!hasSummary) {
    return "no-summary";
  }
  return "no-flow";
}

function hasMermaidBlock(ex: TypeDocExport): boolean {
  if (!ex.comment) {
    return false;
  }
  if (ex.comment.summary.includes("```mermaid")) {
    return true;
  }
  for (const tag of ex.comment.tags) {
    if (tag.content.includes("```mermaid")) {
      return true;
    }
  }
  return false;
}

/**
 * Print the gap list to stderr in the form
 * `&lt;file>:&lt;line> &lt;symbol> — &lt;reason>`. Returns the count.
 * @param gaps Coverage gaps to report.
 * @returns The print flow coverage result.
 */
export const printFlowCoverage = (
  gaps: readonly FlowCoverageGap[],
): Effect.Effect<number> =>
  Effect.sync(() => {
    if (gaps.length === 0) {
      process.stderr.write(
        "Flow coverage: every behavioral export documented.\n",
      );
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
