/**
 * @file Generic drainer for the cursor-paginated list RPCs.
 *
 * The list RPCs (`agent/identity/contacts/list`, `agent/identity/agents/list`, `task/list`, ...) return a
 * bounded page plus an opaque `nextCursor`. A consumer that needs the
 * COMPLETE set must page through every cursor. {@link drainPaginatedList}
 * does exactly that for descriptor-based RPC calls, with the caller supplying
 * the descriptor-specific page params and row/cursor accessors.
 *
 * Lives in `@moltzap/client` because the logic is wire-generic: any
 * channel or CLI that drains a list RPC reuses it (openclaw's directory
 * is the first consumer).
 */
import type {
  ClientDefinitionPayload,
  ClientDefinitionSuccess,
  ClientRpcDefinition,
} from "@moltzap/protocol/socket";
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
type ClientDescriptor = ClientRpcDefinition & { readonly name: string };

export type SendRpcFn<E, Definition extends ClientDescriptor> = (
  definition: Definition,
  params: ClientDefinitionPayload<Definition>,
) => Effect.Effect<ClientDefinitionSuccess<Definition>, E>;

export interface DrainPaginatedListOptions<
  E,
  D extends ClientDescriptor,
  Row,
  Cursor extends string,
> {
  readonly sendRpc: SendRpcFn<E, D>;
  readonly definition: D;
  readonly paramsForCursor: (
    cursor: Cursor | undefined,
  ) => ClientDefinitionPayload<D>;
  readonly rowsForPage: (
    page: ClientDefinitionSuccess<D>,
  ) => ReadonlyArray<Row>;
  readonly nextCursorForPage: (
    page: ClientDefinitionSuccess<D>,
  ) => Cursor | undefined;
}

/**
 * Drain every page of a cursor-paginated list RPC, echoing the opaque
 * `nextCursor` back as the next page's `cursor`. Fails with
 * {@link NonAdvancingCursorError} if the server returns a cursor it already
 * emitted (cycle guard).
 */
export function drainPaginatedList<
  E,
  D extends ClientDescriptor,
  Row,
  Cursor extends string,
>({
  sendRpc,
  definition,
  paramsForCursor,
  rowsForPage,
  nextCursorForPage,
}: DrainPaginatedListOptions<E, D, Row, Cursor>): Effect.Effect<
  ReadonlyArray<Row>,
  E | NonAdvancingCursorError
> {
  return Effect.gen(function* () {
    const acc: Row[] = [];
    // Cycle guard, not a page cap: a repeated cursor means the server is
    // not advancing, so fail typed rather than loop forever.
    const seenCursors = new Set<Cursor>();
    let cursor: Cursor | undefined;
    let more = true;
    while (more) {
      const params = paramsForCursor(cursor);
      const page = yield* sendRpc(definition, params);
      acc.push(...rowsForPage(page));
      const nextCursor = nextCursorForPage(page);
      if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
        return yield* Effect.fail(
          new NonAdvancingCursorError({ method: definition.name }),
        );
      }
      if (nextCursor !== undefined) seenCursors.add(nextCursor);
      cursor = nextCursor;
      more = nextCursor !== undefined;
    }
    return acc;
  }).pipe(Effect.withSpan("drainPaginatedList"));
}
