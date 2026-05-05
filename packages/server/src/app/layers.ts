/**
 * Context tags + Layer composition for the core server services.
 *
 * Dependency order is encoded in each `Layer.effect`'s `yield*` chain.
 * Tag string convention: `moltzap/<ClassName>`.
 */
import { Context, Effect, Layer } from "effect";

import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { LoggerTag } from "../logger.js";
import {
  TraceCaptureTag,
  type TraceCapture,
} from "../runtime-surface/trace-capture.js";
import { ConnectionManager } from "../ws/connection.js";
import { Broadcaster } from "../ws/broadcaster.js";
import { AuthService } from "../services/auth.service.js";
import { ParticipantService } from "../services/participant.service.js";
import { ContactsService } from "../services/contact.service.js";
import { ConversationService } from "../services/conversation.service.js";
import { DeliveryService } from "../services/delivery.service.js";
import { PresenceService } from "../services/presence.service.js";
import { createConnectionFanOutPresenceEventSink } from "../services/presence-event-sink.js";
import {
  MessageService,
  type DeliveryWebhookConfig,
} from "../services/message.service.js";
import type { UserService } from "../services/user.service.js";
import { AppHost } from "./app-host.js";
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

export class ContactsServiceTag extends Context.Tag("moltzap/ContactsService")<
  ContactsServiceTag,
  ContactsService
>() {}

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
 * Shared outbound HTTP client used by {@link MessageService.deliveryWebhook}
 * for the fire-and-forget post-delivery push and by user-side adapters
 * (`WebhookContactService`, `WebhookUserService`). Separate Tag so connection
 * pooling / semaphore sharing is controlled in one place.
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
    const connections = yield* ConnectionManagerTag;
    const appHost = yield* AppHostTag;
    return new ConversationService(
      db,
      participants,
      connections,
      (convId) => appHost.isAttachedToActiveSession(convId),
      // Lazy: AppHost.contactService is wired post-construction in
      // standalone.ts (`app.setContactService(...)`) AFTER this Layer has
      // already produced its ConversationService instance, so capturing
      // a snapshot here would always be `null`.
      () => {
        const cs = appHost.getContactService();
        if (!cs) return null;
        return (a, b) => cs.areInContact(a, b);
      },
    );
  }),
);

export const DeliveryServiceLive = Layer.effect(
  DeliveryServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new DeliveryService(db);
  }),
);

export const ContactsServiceLive = Layer.effect(
  ContactsServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new ContactsService(db);
  }),
);

export const PresenceServiceLive = Layer.effect(
  PresenceServiceTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    const sink = createConnectionFanOutPresenceEventSink({ connections });
    return new PresenceService(sink);
  }),
);

export const AppHostLive = Layer.effect(
  AppHostTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const broadcaster = yield* BroadcasterTag;
    const connections = yield* ConnectionManagerTag;
    const userService = yield* UserServiceTag;
    return new AppHost(db, broadcaster, connections, userService);
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
    const traceCapture = yield* TraceCaptureTag;
    return new MessageService(
      db,
      conversations,
      broadcaster,
      encryption,
      delivery,
      appHost,
      deliveryWebhook,
      webhookClient,
      traceCapture,
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
  AuthServiceLive,
  ParticipantServiceLive,
  DeliveryServiceLive,
  ContactsServiceLive,
);

/** Tier 2 — Broadcaster + Presence both need Tier 1's ConnectionManager.
 * Presence is here (not Tier 1) because it broadcasts `presence/changed`
 * directly to subscriber sockets via ConnectionManager — same wiring shape
 * as Broadcaster. */
const Tier2 = Layer.provideMerge(
  Layer.mergeAll(BroadcasterLive, PresenceServiceLive),
  Tier1,
);

/** Tier 3 — AppHost needs Broadcaster/Connections. */
const Tier3 = Layer.provideMerge(AppHostLive, Tier2);

/** Tier 4 — ConversationService needs AppHost for the session-attach check. */
const Tier4 = Layer.provideMerge(ConversationServiceLive, Tier3);

/** Tier 5 — MessageService needs ConversationService + AppHost + upstream. */
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
  readonly contactService: ContactsService;
  readonly deliveryService: DeliveryService;
  readonly presenceService: PresenceService;
  readonly appHost: AppHost;
  readonly messageService: MessageService;
  readonly encryption: EnvelopeEncryption | null;
  readonly traceCapture: TraceCapture;
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
  contactService: ContactsServiceTag,
  deliveryService: DeliveryServiceTag,
  presenceService: PresenceServiceTag,
  appHost: AppHostTag,
  messageService: MessageServiceTag,
  traceCapture: TraceCaptureTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
