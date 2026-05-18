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
const TOXIC_NAME_SUFFIX_LEN = 8;

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
export interface ToxiproxyProxy {
  /** Upstream (real server) address the proxy forwards to. */
  readonly upstream: string;
  /** Client-facing URL (`ws://127.0.0.1:&lt;ephemeralPort>`). */
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
  }) => Effect.Effect<ToxiproxyProxy, ToxicControlError, Scope.Scope>;
  /** Probe: control plane reachable. */
  readonly ping: Effect.Effect<void, ToxicControlError>;
}

function toxicNameSuffix(): string {
  return globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, TOXIC_NAME_SUFFIX_LEN);
}

function removeToxicFinalizer(
  base: string,
  proxyName: string,
  toxicName: string,
): () => Effect.Effect<void, never> {
  return () =>
    httpJson(
      "remove-toxic",
      `${base}/proxies/${encodeURIComponent(proxyName)}/toxics/${encodeURIComponent(toxicName)}`,
      { method: "DELETE" },
    ).pipe(
      Effect.orElseSucceed(() => null),
      Effect.asVoid,
    );
}

interface RawProxy {
  readonly name: string;
  readonly listen: string;
  readonly upstream: string;
  readonly enabled?: boolean;
}

type HttpMethod = "DELETE" | "GET" | "POST";
type ToxicOperation =
  | "create-proxy"
  | "delete-proxy"
  | "add-toxic"
  | "remove-toxic";

interface HttpJsonInit {
  readonly method?: HttpMethod;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function requestForMethod(
  method: HttpMethod,
  url: string,
): HttpClientRequest.HttpClientRequest {
  if (method === "POST") return HttpClientRequest.post(url);
  if (method === "DELETE") return HttpClientRequest.del(url);
  return HttpClientRequest.get(url);
}

function httpJson(
  op: ToxicOperation,
  url: string,
  init?: HttpJsonInit,
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
    const request = jsonRequest(url, init);
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toToxicError));
    const body = yield* response.text.pipe(Effect.mapError(toToxicError));
    yield* failOnBadStatus(op, response.status, body);
    return yield* parseJsonBody(body, toToxicError);
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

function jsonRequest(
  url: string,
  init: HttpJsonInit | undefined,
): HttpClientRequest.HttpClientRequest {
  const method = init?.method ?? "GET";
  const baseRequest = requestForMethod(method, url);
  const requestWithHeaders = HttpClientRequest.setHeaders(baseRequest, {
    "Content-Type": "application/json",
    ...init?.headers,
  });
  return init?.body === undefined
    ? requestWithHeaders
    : HttpClientRequest.bodyUnsafeJson(requestWithHeaders, init.body);
}

function failOnBadStatus(
  op: ToxicOperation,
  status: number,
  body: string,
): Effect.Effect<void, ToxicControlError> {
  return status >= HTTP_SUCCESS_MIN && status < HTTP_REDIRECT_MIN
    ? Effect.void
    : Effect.fail(new ToxicControlError({ op, status, body }));
}

function parseJsonBody(
  body: string,
  toToxicError: (err: unknown) => ToxicControlError,
): Effect.Effect<unknown, ToxicControlError> {
  return body.length === 0
    ? Effect.succeed(null)
    : Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: toToxicError,
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
  return Effect.succeed({
    proxy: (opts) => createProxy(base, opts),
    ping: pingToxiproxy(base),
  });
}

function pingToxiproxy(base: string): Effect.Effect<void, ToxicControlError> {
  return httpJson("create-proxy", `${base}/version`, { method: "GET" }).pipe(
    Effect.asVoid,
  );
}

function createProxy(
  base: string,
  opts: Parameters<ToxiproxyClient["proxy"]>[0],
): ReturnType<ToxiproxyClient["proxy"]> {
  return Effect.gen(function* () {
    const raw = (yield* httpJson("create-proxy", `${base}/proxies`, {
      method: "POST",
      body: proxyBody(opts),
    })) as RawProxy;
    yield* Effect.addFinalizer(deleteProxyFinalizer(base, opts.name));
    return {
      upstream: raw.upstream,
      listenUrl: proxyListenUrl(raw),
      withToxic: (profile) => addToxic(base, opts.name, profile),
    } satisfies ToxiproxyProxy;
  }).pipe(Effect.withSpan("makeToxiproxyClient"));
}

function proxyBody(opts: Parameters<ToxiproxyClient["proxy"]>[0]) {
  return {
    name: opts.name,
    upstream: opts.upstream,
    listen: "127.0.0.1:0",
    enabled: true,
  };
}

function proxyListenUrl(raw: RawProxy): string {
  return raw.listen.startsWith("ws://") ? raw.listen : `ws://${raw.listen}`;
}

function deleteProxyFinalizer(
  base: string,
  proxyName: string,
): () => Effect.Effect<void, never> {
  return () =>
    httpJson(
      "delete-proxy",
      `${base}/proxies/${encodeURIComponent(proxyName)}`,
      {
        method: "DELETE",
      },
    ).pipe(
      Effect.orElseSucceed(() => null),
      Effect.asVoid,
    );
}

function addToxic(
  base: string,
  proxyName: string,
  profile: ToxicProfile,
): ReturnType<ToxiproxyProxy["withToxic"]> {
  return Effect.gen(function* () {
    const { type, attributes } = profileToAttributes(profile);
    const toxicName = `${profile._tag}-${toxicNameSuffix()}`;
    yield* httpJson(
      "add-toxic",
      `${base}/proxies/${encodeURIComponent(proxyName)}/toxics`,
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
    yield* Effect.addFinalizer(
      removeToxicFinalizer(base, proxyName, toxicName),
    );
    return { name: toxicName, profile };
  });
}
