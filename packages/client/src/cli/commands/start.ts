import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import {
  AppIdV4,
  LocalDaemonCommands,
  StartParticipant,
  StartTaskPartialFailure,
  StartTaskUsageError,
  type StartParticipant as StartParticipantType,
  type StartTaskCommandResult,
} from "../../local-daemon-rpc.js";
import { command, type Transport, type TransportError } from "../transport.js";

const EXIT_CODES = {
  SUCCESS: 0,
  TASK_CREATE_FAILED: 1,
  PARTIAL_SUCCESS: 2,
  USAGE_ERROR: 64,
} as const;

export interface StartCommandArgs {
  readonly name: string;
  readonly participants: readonly StartParticipantType[];
  readonly message: string | undefined;
  readonly appId: AppIdV4 | undefined;
}

type StartCommandError = TransportError;

type StartCommandParsed = {
  readonly name: string;
  readonly participants: StartParticipantType[];
  readonly message: Option.Option<string>;
  readonly appId: Option.Option<AppIdV4>;
};

const startMessage = (result: StartTaskCommandResult): string =>
  result.reusedConversation
    ? `Task started: ${result.taskId} (reusing existing conversation: ${result.conversationId})`
    : `Task started: ${result.taskId} (conversation: ${result.conversationId})`;

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
  command(LocalDaemonCommands.StartTask, {
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
    Effect.catchTag("StartTaskUsageError", (err: StartTaskUsageError) =>
      Effect.logError(err.message).pipe(
        Effect.zipRight(
          Effect.sync(() => process.exit(EXIT_CODES.USAGE_ERROR)),
        ),
      ),
    ),
    Effect.catchTag("StartTaskPartialFailure", (err: StartTaskPartialFailure) =>
      Effect.zipRight(
        Effect.log(
          err.reusedConversation
            ? `Task started: ${err.taskId} (reusing existing conversation: ${err.conversationId})`
            : `Task started: ${err.taskId} (conversation: ${err.conversationId})`,
        ),
        Effect.logError(`Error sending message: ${err.message}`).pipe(
          Effect.zipRight(
            Effect.sync(() => process.exit(EXIT_CODES.PARTIAL_SUCCESS)),
          ),
        ),
      ),
    ),
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
  Args.withSchema(StartParticipant),
  Args.withDescription("Participant token (for example agent:bob)."),
  Args.repeated,
);

const messageOption = Options.text("message").pipe(
  Options.withDescription("First message body"),
  Options.optional,
);

const appIdOption = Options.text("app-id").pipe(
  Options.withSchema(AppIdV4),
  Options.withDescription("App UUID v4. Defaults to the MoltZap app."),
  Options.optional,
);

export const runStartHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, never, Transport> =>
  runStartCommand(startCommandHandler(args));

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
    message: messageOption,
    appId: appIdOption,
  },
  ({ name, participants, message, appId }) =>
    runStartHandler({
      name,
      participants,
      message: Option.getOrUndefined(message),
      appId: Option.getOrUndefined(appId),
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
