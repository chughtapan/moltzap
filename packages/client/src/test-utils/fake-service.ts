/**
 * Fake `MoltZapService` test double, reusable across the client's own tests
 * and downstream consumers (nanoclaw, openclaw).
 *
 * Strategy: extend the real `MoltZapService`, keeping all stateful logic
 * intact, and override only `sendRpc` so every RPC is answered from a
 * canned-response map. The typed `setResponse` helper indexes by
 * `RpcMethodName` so a typo in the wire name is a compile error — unknown
 * methods fail *at compile time*, not at runtime.
 *
 * Motivation: the `sendToAgent` contract drift bug (A7) happened because a
 * hand-maintained mock drifted from the real wire shape. Typed method names
 * surface renames and additions to the RPC surface as compile errors across
 * every test that uses the fake.
 *
 * Two APIs:
 *   (1) `setResponse(method, result)` — strict. `method` must be a
 *       `RpcMethodName`; `result` must match `RpcMap[M]["result"]`.
 *   (2) `responses` — the underlying `Map<string, unknown>`. Permissive,
 *       preserved so existing callers that set unstyped shapes
 *       (e.g. `{}` for a method whose real result has required fields)
 *       keep working. Prefer `setResponse` in new code.
 */

import type { Message, RpcMap, RpcMethodName } from "@moltzap/protocol";
import { Effect, HashMap, Option, Ref } from "effect";
import { MoltZapService, type ServiceRpcError } from "../service.js";
import type { RpcCallOptions } from "../ws-client.js";
import { RpcServerError } from "../runtime/errors.js";

/** A tracked `sendRpc` invocation. */
export interface RecordedCall {
  method: string;
  params: unknown;
  opts?: RpcCallOptions;
}

/**
 * Strict canned-response registry shape. Methods must be known protocol
 * names; results must match their declared schema. Use via `setResponse` —
 * spelled out as a type so downstream consumers can compose their own
 * factories.
 */
export type CannedResponses = Partial<{
  [M in RpcMethodName]:
    | RpcMap[M]["result"]
    | ((params: RpcMap[M]["params"]) => RpcMap[M]["result"]);
}>;

export class FakeMoltZapService extends MoltZapService {
  calls: RecordedCall[] = [];
  /**
   * Permissive response map. Prefer {@link setResponse} for typed
   * registration. Keep this as `Map<string, unknown>` so tests that pass
   * partial or loosely-shaped canned values — and tests that assert on
   * unknown-method rejection — keep working.
   */
  responses = new Map<string, unknown>();

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
   * Register a canned response, typed against the real RPC map. Unknown
   * method names are a compile error (`RpcMethodName` is a union literal),
   * and values must match `RpcMap[M]["result"]` — a schema change in the
   * protocol flows through to every test that sets a response for that
   * method.
   */
  setResponse<M extends RpcMethodName>(
    method: M,
    result:
      | RpcMap[M]["result"]
      | ((params: RpcMap[M]["params"]) => RpcMap[M]["result"]),
  ): void {
    this.responses.set(method, result);
  }

  /**
   * Remove a previously-registered response. Typed against `RpcMethodName`
   * so `deleteResponse("agents/lookpByName")` (typo) is a compile error.
   */
  deleteResponse(method: RpcMethodName): void {
    this.responses.delete(method);
  }

  override sendRpc(
    method: string,
    params?: unknown,
    opts?: RpcCallOptions,
  ): Effect.Effect<unknown, ServiceRpcError> {
    return Effect.suspend(() => {
      this.calls.push(
        opts === undefined ? { method, params } : { method, params, opts },
      );
      if (this.responses.has(method)) {
        const entry = this.responses.get(method);
        if (typeof entry === "function") {
          return Effect.sync(() => (entry as (p: unknown) => unknown)(params));
        }
        return Effect.succeed(entry);
      }
      return Effect.fail(
        new RpcServerError({
          code: -32601,
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
      Ref.update(this.internals.messagesRef, (m) => {
        const existing = Option.getOrElse(
          HashMap.get(m, convId),
          () => [] as ReadonlyArray<Message>,
        );
        return HashMap.set(m, convId, [...existing, msg]);
      }),
    );
  }

  /** Pin an agent name in the internal cache without an RPC round-trip. */
  setAgentNameDirect(id: string, name: string): void {
    Effect.runSync(
      Ref.update(this.internals.agentNamesRef, (m) => HashMap.set(m, id, name)),
    );
  }

  /**
   * Typed view of the parent class's private Refs, exposed only to this
   * fake so its test-only harness methods (addMessage, setAgentNameDirect)
   * can stage state without going through the WebSocket pipeline. This is
   * the single spot where the subclass widens its own `this` to see parent
   * privates — every other caller goes through the narrow harness API.
   */
  private get internals(): ParentInternals {
    // #ignore-sloppy-code-next-line[as-unknown-as]: single test-only view over parent class's private state; callers use this.internals.<ref>
    return this as unknown as ParentInternals;
  }
}

/** Shape of the parent `MoltZapService`'s private Refs, exposed in the fake
 *  via `this.internals` so the test-only harness methods can seed state. */
interface ParentInternals {
  messagesRef: Ref.Ref<HashMap.HashMap<string, ReadonlyArray<Message>>>;
  agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>>;
}
