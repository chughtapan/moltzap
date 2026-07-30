/** @file Network service tags and live layers. */

import { Context, Effect, Layer } from "effect";

import { ConnectionManagerTag } from "#socket";

import { AgentEndpointResolver } from "./agent-endpoint-resolver.js";
import { NetworkSendService } from "./network-send.js";

/** Implements agent endpoint resolver tag. */
export class AgentEndpointResolverTag extends Context.Tag(
  "moltzap/AgentEndpointResolver",
)<AgentEndpointResolverTag, AgentEndpointResolver>() {}

/** Implements network send service tag. */
export class NetworkSendServiceTag extends Context.Tag(
  "moltzap/NetworkSendService",
)<NetworkSendServiceTag, NetworkSendService>() {}

/** Provides the agent endpoint resolver live runtime value. */
export const agentEndpointResolverLive = Layer.effect(
  AgentEndpointResolverTag,
  AgentEndpointResolver.make,
);

/** Provides the network send service live runtime value. */
export const networkSendServiceLive = Layer.effect(
  NetworkSendServiceTag,
  Effect.gen(function* () {
    const resolver = yield* AgentEndpointResolverTag;
    const connections = yield* ConnectionManagerTag;
    return new NetworkSendService(resolver, connections);
  }).pipe(Effect.withSpan("NetworkSendServiceLive")),
);
