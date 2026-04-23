/**
 * Toxiproxy control-plane client.
 *
 * Per design doc §5 "Dependency choices", we talk to Toxiproxy's HTTP
 * control API directly (no `toxiproxy-node-client` dep). The API surface
 * we need is small — create proxy, add toxic, remove toxic, delete proxy —
 * and a thin Effect wrapper keeps us from taking a 4-year-stale MIT
 * package. Rationale recorded in the design doc.
 *
 * Satisfies Goal 5 + AC8. Consumed by the Tier D runner.
 */
import type { Effect, Scope } from "effect";
import type { ToxicControlError } from "../errors.js";
import type { ToxicProfile } from "./profile.js";

export interface ToxiproxyConfig {
  /** Control-plane URL, e.g. `http://localhost:8474`. */
  readonly apiUrl: string;
}

/**
 * A live toxic attachment. Scoped: acquiring adds the toxic to the proxy,
 * releasing the scope removes it. Tier D properties acquire a
 * `ToxicHandle` inside `Effect.scoped` so a crashed property still cleans
 * up.
 */
export interface ToxicHandle {
  readonly name: string;
  readonly profile: ToxicProfile;
}

/**
 * A live proxy that sits between TestClient and the real server (or
 * between real client and TestServer). Acquiring the scope allocates an
 * ephemeral port and registers the proxy; releasing deletes it.
 */
export interface Proxy {
  /** Upstream (real server) address the proxy forwards to. */
  readonly upstream: string;
  /** Client-facing URL (`ws://127.0.0.1:<ephemeralPort>`). */
  readonly listenUrl: string;
  /** Attach a toxic inside a Scope; removed on release. */
  readonly withToxic: (
    profile: ToxicProfile,
  ) => Effect.Effect<ToxicHandle, ToxicControlError, Scope.Scope>;
}

export interface ToxiproxyClient {
  /** Create a scoped proxy; teardown on release. */
  readonly proxy: (opts: {
    readonly name: string;
    readonly upstream: string;
  }) => Effect.Effect<Proxy, ToxicControlError, Scope.Scope>;
  /** Probe: control plane reachable. */
  readonly ping: Effect.Effect<void, ToxicControlError>;
}

export function makeToxiproxyClient(
  config: ToxiproxyConfig,
): Effect.Effect<ToxiproxyClient, ToxicControlError> {
  throw new Error("not implemented");
}
