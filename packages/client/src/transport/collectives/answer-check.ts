/**
 * @file The keywords one answer value fails against its form field.
 *
 * Each keyword has its JSON Schema 2020-12 meaning, and every failing keyword
 * is reported: a keyword that constrains one JSON type applies only to a
 * value of that type, while `type`, `enum` and `oneOf` apply to any value.
 */

import { Predicate } from "effect";
import type { AnswerContent } from "./forms.js";
import type { FormField } from "./part/index.js";
import { matchesFormat } from "./answer-formats.js";

type AnswerValue = AnswerContent[string];

type MultiSelectItems = Extract<
  FormField,
  { readonly items: unknown }
>["items"];

type LimitKeywordName =
  | "minLength"
  | "maxLength"
  | "minimum"
  | "maximum"
  | "minItems"
  | "maxItems";

/** One keyword's check: each failure it finds, as `keyword: requirement`. */
type KeywordCheck = (field: FormField, value: AnswerValue) => readonly string[];

/**
 * A numeric limit keyword: what of a value it measures, when it fails, and
 * what it requires. A value it cannot measure is outside its JSON type.
 */
interface LimitKeyword {
  readonly keyword: LimitKeywordName;
  readonly measure: (value: AnswerValue) => number | undefined;
  readonly fails: (measured: number, limit: number) => boolean;
  readonly requires: (limit: number) => string;
}

const ALLOWED_VALUES = "must be one of the allowed values";

/** Every JSON Schema check a form field's keywords make of an answer. */
const keywordChecks: readonly KeywordCheck[] = [
  typeIssues,
  limitIssues,
  formatIssues,
  enumIssues,
  oneOfIssues,
  itemIssues,
];

/** The limit keywords, each applying to one JSON type. */
const limitKeywords: readonly LimitKeyword[] = [
  {
    keyword: "minLength",
    measure: codePointLength,
    fails: below,
    requires: (limit) => `must have at least ${limit} characters`,
  },
  {
    keyword: "maxLength",
    measure: codePointLength,
    fails: above,
    requires: (limit) => `must have at most ${limit} characters`,
  },
  {
    keyword: "minimum",
    measure: numericValue,
    fails: below,
    requires: (limit) => `must be >= ${limit}`,
  },
  {
    keyword: "maximum",
    measure: numericValue,
    fails: above,
    requires: (limit) => `must be <= ${limit}`,
  },
  {
    keyword: "minItems",
    measure: itemCount,
    fails: below,
    requires: (limit) => `must have at least ${limit} items`,
  },
  {
    keyword: "maxItems",
    measure: itemCount,
    fails: above,
    requires: (limit) => `must have at most ${limit} items`,
  },
];

/**
 * Every failing keyword of one answer value. A titled single-select's value
 * must equal exactly one option, so options repeating a `const` admit
 * neither.
 * @param field The field's admitted property schema.
 * @param value The answer's value for the field.
 * @returns Each failing keyword with what it requires; empty when the value
 *   satisfies the field.
 */
export function answerIssues(
  field: FormField,
  value: AnswerValue,
): readonly string[] {
  return keywordChecks.flatMap((check) => check(field, value));
}

function typeIssues(field: FormField, value: AnswerValue): readonly string[] {
  return hasType(field, value) ? [] : [`type: must be ${field.type}`];
}

function hasType(field: FormField, value: AnswerValue): boolean {
  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function limitIssues(field: FormField, value: AnswerValue): readonly string[] {
  return limitKeywords.flatMap(({ keyword, measure, fails, requires }) => {
    const limit = limitOf(field, keyword);
    const measured = measure(value);
    return limit === undefined ||
      measured === undefined ||
      !fails(measured, limit)
      ? []
      : [`${keyword}: ${requires(limit)}`];
  });
}

function limitOf(
  field: FormField,
  keyword: LimitKeywordName,
): number | undefined {
  const limit = Predicate.hasProperty(field, keyword)
    ? field[keyword]
    : undefined;
  return typeof limit === "number" ? limit : undefined;
}

function formatIssues(field: FormField, value: AnswerValue): readonly string[] {
  if (
    typeof value !== "string" ||
    !("format" in field) ||
    field.format === undefined
  ) {
    return [];
  }
  return matchesFormat(field.format, value)
    ? []
    : [`format: must match format "${field.format}"`];
}

function enumIssues(field: FormField, value: AnswerValue): readonly string[] {
  return "enum" in field && !field.enum.some((allowed) => allowed === value)
    ? [`enum: ${ALLOWED_VALUES}`]
    : [];
}

function oneOfIssues(field: FormField, value: AnswerValue): readonly string[] {
  return "oneOf" in field &&
    field.oneOf.filter((option) => option.const === value).length !== 1
    ? ["oneOf: must equal exactly one option's const"]
    : [];
}

function itemIssues(field: FormField, value: AnswerValue): readonly string[] {
  if (typeof value !== "object" || !("items" in field)) {
    return [];
  }
  const { items } = field;
  return value.flatMap((item, index) => selectedItemIssues(items, item, index));
}

function selectedItemIssues(
  items: MultiSelectItems,
  item: string,
  index: number,
): readonly string[] {
  if ("enum" in items) {
    return items.enum.includes(item)
      ? []
      : [`items[${index}].enum: ${ALLOWED_VALUES}`];
  }
  return items.anyOf.some((option) => option.const === item)
    ? []
    : [`items[${index}].anyOf: must equal some option's const`];
}

/**
 * A string's length in Unicode code points, as JSON Schema counts it, so an
 * astral character such as an emoji counts once.
 */
function codePointLength(value: AnswerValue): number | undefined {
  return typeof value === "string" ? Array.from(value).length : undefined;
}

function numericValue(value: AnswerValue): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function itemCount(value: AnswerValue): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function below(measured: number, limit: number): boolean {
  return measured < limit;
}

function above(measured: number, limit: number): boolean {
  return measured > limit;
}
