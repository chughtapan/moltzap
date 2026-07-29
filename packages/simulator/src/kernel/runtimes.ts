/** @file Mixed-roster acquisition and runtime-termination observation. */

import type { AgentName } from "@moltzap/protocol/identity";
import { Cause, Effect, Exit, type Scope } from "effect";
import {
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  RuntimeEvents,
} from "../events/core.js";
import type { LedgerFailure, LedgerWriter } from "../ledger/live.js";
import type { AgentConnection, Router } from "../network/router.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRosterRequirements,
  StartedAgentHandles,
} from "../runtime/roster.js";
import {
  RuntimeFailed,
  type AgentRuntimeLike,
  type RunningAgent,
} from "../runtime/runtime.js";
import { nonEmptyCause, runtimeEvent } from "./outcomes.js";

const MAX_PARALLEL_RUNTIME_ACQUISITIONS = 32;
type RuntimeEventWriter = LedgerWriter<typeof RuntimeEvents>;

interface AcquiredAgent<Name extends string = string> {
  readonly name: Name;
  readonly agentName: AgentName;
  readonly runtimeName: string;
  readonly connection: AgentConnection<Name>;
  readonly running: RunningAgent;
}

interface AcquireAgentInput<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
> {
  readonly router: Router;
  readonly name: Name;
  readonly agentName: AgentName;
  readonly runtime: AgentRuntimeLike;
  readonly writer: RuntimeEventWriter;
}

interface AcquireRosterInput<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly router: Router;
  readonly roster: AgentRoster<Id, Definitions>;
  readonly writer: RuntimeEventWriter;
}

function runtimeAcquire<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  runtime: AgentRuntimeLike,
  connection: AgentConnection<Name>,
): Effect.Effect<
  RunningAgent,
  AgentRosterAcquisitionError<Definitions>,
  AgentRosterRequirements<Definitions> | Scope.Scope
> {
  // Heterogeneous record iteration erases each runtime definition's E and R.
  // AgentRoster construction proves this union by accepting nominal runtimes.
  return runtime.acquire({ connection }) as Effect.Effect<
    RunningAgent,
    AgentRosterAcquisitionError<Definitions>,
    AgentRosterRequirements<Definitions> | Scope.Scope
  >;
}

function attemptAgent<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  input: Pick<
    AcquireAgentInput<Definitions, Name>,
    "router" | "name" | "agentName" | "runtime"
  >,
) {
  return Effect.gen(function* () {
    const connection = yield* input.router.attachAgent(
      input.name,
      input.agentName,
    );
    const running = yield* runtimeAcquire<Definitions, Name>(
      input.runtime,
      connection,
    );
    return {
      name: input.name,
      agentName: input.agentName,
      runtimeName: input.runtime.name,
      connection,
      running,
    } satisfies AcquiredAgent<Name>;
  });
}

function monitorRuntime(
  acquired: AcquiredAgent,
  writer: RuntimeEventWriter,
): Effect.Effect<void, LedgerFailure> {
  return acquired.running.termination.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : writer.write({
              event: runtimeEvent(
                acquired,
                RuntimeFailed.make({
                  detail: nonEmptyCause(cause),
                }),
              ),
            }),
      onSuccess: (termination) =>
        writer.write({
          event: runtimeEvent(acquired, termination),
        }),
    }),
    Effect.asVoid,
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
      agentId: acquired.connection.agent.id,
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

function startedHandles<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(acquired: ReadonlyArray<AcquiredAgent>): StartedAgentHandles<Definitions> {
  return Object.freeze(
    Object.fromEntries(
      acquired.map((entry) => [entry.name, entry.connection.agent]),
    ),
  ) as StartedAgentHandles<Definitions>;
}

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
        name: entry.name as Name,
        agentName: entry.agentName,
        runtime: entry.runtime,
        writer: input.writer,
      }),
    { concurrency: MAX_PARALLEL_RUNTIME_ACQUISITIONS },
  ).pipe(Effect.map(startedHandles<Definitions>));
}
