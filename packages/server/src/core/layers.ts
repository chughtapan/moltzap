/**
 * Context tags + Layer composition for the core server services.
 *
 * Dependency order is encoded in each `Layer.effect`'s `yield*` chain.
 * Tag string convention: `moltzap/&lt;ClassName>`.
 */
import { Context, Effect, Layer } from "effect";

import type { Db } from "../db/client.js";
import { ConnectionManager, type Connection } from "#socket";
import { AgentEndpointResolver } from "../network/agent-endpoint-resolver.js";
import { NetworkSendService } from "../network/network-send.js";
import { AuthService } from "../identity/services/auth.service.js";
import { AppAuthService } from "../identity/services/app-auth.service.js";
import { ContactsService } from "../identity/services/contact.service.js";
import { ConversationService } from "../task/services/conversation.service.js";
import { PresenceService } from "../network/services/presence.service.js";
import { MessageService } from "../task/services/message.service.js";
import { TaskService } from "../task/services/task.service.js";
import { AppHost } from "../app/app-host.js";
import {
  makeLeaseRegistry,
  type LeaseRegistry,
} from "../task/leases/lease-registry.js";
import type { EnvelopeEncryption } from "../db/crypto/envelope.js";
import type { ConnectionHook, DisconnectionHook } from "./types.js";

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
 * Request-scoped connection. Provided per WebSocket RPC
 * dispatch by the typed dispatcher from the live three-arm `Connection`
 * arm; read by handlers via `yield* ConnectionTag`. Handlers that only
 * need the id read `.connId`; handlers that need the principal narrow on
 * `.auth._tag` (`AgentConnection` carries `AgentContext`, `AppConnection`
 * carries `AppContext`, `UnauthenticatedConnection` has neither).
 */
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}

export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}

/**
 * The server-app's connection / disconnection hook arrays, read by the
 * `agent/connect` handler on a successful AGENT connect (it fires the
 * connection hooks once the agent arm is minted) and by the socket-close
 * finalizer (it fires the disconnection hooks). The arrays are the mutable
 * registration surface the `CoreApp.onConnection` / `onDisconnection`
 * accessors push into; the tag carries them into the request-scoped engine so
 * the native handler can fire them in place of the bare-frame
 * `fireConnectionHooks` path.
 */
export interface ConnectionHooks {
  readonly connectionHooks: readonly ConnectionHook[];
  readonly disconnectionHooks: readonly DisconnectionHook[];
}

export class ConnectionHooksTag extends Context.Tag("moltzap/ConnectionHooks")<
  ConnectionHooksTag,
  ConnectionHooks
>() {}

/**
 * `AgentId → HashSet&lt;ConnectionId>` multimap maintained by the
 * `agent/connect` success path and the WS disconnect finalizer. Read by
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

// The Connect handler's `appKey` branch reads
// `AppAuthService.authenticateApp` directly — the wire's discriminated
// Connect params union IS the principal discriminator, so no resolver
// sits between the wire and the auth services. Exported so
// `connect.handlers.ts` can `yield* AppAuthServiceTag` on the app arm.
export class AppAuthServiceTag extends Context.Tag("moltzap/AppAuthService")<
  AppAuthServiceTag,
  AppAuthService
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
 * `LeaseRegistry` for the `dispatch/*` admission surface. In-process
 * state (`Ref&lt;Map&lt;LeaseId, LeaseEntry>>` + per-lease
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

const AppAuthServiceLive = Layer.effect(
  AppAuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AppAuthService(db);
  }).pipe(Effect.withSpan("AppAuthServiceLive")),
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

/**
 * `PresenceServiceLive` constructs the full {@link PresenceService}
 * (subscriber registry + lease-derived status engine + `presence/changed`
 * fan-out). The R channel consumes `ConnectionManagerTag` — the only
 * construction dep, used by the fan-out to resolve each subscriber's
 * socket. `LeaseRegistryLive` consumes `PresenceServiceTag` as its
 * `transitionObserver`, so a missing wiring surfaces at `tsc --build`
 * via the unresolved R channel.
 */
export const PresenceServiceLive: Layer.Layer<
  PresenceServiceTag,
  never,
  ConnectionManagerTag
> = Layer.effect(
  PresenceServiceTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    return yield* PresenceService.make(connections);
  }).pipe(Effect.withSpan("PresenceServiceLive")),
);

const LeaseRegistryLive = Layer.effect(
  LeaseRegistryTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    // The PresenceService IS the LeaseTransitionObserver. Consuming the
    // Tag here (rather than `noopLeaseTransitionObserver`) wires the
    // real presence-emission path; required-not-optional means dropping
    // this line surfaces at tsc.
    const transitionObserver = yield* PresenceServiceTag;
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
    const appHost = yield* AppHostTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
      encryption,
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
//   Tier 1 — ConnectionManager, AuthService, AppAuthService,
//            ContactsService.
//   Tier 2 — Presence, AgentEndpointResolver (provideMerge over T1).
//   Tier 2.5 — NetworkSendService.
//   Tier 2.6 — LeaseRegistry (consumes PresenceServiceTag as its transitionObserver).
//   Tier 3 — AppHost (db + connections + leases; the boot-installed
//            default app's static policies resolve in-process).
//   Tier 4 — ConversationService (db + participants + connections + AppHost).
//   Tier 5 — MessageService (every upstream + Encryption + AppHost).
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
// `WireConvIntoAppHost` in `core/app.ts`.
//
// The composition below is bottom-up by dependency order. Each stage merges
// a new service Layer on top of the lower tier, with the lower tier's
// outputs wired as the upper tier's inputs.

/** Tier 1 — zero cross-layer deps beyond Db. */
const Tier1 = Layer.mergeAll(
  ConnectionManagerLive,
  AuthServiceLive,
  AppAuthServiceLive,
  ContactsServiceLive,
);

/**
 * Tier 2 — Presence + AgentEndpointResolver above Tier 1's
 * ConnectionManager. The resolver has no upstream deps (in-memory `Ref`);
 * it joins this tier so NetworkSendServiceLive can pick it up at Tier 2.5.
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
 * Tier 2.6 — LeaseRegistryLive consumes ConnectionManager from Tier 1
 * AND PresenceServiceTag from Tier 2 (the service IS the registry's
 * required `transitionObserver`). Sits below AppHost so the registry is
 * wired into AppHost at construction.
 */
const Tier2LeaseRegistry = Layer.provideMerge(
  LeaseRegistryLive,
  Tier2NetworkSend,
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
  readonly appAuthService: AppAuthService;
  readonly conversationService: ConversationService;
  readonly contactService: ContactsService;
  readonly presenceService: PresenceService;
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
  appAuthService: AppAuthServiceTag,
  conversationService: ConversationServiceTag,
  contactService: ContactsServiceTag,
  presenceService: PresenceServiceTag,
  appHost: AppHostTag,
  leaseRegistry: LeaseRegistryTag,
  messageService: MessageServiceTag,
  taskService: TaskServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
