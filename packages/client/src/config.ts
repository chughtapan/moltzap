/** @file Resolves one local agent profile and its canonical server address. */

import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import {
  httpBaseUrl,
  serverBaseUrl,
  serverBaseUrlSchema,
  type ServerBaseUrl as ServerBaseUrlType,
} from "@moltzap/protocol/network";
import { Config, ConfigProvider, Data, Effect, Option, Schema } from "effect";
import {
  loadLayeredConfig,
  parseProfileName,
  type ProfileConfigReadError,
  type ProfileInvalidNameError,
  ProfileNotFoundError,
} from "./profile.js";

/** Describes moltzap service config. */
export interface MoltzapServiceConfig {
  readonly serverUrl: ServerBaseUrlType;
  readonly agentKey: AgentKey;
  readonly agentId: AgentId;
}

const DEFAULT_SERVER_URL = serverBaseUrl("wss://api.moltzap.xyz");
const SERVER_URL_ENV = "MOLTZAP_SERVER_URL";

/** Represents service config error conditions. */
export type ServiceConfigError =
  | ConfigReadError
  | ProfileInvalidNameError
  | ProfileNotFoundError;

class ConfigReadError extends Data.TaggedError("ConfigReadError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
}> {}

function configReadErrorFromProfile(
  error: ProfileConfigReadError,
): ConfigReadError {
  return configReadError(error.path, error.cause, "read");
}

function configReadError(
  configPath: string,
  cause: unknown,
  detail: string,
): ConfigReadError {
  return new ConfigReadError({
    cause,
    message: `Failed to ${detail} ${configPath}: ${describeCause(cause)}`,
    path: configPath,
  });
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const configuredServerUrl = Config.option(Config.string(SERVER_URL_ENV)).pipe(
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.map((value) => Option.getOrElse(value, () => DEFAULT_SERVER_URL)),
);

/** Canonical path-free server address from the environment or default. */
const getServerUrl: Effect.Effect<ServerBaseUrlType, ConfigReadError> =
  configuredServerUrl.pipe(
    Effect.flatMap(Schema.decodeUnknown(serverBaseUrlSchema)),
    Effect.mapError((cause) =>
      configReadError(SERVER_URL_ENV, cause, "read and validate"),
    ),
  );

/** HTTP control-plane origin derived from the same canonical address. */
export const getHttpUrl: Effect.Effect<string, ConfigReadError> =
  getServerUrl.pipe(Effect.map(httpBaseUrl));

/**
 * Loads the credentials for one named local profile and pairs them with the
 * process-wide canonical server address.
 * @param profileName Profile whose endpoint identity should be loaded.
 * @returns The identity credential and normalized server address.
 */
export const loadServiceConfig = (
  profileName: string,
): Effect.Effect<MoltzapServiceConfig, ServiceConfigError> =>
  Effect.gen(function* () {
    const name = yield* parseProfileName(profileName);
    const layered = yield* loadLayeredConfig.pipe(
      Effect.mapError(configReadErrorFromProfile),
    );
    const profile = layered.profiles.get(name);
    if (profile === undefined) {
      return yield* new ProfileNotFoundError({ name });
    }
    const serverUrl = yield* getServerUrl;
    return {
      serverUrl,
      agentKey: profile.apiKey,
      agentId: profile.agentId,
    };
  }).pipe(Effect.withSpan("loadServiceConfig"));
