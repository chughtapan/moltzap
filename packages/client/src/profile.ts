/**
 * Profile layer over `~/.moltzap/config.json`.
 *
 * Named profiles live under a top-level `profiles` key. There is no singleton
 * credential fallback; every persisted identity is selected by profile name.
 */
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect, Either, Schema } from "effect";
import { AgentId } from "@moltzap/protocol/identity";
import { AgentKey } from "@moltzap/protocol/identity";
import { getMoltZapConfigDir, getMoltZapConfigPath } from "./local-paths.js";

// ─── Branded names ─────────────────────────────────────────────────────────

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const CONFIG_FILE_MODE = 0o600;
const JSON_INDENT_SPACES = 2;
const getConfigDir = getMoltZapConfigDir;
const getConfigFilePathSync = getMoltZapConfigPath;
const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

// ─── Records ───────────────────────────────────────────────────────────────

export const ProfileName = Schema.String.pipe(
  Schema.pattern(NAME_PATTERN),
  Schema.brand("ProfileName"),
);

/**
 * Branded profile name shared by profile lookup and CLI registration.
 */
export type ProfileName = Schema.Schema.Type<typeof ProfileName>;

const ProfileRecordSchema = Schema.Struct({
  agentId: AgentId,
  apiKey: AgentKey,
  agentName: Schema.String,
});

/** One profile's persisted auth record. */
export type ProfileRecord = Schema.Schema.Type<typeof ProfileRecordSchema>;

const ProfileMapSchema = Schema.Record({
  key: ProfileName,
  value: ProfileRecordSchema,
});

const ProfileFileSchema = Schema.Struct({
  profiles: Schema.optional(ProfileMapSchema),
});
type ProfileFile = Schema.Schema.Type<typeof ProfileFileSchema>;
const ProfileFileTextSchema = Schema.parseJson(ProfileFileSchema, {
  space: JSON_INDENT_SPACES,
});

/** Named profile view of config.json. */
export interface LayeredConfig {
  readonly profiles: ReadonlyMap<ProfileName, ProfileRecord>;
}

// ─── Errors ────────────────────────────────────────────────────────────────

/** Exhaustive error union for the profile surface. */
export type ProfileError =
  | ProfileNotFoundError
  | ProfileInvalidNameError
  | ProfileConfigReadError
  | ProfileConfigWriteError;

export class ProfileNotFoundError extends Data.TaggedError(
  "ProfileNotFoundError",
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
  return Schema.decodeUnknown(ProfileName)(raw).pipe(
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: () =>
          Effect.fail(
            new ProfileInvalidNameError({
              name: raw,
              reason:
                "must be 3-32 chars, lowercase alphanumeric and hyphens, cannot start or end with a hyphen",
            }),
          ),
        onRight: Effect.succeed,
      }),
    ),
  );
};

const readProfileFileText = (
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

const decodeProfileFileText = (
  configPath: string,
  text: string,
): Effect.Effect<ProfileFile, ProfileConfigReadError> =>
  Schema.decodeUnknown(
    ProfileFileTextSchema,
    STRICT_PARSE_OPTIONS,
  )(text).pipe(
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(new ProfileConfigReadError({ path: configPath, cause })),
        onRight: Effect.succeed,
      }),
    ),
  );

const readProfileFile = (): Effect.Effect<
  { file: ProfileFile; existed: boolean },
  ProfileConfigReadError
> =>
  Effect.gen(function* () {
    const configPath = getConfigFilePathSync();
    const text = yield* readProfileFileText(configPath);
    if (text === null) {
      return { file: {}, existed: false };
    }
    const file = yield* decodeProfileFileText(configPath, text);
    return { file, existed: true };
  });

function profilesFromFile(file: ProfileFile): Map<ProfileName, ProfileRecord> {
  return new Map(
    Object.entries(file.profiles ?? {}) as Array<[ProfileName, ProfileRecord]>,
  );
}

/**
 * Load the full layered config view. Missing file resolves to an empty
 * view; malformed file surfaces as ProfileConfigReadError. No silent
 * defaults on parse error.
 *
 * The file schema is strict: stale fields and malformed profile entries fail
 * decode instead of being silently ignored.
 */
export const loadLayeredConfig: Effect.Effect<
  LayeredConfig,
  ProfileConfigReadError
> = Effect.gen(function* () {
  const { file } = yield* readProfileFile();
  return {
    profiles: profilesFromFile(file),
  };
}).pipe(Effect.withSpan("loadLayeredConfig"));

/**
 * Resolve a named profile record. CLI transport selection uses only
 * `agentId`; daemon startup consumes the redacted `apiKey`.
 */
export const resolveProfileRecord = (
  name: ProfileName,
): Effect.Effect<
  ProfileRecord,
  ProfileNotFoundError | ProfileConfigReadError
> =>
  Effect.gen(function* () {
    const layered = yield* loadLayeredConfig;
    const found = layered.profiles.get(name);
    if (found === undefined) {
      return yield* Effect.fail(new ProfileNotFoundError({ name }));
    }
    return found;
  }).pipe(Effect.withSpan("resolveProfileRecord"));

function nextProfileFile(
  file: ProfileFile,
  name: ProfileName,
  record: ProfileRecord,
): ProfileFile {
  return {
    profiles: {
      ...file.profiles,
      [name]: record,
    },
  };
}

const encodeProfileFileText = (
  configPath: string,
  file: ProfileFile,
): Effect.Effect<string, ProfileConfigWriteError> =>
  Schema.encode(
    ProfileFileTextSchema,
    STRICT_PARSE_OPTIONS,
  )(file).pipe(
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(new ProfileConfigWriteError({ path: configPath, cause })),
        onRight: Effect.succeed,
      }),
    ),
  );

const writeProfileFile = (
  next: ProfileFile,
): Effect.Effect<void, ProfileConfigWriteError> => {
  const configDir = getConfigDir();
  const configPath = getConfigFilePathSync();
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      encodeProfileFileText(configPath, next).pipe(
        Effect.flatMap((text) =>
          fileSystem.makeDirectory(configDir, { recursive: true }).pipe(
            Effect.zipRight(
              fileSystem.writeFileString(configPath, `${text}\n`, {
                mode: CONFIG_FILE_MODE,
              }),
            ),
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
 * Persist a new profile record under `profiles.&lt;name>`.
 */
export const writeProfile = (
  name: ProfileName,
  record: ProfileRecord,
): Effect.Effect<void, ProfileConfigWriteError | ProfileConfigReadError> =>
  Effect.gen(function* () {
    const { file } = yield* readProfileFile();
    yield* writeProfileFile(nextProfileFile(file, name, record));
  }).pipe(Effect.withSpan("writeProfile"));

/**
 * `--no-persist` contract for `moltzap register`: no file under
 * `$HOME/.moltzap/` is created or modified. Returns the record so the caller
 * can print it; does no I/O under that tree.
 *
 * The register command invokes either `writeProfile` (default) or
 * `emitNoPersist` (when the flag is set). The register handler never calls
 * both paths on the same invocation.
 *
 * The register command pipes the returned record through the printer,
 * which writes non-secret registration details to stdout.
 */
export const emitNoPersist = (
  record: ProfileRecord,
): Effect.Effect<{ readonly record: ProfileRecord }, never> =>
  Effect.succeed({ record });
