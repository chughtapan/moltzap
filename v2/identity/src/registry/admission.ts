/** @file Registry-owned bootstrap admission before private dispatch. */

import type { HttpServerRequest } from "@effect/platform";
import { createHash, timingSafeEqual } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";
import { Ed25519PublicKey } from "../agent-key.js";
import {
  AuthenticationFailedError,
  type InternalServerError,
  MalformedRequestError,
  OverloadedError,
  type UnavailableError,
  VersionMismatchError,
} from "../http-errors.js";
import {
  verifyHttpRequestSignature,
  type VerifiedHttpSignature,
} from "../http-signature.js";
import { parseCanonicalJson } from "../canonical-json.js";
import { hasCanonicalBase64UrlLength } from "../identifiers.js";
import { MOLTZAP_VERSION } from "../version.js";
import {
  registrationBody,
  type RegistryRegisterRequest as RegistryRegisterRequestValue,
} from "./contract.js";
import type { RegistryStorage } from "./storage.js";

const registrationPublicKeyRepresentation = Schema.Struct({
  crv: Schema.Literal("Ed25519"),
  kty: Schema.Literal("OKP"),
  x: Schema.String.pipe(
    Schema.filter((value) => hasCanonicalBase64UrlLength(value, 32)),
  ),
});

const minimumRegistrationBody = Schema.Struct({
  request: Schema.Struct({
    publicKey: registrationPublicKeyRepresentation,
  }),
});

const admissionValue =
  /^MoltZap-Admission ((?=.{8,512}$)[A-Za-z0-9\-._~+/]+=*)$/;

type BootstrapRegistrationInput = Readonly<{
  httpRequest: HttpServerRequest.HttpServerRequest;
  bodyBytes: Uint8Array;
  admissionCredential: Redacted.Redacted;
  nonceCapacity: number;
  storage: RegistryStorage;
}>;

/**
 * Verifies Registry-owned bootstrap admission through its durable replay step.
 *
 * @param input Bootstrap boundary dependencies and request.
 * @param input.httpRequest Server request carrying signed framing.
 * @param input.bodyBytes Bounded body octets covered by the signature.
 * @param input.admissionCredential Configured bootstrap secret.
 * @param input.nonceCapacity Maximum live bootstrap nonces.
 * @param input.storage Durable nonce store.
 * @returns The complete registration request after every admission check.
 */
export function verifyBootstrapRegistration(
  input: BootstrapRegistrationInput,
): Effect.Effect<
  RegistryRegisterRequestValue,
  | MalformedRequestError
  | AuthenticationFailedError
  | OverloadedError
  | VersionMismatchError
  | UnavailableError
  | InternalServerError
> {
  return Effect.gen(function* () {
    const parsedBody = yield* malformedRequest(
      parseCanonicalJson(Uint8Array.from(input.bodyBytes)),
    );
    const minimum = yield* malformedRequest(
      Schema.decodeUnknown(minimumRegistrationBody)(parsedBody),
    );
    yield* requireAdmissionCredential(input);
    const publicKey = yield* authenticatePublicKey(minimum.request.publicKey);
    const signature = yield* verifyHttpRequestSignature({
      httpRequest: input.httpRequest,
      bodyBytes: input.bodyBytes,
      publicKey,
      profile: "registration",
    });
    yield* claimNonce(input, signature);
    if (input.httpRequest.headers["moltzap-version"] !== MOLTZAP_VERSION) {
      return yield* new VersionMismatchError();
    }
    const complete = yield* malformedRequest(
      Schema.decodeUnknown(registrationBody)(parsedBody, {
        exact: true,
        onExcessProperty: "error",
      }),
    );
    return complete.request;
  }).pipe(Effect.withSpan("verifyBootstrapRegistration"));
}

function malformedRequest<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, MalformedRequestError, R> {
  return effect.pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Canonical JSON and closed request-schema failures share one exact public malformed envelope.
    Effect.mapError(() => new MalformedRequestError()),
  );
}

function requireAdmissionCredential(
  input: BootstrapRegistrationInput,
): Effect.Effect<void, AuthenticationFailedError> {
  const credential = readAdmissionCredential(
    input.httpRequest.headers.authorization,
  );
  return credential !== undefined &&
    sameCredential(credential, input.admissionCredential)
    ? Effect.void
    : Effect.fail(new AuthenticationFailedError());
}

function authenticatePublicKey(
  candidate: typeof registrationPublicKeyRepresentation.Type,
): Effect.Effect<Ed25519PublicKey, AuthenticationFailedError> {
  return Schema.decodeUnknown(Ed25519PublicKey)(candidate).pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- A syntactically valid but cryptographically unusable verification key is an authentication failure.
    Effect.mapError(() => new AuthenticationFailedError()),
  );
}

function claimNonce(
  input: BootstrapRegistrationInput,
  signature: VerifiedHttpSignature,
): Effect.Effect<
  void,
  | AuthenticationFailedError
  | OverloadedError
  | UnavailableError
  | InternalServerError
> {
  return Effect.gen(function* () {
    const claim = yield* input.storage.claimRegistrationNonce({
      nonce: signature.nonce,
      expires: signature.expires,
      now: signature.verifiedAt,
      capacity: input.nonceCapacity,
    });
    if (claim === "replayed") {
      return yield* new AuthenticationFailedError();
    }
    if (claim === "full") {
      return yield* new OverloadedError();
    }
  });
}

function readAdmissionCredential(authorization?: string): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }
  const match = admissionValue.exec(authorization);
  if (match === null) {
    return undefined;
  }
  const credential = match[1];
  return typeof credential === "string" ? credential : undefined;
}

function sameCredential(
  received: string,
  configured: Redacted.Redacted,
): boolean {
  const receivedDigest = createHash("sha256").update(received).digest();
  const configuredDigest = createHash("sha256")
    .update(Redacted.value(configured))
    .digest();
  return timingSafeEqual(receivedDigest, configuredDigest);
}
