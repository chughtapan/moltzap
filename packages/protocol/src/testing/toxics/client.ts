/**
 * Toxiproxy control-plane client.
 *
 * Per design doc §5 "Dependency choices", we talk to Toxiproxy's HTTP
 * control API directly (no `toxiproxy-node-client` dep). The API surface
 * we need is small — create proxy, add toxic, remove toxic, delete proxy —
 * and a thin Effect wrapper keeps us from taking a 4-year-stale MIT
 * package.
 *
 * Satisfies Goal 5 + AC8. Consumed by the Tier D runner.
 */
import { Effect, Scope } from "effect";
import { ToxicControlError } from "../errors.js";
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

interface RawProxy {
  readonly name: string;
  readonly listen: string;
  readonly upstream: string;
  readonly enabled?: boolean;
}

function httpJson(
  op: "create-proxy" | "delete-proxy" | "add-toxic" | "remove-toxic",
  url: string,
  init?: RequestInit,
): Effect.Effect<unknown, ToxicControlError> {
  return Effect.tryPromise({
    // #ignore-sloppy-code-next-line[async-keyword]: fetch is a Promise-returning Web API; Effect.tryPromise captures the rejection path
    try: async () => {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (init?.headers !== undefined) {
        new Headers(init.headers).forEach((v, k) => headers.set(k, v));
      }
      const res = await fetch(url, { ...init, headers });
      const body = await res.text();
      if (res.status < 200 || res.status >= 300) {
        throw new ToxicControlError({ op, status: res.status, body });
      }
      return body.length === 0 ? null : JSON.parse(body);
    },
    catch: (err) => {
      if (err instanceof ToxicControlError) return err;
      return new ToxicControlError({
        op,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });
}

function profileToAttributes(profile: ToxicProfile): {
  readonly type: string;
  readonly attributes: Record<string, number>;
} {
  switch (profile._tag) {
    case "latency":
      return {
        type: "latency",
        attributes: { latency: profile.latencyMs, jitter: profile.jitterMs },
      };
    case "bandwidth":
      return {
        type: "bandwidth",
        attributes: { rate: profile.rateKbps },
      };
    case "slicer":
      return {
        type: "slicer",
        attributes: {
          average_size: profile.averageSize,
          size_variation: 0,
          delay: profile.delayUs,
        },
      };
    case "reset_peer":
      return {
        type: "reset_peer",
        attributes: { timeout: profile.timeoutMs },
      };
    case "timeout":
      return {
        type: "timeout",
        attributes: { timeout: profile.timeoutMs },
      };
    case "slow_close":
      return {
        type: "slow_close",
        attributes: { delay: profile.delayMs },
      };
    default: {
      const _exhaustive: never = profile;
      throw new Error(
        `profileToAttributes: unexpected toxic ${String(_exhaustive)}`,
      );
    }
  }
}

export function makeToxiproxyClient(
  config: ToxiproxyConfig,
): Effect.Effect<ToxiproxyClient, ToxicControlError> {
  const base = config.apiUrl.replace(/\/$/, "");

  const ping: Effect.Effect<void, ToxicControlError> = httpJson(
    "create-proxy",
    `${base}/version`,
    { method: "GET" },
  ).pipe(Effect.asVoid);

  const proxy: ToxiproxyClient["proxy"] = (opts) =>
    Effect.acquireRelease(
      httpJson("create-proxy", `${base}/proxies`, {
        method: "POST",
        body: JSON.stringify({
          name: opts.name,
          upstream: opts.upstream,
          listen: "127.0.0.1:0",
          enabled: true,
        }),
      }).pipe(
        Effect.map((body) => {
          const raw = body as RawProxy;
          const listen = raw.listen.startsWith("ws://")
            ? raw.listen
            : `ws://${raw.listen}`;
          const proxyHandle: Proxy = {
            upstream: raw.upstream,
            listenUrl: listen,
            withToxic: (profile) =>
              Effect.acquireRelease(
                Effect.suspend(() => {
                  const { type, attributes } = profileToAttributes(profile);
                  const toxicName = `${profile._tag}-${Math.floor(Math.random() * 1e9)}`;
                  return httpJson(
                    "add-toxic",
                    `${base}/proxies/${encodeURIComponent(opts.name)}/toxics`,
                    {
                      method: "POST",
                      body: JSON.stringify({
                        name: toxicName,
                        type,
                        stream: "downstream",
                        toxicity: 1.0,
                        attributes,
                      }),
                    },
                  ).pipe(
                    Effect.map(
                      (): ToxicHandle => ({ name: toxicName, profile }),
                    ),
                  );
                }),
                (handle) =>
                  httpJson(
                    "remove-toxic",
                    `${base}/proxies/${encodeURIComponent(opts.name)}/toxics/${encodeURIComponent(handle.name)}`,
                    { method: "DELETE" },
                  ).pipe(
                    Effect.orElseSucceed(() => null),
                    Effect.asVoid,
                  ),
              ),
          };
          return proxyHandle;
        }),
      ),
      () =>
        httpJson(
          "delete-proxy",
          `${base}/proxies/${encodeURIComponent(opts.name)}`,
          { method: "DELETE" },
        ).pipe(
          Effect.orElseSucceed(() => null),
          Effect.asVoid,
        ),
    );

  return Effect.succeed({ proxy, ping });
}
