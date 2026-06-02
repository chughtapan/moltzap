import { Effect, Either } from "effect";
import { UnauthorizedError } from "@moltzap/protocol";
import { validateAppManifest } from "@moltzap/protocol/app";
import type { AppManifest } from "@moltzap/protocol/app";
import type { AppId } from "@moltzap/protocol/task";
import type { Db } from "../../db/client.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOrFail,
} from "../../db/effect-kysely-toolkit.js";
import { AppContext } from "../../transport/context.js";
import {
  generateAppKey,
  hashSecret,
  parseAppKey,
  safeEqual,
} from "./credential-keys.js";

/**
 * SQL-backed app authentication — the App-principal sibling of
 * {@link AuthService}. Reads/writes the `apps` table (`core-schema.sql`)
 * via Kysely; never touches raw SQL on the typed surface.
 *
 * The four methods carry distinct error channels:
 *
 * | Method             | Channel             | SQL failure | Domain failure |
 * |--------------------|---------------------|-------------|----------------|
 * | `registerApp`      | `never`             | defect      | none           |
 * | `authenticateApp`  | `UnauthorizedError` | defect      | hash MISS → `null`; `manifest_json` decode FAIL → `UnauthorizedError` |
 * | `getManifest`      | `never`             | defect      | impossible-state → defect |
 * | `installDefaultApp`| `never`             | defect      | none           |
 *
 * `catchSqlErrorAsDefect` is the explicit `Effect.orDie` boundary in
 * every body — a bare `never` channel would be a type lie while Kysely's
 * `SqlError` can propagate, so the conversion is applied at each method's
 * edge rather than implied by the signature.
 */
export class AppAuthService {
  constructor(private readonly db: Db) {}

  /**
   * INSERT a fresh app row. `app_id` is server-issued via the column
   * default (`gen_random_uuid()`), so the client never controls the
   * identity. Returns the plaintext `appKey` exactly once; only the
   * derived `keyId` + `secretHash` persist.
   */
  registerApp(params: {
    readonly manifest: AppManifest;
  }): Effect.Effect<{ appId: AppId; appKey: string }, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const { appKey, keyId, secretHash } = generateAppKey();

        const { app_id: appId } = yield* takeFirstOrFail(
          this.db
            .insertInto("apps")
            .values({
              manifest_json: params.manifest,
              api_key_id: keyId,
              api_key_secret_hash: secretHash,
            })
            .returning(["app_id"]),
          "Failed to insert app",
        );

        yield* Effect.logInfo("App registered").pipe(
          Effect.annotateLogs({ appId }),
        );

        return { appId, appKey };
      }),
    );
  }

  /**
   * Resolve an app credential to its principal context AND its manifest in
   * one SQL read. The manifest is decoded atomically with the principal so
   * the Connect handler's App-arm never holds a half-authenticated state
   * where the principal exists but the manifest fetch could still fail.
   *
   * `null` on a hash MISS (caller surfaces a uniform `UnauthorizedError`
   * at the wire). A `manifest_json` decode failure on a hash-MATCHING row
   * is an environmental failure (storage corruption) the operator can fix
   * by re-registering, so it surfaces as a 401 with an actionable
   * `reason: "manifest_corrupted"` rather than a 500 defect.
   */
  authenticateApp(
    apiKey: string,
  ): Effect.Effect<
    { auth: AppContext; manifest: AppManifest } | null,
    UnauthorizedError
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const parsed = parseAppKey(apiKey);
        if (!parsed) return null;

        const rows = yield* this.db
          .selectFrom("apps")
          .select(["app_id", "manifest_json", "api_key_secret_hash"])
          .where("api_key_id", "=", parsed.keyId);

        const row = rows[0];
        if (row === undefined) return null;
        if (!safeEqual(hashSecret(parsed.secret), row.api_key_secret_hash)) {
          return null;
        }

        return yield* Either.match(validateAppManifest(row.manifest_json), {
          onLeft: () =>
            Effect.fail(
              new UnauthorizedError({
                data: { reason: "manifest_corrupted" },
              }),
            ),
          onRight: (manifest) =>
            Effect.succeed({
              auth: new AppContext({ appId: row.app_id }),
              manifest,
            }),
        });
      }),
    );
  }

  /**
   * Read-only manifest lookup for paths OTHER than Connect (admin
   * tooling, observability). Callers hand a `appId` already known-valid
   * from a prior SQL read; a missing row or a `manifest_json` decode
   * failure here is therefore an impossible-state defect, not a
   * caller-actionable error — no concurrent app-row-delete path exists
   * and `manifest_json` corruption surfaces at {@link authenticateApp}'s
   * `UnauthorizedError` channel. The `Effect.die` sites catch the
   * contract violation if the invariant is ever broken upstream.
   */
  getManifest(appId: AppId): Effect.Effect<AppManifest, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("apps")
          .select(["manifest_json"])
          .where("app_id", "=", appId);

        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.die(
            new Error("getManifest: app row missing for known-valid appId"),
          );
        }

        return yield* Either.match(validateAppManifest(row.manifest_json), {
          onLeft: () =>
            Effect.die(
              new Error(
                "getManifest: manifest_json decode failure for known-valid appId",
              ),
            ),
          onRight: (manifest) => Effect.succeed(manifest),
        });
      }),
    );
  }

  /**
   * Boot-time UPSERT for the default-app row. Takes `appId` EXPLICITLY —
   * the manifest does not carry it, so every registry-side surface that
   * needs the identity accepts it as a separate parameter. Reached only
   * from the server boot path; no wire surface exposes it.
   * First boot INSERTs; subsequent boots UPDATE the same row with a
   * refreshed keyId + hash (per-boot key rotation).
   */
  installDefaultApp(
    appId: AppId,
    manifest: AppManifest,
    appKey: string,
  ): Effect.Effect<void, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const parsed = parseAppKey(appKey);
        if (!parsed) {
          // The appKey is minted by `generateAppKey()` at the same boot; an
          // unparseable key is a programmer-invariant violation, not an
          // operational state.
          return yield* Effect.die(
            new Error("installDefaultApp: appKey failed parseAppKey"),
          );
        }
        const secretHash = hashSecret(parsed.secret);

        yield* this.db
          .insertInto("apps")
          .values({
            app_id: appId,
            manifest_json: manifest,
            api_key_id: parsed.keyId,
            api_key_secret_hash: secretHash,
          })
          .onConflict((oc) =>
            oc.column("app_id").doUpdateSet({
              api_key_id: parsed.keyId,
              api_key_secret_hash: secretHash,
              manifest_json: manifest,
            }),
          );
      }),
    );
  }
}
