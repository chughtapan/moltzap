/** @file In-process Effect agents connected through the production protocol. */

import { MoltZapAgentClient } from "@moltzap/client";
import {
  type AgentRuntime,
  type AgentRuntimeInput,
  RuntimeCompleted,
  RuntimeFailed,
  type RuntimeTermination,
  defineRuntime,
} from "./runtime.js";
import type { AgentHandle } from "../network/participant.js";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
  type Message,
  type MessageParts,
  type MessageReceivedNotification,
} from "@moltzap/protocol/message";
import { httpBaseUrl } from "@moltzap/protocol/network";
import type { TaskId } from "@moltzap/protocol/task";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Schema,
  type Scope,
  Stream,
} from "effect";

const EFFECT_RUNTIME_NAME = "effect";
const DEFAULT_STARTUP_TIMEOUT = Duration.seconds(10);

/** Acquisition failed before an in-process agent became router-visible. */
export class EffectRuntimeStartFailed extends Schema.TaggedError<EffectRuntimeStartFailed>()(
  "EffectRuntimeStartFailed",
  {
    agent: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Effect runtime for "${this.agent}" failed to start: ${this.detail}`;
  }
}

/** Message delivery context passed to ordinary Effect agent code. */
export interface EffectMessageContext {
  readonly agent: AgentHandle;
  readonly taskId: TaskId;
  readonly message: Message;
}

/** A message handler reply containing text or structured parts. */
export type EffectMessageReply = string | MessageParts;

/** Construction options owned by one in-process runtime implementation. */
export interface EffectRuntimeOptions<E = never, R = never> {
  readonly startupTimeout?: Duration.Duration;
  readonly onMessage?: (
    context: EffectMessageContext,
  ) => Effect.Effect<EffectMessageReply | undefined, E, R>;
}

/** Sanitized definition-time policy and defaults for an Effect runtime. */
export class EffectRuntimeConfiguration extends Schema.Class<EffectRuntimeConfiguration>(
  "EffectRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
  messageHandlerPolicy: Schema.Literal("default", "custom"),
}) {}

interface EffectRuntimeState {
  readonly client: MoltZapAgentClient;
  readonly termination: Deferred.Deferred<RuntimeTermination>;
}

function startFailure(
  input: AgentRuntimeInput<string>,
  cause: unknown,
): EffectRuntimeStartFailed {
  return EffectRuntimeStartFailed.make({
    agent: input.connection.agent.name,
    detail: String(cause),
  });
}

function replyParts(reply: EffectMessageReply): MessageParts {
  return typeof reply === "string" ? [{ type: "text", text: reply }] : reply;
}

function sendReply(
  client: MoltZapAgentClient,
  incoming: MessageReceivedNotification,
  reply?: EffectMessageReply,
) {
  if (reply === undefined) {
    return Effect.void;
  }
  const parts = replyParts(reply);
  return client
    .callDefinition(messagesSend, {
      taskId: incoming.taskId,
      conversationId: incoming.message.conversationId,
      parts,
      replyToId: incoming.message.id,
    })
    .pipe(Effect.asVoid);
}

function handleMessage<E, R>(
  input: AgentRuntimeInput<string>,
  client: MoltZapAgentClient,
  onMessage: NonNullable<EffectRuntimeOptions<E, R>["onMessage"]>,
  incoming: MessageReceivedNotification,
) {
  return onMessage({
    agent: input.connection.agent,
    taskId: incoming.taskId,
    message: incoming.message,
  }).pipe(Effect.flatMap((reply) => sendReply(client, incoming, reply)));
}

function completeTermination(
  state: EffectRuntimeState,
  termination: RuntimeTermination,
): Effect.Effect<void> {
  return Deferred.succeed(state.termination, termination).pipe(Effect.asVoid);
}

function receiverFailed(
  state: EffectRuntimeState,
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> {
  if (Cause.isInterruptedOnly(cause)) {
    return Effect.void;
  }
  return completeTermination(
    state,
    RuntimeFailed.make({ detail: Cause.pretty(cause) }),
  ).pipe(Effect.zipRight(state.client.close()));
}

function receiverCompleted(state: EffectRuntimeState): Effect.Effect<void> {
  return completeTermination(state, RuntimeCompleted.make({})).pipe(
    Effect.zipRight(state.client.close()),
  );
}

function receiveMessages<E, R>(
  input: AgentRuntimeInput<string>,
  state: EffectRuntimeState,
  onMessage: NonNullable<EffectRuntimeOptions<E, R>["onMessage"]>,
  received: Stream.Stream<MessageReceivedNotification, unknown>,
): Effect.Effect<void, never, R> {
  return received.pipe(
    Stream.runForEach((incoming) =>
      handleMessage(input, state.client, onMessage, incoming),
    ),
    Effect.matchCauseEffect({
      onFailure: (cause) => receiverFailed(state, cause),
      onSuccess: () => receiverCompleted(state),
    }),
  );
}

function startupEnded(
  input: AgentRuntimeInput<string>,
  termination: Deferred.Deferred<RuntimeTermination>,
): Effect.Effect<never, EffectRuntimeStartFailed> {
  return Deferred.await(termination).pipe(
    Effect.flatMap((observed) =>
      Effect.fail(
        startFailure(
          input,
          `receiver terminated during startup (${observed._tag})`,
        ),
      ),
    ),
  );
}

function awaitStartup(
  input: AgentRuntimeInput<string>,
  state: EffectRuntimeState,
  startupTimeout: Duration.Duration,
): Effect.Effect<void, EffectRuntimeStartFailed> {
  const connectAndBecomeVisible = Effect.all(
    [state.client.connect(), input.connection.awaitReady(startupTimeout)],
    { concurrency: 2, discard: true },
  ).pipe(Effect.mapError((cause) => startFailure(input, cause)));
  return Effect.raceFirst(
    connectAndBecomeVisible,
    startupEnded(input, state.termination),
  );
}

function acquireEffectRuntime<E, R>(
  options: EffectRuntimeOptions<E, R>,
  input: AgentRuntimeInput<string>,
): Effect.Effect<
  { readonly termination: Effect.Effect<RuntimeTermination> },
  EffectRuntimeStartFailed,
  Scope.Scope | R
> {
  return Effect.gen(function* () {
    const client = yield* Effect.try({
      try: () =>
        new MoltZapAgentClient({
          serverUrl: httpBaseUrl(input.connection.routerUrl),
          agentKey: input.connection.key,
        }),
      catch: (cause) => startFailure(input, cause),
    });
    const received = yield* client.subscribeScoped(
      messageReceivedNotificationDefinition,
    );
    const state: EffectRuntimeState = {
      client,
      termination: yield* Deferred.make<RuntimeTermination>(),
    };
    yield* Effect.addFinalizer(() => client.close());
    const onMessage =
      options.onMessage ?? (() => Effect.void.pipe(Effect.as(undefined)));
    yield* receiveMessages(input, state, onMessage, received).pipe(
      Effect.forkScoped,
    );
    yield* awaitStartup(
      input,
      state,
      options.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT,
    );
    return {
      termination: Deferred.await(state.termination),
    };
  }).pipe(Effect.withSpan("effectRuntime.acquire"));
}

function snapshotOptions<E, R>(
  options: EffectRuntimeOptions<E, R>,
): EffectRuntimeOptions<E, R> {
  const startupTimeout = options.startupTimeout;
  const onMessage = options.onMessage;
  return Object.freeze({
    ...(startupTimeout === undefined ? {} : { startupTimeout }),
    ...(onMessage === undefined ? {} : { onMessage }),
  });
}

/**
 * Create a scoped in-process agent that communicates exclusively through the
 * production MoltZap protocol.
 * @param options Runtime-owned startup and message behavior.
 * @returns Autonomous runtime backed by in-process Effect behavior.
 */
export function effectRuntime<E = never, R = never>(
  options: EffectRuntimeOptions<E, R> = {},
): AgentRuntime<
  EffectRuntimeStartFailed,
  R,
  typeof EffectRuntimeConfiguration
> {
  const capturedOptions = snapshotOptions(options);
  return defineRuntime({
    name: EFFECT_RUNTIME_NAME,
    configuration: {
      schema: EffectRuntimeConfiguration,
      value: EffectRuntimeConfiguration.make({
        startupTimeout:
          capturedOptions.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT,
        messageHandlerPolicy:
          capturedOptions.onMessage === undefined ? "default" : "custom",
      }),
    },
    acquire: (input) => acquireEffectRuntime(capturedOptions, input),
  });
}
