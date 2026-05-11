/**
 * Fake `MoltZapService` test double, reusable across the client's own tests
 * and downstream consumers (nanoclaw, openclaw).
 *
 * Strategy: extend the real `MoltZapService`, keeping all stateful logic
 * intact, and override only `sendRpc` so every RPC is answered from a
 * canned-response map. `setResponse` indexes by protocol descriptor so a
 * typo in the wire name cannot compile.
 *
 * Motivation: the `sendToAgent` contract drift bug (A7) happened because a
 * hand-maintained mock drifted from the real wire shape. Typed method names
 * surface renames and additions to the RPC surface as compile errors across
 * every test that uses the fake.
 *
 * Canned responses are validated through the descriptor's result schema before
 * they are returned, matching the real transport boundary.
 */

import type {
  DecodedNotification,
  AnyNotificationDefinition,
  NotificationFrame,
  Message,
  ParamsOf,
  ResultOf,
  RpcDefinition,
} from "@moltzap/protocol";
import {
  decodeServerInbound,
  JSON_RPC_RESERVED_CODES,
  RpcServerError,
} from "@moltzap/protocol";
import { Effect, HashMap, Option, Ref } from "effect";
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import type { RpcCallOptions } from "@moltzap/client";
import { testAgentId } from "./ids.js";

/** A tracked `sendRpc` invocation. */
export interface RecordedCall {
  method: string;
  params: unknown;
  opts?: RpcCallOptions;
}

/**
 * Shape returned by the service's internal `messages/list` poll handler
 * (`handleHistoryRequest`). Test code that exercises the poll-dedup
 * path via `pollHistory` reads `messages.length` to assert dedup.
 */
export interface PollHistoryResult {
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly senderId: string;
    readonly senderName: string;
    readonly isOwn: boolean;
    readonly text: string;
    readonly createdAt: string;
    readonly isNew: boolean;
  }>;
  readonly hasMore: boolean;
  readonly conversationMeta: unknown;
  readonly newCount: number;
}

export class FakeMoltZapService extends MoltZapService {
  calls: RecordedCall[] = [];
  private readonly responses = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, ServiceRpcError>
  >();

  constructor(
    opts: {
      serverUrl?: string;
      agentKey?: string;
    } = {},
  ) {
    super({
      serverUrl: opts.serverUrl ?? "ws://test.invalid",
      agentKey: opts.agentKey ?? "test-key",
    });
  }

  /**
   * Register a canned response, typed against the real RPC descriptor.
   */
  setResponse<D extends RpcDefinition<string, any, any>>(
    definition: D,
    result: ResultOf<D>,
  ): void {
    this.responses.set(definition.name, () => Effect.succeed(result));
  }

  /**
   * Remove a previously-registered response.
   */
  deleteResponse<D extends RpcDefinition<string, any, any>>(
    definition: D,
  ): void {
    this.responses.delete(definition.name);
  }

  override sendRpc<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ResultOf<D>, ServiceRpcError> {
    return Effect.suspend(() => {
      const method = definition.name;
      this.calls.push(
        opts === undefined ? { method, params } : { method, params, opts },
      );
      const responder = this.responses.get(method);
      if (responder !== undefined) {
        return responder(params).pipe(
          Effect.flatMap((result) =>
            definition.validateResult(result)
              ? Effect.succeed(result as ResultOf<D>)
              : Effect.fail(
                  new RpcServerError({
                    code: JSON_RPC_RESERVED_CODES.InternalError,
                    message: `FakeMoltZapService: invalid result for ${method}`,
                    data: result,
                  }),
                ),
          ),
        );
      }
      return Effect.fail(
        new RpcServerError({
          code: JSON_RPC_RESERVED_CODES.MethodNotFound,
          message: `FakeMoltZapService: no canned response for ${method}`,
        }),
      );
    });
  }

  // --- Test harness: reach into private state ---

  /**
   * Insert a message into the service's internal buffer without going
   * through the WebSocket path — used to stage state for context-building
   * tests.
   */
  addMessage(convId: string, msg: Message): void {
    Effect.runSync(
      Ref.update(this.parentMessagesRef, (m) => {
        const existing = Option.getOrElse(
          HashMap.get(m, convId),
          () => [] as ReadonlyArray<Message>,
        );
        return HashMap.set(m, convId, [...existing, msg]);
      }),
    );
  }

  /** Deliver a protocol notification through the real service handler. */
  emitEvent(event: NotificationFrame): void {
    const decoded = Effect.runSync(
      decodeServerInbound(event).pipe(
        Effect.mapError(
          () =>
            new RpcServerError({
              code: JSON_RPC_RESERVED_CODES.InvalidParams,
              message: `FakeMoltZapService: invalid notification ${event.method}`,
              data: event.params,
            }),
        ),
      ),
    );
    if (decoded._tag !== "Notification") {
      throw new RpcServerError({
        code: JSON_RPC_RESERVED_CODES.InvalidParams,
        message: `FakeMoltZapService: emitEvent expects a notification frame, got ${decoded._tag}`,
        data: event,
      });
    }
    this.emitNotification(decoded);
  }

  emitNotification(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    this.handleNotification(notification);
  }

  /**
   * Drive the `messages/list` poll path the way the unix socket does
   * — including the post-`sendRpc` dedup filter the service applies
   * before returning history to the caller. The caller registers a
   * `MessagesList` response via `setResponse` and observes the
   * returned `messages` array; duplicates that were already surfaced
   * via the live `messages/received` path are dropped.
   *
   * Reaches into the parent via `Reflect.get` because
   * `handleSocketRequestEffect` is `private`. The fake is the only
   * legitimate caller — the test surface for the poll-path dedup
   * invariant.
   */
  pollHistory(params: {
    conversationId: string;
    limit?: number;
    sessionKey?: string;
  }): Effect.Effect<PollHistoryResult, unknown> {
    const handle = Reflect.get(this, "handleSocketRequestEffect") as
      | undefined
      | ((
          method: string,
          params: Record<string, unknown>,
        ) => Effect.Effect<unknown, unknown>);
    if (typeof handle !== "function") {
      return Effect.fail(
        new RpcServerError({
          code: JSON_RPC_RESERVED_CODES.InternalError,
          message:
            "FakeMoltZapService.pollHistory: parent handleSocketRequestEffect missing",
        }),
      );
    }
    return handle.call(this, "history", {
      conversationId: params.conversationId,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.sessionKey !== undefined
        ? { sessionKey: params.sessionKey }
        : {}),
    }) as Effect.Effect<PollHistoryResult, unknown>;
  }

  /** Pin an agent name in the internal cache without an RPC round-trip. */
  setAgentNameDirect(id: string, name: string): void {
    Effect.runSync(
      Ref.update(this.parentAgentNamesRef, (m) =>
        HashMap.set(m, testAgentId(id), name),
      ),
    );
  }

  /**
   * Typed views of the parent class's private Refs, exposed only to this
   * fake so its test-only harness methods can stage state without going
   * through the WebSocket pipeline.
   */
  private get parentMessagesRef(): ParentInternals["messagesRef"] {
    return Reflect.get(this, "messagesRef") as ParentInternals["messagesRef"];
  }

  private get parentAgentNamesRef(): ParentInternals["agentNamesRef"] {
    return Reflect.get(
      this,
      "agentNamesRef",
    ) as ParentInternals["agentNamesRef"];
  }
}

/** Shape of the parent `MoltZapService`'s private Refs, exposed in the fake
 *  via `this.internals` so the test-only harness methods can seed state. */
interface ParentInternals {
  messagesRef: Ref.Ref<HashMap.HashMap<string, ReadonlyArray<Message>>>;
  agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>>;
}
