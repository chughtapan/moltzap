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
  TSchema,
} from "@moltzap/protocol";
import {
  decodeRpcResult,
  decodeNotification,
  ErrorCodes,
  notificationGroup,
} from "@moltzap/protocol";
import { Effect, HashMap, Option, Ref } from "effect";
import { MoltZapService, type ServiceRpcError } from "../service.js";
import type { RpcCallOptions } from "../ws-client.js";
import { RpcServerError } from "../runtime/errors.js";
import { testAgentId } from "./ids.js";

/** A tracked `sendRpc` invocation. */
export interface RecordedCall {
  method: string;
  params: unknown;
  opts?: RpcCallOptions;
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
  setResponse<D extends RpcDefinition<string, TSchema, TSchema>>(
    definition: D,
    result: ResultOf<D>,
  ): void {
    this.responses.set(definition.name, () => Effect.succeed(result));
  }

  /**
   * Remove a previously-registered response.
   */
  deleteResponse<D extends RpcDefinition<string, TSchema, TSchema>>(
    definition: D,
  ): void {
    this.responses.delete(definition.name);
  }

  override sendRpc<D extends RpcDefinition<string, TSchema, TSchema>>(
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
            decodeRpcResult(definition, result).pipe(
              Effect.mapError(
                () =>
                  new RpcServerError({
                    code: ErrorCodes.InternalError,
                    message: `FakeMoltZapService: invalid result for ${method}`,
                    data: result,
                  }),
              ),
            ),
          ),
        );
      }
      return Effect.fail(
        new RpcServerError({
          code: ErrorCodes.MethodNotFound,
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
    const notification = Effect.runSync(
      decodeNotification(notificationGroup, event).pipe(
        Effect.mapError(
          () =>
            new RpcServerError({
              code: ErrorCodes.InvalidParams,
              message: `FakeMoltZapService: invalid notification ${event.method}`,
              data: event.params,
            }),
        ),
      ),
    );
    this.emitNotification(notification);
  }

  emitNotification(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    this.handleNotification(notification);
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
