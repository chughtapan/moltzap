/** @file Default host services for complete simulator programs. */

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Layer } from "effect";
import { filesystemLedgerStorageLayer } from "./ledger/filesystem.js";
import {
  moltZapRouterLayer,
  type MoltZapRouterOptions,
} from "./network/moltzap.js";

/** Host configuration shared by every run provided with this Layer. */
export interface SimulatorLayerOptions {
  readonly ledgerDirectory: string;
  readonly router: MoltZapRouterOptions;
}

/**
 * Provide the production router, filesystem ledger, and Effect Platform host
 * services once at the application boundary.
 */
export function simulatorLayer(options: SimulatorLayerOptions) {
  const host = Layer.merge(NodeContext.layer, NodeHttpClient.layerUndici);
  const simulator = Layer.merge(
    filesystemLedgerStorageLayer(options.ledgerDirectory),
    moltZapRouterLayer(options.router),
  );
  return simulator.pipe(Layer.provideMerge(host));
}
