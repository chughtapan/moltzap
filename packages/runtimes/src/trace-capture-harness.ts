import { Path } from "@effect/platform";
import { Data, Effect, Either } from "effect";
import { startRuntimeAgent, type RuntimeKind } from "./fleet.js";
import { RuntimeReadyTimedOut, SpawnFailed } from "./errors.js";
import type { Runtime } from "./runtime.js";

import {
  type AnyRpcDefinition,
  ConversationsCreate,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  type DecodedNotification,
  type ParamsOf,
  type ResultOf,
} from "@moltzap/protocol";
import { conversationId } from "@moltzap/protocol/testing";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const MIN_EVENT_WAIT_MS = 1_000;
const DEFAULT_GROUP_NAME = "cc-judge-group";
const PLACEHOLDER_AGENT_ID = "target-agent";
const PLACEHOLDER_IMAGE = "managed/by-moltzap-trace-capture";
const RUNTIME_KIND_CLAUDE_CODE = "claude-code";

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

class InvalidPayload extends Data.TaggedError("InvalidPayload")<{
  readonly path: string;
  readonly issues: readonly string[];
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
  waitForNotification(
    definition: typeof MessageReceivedNotificationDefinition,
    timeoutMs: number,
  ): Effect.Effect<
    DecodedNotification<typeof MessageReceivedNotificationDefinition>,
    Error,
    never
  >;
  sendRpc<D extends AnyRpcDefinition>(
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

type RuntimeCandidate = {
  readonly kind?: unknown;
  readonly targetAgentName?: unknown;
  readonly readyTimeoutMs?: unknown;
};

type ConversationCandidate = {
  readonly kind?: unknown;
  readonly setupMessage?: unknown;
  readonly followUpMessages?: unknown;
  readonly senderName?: unknown;
  readonly groupName?: unknown;
  readonly bystanders?: unknown;
  readonly probeMessage?: unknown;
  readonly probeSenderName?: unknown;
};

type BystanderPayload = GroupConversationPayload["bystanders"][number];
type PayloadCandidate = {
  readonly runtime?: unknown;
  readonly conversation?: unknown;
};
type BystanderCandidate = {
  readonly name?: unknown;
  readonly messages?: unknown;
};

function failLoad(
  pathValue: string,
  issues: readonly string[],
): HarnessFailure {
  return { cause: new InvalidPayload({ path: pathValue, issues }) };
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
  return (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    (error.cause instanceof InvalidPayload ||
      error.cause instanceof HarnessFailed ||
      error.cause instanceof AgentStartFailed)
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

function isObjectCandidate(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPayloadCandidate(value: unknown): value is PayloadCandidate {
  return isObjectCandidate(value);
}

function isRuntimeCandidate(value: unknown): value is RuntimeCandidate {
  return isObjectCandidate(value);
}

function isConversationCandidate(
  value: unknown,
): value is ConversationCandidate {
  return isObjectCandidate(value);
}

function isBystanderCandidate(value: unknown): value is BystanderCandidate {
  return isObjectCandidate(value);
}

function decodeRuntimeCandidate(
  value: unknown,
  issues: Array<string>,
): RuntimeCandidate | undefined {
  if (!isRuntimeCandidate(value)) {
    issues.push("runtime must be an object");
    return undefined;
  }
  return value;
}

function decodeConversationCandidate(
  value: unknown,
  issues: Array<string>,
): ConversationCandidate | undefined {
  if (!isConversationCandidate(value)) {
    issues.push("conversation must be an object");
    return undefined;
  }
  return value;
}

function validateRuntime(
  runtime: RuntimeCandidate | undefined,
  issues: Array<string>,
): void {
  const runtimeKind = runtime?.kind;
  if (
    runtimeKind !== "openclaw" &&
    runtimeKind !== "nanoclaw" &&
    runtimeKind !== RUNTIME_KIND_CLAUDE_CODE
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
}

function validateConversationBase(
  conversation: ConversationCandidate | undefined,
  issues: Array<string>,
): void {
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
  if (
    conversation?.senderName !== undefined &&
    (typeof conversation.senderName !== "string" ||
      conversation.senderName.length === 0)
  ) {
    issues.push("conversation.senderName must be a non-empty string");
  }
}

function decodeBystander(
  entry: unknown,
  index: number,
  issues: Array<string>,
): BystanderPayload | undefined {
  if (!isBystanderCandidate(entry)) {
    issues.push(`conversation.bystanders[${String(index)}] must be an object`);
    return undefined;
  }
  if (typeof entry.name !== "string" || entry.name.length === 0) {
    issues.push(
      `conversation.bystanders[${String(index)}].name must be a non-empty string`,
    );
    return undefined;
  }
  return {
    name: entry.name,
    messages:
      asStringList(
        entry.messages,
        `conversation.bystanders[${String(index)}].messages`,
        issues,
      ) ?? [],
  };
}

function decodeGroupBystanders(
  conversation: ConversationCandidate | undefined,
  issues: Array<string>,
): ReadonlyArray<BystanderPayload> {
  if (conversation?.kind !== "group") return [];
  if (
    conversation.groupName !== undefined &&
    (typeof conversation.groupName !== "string" ||
      conversation.groupName.length === 0)
  ) {
    issues.push("conversation.groupName must be a non-empty string");
  }
  if (conversation.bystanders === undefined) return [];
  if (!Array.isArray(conversation.bystanders)) {
    issues.push("conversation.bystanders must be an array");
    return [];
  }

  const parsed: Array<BystanderPayload> = [];
  for (const [index, entry] of conversation.bystanders.entries()) {
    const bystander = decodeBystander(entry, index, issues);
    if (bystander !== undefined) parsed.push(bystander);
  }
  return parsed;
}

function decodeCrossProbe(
  conversation: ConversationCandidate | undefined,
  issues: Array<string>,
): {
  readonly probeMessage?: string;
  readonly probeSenderName?: string;
} {
  if (conversation?.kind !== "cross") return {};
  let probeMessage: string | undefined;
  let probeSenderName: string | undefined;
  if (
    typeof conversation.probeMessage !== "string" ||
    conversation.probeMessage.length === 0
  ) {
    issues.push("conversation.probeMessage must be a non-empty string");
  } else {
    probeMessage = conversation.probeMessage;
  }
  if (
    conversation.probeSenderName !== undefined &&
    (typeof conversation.probeSenderName !== "string" ||
      conversation.probeSenderName.length === 0)
  ) {
    issues.push("conversation.probeSenderName must be a non-empty string");
  } else if (typeof conversation.probeSenderName === "string") {
    probeSenderName = conversation.probeSenderName;
  }
  return { probeMessage, probeSenderName };
}

function narrowRuntimeKind(kind: unknown): RuntimeKind {
  switch (kind) {
    case "openclaw":
      return "openclaw";
    case RUNTIME_KIND_CLAUDE_CODE:
      return RUNTIME_KIND_CLAUDE_CODE;
    default:
      return "nanoclaw";
  }
}

function narrowConversationKind(kind: unknown): ConversationPayload["kind"] {
  switch (kind) {
    case "group":
      return "group";
    case "cross":
      return "cross";
    default:
      return "direct";
  }
}

function buildRuntimePayload(
  runtime: RuntimeCandidate | undefined,
): HarnessPayload["runtime"] {
  const targetAgentName =
    typeof runtime?.targetAgentName === "string"
      ? runtime.targetAgentName
      : undefined;
  const readyTimeoutMs =
    typeof runtime?.readyTimeoutMs === "number"
      ? runtime.readyTimeoutMs
      : undefined;
  return {
    kind: narrowRuntimeKind(runtime?.kind),
    ...(targetAgentName !== undefined ? { targetAgentName } : {}),
    ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
  };
}

function buildConversationPayload(input: {
  readonly conversation: ConversationCandidate | undefined;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly bystanders: ReadonlyArray<BystanderPayload>;
  readonly probeMessage: string | undefined;
  readonly probeSenderName: string | undefined;
}): ConversationPayload {
  const conversationKind = narrowConversationKind(input.conversation?.kind);
  const setupMessage =
    typeof input.conversation?.setupMessage === "string"
      ? input.conversation.setupMessage
      : "";
  const senderName =
    typeof input.conversation?.senderName === "string"
      ? input.conversation.senderName
      : undefined;
  const groupName =
    typeof input.conversation?.groupName === "string"
      ? input.conversation.groupName
      : undefined;

  switch (conversationKind) {
    case "group":
      return {
        kind: "group",
        setupMessage,
        followUpMessages: input.followUpMessages,
        ...(senderName !== undefined ? { senderName } : {}),
        ...(groupName !== undefined ? { groupName } : {}),
        bystanders: input.bystanders,
      };
    case "cross":
      return {
        kind: "cross",
        setupMessage,
        followUpMessages: input.followUpMessages,
        ...(senderName !== undefined ? { senderName } : {}),
        ...(input.probeSenderName !== undefined
          ? { probeSenderName: input.probeSenderName }
          : {}),
        probeMessage: input.probeMessage ?? "",
      };
    case "direct":
      return {
        kind: "direct",
        setupMessage,
        followUpMessages: input.followUpMessages,
        ...(senderName !== undefined ? { senderName } : {}),
      };
  }
}

function decodePayload(
  sourcePath: string,
  payload: unknown,
): Effect.Effect<HarnessPayload, HarnessFailure, never> {
  const issues: Array<string> = [];
  const candidatePayload = isPayloadCandidate(payload) ? payload : undefined;
  if (candidatePayload === undefined) {
    issues.push("payload must be an object");
  }

  const runtime = decodeRuntimeCandidate(candidatePayload?.runtime, issues);
  validateRuntime(runtime, issues);
  const conversation = decodeConversationCandidate(
    candidatePayload?.conversation,
    issues,
  );
  validateConversationBase(conversation, issues);
  const followUpMessages =
    asStringList(
      conversation?.followUpMessages,
      "conversation.followUpMessages",
      issues,
    ) ?? [];
  const bystanders = decodeGroupBystanders(conversation, issues);
  const { probeMessage, probeSenderName } = decodeCrossProbe(
    conversation,
    issues,
  );

  if (issues.length > 0) {
    return Effect.fail(failLoad(sourcePath, issues));
  }

  return Effect.succeed({
    runtime: buildRuntimePayload(runtime),
    conversation: buildConversationPayload({
      conversation,
      followUpMessages,
      bystanders,
      probeMessage,
      probeSenderName,
    }),
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

function waitForTargetResponse(input: {
  readonly client: HarnessClient;
  readonly targetAgentId: string;
  readonly conversationId: string;
  readonly timeoutMs: number;
}): Effect.Effect<ConversationResponse, HarnessFailure, never> {
  return Effect.gen(function* () {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(MIN_EVENT_WAIT_MS, deadline - Date.now());
      const next = yield* Effect.either(
        input.client.waitForNotification(
          MessageReceivedNotificationDefinition,
          remaining,
        ),
      );
      const data = Either.match(next, {
        onLeft: () => null,
        onRight: (event) => event.params,
      });
      if (data === null) {
        continue;
      }
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
}): Effect.Effect<ConversationResponse, HarnessFailure, never> {
  return Effect.gen(function* () {
    yield* input.sender.client
      .sendRpc(MessagesSend, {
        conversationId: conversationId(input.conversationId),
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

function createDirectConversation(
  sender: ConnectedActor,
  targetAgentId: string,
): Effect.Effect<string, HarnessFailure, never> {
  return sender.client
    .sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: targetAgentId }],
    })
    .pipe(
      Effect.map((result) => result.conversation.id),
      Effect.mapError((error) => failHarness(error.message)),
    );
}

function createGroupConversation(input: {
  readonly sender: ConnectedActor;
  readonly targetAgentId: string;
  readonly groupName: string;
  readonly participants: ReadonlyArray<ConnectedActor>;
}): Effect.Effect<string, HarnessFailure, never> {
  return input.sender.client
    .sendRpc(ConversationsCreate, {
      type: "group",
      name: input.groupName,
      participants: [
        { type: "agent", id: input.targetAgentId },
        ...input.participants.map((participant) => ({
          type: "agent" as const,
          id: participant.agentId,
        })),
      ],
    })
    .pipe(
      Effect.map((result) => result.conversation.id),
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
  HarnessFailure,
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

interface ConversationRun {
  readonly participants: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly role: string;
  }>;
  readonly responses: ReadonlyArray<ConversationResponse>;
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

function participantNameEntry(participant: {
  readonly id: string;
  readonly name: string;
}): readonly [string, string] {
  return [participant.id, participant.name];
}

function buildTraceBundle(input: {
  readonly sourcePath: string;
  readonly payload: HarnessPayload;
  readonly plan: HarnessLoadArgs["plan"];
  readonly runId: string;
  readonly targetAgent: TargetAgentRegistration;
  readonly runtimeStartedAt: string;
  readonly traceEvents: readonly TraceCaptureEvent[];
  readonly conversationRun: ConversationRun;
}): Readonly<Record<string, unknown>> {
  const namesById = new Map<string, string>([
    [input.targetAgent.agentId, input.targetAgent.agentName],
    ...input.conversationRun.participants.map(participantNameEntry),
  ]);
  const events = input.traceEvents.map((event) =>
    toBundleEvent(event, namesById),
  );
  const endedAt = new Date().toISOString();
  return {
    runId: input.runId,
    project: input.plan.project,
    scenarioId: input.plan.scenarioId,
    name: input.plan.name,
    description: input.plan.description,
    requirements: input.plan.requirements,
    agents: [
      {
        id: input.targetAgent.agentId,
        name: input.targetAgent.agentName,
        role: "target",
      },
      ...input.conversationRun.participants,
    ],
    ...(events.length > 0 ? { events } : {}),
    context: {
      runtimeKind: input.payload.runtime.kind,
      conversationKind: input.payload.conversation.kind,
      responses: input.conversationRun.responses,
    },
    outcomes: [
      {
        agentId: input.targetAgent.agentId,
        status: "completed",
        startedAt: input.runtimeStartedAt,
        endedAt,
      },
      ...input.conversationRun.participants.map((participant) => ({
        agentId: participant.id,
        status: "completed",
        startedAt: input.runtimeStartedAt,
        endedAt,
      })),
    ],
    metadata: {
      modelName: `moltzap/${input.payload.runtime.kind}`,
      sourcePath: input.sourcePath,
    },
  };
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

function createCoordinator(sourcePath: string, payload: HarnessPayload) {
  return {
    execute(
      plan: HarnessLoadArgs["plan"],
      _harness: unknown,
      opts: { readonly runId?: string } = {},
    ): Effect.Effect<Readonly<Record<string, unknown>>, HarnessFailure, never> {
      return withExclusiveRun(
        Effect.gen(function* () {
          const [serverIndexModule, serverTestModule] = yield* Effect.all([
            loadServerIndexModule(),
            loadServerTestModule(),
          ]);
          const server = yield* startCoreTraceServer(
            serverIndexModule,
            serverTestModule,
          );
          return yield* Effect.gen(function* () {
            const clientModule = yield* loadHarnessClientModule();
            const targetAgentName =
              payload.runtime.targetAgentName ??
              defaultTargetAgentName(payload.runtime.kind);
            const targetAgent = yield* registerTargetAgent({
              clientModule,
              baseUrl: server.baseUrl,
              targetAgentName,
            });
            const runtimeStartedAt = new Date().toISOString();
            const runtime = yield* startHarnessRuntime({
              payload,
              server,
              targetAgent,
              clientModule,
            });
            return yield* executeTraceRun({
              sourcePath,
              payload,
              plan,
              runId: opts.runId,
              server,
              clientModule,
              targetAgent,
              runtime,
              runtimeStartedAt,
            });
          }).pipe(Effect.ensuring(stopCoreTraceServer(serverTestModule)));
        }),
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
              Effect.fail(
                new ExecutionFailed({
                  message:
                    "MoltZap trace-capture plans require the custom coordinator path",
                }),
              ),
          },
          coordinator: createCoordinator(args.sourcePath, payload),
        };
      }),
    );
  },
};

export default traceCaptureHarness;
