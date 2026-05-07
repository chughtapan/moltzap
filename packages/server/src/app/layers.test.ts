import { it } from "@effect/vitest";
import type { Kysely } from "kysely";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import type { Db } from "../db/client.js";
import type { Database } from "../db/database.js";
import { NoopTraceCaptureLive } from "../runtime-surface/trace-capture.js";
import { LoggerLive, getLogger } from "../logger.js";
import { ConnectionManager } from "../ws/connection.js";
import { AgentEndpointResolver } from "../network/agent-endpoint-resolver.js";
import { NetworkSendService } from "../network/network-send.js";
import { AuthService } from "../services/auth.service.js";
import { ContactsService } from "../services/contact.service.js";
import { ConversationService } from "../services/conversation.service.js";
import { MessageService } from "../services/message.service.js";
import { ParticipantService } from "../services/participant.service.js";
import { PresenceService } from "../services/presence.service.js";
import { AppHost } from "./app-host.js";
import { WebhookClient } from "../adapters/webhook.js";
import {
  DbTag,
  DeliveryWebhookTag,
  EncryptionTag,
  ServicesLive,
  SessionValidatorTag,
  WebhookClientTag,
  resolveServices,
} from "./layers.js";

/**
 * Minimal Kysely stub. None of the constructors under test execute queries
 * — they just stash the db reference — so we don't need a real connection
 * to verify that the Layer graph wires the services together.
 */
const fakeDb = {} as Kysely<Database> as Db;

/** Base layer — feeds the ServicesLive requirements. LoggerLive provides
 * LoggerTag itself, so no separate `Layer.succeed(LoggerTag, …)` needed. */
const BaseLive = Layer.mergeAll(
  Layer.succeed(DbTag, fakeDb),
  Layer.succeed(EncryptionTag, null),
  Layer.succeed(SessionValidatorTag, null),
  Layer.succeed(WebhookClientTag, new WebhookClient()),
  Layer.succeed(DeliveryWebhookTag, null),
  NoopTraceCaptureLive,
  LoggerLive,
);

/** Full composition — Base provides inputs to ServicesLive's requirements. */
const FullLive = Layer.provideMerge(ServicesLive, BaseLive);

it.effect("ServicesLive resolves every service via resolveServices", () =>
  Effect.gen(function* () {
    const services = yield* resolveServices;

    // Identity-pass-throughs from BaseLive — sanity that the plumbing
    // doesn't clone or wrap them somewhere unexpected.
    expect(services.db).toBe(fakeDb);
    // LoggerLive builds pino from Effect.Config — asserting identity against
    // getLogger() confirms the shim and the Layer agree on one singleton.
    expect(services.logger).toBe(getLogger());
    expect(services.encryption).toBeNull();

    // Services that ServicesLive constructs. Each must be a real instance
    // of the expected class — a `Layer.mergeAll` wiring bug would either
    // fail to compile the graph or produce `undefined` at a tag.
    expect(services.connections).toBeInstanceOf(ConnectionManager);
    expect(services.agentEndpointResolver).toBeInstanceOf(
      AgentEndpointResolver,
    );
    expect(services.networkSendService).toBeInstanceOf(NetworkSendService);
    expect(services.authService).toBeInstanceOf(AuthService);
    expect(services.participantService).toBeInstanceOf(ParticipantService);
    expect(services.conversationService).toBeInstanceOf(ConversationService);
    expect(services.contactService).toBeInstanceOf(ContactsService);
    expect(services.presenceService).toBeInstanceOf(PresenceService);
    expect(services.appHost).toBeInstanceOf(AppHost);
    expect(services.messageService).toBeInstanceOf(MessageService);
    expect(typeof services.traceCapture.record).toBe("function");

    // Every slot is populated — `null` counts for encryption.
    for (const k of Object.keys(services)) {
      if (k === "encryption") continue;
      expect(services[k as keyof typeof services]).not.toBeNull();
      expect(services[k as keyof typeof services]).toBeDefined();
    }
  }).pipe(Effect.provide(FullLive)),
);
