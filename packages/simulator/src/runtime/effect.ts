/** @file In-process Effect agents connected through the production protocol. */

import { MoltZapAgentClient } from "@moltzap/client";
import {
  messageReceivedNotificationDefinition,
  type MessageReceivedNotification,
} from "@moltzap/protocol/message";
import { httpBaseUrl } from "@moltzap/protocol/network";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Ref,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import type { AgentHandle } from "../network/participant.js";
import {
  type AgentRuntime,
  type AgentRuntimeInput,
  RuntimeCompleted,
  RuntimeFailed,
  type RunningAgent,
  type RuntimeTermination,
  defineRuntime,
} from "./runtime.js";

const EFFECT_RUNTIME_NAME = "effect";
const DEFAULT_STARTUP_TIMEOUT = Duration.seconds(10);

/** Acquisition failed before an in-process agent became ready. */
export class EffectRuntimeStartFailed extends Schema.TaggedError<EffectRuntimeStartFailed>()(
  "EffectRuntimeStartFailed",
  {
    agent: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Effect runtime for "${this.agent}" failed to start: ${this.detail}`;
  }
}

/**
 * Runtime-owned capabilities available while constructing an in-process agent.
 * The message stream is registered before the client connects, so delivery
 * cannot race construction, and it already carries any directed-link policy
 * the run installs against this agent. Social traffic still goes through
 * `client`.
 */
export interface EffectRuntimeContext<Name extends string = string> {
  readonly agent: AgentHandle<Name>;
  readonly messages: Stream.Stream<MessageReceivedNotification, unknown>;
  readonly client: MoltZapAgentClient;
}

/** Principal gateway and autonomous behavior owned by an in-process agent. */
export interface EffectAgent<Gateway, Requirements = never> {
  readonly gateway: Gateway;
  readonly behavior: Effect.Effect<void, unknown, Requirements>;
}

/** Construction options owned by one in-process runtime implementation. */
export interface EffectRuntimeOptions<
  Gateway,
  BuilderRequirements = never,
  BehaviorRequirements = never,
> {
  readonly startupTimeout?: Duration.Duration;
  readonly build: <Name extends string>(
    context: EffectRuntimeContext<Name>,
  ) => Effect.Effect<
    EffectAgent<Gateway, BehaviorRequirements>,
    unknown,
    BuilderRequirements
  >;
}

/** Sanitized definition-time configuration for an Effect runtime. */
export class EffectRuntimeConfiguration extends Schema.Class<EffectRuntimeConfiguration>(
  "EffectRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
}) {}

function startFailure(
  input: AgentRuntimeInput<string>,
  cause: unknown,
): EffectRuntimeStartFailed {
  return EffectRuntimeStartFailed.make({
    agent: input.connection.agent.name,
    detail: String(cause),
  });
}

function completeTermination(
  termination: Deferred.Deferred<RuntimeTermination>,
  observed: RuntimeTermination,
): Effect.Effect<void> {
  return Deferred.succeed(termination, observed).pipe(Effect.asVoid);
}

function observeBehavior<Failure, Requirements>(
  behavior: Effect.Effect<void, Failure, Requirements>,
  client: MoltZapAgentClient,
  termination: Deferred.Deferred<RuntimeTermination>,
  scopeClosing: Ref.Ref<boolean>,
): Effect.Effect<void, never, Requirements> {
  return behavior.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Ref.get(scopeClosing).pipe(
          Effect.flatMap((closing) =>
            closing && Cause.isInterruptedOnly(cause)
              ? Effect.void
              : completeTermination(
                  termination,
                  RuntimeFailed.make({ detail: Cause.pretty(cause) }),
                ).pipe(Effect.zipRight(client.close())),
          ),
        ),
      onSuccess: () =>
        completeTermination(termination, RuntimeCompleted.make({})).pipe(
          Effect.zipRight(client.close()),
        ),
    }),
  );
}

function awaitStartup<Name extends string>(
  input: AgentRuntimeInput<Name>,
  client: MoltZapAgentClient,
  startupTimeout: Duration.Duration,
): Effect.Effect<void, EffectRuntimeStartFailed> {
  return client.connect().pipe(
    Effect.timeoutFail({
      duration: startupTimeout,
      onTimeout: () =>
        `connect did not complete within ${Duration.format(startupTimeout)}`,
    }),
    Effect.mapError((cause) => startFailure(input, cause)),
  );
}

interface ConnectedEffectClient {
  readonly client: MoltZapAgentClient;
  readonly messages: Stream.Stream<MessageReceivedNotification, unknown>;
}

/**
 * Acquires the kernel's inbound link stage when the run offers one, which is
 * also what registers this agent as a directed-link policy target.
 * @param input Router attachment issued to this runtime.
 * @param subscribed Raw notification stream owned by the connected client.
 * @returns The subscribed stream, shaped by the run's link policies.
 */
function shapeInbound<Name extends string>(
  input: AgentRuntimeInput<Name>,
  subscribed: Stream.Stream<MessageReceivedNotification, unknown>,
): Effect.Effect<
  Stream.Stream<MessageReceivedNotification, unknown>,
  never,
  Scope.Scope
> {
  const intercept = input.interceptInbound;
  return intercept === undefined
    ? Effect.succeed(subscribed)
    : intercept.pipe(Effect.map((stage) => stage(subscribed)));
}

function acquireClient<Name extends string>(
  input: AgentRuntimeInput<Name>,
  startupTimeout: Duration.Duration,
): Effect.Effect<ConnectedEffectClient, EffectRuntimeStartFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const client = yield* Effect.try({
      try: () =>
        new MoltZapAgentClient({
          serverUrl: httpBaseUrl(input.connection.routerUrl),
          agentKey: input.connection.key,
        }),
      catch: (cause) => startFailure(input, cause),
    });
    const subscribed = yield* client.subscribeScoped(
      messageReceivedNotificationDefinition,
    );
    const messages = yield* shapeInbound(input, subscribed);
    yield* Effect.addFinalizer(() => client.close());
    yield* awaitStartup(input, client, startupTimeout);
    return { client, messages };
  });
}

function startBehavior<Gateway, Requirements>(
  built: EffectAgent<Gateway, Requirements>,
  client: MoltZapAgentClient,
): Effect.Effect<RunningAgent<Gateway>, never, Scope.Scope | Requirements> {
  return Effect.gen(function* () {
    const termination = yield* Deferred.make<RuntimeTermination>();
    const scopeClosing = yield* Ref.make(false);
    yield* observeBehavior(
      built.behavior,
      client,
      termination,
      scopeClosing,
    ).pipe(Effect.forkScoped);
    // `forkScoped` registers first. Scope finalizers run LIFO, so this marker
    // distinguishes caller teardown from an agent that interrupts itself.
    yield* Effect.addFinalizer(() => Ref.set(scopeClosing, true));
    return {
      gateway: built.gateway,
      termination: Deferred.await(termination),
    };
  });
}

function acquireEffectRuntime<
  Gateway,
  BuilderRequirements,
  BehaviorRequirements,
  Name extends string,
>(
  options: EffectRuntimeOptions<
    Gateway,
    BuilderRequirements,
    BehaviorRequirements
  >,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  RunningAgent<Gateway>,
  EffectRuntimeStartFailed,
  Scope.Scope | BuilderRequirements | BehaviorRequirements
> {
  return Effect.gen(function* () {
    const connected = yield* acquireClient(
      input,
      options.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT,
    );
    const built = yield* options
      .build(
        Object.freeze({
          agent: input.connection.agent,
          messages: connected.messages,
          client: connected.client,
        }),
      )
      .pipe(Effect.mapError((cause) => startFailure(input, cause)));
    return yield* startBehavior(built, connected.client);
  }).pipe(Effect.withSpan("effectRuntime.acquire"));
}

function snapshotOptions<Gateway, BuilderRequirements, BehaviorRequirements>(
  options: EffectRuntimeOptions<
    Gateway,
    BuilderRequirements,
    BehaviorRequirements
  >,
): EffectRuntimeOptions<Gateway, BuilderRequirements, BehaviorRequirements> {
  const startupTimeout = options.startupTimeout;
  const build = options.build;
  return Object.freeze({
    build,
    ...(startupTimeout === undefined ? {} : { startupTimeout }),
  });
}

/**
 * Create a scoped in-process agent that communicates through the production
 * MoltZap protocol.
 * @param options Runtime-owned startup policy and customer agent builder.
 * @returns An autonomous runtime with the builder's exact principal gateway.
 */
export function effectRuntime<
  Gateway,
  BuilderRequirements = never,
  BehaviorRequirements = never,
>(
  options: EffectRuntimeOptions<
    Gateway,
    BuilderRequirements,
    BehaviorRequirements
  >,
): AgentRuntime<
  Gateway,
  EffectRuntimeStartFailed,
  BuilderRequirements | BehaviorRequirements,
  typeof EffectRuntimeConfiguration
> {
  const capturedOptions = snapshotOptions(options);
  return defineRuntime({
    name: EFFECT_RUNTIME_NAME,
    configuration: {
      schema: EffectRuntimeConfiguration,
      value: EffectRuntimeConfiguration.make({
        startupTimeout:
          capturedOptions.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT,
      }),
    },
    acquire: (input) => acquireEffectRuntime(capturedOptions, input),
  });
}
