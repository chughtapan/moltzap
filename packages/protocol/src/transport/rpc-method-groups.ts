import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import type { NotificationDefinition, RpcDefinition } from "./method.js";
import type { JsonRpcMethod } from "./wire.js";
import {
  serverRpcMethods,
  appCallbackMethods,
  agentClientRpcMethods,
  appCallableRpcMethods,
  notificationDefinitions,
} from "../rpc-registry.js";

type AnyRpcDefinition = RpcDefinition<
  string,
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
>;

/**
 * The `Rpc` a single descriptor maps to: its branded wire `name` is the member
 * tag, its `paramsSchema`/`resultSchema` are payload/success verbatim, and its
 * per-method `errorSchema` (the `_tag`-discriminated union of the method's
 * effective errors) is the error Schema. The engine encodes a handler's tagged
 * failure against that union, so the server emits the typed wire error directly
 * — no coded-envelope projection.
 */
type RpcFromDef<D> =
  D extends RpcDefinition<infer Name, infer P, infer R>
    ? Rpc.Rpc<JsonRpcMethod<Name>, P, R, Schema.Schema.AnyNoContext>
    : never;

/**
 * The per-member tuple a catalog maps to. Homomorphic over the catalog's
 * `as const` tuple (the `[K in keyof Defs]` mapping), so each member keeps its
 * own tag/payload/success types per slot instead of widening to one union
 * element. A group built from this tuple therefore has a member type that
 * correlates each tag with its own payload/success Schemas — the shape
 * `RpcClient.make` reads to type each method, and `RpcGroup.toLayer` reads to
 * type each handler.
 */
type GroupMembers<Defs extends readonly AnyRpcDefinition[]> = {
  readonly [K in keyof Defs]: RpcFromDef<Defs[K]>;
};

/**
 * Build the `@effect/rpc` `RpcGroup` for one per-kind descriptor catalog. Each
 * `defineRpc` descriptor maps to an `Rpc.make` whose payload and success are
 * the descriptor's Effect `Schema`s verbatim and whose error is the method's
 * own `errorSchema` (its `_tag`-discriminated error union); the descriptor's
 * branded wire `name` becomes the member tag.
 *
 * Members are derived by mapping the catalog rather than hand-listing each
 * method, so the group can never drift from `rpc-registry.ts`. {@link
 * GroupMembers} re-types the mapped result as the per-slot tuple so each
 * member's tag/payload/success correlation survives for downstream
 * `RpcClient.make` / `RpcGroup.toLayer`.
 */
const groupFromCatalog = <const Defs extends readonly AnyRpcDefinition[]>(
  defs: Defs,
): RpcGroup.RpcGroup<GroupMembers<Defs>[number]> =>
  RpcGroup.make(
    // `Array.prototype.map` is typed to return a homogeneous element array;
    // TypeScript alone cannot prove it preserves the catalog's tuple length.
    // At runtime it yields exactly one `Rpc` per descriptor in source order,
    // which is precisely the per-slot tuple `GroupMembers<Defs>` describes, so
    // the assertion is sound. The per-tag tag↔payload correlation it claims is
    // type-verified by `rpc-method-groups.types-check.ts` (the group stops
    // compiling there if the mapped type drifts).
    ...(defs.map((definition) =>
      Rpc.make(definition.name, {
        payload: definition.paramsSchema,
        success: definition.resultSchema,
        error: definition.errorSchema,
      }),
    ) as GroupMembers<Defs>),
  );

/**
 * `@effect/rpc` groups for moltzap's four per-kind RPC catalogs, built from the
 * `rpc-registry.ts` descriptor arrays. The native-engine cutover binds handlers
 * onto these via `RpcGroup.toLayer` (server inbound) and derives typed clients
 * via `RpcClient.make`; the dual-endpoint demux pairs {@link ServerRpcGroup}
 * (client-to-server) with {@link AppCallbackRpcGroup} (server-to-client).
 */
export const ServerRpcGroup = groupFromCatalog(serverRpcMethods);

/** Server-to-client callback group: `dispatch/authorize`, `messages/authorize`, `task/create`. */
export const AppCallbackRpcGroup = groupFromCatalog(appCallbackMethods);

/** Outbound group callable from `MoltZapAgentClient`. */
export const AgentClientRpcGroup = groupFromCatalog(agentClientRpcMethods);

/** Outbound group callable from an app connection: superset of the agent-client group. */
export const AppCallableRpcGroup = groupFromCatalog(appCallableRpcMethods);

type AnyNotificationDefinition = NotificationDefinition<
  string,
  Schema.Schema.AnyNoContext
>;

/**
 * The `Rpc` a single notification definition maps to on the server→client
 * reverse channel: the notification's wire `name` is the member tag, its
 * `paramsSchema` is the payload, the success is `Void` (a notification is
 * fire-and-forget — the server fires it without awaiting a meaningful result),
 * and the error is `Never` — a notification cannot fail with a typed wire error.
 */
type NotificationRpcFromDef<D> =
  D extends NotificationDefinition<infer Name, infer P>
    ? Rpc.Rpc<JsonRpcMethod<Name>, P, typeof Schema.Void, typeof Schema.Never>
    : never;

type NotificationGroupMembers<
  Defs extends readonly AnyNotificationDefinition[],
> = {
  readonly [K in keyof Defs]: NotificationRpcFromDef<Defs[K]>;
};

/**
 * Build the server→client reverse `RpcGroup` for the notification catalog. Each
 * `defineNotification` descriptor maps to a `void`-result `Rpc.make`: the
 * notification's params is the payload, the success is `Schema.Void`. The
 * server holds the `RpcClient&lt;NotificationRpcGroup>` (fires each notification on
 * a target connection's reverse channel, fork-and-forget); the agent + app
 * clients hold the `RpcServer&lt;NotificationRpcGroup>` whose handlers route each
 * payload into the `SubscriberRegistry`, preserving the
 * `client.subscribe(def) → Stream` surface unchanged.
 */
const groupFromNotifications = <
  const Defs extends readonly AnyNotificationDefinition[],
>(
  defs: Defs,
): RpcGroup.RpcGroup<NotificationGroupMembers<Defs>[number]> =>
  RpcGroup.make(
    // Same homogeneous-map laundering as `groupFromCatalog`: `Array.map`'s
    // element type cannot prove the per-slot tuple, but at runtime it yields one
    // `void`-result `Rpc` per notification descriptor in source order, precisely
    // the `NotificationGroupMembers` tuple. Verified by
    // `rpc-method-groups.types-check.ts`.
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- tuple-keying proof TS cannot express, same single assertion `groupFromCatalog` uses, verified by rpc-method-groups.types-check.ts
    ...(defs.map((definition) =>
      Rpc.make(definition.name, {
        payload: definition.paramsSchema,
        success: Schema.Void,
        error: Schema.Never,
      }),
    ) as unknown as NotificationGroupMembers<Defs>), // #ignore-sloppy-code[as-unknown-as]: tuple-keying proof TS cannot express; verified by rpc-method-groups.types-check.ts.
  );

/**
 * Server→client reverse notification group. The server fires each notification
 * as a fire-and-forget `void`-result RPC on a target connection's reverse
 * channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
 * each payload into the `SubscriberRegistry`. Reuses the same s2c reverse-RPC
 * machinery as {@link AppCallbackRpcGroup}.
 */
export const NotificationRpcGroup = groupFromNotifications(
  notificationDefinitions,
);

/**
 * The full server→client reverse group: the moderator callbacks
 * ({@link AppCallbackRpcGroup}) ∪ the notifications ({@link NotificationRpcGroup}).
 * The server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires
 * callbacks awaiting a verdict, fires notifications fork-and-forget); the agent
 * + app clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent
 * client only ever receives notifications (its handlers for the three callback
 * methods are never invoked — an agent is not a moderator), but it serves the
 * whole group so the s2c engine binds one handler map.
 */
export const ReverseRpcGroup = AppCallbackRpcGroup.merge(NotificationRpcGroup);
