/**
 * Context tags + Layer composition for the core server services.
 *
 * Dependency order is encoded in each `Layer.effect`'s `yield*` chain.
 * Tag string convention: `moltzap/&lt;ClassName>`.
 */
import { Context, Effect, Layer } from "effect";

import type { Db } from "#db";
import { ConnectionManager, type Connection } from "#socket";
import { AgentEndpointResolver } from "#network";
import { NetworkSendService } from "#network";
import { AuthService } from "#identity/agents";
import { AppAuthService } from "#identity/apps";
import { ContactsService } from "#identity/contacts";
import { ConversationService } from "#conversation";
import { PresenceService } from "#network/presence";
import { MessageAuthorizationService, MessageService } from "#message";
import { TaskAuthorizationService, TaskService } from "#task";
import { AppEndpointRegistry } from "#identity/apps";
import {
  DispatchAdmissionService,
  makeLeaseRegistry,
  type LeaseRegistry,
} from "#dispatch";
import type { EnvelopeEncryption } from "#db/crypto";
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
 * `agent/network/connect` handler on a successful AGENT connect (it fires the
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
 * `agent/network/connect` success path and the WS disconnect finalizer. Read by
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

export class AppEndpointRegistryTag extends Context.Tag(
  "moltzap/AppEndpointRegistry",
)<AppEndpointRegistryTag, AppEndpointRegistry>() {}

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

export class DispatchAdmissionServiceTag extends Context.Tag(
  "moltzap/DispatchAdmissionService",
)<DispatchAdmissionServiceTag, DispatchAdmissionService>() {}

class MessageAuthorizationServiceTag extends Context.Tag(
  "moltzap/MessageAuthorizationService",
)<MessageAuthorizationServiceTag, MessageAuthorizationService>() {}

export class TaskAuthorizationServiceTag extends Context.Tag(
  "moltzap/TaskAuthorizationService",
)<TaskAuthorizationServiceTag, TaskAuthorizationService>() {}

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
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new ConversationService(
      db,
      connections,
      // Lazy: AppEndpointRegistry.contactService is wired post-construction in
      // standalone.ts (`app.setContactService(...)`) AFTER this Layer has
      // already produced its ConversationService instance, so capturing
      // a snapshot here would always be `null`.
      () => {
        const cs = appEndpointRegistry.getContactService();
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
 * (subscriber registry + lease-derived status engine + `network/presence-changed`
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

const AppEndpointRegistryLive = Layer.sync(
  AppEndpointRegistryTag,
  () => new AppEndpointRegistry(),
);

const DispatchAdmissionServiceLive = Layer.effect(
  DispatchAdmissionServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    const leaseRegistry = yield* LeaseRegistryTag;
    const conversations = yield* ConversationServiceTag;
    return new DispatchAdmissionService(
      db,
      appEndpointRegistry,
      leaseRegistry,
      conversations,
    );
  }).pipe(Effect.withSpan("DispatchAdmissionServiceLive")),
);

const MessageAuthorizationServiceLive = Layer.effect(
  MessageAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    const conversations = yield* ConversationServiceTag;
    return new MessageAuthorizationService(appEndpointRegistry, conversations);
  }).pipe(Effect.withSpan("MessageAuthorizationServiceLive")),
);

const TaskAuthorizationServiceLive = Layer.effect(
  TaskAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new TaskAuthorizationService(appEndpointRegistry);
  }).pipe(Effect.withSpan("TaskAuthorizationServiceLive")),
);

const MessageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const networkSend = yield* NetworkSendServiceTag;
    const encryption = yield* EncryptionTag;
    const messageAuthorization = yield* MessageAuthorizationServiceTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
      encryption,
      messageAuthorization,
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
//   Tier 3 — AppEndpointRegistry (live app endpoint registry).
//   Tier 4 — ConversationService (db + participants + connections + AppEndpointRegistry).
//   Tier 5 — Domain authorization/admission services.
//   Tier 6 — MessageService (db + Conversation + MessageAuthorization).
//   Tier 7 — TaskService (db + Conversation + Message).
//
// `Layer.provideMerge` (not `Layer.provide`) is load-bearing: every
// downstream tier sees ALL upstream Tags in its R-channel resolution,
// not just the immediately-above tier. RPC handler bodies can `yield*
// XServiceTag` for any service and have it resolved by the shared
// `dispatchRuntime` without a per-frame `Effect.provide`.
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
 * required `transitionObserver`).
 */
const Tier2LeaseRegistry = Layer.provideMerge(
  LeaseRegistryLive,
  Tier2NetworkSend,
);

/** Tier 3 — AppEndpointRegistry holds app registrations and optional contact policy. */
const Tier3 = Layer.provideMerge(AppEndpointRegistryLive, Tier2LeaseRegistry);

/** Tier 4 — ConversationService needs AppEndpointRegistry for the session-attach check. */
const Tier4 = Layer.provideMerge(ConversationServiceLive, Tier3);

/** Tier 5 — domain callback/admission services. */
const Tier5Auth = Layer.provideMerge(
  Layer.mergeAll(
    DispatchAdmissionServiceLive,
    MessageAuthorizationServiceLive,
    TaskAuthorizationServiceLive,
  ),
  Tier4,
);

/** Tier 6 — MessageService needs ConversationService + authorization. */
const Tier6Message = Layer.provideMerge(MessageServiceLive, Tier5Auth);

const TaskServiceLive = Layer.effect(
  TaskServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const messages = yield* MessageServiceTag;
    return new TaskService(db, conversations, messages);
  }).pipe(Effect.withSpan("TaskServiceLive")),
);
const Tier7 = Layer.provideMerge(TaskServiceLive, Tier6Message);

/**
 * All service Layers merged, with cross-layer deps resolved. Still requires
 * `DbTag | EncryptionTag` from a base Layer.
 */
export const ServicesLive = Tier7;

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
  readonly appEndpointRegistry: AppEndpointRegistry;
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
  appEndpointRegistry: AppEndpointRegistryTag,
  leaseRegistry: LeaseRegistryTag,
  messageService: MessageServiceTag,
  taskService: TaskServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>;
