import { it as effectIt } from "@effect/vitest";
import { Effect, Layer, unsafeCoerce } from "effect";
import { expect } from "vitest";
import { type Db, DbTag } from "#db";
import { ConnectionManager } from "#socket";
import { AgentEndpointResolver, NetworkSendService } from "#network";
import { AuthService } from "#identity/agents";
import { ConversationService } from "#conversation";
import { MessageService } from "#message";
import { AppEndpointRegistry } from "#identity/apps";
import { EncryptionTag } from "#db/crypto";
import { servicesLive, resolveServices } from "#core";

const it = effectIt.effect;

/**
 * Minimal Kysely stub. None of the constructors under test execute queries
 * — they just stash the db reference — so we don't need a real connection
 * to verify that the Layer graph wires the services together.
 */
const fakeDb = unsafeCoerce<Record<string, never>, Db>({});

/** Base layer — feeds the ServicesLive requirements. */
const baseLive = Layer.mergeAll(
  Layer.succeed(DbTag, fakeDb),
  Layer.succeed(EncryptionTag, null),
);

/** Full composition — Base provides inputs to ServicesLive's requirements. */
const fullLive = Layer.provideMerge(servicesLive, baseLive);

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
    expect(services.appEndpointRegistry).toBeInstanceOf(AppEndpointRegistry);
    expect(services.messageService).toBeInstanceOf(MessageService);

    // Every slot is populated — `null` counts for encryption.
    for (const k of Object.keys(services)) {
      if (k === "encryption") {
        continue;
      }
      expect(
        services[
          /* Safe because the test fixture establishes this asserted shape. */ k as keyof typeof services
        ],
      ).not.toBeNull();
      expect(
        services[
          /* Safe because the test fixture establishes this asserted shape. */ k as keyof typeof services
        ],
      ).toBeDefined();
    }
  }).pipe(Effect.provide(fullLive)));
