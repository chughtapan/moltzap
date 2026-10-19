/** @file The installer retains one enrollment identity and validates the existing deployment wire contract, not a second enrollment protocol. */

import { Effect, Redacted, Schema } from "effect";
import { createHash } from "node:crypto";

const digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const httpsUrl = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.filter(canonicalHttpsUrl),
);
const origin = httpsUrl.pipe(
  Schema.filter((value) => new URL(value).origin + "/" === value),
);
const target = Schema.Union(
  Schema.Struct({
    hosting: Schema.Literal("daemon"),
    platform: Schema.Literal(
      "muse",
      "instinct",
      "grokbot",
      "openclaw",
      "openai-dot",
    ),
  }),
  Schema.Struct({
    hosting: Schema.Literal("agent"),
    platform: Schema.Literal("openclaw"),
  }),
);
const name = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.pattern(/^[^\p{Cc}\p{Cs}]+$/u),
);
const expiresAt = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.filter(Number.isSafeInteger),
);
const claimToken = Schema.Redacted(digest);

/** These categories never retain untrusted HTTP, filesystem or schema diagnostics. */
export class InstallFailure extends Schema.TaggedError<InstallFailure>()(
  "InstallFailure",
  {
    reason: Schema.Literal(
      "usage",
      "state",
      "conflict",
      "artifact",
      "response",
      "transport",
      "unavailable",
      "oauth-required",
    ),
  },
) {}

/** Provenance identifies executing installer bytes, not a qualified release or its complete dependency closure. */
const artifactIdentity = Schema.Struct({
  kind: Schema.Literal("source", "private-archive"),
  version: Schema.NullOr(Schema.String),
  manifestSha256: digest,
  installerSha256: digest,
  qualification: Schema.Literal("unqualified"),
});

/** The request and its custody are committed before the first registration attempt. */
export class InstallReceipt extends Schema.Class<InstallReceipt>(
  "InstallReceipt",
)({
  format: Schema.Literal(1),
  origin,
  resource: httpsUrl,
  target,
  name,
  expiresAt,
  claimToken,
  artifact: artifactIdentity,
}) {}

/** Responses may reveal claimed progress, but may not replace any retained request field. */
export class RegistrationResponse extends Schema.Class<RegistrationResponse>(
  "RegistrationResponse",
)({
  installationId: Schema.String.pipe(Schema.pattern(/^inst_[a-f0-9]{32}$/u)),
  target,
  name,
  expiresAt,
  claimed: Schema.Boolean,
  claimUrl: Schema.Redacted(Schema.String),
}) {}

/** Grok's exact key is kept in private receipt custody before its first setup request. */
const nativeSetup = Schema.Union(
  Schema.Struct({
    platform: Schema.Literal("instinct"),
    recipient: Schema.NonEmptyString.pipe(
      Schema.maxLength(254),
      Schema.filter(canonicalRecipient),
    ),
  }),
  Schema.Struct({
    platform: Schema.Literal("grokbot"),
    routineUrl: httpsUrl.pipe(
      Schema.filter((value) => new URL(value).port === ""),
    ),
    credential: Schema.Redacted(
      Schema.NonEmptyString.pipe(
        Schema.maxLength(4096),
        Schema.pattern(/^[A-Za-z0-9._~+/-]+=*$/u),
      ),
    ),
  }),
);

/** Only checked setup values can be retained or sent to the existing native setup endpoint. */
export type NativeSetup = typeof nativeSetup.Type;

/** A canonical 32-byte grant is saved verbatim for the existing native leaf. */
export const runtimeCredential = Schema.Redacted(
  Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)),
);

/** Local setup validation precedes immutable file publication. */
export function decodeNativeSetup(
  input: unknown,
  reason: InstallFailure["reason"],
) {
  return decodeInstall(nativeSetup, input, reason);
}

/** Private receipt and HTTP encoding use the same checked setup representation. */
export function encodeNativeSetup(input: NativeSetup) {
  return encodeInstall(nativeSetup, input);
}

/** Strict decoding strips raw input from the outward failure at every installer boundary. */
export function decodeInstall<A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
  reason: InstallFailure["reason"],
) {
  return Schema.decodeUnknown(schema, { onExcessProperty: "error" })(
    input,
  ).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new InstallFailure({ reason })),
    ),
  );
}

/** Encoding failures share the private-state refusal rather than retaining a supplied secret in a parser diagnostic. */
export function encodeInstall<A, I>(schema: Schema.Schema<A, I>, input: A) {
  return Schema.encode(schema)(input).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new InstallFailure({ reason: "state" })),
    ),
  );
}

/** The ordered descriptor matches the server's owner-visible native setup identity. */
export function setupIdentity(setup: NativeSetup): string {
  const fields =
    setup.platform === "instinct"
      ? [setup.platform, setup.recipient]
      : [
          setup.platform,
          setup.routineUrl,
          sha256(Redacted.value(setup.credential)),
        ];
  return sha256(JSON.stringify(fields));
}

/** SHA-256 fingerprints bytes without turning credentials into public diagnostic fields. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHttpsUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  const privateParts = [url.username, url.password, url.hash, url.search];
  return (
    url.protocol === "https:" &&
    url.href === value &&
    privateParts.every((part) => part === "")
  );
}

function canonicalRecipient(value: string): boolean {
  const [local = "", domain = "", ...extra] = value.split("@");
  return (
    local !== "" &&
    extra.length === 0 &&
    !/[\s<>\p{Cc}]/u.test(value) &&
    validDomain(domain)
  );
}

function validDomain(domain: string): boolean {
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}
