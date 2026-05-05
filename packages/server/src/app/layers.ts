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
import { AgentEndpointResolver } from "../network/agent-endpoint-resolver.js";
import { NetworkSendService } from "../network/network-send.js";
import { AuthService } from "../services/auth.service.js";
import { ParticipantService } from "../services/participant.service.js";
import { ContactsService } from "../services/contact.service.js";
import { ConversationService } from "../services/conversation.service.js";
import { PresenceService } from "../services/presence.service.js";
import { createConnectionFanOutPresenceEventSink } from "../services/presence-event-sink.js";
import {
  MessageService,
  type DeliveryWebhookConfig,
} from "../services/message.service.js";
import { TaskService } from "../services/task.service.js";
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

/**
 * `AgentId → Set<EndpointAddress>` multimap maintained by the `auth/connect`
 * success path and the WS disconnect finalizer. Read by
 * {@link NetworkSendServiceTag} for O(1) outbound routing.
 *
 * Coexists with {@link ConnectionManagerTag} during Phase 8 (Slice G1).
 * Phase 10 (Slice G2) deletes {@link BroadcasterTag} once consumers
 * migrate to {@link NetworkSendServiceTag}.
 */
export class AgentEndpointResolverTag extends Context.Tag(
  "moltzap/AgentEndpointResolver",
)<AgentEndpointResolverTag, AgentEndpointResolver>() {}

/**
 * The `network.send(to, payload)` outbound-routing primitive. New in
 * Slice G1; lives alongside {@link BroadcasterTag} during Phase 8.
 * Consumer migration is Phase 9 (Slice C); Broadcaster deletion is
 * Phase 10 (Slice G2).
 */
export class NetworkSendServiceTag extends Context.Tag(
  "moltzap/NetworkSendService",
)<NetworkSendServiceTag, NetworkSendService>() {}

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

export class TaskServiceTag extends Context.Tag("moltzap/TaskService")<
  TaskServiceTag,
  TaskService
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

/**
 * Build the resolver from its `Effect.make` constructor. The resolver is
 * a `Ref`-backed in-memory data structure with no upstream deps; the
 * Layer exists to register it under {@link AgentEndpointResolverTag} so
 * downstream layers (and `network.send`) can pick it up via Context.
 */
export const AgentEndpointResolverLive = Layer.effect(
  AgentEndpointResolverTag,
  AgentEndpointResolver.make,
);

/**
 * `network.send` Layer. Composes the resolver and the connection manager
 * into the {@link NetworkSendService} instance the rest of the server
 * holds via {@link NetworkSendServiceTag}.
 */
export const NetworkSendServiceLive = Layer.effect(
  NetworkSendServiceTag,
  Effect.gen(function* () {
    const resolver = yield* AgentEndpointResolverTag;
    const connections = yield* ConnectionManagerTag;
    return new NetworkSendService(resolver, connections);
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
    const appHost = yield* AppHostTag;
    const deliveryWebhook = yield* DeliveryWebhookTag;
    const webhookClient = yield* WebhookClientTag;
    const traceCapture = yield* TraceCaptureTag;
    return new MessageService(
      db,
      conversations,
      broadcaster,
      encryption,
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
  ContactsServiceLive,
);

/** Tier 2 — Broadcaster + Presence + AgentEndpointResolver all sit
 * directly above Tier 1's ConnectionManager. The resolver has no
 * upstream deps (in-memory `Ref`); it joins this tier so
 * NetworkSendServiceLive can pick it up at Tier 2.5 below.
 *
 * Slice G1 (Phase 8) introduces AgentEndpointResolverLive alongside
 * the existing layers. */
const Tier2 = Layer.provideMerge(
  Layer.mergeAll(
    BroadcasterLive,
    PresenceServiceLive,
    AgentEndpointResolverLive,
  ),
  Tier1,
);

/** Tier 2.5 — NetworkSendServiceLive depends on the AgentEndpointResolver
 * exposed by Tier 2 plus the ConnectionManager from Tier 1. `provideMerge`
 * wires them in and keeps NetworkSendServiceTag visible to higher tiers.
 *
 * Coexists with BroadcasterTag during Phase 8; consumer migration to
 * NetworkSendServiceTag lands in Phase 9 (Slice C). */
const Tier2NetworkSend = Layer.provideMerge(NetworkSendServiceLive, Tier2);

/** Tier 3 — AppHost needs Broadcaster/Connections. */
const Tier3 = Layer.provideMerge(AppHostLive, Tier2NetworkSend);

/** Tier 4 — ConversationService needs AppHost for the session-attach check. */
const Tier4 = Layer.provideMerge(ConversationServiceLive, Tier3);

/** Tier 5 — MessageService needs ConversationService + AppHost + upstream. */
const Tier5 = Layer.provideMerge(MessageServiceLive, Tier4);

export const TaskServiceLive = Layer.effect(
  TaskServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const messages = yield* MessageServiceTag;
    return new TaskService(db, conversations, messages);
  }),
);
const Tier6 = Layer.provideMerge(TaskServiceLive, Tier5);

/**
 * All service Layers merged, with cross-layer deps resolved. Still requires
 * `DbTag | LoggerTag | EncryptionTag` from a base Layer.
 */
export const ServicesLive = Tier6;

/**
 * Shape of the fully-resolved services. Handler factories consume this
 * plain-object view rather than reading each tag individually.
 */
export interface ResolvedServices {
  readonly db: Db;
  readonly logger: Logger;
  readonly connections: ConnectionManager;
  readonly broadcaster: Broadcaster;
  readonly agentEndpointResolver: AgentEndpointResolver;
  readonly networkSendService: NetworkSendService;
  readonly authService: AuthService;
  readonly participantService: ParticipantService;
  readonly conversationService: ConversationService;
  readonly contactService: ContactsService;
  readonly presenceService: PresenceService;
  readonly appHost: AppHost;
  readonly messageService: MessageService;
  readonly taskService: TaskService;
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
  agentEndpointResolver: AgentEndpointResolverTag,
  networkSendService: NetworkSendServiceTag,
  authService: AuthServiceTag,
  participantService: ParticipantServiceTag,
  conversationService: ConversationServiceTag,
  contactService: ContactsServiceTag,
  presenceService: PresenceServiceTag,
  appHost: AppHostTag,
  messageService: MessageServiceTag,
  taskService: TaskServiceTag,
  traceCapture: TraceCaptureTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
