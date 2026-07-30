import { Effect } from "effect";
import type { AppId, AppManifest } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { ContactService } from "#identity/contacts";
import {
  AppRegistry,
  type AppEndpoint,
  type AppRegistration,
} from "./registry.js";

/** Implements app endpoint registry. */
export class AppEndpointRegistry {
  private readonly apps = new AppRegistry();
  private contactService: ContactService | null = null;

  registerApp(
    appId: AppId,
    manifest: AppManifest,
    endpoint: AppEndpoint,
  ): boolean {
    const ok = this.apps.register(appId, manifest, endpoint);
    if (ok) {
      Effect.runFork(
        Effect.logInfo("App registered").pipe(
          Effect.annotateLogs({
            appId,
            connectionId: endpoint.connId,
          }),
        ),
      );
    }
    return ok;
  }

  unregisterApp(appId: AppId): void {
    if (this.apps.unregister(appId)) {
      Effect.runFork(
        Effect.logInfo("App unregistered").pipe(Effect.annotateLogs({ appId })),
      );
    }
  }

  unregisterAppsForConnection(connId: ConnectionId): void {
    this.apps.unregisterByConnection(connId);
  }

  lookupApp(appId: AppId): AppRegistration | undefined {
    return this.apps.get(appId);
  }

  setContactService(checker: ContactService): void {
    this.contactService = checker;
  }

  getContactService(): ContactService | null {
    return this.contactService;
  }
}
