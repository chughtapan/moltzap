import { Effect } from "effect";
import type { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import type { messagesAuthorize } from "@moltzap/protocol/message";
import type { taskCreate } from "@moltzap/protocol/task";
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
/**
 * Executes the call app rpc operation.
 * @param entry Value supplied to the operation.
 * @param request Value supplied to the operation.
 * @returns The call app rpc result.
 */
export function callAppRpc(
  entry: AppRegistration,
  request: ReverseCallbackRequest,
): ReturnType<typeof sendRpcToClient> {
  return sendRpcToClient(entry.endpoint.originator, request);
}

/**
 * Executes the wrap hook effect with envelope operation.
 * @param opts Value supplied to the operation.
 * @param opts.raw Value supplied to the operation.
 * @param opts.timeoutMs Value supplied to the operation.
 * @param opts.timeoutLogMessage Value supplied to the operation.
 * @param opts.timeoutLogContext Value supplied to the operation.
 * @param opts.errorLogMessage Value supplied to the operation.
 * @param opts.errorLogContext Value supplied to the operation.
 * @param opts.onTimeout Value supplied to the operation.
 * @param opts.onError Value supplied to the operation.
 * @returns The wrap hook effect with envelope result.
 */
export function wrapHookEffectWithEnvelope<Verdict, E = never>(opts: {
  readonly raw: Effect.Effect<Verdict, E>;
  readonly timeoutMs: number;
  readonly timeoutLogMessage: string;
  readonly timeoutLogContext: Record<string, unknown>;
  readonly errorLogMessage: string;
  readonly errorLogContext: Record<string, unknown>;
  readonly onTimeout: () => Verdict;
  readonly onError: () => Verdict;
}): Effect.Effect<Verdict> {
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
