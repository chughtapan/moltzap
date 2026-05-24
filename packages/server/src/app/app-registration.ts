import type { AppManifest } from "@moltzap/protocol";
import { AppId } from "@moltzap/protocol/task";
import { Value } from "@sinclair/typebox/value";
import type { MoltZapConnection } from "../transport/connection.js";

/**
 * A registered app. There is NO `InProcess` vs `Remote` distinction —
 * every app, including the boot-installed default, carries a
 * `MoltZapConnection`. Wire-registered apps hold the real WebSocket
 * connection their `apps/register` call arrived on; the default app
 * holds a loopback connection (see `loopback-connection.ts`) whose
 * `originator.call` dispatches in-process. AppHost sees ONE shape and
 * uses ONE dispatch path: `sendRpcToClient(entry.connection, …)`.
 */
export interface AppRegistration {
  readonly appId: AppId;
  readonly manifest: AppManifest;
  readonly connection: MoltZapConnection;
}

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
   * Returns true if the registration was installed, false if `appId`
   * is already present. Never overwrites — the caller MUST unregister
   * first if they want to replace.
   */
  register(manifest: AppManifest, connection: MoltZapConnection): boolean {
    const appId = Value.Decode(AppId, manifest.appId);
    if (this.entries.has(appId)) return false;
    this.entries.set(appId, { appId, manifest, connection });
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
      if (entry.connection.id === connectionId) {
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
