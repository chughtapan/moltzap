import type { AppManifest } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { AppId } from "@moltzap/protocol/task";
import { Value } from "@sinclair/typebox/value";
import type {
  MessageAuthorizeHook,
  TaskAuthorizeDispatchHook,
} from "./hooks.js";

export interface InProcessHooks {
  readonly dispatchAuthorize: TaskAuthorizeDispatchHook;
  readonly messageAuthorize?: MessageAuthorizeHook;
}

/**
 * A single tagged-union registration per app. Replaces the four
 * parallel maps (`manifests`, `hooks`, `messageAuthorizeHooks`,
 * `remoteRegistrations`) that AppHost used to thread through every
 * lookup.
 *
 * Properties enforced by the type:
 *  - manifest is bundled with its hooks; a "registered manifest with
 *    no hook" state is unrepresentable.
 *  - `InProcess` carries `dispatchAuthorize` (required) and optionally
 *    `messageAuthorize`; both run via the server's in-process hook
 *    runner — never over the wire.
 *  - `Wire` carries `connectionId`; the server invokes both
 *    `dispatch/authorize` and `messages/authorize` over the WS
 *    callback channel.
 *  - The two variants are mutually exclusive: a single app cannot be
 *    in-process AND wire-registered at the same time.
 *
 * The default app (DEFAULT_APP_ID) is the only `InProcess` registration
 * in production today — it is server-installed at boot. Tests that
 * need a custom hook MUST AppsRegister over the wire and attach an
 * `onAppCallback` handler.
 */
export type AppRegistration =
  | {
      readonly _tag: "InProcess";
      readonly appId: AppId;
      readonly manifest: AppManifest;
      readonly dispatchAuthorize: TaskAuthorizeDispatchHook;
      readonly messageAuthorize?: MessageAuthorizeHook;
    }
  | {
      readonly _tag: "Remote";
      readonly appId: AppId;
      readonly manifest: AppManifest;
      readonly connectionId: ConnectionId;
    };

/**
 * Single source of truth for app registrations. Wraps one
 * map of appId to registration. Remote registrations cannot overwrite
 * an `InProcess` entry (a malicious client MUST NOT wire-register as
 * DEFAULT_APP_ID and hijack the boot-installed grant hook); enforced
 * inside `registerRemote`. `installInProcess` is boot-time only and
 * just sets the entry — duplicate installs are last-writer-wins.
 */
export class AppRegistry {
  private entries = new Map<AppId, AppRegistration>();

  installInProcess(manifest: AppManifest, hooks: InProcessHooks): void {
    const appId = Value.Decode(AppId, manifest.appId);
    this.entries.set(appId, {
      _tag: "InProcess",
      appId,
      manifest,
      ...hooks,
    });
  }

  /**
   * Returns true on success; false if the app is already registered
   * in-process (boot-installed). Callers translate `false` into a
   * wire `ForbiddenError` so the remote app sees a clean refusal.
   */
  registerRemote(manifest: AppManifest, connectionId: ConnectionId): boolean {
    const appId = Value.Decode(AppId, manifest.appId);
    const existing = this.entries.get(appId);
    if (existing && existing._tag === "InProcess") {
      return false;
    }
    this.entries.set(appId, { _tag: "Remote", appId, manifest, connectionId });
    return true;
  }

  /**
   * Drop a remote registration. No-op if absent or if the entry is
   * in-process (boot-installed apps stay installed for the server's
   * lifetime).
   */
  unregisterRemote(appId: AppId): boolean {
    const existing = this.entries.get(appId);
    if (!existing || existing._tag !== "Remote") return false;
    this.entries.delete(appId);
    return true;
  }

  get(appId: AppId): AppRegistration | undefined {
    return this.entries.get(appId);
  }

  has(appId: AppId): boolean {
    return this.entries.has(appId);
  }
}
