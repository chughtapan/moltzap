/** @file Real-process version-mismatch round trips through the public clients. */
import {
  type FileSystem,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import {
  AgentName,
  AgentSigningAuthority,
  LIVE_WIRE_VERSIONS,
  PrincipalId,
} from "@moltzap/identity";
import { OperationId, Registry } from "@moltzap/identity/registry";
import { Duration, Effect, Layer, Redacted, Schema, type Scope } from "effect";
import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { Router } from "../../router.js";

interface Infrastructure {
  readonly routerOrigin: URL;
  readonly registryOrigin: URL;
  readonly registrySignerPublicKey: ReturnType<
    typeof AgentSigningAuthority.publicKey
  >;
}

const outsideWireWindow = "1900.101.0";

/** Re-signs the version field so rejection occurs after real authentication. */
const withOutsideWireVersion = (
  request: HttpClientRequest.HttpClientRequest,
  privateKeyPem: string,
) => {
  const url = new URL(request.url);
  const versioned = HttpClientRequest.setHeader(
    request,
    "sharness-version",
    outsideWireWindow,
  );
  const signatureInput = versioned.headers["signature-input"] ?? "";
  const signatureParameters = signatureInput.slice("sharness=".length);
  const base = [
    `"@method": ${versioned.method}`,
    `"@authority": ${url.host}`,
    `"@path": ${url.pathname}`,
    `"@query": ?`,
    `"content-digest": ${versioned.headers["content-digest"]}`,
    `"content-type": ${versioned.headers["content-type"]}`,
    `"sharness-version": ${outsideWireWindow}`,
    `"@signature-params": ${signatureParameters}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(base), privateKeyPem).toString(
    "base64",
  );
  return HttpClientRequest.setHeader(
    versioned,
    "signature",
    `sharness=:${signature}:`,
  );
};

const registerVersionMismatchAgent = (infrastructure: Infrastructure) =>
  Effect.gen(function* () {
    const privateKeyPem = generateKeyPairSync("ed25519").privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(privateKeyPem),
    );
    const registered = yield* Registry.register({
      request: {
        operationId: Schema.decodeUnknownSync(OperationId)(
          "opn_AAAAAAAAAAAAAAAAAAAAAA",
        ),
        principalId: Schema.decodeUnknownSync(PrincipalId)(
          "prn_AAAAAAAAAAAAAAAAAAAAAA",
        ),
        agentName: Schema.decodeUnknownSync(AgentName)("version-mismatch"),
        publicKey: AgentSigningAuthority.publicKey(signingAuthority),
      },
      admissionCredential: Redacted.make("registry-router-e2e-admission"),
      signingAuthority,
    }).pipe(
      Effect.provide(
        Registry.layer({
          origin: infrastructure.registryOrigin,
          registrySignerPublicKey: infrastructure.registrySignerPublicKey,
          requestTimeout: Duration.seconds(5),
        }),
      ),
    );
    if (registered.kind !== "registered") {
      return yield* Effect.dieMessage(
        `registration returned ${registered.kind}`,
      );
    }
    return { privateKeyPem, signingAuthority, agentCard: registered.agentCard };
  });

/** A signed out-of-window request preserves the real Router encoder's live set. */
const assertRouterVersionMismatch = (infrastructure: Infrastructure) =>
  Effect.gen(function* () {
    const { privateKeyPem, signingAuthority, agentCard } =
      yield* registerVersionMismatchAgent(infrastructure);
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        withOutsideWireVersion(request, privateKeyPem),
      ),
    );
    const error = yield* Router.poll({
      request: {},
      callerAgentId: agentCard.agentId,
      signingAuthority,
    }).pipe(
      Effect.provide(
        Router.layer({
          origin: infrastructure.routerOrigin,
          sendTimeout: Duration.seconds(5),
          pollTimeout: Duration.seconds(5),
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
      Effect.flip,
    );
    expect(error).toMatchObject({
      _tag: "VersionMismatchError",
      supported: LIVE_WIRE_VERSIONS,
    });
  });

/** A public out-of-window read preserves the real Registry encoder's live set. */
const assertRegistryVersionMismatch = (infrastructure: Infrastructure) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("sharness-version", outsideWireWindow),
      ),
    );
    const error = yield* Registry.lookup({
      agentName: Schema.decodeUnknownSync(AgentName)("version-mismatch"),
    }).pipe(
      Effect.provide(
        Registry.layer({
          origin: infrastructure.registryOrigin,
          registrySignerPublicKey: infrastructure.registrySignerPublicKey,
          requestTimeout: Duration.seconds(5),
        }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
      Effect.flip,
    );
    expect(error).toMatchObject({
      _tag: "VersionMismatchError",
      supported: LIVE_WIRE_VERSIONS,
    });
  });

/** Each real server's encoder is exercised independently through its public client. */
export const testVersionMismatchRoundTrips = (
  setup: Effect.Effect<
    Infrastructure,
    unknown,
    FileSystem.FileSystem | Scope.Scope | HttpClient.HttpClient
  >,
) => {
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly check: (
      infrastructure: Infrastructure,
    ) => Effect.Effect<void, unknown, HttpClient.HttpClient>;
  }> = [
    { name: "Router", check: assertRouterVersionMismatch },
    { name: "Registry", check: assertRegistryVersionMismatch },
  ];
  it.each(scenarios)(
    "returns the real $name's live versions through the public client",
    ({ check }) =>
      Effect.runPromise(
        setup.pipe(
          Effect.flatMap(check),
          Effect.scoped,
          Effect.provide(NodeFileSystem.layer),
          Effect.provide(NodeHttpClient.layer),
        ),
      ),
    60_000,
  );
};

/** Process tests share the public Router client's production HTTP transport. */
export const makeRouterRunner = (origin: URL) => {
  const routerLayer = Router.layer({
    origin,
    sendTimeout: Duration.seconds(5),
    pollTimeout: Duration.seconds(35),
  }).pipe(Layer.provide(NodeHttpClient.layer));
  return <A, E>(effect: Effect.Effect<A, E, Router>) =>
    effect.pipe(Effect.provide(routerLayer));
};
