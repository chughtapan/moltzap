import { Path } from "@effect/platform";
import { Data, Duration, Effect, Fiber, Option, Stream } from "effect";
import { startRuntimeAgent, type RuntimeKind } from "./fleet.js";
import { RuntimeReadyTimedOut, SpawnFailed } from "./errors.js";
import type { Runtime } from "./runtime.js";
import {
  decodePayload,
  InvalidPayload,
  RUNTIME_KIND_CLAUDE_CODE,
  type HarnessPayload,
} from "./trace-capture-payload.js";
import {
  buildTraceBundle,
  type ConversationParticipant,
  type ConversationResponse,
  type ConversationRun,
  type TraceCaptureEvent,
} from "./trace-capture-bundle.js";

import {
  type AnyServerRpcDefinition,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  type DecodedNotification,
  type NotificationParamsOf,
  type ParamsOf,
  type ResultOf,
} from "@moltzap/protocol";
import {
  DEFAULT_APP_ID,
  TaskRequest,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol/task";
import { agentId } from "@moltzap/protocol/testing";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_GROUP_NAME = "cc-judge-group";
const PLACEHOLDER_AGENT_ID = "target-agent";
const PLACEHOLDER_IMAGE = "managed/by-moltzap-trace-capture";

interface RuntimeCrypto {
  readonly randomUUID?: () => string;
}

let activeRun = false;

class WorkspacePackagesDirNotFound extends Data.TaggedError(
  "WorkspacePackagesDirNotFound",
)<{
  readonly message: string;
}> {}

class ActiveTraceCaptureRunExists extends Data.TaggedError(
  "ActiveTraceCaptureRunExists",
)<{
  readonly message: string;
}> {}

class ExecutionFailed extends Data.TaggedError("ExecutionFailed")<{
  readonly message: string;
}> {}

class HarnessFailed extends Data.TaggedError("HarnessFailed")<{
  readonly detail: ExecutionFailed;
}> {}

class ContainerStartFailed extends Data.TaggedError("ContainerStartFailed")<{
  readonly message: string;
}> {}

class AgentStartFailed extends Data.TaggedError("AgentStartFailed")<{
  readonly agentId: string;
  readonly detail: ContainerStartFailed;
}> {}

type HarnessFailureCause = InvalidPayload | HarnessFailed | AgentStartFailed;

interface HarnessFailure {
  readonly cause: HarnessFailureCause;
}

interface HarnessLoadArgs {
  readonly sourcePath: string;
  readonly plan: {
    readonly project: string;
    readonly scenarioId: string;
    readonly name: string;
    readonly description: string;
    readonly requirements: Readonly<Record<string, unknown>>;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  readonly payload: unknown;
}

interface MessagePart {
  readonly type: string;
  readonly text?: string;
}

interface HarnessClient {
  close(): Effect.Effect<void, never, never>;

  /**
   * Spec B (#596): typed-payload Stream subscription. The harness
   * subscribes BEFORE issuing each `MessagesSend` (`sendMessageAndWait`'s
   * fork → trigger → join pattern) so the response notification is never
   * dropped between the request and the Stream materialisation. Structural
   * shape mirrors `MoltZapAgentClient.subscribe`.
   */
  subscribe<D extends typeof MessageReceivedNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, Error, never>;
  sendRpc<D extends AnyServerRpcDefinition>(
    method: D,
    payload: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, Error, never>;
}

interface ConnectedActor {
  readonly agentId: string;
  readonly name: string;
  readonly client: HarnessClient;
}

interface ClientTestModule {
  registerAgent(
    baseUrl: string,
    name: string,
  ): Effect.Effect<
    {
      readonly agentId: string;
      readonly apiKey: string;
    },
    Error,
    never
  >;
  registerAndConnect(
    baseUrl: string,
    wsUrl: string,
    name: string,
  ): Effect.Effect<
    {
      readonly agentId: string;
      readonly apiKey: string;
      readonly client: HarnessClient;
    },
    Error,
    never
  >;
  stripWsPath(wsUrl: string): string;
}

interface CoreAppHandle {
  readonly traceCapture: {
    snapshot(): Effect.Effect<readonly TraceCaptureEvent[], never, never>;
  };
}

// Pre-wired RuntimeServerHandle that startCoreTestServer now exposes — the
// harness threads this directly into startRuntimeAgent. Structural shape only;
// the concrete implementation lives in @moltzap/server-core's test-utils.
interface RuntimeServerLike {
  awaitAgentReady(
    agentId: string,
    timeoutMs: number,
  ): Effect.Effect<
    | { readonly _tag: "Ready" }
    | { readonly _tag: "Timeout"; readonly timeoutMs: number }
    | {
        readonly _tag: "ProcessExited";
        readonly exitCode: number | null;
        readonly stderr: string;
      },
    never,
    never
  >;
}

interface CoreTestServer {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly coreApp: CoreAppHandle;
  readonly runtimeServer: RuntimeServerLike;
}

interface ServerIndexModule {
  readonly InMemoryTraceCaptureLive: unknown;
}

interface ServerTestModule {
  startCoreTestServer(opts: { readonly traceCaptureLayer: unknown }): unknown;
  stopCoreTestServer(): unknown;
}

interface ConversationExecutionState {
  readonly sender: ConnectedActor;
  readonly closers: Array<HarnessClient>;
  readonly participants: Array<ConversationParticipant>;
  readonly responses: Array<ConversationResponse>;
}

function failHarness(message: string): HarnessFailure {
  return {
    cause: new HarnessFailed({
      detail: new ExecutionFailed({ message }),
    }),
  };
}

function failAgentStart(detail: ContainerStartFailed): HarnessFailure {
  return {
    cause: new AgentStartFailed({
      agentId: PLACEHOLDER_AGENT_ID,
      detail,
    }),
  };
}

function isHarnessFailure(error: unknown): error is HarnessFailure {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return false;
  }
  return isHarnessFailureCause(error.cause);
}

function isHarnessFailureCause(cause: unknown): cause is HarnessFailureCause {
  return (
    cause instanceof InvalidPayload ||
    cause instanceof HarnessFailed ||
    cause instanceof AgentStartFailed
  );
}

function asHarnessFailure(error: unknown): HarnessFailure {
  if (isHarnessFailure(error)) return error;
  return failHarness(error instanceof Error ? error.message : String(error));
}

function packagesDir(): string {
  return Effect.runSync(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const here = yield* path.fromFileUrl(new URL(import.meta.url));
      let current = path.dirname(here);
      while (current !== path.parse(current).root) {
        if (path.basename(current) === "packages") {
          return current;
        }
        current = path.dirname(current);
      }
      return yield* Effect.fail(
        new WorkspacePackagesDirNotFound({
          message: "Unable to resolve workspace packages directory",
        }),
      );
    }).pipe(Effect.provide(Path.layer), Effect.orDie),
  );
}

function packageModuleUrl(...segments: ReadonlyArray<string>): string {
  return Effect.runSync(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const url = yield* path.toFileUrl(path.join(packagesDir(), ...segments));
      return url.href;
    }).pipe(Effect.provide(Path.layer), Effect.orDie),
  );
}

function randomRunId(): Effect.Effect<string, HarnessFailure> {
  const crypto = (globalThis as { readonly crypto?: RuntimeCrypto }).crypto;
  if (crypto?.randomUUID === undefined) {
    return Effect.fail(
      failHarness("Runtime crypto.randomUUID is not available"),
    );
  }
  return Effect.sync(() => crypto.randomUUID!());
}

function loadClientTestModule(): Effect.Effect<ClientTestModule, Error, never> {
  return Effect.tryPromise({
    try: () =>
      import(
        packageModuleUrl("client", "dist", "test", "index.js")
      ) as Promise<ClientTestModule>,
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
}

function loadServerIndexModule(): Effect.Effect<
  ServerIndexModule,
  Error,
  never
> {
  return Effect.tryPromise({
    try: () =>
      import(
        packageModuleUrl("server", "dist", "index.js")
      ) as Promise<ServerIndexModule>,
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
}

function loadServerTestModule(): Effect.Effect<ServerTestModule, Error, never> {
  return Effect.tryPromise({
    try: () =>
      import(
        packageModuleUrl("server", "dist", "test-utils", "server.js")
      ) as Promise<ServerTestModule>,
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
}

function defaultTargetAgentName(kind: RuntimeKind): string {
  switch (kind) {
    case "openclaw":
      return "openclaw-eval-agent";
    case "nanoclaw":
      return "nanoclaw-eval-agent";
    case RUNTIME_KIND_CLAUDE_CODE:
      return "claude-code-eval-agent";
  }
}

function closeClient(client: HarnessClient): Effect.Effect<void, never, never> {
  return client.close().pipe(Effect.orElseSucceed(() => undefined));
}

function extractTextFromEvent(data: {
  readonly message: { readonly parts: ReadonlyArray<MessagePart> };
}): string {
  return data.message.parts
    .filter(
      (part): part is MessagePart & { readonly text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Spec B (#596) Goal #7 disposition (a): subscribe BEFORE triggering.
 * Builds the typed Stream of `MessageReceivedNotificationDefinition`
 * payloads filtered to the target sender/conversation pair, takes the
 * first head, and times out with a harness-shaped failure.
 *
 * The reference to `MIN_EVENT_WAIT_MS` from the prior poll-loop shape is
 * dropped — `Stream.runHead` does not poll, it suspends until either a
 * matching frame arrives or the timeout fires.
 */
function waitForTargetResponseStream(input: {
  readonly client: HarnessClient;
  readonly targetAgentId: string;
  readonly conversationId: ConversationId;
  readonly timeoutMs: number;
}): Effect.Effect<ConversationResponse, HarnessFailure, never> {
  return input.client
    .subscribe(
      MessageReceivedNotificationDefinition,
      (params) =>
        params.message.senderId === input.targetAgentId &&
        params.message.conversationId === input.conversationId,
    )
    .pipe(
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.millis(input.timeoutMs),
        onTimeout: () =>
          failHarness(
            `timed out waiting for ${input.targetAgentId} in conversation ${input.conversationId}`,
          ),
      }),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failHarness(
                `notification stream closed before ${input.targetAgentId} response arrived`,
              ),
            ),
          onSome: (event) => {
            const data = event.params;
            return Effect.succeed({
              conversationId: data.message.conversationId,
              senderId: data.message.senderId,
              text: extractTextFromEvent(data),
              messageId: data.message.id,
            } satisfies ConversationResponse);
          },
        }),
      ),
      Effect.catchAll((error) =>
        Effect.fail(
          error instanceof Error ? failHarness(error.message) : error,
        ),
      ),
    );
}

function sendMessageAndWait(input: {
  readonly sender: ConnectedActor;
  readonly targetAgentId: string;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly message: string;
  readonly timeoutMs?: number;
}): Effect.Effect<ConversationResponse, HarnessFailure, never> {
  return Effect.gen(function* () {
    // Spec B (#596) Goal #7 disposition (a): fork the response-listener
    // Stream BEFORE the trigger RPC.
    const responseFiber = yield* Effect.fork(
      waitForTargetResponseStream({
        client: input.sender.client,
        targetAgentId: input.targetAgentId,
        conversationId: input.conversationId,
        timeoutMs: input.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
      }),
    );
    yield* input.sender.client
      .sendRpc(MessagesSend, {
        taskId: input.taskId,
        conversationId: input.conversationId,
        parts: [{ type: "text", text: input.message }],
      })
      .pipe(
        Effect.mapError((error) => failHarness(error.message)),
        Effect.onError(() => Fiber.interrupt(responseFiber)),
      );
    return yield* Fiber.join(responseFiber);
  });
}

function registerConnectedAgent(
  clientModule: ClientTestModule,
  baseUrl: string,
  wsUrl: string,
  name: string,
): Effect.Effect<ConnectedActor, HarnessFailure, never> {
  return clientModule.registerAndConnect(baseUrl, wsUrl, name).pipe(
    Effect.map((connected) => ({
      agentId: connected.agentId,
      name,
      client: connected.client,
    })),
    Effect.mapError((error) => failHarness(error.message)),
  );
}

interface TaskScope {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

function createDirectConversation(
  sender: ConnectedActor,
  targetAgentId: string,
): Effect.Effect<TaskScope, HarnessFailure, never> {
  const target = agentId(targetAgentId);
  return sender.client
    .sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [target],
      initialConversation: { participants: [target] },
    })
    .pipe(
      Effect.mapError((error) => failHarness(error.message)),
      Effect.flatMap((result) =>
        result.conversation
          ? Effect.succeed({
              taskId: result.task.id,
              conversationId: result.conversation.id,
            })
          : Effect.fail(
              failHarness("TaskRequest returned null initial conversation"),
            ),
      ),
    );
}

function createGroupConversation(input: {
  readonly sender: ConnectedActor;
  readonly targetAgentId: string;
  readonly groupName: string;
  readonly participants: ReadonlyArray<ConnectedActor>;
}): Effect.Effect<TaskScope, HarnessFailure, never> {
  const invited = [
    agentId(input.targetAgentId),
    ...input.participants.map((p) => agentId(p.agentId)),
  ];
  return input.sender.client
    .sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: invited,
      initialConversation: { participants: invited },
    })
    .pipe(
      Effect.mapError((error) => failHarness(error.message)),
      Effect.flatMap((result) =>
        result.conversation
          ? Effect.succeed({
              taskId: result.task.id,
              conversationId: result.conversation.id,
            })
          : Effect.fail(
              failHarness("TaskRequest returned null initial conversation"),
            ),
      ),
    );
}

function createConversationState(
  sender: ConnectedActor,
): ConversationExecutionState {
  return {
    sender,
    closers: [sender.client],
    participants: [{ id: sender.agentId, name: sender.name, role: "sender" }],
    responses: [],
  };
}

function closeConversationClients(
  clients: ReadonlyArray<HarnessClient>,
): Effect.Effect<void, never, never> {
  return Effect.forEach([...clients].reverse(), closeClient, {
    concurrency: 1,
    discard: true,
  });
}

function executeConversationKind(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly wsUrl: string;
    readonly targetAgentId: string;
    readonly clientModule: ClientTestModule;
  },
  state: ConversationExecutionState,
): Effect.Effect<void, HarnessFailure, never> {
  switch (input.payload.conversation.kind) {
    case "direct":
      return executeDirectConversation(input, state);
    case "group":
      return executeGroupConversation(input, state);
    case "cross":
      return executeCrossConversation(input, state);
  }
}

function executeDirectConversation(
  input: {
    readonly payload: HarnessPayload;
    readonly targetAgentId: string;
  },
  state: ConversationExecutionState,
) {
  return Effect.gen(function* () {
    const scope = yield* createDirectConversation(
      state.sender,
      input.targetAgentId,
    );
    yield* sendSetupAndFollowUps({
      state,
      sender: state.sender,
      targetAgentId: input.targetAgentId,
      scope,
      setupMessage: input.payload.conversation.setupMessage,
      followUpMessages: input.payload.conversation.followUpMessages,
    });
  });
}

function executeGroupConversation(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly wsUrl: string;
    readonly targetAgentId: string;
    readonly clientModule: ClientTestModule;
  },
  state: ConversationExecutionState,
) {
  return Effect.gen(function* () {
    if (input.payload.conversation.kind !== "group") {
      return;
    }
    const bystanders = yield* registerBystanders(input, state);
    const scope = yield* createGroupConversation({
      sender: state.sender,
      targetAgentId: input.targetAgentId,
      groupName: input.payload.conversation.groupName ?? DEFAULT_GROUP_NAME,
      participants: bystanders.map((entry) => entry.actor),
    });
    yield* sendBystanderMessages(bystanders, input.targetAgentId, scope);
    yield* sendSetupAndFollowUps({
      state,
      sender: state.sender,
      targetAgentId: input.targetAgentId,
      scope,
      setupMessage: input.payload.conversation.setupMessage,
      followUpMessages: input.payload.conversation.followUpMessages,
    });
  });
}

function executeCrossConversation(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly wsUrl: string;
    readonly targetAgentId: string;
    readonly clientModule: ClientTestModule;
  },
  state: ConversationExecutionState,
) {
  return Effect.gen(function* () {
    if (input.payload.conversation.kind !== "cross") {
      return;
    }
    const firstScope = yield* createDirectConversation(
      state.sender,
      input.targetAgentId,
    );
    yield* sendSetupAndFollowUps({
      state,
      sender: state.sender,
      targetAgentId: input.targetAgentId,
      scope: firstScope,
      setupMessage: input.payload.conversation.setupMessage,
      followUpMessages: input.payload.conversation.followUpMessages,
    });
    const probeSender = yield* registerProbeSender(input, state);
    const secondScope = yield* createDirectConversation(
      probeSender,
      input.targetAgentId,
    );
    state.responses.push(
      yield* sendMessageAndWait({
        sender: probeSender,
        targetAgentId: input.targetAgentId,
        taskId: secondScope.taskId,
        conversationId: secondScope.conversationId,
        message: input.payload.conversation.probeMessage,
      }),
    );
  });
}

function registerBystanders(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly wsUrl: string;
    readonly clientModule: ClientTestModule;
  },
  state: ConversationExecutionState,
) {
  if (input.payload.conversation.kind !== "group") {
    return Effect.succeed([]);
  }
  return Effect.forEach(
    input.payload.conversation.bystanders,
    (entry) =>
      registerConnectedAgent(
        input.clientModule,
        input.baseUrl,
        input.wsUrl,
        entry.name,
      ).pipe(
        Effect.tap((actor) =>
          Effect.sync(() => {
            state.closers.push(actor.client);
            state.participants.push({
              id: actor.agentId,
              name: actor.name,
              role: "bystander",
            });
          }),
        ),
        Effect.map((actor) => ({ actor, messages: entry.messages })),
      ),
    { concurrency: 1 },
  );
}

function registerProbeSender(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly wsUrl: string;
    readonly clientModule: ClientTestModule;
  },
  state: ConversationExecutionState,
) {
  const name =
    input.payload.conversation.kind === "cross"
      ? (input.payload.conversation.probeSenderName ?? "eval-probe-sender")
      : "eval-probe-sender";
  return registerConnectedAgent(
    input.clientModule,
    input.baseUrl,
    input.wsUrl,
    name,
  ).pipe(
    Effect.tap((actor) =>
      Effect.sync(() => {
        state.closers.push(actor.client);
        state.participants.push({
          id: actor.agentId,
          name: actor.name,
          role: "probe",
        });
      }),
    ),
  );
}

function sendSetupAndFollowUps(input: {
  readonly state: ConversationExecutionState;
  readonly sender: ConnectedActor;
  readonly targetAgentId: string;
  readonly scope: TaskScope;
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
}) {
  return Effect.gen(function* () {
    input.state.responses.push(
      yield* sendMessageAndWait({
        sender: input.sender,
        targetAgentId: input.targetAgentId,
        taskId: input.scope.taskId,
        conversationId: input.scope.conversationId,
        message: input.setupMessage,
      }),
    );
    for (const followUp of input.followUpMessages) {
      input.state.responses.push(
        yield* sendMessageAndWait({
          sender: input.sender,
          targetAgentId: input.targetAgentId,
          taskId: input.scope.taskId,
          conversationId: input.scope.conversationId,
          message: followUp,
        }),
      );
    }
  });
}

function sendBystanderMessages(
  bystanders: ReadonlyArray<{
    readonly actor: ConnectedActor;
    readonly messages: ReadonlyArray<string>;
  }>,
  targetAgentId: string,
  scope: TaskScope,
) {
  return Effect.forEach(
    bystanders,
    (bystander) =>
      Effect.forEach(
        bystander.messages,
        (message) =>
          sendMessageAndWait({
            sender: bystander.actor,
            targetAgentId,
            taskId: scope.taskId,
            conversationId: scope.conversationId,
            message,
          }),
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  );
}

function executeConversationPlan(input: {
  readonly payload: HarnessPayload;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly targetAgentId: string;
  readonly clientModule: ClientTestModule;
}): Effect.Effect<ConversationRun, HarnessFailure, never> {
  return Effect.gen(function* () {
    const sender = yield* registerConnectedAgent(
      input.clientModule,
      input.baseUrl,
      input.wsUrl,
      input.payload.conversation.senderName ?? "eval-sender",
    );
    const state = createConversationState(sender);

    try {
      yield* executeConversationKind(input, state);
      return {
        participants: state.participants,
        responses: state.responses,
      };
    } finally {
      yield* closeConversationClients(state.closers);
    }
  });
}

function withExclusiveRun<A, E>(
  effect: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | HarnessFailure, never> {
  return Effect.try({
    try: () => {
      if (activeRun) {
        throw new ActiveTraceCaptureRunExists({
          message:
            "MoltZap trace-capture harness only supports one active run at a time",
        });
      }
      activeRun = true;
    },
    catch: (error) =>
      failHarness(error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.zipRight(effect),
    Effect.ensuring(
      Effect.sync(() => {
        activeRun = false;
      }),
    ),
  );
}

interface TargetAgentRegistration {
  readonly agentId: string;
  readonly apiKey: string;
  readonly agentName: string;
}

function startCoreTraceServer(
  serverIndexModule: ServerIndexModule,
  serverTestModule: ServerTestModule,
): Effect.Effect<CoreTestServer, HarnessFailure> {
  return Effect.tryPromise({
    try: () =>
      Promise.resolve(
        serverTestModule.startCoreTestServer({
          traceCaptureLayer: serverIndexModule.InMemoryTraceCaptureLive,
        }),
      ) as Promise<CoreTestServer>,
    catch: (error) =>
      failHarness(error instanceof Error ? error.message : String(error)),
  });
}

function loadHarnessClientModule(): Effect.Effect<
  ClientTestModule,
  HarnessFailure
> {
  return loadClientTestModule().pipe(
    Effect.mapError((error) =>
      failHarness(error instanceof Error ? error.message : String(error)),
    ),
  );
}

function registerTargetAgent(input: {
  readonly clientModule: ClientTestModule;
  readonly baseUrl: string;
  readonly targetAgentName: string;
}): Effect.Effect<TargetAgentRegistration, HarnessFailure> {
  return input.clientModule
    .registerAgent(input.baseUrl, input.targetAgentName)
    .pipe(
      Effect.map((registered) => ({
        agentId: registered.agentId,
        apiKey: registered.apiKey,
        agentName: input.targetAgentName,
      })),
      Effect.mapError((error) => failHarness(error.message)),
    );
}

function mapRuntimeStartError(error: unknown): HarnessFailure {
  if (error instanceof SpawnFailed) {
    return failAgentStart(new ContainerStartFailed({ message: error.message }));
  }
  if (error instanceof RuntimeReadyTimedOut) {
    return failAgentStart(
      new ContainerStartFailed({
        message: `runtime did not authenticate within ${String(error.timeoutMs)}ms`,
      }),
    );
  }
  const exited = error as { readonly stderr?: unknown };
  return failAgentStart(
    new ContainerStartFailed({
      message: `runtime exited before readiness: ${String(exited.stderr)}`,
    }),
  );
}

function startHarnessRuntime(input: {
  readonly payload: HarnessPayload;
  readonly server: CoreTestServer;
  readonly targetAgent: TargetAgentRegistration;
  readonly clientModule: ClientTestModule;
}) {
  return startRuntimeAgent({
    kind: input.payload.runtime.kind,
    server: input.server.runtimeServer,
    readyTimeoutMs:
      input.payload.runtime.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    agent: {
      agentName: input.targetAgent.agentName,
      apiKey: input.targetAgent.apiKey,
      agentId: input.targetAgent.agentId,
      serverUrl: input.clientModule.stripWsPath(input.server.wsUrl),
    },
  }).pipe(Effect.mapError(mapRuntimeStartError));
}

function stopCoreTraceServer(
  serverTestModule: ServerTestModule,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(serverTestModule.stopCoreTestServer()),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  }).pipe(Effect.catchAll(() => Effect.void));
}

function executeTraceRun(input: {
  readonly sourcePath: string;
  readonly payload: HarnessPayload;
  readonly plan: HarnessLoadArgs["plan"];
  readonly runId: string | undefined;
  readonly server: CoreTestServer;
  readonly clientModule: ClientTestModule;
  readonly targetAgent: TargetAgentRegistration;
  readonly runtime: Runtime;
  readonly runtimeStartedAt: string;
}): Effect.Effect<Readonly<Record<string, unknown>>, HarnessFailure, never> {
  const teardown = input.runtime.teardown();
  return Effect.gen(function* () {
    const conversationRun = yield* executeConversationPlan({
      payload: input.payload,
      baseUrl: input.server.baseUrl,
      wsUrl: input.server.wsUrl,
      targetAgentId: input.targetAgent.agentId,
      clientModule: input.clientModule,
    });
    const traceEvents = yield* input.server.coreApp.traceCapture.snapshot();
    const runId = input.runId ?? (yield* randomRunId());
    return buildTraceBundle({
      sourcePath: input.sourcePath,
      payload: input.payload,
      plan: input.plan,
      runId,
      targetAgent: input.targetAgent,
      runtimeStartedAt: input.runtimeStartedAt,
      traceEvents,
      conversationRun,
    });
  }).pipe(Effect.ensuring(teardown));
}

function executeCoordinatorRun(input: {
  readonly sourcePath: string;
  readonly payload: HarnessPayload;
  readonly plan: HarnessLoadArgs["plan"];
  readonly runId: string | undefined;
}) {
  return Effect.gen(function* () {
    const [serverIndexModule, serverTestModule] = yield* Effect.all([
      loadServerIndexModule(),
      loadServerTestModule(),
    ]);
    const server = yield* startCoreTraceServer(
      serverIndexModule,
      serverTestModule,
    );
    return yield* executeWithCoreServer(input, server).pipe(
      Effect.ensuring(stopCoreTraceServer(serverTestModule)),
    );
  });
}

function executeWithCoreServer(
  input: {
    readonly sourcePath: string;
    readonly payload: HarnessPayload;
    readonly plan: HarnessLoadArgs["plan"];
    readonly runId: string | undefined;
  },
  server: CoreTestServer,
) {
  return Effect.gen(function* () {
    const clientModule = yield* loadHarnessClientModule();
    const targetAgentName =
      input.payload.runtime.targetAgentName ??
      defaultTargetAgentName(input.payload.runtime.kind);
    const targetAgent = yield* registerTargetAgent({
      clientModule,
      baseUrl: server.baseUrl,
      targetAgentName,
    });
    const runtimeStartedAt = new Date().toISOString();
    const runtime = yield* startHarnessRuntime({
      payload: input.payload,
      server,
      targetAgent,
      clientModule,
    });
    return yield* executeTraceRun({
      ...input,
      server,
      clientModule,
      targetAgent,
      runtime,
      runtimeStartedAt,
    });
  });
}

function createCoordinator(sourcePath: string, payload: HarnessPayload) {
  return {
    execute(
      plan: HarnessLoadArgs["plan"],
      _harness: unknown,
      opts: { readonly runId?: string } = {},
    ): Effect.Effect<Readonly<Record<string, unknown>>, HarnessFailure, never> {
      return withExclusiveRun(
        executeCoordinatorRun({
          sourcePath,
          payload,
          plan,
          runId: opts.runId,
        }),
      ).pipe(Effect.mapError(asHarnessFailure));
    },
  };
}

function buildHarnessLoadResult(
  args: HarnessLoadArgs,
  payload: HarnessPayload,
) {
  return {
    plan: buildHarnessPlan(args, payload),
    harness: {
      name: "moltzap-trace-capture",
      run: () =>
        Effect.fail(
          new ExecutionFailed({
            message:
              "MoltZap trace-capture plans require the custom coordinator path",
          }),
        ),
    },
    coordinator: createCoordinator(args.sourcePath, payload),
  };
}

function buildHarnessPlan(args: HarnessLoadArgs, payload: HarnessPayload) {
  return {
    project: args.plan.project,
    scenarioId: args.plan.scenarioId,
    name: args.plan.name,
    description: args.plan.description,
    agents: [targetAgentPlan(payload)],
    requirements: args.plan.requirements,
    metadata: {
      ...args.plan.metadata,
      harness: "moltzap-trace-capture",
      conversationKind: payload.conversation.kind,
      runtimeKind: payload.runtime.kind,
    },
  };
}

function targetAgentPlan(payload: HarnessPayload) {
  return {
    id: PLACEHOLDER_AGENT_ID,
    name:
      payload.runtime.targetAgentName ??
      defaultTargetAgentName(payload.runtime.kind),
    role: "target",
    artifact: {
      _tag: "DockerImageArtifact",
      image: PLACEHOLDER_IMAGE,
      pullPolicy: "never",
    },
    promptInputs: {},
    metadata: {
      runtimeKind: payload.runtime.kind,
    },
  };
}

const traceCaptureHarness = {
  load(args: HarnessLoadArgs) {
    return decodePayload(args.sourcePath, args.payload).pipe(
      Effect.mapError(asHarnessFailure),
      Effect.map((payload) => buildHarnessLoadResult(args, payload)),
    );
  },
};

export default traceCaptureHarness;
