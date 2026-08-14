import type { HarnessTurn, StartInput } from "@moltzap/client";
import type { AgentId, AgentName, SignedMessage } from "@moltzap/identity";
import type { Effect, Scope, Stream } from "effect";
import * as simulator from "@moltzap/simulator";
import type {
  ClusterServices,
  NetworkService as RootNetworkService,
  RunSpec,
} from "@moltzap/simulator";
import * as agents from "@moltzap/simulator/agents";
import type {
  AgentRuntimeInput,
  StartedAgent,
} from "@moltzap/simulator/agents";
import * as ledger from "@moltzap/simulator/ledger";
import * as network from "@moltzap/simulator/network";
import type {
  AgentConnection,
  AgentHandle,
  ConversationAddress,
  ConversationSocket,
  Endpoint,
  EndpointTransport,
  LinkDelivery,
  LinkDriverService,
  LinkPolicyLease,
  NetworkError,
  NetworkService,
  Router,
  RouterProvider,
  RouterProviderService,
  RouterStopped,
} from "@moltzap/simulator/network";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type RunNetwork = Parameters<RunSpec["execute"]>[0]["network"];
type RunNetworkIsPublicNetwork = Assert<Equal<RunNetwork, RootNetworkService>>;
type RouterProviderIsAClusterService = Assert<
  RouterProvider extends ClusterServices ? true : false
>;

interface PositiveNetworkMembers {
  readonly address: ConversationAddress;
  readonly connection: AgentConnection<"alice">;
  readonly delivery: LinkDelivery;
  readonly driver: LinkDriverService;
  readonly endpoint: Endpoint<"alice">;
  readonly endpointTransport: EndpointTransport;
  readonly lease: LinkPolicyLease;
  readonly networkService: NetworkService;
  readonly provider: RouterProviderService;
  readonly router: Router;
  readonly runtimeInput: AgentRuntimeInput;
  readonly socket: ConversationSocket;
  readonly startInput: StartInput;
  readonly started: StartedAgent<"alice", unknown>;
}

export function verifyPositiveNetworkMembers(input: PositiveNetworkMembers) {
  const endpointMessages: Stream.Stream<HarnessTurn, NetworkError> =
    input.endpoint.messages();
  const endpointStart: Effect.Effect<void, NetworkError> = input.endpoint.start(
    input.startInput,
  );
  const socket: Effect.Effect<ConversationSocket, NetworkError> =
    input.endpoint.socket(input.address);
  const constructedAddress: ConversationAddress =
    new network.ConversationAddress(
      input.address.conversationId,
      input.address.participants,
    );
  const rootConstructedAddress: ConversationAddress =
    new simulator.ConversationAddress(
      input.address.conversationId,
      input.address.participants,
    );
  const received: Stream.Stream<HarnessTurn, NetworkError> =
    input.endpointTransport.received;
  const transportStart: Effect.Effect<void, NetworkError> =
    input.endpointTransport.start(input.startInput);
  const nextTurn: Effect.Effect<HarnessTurn, NetworkError> =
    input.socket.receive();
  const agent: AgentHandle<"alice"> = input.connection.agent;
  const startedAgent: AgentHandle<"alice"> = input.started.agent;
  const agentName: AgentName = input.runtimeInput.agentName;
  const routerAddress: URL = input.router.address;
  const stopped: Effect.Effect<RouterStopped, NetworkError> =
    input.router.stopped;
  const acquire: Effect.Effect<Router, NetworkError, Scope.Scope> =
    input.provider.acquire;
  const signedMessage: SignedMessage = input.delivery.message;
  const from: AgentId = input.delivery.from;
  const to: AgentId = input.delivery.to;
  const disable: Effect.Effect<void, NetworkError> = input.driver.disable(
    from,
    to,
  );
  const enable: Effect.Effect<void, NetworkError> = input.driver.enable(
    from,
    to,
  );
  const clear: Effect.Effect<void, NetworkError> = input.lease.clear;
  const controlledEndpoint: Effect.Effect<
    Endpoint<"alice">,
    NetworkError
  > = input.networkService.endpoint("alice");

  return {
    acquire,
    agent,
    agentName,
    clear,
    controlledEndpoint,
    constructedAddress,
    disable,
    enable,
    endpointMessages,
    endpointStart,
    from,
    nextTurn,
    received,
    rootConstructedAddress,
    routerAddress,
    signedMessage,
    socket,
    startedAgent,
    stopped,
    to,
    transportStart,
  };
}

void simulator;
void network;
void ledger;
void agents;

export type { RouterProviderIsAClusterService, RunNetworkIsPublicNetwork };
