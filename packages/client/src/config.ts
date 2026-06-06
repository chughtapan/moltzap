import { Config, ConfigProvider, Data, Effect, Option } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { AgentKey } from "@moltzap/protocol/identity";
import {
  loadLayeredConfig,
  parseProfileName,
  ProfileConfigReadError,
  ProfileInvalidNameError,
  ProfileNotFoundError,
  type StoredProfileRecord,
} from "./profile.js";

export interface MoltzapServiceConfig {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly agentId: AgentId;
}

const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";

export type ServiceConfigError =
  | AuthNotConfiguredError
  | ConfigReadError
  | ProfileInvalidNameError
  | ProfileNotFoundError;

class ConfigReadError extends Data.TaggedError("ConfigReadError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
}> {}

class AuthNotConfiguredError extends Data.TaggedError(
  "AuthNotConfiguredError",
)<{
  readonly message: string;
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

function requireProfileAuth(
  profileName: string,
  value: StoredProfileRecord,
): Effect.Effect<
  { readonly agentKey: AgentKey; readonly agentId: AgentId },
  AuthNotConfiguredError
> {
  if (value.apiKey === undefined) {
    return Effect.fail(
      new AuthNotConfiguredError({
        message: `Profile "${profileName}" is missing an apiKey. Run \`moltzap register --profile ${profileName}\` first.`,
      }),
    );
  }
  return Effect.succeed({
    agentKey: value.apiKey,
    agentId: value.agentId,
  });
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
    const config = yield* requireProfileAuth(name, profile);
    const serverUrl = yield* getServerUrl;
    return {
      serverUrl,
      agentKey: config.agentKey,
      agentId: config.agentId,
    };
  }).pipe(Effect.withSpan("loadServiceConfig"));
