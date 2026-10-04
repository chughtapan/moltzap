/**
 * @file Reads the operation a message's text states.
 *
 * In native hosts, a model reaches every operation through the ordinary
 * message tool, as message text. The OpenClaw and NanoClaw adapters use
 * {@link parseMessageText}, so both hosts accept the same text:
 *
 * ```
 * plain text                                                   multicast
 * {"gather": "Which day?", "deadline": 600, "requestedSchema": {...}}
 * {"all_gather": "Which day?", "deadline": 600, "requestedSchema": {...}}
 * {"action": "accept", "content": {...}}                        answer
 * {"action": "decline"}                                         answer
 * ```
 *
 * Only a whole text that is a JSON object with a `gather`, `all_gather` or
 * `action` key states an operation; any other text, JSON-looking prose
 * included, is a multicast of that text. A text that states an operation but
 * fails validation is refused, never sent as text, because the model meant
 * the operation and the error names the field to fix.
 */

import { Data, Either, Option, ParseResult, Predicate, Schema } from "effect";
import { exactStruct, type MessageAddressInput } from "../wire/values.js";
import {
  AnswerContent,
  type CollectiveResponse,
  DeadlineSeconds,
  RequestedSchema,
  SendInput,
} from "./forms.js";

/* eslint-disable @typescript-eslint/naming-convention -- Effect Schemas are named for the text shapes they decode. */

/** Which operation a refused text stated. */
type StatedOperation = "message" | "gather" | "all_gather" | "answer";

/**
 * A message text states an operation it does not validly carry, or is plain
 * text that is not well-formed Unicode. The message names each failing field
 * so a host can hand it to its model as the tool error.
 */
export class MessageTextError extends Data.TaggedError("MessageTextError")<{
  readonly operation: StatedOperation;
  readonly detail: string;
}> {
  override get message(): string {
    return `${this.operation} not sent: ${this.detail}`;
  }
}

const GatherText = exactStruct({
  gather: Schema.String,
  deadline: DeadlineSeconds,
  requestedSchema: RequestedSchema,
});

const AllGatherText = exactStruct({
  all_gather: Schema.String,
  deadline: DeadlineSeconds,
  requestedSchema: RequestedSchema,
});

const AcceptText = exactStruct({
  action: Schema.Literal("accept"),
  content: AnswerContent,
});

const DeclineText = exactStruct({
  action: Schema.Literal("decline"),
});

/** The `action` key alone, so an unknown action is named as that field. */
const AnswerAction = Schema.Struct({
  action: Schema.Literal("accept", "decline"),
});

const decodeJsonText = Schema.decodeUnknownOption(
  Schema.parseJson(Schema.Unknown),
);

/** The JSON object a whole text is, if it is one. */
const jsonObject = (text: string) =>
  decodeJsonText(text).pipe(Option.filter(Predicate.isRecord));

/**
 * Read one message text as the send it states.
 * @param to The address the host's tool call names: the recipients of a
 *   multicast, gather or all_gather, or for an answer the conversation whose
 *   open request it answers.
 * @param text The whole text of the message.
 * @returns The send input, or an error naming each field a stated operation
 *   gets wrong.
 */
export const parseMessageText = (
  to: MessageAddressInput,
  text: string,
): Either.Either<SendInput, MessageTextError> =>
  Option.match(jsonObject(text), {
    onNone: () => sendInput("message", { to, text }),
    onSome: (value) =>
      statedOperation(to, value) ?? sendInput("message", { to, text }),
  });

/**
 * The operation a JSON object states by its key, or undefined when it has
 * none of `gather`, `all_gather` and `action` and so is plain text.
 */
function statedOperation(
  to: MessageAddressInput,
  value: Readonly<Record<string, unknown>>,
): Either.Either<SendInput, MessageTextError> | undefined {
  if (Object.hasOwn(value, "gather")) {
    return decodeText("gather", GatherText, value).pipe(
      Either.flatMap((stated) =>
        sendInput("gather", {
          to,
          text: stated.gather,
          collective: { ...collecting(stated), op: "gather" },
        }),
      ),
    );
  }
  if (Object.hasOwn(value, "all_gather")) {
    return decodeText("all_gather", AllGatherText, value).pipe(
      Either.flatMap((stated) =>
        sendInput("all_gather", {
          to,
          text: stated.all_gather,
          collective: { ...collecting(stated), op: "all_gather" },
        }),
      ),
    );
  }
  return Object.hasOwn(value, "action") ? answer(to, value) : undefined;
}

function collecting(
  stated: typeof GatherText.Type | typeof AllGatherText.Type,
) {
  return { deadline: stated.deadline, requestedSchema: stated.requestedSchema };
}

/** An answer: `action` decides which shape the rest must have. */
function answer(
  to: MessageAddressInput,
  value: Readonly<Record<string, unknown>>,
): Either.Either<SendInput, MessageTextError> {
  return decodeText("answer", AnswerAction, value).pipe(
    Either.flatMap(
      ({ action }): Either.Either<CollectiveResponse, MessageTextError> =>
        action === "accept"
          ? decodeText("answer", AcceptText, value)
          : decodeText("answer", DeclineText, value),
    ),
    Either.flatMap((collectiveResponse) =>
      sendInput("answer", { to, collectiveResponse }),
    ),
  );
}

function sendInput(
  operation: StatedOperation,
  value: unknown,
): Either.Either<SendInput, MessageTextError> {
  return decodeText(operation, SendInput, value);
}

function decodeText<A, I>(
  operation: StatedOperation,
  schema: Schema.Schema<A, I>,
  value: unknown,
): Either.Either<A, MessageTextError> {
  return Schema.decodeUnknownEither(schema, { errors: "all" })(value).pipe(
    Either.mapLeft(
      (error) =>
        new MessageTextError({ operation, detail: describeIssues(error) }),
    ),
  );
}

/**
 * One line per issue, each led by its field path, such as
 * `requestedSchema.type: Expected "object", actual "obj"`.
 */
function describeIssues(error: ParseResult.ParseError): string {
  return ParseResult.ArrayFormatter.formatErrorSync(error)
    .map(({ path, message }) =>
      path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`,
    )
    .join("; ");
}

/* eslint-enable @typescript-eslint/naming-convention -- Restore the package naming rules after the text Schemas. */
