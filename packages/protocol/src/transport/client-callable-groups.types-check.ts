/**
 * @file Type canaries for the client-callable group projections
 * (`transport/client-callable-groups.ts`).
 *
 * The groups are the first-party compile-time principal bound: an agent client
 * types against {@link AgentCallableGroup}, an app client against
 * {@link AppCallableGroup}. These canaries pin the invariants that make that
 * bound load-bearing:
 *
 *   1. an agent-only method (`task/request`) is ABSENT from the app group;
 *   2. an app-only method (`task/close`) is ABSENT from the agent group;
 *   3. the lone `"any"` method (`network/connect`) is in BOTH (deliberate
 *      overlap — callable pre-auth from either client);
 *   4. the group tag sets are LITERAL branded unions, never the widened
 *      `JsonRpcMethod&lt;string&gt;` brand — a widened derivation would make the
 *      absence checks vacuously green.
 *
 * The operands are branded `JsonRpcMethod&lt;...&gt;` because the group members
 * carry literal branded tags (`callableGroup` builds each from
 * `definition.name`, a branded literal). `AsMethod&lt;N&gt;` brands the plain
 * literal before comparison so the `extends` checks are apples-to-apples (the
 * same branding the in-file `MemberWithTag` precedent in
 * `rpc-method-groups.types-check.ts` uses).
 */
import type { RpcGroup } from "@effect/rpc";
import {
  AgentCallableGroup,
  AppCallableGroup,
} from "./client-callable-groups.js";
import type { JsonRpcMethod } from "./wire.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

/** Brand a plain-literal tag union to `JsonRpcMethod&lt;...&gt;`, distributing. */
type AsMethod<Names extends string> = Names extends Names
  ? JsonRpcMethod<Names>
  : never;

type AgentCallableTags = RpcGroup.Rpcs<typeof AgentCallableGroup>["_tag"];
type AppCallableTags = RpcGroup.Rpcs<typeof AppCallableGroup>["_tag"];

// Canary 1: `task/request` is `callablePrincipal: "agent"` → MUST NOT be
// app-callable.
type _AgentOnlyAbsentFromApp = Expect<
  [AsMethod<"task/request">] extends [AppCallableTags] ? false : true
>;

// Canary 2: `task/close` is `callablePrincipal: "app"` → MUST NOT be
// agent-callable.
type _AppOnlyAbsentFromAgent = Expect<
  [AsMethod<"task/close">] extends [AgentCallableTags] ? false : true
>;

// Canary 3: `network/connect` ("any") IS in both (deliberate overlap). Split
// into two flat assertions so a failure names which side dropped it.
type _AnyInAgent = Expect<
  [AsMethod<"network/connect">] extends [AgentCallableTags] ? true : false
>;
type _AnyInApp = Expect<
  [AsMethod<"network/connect">] extends [AppCallableTags] ? true : false
>;

// Canary 4: the group tag sets are LITERAL branded unions, never the widened
// `JsonRpcMethod<string>` brand. A widened derivation makes the absence checks
// (1/2) vacuously green; this guard fails the build instead.
type _AgentNotWidened = Expect<
  Equal<AgentCallableTags, JsonRpcMethod<string>> extends true ? false : true
>;
type _AppNotWidened = Expect<
  Equal<AppCallableTags, JsonRpcMethod<string>> extends true ? false : true
>;
