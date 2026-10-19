/** @file Bounded schema diagnostics that never inspect rejected values. */

import { Array, Option, type ParseResult, SchemaAST } from "effect";

const MAXIMUM_VALIDATION_ISSUES = 20;

interface ValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/**
 * Projects only schema expectations and field paths, keeping submitted values
 * and custom decoder messages out of errors and logs. At most 20 issues cross
 * the boundary even when a schema reports many failing fields or union arms.
 */
export function validationIssues(error: ParseResult.ParseError) {
  const issues: ValidationIssue[] = [];
  appendIssues(error.issue, [], issues);
  return issues;
}

function appendIssues(
  issue: ParseResult.ParseIssue,
  path: ReadonlyArray<string | number>,
  issues: ValidationIssue[],
): void {
  if (issues.length >= MAXIMUM_VALIDATION_ISSUES) {
    return;
  }
  if (issue._tag === "Pointer") {
    appendIssues(
      issue.issue,
      [...path, ...Array.ensure(issue.path).map(pathSegment)],
      issues,
    );
    return;
  }
  if (issue._tag === "Composite") {
    appendChildren(Array.ensure(issue.issues), path, issues);
    return;
  }
  if (issue._tag === "Refinement" || issue._tag === "Transformation") {
    appendIssues(issue.issue, path, issues);
    return;
  }
  issues.push({ path, message: expectedMessage(issue) });
}

function appendChildren(
  children: readonly ParseResult.ParseIssue[],
  path: ReadonlyArray<string | number>,
  issues: ValidationIssue[],
): void {
  for (const child of children) {
    appendIssues(child, path, issues);
    if (issues.length >= MAXIMUM_VALIDATION_ISSUES) {
      break;
    }
  }
}

function pathSegment(key: PropertyKey): string | number {
  return typeof key === "number" ? key : String(key);
}

function expectedMessage(
  issue:
    | ParseResult.Type
    | ParseResult.Forbidden
    | ParseResult.Missing
    | ParseResult.Unexpected,
): string {
  switch (issue._tag) {
    case "Unexpected":
      return "Unexpected field";
    case "Missing":
      return "Required field is missing";
    case "Type":
    case "Forbidden":
      return `Expected ${Option.getOrElse(
        SchemaAST.getDescriptionAnnotation(issue.ast),
        () => String(issue.ast),
      )}`;
    default:
      return issue satisfies never;
  }
}
