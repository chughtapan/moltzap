/**
 * @file Type canaries for the native server engine layer
 * (`engine/server-engine.ts`).
 *
 * These pin the server-wiring guard: {@link ServerEngineLayer} binds the
 * middleware-attached engine group, so its requirement channel DEMANDS every
 * stacked capability middleware — the principal gate plus each cap's middleware.
 * A regression to binding an un-gated group drops those from the requirement
 * channel (an authorization bypass) and stops this canary compiling. The per-tag
 * partition + handler-map totality canaries live in
 * `server-engine-group.types-check.ts`.
 */
import type { RpcServer } from "@effect/rpc";
import type { Layer } from "effect";
import type {
  PrincipalGateMw,
  ConversationInTaskMw,
  ConversationSendAccessMw,
} from "./cap-middlewares.js";
import { ServerEngineLayer } from "./server-engine.js";

// Compile-time assertion helper.
type Expect<T extends true> = T;

type EngineLayerRIn =
  typeof ServerEngineLayer extends Layer.Layer<infer _ROut, infer _E, infer RIn>
    ? RIn
    : never;

// Server-wiring guard: the engine layer demands each stacked cap middleware (the
// per-cap gate), AND the `RpcServer.Protocol`. A cap middleware is only in the
// requirement channel when the bound group carries it on a member — i.e. the
// gated engine group, not an un-gated catalog group. Binding an un-gated group
// drops them and flips these to `false`. Representatives: the principal gate
// (every authenticated method) and two send-path cap middlewares.
type _DemandsPrincipalGate = Expect<
  [PrincipalGateMw] extends [EngineLayerRIn] ? true : false
>;
type _DemandsConversationInTaskMw = Expect<
  [ConversationInTaskMw] extends [EngineLayerRIn] ? true : false
>;
type _DemandsConversationSendAccessMw = Expect<
  [ConversationSendAccessMw] extends [EngineLayerRIn] ? true : false
>;
type _DemandsProtocol = Expect<
  [RpcServer.Protocol] extends [EngineLayerRIn] ? true : false
>;

export type {
  _DemandsPrincipalGate,
  _DemandsConversationInTaskMw,
  _DemandsConversationSendAccessMw,
  _DemandsProtocol,
};
