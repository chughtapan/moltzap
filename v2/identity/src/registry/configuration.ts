import { isAbsolute } from "node:path";
import {
  Config,
  type ConfigError,
  Effect,
  type Redacted,
  Schema,
} from "effect";

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
const postgresqlUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "postgres:" ||
          parsed.protocol === "postgresql:") &&
        parsed.pathname.length > 1 &&
        parsed.hash === ""
      );
      // eslint-disable-next-line agent-code-guard/bare-catch -- URL parsing failure is the false branch of this Schema predicate.
    } catch {
      return false;
    }
  }),
);
const admissionCredential = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9\-._~+/]+=*$/),
);
const absolutePath = Schema.String.pipe(
  Schema.filter((value) => isAbsolute(value)),
);

const configuredValues = Config.all({
  host: Schema.Config("MOLTZAP_REGISTRY_HOST", bindHost).pipe(
    Config.withDefault("127.0.0.1"),
  ),
  port: Schema.Config("MOLTZAP_REGISTRY_PORT", port),
  postgresqlUrl: Config.redacted(
    Schema.Config("MOLTZAP_REGISTRY_POSTGRESQL_URL", postgresqlUrl),
  ),
  admissionCredential: Config.redacted(
    Schema.Config("MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL", admissionCredential),
  ),
  signingPrivateKeyPath: Config.redacted(
    Schema.Config("MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH", absolutePath),
  ),
  listPageSize: Schema.Config(
    "MOLTZAP_REGISTRY_LIST_PAGE_SIZE",
    processInteger,
  ).pipe(Config.withDefault(100)),
  requestConcurrencyLimit: Schema.Config(
    "MOLTZAP_REGISTRY_REQUEST_CONCURRENCY_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(256)),
  liveNonceCapacity: Schema.Config(
    "MOLTZAP_REGISTRY_LIVE_NONCE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(10_000)),
  sqlPoolSize: Schema.Config(
    "MOLTZAP_REGISTRY_SQL_POOL_SIZE",
    processInteger,
  ).pipe(Config.withDefault(10)),
  sqlOperationTimeoutMs: Schema.Config(
    "MOLTZAP_REGISTRY_SQL_OPERATION_TIMEOUT_MS",
    processInteger,
  ).pipe(Config.withDefault(5_000)),
});

/** Complete validated configuration for one Registry process. */
export interface RegistryConfiguration {
  readonly host: string;
  readonly port: number;
  readonly postgresqlUrl: Redacted.Redacted;
  readonly admissionCredential: Redacted.Redacted;
  readonly signingPrivateKeyPath: Redacted.Redacted;
  readonly listPageSize: number;
  readonly requestConcurrencyLimit: number;
  readonly liveNonceCapacity: number;
  readonly sqlPoolSize: number;
  readonly sqlOperationTimeoutMs: number;
}

/** Loads the complete private Registry process configuration. */
export const loadRegistryConfiguration: Effect.Effect<
  RegistryConfiguration,
  ConfigError.ConfigError
> = configuredValues.pipe(
  Effect.map((configuration): RegistryConfiguration => configuration),
  Effect.withSpan("loadRegistryConfiguration"),
);
