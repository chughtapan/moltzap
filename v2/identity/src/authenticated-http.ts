import type { HttpClientRequest, HttpServerRequest } from "@effect/platform";
import { Context, Deferred, Effect, Layer, Option, Ref, Schema } from "effect";
import type { AgentSigningAuthority } from "./agent-signing-authority.js";
import type { VerifiedAgentCard } from "./agent-card.js";
import {
  AuthenticationFailedError,
  MalformedRequestError,
  OverloadedError,
  UnavailableError,
  VersionMismatchError,
} from "./http-errors.js";
import {
  signHttpRequest,
  verifyHttpRequestSignature,
} from "./http-signature.js";
import { decodeCanonicalJson, encodeCanonicalJson } from "./identity-json.js";
import { AgentId, type AgentId as AgentIdValue } from "./identity-values.js";
import {
  makeVerifiedAgentRequest,
  type VerifiedAgentRequest,
} from "./registered-agent-request.js";
import { Registry } from "./registry.js";
import type { RegistryLookupResult } from "./registry/operations.js";
import { AgentSigningError } from "./signing-errors.js";
import { MOLTZAP_VERSION } from "./version.js";

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  });

const registeredAgentBody = exactStruct({
  callerAgentId: AgentId,
  request: Schema.Unknown,
});

type AuthenticationError =
  | MalformedRequestError
  | AuthenticationFailedError
  | VersionMismatchError
  | OverloadedError
  | UnavailableError;

interface AuthenticatedHttpService {
  readonly verifyAgentRequest: (input: {
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
    readonly bodyBytes: Uint8Array;
  }) => Effect.Effect<VerifiedAgentRequest, AuthenticationError>;
}

type CardCache = Readonly<{
  readonly cards: ReadonlyMap<AgentIdValue, VerifiedAgentCard>;
  readonly recency: readonly AgentIdValue[];
  readonly pending: ReadonlyMap<
    AgentIdValue,
    Deferred.Deferred<VerifiedAgentCard, CardResolutionError>
  >;
}>;

type CardResolutionError =
  | AuthenticationFailedError
  | OverloadedError
  | UnavailableError;

type RegistryLookup = (request: {
  readonly agentId: AgentIdValue;
}) => Effect.Effect<RegistryLookupResult, unknown>;

type CacheAccess =
  | Readonly<{ readonly kind: "cached"; readonly card: VerifiedAgentCard }>
  | Readonly<{
      readonly kind: "join";
      readonly deferred: Deferred.Deferred<
        VerifiedAgentCard,
        CardResolutionError
      >;
    }>
  | Readonly<{
      readonly kind: "lead";
      readonly deferred: Deferred.Deferred<
        VerifiedAgentCard,
        CardResolutionError
      >;
    }>;

type RestoreInterruptibility = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

interface CardResolutionSettings {
  readonly cacheCapacity: number;
  readonly lookupConcurrencyLimit: number;
}

interface CardResolverDependencies {
  readonly cache: Ref.Ref<CardCache>;
  readonly cacheCapacity: number;
  readonly lookup: RegistryLookup;
  readonly lookupPermits: Effect.Semaphore;
}

const beginCardResolution = (
  cache: Ref.Ref<CardCache>,
  agentId: AgentIdValue,
  candidate: Deferred.Deferred<VerifiedAgentCard, CardResolutionError>,
): Effect.Effect<CacheAccess> =>
  Ref.modify(cache, (current): readonly [CacheAccess, CardCache] => {
    const card = current.cards.get(agentId);
    if (card !== undefined) {
      return [
        { kind: "cached", card },
        {
          ...current,
          recency: Object.freeze([
            ...current.recency.filter((value) => value !== agentId),
            agentId,
          ]),
        },
      ] as const;
    }
    const pending = current.pending.get(agentId);
    if (pending !== undefined) {
      return [{ kind: "join", deferred: pending }, current] as const;
    }
    return [
      { kind: "lead", deferred: candidate },
      {
        ...current,
        pending: new Map(current.pending).set(agentId, candidate),
      },
    ] as const;
  });

const removePendingResolution = (
  cache: Ref.Ref<CardCache>,
  agentId: AgentIdValue,
): Effect.Effect<void> =>
  Ref.update(cache, (current) => {
    const pending = new Map(current.pending);
    pending.delete(agentId);
    return { ...current, pending };
  });

const retainResolvedCard = (
  cache: Ref.Ref<CardCache>,
  input: {
    readonly capacity: number;
    readonly agentId: AgentIdValue;
    readonly card: VerifiedAgentCard;
  },
): Effect.Effect<void> =>
  Ref.update(cache, (current) => {
    const pending = new Map(current.pending);
    pending.delete(input.agentId);
    const cards = new Map(current.cards);
    const recency = [
      ...current.recency.filter((value) => value !== input.agentId),
      input.agentId,
    ];
    cards.set(input.agentId, input.card);
    while (recency.length > input.capacity) {
      const evicted = recency.shift();
      if (evicted !== undefined) {
        cards.delete(evicted);
      }
    }
    return {
      cards,
      recency: Object.freeze(recency),
      pending,
    };
  });

type NonceClaim = "claimed" | "replayed" | "full";

interface NonceClaimInput {
  readonly capacity: number;
  readonly nonce: string;
  readonly expires: number;
  readonly now: number;
}

const updateNonces = (
  current: ReadonlyMap<string, number>,
  input: NonceClaimInput,
): readonly [NonceClaim, ReadonlyMap<string, number>] => {
  const live = new Map<string, number>();
  for (const [retainedNonce, retainedExpiry] of current) {
    if (retainedExpiry >= input.now) {
      live.set(retainedNonce, retainedExpiry);
    }
  }
  if (live.has(input.nonce)) {
    return ["replayed", live];
  }
  if (live.size >= input.capacity) {
    return ["full", live];
  }
  live.set(input.nonce, input.expires);
  return ["claimed", live];
};

const claimNonce = (
  nonces: Ref.Ref<ReadonlyMap<string, number>>,
  input: NonceClaimInput,
): Effect.Effect<NonceClaim> =>
  Ref.modify(nonces, (current) => updateNonces(current, input));

const signAgentRequest = (input: {
  readonly httpRequest: HttpClientRequest.HttpClientRequest;
  readonly callerAgentId: AgentIdValue;
  readonly encodedRequest: unknown;
  readonly signingAuthority: AgentSigningAuthority;
}): Effect.Effect<HttpClientRequest.HttpClientRequest, AgentSigningError> =>
  encodeCanonicalJson({
    callerAgentId: input.callerAgentId,
    request: input.encodedRequest,
  }).pipe(
    Effect.catchTag("CanonicalJsonError", () =>
      Effect.fail(new AgentSigningError()),
    ),
    Effect.flatMap((bodyBytes) =>
      signHttpRequest({
        httpRequest: input.httpRequest,
        bodyBytes,
        signingAuthority: input.signingAuthority,
        profile: "normal",
      }),
    ),
  );

const resolveLookupAttempt = (
  attempted: Option.Option<RegistryLookupResult>,
): Effect.Effect<
  VerifiedAgentCard,
  OverloadedError | AuthenticationFailedError
> => {
  if (Option.isNone(attempted)) {
    return Effect.fail(new OverloadedError());
  }
  return attempted.value.kind === "found"
    ? Effect.succeed(attempted.value.agentCard)
    : Effect.fail(new AuthenticationFailedError());
};

const lookupCard = (
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> =>
  dependencies.lookupPermits
    .withPermitsIfAvailable(1)(
      dependencies.lookup({ agentId }).pipe(
        // Registry failures have one recovery at this boundary: the caller
        // identity cannot currently be resolved.
        // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- collapse the Registry client surface into the approved boundary error
        Effect.mapError(() => new UnavailableError()),
      ),
    )
    .pipe(Effect.flatMap(resolveLookupAttempt));

const runLeadingResolution = (
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
  deferred: Deferred.Deferred<VerifiedAgentCard, CardResolutionError>,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> =>
  lookupCard(dependencies, agentId).pipe(
    Effect.tap((card) =>
      retainResolvedCard(dependencies.cache, {
        capacity: dependencies.cacheCapacity,
        agentId,
        card,
      }),
    ),
    Effect.onExit((exit) =>
      removePendingResolution(dependencies.cache, agentId).pipe(
        Effect.zipRight(Deferred.done(deferred, exit)),
      ),
    ),
  );

const resolveCacheAccess = (
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
  access: CacheAccess,
  restoreInterruptibility: RestoreInterruptibility,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> => {
  // CacheAccess is a closed discriminated union.
  // eslint-disable-next-line default-case -- the switch is exhaustive
  switch (access.kind) {
    case "cached":
      return Effect.succeed(access.card);
    case "join":
      return restoreInterruptibility(Deferred.await(access.deferred));
    case "lead":
      return Effect.forkDaemon(
        runLeadingResolution(dependencies, agentId, access.deferred).pipe(
          Effect.interruptible,
        ),
      ).pipe(
        Effect.zipRight(
          restoreInterruptibility(Deferred.await(access.deferred)),
        ),
      );
  }
};

const resolveCard = (
  dependencies: CardResolverDependencies,
  agentId: AgentIdValue,
  restoreInterruptibility: RestoreInterruptibility,
): Effect.Effect<VerifiedAgentCard, CardResolutionError> =>
  Effect.gen(function* () {
    const candidate = yield* Deferred.make<
      VerifiedAgentCard,
      CardResolutionError
    >();
    const access = yield* beginCardResolution(
      dependencies.cache,
      agentId,
      candidate,
    );
    return yield* resolveCacheAccess(
      dependencies,
      agentId,
      access,
      restoreInterruptibility,
    );
  });

const makeCardResolver = (
  settings: CardResolutionSettings,
  lookup: RegistryLookup,
) =>
  Effect.gen(function* () {
    const cache = yield* Ref.make<CardCache>({
      cards: new Map(),
      recency: Object.freeze([]),
      pending: new Map(),
    });
    const lookupPermits = yield* Effect.makeSemaphore(
      settings.lookupConcurrencyLimit,
    );
    const dependencies: CardResolverDependencies = {
      cache,
      cacheCapacity: settings.cacheCapacity,
      lookup,
      lookupPermits,
    };
    return (
      agentId: AgentIdValue,
    ): Effect.Effect<VerifiedAgentCard, CardResolutionError> =>
      Effect.uninterruptibleMask((restoreInterruptibility) =>
        resolveCard(dependencies, agentId, restoreInterruptibility),
      );
  });

type CardResolver = Effect.Effect.Success<ReturnType<typeof makeCardResolver>>;

const verifyRequest = (
  input: {
    readonly bodyBytes: Uint8Array;
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
  },
  dependencies: {
    readonly liveNonceCapacity: number;
    readonly nonces: Ref.Ref<ReadonlyMap<string, number>>;
    readonly resolveCard: CardResolver;
  },
): Effect.Effect<VerifiedAgentRequest, AuthenticationError> =>
  Effect.gen(function* () {
    const body = yield* decodeCanonicalJson(
      registeredAgentBody,
      Uint8Array.from(input.bodyBytes),
    ).pipe(
      Effect.catchTag("CanonicalJsonError", () =>
        Effect.fail(new MalformedRequestError()),
      ),
    );
    const agentCard = yield* dependencies.resolveCard(body.callerAgentId);
    const signature = yield* verifyHttpRequestSignature({
      httpRequest: input.httpRequest,
      bodyBytes: input.bodyBytes,
      publicKey: agentCard.publicKey,
      profile: "normal",
    });
    const claim = yield* claimNonce(dependencies.nonces, {
      capacity: dependencies.liveNonceCapacity,
      nonce: signature.nonce,
      expires: signature.expires,
      now: signature.verifiedAt,
    });
    if (claim === "replayed") {
      return yield* new AuthenticationFailedError();
    }
    if (claim === "full") {
      return yield* new OverloadedError();
    }
    if (input.httpRequest.headers["moltzap-version"] !== MOLTZAP_VERSION) {
      return yield* new VersionMismatchError();
    }
    return makeVerifiedAgentRequest({
      callerAgentId: body.callerAgentId,
      agentCard,
      request: body.request,
    });
  });

const makeService = (input: {
  readonly liveNonceCapacity: number;
  readonly agentCardCacheCapacity: number;
  readonly registryLookupConcurrencyLimit: number;
}): Effect.Effect<AuthenticatedHttpService, never, Registry> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const nonces = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const resolveCard = yield* makeCardResolver(
      {
        cacheCapacity: input.agentCardCacheCapacity,
        lookupConcurrencyLimit: input.registryLookupConcurrencyLimit,
      },
      (request) => registry.lookup(request),
    );
    return {
      verifyAgentRequest: (request) =>
        verifyRequest(request, {
          liveNonceCapacity: input.liveNonceCapacity,
          nonces,
          resolveCard,
        }),
    };
  });

/** Registered-agent request signing and verification. */
export class AuthenticatedHttp extends Context.Tag(
  "@moltzap/v2-identity/AuthenticatedHttp",
)<AuthenticatedHttp, AuthenticatedHttpService>() {
  static readonly signAgentRequest = signAgentRequest;

  static readonly verifyAgentRequest: (input: {
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
    readonly bodyBytes: Uint8Array;
  }) => Effect.Effect<
    VerifiedAgentRequest,
    AuthenticationError,
    AuthenticatedHttp
  > = Effect.serviceFunctionEffect(
    AuthenticatedHttp,
    (service) => service.verifyAgentRequest,
  );

  static readonly layer = (input: {
    readonly liveNonceCapacity: number;
    readonly agentCardCacheCapacity: number;
    readonly registryLookupConcurrencyLimit: number;
  }): Layer.Layer<AuthenticatedHttp, never, Registry> =>
    Layer.effect(AuthenticatedHttp, makeService({ ...input }));
}
