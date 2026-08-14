/** @file Two real moltzapd processes prove the public START and bound-reply path. */

import { ProtocolErrorCode } from "@modelcontextprotocol/client";
import { AgentCard } from "@moltzap/identity";
import {
  Duration,
  Effect,
  Either,
  Fiber,
  Option,
  Schema,
  Stream,
} from "effect";
import { expect, it } from "vitest";
import {
  acquireHarnessClient,
  type Content,
  type ConversationId,
  createConversationId,
  type HarnessTurn,
} from "../src/index.js";
import { openEndpointStore } from "../src/endpoint/store.js";
import {
  acquireDaemonManagementClient,
  acquireDaemonProcess,
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  makeRegistrationRequest,
  ProcessTestError,
  stopProcess,
} from "./daemon-process-harness.js";

const TURN_TIMEOUT = Duration.seconds(60);
const REPLY_PROGRESS_TIMEOUT = Duration.seconds(20);
const UNREGISTERED_TOOL_CATALOG = ["register", "status"] as const;
const ACTIVE_TOOL_CATALOG = [
  "read_conversation",
  "reply",
  "search_agents",
  "search_conversations",
  "start_conversation",
  "status",
] as const;

const initialContent = [
  { type: "text", text: "hello from the first real daemon" },
] as const satisfies Content;
const replyContent = [
  { type: "text", text: "bound reply from the second real daemon" },
] as const satisfies Content;

const requireTurn = (
  optional: Option.Option<HarnessTurn>,
  description: string,
): Effect.Effect<HarnessTurn, ProcessTestError> =>
  Option.match(optional, {
    onNone: () =>
      Effect.fail(new ProcessTestError({ message: `${description} ended` })),
    onSome: Effect.succeed,
  });

const decodeManagementCard = (encoded: unknown) =>
  Schema.decodeUnknown(AgentCard)(encoded).pipe(
    Effect.mapError(
      (cause) =>
        new ProcessTestError({
          message: "management returned an invalid AgentCard",
          cause,
        }),
    ),
  );

const nextTurn = <E>(stream: Stream.Stream<HarnessTurn, E>) =>
  Stream.runHead(stream).pipe(
    Effect.timeoutFail({
      duration: TURN_TIMEOUT,
      onTimeout: () =>
        new ProcessTestError({ message: "timed out awaiting certified turn" }),
    }),
  );

const registerFixture = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.listToolNames()).toEqual(
        UNREGISTERED_TOOL_CATALOG,
      );
      expect(yield* management.status()).toEqual({ kind: "unregistered" });
      const registered = yield* management.register(
        makeRegistrationRequest(fixture),
      );
      expect(registered.kind).toBe("registered");
      if (registered.kind === "registered") {
        const agentCard = yield* decodeManagementCard(registered.agentCard);
        expect(agentCard.agentName).toBe(fixture.agentName);
      }
      expect(yield* management.listToolNames()).toEqual(ACTIVE_TOOL_CATALOG);
    }),
  );

const readDurableHistory = (
  fixture: DaemonProcessFixture,
  conversationId: ConversationId,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(fixture.endpoint);
      expect(yield* management.listToolNames()).toEqual(ACTIVE_TOOL_CATALOG);
      const status = yield* management.status();
      expect(status.kind).toBe("active");
      if (status.kind === "active") {
        const agentCard = yield* decodeManagementCard(status.agentCard);
        expect(agentCard.agentName).toBe(fixture.agentName);
      }
      const conversations = yield* management.searchConversations();
      expect(conversations).toEqual({
        kind: "page",
        conversationIds: [conversationId],
        hasMore: false,
      });
      return yield* management.readConversation(conversationId);
    }),
  );

const describeStore = (fixture: DaemonProcessFixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(fixture.stateDirectory);
      const recovery = yield* store.recover();
      const counts = new Map<string, number>();
      const subjects = new Map<string, Set<string>>();
      for (const evidence of recovery.evidence) {
        counts.set(evidence.kind, (counts.get(evidence.kind) ?? 0) + 1);
        const retained = subjects.get(evidence.kind) ?? new Set<string>();
        retained.add(evidence.subjectId);
        subjects.set(evidence.kind, retained);
      }
      return `staged=${recovery.stagedRecords.length},certified=${recovery.certifiedRecords.length},evidence=${JSON.stringify(Object.fromEntries(counts))},subjects=${JSON.stringify(Object.fromEntries([...subjects].map(([kind, values]) => [kind, values.size])))}`;
    }),
  ).pipe(
    Effect.catchAll((error) => Effect.succeed(`unreadable:${error.reason}`)),
  );

const processBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const [callerFixture, targetFixture] = yield* Effect.all(
    [
      makeDaemonProcessFixture(infrastructure, "process-caller"),
      makeDaemonProcessFixture(infrastructure, "process-target"),
    ] as const,
    { concurrency: 2 },
  );
  const callerDaemon = yield* acquireDaemonProcess(callerFixture);
  const targetDaemon = yield* acquireDaemonProcess(targetFixture);

  yield* registerFixture(callerFixture);
  yield* registerFixture(targetFixture);

  const absentConversationId = yield* createConversationId();
  yield* Effect.scoped(
    Effect.gen(function* () {
      const management = yield* acquireDaemonManagementClient(
        callerFixture.endpoint,
      );
      const malformed = yield* management.callExpectingProtocolError(
        "read_conversation",
        { conversationId: "not-a-conversation-id" },
      );
      expect(malformed.code).toBe(ProtocolErrorCode.InvalidParams);
      expect(malformed.data).toBeUndefined();

      const missing = yield* management.callExpectingProtocolError(
        "read_conversation",
        { conversationId: absentConversationId },
      );
      expect(missing.code).toBe(ProtocolErrorCode.InternalError);
      expect(missing.data).toEqual({ reason: "not-found" });
    }),
  );

  const conversationId = yield* createConversationId();
  yield* Effect.scoped(
    Effect.gen(function* () {
      const caller = yield* acquireHarnessClient(callerFixture.endpoint);
      const target = yield* acquireHarnessClient(targetFixture.endpoint);
      const callerTurnFiber = yield* Effect.forkScoped(nextTurn(caller.turns));
      const targetTurnFiber = yield* Effect.forkScoped(nextTurn(target.turns));

      yield* caller.start({
        conversationId,
        peers: [targetFixture.agentName],
        content: initialContent,
      });
      const targetTurn = yield* Fiber.join(targetTurnFiber).pipe(
        Effect.flatMap((turn) => requireTurn(turn, "target turn stream")),
      );
      expect(targetTurn.conversationId).toBe(conversationId);
      expect(targetTurn.author.agentName).toBe(callerFixture.agentName);
      expect(targetTurn.peers.map(({ agentName }) => agentName)).toEqual([
        callerFixture.agentName,
      ]);
      expect(targetTurn.content).toEqual(initialContent);

      const reply = yield* targetTurn
        .reply(replyContent)
        .pipe(Effect.timeoutOption(REPLY_PROGRESS_TIMEOUT), Effect.either);
      if (Either.isLeft(reply)) {
        return yield* Effect.fail(
          new ProcessTestError({
            message: `bound reply failed: ${reply.left.reason}`,
            cause: reply.left,
          }),
        );
      }
      if (Option.isNone(reply.right)) {
        yield* Effect.all(
          [stopProcess(callerDaemon), stopProcess(targetDaemon)] as const,
          { concurrency: 2, discard: true },
        );
        const [callerStore, targetStore] = yield* Effect.all(
          [describeStore(callerFixture), describeStore(targetFixture)] as const,
          { concurrency: 2 },
        );
        return yield* Effect.fail(
          new ProcessTestError({
            message:
              `bound reply made no progress; caller=${callerStore}; ` +
              `target=${targetStore}`,
          }),
        );
      }
      const callerTurn = yield* Fiber.join(callerTurnFiber).pipe(
        Effect.flatMap((turn) => requireTurn(turn, "caller turn stream")),
      );
      expect(callerTurn.conversationId).toBe(conversationId);
      expect(callerTurn.author.agentName).toBe(targetFixture.agentName);
      expect(callerTurn.peers.map(({ agentName }) => agentName)).toEqual([
        targetFixture.agentName,
      ]);
      expect(callerTurn.content).toEqual(replyContent);
    }),
  );

  for (const fixture of [callerFixture, targetFixture]) {
    const history = yield* readDurableHistory(fixture, conversationId);
    expect(history.continuation).toBeNull();
    expect(history.records).toHaveLength(2);
    expect(
      history.records.map(
        ({ actionCertifiedRecord }) => actionCertifiedRecord.action.actionId,
      ),
    ).toEqual(["START", "MULTICAST"]);
    expect(
      history.records.map(
        ({ actionCertifiedRecord }) => actionCertifiedRecord.action.content,
      ),
    ).toEqual([initialContent, replyContent]);
  }

  yield* stopProcess(targetDaemon);
  yield* acquireDaemonProcess(targetFixture);
  const recovered = yield* readDurableHistory(targetFixture, conversationId);
  expect(recovered.records).toHaveLength(2);
}).pipe(Effect.scoped);

it("certifies START and one bound reply across two restarted real daemons", () => {
  expect.hasAssertions();
  return Effect.runPromise(processBehavior);
}, 180_000);
