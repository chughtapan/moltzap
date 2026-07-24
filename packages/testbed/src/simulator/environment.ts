/**
 * @file Environment (contract 2): wiring per-agent MCP servers and
 * skills into each runtime at spawn time. Every mounted MCP server is
 * wrapped in the logging proxy; the proxy is interface-transparent (tool
 * results byte-identical with and without it) and taps every call and
 * result into the event log. Environment semantics (what the tools do)
 * live entirely with the consumer; the simulator only mounts them.
 */
import type { Effect, Scope } from "effect";
import type { Agent } from "./run-spec.js";
import type { EventLog } from "./event-log.js";
import type { Secrets } from "./recording.js";
import type { LoggingProxyFailed, MountFailed } from "./errors.js";

/**
 * Adapter-facing mount material for one agent. Each runtime adapter
 * consumes the plan its own way: OpenClaw via plugin/CLI config,
 * Nanoclaw via container mounts; an agent without MCP servers yields an empty
 * plan and the no-mount launch path is unchanged.
 */
export type MountPlan = {
  readonly agent: Agent["name"];

  /**
   * Proxied MCP server endpoints, one per declared MCP server, in
   * spec order. Each endpoint fronts the consumer's MCP server through
   * the logging proxy.
   */
  readonly proxiedServers: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  }>;
};

/** A prepared mount: the adapter-facing plan plus the proxy health channel. */
export type MountHandle = {
  readonly plan: MountPlan;
  /** Resolves only if a proxy or mounted server fails after launch; `run` races it. */
  awaitFailure(): Effect.Effect<never, LoggingProxyFailed, never>;
};

/**
 * Environment contract. `prepare` spawns the consumer's MCP servers
 * behind logging proxies and returns the plan the runtime adapter wires
 * in at spawn time; proxies and servers are released at scope close.
 * Mount env values that are credential material are registered in
 * `secrets` before any proxy starts.
 */
export interface Environment {
  prepare(
    agent: Agent,
    log: EventLog,
    secrets: Secrets,
  ): Effect.Effect<MountHandle, MountFailed | LoggingProxyFailed, Scope.Scope>;
}

/** Create the v0 environment mount (stdio MCP servers behind the logging proxy). */
export function makeEnvironment(): Environment {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
