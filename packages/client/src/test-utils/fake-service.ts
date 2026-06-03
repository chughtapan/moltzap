/**
 * Fake `MoltZapService` test double, reusable across the client's own tests
 * and downstream consumers (nanoclaw, openclaw).
 *
 * Strategy: extend the real `MoltZapService`, keeping all stateful logic
 * intact, and override only `call` so every RPC is answered from a
 * canned-response map. `setResponse` indexes by protocol descriptor so a
 * typo in the wire name cannot compile.
 *
 * Motivation: the `sendToAgent` contract drift bug happened because a
 * hand-maintained mock drifted from the real wire shape. Typed method names
 * surface renames and additions to the RPC surface as compile errors across
 * every test that uses the fake.
 */

import type {
  DecodedNotification,
  AnyNotificationDefinition,
  NotificationFrame,
  Message,
  ResultOf,
  RpcDefinition,
} from "@moltzap/protocol";
import { notificationDefinitions, NotFoundError } from "@moltzap/protocol";
import { decodeNotification } from "@moltzap/protocol/testing";
import { Effect, HashMap, Option, Ref } from "effect";
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import type { RpcCallOptions } from "@moltzap/client";
import { testAgentId } from "./ids.js";

/** A tracked `call` invocation. */
export interface RecordedCall {
  method: string;
  params: unknown;
  opts?: RpcCallOptions;
}

export class FakeMoltZapService extends MoltZapService {
  calls: RecordedCall[] = [];
  private readonly responses = new Map<
    string,
    () => Effect.Effect<unknown, ServiceRpcError>
  >();

  constructor(
    opts: {
      serverUrl?: string;
      agentKey?: string;
      agentId?: string;
    } = {},
  ) {
    super({
      serverUrl: opts.serverUrl ?? "ws://test.invalid",
      agentKey: opts.agentKey ?? "test-key",
      agentId: opts.agentId ?? "test-agent",
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

  override call<Tag extends Parameters<MoltZapService["call"]>[0]>(
    tag: Tag,
    payload: Parameters<MoltZapService["call"]>[1],
    opts?: RpcCallOptions,
  ): ReturnType<MoltZapService["call"]> {
    return Effect.suspend(() => {
      this.calls.push(
        opts === undefined
          ? { method: tag, params: payload }
          : { method: tag, params: payload, opts },
      );
      const responder = this.responses.get(tag);
      if (responder !== undefined) {
        return responder() as ReturnType<MoltZapService["call"]>;
      }
      return Effect.fail(
        new NotFoundError({
          message: `FakeMoltZapService: no canned response for ${tag}`,
        }),
      ) as ReturnType<MoltZapService["call"]>;
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
      decodeNotification(notificationDefinitions, event),
    );
    this.emitNotification(decoded);
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

/**
 * Shape of the parent `MoltZapService`'s private Refs, exposed in the fake
 *  via `this.internals` so the test-only harness methods can seed state.
 */
interface ParentInternals {
  messagesRef: Ref.Ref<HashMap.HashMap<string, ReadonlyArray<Message>>>;
  agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>>;
}
