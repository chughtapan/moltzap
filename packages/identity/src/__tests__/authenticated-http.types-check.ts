/**
 * @file AuthenticatedHttp keeps its complete signing and verification inputs and
 * Effect channels exact. These canaries prevent adapters from leaking private
 * requirements or silently widening the failures consumers must handle.
 */

import type { HttpClientRequest, HttpServerRequest } from "@effect/platform";
import type { Effect, Layer } from "effect";
import type {
  AgentId,
  AgentSigningAuthority,
  AgentSigningError,
  AuthenticatedHttp,
  AuthenticationFailedError,
  MalformedRequestError,
  OverloadedError,
  UnavailableError,
  VerifiedAgentRequest,
  VersionMismatchError,
} from "../index.js";
import type { Registry } from "../registry.js";

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- `Probe` stays generic so TypeScript compares the two deferred conditional types by identity. */
/**
 * True only when the two types are identical, so an added optional property
 * or a dropped `readonly` modifier fails the canary.
 */
type Equal<Left, Right> =
  (<Probe>() => Probe extends Left ? 1 : 2) extends <
    Probe,
  >() => Probe extends Right ? 1 : 2
    ? true
    : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters -- Restore repository defaults after the identity helper. */
type Expect<Value extends true> = Value;

type AuthenticationFailure =
  | MalformedRequestError
  | AuthenticationFailedError
  | VersionMismatchError
  | OverloadedError
  | UnavailableError;

type SignCall = Readonly<{
  httpRequest: HttpClientRequest.HttpClientRequest;
  callerAgentId: AgentId;
  encodedRequest: unknown;
  signingAuthority: AgentSigningAuthority;
}>;
type VerifyCall = Readonly<{
  httpRequest: HttpServerRequest.HttpServerRequest;
  bodyBytes: Uint8Array;
}>;

type SignEffect = ReturnType<typeof AuthenticatedHttp.signAgentRequest>;
type VerifyEffect = ReturnType<typeof AuthenticatedHttp.verifyAgentRequest>;
type AuthenticationLayer = ReturnType<typeof AuthenticatedHttp.layer>;

type SignInputIsExact = Expect<
  Equal<Parameters<typeof AuthenticatedHttp.signAgentRequest>[0], SignCall>
>;
type SignChannelsAreExact = Expect<
  Equal<
    SignEffect,
    Effect.Effect<HttpClientRequest.HttpClientRequest, AgentSigningError>
  >
>;
type VerifyInputIsExact = Expect<
  Equal<Parameters<typeof AuthenticatedHttp.verifyAgentRequest>[0], VerifyCall>
>;
type VerifyChannelsAreExact = Expect<
  Equal<
    VerifyEffect,
    Effect.Effect<
      VerifiedAgentRequest,
      AuthenticationFailure,
      AuthenticatedHttp
    >
  >
>;
type AuthenticationLayerInputIsExact = Expect<
  Equal<
    Parameters<typeof AuthenticatedHttp.layer>[0],
    Readonly<{
      liveNonceCapacity: number;
      agentCardCacheCapacity: number;
      registryLookupConcurrencyLimit: number;
    }>
  >
>;
type AuthenticationLayerIsExact = Expect<
  Equal<AuthenticationLayer, Layer.Layer<AuthenticatedHttp, never, Registry>>
>;

/** Compile-time evidence for the public AuthenticatedHttp capability. */
export type AuthenticatedHttpCapabilityCanaries = [
  SignInputIsExact,
  SignChannelsAreExact,
  VerifyInputIsExact,
  VerifyChannelsAreExact,
  AuthenticationLayerInputIsExact,
  AuthenticationLayerIsExact,
];
