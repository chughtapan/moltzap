/**
 * @file Type canaries for the native server engine substrate
 * (`transport/native-server-engine.ts`).
 *
 * The engine is built ahead of the live-connection cutover and is wired to no
 * socket yet. These canaries are its live type consumer (so the unused-export
 * pass does not flag the engine dead) AND the load-bearing invariant the
 * native cutover relies on: `ServerRpcGroup`'s handler map is per-tag total.
 *
 * `RpcGroup#toLayer` accepts a `HandlersFrom&lt;R&gt;` literal whose keys are
 * the group's member tags; a complete literal yields a Layer that provides every
 * member's `Rpc.ToHandler`. The hand-rolled slot-table totality check the wire
 * dispatcher needed becomes this compiler-native invariant: a tag absent from
 * the handler map surfaces as an unprovided `Rpc.ToHandler` requirement at the
 * engine-wiring site, and a stray key is not a member tag. These canaries pin
 * both halves so the invariant stops compiling here if `@effect/rpc`'s handler
 * contract or the group's member type drifts.
 */
import type { Rpc, RpcGroup } from "@effect/rpc";
import type { Layer } from "effect";
import { ServerRpcGroup } from "./rpc-method-groups.js";

// Compile-time equality helper.
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

type ServerRpcs = RpcGroup.Rpcs<typeof ServerRpcGroup>;
type ServerHandlers = RpcGroup.HandlersFrom<ServerRpcs>;

// Canary 1: the handler map's keys are exactly the group's member tags.
//
// `HandlersFrom<R>` maps each member to its tag-keyed handler slot, so a
// missing tag drops a required key and a stray key is not a member tag.
// Equating the key set with the member-tag set pins that the handler map
// requires one handler per tag — the per-tag totality the wire dispatcher's
// hand-written slot-table check used to enforce.
type _Total = Expect<Equal<keyof ServerHandlers, ServerRpcs["_tag"]>>;

// Canary 2: a complete `HandlersFrom` literal is accepted by `toLayer`, and
// the Layer it yields provides EVERY member's `Rpc.ToHandler`.
//
// A handler map missing a tag would either fail this assignment (the literal
// is not a `HandlersFrom<R>`) or, when the engine wires it, leave that tag's
// `Rpc.ToHandler` as an unprovided requirement — the `RIn ≠ never` signal that
// replaces the wire dispatcher's totality canary. The complete literal here
// must discharge the full union.
declare const handlers: ServerHandlers;
const handlerLayer = ServerRpcGroup.toLayer(handlers);
type ProvidedHandlers =
  typeof handlerLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn>
    ? ROut
    : never;
type _ProvidesEveryHandler = Expect<
  Equal<ProvidedHandlers, Rpc.ToHandler<ServerRpcs>>
>;

export type { _Total, _ProvidesEveryHandler };
