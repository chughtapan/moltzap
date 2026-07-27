/**
 * @file StubRuntime process: a scripted external agent speaking the real
 * WS wire protocol through `MoltZapAgentClient`. Spawned by the
 * simulator's stub adapter; configured entirely through environment
 * variables; always bannered as a scripted instrument fixture. Resolves
 * recipient names through `agent/identity/agents/list`, so a script
 * needs no out-of-band peer table.
 */
import { Effect, Redacted, Schema, Stream } from "effect";
import { MoltZapAgentClient } from "@moltzap/protocol/socket";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import {
  MessageReceivedNotificationDefinition,
  MessagesSend,
} from "@moltzap/protocol/message";
import { AgentsList } from "@moltzap/protocol/identity";

const AGENTS_LIST_LIMIT = 100;

const EnvSchema = Schema.Struct({
  MOLTZAP_STUB_SERVER_URL: Schema.NonEmptyString,
  MOLTZAP_STUB_AGENT_KEY: Schema.NonEmptyString,
  MOLTZAP_STUB_AGENT_NAME: Schema.NonEmptyString,
  MOLTZAP_STUB_SCRIPT: Schema.NonEmptyString,
});

const StepSchema = Schema.Union(
  Schema.TaggedStruct("send", {
    to: Schema.String,
    content: Schema.String,
    afterMs: Schema.optionalWith(Schema.Int, { default: () => 0 }),
  }),
  Schema.TaggedStruct("replyOnMatch", {
    pattern: Schema.String,
    content: Schema.String,
  }),
  Schema.TaggedStruct("signalDone", { afterMs: Schema.Int }),
  Schema.TaggedStruct("exit", { exitCode: Schema.Int, afterMs: Schema.Int }),
);

const ScriptSchema = Schema.Struct({
  name: Schema.String,
  steps: Schema.Array(StepSchema),
});

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function main() {
  const env = Schema.decodeUnknownSync(EnvSchema)(process.env);
  const script = Schema.decodeUnknownSync(ScriptSchema)(
    JSON.parse(env.MOLTZAP_STUB_SCRIPT),
  );
  log(
    `[stub-runtime] scripted instrument fixture "${script.name}" for agent "${env.MOLTZAP_STUB_AGENT_NAME}"; not agent cognition`,
  );
  const client = new MoltZapAgentClient({
    serverUrl: env.MOLTZAP_STUB_SERVER_URL,
    agentKey: Redacted.make(env.MOLTZAP_STUB_AGENT_KEY),
  });
  await Effect.runPromise(client.connect());
  log("[stub-runtime] connected");

  const matchers = script.steps.filter((step) => step._tag === "replyOnMatch");
  // The channel whoever last addressed this agent used; `signalDone`
  // answers there, and only the inbound stream can learn it.
  const addressed = { channel: undefined };
  armReplies(client, matchers, addressed);
  for (const step of script.steps) {
    await executeStep(client, step, addressed);
  }
  // Matchers stay armed; the adapter's teardown ends the process.
  await new Promise(() => {});
}

function textOf(message) {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function armReplies(client, matchers, addressed) {
  const consume = client
    .subscribe(MessageReceivedNotificationDefinition)
    .pipe(
      Stream.runForEach((notification) =>
        Effect.promise(() => onInbound(client, matchers, notification, addressed)),
      ),
    );
  Effect.runPromise(consume).catch(() => {
    // Subscription ends when the connection drops; teardown owns exits.
  });
}

async function onInbound(client, matchers, notification, addressed) {
  const text = textOf(notification.message);
  log(`[stub-runtime] received: ${text}`);
  // The conversation whoever spoke last used. A reply into a conversation
  // this agent opened itself reaches only the peer it invited, so it is
  // invisible to the run driving the episode.
  addressed.channel = {
    taskId: notification.taskId,
    conversationId: notification.message.conversationId,
  };
  for (const matcher of matchers) {
    if (!text.includes(matcher.pattern)) continue;
    await Effect.runPromise(
      client.callDefinition(MessagesSend, {
        taskId: notification.taskId,
        conversationId: notification.message.conversationId,
        parts: [{ type: "text", text: matcher.content }],
      }),
    );
    log(`[stub-runtime] replied: ${matcher.content}`);
  }
}

async function resolveAgentId(client, name) {
  const result = await Effect.runPromise(
    client.callDefinition(AgentsList, { limit: AGENTS_LIST_LIMIT }),
  );
  const match = result.agents.find((agent) => agent.name === name);
  if (match === undefined) {
    throw new Error(`[stub-runtime] no agent named "${name}" is registered`);
  }
  return match.id;
}

async function sendTo(client, recipientName, content) {
  const recipient = await resolveAgentId(client, recipientName);
  const created = await Effect.runPromise(
    client.callDefinition(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [recipient],
      initialConversation: { participants: [recipient] },
    }),
  );
  if (created.conversation === null) {
    throw new Error("[stub-runtime] task request returned no conversation");
  }
  await Effect.runPromise(
    client.callDefinition(MessagesSend, {
      taskId: created.task.id,
      conversationId: created.conversation.id,
      parts: [{ type: "text", text: content }],
    }),
  );
  log(`[stub-runtime] sent to ${recipientName}: ${content}`);
}

function sleep(ms) {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

async function executeStep(client, step, addressed) {
  switch (step._tag) {
    case "replyOnMatch":
      return;
    case "send":
      await sleep(step.afterMs);
      await sendTo(client, step.to, step.content);
      return;
    case "signalDone": {
      // Back into the conversation this agent was spoken to in. A run
      // observes the conversations its principals participate in, so a
      // signal sent anywhere else reaches nobody who is waiting for it.
      await sleep(step.afterMs);
      const channel = addressed.channel;
      if (channel === undefined) {
        log("[stub-runtime] done-signal skipped: nobody addressed this agent");
        return;
      }
      await Effect.runPromise(
        client.callDefinition(MessagesSend, {
          ...channel,
          parts: [{ type: "text", text: "[stub done-signal]" }],
        }),
      );
      log("[stub-runtime] done-signal emitted");
      return;
    }
    case "exit":
      await sleep(step.afterMs);
      log(`[stub-runtime] exiting with code ${step.exitCode}`);
      process.exit(step.exitCode);
  }
}

main().catch((cause) => {
  process.stderr.write(`[stub-runtime] fatal: ${String(cause)}\n`);
  process.exit(1);
});
