/**
 * @file Generic drainer for the cursor-paginated list RPCs.
 *
 * The list RPCs (`contacts/list`, `agents/list`, `task/list`, …) return a
 * bounded page plus an opaque `nextCursor`. A consumer that needs the
 * COMPLETE set must page through every cursor. {@link drainPaginatedList}
 * does exactly that for any RPC whose result is `{ [K]: T[], nextCursor? }`,
 * echoing the opaque `nextCursor` back as the next page's `cursor`.
 *
 * Lives in `@moltzap/client` because the logic is wire-generic: any
 * channel or CLI that drains a list RPC reuses it (openclaw's directory
 * is the first consumer).
 */
import type { ParamsOf, ResultOf, RpcDefinition } from "@moltzap/protocol";
import { Data, Effect } from "effect";

/**
 * A server that returns a non-advancing `nextCursor` (one already seen)
 * would loop the drain forever; fail typed so the caller's `catchAll`
 * can degrade gracefully instead of hanging. This is a cycle guard, NOT
 * a page cap — a well-behaved server never trips it.
 */
export class NonAdvancingCursorError extends Data.TaggedError(
  "NonAdvancingCursorError",
)<{
  readonly method: string;
}> {
  override get message(): string {
    return `Pagination cursor for ${this.method} did not advance — refusing to loop`;
  }
}

/**
 * The `sendRpc` shape every drain consumer provides: send one list-RPC
 * page, decoding its typed result. Parameterized over the sender's error
 * channel `E` so the helper stays decoupled from any one client's error
 * union.
 */
export type SendRpcFn<E> = <D extends RpcDefinition<string, any, any>>(
  definition: D,
  params: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, E>;

/**
 * Drain every page of a cursor-paginated list RPC whose result is
 * `{ [K]: T[], nextCursor? }`, echoing the opaque `nextCursor` back as the
 * next page's `cursor`. Fails with {@link NonAdvancingCursorError} if the
 * server returns a cursor it already emitted (cycle guard).
 */
export function drainPaginatedList<
  E,
  D extends RpcDefinition<string, any, any>,
  K extends keyof ResultOf<D>,
>(
  sendRpc: SendRpcFn<E>,
  definition: D,
  collectionKey: K,
): Effect.Effect<ResultOf<D>[K], E | NonAdvancingCursorError> {
  return Effect.gen(function* () {
    const acc: Array<
      ResultOf<D>[K] extends ReadonlyArray<infer Elem> ? Elem : never
    > = [];
    // Cycle guard, not a page cap: a repeated cursor means the server is
    // not advancing, so fail typed rather than loop forever.
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let more = true;
    while (more) {
      const params = (cursor !== undefined ? { cursor } : {}) as ParamsOf<D>;
      const page = yield* sendRpc(definition, params);
      const rows = page[collectionKey] as ReadonlyArray<
        ResultOf<D>[K] extends ReadonlyArray<infer Elem> ? Elem : never
      >;
      acc.push(...rows);
      const nextCursor = (page as { readonly nextCursor?: string }).nextCursor;
      if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
        return yield* Effect.fail(
          new NonAdvancingCursorError({ method: definition.name }),
        );
      }
      if (nextCursor !== undefined) seenCursors.add(nextCursor);
      cursor = nextCursor;
      more = nextCursor !== undefined;
    }
    return acc as ResultOf<D>[K];
  }).pipe(Effect.withSpan("drainPaginatedList"));
}
