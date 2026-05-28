/**
 * Context tags + Layer composition for the core server services.
 *
 * Dependency order is encoded in each `Layer.effect`'s `yield*` chain.
 * Tag string convention: `moltzap/&lt;ClassName>`.
 */
import { HttpClient } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import type { Db } from "../db/client.js";
import {
  ConnectionManager,
  type MoltZapConnection,
} from "../transport/connection.js";
import { AgentEndpointResolver } from "../network/agent-endpoint-resolver.js";
import { NetworkSendService } from "../network/network-send.js";
import { AuthService } from "../identity/services/auth.service.js";
import { ContactsService } from "../identity/services/contact.service.js";
import { ConversationService } from "../task/services/conversation.service.js";
import { PresenceService } from "../network/services/presence.service.js";
import {
  MessageService,
  type DeliveryWebhookConfig,
} from "../task/services/message.service.js";
import { TaskService } from "../task/services/task.service.js";
import type { SessionValidator } from "../identity/services/session-validator.js";
import { AppHost } from "./app-host.js";
import {
  makeLeaseRegistry,
  type LeaseRegistry,
} from "../task/leases/lease-registry.js";
import {
  makePresenceProjection,
  PresenceProjectionTag,
  type PresenceProjection,
} from "../network/services/presence-projection.js";
import type { EnvelopeEncryption } from "../crypto/envelope.js";

/** Default retention window for terminal lease records: 5 minutes. */
const LEASE_RETENTION_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DEFAULT_LEASE_RETENTION_MS =
  LEASE_RETENTION_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

// ── Tags ──────────────────────────────────────────────────────────────────
// One Context.Tag per injectable. The type parameter on the tag class is the
// compile-time token that Effect uses to index services.

/** Postgres/PGlite database handle (Kysely&lt;Database>). */
export class DbTag extends Context.Tag("moltzap/Db")<DbTag, Db>() {}

/** Optional envelope-encryption helper. null when encryption is disabled. */
export class EncryptionTag extends Context.Tag("moltzap/Encryption")<
  EncryptionTag,
  EnvelopeEncryption | null
>() {}

/**
 * Request-scoped connection. Provided per WebSocket RPC dispatch by the
 * router; read by handlers via `yield* ConnectionTag`. Handlers that
 * only need the id read `.id` on the connection. Replaces the
 * previous `ConnectionTag` — carrying the connection directly eliminates
 * the lookup-by-id-and-maybe-fail step (and its associated defect
 * path) every handler that wanted the connection object had to do.
 */
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  MoltZapConnection
>() {}

export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}

/**
 * `AgentId → HashSet&lt;ConnectionId>` multimap maintained by the
 * `network/connect` success path and the WS disconnect finalizer. Read by
 * {@link NetworkSendServiceTag} for O(1) outbound routing.
 */
export class AgentEndpointResolverTag extends Context.Tag(
  "moltzap/AgentEndpointResolver",
)<AgentEndpointResolverTag, AgentEndpointResolver>() {}

/**
 * Single outbound surface: `send` (directed) and `broadcast`
 * (fan-out).
 */
export class NetworkSendServiceTag extends Context.Tag(
  "moltzap/NetworkSendService",
)<NetworkSendServiceTag, NetworkSendService>() {}

export class AuthServiceTag extends Context.Tag("moltzap/AuthService")<
  AuthServiceTag,
  AuthService
>() {}

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

/**
 * `LeaseRegistry` for the #529 reshape additive `dispatch/*` admission
 * surface. In-process state (`Ref&lt;Map&lt;LeaseId, LeaseEntry>>` + per-lease
 * TTL fibers); no DB. Constructed once per server lifetime via
 * {@link LeaseRegistryLive}.
 */
export class LeaseRegistryTag extends Context.Tag("moltzap/LeaseRegistry")<
  LeaseRegistryTag,
  LeaseRegistry
>() {}

export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}

export class TaskServiceTag extends Context.Tag("moltzap/TaskService")<
  TaskServiceTag,
  TaskService
>() {}

/** Optional bearer-token session validator. `null` → bearer auth disabled. */
export class SessionValidatorTag extends Context.Tag(
  "moltzap/SessionValidator",
)<SessionValidatorTag, SessionValidator | null>() {}

/**
 * Optional fire-and-forget message-delivery webhook. `null` means no
 * webhook — the fanout is skipped entirely.
 *
 * The transport (`@effect/platform/HttpClient.HttpClient`) is the
 * standard Tag from `@effect/platform`; production wiring sits in
 * `app/server.ts` (`NodeHttpClient.layerUndici`, optionally wrapped
 * with a concurrency-cap `HttpClient.transform`). Tests override it
 * via `Layer.succeed(HttpClient.HttpClient, mockClient)`.
 */
export class DeliveryWebhookTag extends Context.Tag("moltzap/DeliveryWebhook")<
  DeliveryWebhookTag,
  DeliveryWebhookConfig | null
>() {}

// ── Infrastructure Layers (no app deps) ───────────────────────────────────

const ConnectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
);

/**
 * Build the resolver from its `Effect.make` constructor. The resolver is
 * a `Ref`-backed in-memory data structure with no upstream deps; the
 * Layer exists to register it under {@link AgentEndpointResolverTag} so
 * downstream layers (and `network.send`) can pick it up via Context.
 */
const AgentEndpointResolverLive = Layer.effect(
  AgentEndpointResolverTag,
  AgentEndpointResolver.make,
);

/**
 * `network.send` Layer. Composes the resolver and the connection
 * manager into the {@link NetworkSendService} instance the rest of the
 * server holds via {@link NetworkSendServiceTag}.
 */
const NetworkSendServiceLive = Layer.effect(
  NetworkSendServiceTag,
  Effect.gen(function* () {
    const resolver = yield* AgentEndpointResolverTag;
    const connections = yield* ConnectionManagerTag;
    return new NetworkSendService(resolver, connections);
  }).pipe(Effect.withSpan("NetworkSendServiceLive")),
);

// ── Service Layers ────────────────────────────────────────────────────────

const AuthServiceLive = Layer.effect(
  AuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AuthService(db);
  }).pipe(Effect.withSpan("AuthServiceLive")),
);

const ConversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    const appHost = yield* AppHostTag;
    return new ConversationService(
      db,
      connections,
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
  }).pipe(Effect.withSpan("ConversationServiceLive")),
);

const ContactsServiceLive = Layer.effect(
  ContactsServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new ContactsService(db);
  }).pipe(Effect.withSpan("ContactsServiceLive")),
);

const PresenceServiceLive = Layer.effect(
  PresenceServiceTag,
  // v7 (codex r6 P2 #2): PresenceService is now a pure subscriber
  // registry — no event sink dep, no constructor args. The sink
  // lives behind `createEmitIfChanged`'s closure in
  // `_internal/presence-emit.ts`, constructed by
  // `PresenceProjectionLive`.
  Effect.sync(() => new PresenceService()).pipe(
    Effect.withSpan("PresenceServiceLive"),
  ),
);

/**
 * Tier 2.55 — `PresenceProjectionLive` constructs the architect-tier
 * `PresenceProjection` from `PresenceServiceTag` (subscriber-registry
 * surface) + `ConnectionManagerTag` (fan-out sink construction). See
 * architect plan #706 v7 §3 + §8.
 *
 * **v7 (codex r6 P2 #3) — real runtime binding.** v6 declared this
 * as `export declare const PresenceProjectionLive` in
 * `presence-projection.ts` — a TYPE-only declaration with no runtime
 * value. Any consumer importing it would crash with `undefined`. v7
 * relocates the Layer here (where the other Live layers live; cycle-
 * friendly since `app/layers.ts` already imports from
 * `presence-projection.ts`) and binds it to a real
 * `Layer.die(...)` placeholder with the typed `R` channel narrowed
 * to `PresenceServiceTag | ConnectionManagerTag`. Impl-staff (#712)
 * replaces the `Layer.die` body with the real `Layer.effect(...)`
 * composition that calls `makePresenceProjection({ subscribers,
 * connections })`.
 *
 * Test harnesses that DO NOT exercise presence may continue to
 * provide `noopLeaseTransitionObserver` directly to
 * `makeLeaseRegistry`; the production `LeaseRegistryLive` (below)
 * consumes `PresenceProjectionTag` so a stale wiring (forgetting to
 * provide the projection in production) surfaces at `tsc --build`
 * via the unresolved R channel.
 */
export const PresenceProjectionLive: Layer.Layer<
  PresenceProjectionTag,
  never,
  PresenceServiceTag | ConnectionManagerTag
> = Layer.effect(
  PresenceProjectionTag,
  Effect.gen(function* () {
    const subscribers = yield* PresenceServiceTag;
    const connections = yield* ConnectionManagerTag;
    // Architect-stub: `makePresenceProjection`'s body throws "not
    // implemented" until impl-staff (#712) lands it. The Layer's
    // runtime construction will die loudly the first time something
    // tries to use it. Impl-staff replaces THIS factory body with
    // the real composition per §3 recipe.
    return yield* makePresenceProjection({ subscribers, connections });
  }).pipe(Effect.withSpan("PresenceProjectionLive")),
);

const LeaseRegistryLive = Layer.effect(
  LeaseRegistryTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    // v7 (codex r6 P2 #3): consume PresenceProjectionTag for the
    // transitionObserver field. v6 wired noopLeaseTransitionObserver
    // here as a placeholder; v7 wires the real projection (which
    // dies at construction time via Layer.die until impl-staff
    // fills the body). Required-not-optional means dropping this
    // line surfaces at tsc.
    const transitionObserver = yield* PresenceProjectionTag;
    return yield* makeLeaseRegistry({
      connections,
      leaseRetentionMs: DEFAULT_LEASE_RETENTION_MS,
      transitionObserver,
    });
  }).pipe(Effect.withSpan("LeaseRegistryLive")),
);

const AppHostLive = Layer.effect(
  AppHostTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    const leaseRegistry = yield* LeaseRegistryTag;
    const host = new AppHost(db, connections);
    host.setLeaseRegistry(leaseRegistry);
    return host;
  }).pipe(Effect.withSpan("AppHostLive")),
);

const MessageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const networkSend = yield* NetworkSendServiceTag;
    const encryption = yield* EncryptionTag;
    const deliveryWebhook = yield* DeliveryWebhookTag;
    const httpClient = yield* HttpClient.HttpClient;
    const appHost = yield* AppHostTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
      encryption,
      deliveryWebhook,
      httpClient,
      appHost,
    });
  }).pipe(Effect.withSpan("MessageServiceLive")),
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
// Service tier graph:
//
//   Tier 1 — ConnectionManager, AuthService, ParticipantService,
//            ContactsService.
//   Tier 2 — Presence, AgentEndpointResolver, AppTmRegistry (provideMerge over T1).
//   Tier 2.5 — NetworkSendService.
//   Tier 2.55 — PresenceProjection (architect plan #706 v7).
//   Tier 2.6 — LeaseRegistry (consumes PresenceProjectionTag).
//   Tier 3 — AppHost (db + connections + leases; seeds default
//            messageAuthorize hooks for the DM/Group TM addresses).
//   Tier 4 — ConversationService (db + participants + connections + AppHost).
//   Tier 5 — MessageService (every upstream + Encryption + DeliveryWebhook +
//            Webhook + TraceCapture + AppHost).
//   Tier 6 — TaskService (db + Conversation + Message).
//
// `Layer.provideMerge` (not `Layer.provide`) is load-bearing: every
// downstream tier sees ALL upstream Tags in its R-channel resolution,
// not just the immediately-above tier. RPC handler bodies can `yield*
// XServiceTag` for any service and have it resolved by the shared
// `dispatchRuntime` without a per-frame `Effect.provide`.
//
// `ConversationService` is built ABOVE `AppHost` but `AppHost` carries
// a backref into it (for the dispatch-deny path's removeParticipant
// call). The cycle is broken with a post-construction
// `appHost.setConversationService(conv)` wire-up — see
// `WireConvIntoAppHost` in `server.ts`.
//
// The composition below is bottom-up by dependency order. Each stage merges
// a new service Layer on top of the lower tier, with the lower tier's
// outputs wired as the upper tier's inputs.

/** Tier 1 — zero cross-layer deps beyond Db. */
const Tier1 = Layer.mergeAll(
  ConnectionManagerLive,
  AuthServiceLive,
  ContactsServiceLive,
);

/**
 * Tier 2 — Presence + resolver above Tier 1's ConnectionManager. The
 * resolver has no upstream deps (in-memory `Ref`); it joins this tier
 * so NetworkSendServiceLive can pick it up at Tier 2.5.
 */
const Tier2 = Layer.provideMerge(
  Layer.mergeAll(PresenceServiceLive, AgentEndpointResolverLive),
  Tier1,
);

/**
 * Tier 2.5 — NetworkSendServiceLive consumes the resolver from Tier 2
 * and the ConnectionManager from Tier 1; the sole outbound-routing
 * surface.
 */
const Tier2NetworkSend = Layer.provideMerge(NetworkSendServiceLive, Tier2);

/**
 * Tier 2.55 (v7 / architect plan #706) — PresenceProjectionLive
 * consumes PresenceServiceTag (for subscribers) + ConnectionManagerTag
 * (for the internal fan-out sink). Sits between Tier 2.5 and Tier 2.6
 * so LeaseRegistryLive can pull the projection from its R channel as
 * the new required `transitionObserver` dep.
 */
const Tier2PresenceProjection = Layer.provideMerge(
  PresenceProjectionLive,
  Tier2NetworkSend,
);

/**
 * Tier 2.6 — LeaseRegistryLive consumes ConnectionManager from Tier 1
 * (#529 reshape additive) AND PresenceProjectionTag from Tier 2.55
 * (architect plan #706 v7 codex r6 P2 #3). Sits below AppHost so the
 * registry is wired into AppHost at construction.
 */
const Tier2LeaseRegistry = Layer.provideMerge(
  LeaseRegistryLive,
  Tier2PresenceProjection,
);

/** Tier 3 — AppHost holds db + connections + optional user validator. */
const Tier3 = Layer.provideMerge(AppHostLive, Tier2LeaseRegistry);

/** Tier 4 — ConversationService needs AppHost for the session-attach check. */
const Tier4 = Layer.provideMerge(ConversationServiceLive, Tier3);

/** Tier 5 — MessageService needs ConversationService + AppHost + upstream. */
const Tier5 = Layer.provideMerge(MessageServiceLive, Tier4);

const TaskServiceLive = Layer.effect(
  TaskServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const messages = yield* MessageServiceTag;
    return new TaskService(db, conversations, messages);
  }).pipe(Effect.withSpan("TaskServiceLive")),
);
const Tier6 = Layer.provideMerge(TaskServiceLive, Tier5);

/**
 * All service Layers merged, with cross-layer deps resolved. Still requires
 * `DbTag | EncryptionTag` from a base Layer.
 */
export const ServicesLive = Tier6;

/**
 * Shape of the fully-resolved services. Handler factories consume this
 * plain-object view rather than reading each tag individually.
 */
export interface ResolvedServices {
  readonly db: Db;
  readonly connections: ConnectionManager;
  readonly agentEndpointResolver: AgentEndpointResolver;
  readonly networkSendService: NetworkSendService;
  readonly authService: AuthService;
  readonly conversationService: ConversationService;
  readonly contactService: ContactsService;
  readonly presenceService: PresenceService;
  // v7 (codex r6 P2 #2/#3): the projection joins the resolved set so
  // socket-handler.ts can call `onAgentDisconnect(agentId, connId)`
  // at close time. PresenceService stays for `removeConnection` +
  // `subscribe` (subscriber registry).
  readonly presenceProjection: PresenceProjection;
  readonly appHost: AppHost;
  readonly leaseRegistry: LeaseRegistry;
  readonly messageService: MessageService;
  readonly taskService: TaskService;
  readonly encryption: EnvelopeEncryption | null;
}

/**
 * Resolves every service via Context into a plain-object view (matches the
 * shape handler factories already expect). Context requirements inferred
 * from the tag record.
 */
export const resolveServices = Effect.all({
  db: DbTag,
  encryption: EncryptionTag,
  connections: ConnectionManagerTag,
  agentEndpointResolver: AgentEndpointResolverTag,
  networkSendService: NetworkSendServiceTag,
  authService: AuthServiceTag,
  conversationService: ConversationServiceTag,
  contactService: ContactsServiceTag,
  presenceService: PresenceServiceTag,
  // v7 (codex r6 P2 #3): wire the projection through resolveServices
  // so the socket-handler closure can call onAgentDisconnect at
  // close time. PresenceProjectionLive lives at Tier 2.55.
  presenceProjection: PresenceProjectionTag,
  appHost: AppHostTag,
  leaseRegistry: LeaseRegistryTag,
  messageService: MessageServiceTag,
  taskService: TaskServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
