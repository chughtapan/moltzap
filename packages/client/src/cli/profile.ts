/**
 * Profile layer over `~/.moltzap/config.json`.
 *
 * Backward-compatible extension of the existing singleton: the top-level
 * `apiKey` / `agentName` fields (see cli/config.ts) remain the "default"
 * record; named profiles live under a new top-level `profiles` key.
 *
 * Spec sbd#177 rev 3 §5.2 (`--profile <name>`, `--no-persist`),
 * Invariants §4.3 (coexistence) and §4.4 (no-disk-write guarantee).
 *
 * Architect note. The existing `cli/config.ts` pre-dates this branch and is
 * not edited here (architect rule: no edits to pre-dating files beyond one
 * barrel). `loadLayeredConfig` therefore reads the file directly for the
 * profile-aware path; impl-staff may collapse this back into `config.ts`
 * during implementation, at which point the profile module becomes a
 * named export of `config.ts`. The public interface defined below is the
 * contract impl-staff preserves regardless of layout.
 */
import { Data, Effect } from "effect";

// ─── Branded names ─────────────────────────────────────────────────────────

/**
 * Branded profile name. Enforces the same NAME_PATTERN already gated by
 * `commands/register.ts`: `/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/`.
 */
export type ProfileName = string & { readonly __brand: "ProfileName" };

/** Sentinel used when the caller addresses the legacy top-level record. */
export type DefaultProfileId = "default";

// ─── Records ───────────────────────────────────────────────────────────────

/**
 * One profile's auth record. Shape mirrors the singleton's auth subset.
 * `registeredAt` is OPTIONAL — legacy configs produced by pre-v2 `moltzap
 * register` never wrote the field. The profile layer tolerates its absence
 * so existing `~/.moltzap/config.json` files decode into `LayeredConfig`
 * without rewrite (Invariant §4.3).
 */
export interface ProfileRecord {
  readonly apiKey: string;
  readonly agentName: string;
  readonly serverUrl: string;
  readonly registeredAt?: string; // ISO-8601 datetime; absent on legacy configs
}

/**
 * Layered view of config.json. The legacy top-level keys populate
 * `default`; named records live under `profiles.<name>`. `serverUrl`
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

export class ProfileAlreadyExistsError extends Data.TaggedError(
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
  _raw: string,
): Effect.Effect<ProfileName, ProfileInvalidNameError> => {
  throw new Error("not implemented");
};

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
> = Effect.sync(() => {
  throw new Error("not implemented");
});

/**
 * Resolve the auth record for a given profile name.
 *
 * When `name` is `undefined`, the `default` record is returned (legacy
 * behavior for users who never pass `--profile`). When `name` is supplied
 * and no matching record exists, fails with ProfileNotFoundError — do not
 * silently fall back to `default`; that would violate Invariant §4.3's
 * "takes precedence" clause in the opposite direction.
 */
export const resolveProfileAuth = (
  _name: ProfileName | undefined,
): Effect.Effect<
  ProfileRecord,
  ProfileNotFoundError | ProfileConfigReadError
> => {
  throw new Error("not implemented");
};

/**
 * Persist a new profile record under `profiles.<name>`, or replace the
 * legacy top-level record when `name` is `"default"`.
 *
 * When called with `"default"`, writes the legacy top-level `apiKey` /
 * `agentName` fields (not under `profiles`) so pre-profile-aware readers
 * keep working (Invariant §4.3).
 */
export const writeProfile = (
  _name: ProfileName | DefaultProfileId,
  _record: ProfileRecord,
): Effect.Effect<void, ProfileConfigWriteError | ProfileConfigReadError> => {
  throw new Error("not implemented");
};

/**
 * `--no-persist` contract for `moltzap register`. Revised Invariant §4.4
 * per architect design doc rev 4 finding 2: no file under `$HOME/.moltzap/`
 * OR `$HOME/.openclaw/` is created or modified. Returns the record so the
 * caller can print it; does no I/O under either tree.
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
  _record: ProfileRecord,
): Effect.Effect<{ readonly record: ProfileRecord }, never> => {
  throw new Error("not implemented");
};

// ─── Test seam ─────────────────────────────────────────────────────────────

/**
 * Absolute path to the config file. Overridable at test time via the
 * `MOLTZAP_CONFIG_HOME` env (tests set a tmp dir; production leaves unset).
 * Exported so assertions can diff the file after a command run.
 */
export const getConfigFilePath: Effect.Effect<string, never> = Effect.sync(
  () => {
    throw new Error("not implemented");
  },
);
