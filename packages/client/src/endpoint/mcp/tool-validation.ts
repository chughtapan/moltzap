/** @file Read-only SDK validation stays separate from Effect-owned persistence. */

import {
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaV1,
} from "@modelcontextprotocol/server";
import { Effect } from "effect";

/* eslint-disable agent-code-guard/async-keyword -- Standard Schema validation is Promise-capable at the official SDK edge. */

/** Argument validation follows the SDK's Standard Schema contract. */
// #ignore-sloppy-code-next-line[async-keyword]: The pinned SDK validates through a Promise-capable Standard Schema method.
export const decodeToolInput = async <Value>(
  schema: StandardSchemaV1<unknown, Value>,
  value: unknown,
  toolName: string,
) => {
  const decoded = await schema["~standard"].validate(value);
  if (!("value" in decoded)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid arguments for tool ${toolName}`,
    );
  }
  return decoded.value;
};

const validationFailure = (cause: unknown): ProtocolError =>
  ProtocolError.isInstance(cause)
    ? cause
    : new ProtocolError(
        ProtocolErrorCode.InternalError,
        "Tool validation failed",
      );

/** Effect callers own validation cancellation without starting a persistence fiber. */
export const decodeToolInputEffect = <Value>(
  schema: StandardSchemaV1<unknown, Value>,
  value: unknown,
  toolName: string,
) =>
  Effect.tryPromise({
    try: () => decodeToolInput(schema, value, toolName),
    catch: validationFailure,
  });

/** Results retain their canonical content after read-only SDK validation. */
// #ignore-sloppy-code-next-line[async-keyword]: MCP consumes Standard Schema's Promise-capable output validation at its transport boundary.
export const validateToolOutput = async <
  Value,
  Result extends Readonly<{ structuredContent: Value }>,
>(
  schema: StandardSchemaV1<unknown, Value>,
  result: Result,
  toolName: string,
) => {
  const decoded = await schema["~standard"].validate(result.structuredContent);
  if (!("value" in decoded)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid result from tool ${toolName}`,
    );
  }
  return result;
};

/** Validation may cross into Promises; business operations stay in the caller's fiber. */
export const validateToolOutputEffect = <
  Value,
  Result extends Readonly<{ structuredContent: Value }>,
>(
  schema: StandardSchemaV1<unknown, Value>,
  result: Result,
  toolName: string,
) =>
  Effect.tryPromise({
    try: () => validateToolOutput(schema, result, toolName),
    catch: validationFailure,
  });

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults. */
