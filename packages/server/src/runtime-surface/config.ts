/**
 * Architecture-only contract for shared runtime process config.
 *
 * Implementers fill this in during the approved runtime cleanup slice.
 */

import { Data, Effect } from "effect";
import type { LoadedConfig } from "../app/config.js";
import type { MoltZapAppConfig } from "../config/effect-config.js";

export type RuntimeConfigPath = string & {
  readonly __brand: "RuntimeConfigPath";
};

export type RuntimeEnvironment = "development" | "test" | "production";

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLoggingConfig {
  readonly level: RuntimeLogLevel;
  readonly preserveLegacyFields: boolean;
}

export interface RuntimeTracingConfig {
  readonly serviceName: string;
  readonly includeFiberIds: boolean;
  readonly includeRequestContext: boolean;
}

export interface LoadRuntimeConfigInput {
  readonly configPath?: RuntimeConfigPath;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

export interface RuntimeProcessConfig {
  readonly configPath: RuntimeConfigPath;
  readonly configDirectory: string;
  readonly environment: RuntimeEnvironment;
  readonly logging: RuntimeLoggingConfig;
  readonly tracing: RuntimeTracingConfig;
  readonly app: MoltZapAppConfig;
  readonly server: LoadedConfig;
}

export class RuntimeConfigSurfaceError extends Data.TaggedError(
  "RuntimeConfigSurfaceError",
)<{
  readonly cause:
    | {
        readonly _tag: "ConfigFileUnreadable";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "ConfigFileInvalid";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "EnvironmentInvalid";
        readonly key: string;
        readonly message: string;
      }
    | {
        readonly _tag: "DirectoryResolutionFailed";
        readonly path: string;
        readonly message: string;
      };
}> {}

export function loadRuntimeProcessConfig(
  _input: LoadRuntimeConfigInput,
): Effect.Effect<RuntimeProcessConfig, RuntimeConfigSurfaceError, never> {
  throw new Error("not implemented");
}
