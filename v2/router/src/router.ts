import type { HttpClient } from "@effect/platform";
import type { AgentId, AgentSigningAuthority } from "@moltzap/v2-identity";
import { Context, type Duration, Effect, Layer } from "effect";
import {
  makeRouterClient,
  type RouterClientError,
  type RouterClientService,
} from "./router/client.js";
import type {
  RouterPollRequest,
  RouterPollResult,
  RouterSendRequest,
  RouterSendResult,
} from "./router/operations.js";

/** Opaque message acceptance and endpoint-wide bounded polling. */
export class Router extends Context.Tag("@moltzap/v2-router/Router")<
  Router,
  RouterClientService
>() {
  static readonly send: (input: {
    readonly request: RouterSendRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterSendResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.send);

  static readonly poll: (input: {
    readonly request: RouterPollRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterPollResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.poll);

  static readonly layer = (input: {
    readonly origin: URL;
    readonly sendTimeout: Duration.Duration;
    readonly pollTimeout: Duration.Duration;
  }): Layer.Layer<Router, never, HttpClient.HttpClient> =>
    Layer.effect(Router, makeRouterClient(input));
}
