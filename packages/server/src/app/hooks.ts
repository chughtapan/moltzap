/**
 * @file Server-side hook types for the `dispatch/authorize` and
 * `messages/authorize` server-to-client RPCs. All context, decision,
 * and verdict shapes derive from the protocol's wire schemas
 * (`ParamsOf` / `ResultOf`); the `signal: AbortSignal` reaches handlers
 * via the runner that invokes them (`AppHost.runInProcessHookEffect`),
 * not via the wire context.
 */

import {
  type ParamsOf,
  type ResultOf,
  type DispatchAuthorize,
  type MessagesAuthorize,
} from "@moltzap/protocol";

export type TaskAuthorizeDispatchContext = ParamsOf<typeof DispatchAuthorize>;

export type DispatchAdmissionResult = ResultOf<
  typeof DispatchAuthorize
>["admission"];

export type TaskAuthorizeDispatchHook = (
  ctx: TaskAuthorizeDispatchContext & { signal: AbortSignal },
) => DispatchAdmissionResult | Promise<DispatchAdmissionResult>;

export type MessageAuthorizeContext = ParamsOf<typeof MessagesAuthorize>;

export type MessageAuthorizeResult = ResultOf<
  typeof MessagesAuthorize
>["verdict"];

export type MessageAuthorizeHook = (
  ctx: MessageAuthorizeContext & { signal: AbortSignal },
) => MessageAuthorizeResult | Promise<MessageAuthorizeResult>;
