import type { HttpClient } from "@effect/platform";
import { Context, type Duration, Effect, Layer } from "effect";
import type { Ed25519PublicKey } from "./agent-key.js";
import { makeRegistryService } from "./registry/client.js";
import type { RegistryClientService } from "./registry/contract.js";

/** Closed Registry requests, verified results, and client failures. */
export {
  OperationId,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryListRequest,
  type RegistryListResult,
  RegistryLookupRequest,
  type RegistryLookupResult,
  RegistryRegisterRequest,
  type RegistryRegisterResult,
  RegistryRequestTimeoutError,
} from "./registry/contract.js";

/** Bootstrap registration and immutable identity resolution. */
export class Registry extends Context.Tag("@moltzap/v2-identity/Registry")<
  Registry,
  RegistryClientService
>() {
  static readonly register = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.register,
  );

  static readonly lookup = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.lookup,
  );

  static readonly list = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.list,
  );

  static readonly layer = (input: {
    readonly origin: URL;
    readonly registrySignerPublicKey: Ed25519PublicKey;
    readonly requestTimeout: Duration.Duration;
  }): Layer.Layer<Registry, never, HttpClient.HttpClient> =>
    Layer.effect(Registry, makeRegistryService(input));
}
