/**
 * @file Answer validation against a collective request's form-mode schema.
 *
 * Validation runs field by field with the MCP SDK's JSON Schema validator so
 * a failure names each failing field rather than one combined message. The
 * form-mode grammar is flat, so a field's property schema is the whole rule
 * for that field.
 */

import {
  fromJsonSchema,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Data, Effect } from "effect";
import type { AnswerContent, CollectiveFailure } from "./forms.js";
import type { CollectiveMemberOutcome } from "./inbound.js";
import type { CollectiveResponse, FormModeSchema } from "./wire.js";

/**
 * Why one answer field failed its request's schema; `detail` is the SDK
 * validator's message for an `invalid` field.
 */
export type CollectiveFieldFailure = Extract<
  CollectiveFailure,
  { readonly kind: "answer-invalid" }
>["fields"][number];

/** An answer does not satisfy its request's `requestedSchema`. */
export class CollectiveAnswerInvalidError extends Data.TaggedError(
  "CollectiveAnswerInvalidError",
)<{
  readonly failures: readonly [
    CollectiveFieldFailure,
    ...CollectiveFieldFailure[],
  ];
}> {
  override get message(): string {
    return this.failures
      .map((failure) =>
        failure.detail === undefined
          ? `${failure.field}: ${failure.reason}`
          : `${failure.field}: ${failure.reason} (${failure.detail})`,
      )
      .join("; ");
  }
}

/**
 * Field names come from peers, so a lookup ignores the prototype chain: an
 * answer field named `constructor` must not find `Object.prototype.constructor`.
 */
const ownValue = <Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Value | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

function fieldFailure(
  validator: jsonSchemaValidator,
  requestedSchema: FormModeSchema,
  content: AnswerContent,
  field: string,
): CollectiveFieldFailure | undefined {
  const definition = ownValue(requestedSchema.properties, field);
  if (definition === undefined) {
    return { field, reason: "unexpected" };
  }
  const value = ownValue(content, field);
  if (value === undefined) {
    return requestedSchema.required?.includes(field) === true
      ? { field, reason: "missing" }
      : undefined;
  }
  const result = fromJsonSchema(definition, validator)["~standard"].validate(
    value,
  );
  if (result instanceof Promise) {
    return { field, reason: "invalid", detail: "asynchronous validator" };
  }
  const detail = result.issues?.map((issue) => issue.message).join(", ");
  return detail === undefined
    ? undefined
    : { field, reason: "invalid", detail };
}

/**
 * Check an answer against the schema its request carried. Each call compiles
 * with its own validator: the SDK's shared default caches every compiled
 * schema for the life of the process, and request schemas are unbounded.
 * @param requestedSchema The request's form-mode schema.
 * @param content The member's answer.
 * @returns The answer unchanged, or an error naming every failing field.
 */
export const validateAnswer = (
  requestedSchema: FormModeSchema,
  content: AnswerContent,
): Effect.Effect<AnswerContent, CollectiveAnswerInvalidError> => {
  const fields = new Set([
    ...Object.keys(requestedSchema.properties),
    ...Object.keys(content),
  ]);
  const validator = new AjvJsonSchemaValidator();
  const [first, ...rest] = [...fields].flatMap((field) => {
    const failure = fieldFailure(validator, requestedSchema, content, field);
    return failure === undefined ? [] : [failure];
  });
  return first === undefined
    ? Effect.succeed(content)
    : Effect.fail(
        new CollectiveAnswerInvalidError({ failures: [first, ...rest] }),
      );
};

/**
 * Record a received response as the member's outcome. An `accept` whose content
 * fails the request's schema is recorded as invalid rather than rejected.
 * @param requestedSchema The schema the request carried.
 * @param response The member's decoded response.
 * @returns The member's outcome.
 */
export const outcomeOfResponse = (
  requestedSchema: FormModeSchema,
  response: CollectiveResponse,
): Effect.Effect<CollectiveMemberOutcome> => {
  switch (response.action) {
    case "accept":
      return validateAnswer(requestedSchema, response.content).pipe(
        Effect.match({
          onFailure: (error): CollectiveMemberOutcome => ({
            kind: "invalid",
            reason: error.message,
          }),
          onSuccess: (content): CollectiveMemberOutcome => ({
            kind: "answered",
            content,
          }),
        }),
      );
    case "decline":
      return Effect.succeed({ kind: "declined" });
    default: {
      const exhaustive: never = response;
      return exhaustive;
    }
  }
};
