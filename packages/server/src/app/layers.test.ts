import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import type { Db } from "../db/client.js";
import { NoopTraceCaptureLive } from "../runtime-surface/trace-capture.js";
import { ConnectionManager } from "../transport/connection.js";
import { AgentEndpointResolver } from "../network/agent-endpoint-resolver.js";
import { NetworkSendService } from "../network/network-send.js";
import { AuthService } from "../identity/services/auth.service.js";
import { ContactsService } from "../identity/services/contact.service.js";
import { ConversationService } from "../task/services/conversation.service.js";
import { MessageService } from "../task/services/message.service.js";
import { PresenceService } from "../network/services/presence.service.js";
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

const it = effectIt.effect;
const FUNCTION_TYPE = "function";

/**
 * Minimal Kysely stub. None of the constructors under test execute queries
 * — they just stash the db reference — so we don't need a real connection
 * to verify that the Layer graph wires the services together.
 */
const fakeDb = {} as Db;

/** Base layer — feeds the ServicesLive requirements. */
const BaseLive = Layer.mergeAll(
  Layer.succeed(DbTag, fakeDb),
  Layer.succeed(EncryptionTag, null),
  Layer.succeed(SessionValidatorTag, null),
  Layer.succeed(WebhookClientTag, new WebhookClient()),
  Layer.succeed(DeliveryWebhookTag, null),
  NoopTraceCaptureLive,
);

/** Full composition — Base provides inputs to ServicesLive's requirements. */
const FullLive = Layer.provideMerge(ServicesLive, BaseLive);

it("ServicesLive resolves every service via resolveServices", () =>
  Effect.gen(function* () {
    const services = yield* resolveServices;

    // Identity-pass-throughs from BaseLive — sanity that the plumbing
    // doesn't clone or wrap them somewhere unexpected.
    expect(services.db).toBe(fakeDb);
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
    expect(services.conversationService).toBeInstanceOf(ConversationService);
    expect(services.contactService).toBeInstanceOf(ContactsService);
    expect(services.presenceService).toBeInstanceOf(PresenceService);
    expect(services.appHost).toBeInstanceOf(AppHost);
    expect(services.messageService).toBeInstanceOf(MessageService);
    expect(typeof services.traceCapture.record).toBe(FUNCTION_TYPE);

    // Every slot is populated — `null` counts for encryption.
    for (const k of Object.keys(services)) {
      if (k === "encryption") continue;
      expect(services[k as keyof typeof services]).not.toBeNull();
      expect(services[k as keyof typeof services]).toBeDefined();
    }
  }).pipe(Effect.provide(FullLive)));
