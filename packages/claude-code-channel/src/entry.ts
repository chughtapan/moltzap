/**
 * entry — public boot entry point for `@moltzap/claude-code-channel`.
 *
 * Wires `MoltZapService` + `MoltZapChannelCore` + the MCP stdio server into
 * a single `Handle`. Mirrors `~/moltzap/packages/openclaw-channel/src/openclaw-entry.ts`
 * as the precedent for "wrap client primitives + host plugin shape."
 *
 * Spec A2: `bootClaudeCodeChannel(opts: BootOptions): Promise<Result<Handle, BootError>>`.
 *
 * Lifecycle (linear, no nontrivial state machine):
 *   1. Validate options; fail fast with `AgentKeyInvalid` if `agentKey` is
 *      absent/empty.
 *   2. Construct `MoltZapService` from `{serverUrl, agentKey, logger}`.
 *   3. Construct `MoltZapChannelCore` over that service.
 *   4. Construct `RoutingState` (fresh, per-boot).
 *   5. Boot the MCP stdio server (`bootChannelMcpServer`) with bound
 *      `sendReply` (capture `core.sendReply` + `RoutingState.resolveTarget`)
 *      and `routing`.
 *   6. Register inbound handler on `core.onInbound`: apply `gateInbound?`
 *      (Principle 4 — handle both Success / Failure branches); on Success
 *      translate via `toClaudeChannelNotification`, update `RoutingState`,
 *      push through the server handle.
 *   7. `core.connect()` — any `ServiceRpcError` maps to
 *      `ServiceConnectFailed`.
 *   8. Return `Handle`.
 *
 * Shutdown path (`Handle.stop`): `core.disconnect()` → `serverHandle.stop()`.
 * Both swallow downstream errors into `logger.error` per spec I8; the public
 * `stop` is `Effect<void>` with no error channel because no caller can
 * meaningfully react to teardown failures.
 *
 * No `Promise<T>` on internal plumbing — the spec fixes `Promise<Result<...>>`
 * only at the public boot boundary (A2); everything downstream stays in
 * Effect (Principle 3). The single `runPromise` tax lives inside this file.
 */

import type { BootOptions, Handle } from "./types.js";
import type { BootError } from "./errors.js";

export type BootResult =
  | { readonly _tag: "Ok"; readonly value: Handle }
  | { readonly _tag: "Err"; readonly error: BootError };

/**
 * Boot a Claude Code channel. Single public entry point of the package.
 *
 * Returns `Promise<BootResult>` — the `Promise` is a concession to callers
 * that have not adopted Effect (zapbot today). Internals are Effect; the
 * error channel stays tagged (Principle 3, not `Promise<Handle>` throws).
 */
export function bootClaudeCodeChannel(
  opts: BootOptions,
): Promise<BootResult> {
  throw new Error("not implemented");
}
