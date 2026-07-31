/**
 * Registry keeps its complete public inputs and Effect channels exact.
 * These canaries prevent adapters from leaking private requirements or
 * silently widening the failures consumers must handle.
 */

import type { HttpClient } from "@effect/platform";
import type {
  AgentSigningAuthority,
  AgentSigningError,
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
  VersionMismatchError,
} from "../../index.js";
import type { RegistryServer } from "../../server.js";
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
type RegisterCall = Readonly<{
  request: RegistryRegisterRequest;
  admissionCredential: Redacted.Redacted;
  signingAuthority: AgentSigningAuthority;
}>;

type RegisterEffect = ReturnType<typeof Registry.register>;
type LookupEffect = ReturnType<typeof Registry.lookup>;
type ListEffect = ReturnType<typeof Registry.list>;
type RegistryLayer = ReturnType<typeof Registry.layer>;
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
type ServerLayerIsExact = Expect<
  Equal<ServerLayer, Layer.Layer<never, RegistryServer.StartupError>>
>;

/** Compile-time evidence for the public Registry capability. */
export type RegistryCapabilityCanaries = [
  RegisterInputIsExact,
  RegisterChannelsAreExact,
  LookupInputIsExact,
  LookupChannelsAreExact,
  ListInputIsExact,
  ListChannelsAreExact,
  RegistryLayerInputIsExact,
  RegistryLayerIsExact,
  ServerLayerIsExact,
];
