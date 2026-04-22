import { Effect } from "effect";

import type { CoreApp } from "@moltzap/server-core";

import {
  NanoclawAdapter,
  type LogSlice,
  type ReadyOutcome,
} from "../runtimes/index.js";
import { SpawnFailed } from "../runtimes/errors.js";
import { DockerManager, type AgentContainer } from "./docker-manager.js";
import { logger } from "./logger.js";
import {
  createFleetStartedTelemetryEvent,
  createFleetStoppedTelemetryEvent,
  telemetry,
} from "./telemetry.js";
import type {
  DockerHealthTimeoutError,
  DockerImageError,
  DockerStartError,
} from "./types.js";

export type EvalRuntimeKind = "openclaw" | "nanoclaw";

export interface EvalRuntimeSession {
  readonly name: string;
  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never>;
  teardown(): Effect.Effect<void, never, never>;
  getLogs(offset: number): LogSlice;
  getInboundMarker(): string;
}

export interface LaunchEvalRuntimeInput {
  readonly runtime: EvalRuntimeKind;
  readonly agentName: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly serverUrl: string;
  readonly coreApp: CoreApp;
  readonly modelId?: string;
  readonly workspaceFiles?: ReadonlyArray<{
    relativePath: string;
    content: string;
  }>;
  readonly connectTimeoutMs?: number;
}

export type LaunchEvalRuntimeError =
  | SpawnFailed
  | DockerImageError
  | DockerStartError
  | DockerHealthTimeoutError;

function brand<T extends string>(
  value: string,
  _brand: T,
): string & { readonly __brand: T } {
  return value as string & { readonly __brand: T };
}

function tailLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n");
}

function logRuntimeTail(name: string, logs: string): void {
  if (!logs.trim()) {
    return;
  }
  logger.info(`Runtime "${name}" logs (last 20):\n${tailLines(logs, 20)}`);
}

function emitFleetStartedOnce(
  runtime: EvalRuntimeKind,
  agentName: string,
  serverUrl: string,
  startedRef: { value: boolean },
): void {
  if (startedRef.value) {
    return;
  }
  startedRef.value = true;
  telemetry.emit(
    createFleetStartedTelemetryEvent({
      ts: new Date().toISOString(),
      runtime,
      agentNames: [agentName],
      serverUrl,
    }),
  );
}

function emitFleetStoppedIfStarted(
  runtime: EvalRuntimeKind,
  agentName: string,
  startedRef: { value: boolean },
): void {
  if (!startedRef.value) {
    return;
  }
  telemetry.emit(
    createFleetStoppedTelemetryEvent({
      ts: new Date().toISOString(),
      runtime,
      agentNames: [agentName],
    }),
  );
}

function createNanoclawSession(
  input: LaunchEvalRuntimeInput,
): Effect.Effect<EvalRuntimeSession, SpawnFailed, never> {
  return Effect.gen(function* () {
    const adapter = new NanoclawAdapter({ coreApp: input.coreApp });
    const startedRef = { value: false };
    let tornDown = false;

    yield* adapter.spawn({
      agentName: brand(input.agentName, "AgentName"),
      apiKey: brand(input.apiKey, "ApiKey"),
      agentId: input.agentId,
      serverUrl: brand(input.serverUrl, "ServerUrl"),
    });

    return {
      name: input.agentName,
      waitUntilReady(
        timeoutMs: number,
      ): Effect.Effect<ReadyOutcome, never, never> {
        return adapter.waitUntilReady(timeoutMs).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() => {
              if (outcome._tag === "Ready") {
                emitFleetStartedOnce(
                  input.runtime,
                  input.agentName,
                  input.serverUrl,
                  startedRef,
                );
              }
            }),
          ),
        );
      },
      teardown(): Effect.Effect<void, never, never> {
        return Effect.gen(function* () {
          if (tornDown) {
            return;
          }
          tornDown = true;
          logRuntimeTail(input.agentName, adapter.getLogs(0).text);
          yield* adapter.teardown();
          yield* Effect.sync(() =>
            emitFleetStoppedIfStarted(
              input.runtime,
              input.agentName,
              startedRef,
            ),
          );
        });
      },
      getLogs(offset: number): LogSlice {
        return adapter.getLogs(offset);
      },
      getInboundMarker(): string {
        return adapter.getInboundMarker();
      },
    } satisfies EvalRuntimeSession;
  });
}

function createOpenclawLogSlice(
  dockerManager: DockerManager,
  container: AgentContainer,
  offset: number,
): LogSlice {
  const full = dockerManager.getContainerLogs(container);
  return {
    text: full.slice(offset),
    nextOffset: full.length,
  };
}

function createOpenclawSession(
  input: LaunchEvalRuntimeInput,
): Effect.Effect<
  EvalRuntimeSession,
  DockerImageError | DockerStartError | DockerHealthTimeoutError,
  never
> {
  return Effect.gen(function* () {
    const dockerManager = new DockerManager();
    const startedRef = { value: false };
    let tornDown = false;

    yield* dockerManager.ensureImage();
    const container = yield* dockerManager.startAgentAndWait({
      name: input.agentName,
      agentModelId: input.modelId,
      moltzapServerUrl: input.serverUrl,
      moltzapApiKey: input.apiKey,
      workspaceFiles: input.workspaceFiles
        ? [...input.workspaceFiles]
        : undefined,
      connectTimeoutMs: input.connectTimeoutMs,
    });

    return {
      name: input.agentName,
      waitUntilReady(
        _timeoutMs: number,
      ): Effect.Effect<ReadyOutcome, never, never> {
        return Effect.sync(() => {
          emitFleetStartedOnce(
            input.runtime,
            input.agentName,
            input.serverUrl,
            startedRef,
          );
          return { _tag: "Ready" as const };
        });
      },
      teardown(): Effect.Effect<void, never, never> {
        return Effect.gen(function* () {
          if (tornDown) {
            return;
          }
          tornDown = true;
          logRuntimeTail(
            input.agentName,
            dockerManager.getContainerLogs(container),
          );
          yield* dockerManager
            .stopAgent(container)
            .pipe(
              Effect.catchAll((err) =>
                Effect.sync(() =>
                  logger.warn(
                    `Failed to stop runtime "${input.agentName}": ${err.message}`,
                  ),
                ),
              ),
            );
          yield* Effect.sync(() =>
            emitFleetStoppedIfStarted(
              input.runtime,
              input.agentName,
              startedRef,
            ),
          );
        });
      },
      getLogs(offset: number): LogSlice {
        return createOpenclawLogSlice(dockerManager, container, offset);
      },
      getInboundMarker(): string {
        return "inbound from agent:";
      },
    } satisfies EvalRuntimeSession;
  });
}

function absurd(x: never): never {
  throw new Error(`Unexpected runtime: ${String(x)}`);
}

export function launchEvalRuntime(
  input: LaunchEvalRuntimeInput,
): Effect.Effect<EvalRuntimeSession, LaunchEvalRuntimeError, never> {
  switch (input.runtime) {
    case "nanoclaw":
      return createNanoclawSession(input);
    case "openclaw":
      return createOpenclawSession(input);
    default:
      return absurd(input.runtime);
  }
}
