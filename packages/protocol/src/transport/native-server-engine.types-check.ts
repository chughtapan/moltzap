/**
 * @file Type canaries for the native server engine layer
 * (`transport/native-server-engine.ts`).
 *
 * These pin the server-wiring guard: {@link ServerEngineLayer} binds the
 * middleware-attached {@link ServerEngineRpcGroup}, so its requirement channel
 * DEMANDS every member's per-method `*AuthMw`. A regression to
 * `RpcServer.layer(ServerRpcGroup)` (the un-gated group) drops the `*AuthMw` from
 * the requirement channel — an authorization bypass — and stops this canary
 * compiling. The per-tag partition + handler-map totality canaries live in
 * `server-engine-group.types-check.ts`.
 */
import type { RpcServer } from "@effect/rpc";
import type { Layer } from "effect";
import type {
  MessagesSendAuthMw,
  TaskListAuthMw,
  TaskCloseAuthMw,
} from "./auth-middleware.js";
import { ServerEngineLayer } from "./native-server-engine.js";

// Compile-time assertion helper.
type Expect<T extends true> = T;

type EngineLayerRIn =
  typeof ServerEngineLayer extends Layer.Layer<infer _ROut, infer _E, infer RIn>
    ? RIn
    : never;

// Server-wiring guard: the engine layer demands each member's `*AuthMw` (the
// per-method gate), AND the `RpcServer.Protocol`. A `*AuthMw` is only in the
// requirement channel when the bound group carries the middleware on that member
// — i.e. it is `ServerEngineRpcGroup`, not the un-gated `ServerRpcGroup`. Binding
// the un-gated group drops them and flips these to `false`. Three representatives
// span the shapes: a cap-bearing agent method, a cap-less agent method, and a
// cap-less app method.
type _DemandsMessagesSendAuthMw = Expect<
  [MessagesSendAuthMw] extends [EngineLayerRIn] ? true : false
>;
type _DemandsTaskListAuthMw = Expect<
  [TaskListAuthMw] extends [EngineLayerRIn] ? true : false
>;
type _DemandsTaskCloseAuthMw = Expect<
  [TaskCloseAuthMw] extends [EngineLayerRIn] ? true : false
>;
type _DemandsProtocol = Expect<
  [RpcServer.Protocol] extends [EngineLayerRIn] ? true : false
>;

export type {
  _DemandsMessagesSendAuthMw,
  _DemandsTaskListAuthMw,
  _DemandsTaskCloseAuthMw,
  _DemandsProtocol,
};
