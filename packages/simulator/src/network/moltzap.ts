/** @file MoltZap implementation of the simulator router service. */

import type { AgentId, AgentKey, AgentName } from "@moltzap/protocol/identity";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
} from "@moltzap/protocol/message";
import { httpBaseUrl, type ServerBaseUrl } from "@moltzap/protocol/network";
import { MoltZapAgentClient } from "@moltzap/protocol/socket";
import { DEFAULT_APP_ID, taskRequest } from "@moltzap/protocol/task";
import {
  type AgentConnection,
  type AttachedEndpoint,
  type CommittedRouterMessage,
  type EndpointTransport,
  networkFailure,
  type NetworkFailure,
  type NetworkOperation,
  type ParticipantIds,
  type Router,
  RouterProvider,
  type RouterProviderService,
  type RouterStopped,
  makeRouterStopReport,
} from "./router.js";
import { makeAgentHandle, makeParticipantHandle } from "./participant.js";
import {
  Cause,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Option,
  Ref,
  type Scope,
  Stream,
} from "effect";
import {
  type MessageDatabasePath,
  readCommittedRouterMessages,
} from "./message-store.js";
import {
  acquireMoltZapServer,
  type MoltZapServer,
  type MoltZapServerHost,
} from "./server.js";
import type { ImageDigest } from "./server-image.js";

/** Configuration for one isolated MoltZap router per simulator run. */
export interface MoltZapRouterOptions {
  readonly image?: ImageDigest;
  readonly startupTimeout: Duration.Duration;
}

interface RouterIdentity {
  readonly agentId: AgentId;
  readonly key: AgentKey;
}

/**
 * The private boundary between router ownership and host resources.
 * It contains neither storage paths nor database row types.
 * @internal
 */
export interface MoltZapRouterDriver {
  readonly address: ServerBaseUrl;
  readonly register: (
    name: AgentName,
  ) => Effect.Effect<RouterIdentity, unknown>;
  readonly awaitAgentReady: (
    agentId: AgentId,
    within: Duration.Duration,
  ) => Effect.Effect<void, unknown>;
  readonly attachEndpoint: (
    key: AgentKey,
  ) => Effect.Effect<EndpointTransport, unknown, Scope.Scope>;
  readonly stopAndCollect: Effect.Effect<RouterStopped, NetworkFailure>;
}

/** @internal */
export type MoltZapRouterDriverAcquirer<Requirements = never> = (
  options: MoltZapRouterOptions,
) => Effect.Effect<MoltZapRouterDriver, unknown, Scope.Scope | Requirements>;

interface RouterRuntime {
  readonly driver: MoltZapRouterDriver;
  readonly bindings: Ref.Ref<ReadonlyMap<string, BoundIdentity>>;
  readonly bind: Effect.Semaphore;
  readonly stopped: Deferred.Deferred<RouterStopped, NetworkFailure>;
}

type BindingRole = "agent" | "endpoint";

interface BoundIdentity {
  readonly role: BindingRole;
  readonly identity: RouterIdentity;
}

interface IdentityBinding {
  readonly name: string;
  readonly agentName: AgentName;
  readonly role: BindingRole;
  readonly operation: "attach-agent" | "attach-endpoint";
}

function fail(operation: NetworkOperation, cause: unknown): NetworkFailure {
  return networkFailure(
    operation,
    cause instanceof Error ? cause.message : cause,
  );
}

function readCommittedMessages(
  databasePath: MessageDatabasePath,
): Effect.Effect<readonly CommittedRouterMessage[], NetworkFailure> {
  return readCommittedRouterMessages(databasePath).pipe(
    Effect.mapError((cause) => fail("stop-router", cause)),
  );
}

function collectStoppedRouter(
  server: MoltZapServer,
): Effect.Effect<RouterStopped, NetworkFailure> {
  return Effect.gen(function* () {
    yield* server
      .stop()
      .pipe(Effect.mapError((cause) => fail("stop-router", cause)));
    const messages = yield* readCommittedMessages(server.messageDatabasePath);
    return makeRouterStopReport(messages);
  });
}

function endpointMessages(
  client: MoltZapAgentClient,
): Effect.Effect<EndpointTransport["received"], never, Scope.Scope> {
  return client
    .subscribeScoped(messageReceivedNotificationDefinition)
    .pipe(
      Effect.map((received) =>
        received.pipe(Stream.mapError((cause) => fail("receive", cause))),
      ),
    );
}

function openConversationWith(
  client: MoltZapAgentClient,
): EndpointTransport["openConversation"] {
  return (participants: ParticipantIds) =>
    client
      .callDefinition(taskRequest, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: participants,
        initialConversation: { participants },
      })
      .pipe(
        Effect.mapError((cause) => fail("open-conversation", cause)),
        Effect.flatMap((result) =>
          result.conversation === null
            ? Effect.fail(
                fail(
                  "open-conversation",
                  "task request returned no initial conversation",
                ),
              )
            : Effect.succeed({
                taskId: result.task.id,
                conversationId: result.conversation.id,
              }),
        ),
      );
}

function sendWith(client: MoltZapAgentClient): EndpointTransport["send"] {
  return (taskId, conversationId, parts) =>
    client
      .callDefinition(messagesSend, {
        taskId,
        conversationId,
        parts,
      })
      .pipe(
        Effect.map((result) => result.message),
        Effect.mapError((cause) => fail("send", cause)),
      );
}

function endpointTransport(
  address: ServerBaseUrl,
  key: AgentKey,
): Effect.Effect<EndpointTransport, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const client = new MoltZapAgentClient({
      serverUrl: httpBaseUrl(address),
      agentKey: key,
    });
    yield* Effect.addFinalizer(() => client.close());
    const received = yield* endpointMessages(client);
    yield* client.connect();
    return {
      received,
      openConversation: openConversationWith(client),
      send: sendWith(client),
    };
  });
}

const acquireMoltZapDriver: MoltZapRouterDriverAcquirer<MoltZapServerHost> = (
  options,
) =>
  acquireMoltZapServer({
    image: options.image,
    readyTimeout: options.startupTimeout,
  }).pipe(
    Effect.map(
      (server): MoltZapRouterDriver => ({
        address: server.serverUrl,
        register: server.register,
        awaitAgentReady: server.awaitAgentReady,
        attachEndpoint: (key) => endpointTransport(server.serverUrl, key),
        stopAndCollect: collectStoppedRouter(server),
      }),
    ),
  );

function identityFor(
  runtime: RouterRuntime,
  binding: IdentityBinding,
): Effect.Effect<RouterIdentity, NetworkFailure> {
  // Registration stays cancellable, but a successful result and its local
  // binding become one masked handoff while the name permit remains held.
  return runtime.bind.withPermits(1)(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const bindings = yield* Ref.get(runtime.bindings);
        const existing = bindings.get(binding.name);
        if (existing !== undefined) {
          return existing.role === binding.role
            ? existing.identity
            : yield* Effect.fail(
                fail(
                  binding.operation,
                  `network identity "${binding.name}" is already bound as an ${existing.role}`,
                ),
              );
        }
        const identity = yield* restore(
          runtime.driver
            .register(binding.agentName)
            .pipe(Effect.mapError((cause) => fail(binding.operation, cause))),
        );
        yield* Ref.update(runtime.bindings, (current) => {
          const updated = new Map(current);
          updated.set(binding.name, {
            role: binding.role,
            identity,
          });
          return updated;
        });
        return identity;
      }),
    ),
  );
}

function readiness(
  runtime: RouterRuntime,
  agentId: AgentId,
  within: Duration.Duration,
): Effect.Effect<void, NetworkFailure> {
  return runtime.driver
    .awaitAgentReady(agentId, within)
    .pipe(Effect.mapError((cause) => fail("attach-agent", cause)));
}

function attachAgent<const Name extends string>(
  runtime: RouterRuntime,
  name: Name,
  agentName: AgentName,
): Effect.Effect<AgentConnection<Name>, NetworkFailure, Scope.Scope> {
  return identityFor(runtime, {
    name,
    agentName,
    role: "agent",
    operation: "attach-agent",
  }).pipe(
    Effect.map((identity) => ({
      agent: makeAgentHandle(name, identity.agentId),
      key: identity.key,
      routerUrl: runtime.driver.address,
      awaitReady: (within) => readiness(runtime, identity.agentId, within),
    })),
  );
}

function attachEndpoint<const Name extends string>(
  runtime: RouterRuntime,
  name: Name,
  agentName: AgentName,
): Effect.Effect<AttachedEndpoint<Name>, NetworkFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const identity = yield* identityFor(runtime, {
      name,
      agentName,
      role: "endpoint",
      operation: "attach-endpoint",
    });
    const transport = yield* runtime.driver
      .attachEndpoint(identity.key)
      .pipe(Effect.mapError((cause) => fail("attach-endpoint", cause)));
    return {
      participant: makeParticipantHandle(name, identity.agentId),
      transport,
    };
  });
}

function completeStopped(runtime: RouterRuntime): Effect.Effect<void> {
  return runtime.driver.stopAndCollect.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const failure = Option.getOrElse(Cause.failureOption(cause), () =>
          fail("stop-router", Cause.pretty(cause)),
        );
        return Deferred.fail(runtime.stopped, failure);
      },
      onSuccess: (stopped) => Deferred.succeed(runtime.stopped, stopped),
    }),
    Effect.asVoid,
  );
}

function acquireRouter(
  options: MoltZapRouterOptions,
  acquireDriver: MoltZapRouterDriverAcquirer,
): Effect.Effect<Router, NetworkFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const driver = yield* acquireDriver(options).pipe(
      Effect.mapError((cause) => fail("acquire-router", cause)),
    );
    const runtime: RouterRuntime = {
      driver,
      bindings: yield* Ref.make<ReadonlyMap<string, BoundIdentity>>(new Map()),
      bind: yield* Effect.makeSemaphore(1),
      stopped: yield* Deferred.make<RouterStopped, NetworkFailure>(),
    };
    yield* Effect.addFinalizer(() => completeStopped(runtime));
    return Object.freeze<Router>({
      address: driver.address,
      stopped: Deferred.await(runtime.stopped),
      attachAgent: (name, agentName) => attachAgent(runtime, name, agentName),
      attachEndpoint: (name, agentName) =>
        attachEndpoint(runtime, name, agentName),
    });
  }).pipe(Effect.withSpan("moltZapRouter.acquire"));
}

/**
 * Construct the MoltZap router provider over an explicit driver acquirer.
 * @param options Options that control the operation.
 * @param acquireDriver Value supplied to the operation.
 * @internal
 * @returns The created molt zap router provider with.
 */
export function makeMoltZapRouterProviderWith(
  options: MoltZapRouterOptions,
  acquireDriver: MoltZapRouterDriverAcquirer,
): RouterProviderService {
  return {
    acquire: acquireRouter(options, acquireDriver),
  };
}

/**
 * Construct the MoltZap router service from host platform services.
 * @param options Options that control the operation.
 * @returns The created molt zap router provider.
 */
function makeMoltZapRouterProvider(
  options: MoltZapRouterOptions,
): Effect.Effect<RouterProviderService, never, MoltZapServerHost> {
  return Effect.context<MoltZapServerHost>().pipe(
    Effect.map((host) =>
      makeMoltZapRouterProviderWith(options, (driverOptions) =>
        acquireMoltZapDriver(driverOptions).pipe(Effect.provide(host)),
      ),
    ),
  );
}

/**
 * Provide the MoltZap router while leaving host services to the root layer.
 * @param options Options that control the operation.
 * @returns The molt zap router layer result.
 */
export function moltZapRouterLayer(
  options: MoltZapRouterOptions,
): Layer.Layer<RouterProvider, never, MoltZapServerHost> {
  return Layer.effect(RouterProvider, makeMoltZapRouterProvider(options));
}
