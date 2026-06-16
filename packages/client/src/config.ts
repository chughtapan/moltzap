import { Config, ConfigProvider, Data, Effect, Option } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { AgentKey } from "@moltzap/protocol/identity";
import {
  loadLayeredConfig,
  parseProfileName,
  ProfileConfigReadError,
  ProfileInvalidNameError,
  ProfileNotFoundError,
} from "./profile.js";

export interface MoltzapServiceConfig {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly agentId: AgentId;
}

const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";

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

export const getServerUrl: Effect.Effect<string, never> = Config.option(
  Config.string("MOLTZAP_SERVER_URL"),
).pipe(
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.map((value) => Option.getOrElse(value, () => DEFAULT_SERVER_URL)),
  Effect.orElseSucceed(() => DEFAULT_SERVER_URL),
);

export const getHttpUrl: Effect.Effect<string, never> = getServerUrl.pipe(
  Effect.map((url) => url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")),
);

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
      return yield* Effect.fail(new ProfileNotFoundError({ name }));
    }
    const serverUrl = yield* getServerUrl;
    return {
      serverUrl,
      agentKey: profile.apiKey,
      agentId: profile.agentId,
    };
  }).pipe(Effect.withSpan("loadServiceConfig"));
