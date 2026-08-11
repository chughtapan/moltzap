import type { HarnessClientService } from "@moltzap/client/harness-client";
import { Deferred, Effect, type Scope } from "effect";

/** Signals shared by one gateway generation from acquisition through release. */
export interface HarnessGatewayGeneration {
  readonly stopSignal: Deferred.Deferred<undefined>;
  readonly released: Deferred.Deferred<undefined>;
}

/** One Harness client currently available to inbound and outbound adapter work. */
export interface ActiveHarnessClient {
  readonly client: HarnessClientService;
  readonly generation: HarnessGatewayGeneration;
}

interface ReplaceHarnessGatewayInput<AcquireError> {
  readonly accountId: string;
  readonly acquireClient: Effect.Effect<
    HarnessClientService,
    AcquireError,
    Scope.Scope
  >;
  readonly isCancelled: () => boolean;
  readonly waitForCancellation: Effect.Effect<void>;
}

interface RunHarnessGatewayInput<AcquireError, RunError>
  extends ReplaceHarnessGatewayInput<AcquireError> {
  readonly runClient: (
    active: ActiveHarnessClient,
  ) => Effect.Effect<void, RunError>;
}

/**
 * Coordinates gateway replacement around the scope that owns a production
 * Harness client. An account remains reserved after its drain stops and until
 * that scope has run every finalizer, so a replacement cannot race the old
 * daemon for the profile's fixed port.
 */
export class HarnessGatewayLifecycle {
  private readonly activeClients = new Map<string, ActiveHarnessClient>();
  private readonly generations = new Map<string, HarnessGatewayGeneration>();
  private readonly pendingGenerations = new Map<
    string,
    Set<HarnessGatewayGeneration>
  >();
  private readonly transitions = new Map<string, Effect.Semaphore>();

  /**
   * Clients that may currently serve OpenClaw outbound requests.
   * @returns The active outbound client view.
   */
  get outboundClients(): ReadonlyMap<string, ActiveHarnessClient> {
    return this.activeClients;
  }

  /**
   * Whether an account still owns or is releasing a gateway generation.
   * @param accountId Account to inspect.
   * @returns Whether that account has an unreleased generation.
   */
  hasGeneration(accountId: string): boolean {
    return (
      this.generations.has(accountId) ||
      (this.pendingGenerations.get(accountId)?.size ?? 0) > 0
    );
  }

  /**
   * Replaces and runs one account generation inside its complete resource
   * lifetime. Replacement cannot acquire until the prior generation has
   * released, and release is announced only after the new client's scoped
   * finalizers complete.
   * @param input Account acquisition, cancellation check, and active drain.
   * @param input.accountId Account whose prior generation is replaced.
   * @param input.acquireClient Scoped client acquisition for the replacement.
   * @param input.isCancelled Whether startup should finish without publishing.
   * @param input.waitForCancellation Operation that completes when startup is cancelled.
   * @param input.runClient Long-running work for the published client.
   * @returns Completion of the account generation.
   */
  run<AcquireError, RunError>(
    input: RunHarnessGatewayInput<AcquireError, RunError>,
  ): Effect.Effect<void, AcquireError | RunError> {
    return Effect.scoped(
      this.makeGeneration().pipe(
        // Register release before client acquisition. Scope closes in reverse
        // order, so the client and daemon finalize before replacement unblocks.
        Effect.tap((generation) =>
          Effect.addFinalizer(() => this.release(input.accountId, generation)),
        ),
        Effect.tap((generation) =>
          Effect.sync(() => {
            this.addPending(input.accountId, generation);
          }),
        ),
        Effect.flatMap((generation) => this.runGeneration(input, generation)),
      ),
    ).pipe(Effect.withSpan("HarnessGatewayLifecycle.run"));
  }

  /**
   * Stops one generation and waits until the scope that owns it is closed.
   * Removing its outbound entry first prevents new sends during teardown.
   * @param accountId Account to stop.
   * @returns An operation that completes after scoped release.
   */
  stop(accountId: string): Effect.Effect<void> {
    return this.requestCurrentStop(accountId).pipe(
      Effect.flatMap((generations) =>
        Effect.forEach(
          generations,
          (generation) => Deferred.await(generation.released),
          { concurrency: 1, discard: true },
        ),
      ),
      Effect.withSpan("HarnessGatewayLifecycle.stop"),
    );
  }

  private finish(
    accountId: string,
    active: ActiveHarnessClient,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.activeClients.get(accountId) === active) {
        this.activeClients.delete(accountId);
      }
    });
  }

  private release(
    accountId: string,
    generation: HarnessGatewayGeneration,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      const active = this.activeClients.get(accountId);
      if (active?.generation === generation) {
        this.activeClients.delete(accountId);
      }
      if (this.generations.get(accountId) === generation) {
        this.generations.delete(accountId);
      }
      this.removePending(accountId, generation);
    }).pipe(
      Effect.zipRight(Deferred.succeed(generation.released, undefined)),
      Effect.asVoid,
    );
  }

  private makeGeneration(): Effect.Effect<HarnessGatewayGeneration> {
    return Effect.all({
      stopSignal: Deferred.make<undefined>(),
      released: Deferred.make<undefined>(),
    });
  }

  private runGeneration<AcquireError, RunError>(
    input: RunHarnessGatewayInput<AcquireError, RunError>,
    generation: HarnessGatewayGeneration,
  ): Effect.Effect<void, AcquireError | RunError, Scope.Scope> {
    const cancelled = Effect.raceFirst(
      input.waitForCancellation,
      Deferred.await(generation.stopSignal),
    ).pipe(Effect.as(undefined));
    return this.requestCurrentStop(input.accountId, generation).pipe(
      Effect.zipRight(
        this.withAccountTransition(
          input.accountId,
          this.acquireReplacement(input, generation),
        ).pipe(Effect.raceFirst(cancelled)),
      ),
      Effect.flatMap((active) =>
        active === undefined
          ? Effect.void
          : input
              .runClient(active)
              .pipe(Effect.ensuring(this.finish(input.accountId, active))),
      ),
    );
  }

  private acquireReplacement<AcquireError>(
    {
      accountId,
      acquireClient,
      isCancelled,
      waitForCancellation,
    }: ReplaceHarnessGatewayInput<AcquireError>,
    generation: HarnessGatewayGeneration,
  ): Effect.Effect<ActiveHarnessClient | undefined, AcquireError, Scope.Scope> {
    return this.stopCurrentGeneration(accountId).pipe(
      Effect.zipRight(
        Deferred.isDone(generation.stopSignal).pipe(
          Effect.flatMap((stopped) => {
            if (stopped || isCancelled()) {
              return Effect.succeed(undefined);
            }
            return Effect.sync(() => {
              this.promote(accountId, generation);
            }).pipe(
              Effect.zipRight(
                acquireClient.pipe(
                  Effect.flatMap((client) =>
                    Deferred.isDone(generation.stopSignal).pipe(
                      Effect.map((wasStopped) => {
                        if (wasStopped || isCancelled()) {
                          return undefined;
                        }
                        const active = { client, generation };
                        this.activeClients.set(accountId, active);
                        return active;
                      }),
                    ),
                  ),
                  Effect.raceFirst(
                    Effect.raceFirst(
                      waitForCancellation,
                      Deferred.await(generation.stopSignal),
                    ).pipe(Effect.as(undefined)),
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }

  private requestCurrentStop(
    accountId: string,
    except?: HarnessGatewayGeneration,
  ): Effect.Effect<readonly HarnessGatewayGeneration[]> {
    return Effect.suspend(() => {
      const generations = new Set<HarnessGatewayGeneration>();
      const current = this.generations.get(accountId);
      if (current !== undefined && current !== except) {
        generations.add(current);
        const active = this.activeClients.get(accountId);
        if (active?.generation === current) {
          this.activeClients.delete(accountId);
        }
      }
      for (const pending of this.pendingGenerations.get(accountId) ?? []) {
        if (pending !== except) {
          generations.add(pending);
        }
      }
      return Effect.forEach(
        generations,
        (generation) => Deferred.succeed(generation.stopSignal, undefined),
        { concurrency: 1, discard: true },
      ).pipe(Effect.as([...generations]));
    });
  }

  private stopCurrentGeneration(accountId: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const current = this.generations.get(accountId);
      if (current === undefined) {
        return Effect.void;
      }
      const active = this.activeClients.get(accountId);
      if (active?.generation === current) {
        this.activeClients.delete(accountId);
      }
      return Deferred.succeed(current.stopSignal, undefined).pipe(
        Effect.zipRight(Deferred.await(current.released)),
      );
    });
  }

  private addPending(
    accountId: string,
    generation: HarnessGatewayGeneration,
  ): void {
    const pending = this.pendingGenerations.get(accountId);
    if (pending === undefined) {
      this.pendingGenerations.set(accountId, new Set([generation]));
      return;
    }
    pending.add(generation);
  }

  private removePending(
    accountId: string,
    generation: HarnessGatewayGeneration,
  ): void {
    const pending = this.pendingGenerations.get(accountId);
    if (pending === undefined) {
      return;
    }
    pending.delete(generation);
    if (pending.size === 0) {
      this.pendingGenerations.delete(accountId);
    }
  }

  private promote(
    accountId: string,
    generation: HarnessGatewayGeneration,
  ): void {
    this.removePending(accountId, generation);
    this.generations.set(accountId, generation);
  }

  private withAccountTransition<A, E, R>(
    accountId: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.suspend(() =>
      this.transitionFor(accountId).withPermits(1)(operation),
    );
  }

  private transitionFor(accountId: string): Effect.Semaphore {
    const existing = this.transitions.get(accountId);
    if (existing !== undefined) {
      return existing;
    }
    const created = Effect.runSync(Effect.makeSemaphore(1));
    this.transitions.set(accountId, created);
    return created;
  }
}
