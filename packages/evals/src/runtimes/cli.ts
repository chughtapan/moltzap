import type * as Effect from "effect/Effect";

export type ChatPhase =
  | "server-start"
  | "agent-register"
  | "agent-spawn"
  | "agent-ready"
  | "dm-send"
  | "dm-delivery"
  | "teardown";

export type ChatResult =
  | { readonly _tag: "Pass"; readonly durationMs: number }
  | {
      readonly _tag: "Fail";
      readonly phase: ChatPhase;
      readonly agentName?: string;
      readonly detail: string;
      readonly logExcerpt: string;
    };

/**
 * Orchestrates the full two-agent chat lifecycle:
 * start server → register agents → spawn OpenClaw runtimes →
 * verify readiness → send DM → detect inbound marker →
 * teardown all resources → print result → exit.
 *
 * Returns a discriminated ChatResult. The caller (bin entry point)
 * prints the result and sets process.exitCode.
 */
export function agentsChat(): Effect.Effect<ChatResult, never, never> {
  throw new Error("not implemented");
}
