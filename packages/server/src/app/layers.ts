/**
 * Context tags + Layer composition for the core server services.
 *
 * Dependency order is encoded in each `Layer.effect`'s `yield*` chain.
 * Tag string convention: `moltzap/<ClassName>`.
 */
import { Context, Deferred, Effect, HashMap, Layer, Ref } from "effect";

import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { LoggerTag } from "../logger.js";
import { ConnectionManager } from "../ws/connection.js";
import { Broadcaster } from "../ws/broadcaster.js";
import { AuthService } from "../services/auth.service.js";
import { ParticipantService } from "../services/participant.service.js";
import { ConversationService } from "../services/conversation.service.js";
import { DeliveryService } from "../services/delivery.service.js";
import { PresenceService } from "../services/presence.service.js";
import {
  MessageService,
  type DeliveryWebhookConfig,
} from "../services/message.service.js";
import type { UserService } from "../services/user.service.js";
import { AppHost, DefaultPermissionService } from "./app-host.js";
import type { EnvelopeEncryption } from "../crypto/envelope.js";
import type { WebhookClient } from "../adapters/webhook.js";

// ── Tags ──────────────────────────────────────────────────────────────────
// One Context.Tag per injectable. The type parameter on the tag class is the
// compile-time token that Effect uses to index services.

/** Postgres/PGlite database handle (Kysely<Database>). */
export class DbTag extends Context.Tag("moltzap/Db")<DbTag, Db>() {}

/** Re-exported so call sites importing tags from one file still compile.
 * Canonical definition lives in `../logger.js`. */
export { LoggerTag };

/** Optional envelope-encryption helper. null when encryption is disabled. */
export class EncryptionTag extends Context.Tag("moltzap/Encryption")<
  EncryptionTag,
  EnvelopeEncryption | null
>() {}

/**
 * Request-scoped connection id. Provided per WebSocket RPC dispatch by the
 * router; read by handlers via `yield* ConnIdTag`. Replaces the previous
 * `AsyncLocalStorage<string>` + `getConnId` prop threading.
 */
export class ConnIdTag extends Context.Tag("moltzap/ConnId")<
  ConnIdTag,
  string
>() {}

export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}

export class BroadcasterTag extends Context.Tag("moltzap/Broadcaster")<
  BroadcasterTag,
  Broadcaster
>() {}

export class AuthServiceTag extends Context.Tag("moltzap/AuthService")<
  AuthServiceTag,
  AuthService
>() {}

export class ParticipantServiceTag extends Context.Tag(
  "moltzap/ParticipantService",
)<ParticipantServiceTag, ParticipantService>() {}

export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}

export class DeliveryServiceTag extends Context.Tag("moltzap/DeliveryService")<
  DeliveryServiceTag,
  DeliveryService
>() {}

export class PresenceServiceTag extends Context.Tag("moltzap/PresenceService")<
  PresenceServiceTag,
  PresenceService
>() {}

export class AppHostTag extends Context.Tag("moltzap/AppHost")<
  AppHostTag,
  AppHost
>() {}

export class DefaultPermissionServiceTag extends Context.Tag(
  "moltzap/DefaultPermissionService",
)<DefaultPermissionServiceTag, DefaultPermissionService>() {}

export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}

/** Optional user validator. `null` means no validation — admit all owners. */
export class UserServiceTag extends Context.Tag("moltzap/UserService")<
  UserServiceTag,
  UserService | null
>() {}

/**
 * Shared outbound HTTP client used by {@link AppHost} for webhook-based
 * hook dispatch. Separate from the per-service adapters so connection
 * pooling/semaphore sharing is controlled in one place.
 */
export class WebhookClientTag extends Context.Tag("moltzap/WebhookClient")<
  WebhookClientTag,
  WebhookClient
>() {}

/**
 * Optional fire-and-forget message-delivery webhook. `null` means no
 * webhook — the fanout is skipped entirely.
 */
export class DeliveryWebhookTag extends Context.Tag("moltzap/DeliveryWebhook")<
  DeliveryWebhookTag,
  DeliveryWebhookConfig | null
>() {}

// ── Infrastructure Layers (no app deps) ───────────────────────────────────

export const ConnectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
);

export const BroadcasterLive = Layer.effect(
  BroadcasterTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    return new Broadcaster(connections);
  }),
);

// ── Service Layers ────────────────────────────────────────────────────────

export const AuthServiceLive = Layer.effect(
  AuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AuthService(db);
  }),
);

export const ParticipantServiceLive = Layer.effect(
  ParticipantServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new ParticipantService(db);
  }),
);

export const ConversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const participants = yield* ParticipantServiceTag;
    return new ConversationService(db, participants);
  }),
);

export const DeliveryServiceLive = Layer.effect(
  DeliveryServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new DeliveryService(db);
  }),
);

export const PresenceServiceLive = Layer.sync(
  PresenceServiceTag,
  () => new PresenceService(),
);

export const AppHostLive = Layer.effect(
  AppHostTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const broadcaster = yield* BroadcasterTag;
    const connections = yield* ConnectionManagerTag;
    const userService = yield* UserServiceTag;
    const webhookClient = yield* WebhookClientTag;
    const inflightPermissions = yield* Ref.make(
      HashMap.empty<string, Deferred.Deferred<string[], Error>>(),
    );
    return new AppHost(
      db,
      broadcaster,
      connections,
      userService,
      webhookClient,
      inflightPermissions,
    );
  }),
);

export const DefaultPermissionServiceLive = Layer.effect(
  DefaultPermissionServiceTag,
  Effect.gen(function* () {
    const broadcaster = yield* BroadcasterTag;
    return new DefaultPermissionService(broadcaster);
  }),
);

/**
 * MessageService calls `AppHost.runBeforeMessageDelivery` on send; AppHost
 * itself has no reverse edge, so the two sit cleanly in separate tiers
 * without a real cycle.
 */
export const MessageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const broadcaster = yield* BroadcasterTag;
    const encryption = yield* EncryptionTag;
    const delivery = yield* DeliveryServiceTag;
    const appHost = yield* AppHostTag;
    const deliveryWebhook = yield* DeliveryWebhookTag;
    const webhookClient = yield* WebhookClientTag;
    return new MessageService(
      db,
      conversations,
      broadcaster,
      encryption,
      delivery,
      appHost,
      deliveryWebhook,
      webhookClient,
    );
  }),
);

// ── Composed top-level Layer ──────────────────────────────────────────────
//
// Effect's Layer type parameters are (ROut, E, RIn): the outputs, errors, and
// remaining inputs. `Layer.mergeAll` does NOT auto-resolve cross-layer
// requirements — a layer that depends on a sibling's output still shows that
// tag in RIn. `Layer.provideMerge(consumer, provider)` *does* wire them: it
// feeds `provider`'s outputs into `consumer`'s inputs AND keeps both sets of
// outputs visible to downstream layers.
//
// The composition below is bottom-up by dependency order. Each stage merges
// a new service Layer on top of the lower tier, with the lower tier's
// outputs wired as the upper tier's inputs.

/** Tier 1 — zero cross-layer deps beyond Db/Logger. */
const Tier1 = Layer.mergeAll(
  ConnectionManagerLive,
  PresenceServiceLive,
  AuthServiceLive,
  ParticipantServiceLive,
  DeliveryServiceLive,
);

/** Tier 2 — Broadcaster needs Tier 1's ConnectionManager. */
const Tier2 = Layer.provideMerge(BroadcasterLive, Tier1);

/** Tier 3 — Conversation needs Tier 1's Participant; keeps Tier 2 outputs. */
const Tier3 = Layer.provideMerge(ConversationServiceLive, Tier2);

/** Tier 4 — AppHost + DefaultPermission need Conversation + Broadcaster. */
const Tier4 = Layer.provideMerge(
  Layer.mergeAll(AppHostLive, DefaultPermissionServiceLive),
  Tier3,
);

/** Tier 5 — MessageService needs AppHost + everything upstream. */
const Tier5 = Layer.provideMerge(MessageServiceLive, Tier4);

/**
 * All service Layers merged, with cross-layer deps resolved. Still requires
 * `DbTag | LoggerTag | EncryptionTag` from a base Layer.
 */
export const ServicesLive = Tier5;

/**
 * Shape of the fully-resolved services. Handler factories consume this
 * plain-object view rather than reading each tag individually.
 */
export interface ResolvedServices {
  readonly db: Db;
  readonly logger: Logger;
  readonly connections: ConnectionManager;
  readonly broadcaster: Broadcaster;
  readonly authService: AuthService;
  readonly participantService: ParticipantService;
  readonly conversationService: ConversationService;
  readonly deliveryService: DeliveryService;
  readonly presenceService: PresenceService;
  readonly appHost: AppHost;
  readonly defaultPermissionService: DefaultPermissionService;
  readonly messageService: MessageService;
  readonly encryption: EnvelopeEncryption | null;
}

/**
 * Resolves every service via Context into a plain-object view (matches the
 * shape handler factories already expect). Context requirements inferred
 * from the tag record.
 */
export const resolveServices = Effect.all({
  db: DbTag,
  logger: LoggerTag,
  encryption: EncryptionTag,
  connections: ConnectionManagerTag,
  broadcaster: BroadcasterTag,
  authService: AuthServiceTag,
  participantService: ParticipantServiceTag,
  conversationService: ConversationServiceTag,
  deliveryService: DeliveryServiceTag,
  presenceService: PresenceServiceTag,
  appHost: AppHostTag,
  defaultPermissionService: DefaultPermissionServiceTag,
  messageService: MessageServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
