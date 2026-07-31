/**
 * Registry and AuthenticatedHttp keep their complete public inputs and Effect
 * channels exact. These canaries prevent adapters from leaking private
 * requirements or silently widening the failures consumers must handle.
 */

import type {
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
} from "@effect/platform";
import type {
  AgentSigningAuthority,
  AgentSigningError,
  AgentId,
  AuthenticatedHttp,
  AuthenticationFailedError,
  Ed25519PublicKey,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  Registry,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryListRequest,
  RegistryListResult,
  RegistryLookupRequest,
  RegistryLookupResult,
  RegistryRegisterRequest,
  RegistryRegisterResult,
  RegistryRequestTimeoutError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VerifiedAgentRequest,
  VersionMismatchError,
} from "../index.js";
import type { RegistryServer } from "../server.js";
import type { Duration, Effect, Layer, Redacted } from "effect";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type RegistryClientFailure =
  | MalformedRequestError
  | RouteNotFoundError
  | MethodNotAllowedError
  | VersionMismatchError
  | PayloadTooLargeError
  | UnsupportedMediaTypeError
  | OverloadedError
  | UnavailableError
  | InternalServerError
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError;
type RegisterFailure =
  | RegistryClientFailure
  | AuthenticationFailedError
  | AgentSigningError;
type AuthenticationFailure =
  | MalformedRequestError
  | AuthenticationFailedError
  | VersionMismatchError
  | OverloadedError
  | UnavailableError;

type RegisterCall = Readonly<{
  request: RegistryRegisterRequest;
  admissionCredential: Redacted.Redacted;
  signingAuthority: AgentSigningAuthority;
}>;
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

type RegisterEffect = ReturnType<typeof Registry.register>;
type LookupEffect = ReturnType<typeof Registry.lookup>;
type ListEffect = ReturnType<typeof Registry.list>;
type SignEffect = ReturnType<typeof AuthenticatedHttp.signAgentRequest>;
type VerifyEffect = ReturnType<typeof AuthenticatedHttp.verifyAgentRequest>;
type RegistryLayer = ReturnType<typeof Registry.layer>;
type AuthenticationLayer = ReturnType<typeof AuthenticatedHttp.layer>;
type ServerLayer = typeof RegistryServer.layer;

type RegisterInputIsExact = Expect<
  Equal<Parameters<typeof Registry.register>[0], RegisterCall>
>;
type RegisterChannelsAreExact = Expect<
  Equal<
    RegisterEffect,
    Effect.Effect<RegistryRegisterResult, RegisterFailure, Registry>
  >
>;
type LookupChannelsAreExact = Expect<
  Equal<
    LookupEffect,
    Effect.Effect<RegistryLookupResult, RegistryClientFailure, Registry>
  >
>;
type LookupInputIsExact = Expect<
  Equal<Parameters<typeof Registry.lookup>[0], RegistryLookupRequest>
>;
type ListChannelsAreExact = Expect<
  Equal<
    ListEffect,
    Effect.Effect<RegistryListResult, RegistryClientFailure, Registry>
  >
>;
type ListInputIsExact = Expect<
  Equal<Parameters<typeof Registry.list>[0], RegistryListRequest>
>;
type RegistryLayerInputIsExact = Expect<
  Equal<
    Parameters<typeof Registry.layer>[0],
    Readonly<{
      origin: URL;
      registrySignerPublicKey: Ed25519PublicKey;
      requestTimeout: Duration.Duration;
    }>
  >
>;
type RegistryLayerIsExact = Expect<
  Equal<RegistryLayer, Layer.Layer<Registry, never, HttpClient.HttpClient>>
>;
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
type ServerLayerIsExact = Expect<
  Equal<ServerLayer, Layer.Layer<never, RegistryServer.StartupError>>
>;

/** Compile-time evidence for both public HTTP-facing capabilities. */
export type RegistryCapabilityCanaries = [
  RegisterInputIsExact,
  RegisterChannelsAreExact,
  LookupInputIsExact,
  LookupChannelsAreExact,
  ListInputIsExact,
  ListChannelsAreExact,
  RegistryLayerInputIsExact,
  RegistryLayerIsExact,
  SignInputIsExact,
  SignChannelsAreExact,
  VerifyInputIsExact,
  VerifyChannelsAreExact,
  AuthenticationLayerInputIsExact,
  AuthenticationLayerIsExact,
  ServerLayerIsExact,
];
