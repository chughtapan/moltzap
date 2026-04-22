import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  registerAgent,
  registerAndConnect,
  stripWsPath,
} from "../client/dist/test/index.js";
import { InMemoryTraceCaptureLive } from "../server/dist/index.js";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "../server/dist/test-utils/server.js";
import {
  NanoclawAdapter,
  createWorkspaceOpenClawAdapter,
} from "../runtimes/dist/index.js";

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_GROUP_NAME = "cc-judge-group";
const PLACEHOLDER_AGENT_ID = "target-agent";
const PLACEHOLDER_IMAGE = "managed/by-moltzap-trace-capture";

let activeRun = false;

function failLoad(path, tag, detail) {
  return { cause: { _tag: tag, path, ...detail } };
}

function failHarness(message) {
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

function failAgentStart(detail) {
  return {
    cause: {
      _tag: "AgentStartFailed",
      agentId: PLACEHOLDER_AGENT_ID,
      detail,
    },
  };
}

function asStringList(value, field, issues) {
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

function decodePayload(sourcePath, payload) {
  const issues = [];
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    issues.push("payload must be an object");
  }
  const runtime = payload?.runtime;
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    Array.isArray(runtime)
  ) {
    issues.push("runtime must be an object");
  }
  const runtimeKind = runtime?.kind;
  if (runtimeKind !== "openclaw" && runtimeKind !== "nanoclaw") {
    issues.push("runtime.kind must be 'openclaw' or 'nanoclaw'");
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
    (!Number.isInteger(runtime.readyTimeoutMs) || runtime.readyTimeoutMs <= 0)
  ) {
    issues.push("runtime.readyTimeoutMs must be a positive integer");
  }

  const conversation = payload?.conversation;
  if (
    typeof conversation !== "object" ||
    conversation === null ||
    Array.isArray(conversation)
  ) {
    issues.push("conversation must be an object");
  }
  const conversationKind = conversation?.kind;
  if (!["direct", "group", "cross"].includes(conversationKind)) {
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
  let bystanders = [];
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
        bystanders = conversation.bystanders.flatMap((entry, index) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          ) {
            issues.push(
              `conversation.bystanders[${String(index)}] must be an object`,
            );
            return [];
          }
          if (typeof entry.name !== "string" || entry.name.length === 0) {
            issues.push(
              `conversation.bystanders[${String(index)}].name must be a non-empty string`,
            );
            return [];
          }
          const messages =
            asStringList(
              entry.messages,
              `conversation.bystanders[${String(index)}].messages`,
              issues,
            ) ?? [];
          return [{ name: entry.name, messages }];
        });
      }
    }
  }
  let probeMessage;
  let probeSenderName;
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
    } else {
      probeSenderName = conversation?.probeSenderName;
    }
  }

  if (issues.length > 0) {
    return Effect.fail(failLoad(sourcePath, "InvalidPayload", { issues }));
  }

  return Effect.succeed({
    runtime: {
      kind: runtimeKind,
      targetAgentName: runtime.targetAgentName,
      readyTimeoutMs: runtime.readyTimeoutMs,
    },
    conversation:
      conversationKind === "group"
        ? {
            kind: "group",
            setupMessage: conversation.setupMessage,
            followUpMessages,
            senderName: conversation.senderName,
            groupName: conversation.groupName,
            bystanders,
          }
        : conversationKind === "cross"
          ? {
              kind: "cross",
              setupMessage: conversation.setupMessage,
              followUpMessages,
              senderName: conversation.senderName,
              probeSenderName,
              probeMessage,
            }
          : {
              kind: "direct",
              setupMessage: conversation.setupMessage,
              followUpMessages,
              senderName: conversation.senderName,
            },
  });
}

function defaultTargetAgentName(kind) {
  return kind === "openclaw" ? "openclaw-eval-agent" : "nanoclaw-eval-agent";
}

function closeClient(client) {
  return client.close().pipe(Effect.orElseSucceed(() => undefined));
}

function extractTextFromEvent(data) {
  return data.message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function waitForTargetResponse({
  client,
  targetAgentId,
  conversationId,
  timeoutMs,
}) {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1_000, deadline - Date.now());
      const next = yield* Effect.either(
        client.waitForEvent("messages/received", remaining),
      );
      if (next._tag === "Left") {
        continue;
      }
      const data = next.right.data;
      if (
        data.message.senderId === targetAgentId &&
        data.message.conversationId === conversationId
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
        `timed out waiting for ${targetAgentId} in conversation ${conversationId}`,
      ),
    );
  });
}

function sendMessageAndWait({
  sender,
  targetAgentId,
  conversationId,
  message,
  timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
}) {
  return Effect.gen(function* () {
    yield* sender.client.sendRpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: message }],
    });
    return yield* waitForTargetResponse({
      client: sender.client,
      targetAgentId,
      conversationId,
      timeoutMs,
    });
  });
}

function registerConnectedAgent(baseUrl, wsUrl, name) {
  return registerAndConnect(baseUrl, wsUrl, name).pipe(
    Effect.mapError((error) => failHarness(error.message)),
  );
}

function createDirectConversation(sender, targetAgentId) {
  return sender.client
    .sendRpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: targetAgentId }],
    })
    .pipe(
      Effect.map((result) => result.conversation.id),
      Effect.mapError((error) => failHarness(error.message)),
    );
}

function createGroupConversation({
  sender,
  targetAgentId,
  groupName,
  participants,
}) {
  return sender.client
    .sendRpc("conversations/create", {
      type: "group",
      name: groupName,
      participants: [
        { type: "agent", id: targetAgentId },
        ...participants.map((participant) => ({
          type: "agent",
          id: participant.agentId,
        })),
      ],
    })
    .pipe(
      Effect.map((result) => result.conversation.id),
      Effect.mapError((error) => failHarness(error.message)),
    );
}

function executeConversationPlan({ payload, baseUrl, wsUrl, targetAgentId }) {
  return Effect.gen(function* () {
    const sender = yield* registerConnectedAgent(
      baseUrl,
      wsUrl,
      payload.conversation.senderName ?? "eval-sender",
    );
    const closers = [sender.client];
    const participants = [
      { id: sender.agentId, name: sender.name, role: "sender" },
    ];
    const responses = [];

    try {
      switch (payload.conversation.kind) {
        case "direct": {
          const conversationId = yield* createDirectConversation(
            sender,
            targetAgentId,
          );
          responses.push(
            yield* sendMessageAndWait({
              sender,
              targetAgentId,
              conversationId,
              message: payload.conversation.setupMessage,
            }),
          );
          for (const followUp of payload.conversation.followUpMessages) {
            responses.push(
              yield* sendMessageAndWait({
                sender,
                targetAgentId,
                conversationId,
                message: followUp,
              }),
            );
          }
          break;
        }
        case "group": {
          const bystanders = yield* Effect.forEach(
            payload.conversation.bystanders ?? [],
            (entry) =>
              registerConnectedAgent(baseUrl, wsUrl, entry.name).pipe(
                Effect.map((actor) => ({
                  actor,
                  messages: entry.messages ?? [],
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
            targetAgentId,
            groupName: payload.conversation.groupName ?? DEFAULT_GROUP_NAME,
            participants: bystanders.map((entry) => entry.actor),
          });
          for (const bystander of bystanders) {
            for (const message of bystander.messages) {
              yield* sendMessageAndWait({
                sender: bystander.actor,
                targetAgentId,
                conversationId,
                message,
              });
            }
          }
          responses.push(
            yield* sendMessageAndWait({
              sender,
              targetAgentId,
              conversationId,
              message: payload.conversation.setupMessage,
            }),
          );
          for (const followUp of payload.conversation.followUpMessages) {
            responses.push(
              yield* sendMessageAndWait({
                sender,
                targetAgentId,
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
            targetAgentId,
          );
          responses.push(
            yield* sendMessageAndWait({
              sender,
              targetAgentId,
              conversationId: firstConversationId,
              message: payload.conversation.setupMessage,
            }),
          );
          for (const followUp of payload.conversation.followUpMessages) {
            responses.push(
              yield* sendMessageAndWait({
                sender,
                targetAgentId,
                conversationId: firstConversationId,
                message: followUp,
              }),
            );
          }
          const probeSender = yield* registerConnectedAgent(
            baseUrl,
            wsUrl,
            payload.conversation.probeSenderName ?? "eval-probe-sender",
          );
          closers.push(probeSender.client);
          participants.push({
            id: probeSender.agentId,
            name: probeSender.name,
            role: "probe",
          });
          const secondConversationId = yield* createDirectConversation(
            probeSender,
            targetAgentId,
          );
          responses.push(
            yield* sendMessageAndWait({
              sender: probeSender,
              targetAgentId,
              conversationId: secondConversationId,
              message: payload.conversation.probeMessage,
            }),
          );
          break;
        }
      }
      return { participants, responses };
    } finally {
      for (const client of closers.reverse()) {
        yield* closeClient(client);
      }
    }
  });
}

function toBundleEvent(event, namesById) {
  if (event._tag !== "Message") {
    return null;
  }
  const text = event.message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return {
    type: "message",
    from: namesById.get(event.message.senderId) ?? event.message.senderId,
    ...(event.recipientAgentIds.length === 1
      ? {
          to:
            namesById.get(event.recipientAgentIds[0]) ??
            event.recipientAgentIds[0],
        }
      : {}),
    channel: event.message.conversationId,
    text,
    ts: Date.parse(event.message.createdAt),
  };
}

function withExclusiveRun(effect) {
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

function startRuntime(serverHandle, payload, targetAgent, wsUrl) {
  const runtime =
    payload.runtime.kind === "openclaw"
      ? createWorkspaceOpenClawAdapter({ server: serverHandle })
      : new NanoclawAdapter({ server: serverHandle });
  return Effect.gen(function* () {
    yield* runtime.spawn({
      agentName: targetAgent.agentName,
      apiKey: targetAgent.apiKey,
      agentId: targetAgent.agentId,
      serverUrl: stripWsPath(wsUrl),
    });
    const ready = yield* runtime.waitUntilReady(
      payload.runtime.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    );
    switch (ready._tag) {
      case "Ready":
        return runtime;
      case "Timeout":
        return yield* Effect.fail(
          failAgentStart({
            _tag: "ContainerStartFailed",
            message: `runtime did not authenticate within ${String(ready.timeoutMs)}ms`,
          }),
        );
      case "ProcessExited":
        return yield* Effect.fail(
          failAgentStart({
            _tag: "ContainerStartFailed",
            message: `runtime exited before readiness: ${ready.stderr}`,
          }),
        );
    }
  });
}

function createCoordinator(sourcePath, payload) {
  return {
    execute(plan, _harness, opts = {}) {
      return withExclusiveRun(
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () =>
              startCoreTestServer({
                traceCaptureLayer: InMemoryTraceCaptureLive,
              }),
            catch: (error) =>
              failHarness(
                error instanceof Error ? error.message : String(error),
              ),
          }),
          (server) =>
            Effect.gen(function* () {
              const targetAgentName =
                payload.runtime.targetAgentName ??
                defaultTargetAgentName(payload.runtime.kind);
              const targetAgent = yield* registerAgent(
                server.baseUrl,
                targetAgentName,
              ).pipe(
                Effect.map((registered) => ({
                  agentId: registered.agentId,
                  apiKey: registered.apiKey,
                  agentName: targetAgentName,
                })),
                Effect.mapError((error) => failHarness(error.message)),
              );
              const runtimeStartedAt = new Date().toISOString();
              const runtime = yield* Effect.acquireUseRelease(
                startRuntime(
                  server.coreApp,
                  payload,
                  targetAgent,
                  server.wsUrl,
                ),
                (liveRuntime) =>
                  Effect.gen(function* () {
                    const conversationRun = yield* executeConversationPlan({
                      payload,
                      baseUrl: server.baseUrl,
                      wsUrl: server.wsUrl,
                      targetAgentId: targetAgent.agentId,
                    });
                    const traceEvents =
                      yield* server.coreApp.traceCapture.snapshot();
                    const namesById = new Map([
                      [targetAgent.agentId, targetAgent.agentName],
                      ...conversationRun.participants.map((participant) => [
                        participant.id,
                        participant.name,
                      ]),
                    ]);
                    const events = traceEvents
                      .map((event) => toBundleEvent(event, namesById))
                      .filter(Boolean);
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
                (liveRuntime) => liveRuntime.teardown(),
              );
              return runtime;
            }),
          () =>
            Effect.tryPromise({
              try: () => stopCoreTestServer(),
              catch: () => undefined,
            }).pipe(Effect.asVoid),
        ),
      );
    },
  };
}

export default {
  load(args) {
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
              ...(args.plan.metadata ?? {}),
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
