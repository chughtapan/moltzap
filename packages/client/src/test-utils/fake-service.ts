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

import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import { serverBaseUrl } from "@moltzap/protocol/network";
import type {
  agentCallableGroup,
  AnyAgentCallableRpcDefinition,
  AnyNotificationDefinition,
} from "@moltzap/protocol/socket/catalog";
import type {
  NotificationDelivery,
  NotificationParamsOf,
  PayloadForTag,
  SuccessForTag,
} from "@moltzap/protocol/rpc";
import type { Message } from "@moltzap/protocol/message";
import type { RpcGroup } from "@effect/rpc";
import { agentKeyString, redactedAgentKey } from "@moltzap/protocol/testing";
import { Effect, HashMap, Option, Ref } from "effect";
import { MoltZapService, type ServiceRpcError } from "../service.js";
import type { RpcCallOptions } from "../agent-client.js";
import { testAgentId } from "./ids.js";

const TEST_AGENT_KEY = redactedAgentKey(agentKeyString(0));

type FakeAgentCallableRpcs = RpcGroup.Rpcs<typeof agentCallableGroup>;
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

/** Implements fake molt zap service. */
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
      serverUrl: serverBaseUrl(opts.serverUrl ?? "ws://test.invalid"),
      agentKey: opts.agentKey ?? TEST_AGENT_KEY,
      agentId: opts.agentId ?? testAgentId("test-agent"),
    });
  }

  /**
   * Register a canned response, typed against the real RPC descriptor.
   * @param definition Protocol definition to process.
   * @param result Value supplied to the operation.
   */
  setResponse<Tag extends FakeAgentCallableTag>(
    definition: Extract<AnyAgentCallableRpcDefinition, { readonly name: Tag }>,
    result: SuccessForTag<FakeAgentCallableRpcs, Tag>,
  ): void {
    this.responses[definition.name] = () => Effect.succeed(result);
  }

  /**
   * Remove a previously-registered response.
   * @param definition Protocol definition to process.
   */
  deleteResponse(definition: AnyAgentCallableRpcDefinition): void {
    Reflect.deleteProperty(this.responses, definition.name);
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
      return Effect.dieMessage(
        `FakeMoltZapService: no canned response for ${tag}`,
      );
    });
  }

  // --- Test harness: reach into private state ---

  /**
   * Insert a message into the service's internal buffer without going
   * through the WebSocket path. Tests use this to stage context-building state.
   * @param convId Value supplied to the operation.
   * @param msg Value supplied to the operation.
   */
  addMessage(convId: string, msg: Message): void {
    Effect.runSync(
      Ref.update(this.parentMessagesRef, (m) => {
        const existing = Option.getOrElse(
          HashMap.get(m, convId),
          (): readonly Message[] => [],
        );
        return HashMap.set(m, convId, [...existing, msg]);
      }),
    );
  }

  /**
   * Deliver already Schema-decoded notification params through the service.
   * @param definition Protocol definition to process.
   * @param params Request payload to process.
   */
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

  /**
   * Pin an agent name in the internal cache without an RPC round-trip.
   * @param id Value supplied to the operation.
   * @param name Name of the operation.
   */
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
   * @returns The parent messages ref result.
   */
  private get parentMessagesRef(): ParentInternals["messagesRef"] {
    return Reflect.get(this, "messagesRef");
  }

  private get parentAgentNamesRef(): ParentInternals["agentNamesRef"] {
    return Reflect.get(this, "agentNamesRef");
  }
}

/**
 * Shape of the parent `MoltZapService`'s private Refs, exposed in the fake
 *  via `this.internals` so the test-only harness methods can seed state.
 */
interface ParentInternals {
  messagesRef: Ref.Ref<HashMap.HashMap<string, readonly Message[]>>;
  agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>>;
}
