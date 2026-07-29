import { Effect } from "effect";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize } from "@moltzap/protocol/message";
import { taskCreate } from "@moltzap/protocol/task";
import type {
  ReverseCallError,
  ReverseCallbackError,
  ReverseCallbackRequest,
  ReverseCallbackSuccess,
} from "@moltzap/protocol/socket";
import { sendRpcToClient } from "#socket";
import type { AppRegistration } from "./registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof dispatchAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof dispatchAuthorize>,
  ReverseCallbackError<typeof dispatchAuthorize> | ReverseCallError
>;
export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof messagesAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof messagesAuthorize>,
  ReverseCallbackError<typeof messagesAuthorize> | ReverseCallError
>;
export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof taskCreate }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof taskCreate>,
  ReverseCallbackError<typeof taskCreate> | ReverseCallError
>;
export function callAppRpc(
  entry: AppRegistration,
  request: ReverseCallbackRequest,
): ReturnType<typeof sendRpcToClient> {
  return sendRpcToClient(entry.endpoint.originator, request);
}

export function wrapHookEffectWithEnvelope<Verdict, E = never>(opts: {
  readonly raw: Effect.Effect<Verdict, E>;
  readonly timeoutMs: number;
  readonly timeoutLogMessage: string;
  readonly timeoutLogContext: Record<string, unknown>;
  readonly errorLogMessage: string;
  readonly errorLogContext: Record<string, unknown>;
  readonly onTimeout: () => Verdict;
  readonly onError: () => Verdict;
}): Effect.Effect<Verdict, never> {
  return opts.raw.pipe(
    Effect.timeout(`${opts.timeoutMs} millis`),
    Effect.catchTag("TimeoutException", () =>
      Effect.gen(function* () {
        yield* Effect.logWarning(opts.timeoutLogMessage).pipe(
          Effect.annotateLogs(opts.timeoutLogContext),
        );
        return opts.onTimeout();
      }),
    ),
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        yield* Effect.logError(opts.errorLogMessage).pipe(
          Effect.annotateLogs({
            ...opts.errorLogContext,
            err: errorMessage(err),
          }),
        );
        return opts.onError();
      }),
    ),
    Effect.withSpan("wrapHookEffectWithEnvelope"),
  );
}
