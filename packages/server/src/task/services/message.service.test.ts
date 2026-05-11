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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { KyselyPGlite } from "kysely-pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import {
  agentId as makeAgentId,
  conversationId as makeConversationId,
} from "@moltzap/protocol/testing";
import { makeEffectKysely } from "../../db/effect-kysely-toolkit.js";
import type { Database } from "../../db/database.js";
import type { AgentId } from "../../app/types.js";
import type { ConversationId } from "@moltzap/protocol/task";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  join(__dirname, "..", "..", "app", "core-schema.sql"),
  "utf-8",
);
const dbHookTimeoutMs = 30_000;

const ALICE = makeAgentId("00000000-0000-4000-8000-00000000a11c");
const BOB = makeAgentId("00000000-0000-4000-8000-00000000b0b0");

let db: Kysely<Database>;
let pglite: {
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function freshDb(): Promise<void> {
  const kpg = await KyselyPGlite.create();
  pglite = {
    exec: (s) => kpg.client.exec(s),
    close: () => kpg.client.close(),
  };
  db = makeEffectKysely<Database>({ dialect: kpg.dialect });
  await pglite.exec(schema);
}

async function seedAgent(id: AgentId, name: string): Promise<void> {
  await db
    .insertInto("agents")
    .values({
      id,
      name,
      api_key_id: name.padEnd(16, "0").slice(0, 16),
      api_key_secret_hash:
        "0".repeat(64).slice(0, name.length) +
        "0".repeat(64).slice(name.length),
      claim_token: `claim-${name}`,
      status: "active",
    })
    .execute();
}

async function seedConversation(
  participants: AgentId[],
): Promise<ConversationId> {
  // Phase 9b consumer-migration R12: every conversation is task-bound and
  // `tm_endpoint_address` is NOT NULL. Seed a minimal task row so the FK
  // chain is satisfied; the preflight under test never reads the task.
  const initiator = participants[0];
  if (initiator === undefined) throw new Error("need at least one participant");
  const task = await db
    .insertInto("tasks")
    .values({
      initiator_agent_id: initiator,
      status: "active",
      tm_endpoint_address: `tm:agent:${initiator}`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const conv = await db
    .insertInto("conversations")
    .values({
      task_id: task.id,
      type: "group",
      created_by_id: initiator,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const agent of participants) {
    await db
      .insertInto("conversation_participants")
      .values({
        conversation_id: conv.id,
        agent_id: agent,
      })
      .execute();
  }
  return makeConversationId(conv.id);
}

function makeMessageService(opts: {
  resolver: AgentEndpointResolver;
}): MessageService {
  const connections = new ConnectionManager();
  const participants = new ParticipantService(db);
  const conversations = new ConversationService(db, participants, connections);
  const appTmRegistry = Effect.runSync(AppTmRegistry.make);
  const networkSend = new NetworkSendService(
    opts.resolver,
    connections,
    appTmRegistry,
  );
  return new MessageService({
    db,
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

describe("MessageService.preflightRecipients (#463 v3)", () => {
  beforeEach(freshDb, dbHookTimeoutMs);
  afterEach(async () => {
    await pglite?.close();
  });

  it("fails closed with RecipientNotResolved when a non-sender participant has zero live connections", async () => {
    await seedAgent(ALICE, "alice");
    await seedAgent(BOB, "bob");
    const conversationId = await seedConversation([ALICE, BOB]);

    // Resolver holds zero entries — neither alice nor bob has a live
    // connection. Alice (sender) is excluded from the preflight set; bob
    // (recipient) is checked, hits the empty set, and the preflight
    // fails closed.
    const resolver = Effect.runSync(AgentEndpointResolver.make);
    const service = makeMessageService({ resolver });

    const exit = await Effect.runPromise(
      Effect.exit(service.preflightRecipients(conversationId, ALICE)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
        const err = failure.value as RecipientNotResolved;
        expect(String(err.to)).toBe(`tm:agent:${BOB}`);
      }
    }
  });

  it("succeeds and returns the recipient set when every non-sender participant has at least one live connection", async () => {
    await seedAgent(ALICE, "alice");
    await seedAgent(BOB, "bob");
    const conversationId = await seedConversation([ALICE, BOB]);

    // Bob holds one live connection in the resolver. Alice is the sender;
    // she is excluded from the preflight set regardless of resolver state.
    const resolver = Effect.runSync(AgentEndpointResolver.make);
    await Effect.runPromise(resolver.add(BOB, connectionId("conn-bob-1")));

    const service = makeMessageService({ resolver });
    const result = await Effect.runPromise(
      service.preflightRecipients(conversationId, ALICE),
    );
    expect(result.recipients).toEqual([BOB]);
  });

  it("succeeds with an empty recipient set on a self-only conversation (no non-sender participant to resolve)", async () => {
    await seedAgent(ALICE, "alice");
    const conversationId = await seedConversation([ALICE]);

    // No live resolver entries. The preflight has zero recipients to
    // check, so the success channel returns an empty list — the durable
    // INSERT is allowed to proceed. This pins the "no recipients to
    // verify" branch so a future refactor cannot accidentally fail-close
    // here (which would break the self-conversation case).
    const resolver = Effect.runSync(AgentEndpointResolver.make);
    const service = makeMessageService({ resolver });
    const result = await Effect.runPromise(
      service.preflightRecipients(conversationId, ALICE),
    );
    expect(result.recipients).toEqual([]);
  });
});
