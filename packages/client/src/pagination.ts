/** @file Provides a generic drainer for cursor-paginated list RPCs. */
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

/** Represents send rpc fn values. */
export type SendRpcFn<E, Definition extends ClientDescriptor> = (
  definition: Definition,
  params: ClientDefinitionPayload<Definition>,
) => Effect.Effect<ClientDefinitionSuccess<Definition>, E>;

/** Configures drain paginated list. */
export interface DrainPaginatedListOptions<
  E,
  D extends ClientDescriptor,
  Row,
  Cursor extends string,
> {
  readonly sendRpc: SendRpcFn<E, D>;
  readonly definition: D;
  readonly paramsForCursor: (cursor?: Cursor) => ClientDefinitionPayload<D>;
  readonly rowsForPage: (page: ClientDefinitionSuccess<D>) => readonly Row[];
  readonly nextCursorForPage: (
    page: ClientDefinitionSuccess<D>,
  ) => Cursor | undefined;
}

/**
 * Drain every page of a cursor-paginated list RPC, echoing the opaque
 * `nextCursor` back as the next page's `cursor`. Fails with
 * {@link NonAdvancingCursorError} if the server returns a cursor it already
 * emitted (cycle guard).
 * @param root0 Value supplied to the operation.
 * @param root0.sendRpc Value supplied to the operation.
 * @param root0.definition Value supplied to the operation.
 * @param root0.paramsForCursor Value supplied to the operation.
 * @param root0.rowsForPage Value supplied to the operation.
 * @param root0.nextCursorForPage Value supplied to the operation.
 * @returns The drain paginated list result.
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
  readonly Row[],
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
      if (nextCursor !== undefined) {
        seenCursors.add(nextCursor);
      }
      cursor = nextCursor;
      more = nextCursor !== undefined;
    }
    return acc;
  }).pipe(Effect.withSpan("drainPaginatedList"));
}
