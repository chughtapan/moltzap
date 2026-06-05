import type { AppManifest } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol";
import { AppId } from "@moltzap/protocol/task";
import type { Originator } from "../transport/connection.js";

/**
 * The minimal server→app dispatch surface a registration needs: the
 * connection id (for close-time cleanup via `unregisterByConnection`) and
 * the outbound {@link Originator} (the `sendRpcToClient` channel). Minted from
 * the live `AppConnection` arm's `{ connId, originator }` at `app/connect`.
 * The boot-installed default app carries an INERT endpoint
 * (`default-app.ts → makeDefaultAppEndpoint`) whose originator defects — its
 * manifest declares only static policies, which AppHost resolves in-process,
 * so the originator is never invoked.
 */
export interface AppEndpoint {
  readonly connId: ConnectionId;
  readonly originator: Originator;
}

/**
 * A registered app. There is NO `InProcess` vs `Remote` distinction —
 * every app, including the boot-installed default, carries an
 * {@link AppEndpoint}. Connected apps hold the `{ connId, originator }`
 * minted from the `AppConnection` arm their `app/connect` call arrived on;
 * the default app holds an inert endpoint (see
 * `default-app.ts → makeDefaultAppEndpoint`) and declares only static
 * policies, which AppHost resolves in-process rather than over the
 * `sendRpcToClient(entry.endpoint.originator, …)` path a `kind: "hook"` policy
 * uses. AppHost sees ONE registration shape regardless.
 */
export interface AppRegistration {
  readonly appId: AppId;
  readonly manifest: AppManifest;
  readonly endpoint: AppEndpoint;
}

/**
 * Single source of truth for app registrations. The registry has no
 * notion of "boot" vs "connected" — both go through {@link register}.
 * The registry itself enforces the no-overwrite invariant: any
 * attempt to register on top of an existing entry returns false.
 * Callers (`app/connect`, `installDefaultApp`) map a
 * `false` return to whatever surfacing they need — typed
 * `ForbiddenError` for the connect path, an exception for boot.
 */
export class AppRegistry {
  private entries = new Map<AppId, AppRegistration>();

  /**
   * Returns true if the registration was installed, false if `appId`
   * is already present. Never overwrites — the caller MUST unregister
   * first if they want to replace.
   *
   * Keyed by the SERVER-MINTED `appId` (the authenticated
   * `AppConnection.auth.appId`, or `DEFAULT_APP_ID` at boot), NOT by
   * `manifest.appId`. The DB issues `app_id` via `gen_random_uuid()`;
   * the manifest's `appId` field does not participate in routing.
   * `task/request` targets the appId the registrant received from
   * `/api/v1/apps/register`, which is this same server-minted identity.
   */
  register(
    appId: AppId,
    manifest: AppManifest,
    endpoint: AppEndpoint,
  ): boolean {
    if (this.entries.has(appId)) return false;
    this.entries.set(appId, { appId, manifest, endpoint });
    return true;
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
