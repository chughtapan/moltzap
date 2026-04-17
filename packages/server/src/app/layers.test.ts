import { it } from "@effect/vitest";
import type { Kysely } from "kysely";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import type { Db } from "../db/client.js";
import type { Database } from "../db/database.js";
import { LoggerLive, logger } from "../logger.js";
import { Broadcaster } from "../ws/broadcaster.js";
import { ConnectionManager } from "../ws/connection.js";
import { AuthService } from "../services/auth.service.js";
import { ConversationService } from "../services/conversation.service.js";
import { DeliveryService } from "../services/delivery.service.js";
import { MessageService } from "../services/message.service.js";
import { ParticipantService } from "../services/participant.service.js";
import { PresenceService } from "../services/presence.service.js";
import { AppHost, DefaultPermissionService } from "./app-host.js";
import { WebhookClient } from "../adapters/webhook.js";
import {
  DbTag,
  EncryptionTag,
  LoggerTag,
  ServicesLive,
  UserServiceTag,
  WebhookClientTag,
  resolveServices,
} from "./layers.js";

/**
 * Minimal Kysely stub. None of the constructors under test execute queries
 * — they just stash the db reference — so we don't need a real connection
 * to verify that the Layer graph wires 13 services together.
 */
const fakeDb = {} as Kysely<Database> as Db;

/** Base layer — feeds the ServicesLive requirements. */
const BaseLive = Layer.mergeAll(
  Layer.succeed(DbTag, fakeDb),
  Layer.succeed(LoggerTag, logger),
  Layer.succeed(EncryptionTag, null),
  Layer.succeed(UserServiceTag, null),
  Layer.succeed(WebhookClientTag, new WebhookClient()),
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
    expect(services.logger).toBe(logger);
    expect(services.encryption).toBeNull();

    // Services that ServicesLive constructs. Each must be a real instance
    // of the expected class — a `Layer.mergeAll` wiring bug would either
    // fail to compile the graph or produce `undefined` at a tag.
    expect(services.connections).toBeInstanceOf(ConnectionManager);
    expect(services.broadcaster).toBeInstanceOf(Broadcaster);
    expect(services.authService).toBeInstanceOf(AuthService);
    expect(services.participantService).toBeInstanceOf(ParticipantService);
    expect(services.conversationService).toBeInstanceOf(ConversationService);
    expect(services.deliveryService).toBeInstanceOf(DeliveryService);
    expect(services.presenceService).toBeInstanceOf(PresenceService);
    expect(services.appHost).toBeInstanceOf(AppHost);
    expect(services.defaultPermissionService).toBeInstanceOf(
      DefaultPermissionService,
    );
    expect(services.messageService).toBeInstanceOf(MessageService);

    // All 13 slots are populated — `null` counts for encryption.
    const keys = Object.keys(services);
    expect(keys.length).toBe(13);
    for (const k of keys) {
      if (k === "encryption") continue;
      expect(services[k as keyof typeof services]).not.toBeNull();
      expect(services[k as keyof typeof services]).toBeDefined();
    }
  }).pipe(Effect.provide(FullLive)),
);
