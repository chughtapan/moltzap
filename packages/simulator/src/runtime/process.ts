/** @file Shared observation of already-acquired autonomous processes. */

import type { ExitCode } from "@effect/platform/CommandExecutor";
import type { AgentKey, AgentName } from "@moltzap/protocol/identity";
import {
  RuntimeExited,
  RuntimeFailed,
  type RuntimeTermination,
} from "./runtime.js";
import { Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { attachChildOutput } from "./command.js";

const AGENT_KEY_REDACTION_MARKER = "[REDACTED:agent-key]";
const READY_POLL_INTERVAL = Duration.millis(100);

/** Runtime-specific observations exposed by one acquired process resource. */
export interface ProcessObservation<WaitFailure> {
  readonly exitCode: Effect.Effect<ExitCode, WaitFailure>;
  readonly output: () => string;
}

interface ProcessIdentity {
  readonly agentName: AgentName;
  readonly agentKey: AgentKey;
  readonly runtimeName: string;
}

interface ProcessReadiness<WaitFailure> extends ProcessIdentity {
  readonly within: Duration.Duration;
  readonly observation: ProcessObservation<WaitFailure>;

  /**
   * Recognizes the agent's readiness line in the child's accumulated output.
   * Each runtime owns its own line, so this module never names one.
   */
  readonly readyWhen: (output: string) => boolean;
}

/** An external runtime did not become a ready participant. */
export class RuntimeAcquisitionFailed extends Schema.TaggedError<RuntimeAcquisitionFailed>()(
  "RuntimeAcquisitionFailed",
  {
    runtime: Schema.NonEmptyString,
    agent: Schema.NonEmptyString,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.runtime} runtime for "${this.agent}" failed to start: ${this.detail}`;
  }
}

function redactAgentKey(key: AgentKey, text: string): string {
  return text.split(Redacted.value(key)).join(AGENT_KEY_REDACTION_MARKER);
}

function acquisitionFailed(
  identity: ProcessIdentity,
  observation: ProcessObservation<unknown>,
  diagnostic: {
    readonly detail: string;
  },
): RuntimeAcquisitionFailed {
  const output = observation.output();
  return RuntimeAcquisitionFailed.make({
    runtime: identity.runtimeName,
    agent: identity.agentName,
    detail: attachChildOutput(diagnostic.detail, output, (text) =>
      redactAgentKey(identity.agentKey, text),
    ),
  });
}

/**
 * Wait for the child to announce readiness on its own output, racing that
 * announcement against actual process exit so an agent that dies during
 * startup fails immediately instead of burning the whole budget. The
 * runtime-specific owner supplies process observations and its readiness
 * predicate, not lifecycle configuration or teardown.
 * @param input Input value to process.
 * @returns The await process ready result.
 */
export function awaitProcessReady<WaitFailure>(
  input: ProcessReadiness<WaitFailure>,
): Effect.Effect<void, RuntimeAcquisitionFailed> {
  const exited = input.observation.exitCode.pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.fail(
          acquisitionFailed(input, input.observation, {
            detail: `Agent "${input.agentName}" stopped before announcing readiness without an observable exit code`,
          }),
        ),
      onSuccess: (code) =>
        Effect.fail(
          acquisitionFailed(input, input.observation, {
            detail: `Agent "${input.agentName}" exited before announcing readiness (exitCode=${String(code)})`,
          }),
        ),
    }),
  );
  // The accumulated window is matched whole: a readiness line can arrive split
  // across stream chunks, and the buffer retains the startup head verbatim.
  const ready = Effect.sync(() =>
    input.readyWhen(input.observation.output()),
  ).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(READY_POLL_INTERVAL),
      until: (announced) => announced,
    }),
    Effect.asVoid,
  );
  return Effect.raceFirst(ready, exited).pipe(
    Effect.timeoutFail({
      duration: input.within,
      onTimeout: () =>
        acquisitionFailed(input, input.observation, {
          detail: `Agent "${input.agentName}" did not announce readiness within ${Duration.format(input.within)}`,
        }),
    }),
  );
}

/**
 * Convert one process exit observation into runtime evidence.
 * @param identity Value supplied to the operation.
 * @param observation Value supplied to the operation.
 * @returns The process termination result.
 */
export function processTermination<WaitFailure>(
  identity: Pick<ProcessIdentity, "agentName" | "runtimeName">,
  observation: ProcessObservation<WaitFailure>,
): Effect.Effect<RuntimeTermination> {
  return observation.exitCode.pipe(
    Effect.match({
      onFailure: () =>
        RuntimeFailed.make({
          detail: `${identity.runtimeName} process for agent "${identity.agentName}" completed without an observable exit code`,
        }),
      onSuccess: (code) => RuntimeExited.make({ code: Number(code) }),
    }),
  );
}
