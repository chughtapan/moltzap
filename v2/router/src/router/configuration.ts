import {
  Ed25519PublicKey,
  SignedMessage,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
} from "@moltzap/v2-identity";
import { Config, Effect, Schema } from "effect";
import { routerRepresentationLimits } from "./contract.js";

const MAXIMUM_PROCESS_INTEGER = 2_147_483_647;
const canonicalUnsignedDecimal = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)$/),
);
const processInteger = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, MAXIMUM_PROCESS_INTEGER),
);
const port = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, 65_535),
);
const bindHost = Schema.String.pipe(Schema.minLength(1));

const isSerializedRegistryOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return value === parsed.origin;
};

const registryOriginText = Schema.String.pipe(
  Schema.filter(isSerializedRegistryOrigin),
);
const registryOrigin = registryOriginText.pipe(Schema.compose(Schema.URL));
const compactPublicKeyJson = Schema.String.pipe(
  Schema.pattern(/^\{"crv":"Ed25519","kty":"OKP","x":"[A-Za-z0-9_-]{43}"\}$/),
  Schema.compose(Schema.parseJson(Ed25519PublicKey)),
);

const configuredValues = Config.all({
  host: Schema.Config("MOLTZAP_ROUTER_HOST", bindHost).pipe(
    Config.withDefault("127.0.0.1"),
  ),
  port: Schema.Config("MOLTZAP_ROUTER_PORT", port),
  registryOrigin: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_ORIGIN",
    registryOrigin,
  ),
  registrySignerPublicKey: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY",
    compactPublicKeyJson,
  ),
  retainedMessageCapacity: Schema.Config(
    "MOLTZAP_ROUTER_RETAINED_MESSAGE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(4_096)),
  retainedMessageByteCapacity: Schema.Config(
    "MOLTZAP_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(67_108_864)),
  pollMessageLimit: Schema.Config(
    "MOLTZAP_ROUTER_POLL_MESSAGE_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(128)),
  pollResponseByteLimit: Schema.Config(
    "MOLTZAP_ROUTER_POLL_RESPONSE_BYTE_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(1_048_576)),
  requestConcurrencyLimit: Schema.Config(
    "MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(512)),
  heldPollCapacity: Schema.Config(
    "MOLTZAP_ROUTER_HELD_POLL_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(256)),
  liveNonceCapacity: Schema.Config(
    "MOLTZAP_ROUTER_LIVE_NONCE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(100_000)),
  agentCardCacheCapacity: Schema.Config(
    "MOLTZAP_ROUTER_AGENT_CARD_CACHE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(10_000)),
  registryLookupConcurrencyLimit: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_LOOKUP_CONCURRENCY_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(32)),
  registryLookupTimeoutMs: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_LOOKUP_TIMEOUT_MS",
    processInteger,
  ).pipe(Config.withDefault(5_000)),
});

/** Complete validated private process configuration. */
export interface RouterConfiguration {
  readonly host: string;
  readonly port: number;
  readonly registryOrigin: URL;
  readonly registrySignerPublicKey: Ed25519PublicKeyValue;
  readonly retainedMessageCapacity: number;
  readonly retainedMessageByteCapacity: number;
  readonly pollMessageLimit: number;
  readonly pollResponseByteLimit: number;
  readonly requestConcurrencyLimit: number;
  readonly heldPollCapacity: number;
  readonly liveNonceCapacity: number;
  readonly agentCardCacheCapacity: number;
  readonly registryLookupConcurrencyLimit: number;
  readonly registryLookupTimeoutMs: number;
}

const retentionFits = (candidate: RouterConfiguration): boolean =>
  candidate.retainedMessageCapacity >= 1 &&
  candidate.retainedMessageByteCapacity >=
    SignedMessage.maximumEncodedByteLength;

const pollBatchFits = (candidate: RouterConfiguration): boolean =>
  candidate.pollMessageLimit >= 1 &&
  candidate.pollResponseByteLimit >=
    routerRepresentationLimits.oneMessageBatchBytes;

const heldPollsFit = (candidate: RouterConfiguration): boolean =>
  candidate.heldPollCapacity < candidate.requestConcurrencyLimit;

const validatedConfiguration = configuredValues.pipe(
  Config.validate({
    message:
      "Router resource bounds do not satisfy the representation fit laws",
    validation: (candidate) =>
      retentionFits(candidate) &&
      pollBatchFits(candidate) &&
      heldPollsFit(candidate),
  }),
);

/** Loads and cross-validates the complete private Router process configuration. */
export const loadRouterConfiguration = Effect.gen(function* () {
  const configuration: RouterConfiguration = yield* validatedConfiguration;
  return configuration;
}).pipe(Effect.withSpan("loadRouterConfiguration"));
