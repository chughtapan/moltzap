import { Path } from "@effect/platform";
import type * as ClientTestUtils from "@moltzap/client/test-utils";
import { Data, Duration, Effect, Fiber, Option, Stream } from "effect";
import type * as ServerTestUtils from "@moltzap/server-core/test-utils";
import { startRuntimeAgent, type RuntimeKind } from "./testbed.js";
import { RuntimeReadyTimedOut, SpawnFailed } from "./errors.js";
import type { Runtime } from "./runtime.js";
import {
  decodePayload,
  InvalidPayload,
  type HarnessPayload,
} from "./trace-capture-payload.js";
import {
  buildTraceBundle,
  type ConversationParticipant,
  type ConversationResponse,
  type ConversationRun,
  type TraceCaptureEvent,
} from "./trace-capture-bundle.js";

import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
} from "@moltzap/protocol/message";
import {
  DEFAULT_APP_ID,
  taskRequest,
  type TaskId,
} from "@moltzap/protocol/task";
import type { ConversationId } from "@moltzap/protocol/conversation";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_GROUP_NAME = "cc-judge-group";
const PLAN_TARGET_AGENT_ID = "target-agent";
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
  readonly agentId: AgentId;
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

// Type-only namespaces keep the dynamic loaders aligned with their published
// test surfaces without introducing client or server runtime imports.
type ClientTestModule = typeof ClientTestUtils;
type HarnessClient = ClientTestUtils.HarnessAgentClient;
type ServerTestModule = typeof ServerTestUtils;
type CoreTestServer = ServerTestUtils.CoreTestServer;

interface ConnectedActor {
  readonly agentId: AgentId;
  readonly name: string;
  readonly client: HarnessClient;
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

function failAgentStart(
  agentId: AgentId,
  detail: ContainerStartFailed,
): HarnessFailure {
  return {
    cause: new AgentStartFailed({
      agentId,
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
        packageModuleUrl("client", "dist", "test-utils", "index.js")
      ) as Promise<ClientTestModule>,
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
}

function loadServerTestModule(): Effect.Effect<ServerTestModule, Error, never> {
  return Effect.tryPromise({
    try: () =>
      import(
        packageModuleUrl("server", "dist", "test-utils", "index.js")
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
  }
}

const CLIENT_CLOSE_TIMEOUT_MS = 5_000;

// Bounded: a close that hangs (half-dead socket) must degrade to a leaked
// connection warning, never wedge the run's unwind chain.
function closeClient(client: HarnessClient): Effect.Effect<void, never, never> {
  return client.close().pipe(
    Effect.timeout(Duration.millis(CLIENT_CLOSE_TIMEOUT_MS)),
    Effect.orElseSucceed(() => undefined),
  );
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
  readonly targetAgentId: AgentId;
  readonly conversationId: ConversationId;
  readonly timeoutMs: number;
}): Effect.Effect<ConversationResponse, HarnessFailure, never> {
  return input.client
    .subscribe(
      messageReceivedNotificationDefinition,
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
          onSome: (data) => {
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
  readonly targetAgentId: AgentId;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly message: string;
  readonly timeoutMs: number | undefined;
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
      .sendRpc(messagesSend, {
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
  name: string,
): Effect.Effect<ConnectedActor, HarnessFailure, never> {
  return clientModule.registerAndConnect(baseUrl, name).pipe(
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
  targetAgentId: AgentId,
): Effect.Effect<TaskScope, HarnessFailure, never> {
  return sender.client
    .sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [targetAgentId],
      initialConversation: { participants: [targetAgentId] },
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
  readonly targetAgentId: AgentId;
  readonly groupName: string;
  readonly participants: ReadonlyArray<ConnectedActor>;
}): Effect.Effect<TaskScope, HarnessFailure, never> {
  const invited = [
    input.targetAgentId,
    ...input.participants.map((p) => p.agentId),
  ];
  return input.sender.client
    .sendRpc(taskRequest, {
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

// Concurrent: the clients are independent sockets, and serial closes would
// stack the per-close timeout into an N x 5s worst-case unwind.
function closeConversationClients(
  clients: ReadonlyArray<HarnessClient>,
): Effect.Effect<void, never, never> {
  return Effect.forEach(clients, closeClient, {
    concurrency: clients.length,
    discard: true,
  });
}

function executeConversationKind(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly targetAgentId: AgentId;
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
    readonly targetAgentId: AgentId;
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
      timeoutMs: input.payload.runtime.responseTimeoutMs,
    });
  });
}

function executeGroupConversation(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly targetAgentId: AgentId;
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
    yield* sendBystanderMessages(
      bystanders,
      input.targetAgentId,
      scope,
      input.payload.runtime.responseTimeoutMs,
    );
    yield* sendSetupAndFollowUps({
      state,
      sender: state.sender,
      targetAgentId: input.targetAgentId,
      scope,
      setupMessage: input.payload.conversation.setupMessage,
      followUpMessages: input.payload.conversation.followUpMessages,
      timeoutMs: input.payload.runtime.responseTimeoutMs,
    });
  });
}

function executeCrossConversation(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
    readonly targetAgentId: AgentId;
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
      timeoutMs: input.payload.runtime.responseTimeoutMs,
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
        timeoutMs: input.payload.runtime.responseTimeoutMs,
      }),
    );
  });
}

function registerBystanders(
  input: {
    readonly payload: HarnessPayload;
    readonly baseUrl: string;
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
    readonly clientModule: ClientTestModule;
  },
  state: ConversationExecutionState,
) {
  const name =
    input.payload.conversation.kind === "cross"
      ? (input.payload.conversation.probeSenderName ?? "eval-probe-sender")
      : "eval-probe-sender";
  return registerConnectedAgent(input.clientModule, input.baseUrl, name).pipe(
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
  readonly targetAgentId: AgentId;
  readonly scope: TaskScope;
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly timeoutMs: number | undefined;
}) {
  return Effect.gen(function* () {
    input.state.responses.push(
      yield* sendMessageAndWait({
        sender: input.sender,
        targetAgentId: input.targetAgentId,
        taskId: input.scope.taskId,
        conversationId: input.scope.conversationId,
        message: input.setupMessage,
        timeoutMs: input.timeoutMs,
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
          timeoutMs: input.timeoutMs,
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
  targetAgentId: AgentId,
  scope: TaskScope,
  responseTimeoutMs: number | undefined,
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
            timeoutMs: responseTimeoutMs,
          }),
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  );
}

function executeConversationPlan(input: {
  readonly payload: HarnessPayload;
  readonly baseUrl: string;
  readonly targetAgentId: AgentId;
  readonly clientModule: ClientTestModule;
}): Effect.Effect<ConversationRun, HarnessFailure, never> {
  return Effect.gen(function* () {
    const sender = yield* registerConnectedAgent(
      input.clientModule,
      input.baseUrl,
      input.payload.conversation.senderName ?? "eval-sender",
    );
    const state = createConversationState(sender);

    // Cleanup MUST be Effect.ensuring, not a gen-body try/finally: on the
    // failure path Effect.gen never resumes the generator, so a finally's
    // `yield*` silently never executes — the leaked client sockets then
    // hang the server close and wedge the caller forever (#791). The
    // suspend defers reading `closers`, which fills during execution.
    yield* executeConversationKind(input, state).pipe(
      Effect.ensuring(
        Effect.suspend(() => closeConversationClients(state.closers)),
      ),
    );
    return {
      participants: state.participants,
      responses: state.responses,
    };
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
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
  readonly agentName: string;
}

function startCoreTraceServer(
  serverTestModule: ServerTestModule,
): Effect.Effect<CoreTestServer, HarnessFailure> {
  return Effect.tryPromise({
    try: () => serverTestModule.startCoreTestServer({}),
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

function mapRuntimeStartError(
  error: unknown,
  agentId: AgentId,
): HarnessFailure {
  if (error instanceof SpawnFailed) {
    return failAgentStart(
      agentId,
      new ContainerStartFailed({ message: error.message }),
    );
  }
  if (error instanceof RuntimeReadyTimedOut) {
    return failAgentStart(
      agentId,
      new ContainerStartFailed({
        message: `runtime did not authenticate within ${String(error.timeoutMs)}ms`,
      }),
    );
  }
  const exited = error as { readonly stderr?: unknown };
  return failAgentStart(
    agentId,
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
  // Harness runs create fresh conversations with no pre-provisioned NanoClaw
  // registration, so the disposable eval runtime must accept them on delivery.
  const runtimeSelection =
    input.payload.runtime.kind === "nanoclaw"
      ? ({
          kind: "nanoclaw",
          nanoclaw: { autoRegisterConversations: true },
        } as const)
      : ({ kind: "openclaw" } as const);
  return startRuntimeAgent({
    ...runtimeSelection,
    server: input.server.runtimeServer,
    readyTimeoutMs:
      input.payload.runtime.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    agent: {
      agentName: input.targetAgent.agentName,
      apiKey: input.targetAgent.apiKey,
      agentId: input.targetAgent.agentId,
      serverUrl: input.clientModule.stripWsPath(input.server.wsUrl),
    },
  }).pipe(
    Effect.mapError((error) =>
      mapRuntimeStartError(error, input.targetAgent.agentId),
    ),
  );
}

const SERVER_STOP_TIMEOUT_MS = 15_000;

// Bounded like every other finalizer in the unwind chain: app.close() waits
// for connection drain, so a socket that survived client close and runtime
// teardown must degrade to a leak warning instead of wedging the caller.
function stopCoreTraceServer(
  serverTestModule: ServerTestModule,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(serverTestModule.stopCoreTestServer()),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  }).pipe(
    Effect.timeout(Duration.millis(SERVER_STOP_TIMEOUT_MS)),
    Effect.catchAll(() =>
      Effect.logWarning(
        "core test server did not stop within the bound; abandoning close",
      ),
    ),
  );
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
      targetAgentId: input.targetAgent.agentId,
      clientModule: input.clientModule,
    });
    // TODO: read finished OTel spans from `server.spanExporter` and map
    // `moltzap.message.delivered` spans to `TraceCaptureEvent`. The
    // server-side custom `TraceCapture` was removed; arena's harness
    // needs its own OTel→TraceCaptureEvent mapping. Bundles are empty
    // until that's wired.
    //
    // Note: spans carry message-shape metadata only (part/text counts and
    // lengths), NOT message body plaintext — the server redacts body text
    // from telemetry. A future mapping that needs the actual message text
    // must obtain it through a non-telemetry path, not from these spans.
    const traceEvents: readonly TraceCaptureEvent[] = [];
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
    const serverTestModule = yield* loadServerTestModule();
    const server = yield* startCoreTraceServer(serverTestModule);
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
    id: PLAN_TARGET_AGENT_ID,
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
