import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";
import {
  type AppIdV4,
  localDaemonCommands,
  startParticipant,
  type StartTaskPartialFailure,
  startTaskCommandRpc,
  type StartTaskUsageError,
  type StartParticipant as StartParticipantType,
  type StartTaskCommandResult,
} from "../../local-daemon-rpc.js";
import { command, type Transport, type TransportError } from "../transport.js";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { optionsFromSchema } from "../adapters.js";

const EXIT_CODES = {
  SUCCESS: 0,
  TASK_CREATE_FAILED: 1,
  PARTIAL_SUCCESS: 2,
  USAGE_ERROR: 64,
} as const;

/** Describes start command args. */
export interface StartCommandArgs {
  readonly name: string;
  readonly participants: readonly StartParticipantType[];
  readonly message?: string;
  readonly appId?: AppIdV4;
}

type StartCommandError = TransportError;

interface StartCommandParsed {
  readonly name: string;
  readonly participants: StartParticipantType[];
  readonly options: Schema.Schema.Type<typeof startOptionsSchema>;
}

const startMessage = (outcome: {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly reusedConversation: boolean;
}): string =>
  outcome.reusedConversation
    ? `Task started: ${outcome.taskId} (reusing existing conversation: ${outcome.conversationId})`
    : `Task started: ${outcome.taskId} (conversation: ${outcome.conversationId})`;

const logStartResult = (result: StartTaskCommandResult): Effect.Effect<void> =>
  Effect.zipRight(
    Effect.log(startMessage(result)),
    result.sentMessageId === undefined
      ? Effect.void
      : Effect.log(`Message sent: ${result.sentMessageId}`),
  );

const startCommandHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, StartCommandError, Transport> =>
  command(localDaemonCommands.startTask, {
    name: args.name,
    participants: args.participants,
    ...(args.message === undefined ? {} : { message: args.message }),
    ...(args.appId === undefined ? {} : { appId: args.appId }),
  }).pipe(
    Effect.flatMap(logStartResult),
    Effect.withSpan("startCommandHandler"),
  );

const runStartCommand = (
  effect: Effect.Effect<void, StartCommandError, Transport>,
): Effect.Effect<void, never, Transport> =>
  effect.pipe(
    Effect.catchTags({
      StartTaskUsageError: (err: StartTaskUsageError) =>
        Effect.logError(err.message).pipe(
          Effect.zipRight(
            Effect.sync(() => process.exit(EXIT_CODES.USAGE_ERROR)),
          ),
        ),
      StartTaskPartialFailure: (err: StartTaskPartialFailure) =>
        Effect.zipRight(
          Effect.log(startMessage(err)),
          Effect.logError(`Error sending message: ${err.message}`).pipe(
            Effect.zipRight(
              Effect.sync(() => process.exit(EXIT_CODES.PARTIAL_SUCCESS)),
            ),
          ),
        ),
    }),
    Effect.catchAll((err) => {
      const msg =
        err.message !== undefined && err.message !== ""
          ? err.message
          : err._tag;
      return Effect.logError(`Failed: ${msg}`).pipe(
        Effect.zipRight(
          Effect.sync(() => process.exit(EXIT_CODES.TASK_CREATE_FAILED)),
        ),
      );
    }),
  );

const nameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Conversation name"),
);

const participantsArg = Args.text({ name: "participant" }).pipe(
  Args.withSchema(startParticipant),
  Args.withDescription("Participant token (for example agent:bob)."),
  Args.repeated,
);

const startOptionsSchema = startTaskCommandRpc.payloadSchema.pipe(
  Schema.omit("name", "participants"),
);
/** Provides the start options runtime value. */
export const startOptions = optionsFromSchema(startOptionsSchema, {
  message: { description: "First message body" },
  appId: { description: "App UUID v4. Defaults to the MoltZap app." },
});

/**
 * Provides the run start handler runtime value.
 * @param args Value supplied to the operation.
 * @returns The run start handler result.
 */
export const runStartHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, never, Transport> =>
  runStartCommand(startCommandHandler(args));

/** Provides the start command runtime value. */
export const startCommand: Command.Command<
  "start",
  Transport,
  never,
  StartCommandParsed
> = Command.make(
  "start",
  {
    name: nameArg,
    participants: participantsArg,
    options: startOptions,
  },
  ({ name, participants, options }) =>
    runStartHandler({
      name,
      participants,
      message: options.message,
      appId: options.appId,
    }),
).pipe(
  Command.withDescription(
    "Start a task with named participants and optionally send the first message.\n" +
      "\n" +
      "Exit codes:\n" +
      `  ${EXIT_CODES.SUCCESS}   success\n` +
      `  ${EXIT_CODES.TASK_CREATE_FAILED}   task creation or lookup failed\n` +
      `  ${EXIT_CODES.PARTIAL_SUCCESS}   task started, first message failed\n` +
      `  ${EXIT_CODES.USAGE_ERROR}  usage error`,
  ),
);
