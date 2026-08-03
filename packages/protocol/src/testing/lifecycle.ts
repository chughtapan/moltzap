import { Effect, Exit, type Stream } from "effect";
import type {
  agentCallableGroup,
  AnyAgentCallableRpcDefinition,
  AnyNotificationDefinition,
} from "#socket/catalog";
import type {
  NotificationDelivery,
  NotificationParamsOf,
  ErrorForTag,
  PayloadForTag,
  SuccessForTag,
  NotConnectedError,
  RpcTimeoutError,
} from "#transport";
import {
  MoltZapAgentClient,
  type AgentClientOptions,
  type ClientDefinitionError,
  type ClientDefinitionPayload,
  type ClientDefinitionSuccess,
  type RpcCallOptions,
} from "#socket";
import type { AgentId } from "#identity/agents";
import type { RpcGroup } from "@effect/rpc";

type AgentCallableRpcs = RpcGroup.Rpcs<typeof agentCallableGroup>;
type AgentCallableTag = AgentCallableRpcs["_tag"];
type AgentRpcError<Tag extends AgentCallableTag> =
  | ErrorForTag<AgentCallableRpcs, Tag>
  | NotConnectedError
  | RpcTimeoutError;

/** Describes test server. */
export interface TestServer {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly close: Effect.Effect<void, unknown>;
}

/** Describes test agent client. */
export interface TestAgentClient {
  readonly principal: "agent";
  readonly agentId?: AgentId;
  close(): Effect.Effect<void>;
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

type SubscribingClient = MoltZapAgentClient;

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
      return input.client.callDefinition(definition, params, opts ?? {});
    },
    call<Tag extends AgentCallableTag>(
      tag: Tag,
      payload: PayloadForTag<AgentCallableRpcs, Tag>,
      opts?: RpcCallOptions,
    ): Effect.Effect<
      SuccessForTag<AgentCallableRpcs, Tag>,
      AgentRpcError<Tag>
    > {
      return input.client.call(tag, payload, opts ?? {});
    },
    subscribe<D extends AnyNotificationDefinition>(
      definition: D,
      refinement?: (params: NotificationParamsOf<D>) => boolean,
    ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError> {
      if (refinement === undefined) {
        return input.client.subscribe(definition);
      }
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
      if (refinement === undefined) {
        return subscribeAllFromClient(input.client);
      }
      return subscribeAllWithDeliveryRefinement(input.client, refinement);
    },
    close: () => input.client.close(),
  };
}

/**
 * Creates test agent client.
 * @param agentId Identifier of the agent targeted by the operation.
 * @param options Options that control the operation.
 * @returns The created test agent client.
 */
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
