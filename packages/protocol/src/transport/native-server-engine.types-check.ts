/**
 * @file Type canaries for the native server engine layer
 * (`transport/native-server-engine.ts`).
 *
 * These pin the server-wiring guard: {@link ServerEngineLayer} binds the
 * middleware-attached {@link ServerEngineRpcGroup}, so its requirement channel
 * DEMANDS `PrincipalResolution`. A regression to `RpcServer.layer(ServerRpcGroup)`
 * (the un-gated group) drops `PrincipalResolution` from the requirement channel
 * — an authorization bypass — and stops this canary compiling. The per-tag
 * partition + handler-map totality canaries live in
 * `server-engine-group.types-check.ts`.
 */
import type { RpcServer } from "@effect/rpc";
import type { Layer } from "effect";
import { PrincipalResolution } from "./server-engine-group.js";
import { ServerEngineLayer } from "./native-server-engine.js";

// Compile-time assertion helper.
type Expect<T extends true> = T;

type EngineLayerRIn =
  typeof ServerEngineLayer extends Layer.Layer<infer _ROut, infer _E, infer RIn>
    ? RIn
    : never;

// Server-wiring guard: the engine layer demands `PrincipalResolution`, AND the
// `RpcServer.Protocol`. `PrincipalResolution` is only in the requirement channel
// when the bound group carries the middleware — i.e. it is `ServerEngineRpcGroup`,
// not the un-gated `ServerRpcGroup`. Binding the un-gated group drops it and
// flips this to `false`.
type _DemandsPrincipalResolution = Expect<
  [PrincipalResolution] extends [EngineLayerRIn] ? true : false
>;
type _DemandsProtocol = Expect<
  [RpcServer.Protocol] extends [EngineLayerRIn] ? true : false
>;

export type { _DemandsPrincipalResolution, _DemandsProtocol };
