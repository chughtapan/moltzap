import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import type { Db } from "#db";
import { ConnectionManager } from "#socket";
import { AgentEndpointResolver } from "#network";
import { NetworkSendService } from "#network";
import { AuthService } from "#identity/agents";
import { ContactsService } from "#identity/contacts";
import { ConversationService } from "#conversation";
import { MessageService } from "#message";
import { PresenceService } from "#network/presence";
import { AppEndpointRegistry } from "#identity/apps";
import { DbTag } from "#db";
import { EncryptionTag } from "#db/crypto";
import { resolveServices, ServicesLive } from "#core";

const it = effectIt.effect;

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
    expect(services.appEndpointRegistry).toBeInstanceOf(AppEndpointRegistry);
    expect(services.messageService).toBeInstanceOf(MessageService);

    // Every slot is populated — `null` counts for encryption.
    for (const k of Object.keys(services)) {
      if (k === "encryption") continue;
      expect(services[k as keyof typeof services]).not.toBeNull();
      expect(services[k as keyof typeof services]).toBeDefined();
    }
  }).pipe(Effect.provide(FullLive)));
