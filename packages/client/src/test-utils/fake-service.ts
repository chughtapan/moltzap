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

import type { AgentId } from "@moltzap/protocol/identity";
import type { AgentKey } from "@moltzap/protocol/credentials";
import {
  AgentCallableGroup,
  type AnyAgentCallableRpcDefinition,
  type AnyNotificationDefinition,
} from "@moltzap/protocol/rpc-method-groups";
import type {
  NotificationDelivery,
  NotificationParamsOf,
  PayloadForTag,
  SuccessForTag,
} from "@moltzap/protocol/transport";
import type { Message } from "@moltzap/protocol/message";
import type { RpcGroup } from "@effect/rpc";
import { NotFoundError } from "@moltzap/protocol/transport";
import { agentKeyString, redactedAgentKey } from "@moltzap/protocol/testing";
import { Effect, HashMap, Option, Ref } from "effect";
import { MoltZapService, type ServiceRpcError } from "@moltzap/client";
import type { RpcCallOptions } from "@moltzap/client";
import { testAgentId } from "./ids.js";

const TEST_AGENT_KEY = redactedAgentKey(agentKeyString(0));

type FakeAgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;
type FakeAgentCallableTag = FakeAgentCallableRpcs["_tag"];
type FakeResponseMap = {
  [Tag in FakeAgentCallableTag]?: () => Effect.Effect<
    SuccessForTag<FakeAgentCallableRpcs, Tag>,
    ServiceRpcError
  >;
};

/** A tracked `call` invocation. */
export interface RecordedCall {
  method: string;
  params: unknown;
  opts?: RpcCallOptions;
}

export class FakeMoltZapService extends MoltZapService {
  calls: RecordedCall[] = [];
  private readonly responses: FakeResponseMap = {};

  constructor(
    opts: {
      serverUrl?: string;
      agentKey?: AgentKey;
      agentId?: AgentId;
    } = {},
  ) {
    super({
      serverUrl: opts.serverUrl ?? "ws://test.invalid",
      agentKey: opts.agentKey ?? TEST_AGENT_KEY,
      agentId: opts.agentId ?? testAgentId("test-agent"),
    });
  }

  /**
   * Register a canned response, typed against the real RPC descriptor.
   */
  setResponse<Tag extends FakeAgentCallableTag>(
    definition: Extract<AnyAgentCallableRpcDefinition, { readonly name: Tag }>,
    result: SuccessForTag<FakeAgentCallableRpcs, Tag>,
  ): void {
    this.responses[definition.name] = () => Effect.succeed(result);
  }

  /**
   * Remove a previously-registered response.
   */
  deleteResponse<Tag extends FakeAgentCallableTag>(
    definition: Extract<AnyAgentCallableRpcDefinition, { readonly name: Tag }>,
  ): void {
    delete this.responses[definition.name];
  }

  override call<Tag extends FakeAgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<FakeAgentCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<SuccessForTag<FakeAgentCallableRpcs, Tag>, ServiceRpcError> {
    return Effect.suspend(() => {
      this.calls.push(
        opts === undefined
          ? { method: tag, params: payload }
          : { method: tag, params: payload, opts },
      );
      const responder = this.responses[tag];
      if (responder !== undefined) {
        return responder();
      }
      return Effect.fail(
        new NotFoundError({
          message: `FakeMoltZapService: no canned response for ${tag}`,
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

  /** Deliver already Schema-decoded notification params through the service. */
  emitEvent<D extends AnyNotificationDefinition>(
    definition: D,
    params: NotificationParamsOf<D>,
  ): void {
    this.emitNotification({
      definition,
      method: definition.name,
      params,
    });
  }

  emitNotification(
    notification: NotificationDelivery<AnyNotificationDefinition>,
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
