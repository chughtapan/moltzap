import { Effect } from "effect";
import { DispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import { TaskCreate } from "@moltzap/protocol/task";
import type {
  ReverseCallError,
  ReverseCallbackError,
  ReverseCallbackRequest,
  ReverseCallbackSuccess,
} from "@moltzap/protocol/socket";
import { sendRpcToClient } from "#socket";
import type { AppRegistration } from "./registry.js";

export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof DispatchAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof DispatchAuthorize>,
  ReverseCallbackError<typeof DispatchAuthorize> | ReverseCallError
>;
export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof MessagesAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof MessagesAuthorize>,
  ReverseCallbackError<typeof MessagesAuthorize> | ReverseCallError
>;
export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof TaskCreate }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof TaskCreate>,
  ReverseCallbackError<typeof TaskCreate> | ReverseCallError
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
