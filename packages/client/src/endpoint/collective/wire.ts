/**
 * @file Collective-layer values carried inside a certified post's content.
 *
 * A collective value travels as one `data` part whose value is an object with
 * the key `COLLECTIVE_DATA_KEY`. `Content` stays a generic container; only
 * endpoints read the part, and the Router sees only the envelope. Every value
 * carries a `kind` discriminant so an endpoint classifies a part without trying
 * each shape in turn.
 */

import {
  type PrimitiveSchemaDefinition as McpPrimitiveSchemaDefinition,
  specTypeSchemas,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Data, Effect, Option, ParseResult, Schema } from "effect";
import { createHash } from "node:crypto";
import {
  type AgentAddress,
  AnswerContent,
  CollectiveId,
} from "../../contract.js";
import { Content, exactStruct, RecordHash } from "../representation.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the values they decode. */

type PostContent = typeof Content.Type;

/** The `data` part key under which the collective layer carries its value. */
export const COLLECTIVE_DATA_KEY = "xyz.moltzap/collective";

const mcpPrimitiveSchemaDefinition =
  specTypeSchemas.PrimitiveSchemaDefinition["~standard"];

const McpPrimitiveSchema = Schema.declare(
  (value): value is McpPrimitiveSchemaDefinition =>
    mcpPrimitiveSchemaDefinition.validate(value).issues === undefined,
  { identifier: "PrimitiveSchemaDefinition" },
);

/**
 * One property of an MCP form-mode `requestedSchema`, as the MCP SDK's
 * `PrimitiveSchemaDefinition` accepts it. Decoding keeps the SDK's parsed
 * value, so keywords outside the form-mode grammar never travel or reach
 * answer validation. The SDK grammar admits some schemas its own validator
 * cannot compile, such as an empty `enum`; decoding compiles each property
 * so answer validation never meets one.
 */
const PrimitiveSchemaDefinition = Schema.transformOrFail(
  Schema.Unknown,
  McpPrimitiveSchema,
  {
    strict: true,
    decode: (value) => {
      const result = mcpPrimitiveSchemaDefinition.validate(value);
      const invalid = (message: string) =>
        new ParseResult.Type(McpPrimitiveSchema.ast, value, message);
      if (result.issues !== undefined) {
        return ParseResult.fail(
          invalid("not an MCP form-mode primitive schema"),
        );
      }
      const definition = result.value;
      return ParseResult.try({
        try: () => {
          new AjvJsonSchemaValidator().getValidator(definition);
          return definition;
        },
        catch: () => invalid("not a compilable form-mode primitive schema"),
      });
    },
    encode: (definition) => ParseResult.succeed(definition),
  },
);

/**
 * The MCP form-mode `requestedSchema`: a flat object of primitive properties.
 * Every `required` name must be a declared property, since an answer can carry
 * no other field.
 */
export const FormModeSchema = exactStruct({
  $schema: Schema.optional(Schema.String),
  type: Schema.Literal("object"),
  properties: Schema.Record({
    key: Schema.String,
    value: PrimitiveSchemaDefinition,
  }),
  required: Schema.optional(Schema.Array(Schema.String)),
}).pipe(
  Schema.filter(
    (schema) =>
      (schema.required ?? []).every((name) =>
        Object.hasOwn(schema.properties, name),
      ),
    {
      identifier: "RequestedSchema",
      description: "Form-mode schema whose required names are properties",
    },
  ),
);
/** A validated form-mode schema for one collective question. */
export type FormModeSchema = typeof FormModeSchema.Type;

/** 32 random bytes in base64url, which a requester binds its collective id to. */
const CollectiveNonce = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/),
);

const decodeCollectiveId = Schema.decodeUnknownSync(CollectiveId);

/**
 * The collective id a requester's nonce names: `col_` and the base64url
 * SHA-256 of a domain tag, the requester's address and the nonce. A member
 * accepts a request only when its id derives from the request's certified
 * sender, so no agent can reuse an id another requester minted.
 * @param requester The agent that minted the id.
 * @param nonce The request's nonce.
 * @returns The id the pair names.
 */
export const collectiveIdOf = (
  requester: AgentAddress,
  nonce: string,
): CollectiveId =>
  decodeCollectiveId(
    `col_${createHash("sha256")
      .update(`xyz.moltzap/collective-id\0${requester}\0${nonce}`)
      .digest("base64url")}`,
  );

/** A plain post: multicast carries neither a deadline nor a schema. */
const MulticastOperation = exactStruct({
  kind: Schema.Literal("operation"),
  op: Schema.Literal("multicast"),
});

/**
 * A question to every member. `id` derives from the requester and `nonce`
 * through `collectiveIdOf`. `deadlineAt` is absolute epoch milliseconds: the
 * sending endpoint converts the model's relative duration at send, and
 * endpoints assume zero clock skew.
 */
const CollectingOperation = exactStruct({
  kind: Schema.Literal("operation"),
  op: Schema.Literal("gather", "all_gather"),
  id: CollectiveId,
  nonce: CollectiveNonce,
  deadlineAt: Schema.Int.pipe(Schema.positive()),
  requestedSchema: FormModeSchema,
});

/** A member's reply to one request; only `accept` carries content. */
const CollectiveResponse = Schema.Union(
  exactStruct({
    kind: Schema.Literal("response"),
    id: CollectiveId,
    action: Schema.Literal("accept"),
    content: AnswerContent,
  }),
  exactStruct({
    kind: Schema.Literal("response"),
    id: CollectiveId,
    action: Schema.Literal("decline", "cancel"),
  }),
);
/** A validated collective response. */
export type CollectiveResponse = typeof CollectiveResponse.Type;

/** The requester's all_gather close: the included answers by certified record hash. */
const CollectiveClose = exactStruct({
  kind: Schema.Literal("close"),
  id: CollectiveId,
  included: Schema.Array(RecordHash),
});

/** Every value the collective layer carries, discriminated by `kind`. */
const CollectiveValue = Schema.Union(
  MulticastOperation,
  CollectingOperation,
  CollectiveResponse,
  CollectiveClose,
);
/** A validated collective value. */
export type CollectiveValue = typeof CollectiveValue.Type;

/** Content carries a collective part that is duplicated or does not decode. */
export class CollectivePartInvalidError extends Data.TaggedError(
  "CollectivePartInvalidError",
)<{
  readonly reason: "duplicate" | "malformed";
}> {}

/** A collective value and its text do not form content within the 32,768-byte canonical limit. */
export class CollectiveContentError extends Data.TaggedError(
  "CollectiveContentError",
) {}

/**
 * Any object value that carries the collective key; other keys are ignored.
 * `exact` keeps a missing key from decoding as `undefined`.
 */
const CollectiveCarrier = Schema.Struct({
  [COLLECTIVE_DATA_KEY]: Schema.Unknown,
}).annotations({ parseOptions: { exact: true } });

function collectivePartValue(
  part: PostContent[number],
): Option.Option<unknown> {
  return part.type === "data"
    ? Schema.decodeUnknownOption(CollectiveCarrier)(part.value).pipe(
        Option.map((carrier) => carrier[COLLECTIVE_DATA_KEY]),
      )
    : Option.none();
}

/**
 * Remove the collective part from post content, keeping every other part in
 * order.
 * @param content Certified post content.
 * @returns The remaining parts, empty when the collective part was the only one.
 */
export const withoutCollectivePart = (
  content: PostContent,
): ReadonlyArray<PostContent[number]> =>
  content.filter((part) => Option.isNone(collectivePartValue(part)));

/**
 * Decode one untrusted collective value.
 * @param value The value found under `COLLECTIVE_DATA_KEY`.
 * @returns The validated value.
 */
export const decodeCollectiveValue = Schema.decodeUnknown(CollectiveValue);

/**
 * Decode one untrusted collective response.
 * @param value A member's response as it arrives.
 * @returns The validated response.
 */
export const decodeCollectiveResponse =
  Schema.decodeUnknown(CollectiveResponse);

/**
 * Find and decode the collective value in one post's content.
 * @param content Certified post content.
 * @returns The decoded value, or none when the content carries no collective part.
 */
export const readCollectiveValue = (
  content: PostContent,
): Effect.Effect<
  Option.Option<CollectiveValue>,
  CollectivePartInvalidError
> => {
  const [only, ...rest] = content.flatMap((part) =>
    Option.toArray(collectivePartValue(part)),
  );
  if (only === undefined) {
    return Effect.succeed(Option.none());
  }
  if (rest.length > 0) {
    return Effect.fail(new CollectivePartInvalidError({ reason: "duplicate" }));
  }
  return decodeCollectiveValue(only).pipe(
    Effect.map(Option.some),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CollectivePartInvalidError({ reason: "malformed" })),
    ),
  );
};

/**
 * Build post content from a collective value and optional message text. The
 * public `Content` schema applies the one canonical size limit.
 * @param value The collective value to carry in the data part.
 * @param text The message body; for gather and all_gather, the question.
 * @returns Content with the text first and the collective part last.
 */
export const encodeCollectiveContent = (
  value: CollectiveValue,
  text?: string,
): Effect.Effect<PostContent, CollectiveContentError> =>
  Schema.encode(CollectiveValue)(value).pipe(
    Effect.flatMap((encoded) =>
      Schema.decodeUnknown(Content)([
        ...(text === undefined ? [] : [{ type: "text", text }]),
        { type: "data", value: { [COLLECTIVE_DATA_KEY]: encoded } },
      ]),
    ),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CollectiveContentError()),
    ),
  );

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
