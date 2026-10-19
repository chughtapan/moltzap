/** @file Startup recovery and atomic Registry-to-store identity binding tests. */

import { live as it } from "@effect/vitest";
import {
  AgentCard,
  AgentSigningAuthority,
  Ed25519PublicKey,
} from "@moltzap/identity";
import {
  Registry,
  RegistryConnectionError,
  type RegistryRegisterResult,
} from "@moltzap/identity/registry";
import { type Context, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  type ManagementRegisterRequest,
  managementRegisterRequestSchema,
} from "../../endpoint/mcp/owner-tools.js";
import { EndpointStoreError, type IdentityBinding } from "../../store/index.js";
import {
  type DaemonBootstrap,
  DaemonConfigurationError,
} from "../bootstrap.js";
import {
  DaemonRegistrationPersistenceError,
  DaemonRegistrationRepresentationError,
  type DaemonRegistrationStore,
  DaemonRegistrationUpstreamError,
  readDaemonRegistrationState,
  registerDaemonIdentity,
  requireAdmission,
} from "./index.js";

const privateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHsbmQdBGQFs1eXLEWxKDblLeG//B9s8WmWEMQHvw4f8
-----END PRIVATE KEY-----`;
const registryKeyRepresentation = {
  crv: "Ed25519",
  kty: "OKP",
  x: "kVwONy_B4JUCO89NL3G63Ha2Bto1o7Niy1qDNNzB5yo",
} as const;
const cardRepresentation = {
  payload:
    "eyJhZ2VudElkIjoiYWd0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVEiLCJhZ2VudE5hbWUiOiJhZ2VudC1vbmUiLCJpc3N1ZWRBdCI6IjIwMjYtMDgtMTNUMDA6MDA6MDFaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi4xMDA2LjEiLCJwcmluY2lwYWxJZCI6InBybl9Dd3NMQ3dzTEN3c0xDd3NMQ3dzTEN3IiwicHVibGljS2V5Ijp7ImNydiI6IkVkMjU1MTkiLCJrdHkiOiJPS1AiLCJ4IjoiM3JVSjkydElQMERFNGVrbUVUMXptZTZTSVdUcDVHMEtpRjNaakwtQW9LZyJ9fQ",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6NlpCdHpOeHRaUzRaYlNENlNuLVJXekpfYlhncmxHWC1RVU1qUE9BMWluWSIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "w7HcWwseXqJsn6FZeDwDATar3D4WF1v5IltDgrYwU4N1LzU41mvWe8OxnhUdOtKH26a2ZqPTA8eX2YafBSs8DA",
    },
  ],
};

interface MemoryStore {
  readonly store: DaemonRegistrationStore;
  readonly binding: Ref.Ref<IdentityBinding | undefined>;
  readonly failWrites: Ref.Ref<boolean>;
}

/**
 * Bind `candidate` as the production store's identity write does: insert when
 * unbound, report an identical binding as existing, and refuse a different
 * one as a conflict.
 */
const bindMemoryIdentity = (
  binding: Ref.Ref<IdentityBinding | undefined>,
  candidate: IdentityBinding,
) =>
  Ref.get(binding).pipe(
    Effect.flatMap((existing) => {
      if (existing === undefined) {
        return Ref.set(binding, candidate).pipe(Effect.as("inserted" as const));
      }
      return existing.agentId === candidate.agentId &&
        Buffer.compare(
          existing.canonicalAgentCard,
          candidate.canonicalAgentCard,
        ) === 0
        ? Effect.succeed("existing" as const)
        : Effect.fail(new EndpointStoreError({ reason: "conflict" }));
    }),
  );

const makeMemoryStore = Effect.gen(function* () {
  const binding = yield* Ref.make<IdentityBinding | undefined>(undefined);
  const failWrites = yield* Ref.make(false);
  const store: DaemonRegistrationStore = {
    readIdentity: () => Ref.get(binding),
    bindIdentity: (candidate) =>
      Ref.get(failWrites).pipe(
        Effect.flatMap((shouldFail) =>
          shouldFail
            ? Effect.fail(new EndpointStoreError({ reason: "persistence" }))
            : bindMemoryIdentity(binding, candidate),
        ),
      ),
  };
  return { store, binding, failWrites } satisfies MemoryStore;
});

const makeFixture = Effect.gen(function* () {
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeyRepresentation,
  );
  const encodedCard =
    yield* Schema.decodeUnknown(AgentCard)(cardRepresentation);
  const agentCard = yield* AgentCard.verify({
    agentCard: encodedCard,
    registrySignerPublicKey,
  });
  const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey),
  );
  const bootstrap: DaemonBootstrap = Object.freeze({
    configuration: {
      stateDirectory: "/var/lib/moltzapd",
      mcpPort: 4319,
      registryOrigin: new URL("https://registry.example"),
      registrySignerPublicKey,
      routerOrigin: new URL("https://router.example"),
      agentPrivateKeyFile: Redacted.make("/run/secrets/agent.pem"),
      admissionCredentialFile: Redacted.make("/run/secrets/admission"),
    },
    signingAuthority,
    agentPublicKey: AgentSigningAuthority.publicKey(signingAuthority),
    admissionCredential: Effect.succeed(Redacted.make("bootstrap-token=")),
  });
  const request = yield* Schema.decodeUnknown(managementRegisterRequestSchema)({
    operationId: "opn_AAAAAAAAAAAAAAAAAAAAAA",
    principalId: "prn_CwsLCwsLCwsLCwsLCwsLCw",
    agentName: "agent-one",
  });
  return { agentCard, bootstrap, request };
});

const registryLayer = (input: {
  readonly result: RegistryRegisterResult;
  readonly calls: Ref.Ref<readonly ManagementRegisterRequest[]>;
  readonly fail?: boolean;
}) => {
  const service: Context.Tag.Service<typeof Registry> = {
    register: (call) =>
      Ref.update(input.calls, (calls) => [
        ...calls,
        {
          operationId: call.request.operationId,
          principalId: call.request.principalId,
          agentName: call.request.agentName,
        },
      ]).pipe(
        Effect.flatMap(() =>
          input.fail === true
            ? Effect.fail(new RegistryConnectionError())
            : Effect.succeed(input.result),
        ),
      ),
    lookup: () => Effect.succeed({ kind: "not_found" }),
    list: () =>
      Effect.succeed({ kind: "page", agentCards: [], hasMore: false }),
  };
  return Layer.succeed(Registry, service);
};

const provideRegistry = <A, E>(
  effect: Effect.Effect<A, E, Registry>,
  result: RegistryRegisterResult,
  calls: Ref.Ref<readonly ManagementRegisterRequest[]>,
  fail = false,
) => Effect.provide(effect, registryLayer({ result, calls, fail }));

const registersAndActivates = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const calls = yield* Ref.make<readonly ManagementRegisterRequest[]>([]);
    const before = yield* readDaemonRegistrationState({
      store: memory.store,
      bootstrap: fixture.bootstrap,
    });
    expect(before).toEqual({ kind: "unregistered" });
    const result = yield* provideRegistry(
      registerDaemonIdentity({
        request: fixture.request,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      { kind: "registered", agentCard: fixture.agentCard },
      calls,
    );
    expect(result).toEqual({
      kind: "registered",
      agentCard: fixture.agentCard,
    });
    const after = yield* readDaemonRegistrationState({
      store: memory.store,
      bootstrap: fixture.bootstrap,
    });
    expect(after).toEqual({ kind: "active", agentCard: fixture.agentCard });
  });

const retriesAfterLocalPersistenceFailure = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const calls = yield* Ref.make<readonly ManagementRegisterRequest[]>([]);
    const result = {
      kind: "registered" as const,
      agentCard: fixture.agentCard,
    };
    yield* Ref.set(memory.failWrites, true);
    const firstFailure = yield* Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: fixture.request,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        result,
        calls,
      ),
    );
    expect(firstFailure).toBeInstanceOf(DaemonRegistrationPersistenceError);
    expect(yield* Ref.get(memory.binding)).toBeUndefined();

    yield* Ref.set(memory.failWrites, false);
    const recovered = yield* provideRegistry(
      registerDaemonIdentity({
        request: fixture.request,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      result,
      calls,
    );
    expect(recovered).toEqual(result);
    expect(yield* Ref.get(calls)).toEqual([fixture.request, fixture.request]);
  });

const keepsRegistryRefusalsUncommitted = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const calls = yield* Ref.make<readonly ManagementRegisterRequest[]>([]);
    const result = yield* provideRegistry(
      registerDaemonIdentity({
        request: fixture.request,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      { kind: "name_taken" },
      calls,
    );
    expect(result).toEqual({ kind: "name_taken" });
    expect(yield* Ref.get(memory.binding)).toBeUndefined();
  });

const closesUpstreamAndRepresentationFailures = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const calls = yield* Ref.make<readonly ManagementRegisterRequest[]>([]);
    const upstream = yield* Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: fixture.request,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        { kind: "name_taken" },
        calls,
        true,
      ),
    );
    expect(upstream).toBeInstanceOf(DaemonRegistrationUpstreamError);

    const mismatchedRequest = Schema.decodeUnknownSync(
      managementRegisterRequestSchema,
    )({ ...fixture.request, agentName: "agent-two" });
    const representation = yield* Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: mismatchedRequest,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        { kind: "registered", agentCard: fixture.agentCard },
        calls,
      ),
    );
    expect(representation).toBeInstanceOf(
      DaemonRegistrationRepresentationError,
    );
  });

const rejectsCorruptPreexistingBinding = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    yield* Ref.set(memory.binding, {
      agentId: fixture.agentCard.agentId,
      canonicalAgentCard: new TextEncoder().encode("{}"),
    });
    const error = yield* Effect.flip(
      readDaemonRegistrationState({
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
    );
    expect(error).toBeInstanceOf(DaemonRegistrationRepresentationError);
  });

const missingAdmission = (reads: Ref.Ref<number>) =>
  Ref.update(reads, (count) => count + 1).pipe(
    Effect.zipRight(
      Effect.fail(
        new DaemonConfigurationError({
          reason: "admission-credential-file",
          message: "admission credential file is required",
        }),
      ),
    ),
  );

const unregisteredStartupFailsClosed = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const reads = yield* Ref.make(0);
    const error = yield* Effect.flip(
      requireAdmission(
        { kind: "unregistered" },
        {
          ...fixture.bootstrap,
          admissionCredential: missingAdmission(reads),
        },
      ),
    );
    expect(error).toEqual(
      new DaemonConfigurationError({
        reason: "admission-credential-file",
        message: "admission credential file is required",
      }),
    );
    expect(yield* Ref.get(reads)).toBe(1);
  });

const unregisteredStartupLoadsCredential = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    expect(
      yield* requireAdmission({ kind: "unregistered" }, fixture.bootstrap),
    ).toBeUndefined();
  });

const registeredStartupSkipsCredential = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const reads = yield* Ref.make(0);
    expect(
      yield* requireAdmission(
        { kind: "active", agentCard: fixture.agentCard },
        {
          ...fixture.bootstrap,
          admissionCredential: missingAdmission(reads),
        },
      ),
    ).toBeUndefined();
    expect(yield* Ref.get(reads)).toBe(0);
  });

const startupSurfacesStoreFailure = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const store: DaemonRegistrationStore = {
      readIdentity: () =>
        Effect.fail(new EndpointStoreError({ reason: "persistence" })),
      bindIdentity: () =>
        Effect.fail(new EndpointStoreError({ reason: "persistence" })),
    };
    const error = yield* Effect.flip(
      readDaemonRegistrationState({
        store,
        bootstrap: fixture.bootstrap,
      }),
    );
    expect(error).toBeInstanceOf(DaemonRegistrationPersistenceError);
  });

const presentsLoadedCredentialToRegistry = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const presented = yield* Ref.make<readonly string[]>([]);
    const service: Context.Tag.Service<typeof Registry> = {
      register: (call) =>
        Ref.update(presented, (credentials) => [
          ...credentials,
          Redacted.value(call.admissionCredential),
        ]).pipe(
          Effect.as({
            kind: "registered" as const,
            agentCard: fixture.agentCard,
          }),
        ),
      lookup: () => Effect.succeed({ kind: "not_found" }),
      list: () =>
        Effect.succeed({ kind: "page", agentCards: [], hasMore: false }),
    };
    yield* Effect.provide(
      registerDaemonIdentity({
        request: fixture.request,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      Layer.succeed(Registry, service),
    );
    expect(yield* Ref.get(presented)).toEqual(["bootstrap-token="]);
  });

const refusesRegistrationWithoutCredential = () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    const memory = yield* makeMemoryStore;
    const calls = yield* Ref.make<readonly ManagementRegisterRequest[]>([]);
    const reads = yield* Ref.make(0);
    const error = yield* Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: fixture.request,
          store: memory.store,
          bootstrap: {
            ...fixture.bootstrap,
            admissionCredential: missingAdmission(reads),
          },
        }),
        { kind: "registered", agentCard: fixture.agentCard },
        calls,
      ),
    );
    expect(error).toEqual(
      new DaemonConfigurationError({
        reason: "admission-credential-file",
        message: "admission credential file is required",
      }),
    );
    expect(yield* Ref.get(calls)).toEqual([]);
    expect(yield* Ref.get(memory.binding)).toBeUndefined();
  });

// @agent-code-guard/regression-only: these examples pin that only an unregistered daemon needs the admission credential.
describe("daemon admission credential", () => {
  it(
    "fails an unregistered startup closed without the credential",
    unregisteredStartupFailsClosed,
  );
  it(
    "loads the credential for an unregistered startup",
    unregisteredStartupLoadsCredential,
  );
  it(
    "starts a registered daemon without reading the credential",
    registeredStartupSkipsCredential,
  );
  it(
    "presents the loaded credential to Registry registration",
    presentsLoadedCredentialToRegistry,
  );
  it(
    "refuses registration without calling Registry when the credential is unavailable",
    refusesRegistrationWithoutCredential,
  );
});

// @agent-code-guard/regression-only: these examples pin crash recovery through Registry OperationId and one durable identity binding.
describe("daemon registration", () => {
  it(
    "moves from unregistered to active only after local binding",
    registersAndActivates,
  );
  it(
    "retries the same Registry request after local persistence failure",
    retriesAfterLocalPersistenceFailure,
  );
  it(
    "does not bind Registry domain refusals",
    keepsRegistryRefusalsUncommitted,
  );
  it(
    "closes upstream and cross-field representation failures",
    closesUpstreamAndRepresentationFailures,
  );
  it(
    "fails closed on a corrupt preexisting binding",
    rejectsCorruptPreexistingBinding,
  );
  it(
    "surfaces an unreadable identity binding as a persistence failure",
    startupSurfacesStoreFailure,
  );
});
