/**
 * #463 v3 — unit coverage for {@link MessageService.preflightRecipients}.
 *
 * The pre-INSERT fail-closed gate is the load-bearing piece: when any
 * non-sender participant has zero live connections in the
 * `AgentEndpointResolver`, the preflight returns
 * {@link RecipientNotResolved} on the error channel BEFORE
 * {@link MessageService.sendInsert} has a chance to write the durable
 * row. The wider end-to-end proof (no row in DB on preflight failure)
 * lives at `__tests__/integration/task/messages-preflight.test.ts`; this
 * test pins the resolver-empty branch at the service boundary so the
 * fail-closed shape is regressed without spinning up the WS stack.
 *
 * Memory `feedback_no_raw_sql`: every DB touch goes through Kysely.
 * Memory `feedback_predicate_tautology_lesson`: the happy-path
 * assertion explicitly compares the returned recipient set to the
 * expected agent ids — not just "non-empty" — so the predicate cannot
 * pass on accident.
 */
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  agentId as makeAgentId,
  conversationId as makeConversationId,
} from "@moltzap/protocol/testing";
import { takeFirstOrFail } from "../../db/effect-kysely-toolkit.js";
import type { AgentId } from "../../app/types.js";
import { MessageService } from "./message.service.js";
import { ConversationService } from "./conversation.service.js";
import { ParticipantService } from "../../identity/services/participant.service.js";
import {
  AgentEndpointResolver,
  connectionId,
} from "../../network/agent-endpoint-resolver.js";
import {
  NetworkSendService,
  RecipientNotResolved,
} from "../../network/network-send.js";
import { ConnectionManager } from "../../transport/connection.js";
import { AppTmRegistry } from "../../network/app-tm-registry.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";

const ALICE = makeAgentId("00000000-0000-4000-8000-00000000a11c");
const BOB = makeAgentId("00000000-0000-4000-8000-00000000b0b0");
const API_KEY_ID_LENGTH = 16;
const API_SECRET_HASH_LENGTH = 64;

let harness: PgliteHarness;

const it = effectIt.effect;

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
  );
}

function seedAgent(id: AgentId, name: string) {
  return harness.db.insertInto("agents").values({
    id,
    name,
    api_key_id: name.padEnd(API_KEY_ID_LENGTH, "0").slice(0, API_KEY_ID_LENGTH),
    api_key_secret_hash: "0".repeat(API_SECRET_HASH_LENGTH),
    claim_token: `claim-${name}`,
    status: "active",
  });
}

function seedConversation(participants: readonly [AgentId, ...AgentId[]]) {
  // Phase 9b consumer-migration R12: every conversation is task-bound and
  // `tm_endpoint_address` is NOT NULL. Seed a minimal task row so the FK
  // chain is satisfied; the preflight under test never reads the task.
  return Effect.gen(function* () {
    const initiator = participants[0];
    const task = yield* takeFirstOrFail(
      harness.db
        .insertInto("tasks")
        .values({
          initiator_agent_id: initiator,
          status: "active",
          tm_endpoint_address: `tm:agent:${initiator}`,
        })
        .returning("id"),
    );
    const conv = yield* takeFirstOrFail(
      harness.db
        .insertInto("conversations")
        .values({
          task_id: task.id,
          type: "group",
          created_by_id: initiator,
        })
        .returning("id"),
    );
    for (const agent of participants) {
      yield* harness.db.insertInto("conversation_participants").values({
        conversation_id: conv.id,
        agent_id: agent,
      });
    }
    return makeConversationId(conv.id);
  });
}

function makeMessageService(opts: {
  resolver: AgentEndpointResolver;
}): MessageService {
  const connections = new ConnectionManager();
  const participants = new ParticipantService(harness.db);
  const conversations = new ConversationService(
    harness.db,
    participants,
    connections,
  );
  const appTmRegistry = Effect.runSync(AppTmRegistry.make);
  const networkSend = new NetworkSendService(
    opts.resolver,
    connections,
    appTmRegistry,
  );
  return new MessageService({
    db: harness.db,
    conversations,
    networkSend,
    resolver: opts.resolver,
    encryption: null,
    deliveryWebhook: null,
    webhookClient: null,
    traceCapture: null,
    appHost: null,
  });
}

function failsClosedWhenRecipientHasNoConnection() {
  return Effect.gen(function* () {
    yield* seedAgent(ALICE, "alice");
    yield* seedAgent(BOB, "bob");
    const conversationId = yield* seedConversation([ALICE, BOB]);

    // Resolver holds zero entries: the sender is excluded from the
    // preflight set, while the recipient hits the empty resolver set.
    const resolver = Effect.runSync(AgentEndpointResolver.make);
    const service = makeMessageService({ resolver });

    const exit = yield* Effect.exit(
      service.preflightRecipients(conversationId, ALICE),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      const value = Option.getOrUndefined(failure);
      expect(value).toBeInstanceOf(RecipientNotResolved);
      if (value instanceof RecipientNotResolved) {
        expect(String(value.to)).toBe(`tm:agent:${BOB}`);
      }
    }
  });
}

function succeedsWhenRecipientHasLiveConnection() {
  return Effect.gen(function* () {
    yield* seedAgent(ALICE, "alice");
    yield* seedAgent(BOB, "bob");
    const conversationId = yield* seedConversation([ALICE, BOB]);

    // Bob holds one live connection. Alice is the sender, so she is
    // excluded from the preflight set regardless of resolver state.
    const resolver = Effect.runSync(AgentEndpointResolver.make);
    yield* resolver.add(BOB, connectionId("conn-bob-1"));

    const service = makeMessageService({ resolver });
    const result = yield* service.preflightRecipients(conversationId, ALICE);
    expect(result.recipients).toEqual([BOB]);
  });
}

function succeedsForSelfOnlyConversation() {
  return Effect.gen(function* () {
    yield* seedAgent(ALICE, "alice");
    const conversationId = yield* seedConversation([ALICE]);

    const resolver = Effect.runSync(AgentEndpointResolver.make);
    const service = makeMessageService({ resolver });
    const result = yield* service.preflightRecipients(conversationId, ALICE);
    expect(result.recipients).toEqual([]);
  });
}

describe("MessageService.preflightRecipients (#463 v3)", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  it(
    "fails closed with RecipientNotResolved when a non-sender participant has zero live connections",
    failsClosedWhenRecipientHasNoConnection,
  );

  it(
    "succeeds and returns the recipient set when every non-sender participant has at least one live connection",
    succeedsWhenRecipientHasLiveConnection,
  );

  it(
    "succeeds with an empty recipient set on a self-only conversation",
    succeedsForSelfOnlyConversation,
  );
});
