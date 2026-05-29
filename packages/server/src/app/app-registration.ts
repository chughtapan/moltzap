import type { AppManifest } from "@moltzap/protocol";
import { AppNotFoundError, AppNotReadyError } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { AppId, DEFAULT_APP_ID } from "@moltzap/protocol/task";
import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import type { Originator } from "../transport/connection.js";

/**
 * The minimal server→app dispatch surface a registration needs: the
 * connection id (for `isAppConnection` id-equality + close-time cleanup) and
 * the outbound {@link Originator} (the `sendRpcToClient` channel). Minted from
 * the live `AppConnection` arm's `{ connId, originator }` at `apps/register`
 * (D #705 CP4d/CP5), or from a loopback originator for the boot-installed
 * default app. Replaces the full `MoltZapConnection` the registration used to
 * carry — AppHost never read anything else off it.
 */
export interface AppEndpoint {
  readonly connId: ConnectionId;
  readonly originator: Originator;
}

/**
 * A registered app. There is NO `InProcess` vs `Remote` distinction —
 * every app, including the boot-installed default, carries an
 * {@link AppEndpoint}. Wire-registered apps hold the `{ connId, originator }`
 * minted from the `AppConnection` arm their `apps/register` call arrived on;
 * the default app holds a loopback endpoint (see `loopback-connection.ts`)
 * whose `originator.call` dispatches in-process. AppHost sees ONE shape and
 * uses ONE dispatch path: `sendRpcToClient(entry.endpoint.originator, …)`.
 */
export interface AppRegistration {
  readonly appId: AppId;
  readonly manifest: AppManifest;
  readonly endpoint: AppEndpoint;
}

/**
 * D #705 §3.1 — the spec's name for a registry entry. Aliased onto the
 * existing `AppRegistration` shape so `lookup`'s public signature reads in
 * `RegisteredApp` terms per spec; the cutover phase renames the underlying
 * interface and migrates consumers.
 */
export type RegisteredApp = AppRegistration;

/**
 * Single source of truth for app registrations. The registry has no
 * notion of "boot" vs "wire" — both go through {@link register}.
 * The registry itself enforces the no-overwrite invariant: any
 * attempt to register on top of an existing entry returns false.
 * Callers (the `apps/register` handler, `installDefaultApp`) map a
 * `false` return to whatever surfacing they need — typed
 * `ForbiddenError` for the wire path, an exception for boot.
 */
export class AppRegistry {
  private entries = new Map<AppId, AppRegistration>();

  /**
   * D #705 §3.1 — boot-state discriminator for {@link lookup}. `null` until
   * {@link markBootComplete} runs after §2.6 step 5c; thereafter an immutable
   * timestamp. Internal state — no public read accessor.
   */
  private bootCompleteAt: number | null = null;

  /**
   * Returns true if the registration was installed, false if `appId`
   * is already present. Never overwrites — the caller MUST unregister
   * first if they want to replace.
   */
  register(manifest: AppManifest, endpoint: AppEndpoint): boolean {
    const appId = Value.Decode(AppId, manifest.appId);
    if (this.entries.has(appId)) return false;
    this.entries.set(appId, { appId, manifest, endpoint });
    return true;
  }

  /**
   * Stamp boot-complete (D #705 §3.1). Called by the boot orchestrator AFTER
   * §2.6 step 5c's `startDefaultApp` succeeds. One-shot idempotent: the first
   * call stamps `bootCompleteAt`; subsequent calls are no-ops, preserving the
   * original timestamp. The set-if-null guard structurally enforces the
   * immutable-once-set invariant — not caller-disciplined.
   *
   * Returns an Effect with a `never` error channel (not sync `void`) so the
   * boot orchestrator can compose it inline with `lookup()` via `yield*`.
   */
  markBootComplete(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.bootCompleteAt === null) {
        this.bootCompleteAt = Date.now();
      }
    });
  }

  /**
   * Primary consumer surface (D #705 §3.1). Encapsulates the
   * `AppNotReadyError` (transient) vs `AppNotFoundError` (durable)
   * discriminator so callers see the typed union directly and never replicate
   * the boot-state rule at the call site.
   *
   * - entry present → succeed.
   * - absent AND `appId === DEFAULT_APP_ID` AND still in the boot transient
   *   (`bootCompleteAt === null`) → `AppNotReadyError` (retryable, -32011).
   * - otherwise → `AppNotFoundError` (durable, -32012).
   */
  lookup(
    appId: AppId,
  ): Effect.Effect<RegisteredApp, AppNotReadyError | AppNotFoundError> {
    const entry = this.entries.get(appId);
    if (entry !== undefined) return Effect.succeed(entry);
    if (appId === DEFAULT_APP_ID && this.bootCompleteAt === null) {
      return Effect.fail(new AppNotReadyError({ appId }));
    }
    return Effect.fail(new AppNotFoundError({ appId }));
  }

  unregister(appId: AppId): boolean {
    return this.entries.delete(appId);
  }

  /**
   * Drop every entry whose connection matches `connectionId`. Used
   * by the WS-close path to clean up any apps the closing connection
   * registered.
   */
  unregisterByConnection(connectionId: string): void {
    for (const [appId, entry] of this.entries) {
      if (entry.endpoint.connId === connectionId) {
        this.entries.delete(appId);
      }
    }
  }

  get(appId: AppId): AppRegistration | undefined {
    return this.entries.get(appId);
  }

  has(appId: AppId): boolean {
    return this.entries.has(appId);
  }
}
