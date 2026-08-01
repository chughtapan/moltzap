import { Effect, Exit, Stream } from "effect";
import type {
  AgentCallableGroup,
  AnyAgentCallableRpcDefinition,
  AnyAppCallableRpcDefinition,
  AnyNotificationDefinition,
  AppCallableGroup,
} from "#socket/catalog";
import type { NotificationDelivery, NotificationParamsOf } from "#transport";
import { type AgentClientOptions, MoltZapAgentClient } from "#socket";
import { type AppClientOptions, MoltZapAppClient } from "#socket";
import {
  type ClientDefinitionError,
  type ClientDefinitionPayload,
  type ClientDefinitionSuccess,
  type RpcCallOptions,
} from "#socket";
import type { AgentId } from "#identity/agents";
import type { AppId } from "#identity/apps";
import type { RpcGroup } from "@effect/rpc";
import type { ErrorForTag, PayloadForTag, SuccessForTag } from "#transport";
import type { NotConnectedError, RpcTimeoutError } from "#transport";

type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;
type AppCallableRpcs = RpcGroup.Rpcs<typeof AppCallableGroup>;
type AgentCallableTag = AgentCallableRpcs["_tag"];
type AppCallableTag = AppCallableRpcs["_tag"];
type AgentRpcError<Tag extends AgentCallableTag> =
  | ErrorForTag<AgentCallableRpcs, Tag>
  | NotConnectedError
  | RpcTimeoutError;
type AppRpcError<Tag extends AppCallableTag> =
  | ErrorForTag<AppCallableRpcs, Tag>
  | NotConnectedError
  | RpcTimeoutError;

export interface TestServer {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly close: Effect.Effect<void, unknown>;
}

export interface TestAgentClient {
  readonly principal: "agent";
  readonly agentId?: AgentId;
  close(): Effect.Effect<void, never>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError>;
  subscribeAll(
    refinement?: (
      delivery: NotificationDelivery<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    NotificationDelivery<AnyNotificationDefinition>,
    NotConnectedError
  >;
  sendRpc<D extends AnyAgentCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ClientDefinitionSuccess<D>, ClientDefinitionError<D>>;
  call<Tag extends AgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AgentCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, AgentRpcError<Tag>>;
}

export interface TestAppClient {
  readonly principal: "app";
  readonly appId?: AppId;
  close(): Effect.Effect<void, never>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError>;
  subscribeAll(
    refinement?: (
      delivery: NotificationDelivery<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    NotificationDelivery<AnyNotificationDefinition>,
    NotConnectedError
  >;
  sendRpc<D extends AnyAppCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ClientDefinitionSuccess<D>, ClientDefinitionError<D>>;
  call<Tag extends AppCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AppCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<SuccessForTag<AppCallableRpcs, Tag>, AppRpcError<Tag>>;
}

type SubscribingClient = MoltZapAgentClient | MoltZapAppClient;

function deliveryFor(
  definition: AnyNotificationDefinition,
  params: NotificationParamsOf<AnyNotificationDefinition>,
): NotificationDelivery<AnyNotificationDefinition> {
  return { definition, method: definition.name, params };
}

function subscribeAllFromClient(
  client: SubscribingClient,
): Stream.Stream<
  NotificationDelivery<AnyNotificationDefinition>,
  NotConnectedError
> {
  return client.subscribeAll();
}

function subscribeAllWithDeliveryRefinement(
  client: SubscribingClient,
  refinement: (
    delivery: NotificationDelivery<AnyNotificationDefinition>,
  ) => boolean,
): Stream.Stream<
  NotificationDelivery<AnyNotificationDefinition>,
  NotConnectedError
> {
  return client.subscribeAll((definition, params) =>
    refinement(deliveryFor(definition, params)),
  );
}

function makeLiveTestAgentClient(input: {
  readonly agentId?: AgentId;
  readonly client: MoltZapAgentClient;
}): TestAgentClient {
  return {
    principal: "agent",
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    sendRpc<D extends AnyAgentCallableRpcDefinition>(
      definition: D,
      params: ClientDefinitionPayload<D>,
      opts?: RpcCallOptions,
    ): Effect.Effect<ClientDefinitionSuccess<D>, ClientDefinitionError<D>> {
      if (opts === undefined)
        return input.client.callDefinition(definition, params);
      return input.client.callDefinition(definition, params, opts);
    },
    call<Tag extends AgentCallableTag>(
      tag: Tag,
      payload: PayloadForTag<AgentCallableRpcs, Tag>,
      opts?: RpcCallOptions,
    ): Effect.Effect<
      SuccessForTag<AgentCallableRpcs, Tag>,
      AgentRpcError<Tag>
    > {
      if (opts === undefined) return input.client.call(tag, payload);
      return input.client.call(tag, payload, opts);
    },
    subscribe<D extends AnyNotificationDefinition>(
      definition: D,
      refinement?: (params: NotificationParamsOf<D>) => boolean,
    ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError> {
      if (refinement === undefined) return input.client.subscribe(definition);
      return input.client.subscribe(definition, refinement);
    },
    subscribeAll(
      refinement?: (
        delivery: NotificationDelivery<AnyNotificationDefinition>,
      ) => boolean,
    ): Stream.Stream<
      NotificationDelivery<AnyNotificationDefinition>,
      NotConnectedError
    > {
      if (refinement === undefined) return subscribeAllFromClient(input.client);
      return subscribeAllWithDeliveryRefinement(input.client, refinement);
    },
    close: () => input.client.close(),
  };
}

function makeLiveTestAppClient(input: {
  readonly appId?: AppId;
  readonly client: MoltZapAppClient;
}): TestAppClient {
  return {
    principal: "app",
    ...(input.appId !== undefined ? { appId: input.appId } : {}),
    sendRpc<D extends AnyAppCallableRpcDefinition>(
      definition: D,
      params: ClientDefinitionPayload<D>,
      opts?: RpcCallOptions,
    ): Effect.Effect<ClientDefinitionSuccess<D>, ClientDefinitionError<D>> {
      if (opts === undefined)
        return input.client.callDefinition(definition, params);
      return input.client.callDefinition(definition, params, opts);
    },
    call<Tag extends AppCallableTag>(
      tag: Tag,
      payload: PayloadForTag<AppCallableRpcs, Tag>,
      opts?: RpcCallOptions,
    ): Effect.Effect<SuccessForTag<AppCallableRpcs, Tag>, AppRpcError<Tag>> {
      if (opts === undefined) return input.client.call(tag, payload);
      return input.client.call(tag, payload, opts);
    },
    subscribe<D extends AnyNotificationDefinition>(
      definition: D,
      refinement?: (params: NotificationParamsOf<D>) => boolean,
    ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError> {
      if (refinement === undefined) return input.client.subscribe(definition);
      return input.client.subscribe(definition, refinement);
    },
    subscribeAll(
      refinement?: (
        delivery: NotificationDelivery<AnyNotificationDefinition>,
      ) => boolean,
    ): Stream.Stream<
      NotificationDelivery<AnyNotificationDefinition>,
      NotConnectedError
    > {
      if (refinement === undefined) return subscribeAllFromClient(input.client);
      return subscribeAllWithDeliveryRefinement(input.client, refinement);
    },
    close: () => input.client.close(),
  };
}

export function makeTestAgentClient(
  agentId: AgentId,
  options: AgentClientOptions,
): Effect.Effect<TestAgentClient, unknown> {
  return Effect.gen(function* () {
    const client = new MoltZapAgentClient({
      serverUrl: options.serverUrl,
      agentKey: options.agentKey,
    });
    const wrapped = makeLiveTestAgentClient({
      agentId,
      client,
    });
    yield* client
      .connect()
      .pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? client.close() : Effect.void,
        ),
      );
    return wrapped;
  }).pipe(Effect.withSpan("makeTestAgentClient"));
}

export function makeTestAppClient(
  appId: AppId,
  options: AppClientOptions,
): Effect.Effect<TestAppClient, unknown> {
  return Effect.gen(function* () {
    const client = new MoltZapAppClient(options);
    const wrapped = makeLiveTestAppClient({
      appId,
      client,
    });
    yield* client
      .connect()
      .pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? client.close() : Effect.void,
        ),
      );
    return wrapped;
  }).pipe(Effect.withSpan("makeTestAppClient"));
}
