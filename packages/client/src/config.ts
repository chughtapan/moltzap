import { Config, ConfigProvider, Data, Effect, Option, Schema } from "effect";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import {
  httpBaseUrl,
  serverBaseUrl,
  serverBaseUrlSchema,
  type ServerBaseUrl as ServerBaseUrlType,
} from "@moltzap/protocol/network";
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

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

function configReadErrorFromProfile(
  error: ProfileConfigReadError,
): ConfigReadError {
  return configReadError(error.path, error.cause, "read");
}

const configuredServerUrl = Config.option(Config.string(SERVER_URL_ENV)).pipe(
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.map((value) => Option.getOrElse(value, () => DEFAULT_SERVER_URL)),
);

/** Canonical path-free server address from the environment or default. */
export const getServerUrl: Effect.Effect<ServerBaseUrlType, ConfigReadError> =
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
 * Provides the load service config runtime value.
 * @param profileName Value supplied to the operation.
 * @returns The load service config result.
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
