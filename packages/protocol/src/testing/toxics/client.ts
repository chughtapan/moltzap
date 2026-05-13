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
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { Effect, type Scope } from "effect";
import { ToxicControlError } from "./errors.js";
import type { ToxicProfile } from "./profile.js";

const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
const TOXIC_NAME_RANDOM_MAX = 1e9;

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
  init?: {
    readonly method?: "DELETE" | "GET" | "POST";
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Effect.Effect<unknown, ToxicControlError> {
  const toToxicError = (err: unknown): ToxicControlError => {
    if (err instanceof ToxicControlError) return err;
    return new ToxicControlError({
      op,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    });
  };
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const method = init?.method ?? "GET";
    const baseRequest =
      method === "POST"
        ? HttpClientRequest.post(url)
        : method === "DELETE"
          ? HttpClientRequest.del(url)
          : HttpClientRequest.get(url);
    const requestWithHeaders = HttpClientRequest.setHeaders(baseRequest, {
      "Content-Type": "application/json",
      ...init?.headers,
    });
    const request =
      init?.body === undefined
        ? requestWithHeaders
        : HttpClientRequest.bodyUnsafeJson(requestWithHeaders, init.body);
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toToxicError));
    const body = yield* response.text.pipe(Effect.mapError(toToxicError));
    if (
      response.status < HTTP_SUCCESS_MIN ||
      response.status >= HTTP_REDIRECT_MIN
    ) {
      return yield* Effect.fail(
        new ToxicControlError({ op, status: response.status, body }),
      );
    }
    if (body.length === 0) return null;
    return yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: toToxicError,
    });
  }).pipe(Effect.provide(FetchHttpClient.layer));
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
      return absurdToxicProfile(_exhaustive);
    }
  }
}

function absurdToxicProfile(profile: never): never {
  throw new Error(`profileToAttributes: unexpected toxic ${String(profile)}`);
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
    Effect.gen(function* () {
      const body = yield* httpJson("create-proxy", `${base}/proxies`, {
        method: "POST",
        body: {
          name: opts.name,
          upstream: opts.upstream,
          listen: "127.0.0.1:0",
          enabled: true,
        },
      });
      const raw = body as RawProxy;
      const listen = raw.listen.startsWith("ws://")
        ? raw.listen
        : `ws://${raw.listen}`;
      yield* Effect.addFinalizer(() =>
        httpJson(
          "delete-proxy",
          `${base}/proxies/${encodeURIComponent(opts.name)}`,
          { method: "DELETE" },
        ).pipe(
          Effect.orElseSucceed(() => null),
          Effect.asVoid,
        ),
      );
      return {
        upstream: raw.upstream,
        listenUrl: listen,
        withToxic: (profile) =>
          Effect.gen(function* () {
            const { type, attributes } = profileToAttributes(profile);
            const toxicName = `${profile._tag}-${Math.floor(Math.random() * TOXIC_NAME_RANDOM_MAX)}`;
            yield* httpJson(
              "add-toxic",
              `${base}/proxies/${encodeURIComponent(opts.name)}/toxics`,
              {
                method: "POST",
                body: {
                  name: toxicName,
                  type,
                  stream: "downstream",
                  toxicity: 1.0,
                  attributes,
                },
              },
            );
            yield* Effect.addFinalizer(() =>
              httpJson(
                "remove-toxic",
                `${base}/proxies/${encodeURIComponent(opts.name)}/toxics/${encodeURIComponent(toxicName)}`,
                { method: "DELETE" },
              ).pipe(
                Effect.orElseSucceed(() => null),
                Effect.asVoid,
              ),
            );
            return { name: toxicName, profile };
          }),
      } satisfies Proxy;
    }).pipe(Effect.withSpan("makeToxiproxyClient"));

  return Effect.succeed({ proxy, ping });
}
