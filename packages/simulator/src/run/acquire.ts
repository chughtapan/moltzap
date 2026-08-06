/** @file Mixed-roster acquisition and runtime-termination observation. */
// safer-arch-ignore no-cross-domain-sibling-import: Roster acquisition supervises agents against the cluster while writing router evidence to the ledger.

import type { AgentId, AgentName } from "@moltzap/protocol/identity";
import { Cause, Deferred, Effect, Exit, Ref, type Scope } from "effect";
import {
  AgentRuntimeReady,
  AgentRuntimeStartFailed,
  type runtimeEvents,
} from "../events/core.js";
import type { LedgerFailure, LedgerWriter } from "../ledger/append.js";
import type { Router } from "../network/router.js";
import { type Society, ClusterError } from "../cluster/cluster.js";
import type {
  AgentRoster,
  RuntimeGatewayOf,
  StartedAgent,
  StartedAgents,
} from "../agents/roster.js";
import {
  RuntimeFailed,
  type AgentRuntimeLike,
  type RuntimeTermination,
} from "../agents/agent.js";
import { nonEmptyCause, runtimeEvent } from "./outcomes.js";

const MAX_PARALLEL_RUNTIME_ACQUISITIONS = 32;
type RuntimeEventWriter = LedgerWriter<typeof runtimeEvents>;
type DispatchState = "pending" | "lost" | "open";

interface DispatchFence {
  readonly state: Ref.Ref<DispatchState>;
  readonly failure: Deferred.Deferred<never, LedgerFailure | ClusterError>;
}

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
  readonly session: Society<Definitions>;
  readonly dispatch: DispatchFence;
  readonly writer: RuntimeEventWriter;
}

interface AcquireRosterInput<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly router: Router;
  readonly roster: AgentRoster<Id, Definitions>;
  readonly session: Society<Definitions>;
  readonly writer: RuntimeEventWriter;
}

function attemptAgent<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  input: Pick<
    AcquireAgentInput<Definitions, Name>,
    "router" | "name" | "agentName" | "runtime" | "session"
  >,
) {
  return Effect.gen(function* () {
    const connection = yield* input.router.attachAgent(
      input.name,
      input.agentName,
    );
    const running = yield* input.session.acquireAgent({
      name: input.name,
      runtime: input.runtime,
      agentName: input.agentName,
      connection,
    });
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

function claimPreDispatchLoss(dispatch: DispatchFence) {
  return Ref.modify(dispatch.state, (state) =>
    state === "pending" ? ([true, "lost"] as const) : ([false, state] as const),
  );
}

function recordTermination(
  acquired: AcquiredAgent,
  termination: RuntimeTermination,
  writer: RuntimeEventWriter,
  dispatch: DispatchFence,
) {
  return Effect.gen(function* () {
    const beforeDispatch = yield* claimPreDispatchLoss(dispatch);
    const recorded = yield* Effect.exit(
      writer.write({ event: runtimeEvent(acquired, termination) }),
    );
    if (beforeDispatch) {
      if (Exit.isFailure(recorded)) {
        yield* Deferred.failCause(dispatch.failure, recorded.cause);
      } else {
        yield* Deferred.fail(
          dispatch.failure,
          new ClusterError({
            detail: `${acquired.name} terminated before cohort readiness (${termination._tag})`,
          }),
        );
      }
    }
    if (Exit.isFailure(recorded)) {
      return yield* Effect.failCause(recorded.cause);
    }
  });
}

function monitorRuntime(
  acquired: AcquiredAgent,
  writer: RuntimeEventWriter,
  dispatch: DispatchFence,
): Effect.Effect<void, LedgerFailure> {
  return acquired.started.termination.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : recordTermination(
              acquired,
              RuntimeFailed.make({ detail: nonEmptyCause(cause) }),
              writer,
              dispatch,
            ),
      onSuccess: (termination) =>
        recordTermination(acquired, termination, writer, dispatch),
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
  dispatch: DispatchFence,
): Effect.Effect<void, never, Scope.Scope> {
  // Registration follows runtime acquisition so LIFO scope closure interrupts
  // this observer before runtime teardown. Teardown is not terminal evidence.
  return monitorRuntime(acquired, writer, dispatch).pipe(
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
    yield* startMonitor(attempted.value, input.writer, input.dispatch);
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

function openDispatchFence(dispatch: DispatchFence) {
  return Ref.modify(dispatch.state, (state) =>
    state === "pending"
      ? ([true, "open"] as const)
      : ([state === "open", state] as const),
  ).pipe(
    Effect.flatMap((opened) =>
      opened ? Effect.void : Deferred.await(dispatch.failure),
    ),
  );
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
  return Effect.gen(function* () {
    const dispatch: DispatchFence = {
      state: yield* Ref.make<DispatchState>("pending"),
      failure: yield* Deferred.make<never, LedgerFailure | ClusterError>(),
    };
    const acquired = yield* Effect.raceFirst(
      Effect.forEach(
        input.roster.validatedDefinitions,
        (entry) =>
          acquireAgent<Definitions, Name>({
            router: input.router,
            name: entry.name,
            agentName: entry.agentName,
            runtime: entry.runtime,
            session: input.session,
            dispatch,
            writer: input.writer,
          }),
        { concurrency: MAX_PARALLEL_RUNTIME_ACQUISITIONS },
      ),
      Deferred.await(dispatch.failure),
    );
    // Registered observers run once before the fence so an already-terminal
    // runtime cannot be dispatched by an immediately ready platform.
    yield* Effect.yieldNow();
    yield* Effect.raceFirst(
      input.session.cohortReady,
      Deferred.await(dispatch.failure),
    );
    yield* openDispatchFence(dispatch);
    return startedAgents<Definitions>(acquired);
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.failCause(withoutPeerCancellation(cause)),
    ),
    Effect.withSpan("Simulator.acquireRoster"),
  );
}
