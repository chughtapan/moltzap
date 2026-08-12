/**
 * @file Scopes environment and profile fixtures around Client configuration
 * tests.
 */

import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import { Effect, Redacted } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"; // eslint-disable-line agent-code-guard/prefer-effect-platform -- The acquire callback builds and removes its synchronous fixture before exposing the Effect under test.
import { tmpdir } from "node:os";
import { join } from "node:path";

/* eslint-disable agent-code-guard/acquire-release-requires-scope, agent-code-guard/no-process-env-at-runtime -- Test-only helper scopes process.env and temp config files around one Effect. */

interface TestServiceConfig {
  readonly agentId: AgentId;
  readonly agentKey: AgentKey;
  readonly serverUrl: string;
  readonly profileName?: string;
  readonly agentName?: string;
}

const ENV_SERVER_URL = "MOLTZAP_SERVER_URL";
const ENV_CONFIG_HOME = "MOLTZAP_CONFIG_HOME";
const CONFIG_FILE_NAME = "config.json";

/**
 * Installs a temporary server address and, when named, a profile file for the
 * lifetime of one Effect, then restores the caller's environment.
 * @param config Endpoint values exposed to the Effect under test.
 * @param effect Effect that reads the scoped configuration.
 * @returns The original Effect with fixture acquisition and cleanup attached.
 */
export function withTestServiceConfig<A, E, R>(
  config: TestServiceConfig,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previousServerUrl = process.env[ENV_SERVER_URL];
      const previousConfigHome = process.env[ENV_CONFIG_HOME];
      const configHome = config.profileName
        ? mkdtempSync(join(tmpdir(), "moltzap-test-config-"))
        : undefined;
      process.env[ENV_SERVER_URL] = config.serverUrl;
      if (configHome !== undefined && config.profileName !== undefined) {
        process.env[ENV_CONFIG_HOME] = configHome;
        writeFileSync(
          join(configHome, CONFIG_FILE_NAME),
          JSON.stringify(
            {
              profiles: {
                [config.profileName]: {
                  agentId: config.agentId,
                  apiKey: Redacted.value(config.agentKey),
                  agentName: config.agentName ?? config.profileName,
                },
              },
            },
            null,
            2,
          ),
        );
      }
      return () => {
        restoreEnv(ENV_SERVER_URL, previousServerUrl);
        restoreEnv(ENV_CONFIG_HOME, previousConfigHome);
        if (configHome !== undefined) {
          rmSync(configHome, { recursive: true, force: true });
        }
      };
    }),
    () => effect,
    (restore) => Effect.sync(restore),
  );
}

function restoreEnv(key: string, value?: string): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

/* eslint-enable agent-code-guard/acquire-release-requires-scope, agent-code-guard/no-process-env-at-runtime -- Restore strict defaults after the scoped exception. */
