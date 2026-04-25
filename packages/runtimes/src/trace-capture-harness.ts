import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { startRuntimeAgent, type RuntimeKind } from "./fleet.js";
import type { Runtime } from "./runtime.js";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_GROUP_NAME = "cc-judge-group";
const PLACEHOLDER_AGENT_ID = "target-agent";
const PLACEHOLDER_IMAGE = "managed/by-moltzap-trace-capture";

let activeRun = false;

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

interface TraceCaptureEvent {
  readonly _tag: "Message";
  readonly channelKey: string;
  readonly senderDisplayName: string;
  readonly message: {
    readonly senderId: string;
    readonly conversationId: string;
    readonly id: string;
    readonly createdAt: string;
    readonly parts: ReadonlyArray<MessagePart>;
  };
  readonly recipientAgentIds: ReadonlyArray<string>;
}

interface HarnessClient {
  close(): Effect.Effect<void, never, never>;
  waitForEvent(
    method: "messages/received",
    timeoutMs: number,
  ): Effect.Effect<
    {
      readonly data: {
        readonly message: {
          readonly senderId: string;
          readonly conversationId: string;
          readonly id: string;
          readonly createdAt: string;
          readonly parts: ReadonlyArray<MessagePart>;
        };
      };
    },
    Error,
    never
  >;
  sendRpc(
    method: string,
    payload: unknown,
  ): Effect.Effect<unknown, Error, never>;
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
  readonly connections: {
    getByAgent(
      agentId: string,
    ): ReadonlyArray<{ readonly auth: unknown | null }>;
  };
  readonly traceCapture: {
    snapshot(): Effect.Effect<readonly TraceCaptureEvent[], never, never>;
  };
}

interface CoreTestServer {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly coreApp: CoreAppHandle;
}

interface ServerIndexModule {
  readonly InMemoryTraceCaptureLive: unknown;
}

interface ServerTestModule {
  startCoreTestServer(opts: { readonly traceCaptureLayer: unknown }): unknown;
  stopCoreTestServer(): unknown;
}

interface DirectConversationPayload {
  readonly kind: "direct";
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly senderName?: string;
}

interface GroupConversationPayload {
  readonly kind: "group";
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly senderName?: string;
  readonly groupName?: string;
  readonly bystanders: ReadonlyArray<{
    readonly name: string;
    readonly messages: ReadonlyArray<string>;
  }>;
}

interface CrossConversationPayload {
  readonly kind: "cross";
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly senderName?: string;
  readonly probeSenderName?: string;
  readonly probeMessage: string;
}

type ConversationPayload =
  | DirectConversationPayload
  | GroupConversationPayload
  | CrossConversationPayload;

interface HarnessPayload {
  readonly runtime: {
    readonly kind: RuntimeKind;
    readonly targetAgentName?: string;
    readonly readyTimeoutMs?: number;
  };
  readonly conversation: ConversationPayload;
}

interface ConversationResponse {
  readonly conversationId: string;
  readonly senderId: string;
  readonly text: string;
  readonly messageId: string;
}

function failLoad(
  pathValue: string,
  tag: string,
  detail: Readonly<Record<string, unknown>>,
): {
  readonly cause: Readonly<Record<string, unknown>>;
} {
  return { cause: { _tag: tag, path: pathValue, ...detail } };
}

function failHarness(message: string): {
  readonly cause: {
    readonly _tag: "HarnessFailed";
    readonly detail: {
      readonly _tag: "ExecutionFailed";
      readonly message: string;
    };
  };
} {
  return {
    cause: {
      _tag: "HarnessFailed",
      detail: {
        _tag: "ExecutionFailed",
        message,
      },
    },
  };
}

function failAgentStart(detail: {
  readonly _tag: "ContainerStartFailed";
  readonly message: string;
}): {
  readonly cause: {
    readonly _tag: "AgentStartFailed";
    readonly agentId: string;
    readonly detail: {
      readonly _tag: "ContainerStartFailed";
      readonly message: string;
    };
  };
} {
  return {
    cause: {
      _tag: "AgentStartFailed",
      agentId: PLACEHOLDER_AGENT_ID,
      detail,
    },
  };
}

function asHarnessFailure(error: unknown): {
  readonly cause: Readonly<Record<string, unknown>>;
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null
  ) {
    return error as { readonly cause: Readonly<Record<string, unknown>> };
  }
  return failHarness(error instanceof Error ? error.message : String(error));
}

function packagesDir(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.parse(current).root) {
    if (path.basename(current) === "packages") {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("Unable to resolve workspace packages directory");
}

function packageModuleUrl(...segments: ReadonlyArray<string>): string {
  return pathToFileURL(path.join(packagesDir(), ...segments)).href;
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

function asStringList(
  value: unknown,
  field: string,
  issues: Array<string>,
): ReadonlyArray<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    issues.push(`${field} must be an array of non-empty strings`);
    return undefined;
  }
  return value;
}

function decodePayload(
  sourcePath: string,
  payload: unknown,
): Effect.Effect<
  HarnessPayload,
  { readonly cause: Readonly<Record<string, unknown>> },
  never
> {
  const issues: Array<string> = [];
  const candidatePayload =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as {
          readonly runtime?: unknown;
          readonly conversation?: unknown;
        })
      : undefined;

  if (candidatePayload === undefined) {
    issues.push("payload must be an object");
  }

  const runtime =
    typeof candidatePayload?.runtime === "object" &&
    candidatePayload.runtime !== null &&
    !Array.isArray(candidatePayload.runtime)
      ? (candidatePayload.runtime as {
          readonly kind?: unknown;
          readonly targetAgentName?: unknown;
          readonly readyTimeoutMs?: unknown;
        })
      : undefined;
  if (runtime === undefined) {
    issues.push("runtime must be an object");
  }

  const runtimeKind = runtime?.kind;
  if (
    runtimeKind !== "openclaw" &&
    runtimeKind !== "nanoclaw" &&
    runtimeKind !== "claude-code"
  ) {
    issues.push(
      "runtime.kind must be 'openclaw', 'nanoclaw', or 'claude-code'",
    );
  }
  if (
    runtime?.targetAgentName !== undefined &&
    (typeof runtime.targetAgentName !== "string" ||
      runtime.targetAgentName.length === 0)
  ) {
    issues.push("runtime.targetAgentName must be a non-empty string");
  }
  if (
    runtime?.readyTimeoutMs !== undefined &&
    (typeof runtime.readyTimeoutMs !== "number" ||
      !Number.isInteger(runtime.readyTimeoutMs) ||
      runtime.readyTimeoutMs <= 0)
  ) {
    issues.push("runtime.readyTimeoutMs must be a positive integer");
  }

  const conversation =
    typeof candidatePayload?.conversation === "object" &&
    candidatePayload.conversation !== null &&
    !Array.isArray(candidatePayload.conversation)
      ? (candidatePayload.conversation as {
          readonly kind?: unknown;
          readonly setupMessage?: unknown;
          readonly followUpMessages?: unknown;
          readonly senderName?: unknown;
          readonly groupName?: unknown;
          readonly bystanders?: unknown;
          readonly probeMessage?: unknown;
          readonly probeSenderName?: unknown;
        })
      : undefined;
  if (conversation === undefined) {
    issues.push("conversation must be an object");
  }

  const conversationKind = conversation?.kind;
  if (
    conversationKind !== "direct" &&
    conversationKind !== "group" &&
    conversationKind !== "cross"
  ) {
    issues.push("conversation.kind must be 'direct', 'group', or 'cross'");
  }
  if (
    typeof conversation?.setupMessage !== "string" ||
    conversation.setupMessage.length === 0
  ) {
    issues.push("conversation.setupMessage must be a non-empty string");
  }
  const followUpMessages =
    asStringList(
      conversation?.followUpMessages,
      "conversation.followUpMessages",
      issues,
    ) ?? [];
  if (
    conversation?.senderName !== undefined &&
    (typeof conversation.senderName !== "string" ||
      conversation.senderName.length === 0)
  ) {
    issues.push("conversation.senderName must be a non-empty string");
  }

  let bystanders: ReadonlyArray<{
    readonly name: string;
    readonly messages: ReadonlyArray<string>;
  }> = [];
  if (conversationKind === "group") {
    if (
      conversation?.groupName !== undefined &&
      (typeof conversation.groupName !== "string" ||
        conversation.groupName.length === 0)
    ) {
      issues.push("conversation.groupName must be a non-empty string");
    }
    if (conversation?.bystanders !== undefined) {
      if (!Array.isArray(conversation.bystanders)) {
        issues.push("conversation.bystanders must be an array");
      } else {
        const parsed: Array<{
          readonly name: string;
          readonly messages: ReadonlyArray<string>;
        }> = [];
        conversation.bystanders.forEach((entry, index) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          ) {
            issues.push(
              `conversation.bystanders[${String(index)}] must be an object`,
            );
            return;
          }
          const candidate = entry as {
            readonly name?: unknown;
            readonly messages?: unknown;
          };
          if (
            typeof candidate.name !== "string" ||
            candidate.name.length === 0
          ) {
            issues.push(
              `conversation.bystanders[${String(index)}].name must be a non-empty string`,
            );
            return;
          }
          parsed.push({
            name: candidate.name,
            messages:
              asStringList(
                candidate.messages,
                `conversation.bystanders[${String(index)}].messages`,
                issues,
              ) ?? [],
          });
        });
        bystanders = parsed;
      }
    }
  }

  let probeMessage: string | undefined;
  let probeSenderName: string | undefined;
  if (conversationKind === "cross") {
    if (
      typeof conversation?.probeMessage !== "string" ||
      conversation.probeMessage.length === 0
    ) {
      issues.push("conversation.probeMessage must be a non-empty string");
    } else {
      probeMessage = conversation.probeMessage;
    }
    if (
      conversation?.probeSenderName !== undefined &&
      (typeof conversation.probeSenderName !== "string" ||
        conversation.probeSenderName.length === 0)
    ) {
      issues.push("conversation.probeSenderName must be a non-empty string");
    } else if (typeof conversation?.probeSenderName === "string") {
      probeSenderName = conversation.probeSenderName;
    }
  }

  if (issues.length > 0) {
    return Effect.fail(failLoad(sourcePath, "InvalidPayload", { issues }));
  }

  const narrowedRuntimeKind: RuntimeKind =
    runtimeKind === "openclaw"
      ? "openclaw"
      : runtimeKind === "claude-code"
        ? "claude-code"
        : "nanoclaw";
  const targetAgentName =
    typeof runtime?.targetAgentName === "string"
      ? runtime.targetAgentName
      : undefined;
  const readyTimeoutMs =
    typeof runtime?.readyTimeoutMs === "number"
      ? runtime.readyTimeoutMs
      : undefined;
  const narrowedConversationKind =
    conversationKind === "group"
      ? "group"
      : conversationKind === "cross"
        ? "cross"
        : "direct";
  const setupMessage =
    typeof conversation?.setupMessage === "string"
      ? conversation.setupMessage
      : "";
  const senderName =
    typeof conversation?.senderName === "string"
      ? conversation.senderName
      : undefined;
  const groupName =
    typeof conversation?.groupName === "string"
      ? conversation.groupName
      : undefined;

  const runtimePayload = {
    kind: narrowedRuntimeKind,
    ...(targetAgentName !== undefined ? { targetAgentName } : {}),
    ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
  } satisfies HarnessPayload["runtime"];

  const conversationPayload =
    narrowedConversationKind === "group"
      ? ({
          kind: "group",
          setupMessage,
          followUpMessages,
          ...(senderName !== undefined ? { senderName } : {}),
          ...(groupName !== undefined ? { groupName } : {}),
          bystanders,
        } satisfies GroupConversationPayload)
      : narrowedConversationKind === "cross"
        ? ({
            kind: "cross",
            setupMessage,
            followUpMessages,
            ...(senderName !== undefined ? { senderName } : {}),
            ...(probeSenderName !== undefined ? { probeSenderName } : {}),
            probeMessage: probeMessage!,
          } satisfies CrossConversationPayload)
        : ({
            kind: "direct",
            setupMessage,
            followUpMessages,
            ...(senderName !== undefined ? { senderName } : {}),
          } satisfies DirectConversationPayload);

  return Effect.succeed({
    runtime: runtimePayload,
    conversation: conversationPayload,
  });
}

function defaultTargetAgentName(kind: RuntimeKind): string {
  switch (kind) {
    case "openclaw":
      return "openclaw-eval-agent";
    case "nanoclaw":
      return "nanoclaw-eval-agent";
    case "claude-code":
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

function waitForTargetResponse(input: {
  readonly client: HarnessClient;
  readonly targetAgentId: string;
  readonly conversationId: string;
  readonly timeoutMs: number;
}): Effect.Effect<
  ConversationResponse,
  {
    readonly cause: {
      readonly _tag: "HarnessFailed";
      readonly detail: {
        readonly _tag: "ExecutionFailed";
        readonly message: string;
      };
    };
  },
  never
> {
  return Effect.gen(function* () {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1_000, deadline - Date.now());
      const next = yield* Effect.either(
        input.client.waitForEvent("messages/received", remaining),
      );
      if (next._tag === "Left") {
        continue;
      }
      const data = next.right.data;
      if (
        data.message.senderId === input.targetAgentId &&
        data.message.conversationId === input.conversationId
      ) {
        return {
          conversationId: data.message.conversationId,
          senderId: data.message.senderId,
          text: extractTextFromEvent(data),
          messageId: data.message.id,
        };
      }
    }
    return yield* Effect.fail(
      failHarness(
        `timed out waiting for ${input.targetAgentId} in conversation ${input.conversationId}`,
      ),
    );
  });
}

function sendMessageAndWait(input: {
  readonly sender: ConnectedActor;
  readonly targetAgentId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly timeoutMs?: number;
}): Effect.Effect<
  ConversationResponse,
  {
    readonly cause: {
      readonly _tag: "HarnessFailed";
      readonly detail: {
        readonly _tag: "ExecutionFailed";
        readonly message: string;
      };
    };
  },
  never
> {
  return Effect.gen(function* () {
    yield* input.sender.client
      .sendRpc("messages/send", {
        conversationId: input.conversationId,
        parts: [{ type: "text", text: input.message }],
      })
      .pipe(Effect.mapError((error) => failHarness(error.message)));
    return yield* waitForTargetResponse({
      client: input.sender.client,
      targetAgentId: input.targetAgentId,
      conversationId: input.conversationId,
      timeoutMs: input.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
    });
  });
}

function registerConnectedAgent(
  clientModule: ClientTestModule,
  baseUrl: string,
  wsUrl: string,
  name: string,
): Effect.Effect<
  ConnectedActor,
  {
    readonly cause: {
      readonly _tag: "HarnessFailed";
      readonly detail: {
        readonly _tag: "ExecutionFailed";
        readonly message: string;
      };
    };
  },
  never
> {
  return clientModule.registerAndConnect(baseUrl, wsUrl, name).pipe(
    Effect.map((connected) => ({
      agentId: connected.agentId,
      name,
      client: connected.client,
    })),
    Effect.mapError((error) => failHarness(error.message)),
  );
}

function createDirectConversation(
  sender: ConnectedActor,
  targetAgentId: string,
): Effect.Effect<
  string,
  {
    readonly cause: {
      readonly _tag: "HarnessFailed";
      readonly detail: {
        readonly _tag: "ExecutionFailed";
        readonly message: string;
      };
    };
  },
  never
> {
  return sender.client
    .sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: targetAgentId }],
    })
    .pipe(
      Effect.map((result) => {
        const conversation = result as {
          readonly conversation: { readonly id: string };
        };
        return conversation.conversation.id;
      }),
      Effect.mapError((error) => failHarness(error.message)),
    );
}

function createGroupConversation(input: {
  readonly sender: ConnectedActor;
  readonly targetAgentId: string;
  readonly groupName: string;
  readonly participants: ReadonlyArray<ConnectedActor>;
}): Effect.Effect<
  string,
  {
    readonly cause: {
      readonly _tag: "HarnessFailed";
      readonly detail: {
        readonly _tag: "ExecutionFailed";
        readonly message: string;
      };
    };
  },
  never
> {
  return input.sender.client
    .sendRpc("conversations/create", {
      type: "group",
      name: input.groupName,
      participants: [
        { type: "agent", id: input.targetAgentId },
        ...input.participants.map((participant) => ({
          type: "agent",
          id: participant.agentId,
        })),
      ],
    })
    .pipe(
      Effect.map((result) => {
        const conversation = result as {
          readonly conversation: { readonly id: string };
        };
        return conversation.conversation.id;
      }),
      Effect.mapError((error) => failHarness(error.message)),
    );
}

function executeConversationPlan(input: {
  readonly payload: HarnessPayload;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly targetAgentId: string;
  readonly clientModule: ClientTestModule;
}): Effect.Effect<
  {
    readonly participants: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly role: string;
    }>;
    readonly responses: ReadonlyArray<ConversationResponse>;
  },
  {
    readonly cause: Readonly<Record<string, unknown>>;
  },
  never
> {
  return Effect.gen(function* () {
    const sender = yield* registerConnectedAgent(
      input.clientModule,
      input.baseUrl,
      input.wsUrl,
      input.payload.conversation.senderName ?? "eval-sender",
    );
    const closers: Array<HarnessClient> = [sender.client];
    const participants: Array<{
      readonly id: string;
      readonly name: string;
      readonly role: string;
    }> = [{ id: sender.agentId, name: sender.name, role: "sender" }];
    const responses: Array<ConversationResponse> = [];

    try {
      switch (input.payload.conversation.kind) {
        case "direct": {
          const conversationId = yield* createDirectConversation(
            sender,
            input.targetAgentId,
          );
          responses.push(
            yield* sendMessageAndWait({
              sender,
              targetAgentId: input.targetAgentId,
              conversationId,
              message: input.payload.conversation.setupMessage,
            }),
          );
          for (const followUp of input.payload.conversation.followUpMessages) {
            responses.push(
              yield* sendMessageAndWait({
                sender,
                targetAgentId: input.targetAgentId,
                conversationId,
                message: followUp,
              }),
            );
          }
          break;
        }
        case "group": {
          const bystanders = yield* Effect.forEach(
            input.payload.conversation.bystanders,
            (entry) =>
              registerConnectedAgent(
                input.clientModule,
                input.baseUrl,
                input.wsUrl,
                entry.name,
              ).pipe(
                Effect.map((actor) => ({
                  actor,
                  messages: entry.messages,
                })),
              ),
            { concurrency: 1 },
          );
          for (const bystander of bystanders) {
            closers.push(bystander.actor.client);
            participants.push({
              id: bystander.actor.agentId,
              name: bystander.actor.name,
              role: "bystander",
            });
          }
          const conversationId = yield* createGroupConversation({
            sender,
            targetAgentId: input.targetAgentId,
            groupName:
              input.payload.conversation.groupName ?? DEFAULT_GROUP_NAME,
            participants: bystanders.map((entry) => entry.actor),
          });
          for (const bystander of bystanders) {
            for (const message of bystander.messages) {
              yield* sendMessageAndWait({
                sender: bystander.actor,
                targetAgentId: input.targetAgentId,
                conversationId,
                message,
              });
            }
          }
          responses.push(
            yield* sendMessageAndWait({
              sender,
              targetAgentId: input.targetAgentId,
              conversationId,
              message: input.payload.conversation.setupMessage,
            }),
          );
          for (const followUp of input.payload.conversation.followUpMessages) {
            responses.push(
              yield* sendMessageAndWait({
                sender,
                targetAgentId: input.targetAgentId,
                conversationId,
                message: followUp,
              }),
            );
          }
          break;
        }
        case "cross": {
          const firstConversationId = yield* createDirectConversation(
            sender,
            input.targetAgentId,
          );
          responses.push(
            yield* sendMessageAndWait({
              sender,
              targetAgentId: input.targetAgentId,
              conversationId: firstConversationId,
              message: input.payload.conversation.setupMessage,
            }),
          );
          for (const followUp of input.payload.conversation.followUpMessages) {
            responses.push(
              yield* sendMessageAndWait({
                sender,
                targetAgentId: input.targetAgentId,
                conversationId: firstConversationId,
                message: followUp,
              }),
            );
          }
          const probeSender = yield* registerConnectedAgent(
            input.clientModule,
            input.baseUrl,
            input.wsUrl,
            input.payload.conversation.probeSenderName ?? "eval-probe-sender",
          );
          closers.push(probeSender.client);
          participants.push({
            id: probeSender.agentId,
            name: probeSender.name,
            role: "probe",
          });
          const secondConversationId = yield* createDirectConversation(
            probeSender,
            input.targetAgentId,
          );
          responses.push(
            yield* sendMessageAndWait({
              sender: probeSender,
              targetAgentId: input.targetAgentId,
              conversationId: secondConversationId,
              message: input.payload.conversation.probeMessage,
            }),
          );
          break;
        }
      }
      return { participants, responses };
    } finally {
      for (const client of [...closers].reverse()) {
        yield* closeClient(client);
      }
    }
  });
}

function toBundleEvent(
  event: TraceCaptureEvent,
  namesById: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const text = event.message.parts
    .filter(
      (part): part is MessagePart & { readonly text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
  return {
    type: "message",
    from: event.senderDisplayName,
    ...(event.recipientAgentIds.length === 1
      ? {
          to:
            namesById.get(event.recipientAgentIds[0]!) ??
            event.recipientAgentIds[0]!,
        }
      : {}),
    channel: event.channelKey,
    text,
    ts: Date.parse(event.message.createdAt),
  };
}

function withExclusiveRun<A, E>(
  effect: Effect.Effect<A, E, never>,
): Effect.Effect<
  A,
  | E
  | {
      readonly cause: {
        readonly _tag: "HarnessFailed";
        readonly detail: {
          readonly _tag: "ExecutionFailed";
          readonly message: string;
        };
      };
    },
  never
> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        if (activeRun) {
          throw new Error(
            "MoltZap trace-capture harness only supports one active run at a time",
          );
        }
        activeRun = true;
      },
      catch: (error) =>
        failHarness(error instanceof Error ? error.message : String(error)),
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        activeRun = false;
      }),
  );
}

function createCoordinator(sourcePath: string, payload: HarnessPayload) {
  return {
    execute(
      plan: HarnessLoadArgs["plan"],
      _harness: unknown,
      opts: { readonly runId?: string } = {},
    ): Effect.Effect<
      Readonly<Record<string, unknown>>,
      {
        readonly cause: Readonly<Record<string, unknown>>;
      },
      never
    > {
      return withExclusiveRun(
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const [serverIndexModule, serverTestModule] = yield* Effect.all([
              loadServerIndexModule(),
              loadServerTestModule(),
            ]);
            const server = yield* Effect.tryPromise({
              try: () =>
                Promise.resolve(
                  serverTestModule.startCoreTestServer({
                    traceCaptureLayer:
                      serverIndexModule.InMemoryTraceCaptureLive,
                  }),
                ) as Promise<CoreTestServer>,
              catch: (error) =>
                failHarness(
                  error instanceof Error ? error.message : String(error),
                ),
            });
            return { server, serverTestModule };
          }),
          ({ server }) =>
            Effect.gen(function* () {
              const clientModule = yield* loadClientTestModule().pipe(
                Effect.mapError((error) =>
                  failHarness(
                    error instanceof Error ? error.message : String(error),
                  ),
                ),
              );
              const targetAgentName =
                payload.runtime.targetAgentName ??
                defaultTargetAgentName(payload.runtime.kind);
              const targetAgent = yield* clientModule
                .registerAgent(server.baseUrl, targetAgentName)
                .pipe(
                  Effect.map((registered) => ({
                    agentId: registered.agentId,
                    apiKey: registered.apiKey,
                    agentName: targetAgentName,
                  })),
                  Effect.mapError((error) => failHarness(error.message)),
                );
              const runtimeStartedAt = new Date().toISOString();
              return yield* Effect.acquireUseRelease(
                startRuntimeAgent({
                  kind: payload.runtime.kind,
                  server: server.coreApp,
                  readyTimeoutMs:
                    payload.runtime.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
                  agent: {
                    agentName: targetAgent.agentName,
                    apiKey: targetAgent.apiKey,
                    agentId: targetAgent.agentId,
                    serverUrl: clientModule.stripWsPath(server.wsUrl),
                  },
                }).pipe(
                  Effect.mapError((error) => {
                    switch (error._tag) {
                      case "SpawnFailed":
                        return failAgentStart({
                          _tag: "ContainerStartFailed",
                          message: error.message,
                        });
                      case "RuntimeReadyTimedOut":
                        return failAgentStart({
                          _tag: "ContainerStartFailed",
                          message: `runtime did not authenticate within ${String(error.timeoutMs)}ms`,
                        });
                      case "RuntimeExitedBeforeReady":
                        return failAgentStart({
                          _tag: "ContainerStartFailed",
                          message: `runtime exited before readiness: ${error.stderr}`,
                        });
                    }
                  }),
                ),
                (_runtime: Runtime) =>
                  Effect.gen(function* () {
                    const conversationRun = yield* executeConversationPlan({
                      payload,
                      baseUrl: server.baseUrl,
                      wsUrl: server.wsUrl,
                      targetAgentId: targetAgent.agentId,
                      clientModule,
                    });
                    const traceEvents =
                      yield* server.coreApp.traceCapture.snapshot();
                    const participantNames = conversationRun.participants.map(
                      (participant): readonly [string, string] => [
                        participant.id,
                        participant.name,
                      ],
                    );
                    const namesById = new Map<string, string>([
                      [targetAgent.agentId, targetAgent.agentName],
                      ...participantNames,
                    ]);
                    const events = traceEvents.map((event) =>
                      toBundleEvent(event, namesById),
                    );
                    return {
                      runId: opts.runId ?? randomUUID(),
                      project: plan.project,
                      scenarioId: plan.scenarioId,
                      name: plan.name,
                      description: plan.description,
                      requirements: plan.requirements,
                      agents: [
                        {
                          id: targetAgent.agentId,
                          name: targetAgent.agentName,
                          role: "target",
                        },
                        ...conversationRun.participants,
                      ],
                      ...(events.length > 0 ? { events } : {}),
                      context: {
                        runtimeKind: payload.runtime.kind,
                        conversationKind: payload.conversation.kind,
                        responses: conversationRun.responses,
                      },
                      outcomes: [
                        {
                          agentId: targetAgent.agentId,
                          status: "completed",
                          startedAt: runtimeStartedAt,
                          endedAt: new Date().toISOString(),
                        },
                        ...conversationRun.participants.map((participant) => ({
                          agentId: participant.id,
                          status: "completed",
                          startedAt: runtimeStartedAt,
                          endedAt: new Date().toISOString(),
                        })),
                      ],
                      metadata: {
                        modelName: `moltzap/${payload.runtime.kind}`,
                        sourcePath,
                      },
                    };
                  }),
                (runtime) => runtime.teardown(),
              );
            }),
          ({ serverTestModule }) =>
            Effect.tryPromise({
              try: () => Promise.resolve(serverTestModule.stopCoreTestServer()),
              catch: (error) =>
                error instanceof Error ? error : new Error(String(error)),
            }).pipe(Effect.catchAll(() => Effect.void)),
        ),
      ).pipe(Effect.mapError(asHarnessFailure));
    },
  };
}

const traceCaptureHarness = {
  load(args: HarnessLoadArgs) {
    return decodePayload(args.sourcePath, args.payload).pipe(
      Effect.map((payload) => {
        const targetAgentName =
          payload.runtime.targetAgentName ??
          defaultTargetAgentName(payload.runtime.kind);
        return {
          plan: {
            project: args.plan.project,
            scenarioId: args.plan.scenarioId,
            name: args.plan.name,
            description: args.plan.description,
            agents: [
              {
                id: PLACEHOLDER_AGENT_ID,
                name: targetAgentName,
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
              },
            ],
            requirements: args.plan.requirements,
            metadata: {
              ...args.plan.metadata,
              harness: "moltzap-trace-capture",
              conversationKind: payload.conversation.kind,
              runtimeKind: payload.runtime.kind,
            },
          },
          harness: {
            name: "moltzap-trace-capture",
            run: () =>
              Effect.fail({
                _tag: "ExecutionFailed",
                message:
                  "MoltZap trace-capture plans require the custom coordinator path",
              }),
          },
          coordinator: createCoordinator(args.sourcePath, payload),
        };
      }),
    );
  },
};

export default traceCaptureHarness;
