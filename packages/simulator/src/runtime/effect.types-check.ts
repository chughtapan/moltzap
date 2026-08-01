/**
 * An Effect runtime preserves its customer gateway exactly and exposes every
 * builder and behavior requirement. The keyed roster relies on both facts to
 * install a precise started-agent service without hiding missing dependencies.
 */

import { Context, Effect } from "effect";
import { effectRuntime, type EffectRuntimeStartFailed } from "./effect.js";
import type { AgentRuntime } from "./runtime.js";

interface TestGateway {
  readonly submit: (value: string) => Effect.Effect<void>;
}

class BuilderDependency extends Context.Tag(
  "@moltzap/simulator/test/EffectRuntimeBuilderDependency",
)<BuilderDependency, { readonly prefix: string }>() {}

class BehaviorDependency extends Context.Tag(
  "@moltzap/simulator/test/EffectRuntimeBehaviorDependency",
)<BehaviorDependency, { readonly observe: Effect.Effect<void> }>() {}

/** Representative runtime retained for compile-time inference checks. */
export const effectRuntimeCanary = effectRuntime({
  build: (context) =>
    Effect.gen(function* () {
      const builder = yield* BuilderDependency;
      const gateway: TestGateway = {
        submit: (value) =>
          Effect.sync(
            () => `${builder.prefix}${context.agent.name}${value}`,
          ).pipe(Effect.asVoid),
      };
      const behavior = Effect.gen(function* () {
        const dependency = yield* BehaviorDependency;
        yield* dependency.observe;
        return yield* Effect.never;
      });
      return { gateway, behavior };
    }).pipe(Effect.withSpan("effectRuntimeCanary")),
});

type RuntimeTypes<Runtime> =
  Runtime extends AgentRuntime<
    infer Gateway,
    infer AcquisitionError,
    infer Requirements,
    infer Configuration
  >
    ? readonly [Gateway, AcquisitionError, Requirements, Configuration]
    : never;

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type GatewayIsExact = Expect<
  Equal<RuntimeTypes<typeof effectRuntimeCanary>[0], TestGateway>
>;
type AcquisitionErrorIsBounded = Expect<
  Equal<RuntimeTypes<typeof effectRuntimeCanary>[1], EffectRuntimeStartFailed>
>;
type RequirementsAreExact = Expect<
  Equal<
    RuntimeTypes<typeof effectRuntimeCanary>[2],
    BuilderDependency | BehaviorDependency
  >
>;

/** Compile-time assertions for the Effect runtime's inferred public contract. */
export type EffectRuntimeCanaries = [
  GatewayIsExact,
  AcquisitionErrorIsBounded,
  RequirementsAreExact,
];
