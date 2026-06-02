import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import type { NotificationDefinition, RpcDefinition } from "./method.js";
import type { JsonRpcMethod } from "./wire.js";
import {
  appCallbackMethods,
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
    // `Array.map`'s element type cannot prove the per-slot tuple, but at runtime
    // it yields one `void`-result `Rpc` per notification descriptor in source
    // order, precisely the `NotificationGroupMembers` tuple. Verified by
    // `rpc-method-groups.types-check.ts`.
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- tuple-keying proof TS cannot express; verified by rpc-method-groups.types-check.ts
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
 * machinery as the moderator callbacks folded into {@link ReverseRpcGroup}.
 */
export const NotificationRpcGroup = groupFromNotifications(
  notificationDefinitions,
);

/**
 * The precise per-slot member union of the reverse channel: the moderator
 * callbacks (result-bearing) ∪ the notifications (`void`-result). One union,
 * not a merged pair of groups, so `RpcClient.make(ReverseRpcGroup)` keys each
 * tag to its own success and `dispatchCall(client, tag, payload)` reduces to
 * that one success cast-free — the same reduction the direct callable groups
 * get. `RpcGroup.merge` widens the per-tag success to the whole union at a
 * generic `Tag`, which is what forced a value-boundary cast; building one group
 * over the combined member tuple keeps the correlation.
 */
type ReverseRpcMemberTuple = readonly [
  ...GroupMembers<typeof appCallbackMethods>,
  ...NotificationGroupMembers<typeof notificationDefinitions>,
];
type ReverseRpcMember = ReverseRpcMemberTuple[number];

/**
 * The full server→client reverse group: the moderator callbacks
 * (`appCallbackMethods`) ∪ the notifications ({@link NotificationRpcGroup}),
 * built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
 * server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
 * awaiting a verdict, fires notifications fork-and-forget); the agent + app
 * clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
 * only ever receives notifications (its handlers for the three callback methods
 * are never invoked — an agent is not a moderator), but it serves the whole
 * group so the s2c engine binds one handler map.
 */
export const ReverseRpcGroup: RpcGroup.RpcGroup<ReverseRpcMember> =
  RpcGroup.make(
    // Same homogeneous-map laundering as `groupFromNotifications`: `Array.map`'s
    // element type cannot prove the per-slot tuple, but at runtime each callback
    // maps to a result-bearing `Rpc` and each notification to a `void`-result
    // `Rpc`, in source order — precisely the `ReverseRpcMember` union. Verified
    // by `rpc-method-groups.types-check.ts`.
    // eslint-disable-next-line agent-code-guard/as-unknown-as -- combined-tuple keying proof TS cannot express; verified by rpc-method-groups.types-check.ts
    ...([
      ...appCallbackMethods.map((definition) =>
        Rpc.make(definition.name, {
          payload: definition.paramsSchema,
          success: definition.resultSchema,
          error: definition.errorSchema,
        }),
      ),
      ...notificationDefinitions.map((definition) =>
        Rpc.make(definition.name, {
          payload: definition.paramsSchema,
          success: Schema.Void,
          error: Schema.Never,
        }),
      ),
    ] as unknown as readonly ReverseRpcMember[]), // #ignore-sloppy-code[as-unknown-as]: combined-tuple keying proof TS cannot express; verified by rpc-method-groups.types-check.ts.
  );
