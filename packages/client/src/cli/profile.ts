/**
 * Profile layer over `~/.moltzap/config.json`.
 *
 * The top-level `apiKey` / `agentName` fields (see cli/config.ts) are the
 * "default" record; named profiles live under a top-level `profiles` key.
 * `loadLayeredConfig` reads the file directly for the profile-aware path.
 *
 * Supports `--profile &lt;name>` and `--no-persist`: named profiles coexist
 * with the default record, and `--no-persist` guarantees no disk write.
 */
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Brand, Data, Effect, Either } from "effect";
import { getMoltZapConfigDir, getMoltZapConfigPath } from "../local-paths.js";

// ─── Branded names ─────────────────────────────────────────────────────────

/**
 * Branded profile name. Enforces the same NAME_PATTERN already gated by
 * `commands/register.ts`: `/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/`.
 */
export type ProfileName = string & Brand.Brand<"ProfileName">;
const ProfileNameBrand = Brand.nominal<ProfileName>();

/** Sentinel used when the caller addresses the legacy top-level record. */
export type DefaultProfileId = "default";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";
const CONFIG_FILE_MODE = 0o600;
const JSON_INDENT_SPACES = 2;
const getConfigDir = getMoltZapConfigDir;
const getConfigFilePathSync = getMoltZapConfigPath;

// ─── Records ───────────────────────────────────────────────────────────────

/**
 * One profile's auth record. Shape mirrors the singleton's auth subset.
 * `registeredAt` is OPTIONAL — older configs may not carry the field. The
 * profile layer tolerates its absence so existing `~/.moltzap/config.json`
 * files decode into `LayeredConfig` without rewrite.
 */
export interface ProfileRecord {
  readonly apiKey: string;
  readonly agentName: string;
  readonly serverUrl: string;
  readonly registeredAt?: string; // ISO-8601 datetime; absent on legacy configs
}

/**
 * Layered view of config.json. The legacy top-level keys populate
 * `default`; named records live under `profiles.&lt;name>`. `serverUrl`
 * is surfaced at the top because it is shared across profiles unless
 * a profile overrides it.
 */
export interface LayeredConfig {
  readonly default: ProfileRecord | undefined;
  readonly profiles: ReadonlyMap<ProfileName, ProfileRecord>;
  readonly serverUrl: string;
}

// ─── Errors ────────────────────────────────────────────────────────────────

/** Exhaustive error union for the profile surface. */
export type ProfileError =
  | ProfileNotFoundError
  | ProfileAlreadyExistsError
  | ProfileInvalidNameError
  | ProfileConfigReadError
  | ProfileConfigWriteError;

export class ProfileNotFoundError extends Data.TaggedError(
  "ProfileNotFoundError",
)<{
  readonly name: string;
}> {}

class ProfileAlreadyExistsError extends Data.TaggedError(
  "ProfileAlreadyExistsError",
)<{
  readonly name: string;
}> {}

export class ProfileInvalidNameError extends Data.TaggedError(
  "ProfileInvalidNameError",
)<{
  readonly name: string;
  readonly reason: string;
}> {}

export class ProfileConfigReadError extends Data.TaggedError(
  "ProfileConfigReadError",
)<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class ProfileConfigWriteError extends Data.TaggedError(
  "ProfileConfigWriteError",
)<{
  readonly path: string;
  readonly cause: unknown;
}> {}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Parse and brand a raw profile name. Rejects the empty string and any
 * string that fails NAME_PATTERN.
 */
export const parseProfileName = (
  raw: string,
): Effect.Effect<ProfileName, ProfileInvalidNameError> => {
  if (raw.length === 0) {
    return Effect.fail(
      new ProfileInvalidNameError({ name: raw, reason: "empty string" }),
    );
  }
  if (!NAME_PATTERN.test(raw)) {
    return Effect.fail(
      new ProfileInvalidNameError({
        name: raw,
        reason:
          "must be 3-32 chars, lowercase alphanumeric and hyphens, cannot start or end with a hyphen",
      }),
    );
  }
  return Effect.succeed(ProfileNameBrand(raw));
};

interface RawConfig {
  readonly serverUrl?: string;
  readonly apiKey?: string;
  readonly agentName?: string;
  readonly profiles?: Record<string, unknown>;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const decodeProfileRecord = (
  raw: unknown,
  fallbackServerUrl: string,
): ProfileRecord | undefined => {
  if (!isRecord(raw)) return undefined;
  const { apiKey, agentName } = raw;
  if (typeof apiKey !== "string" || typeof agentName !== "string") {
    return undefined;
  }
  const serverUrl =
    typeof raw.serverUrl === "string" ? raw.serverUrl : fallbackServerUrl;
  const record: ProfileRecord = { apiKey, agentName, serverUrl };
  if (typeof raw.registeredAt === "string") {
    return { ...record, registeredAt: raw.registeredAt };
  }
  return record;
};

const readRawConfigText = (
  configPath: string,
): Effect.Effect<string | null, ProfileConfigReadError> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem
        .exists(configPath)
        .pipe(
          Effect.flatMap((exists) =>
            exists
              ? fileSystem.readFileString(configPath, "utf-8")
              : Effect.succeed(null),
          ),
        ),
    ),
    Effect.provide(NodeFileSystem.layer),
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(new ProfileConfigReadError({ path: configPath, cause })),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
  );

const parseRawConfig = (
  configPath: string,
  text: string,
): Effect.Effect<unknown, ProfileConfigReadError> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (err) =>
      new ProfileConfigReadError({ path: configPath, cause: err }),
  });

const requireRawConfigRecord = (
  configPath: string,
  parsed: unknown,
): Effect.Effect<RawConfig, ProfileConfigReadError> =>
  isRecord(parsed)
    ? Effect.succeed(parsed as RawConfig)
    : Effect.fail(
        new ProfileConfigReadError({
          path: configPath,
          cause: "config root is not a JSON object",
        }),
      );

const readRawConfig = (): Effect.Effect<
  { raw: RawConfig; existed: boolean },
  ProfileConfigReadError
> =>
  Effect.gen(function* () {
    const configPath = getConfigFilePathSync();
    const text = yield* readRawConfigText(configPath);
    if (text === null) {
      return { raw: {}, existed: false };
    }
    const parsed = yield* parseRawConfig(configPath, text);
    const raw = yield* requireRawConfigRecord(configPath, parsed);
    return { raw, existed: true };
  });

function defaultProfileFromRaw(
  raw: RawConfig,
  serverUrl: string,
): ProfileRecord | undefined {
  if (typeof raw.apiKey !== "string" || typeof raw.agentName !== "string") {
    return undefined;
  }
  return {
    apiKey: raw.apiKey,
    agentName: raw.agentName,
    serverUrl,
  };
}

function profilesFromRaw(
  raw: RawConfig,
  serverUrl: string,
): Map<ProfileName, ProfileRecord> {
  const profiles = new Map<ProfileName, ProfileRecord>();
  if (!isRecord(raw.profiles)) return profiles;
  for (const [name, value] of Object.entries(raw.profiles)) {
    if (!NAME_PATTERN.test(name)) continue; // tolerate malformed entries
    const record = decodeProfileRecord(value, serverUrl);
    if (record !== undefined) {
      profiles.set(ProfileNameBrand(name), record);
    }
  }
  return profiles;
}

/**
 * Load the full layered config view. Missing file resolves to an empty
 * view; malformed file surfaces as ProfileConfigReadError. No silent
 * defaults on parse error.
 *
 * Unknown-key tolerance: the decoder accepts extra top-level keys (e.g.
 * future experimental fields) without failing. This keeps forward and
 * backward compatibility explicit rather than implicit.
 */
export const loadLayeredConfig: Effect.Effect<
  LayeredConfig,
  ProfileConfigReadError
> = Effect.gen(function* () {
  const { raw } = yield* readRawConfig();
  const serverUrl =
    typeof raw.serverUrl === "string" ? raw.serverUrl : DEFAULT_SERVER_URL;
  return {
    default: defaultProfileFromRaw(raw, serverUrl),
    profiles: profilesFromRaw(raw, serverUrl),
    serverUrl,
  };
}).pipe(Effect.withSpan("loadLayeredConfig"));

/**
 * Resolve the auth record for a given profile name.
 *
 * When `name` is `undefined`, the `default` record is returned (the path
 * for users who never pass `--profile`). When `name` is supplied and no
 * matching record exists, fails with ProfileNotFoundError — it does not
 * silently fall back to `default`, since a named profile takes precedence
 * over the default.
 */
export const resolveProfileAuth = (
  name: ProfileName | undefined,
): Effect.Effect<
  ProfileRecord,
  ProfileNotFoundError | ProfileConfigReadError
> =>
  Effect.gen(function* () {
    const layered = yield* loadLayeredConfig;
    if (name === undefined) {
      if (layered.default === undefined) {
        return yield* Effect.fail(
          new ProfileNotFoundError({ name: "default" }),
        );
      }
      return layered.default;
    }
    const found = layered.profiles.get(name);
    if (found === undefined) {
      return yield* Effect.fail(new ProfileNotFoundError({ name }));
    }
    return found;
  }).pipe(Effect.withSpan("resolveProfileAuth"));

function profileBodyFromRecord(record: ProfileRecord): Record<string, unknown> {
  return {
    apiKey: record.apiKey,
    agentName: record.agentName,
    serverUrl: record.serverUrl,
    ...(record.registeredAt !== undefined
      ? { registeredAt: record.registeredAt }
      : {}),
  };
}

function nextProfileConfig(
  raw: RawConfig,
  name: ProfileName | DefaultProfileId,
  record: ProfileRecord,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  if (name === "default") {
    next.serverUrl = record.serverUrl;
    next.apiKey = record.apiKey;
    next.agentName = record.agentName;
    return next;
  }
  const existingProfiles = isRecord(next.profiles) ? next.profiles : {};
  next.profiles = {
    ...existingProfiles,
    [name]: profileBodyFromRecord(record),
  };
  if (typeof next.serverUrl !== "string") {
    next.serverUrl = record.serverUrl;
  }
  return next;
}

const writeRawConfig = (
  next: Record<string, unknown>,
): Effect.Effect<void, ProfileConfigWriteError> => {
  const configDir = getConfigDir();
  const configPath = getConfigFilePathSync();
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem
        .makeDirectory(configDir, { recursive: true })
        .pipe(
          Effect.zipRight(
            fileSystem.writeFileString(
              configPath,
              JSON.stringify(next, null, JSON_INDENT_SPACES) + "\n",
              { mode: CONFIG_FILE_MODE },
            ),
          ),
        ),
    ),
    Effect.provide(NodeFileSystem.layer),
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(new ProfileConfigWriteError({ path: configPath, cause })),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
  );
};

/**
 * Persist a new profile record under `profiles.&lt;name>`, or replace the
 * top-level record when `name` is `"default"`.
 *
 * When called with `"default"`, writes the top-level `apiKey` /
 * `agentName` fields (not under `profiles`) so readers that only know the
 * top-level record keep working.
 */
export const writeProfile = (
  name: ProfileName | DefaultProfileId,
  record: ProfileRecord,
): Effect.Effect<void, ProfileConfigWriteError | ProfileConfigReadError> =>
  Effect.gen(function* () {
    const { raw } = yield* readRawConfig();
    yield* writeRawConfig(nextProfileConfig(raw, name, record));
  }).pipe(Effect.withSpan("writeProfile"));

/**
 * `--no-persist` contract for `moltzap register`: no file under
 * `$HOME/.moltzap/` OR `$HOME/.openclaw/` is created or modified. Returns
 * the record so the caller can print it; does no I/O under either tree.
 *
 * The register command invokes either `writeProfile` + the existing
 * `writeOpenClawChannelConfig` (default) or `emitNoPersist` (when the flag
 * is set) — both side effects are gated by the single flag. The register
 * handler NEVER calls both paths on the same invocation.
 *
 * The register command pipes the returned record through the printer,
 * which writes agentId / apiKey / serverUrl / claimUrl to stdout (so
 * callers can `$(moltzap register --no-persist ...)` into env).
 */
export const emitNoPersist = (
  record: ProfileRecord,
): Effect.Effect<{ readonly record: ProfileRecord }, never> =>
  Effect.succeed({ record });
