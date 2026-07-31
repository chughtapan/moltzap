/** @file Shared observation of already-acquired autonomous processes. */

import type { ExitCode } from "@effect/platform/CommandExecutor";
import type { AgentKey, AgentName } from "@moltzap/protocol/identity";
import {
  RuntimeExited,
  RuntimeFailed,
  type RuntimeTermination,
} from "./runtime.js";
import type { AgentConnection } from "../network/router.js";
import { type Duration, Effect, Redacted, Schema } from "effect";
import { attachChildOutput } from "./command.js";

const AGENT_KEY_REDACTION_MARKER = "[REDACTED:agent-key]";

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

interface ProcessReadiness<Name extends string, WaitFailure>
  extends ProcessIdentity {
  readonly connection: AgentConnection<Name>;
  readonly within: Duration.Duration;
  readonly observation: ProcessObservation<WaitFailure>;
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
 * Race the router's single readiness contract against actual process exit.
 * The runtime-specific owner supplies process observations, not lifecycle
 * configuration or teardown.
 * @param input Input value to process.
 * @returns The await process ready result.
 */
export function awaitProcessReady<Name extends string, WaitFailure>(
  input: ProcessReadiness<Name, WaitFailure>,
): Effect.Effect<void, RuntimeAcquisitionFailed> {
  const exited = input.observation.exitCode.pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.fail(
          acquisitionFailed(input, input.observation, {
            detail: `Agent "${input.agentName}" stopped before becoming router-visible without an observable exit code`,
          }),
        ),
      onSuccess: (code) =>
        Effect.fail(
          acquisitionFailed(input, input.observation, {
            detail: `Agent "${input.agentName}" exited before becoming router-visible (exitCode=${String(code)})`,
          }),
        ),
    }),
  );
  const ready = input.connection.awaitReady(input.within).pipe(
    Effect.mapError((cause) =>
      acquisitionFailed(input, input.observation, {
        detail: `Agent "${input.agentName}" did not become router-visible: ${String(cause)}`,
      }),
    ),
  );
  return Effect.raceFirst(ready, exited);
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
