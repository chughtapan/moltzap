import type { HttpClient } from "@effect/platform";
import { Context, type Duration, Effect, Layer } from "effect";
import type { Ed25519PublicKey } from "./ed25519-public-key.js";
import {
  makeRegistryService,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryRequestTimeoutError,
  type RegistryClientService,
} from "./registry/client.js";

/** Closed infrastructure failures returned by the Registry client. */
export {
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryRequestTimeoutError,
};

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
