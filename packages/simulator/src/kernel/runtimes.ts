/** @file Mixed-roster acquisition and runtime-termination observation. */

import type { AgentId, AgentName } from "@moltzap/protocol/identity";
import { Cause, Effect, Exit, type Scope } from "effect";
import {
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  type runtimeEvents,
} from "../events/core.js";
import type { LedgerFailure, LedgerWriter } from "../ledger/live.js";
import type { InboundLinkStage } from "../network/link.js";
import type { AgentConnection, Router } from "../network/router.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRosterRequirements,
  RuntimeGatewayOf,
  StartedAgent,
  StartedAgents,
} from "../runtime/roster.js";
import {
  RuntimeFailed,
  type AgentRuntimeLike,
  type RunningAgent,
} from "../runtime/runtime.js";
import type { InboundLinkInterceptor } from "./link-fabric.js";
import { nonEmptyCause, runtimeEvent } from "./outcomes.js";

const MAX_PARALLEL_RUNTIME_ACQUISITIONS = 32;
type RuntimeEventWriter = LedgerWriter<typeof runtimeEvents>;

interface AcquiredAgent<Name extends string = string, Gateway = unknown> {
  readonly name: Name;
  readonly agentName: AgentName;
  readonly agentId: AgentId;
  readonly runtimeName: string;
  readonly started: StartedAgent<Name, Gateway>;
}

interface AcquireAgentInput<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
> {
  readonly router: Router;
  readonly name: Name;
  readonly agentName: AgentName;
  readonly runtime: Definitions[Name];
  readonly writer: RuntimeEventWriter;
  readonly interceptor: InboundLinkInterceptor;
}

interface AcquireRosterInput<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly router: Router;
  readonly roster: AgentRoster<Id, Definitions>;
  readonly writer: RuntimeEventWriter;
  readonly interceptor: InboundLinkInterceptor;
}

function runtimeAcquire<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  runtime: Definitions[Name],
  agentName: AgentName,
  connection: AgentConnection<Name>,
  interceptInbound: Effect.Effect<InboundLinkStage, never, Scope.Scope>,
): Effect.Effect<
  RunningAgent<RuntimeGatewayOf<Definitions[Name]>>,
  AgentRosterAcquisitionError<Definitions>,
  AgentRosterRequirements<Definitions> | Scope.Scope
> {
  // The keyed entry keeps its exact gateway while this supervisor widens its
  // failure and service requirements to the complete roster unions.
  return runtime.acquire({ agentName, connection, interceptInbound });
}

function attemptAgent<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  input: Pick<
    AcquireAgentInput<Definitions, Name>,
    "router" | "name" | "agentName" | "runtime" | "interceptor"
  >,
) {
  return Effect.gen(function* () {
    const connection = yield* input.router.attachAgent(
      input.name,
      input.agentName,
    );
    // The runtime, not this supervisor, acquires the stage: only a runtime
    // that owns its agent's inbound stream can apply one, and acquisition is
    // what registers the agent as a link-policy target.
    const running = yield* runtimeAcquire<Definitions, Name>(
      input.runtime,
      input.agentName,
      connection,
      input.interceptor.attach(connection.agent.id),
    );
    const started = Object.freeze({
      agent: connection.agent,
      gateway: running.gateway,
      termination: running.termination,
    });
    return {
      name: input.name,
      agentName: input.agentName,
      agentId: connection.agent.id,
      runtimeName: input.runtime.name,
      started,
    } satisfies AcquiredAgent<Name, RuntimeGatewayOf<Definitions[Name]>>;
  });
}

function monitorRuntime(
  acquired: AcquiredAgent,
  writer: RuntimeEventWriter,
): Effect.Effect<void, LedgerFailure> {
  return acquired.started.termination.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : writer
              .write({
                event: runtimeEvent(
                  acquired,
                  RuntimeFailed.make({
                    detail: nonEmptyCause(cause),
                  }),
                ),
              })
              .pipe(Effect.asVoid),
      onSuccess: (termination) =>
        writer
          .write({
            event: runtimeEvent(acquired, termination),
          })
          .pipe(Effect.asVoid),
    }),
    Effect.withSpan("Simulator.runtimeTermination", {
      attributes: {
        "agent.name": acquired.name,
        "runtime.name": acquired.runtimeName,
      },
    }),
  );
}

function startMonitor(
  acquired: AcquiredAgent,
  writer: RuntimeEventWriter,
): Effect.Effect<void, never, Scope.Scope> {
  // Registration follows runtime acquisition so LIFO scope closure interrupts
  // this observer before runtime teardown. Teardown is not terminal evidence.
  return monitorRuntime(acquired, writer).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  );
}

function recordReady(acquired: AcquiredAgent, writer: RuntimeEventWriter) {
  return writer.write({
    event: AgentRuntimeReady.make({
      agentName: acquired.agentName,
      agentId: acquired.agentId,
      runtime: acquired.runtimeName,
    }),
  });
}

function recordStartFailure(
  input: {
    readonly name: string;
    readonly agentName: AgentName;
    readonly runtime: AgentRuntimeLike;
    readonly writer: RuntimeEventWriter;
  },
  cause: Cause.Cause<unknown>,
) {
  return input.writer.write({
    event: AgentRuntimeStartFailed.make({
      agentName: input.agentName,
      runtime: input.runtime.name,
      cause: nonEmptyCause(cause),
    }),
  });
}

function acquireAgent<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(input: AcquireAgentInput<Definitions, Name>) {
  return Effect.gen(function* () {
    const attempted = yield* Effect.exit(
      attemptAgent<Definitions, Name>(input),
    );
    if (Exit.isFailure(attempted)) {
      if (Cause.isInterruptedOnly(attempted.cause)) {
        return yield* Effect.failCause(attempted.cause);
      }
      const recorded = yield* Effect.exit(
        recordStartFailure(input, attempted.cause),
      );
      return yield* Effect.failCause(
        Exit.isFailure(recorded)
          ? Cause.sequential(attempted.cause, recorded.cause)
          : attempted.cause,
      );
    }
    yield* recordReady(attempted.value, input.writer);
    yield* startMonitor(attempted.value, input.writer);
    return attempted.value;
  }).pipe(
    Effect.withSpan("Simulator.acquireAgent", {
      attributes: {
        "agent.name": input.name,
        "runtime.name": input.runtime.name,
      },
    }),
  );
}

function startedAgents<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(acquired: readonly AcquiredAgent[]): StartedAgents<Definitions> {
  return /* Safe because the surrounding invariant establishes this asserted shape. */ Object.freeze(
    Object.fromEntries(acquired.map((entry) => [entry.name, entry.started])),
  ) as StartedAgents<Definitions>;
}

function withoutPeerCancellation<Failure>(
  cause: Cause.Cause<Failure>,
): Cause.Cause<Failure> {
  // Parallel acquisition cancels unfinished peers after a primary failure.
  // A primary interruption has no non-interrupt cause and remains unchanged.
  const primary = Cause.filter(
    cause,
    (current) => !Cause.isInterruptType(current),
  );
  return Cause.isEmpty(primary) ? cause : primary;
}

/**
 * Executes the acquire roster operation.
 * @param input Input value to process.
 * @returns The acquire roster result.
 */
export function acquireRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(input: AcquireRosterInput<Id, Definitions>) {
  type Name = Extract<keyof Definitions, string>;
  return Effect.forEach(
    input.roster.validatedDefinitions,
    (entry) =>
      acquireAgent<Definitions, Name>({
        router: input.router,
        name: entry.name,
        agentName: entry.agentName,
        runtime: entry.runtime,
        writer: input.writer,
        interceptor: input.interceptor,
      }),
    { concurrency: MAX_PARALLEL_RUNTIME_ACQUISITIONS },
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.failCause(withoutPeerCancellation(cause)),
    ),
    Effect.map(startedAgents<Definitions>),
  );
}
