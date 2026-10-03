/** @file Pins that local emission never waits on the delivery gate. */

import { Deferred, Effect, Encoding, Schema, Scope } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The store opens a real SQLite database in a temporary directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DaemonRuntimeError } from "./activation.js";
import { noHistoryExport } from "../delivery/history-export.js";
import { makeHostDelivery } from "../delivery/index.js";
import { openEndpointStore } from "../store/index.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import { emitLocalItem } from "./supervision.js";

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const failure = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: `col_${Encoding.encodeBase64Url(new Uint8Array(32).fill(1))}`,
  to: "agent:bob",
  error: "request unavailable",
});

/** A pass that classifies a post holds the gate while the collective layer emits. */
it("emits a local item while the delivery gate is held", () => {
  const path = mkdtempSync(join(tmpdir(), "moltzap-supervision-"));
  directories.push(path);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path);
        const daemonScope = yield* Scope.Scope;
        const delivery = yield* makeHostDelivery({
          store,
          historyExport: noHistoryExport,
          collectives: () => undefined,
          scope: daemonScope,
        });
        const fatal = yield* Deferred.make<never, DaemonRuntimeError>();
        const { gate } = delivery.state;
        const reconciler = gate.withPermits(1)(Effect.void);
        yield* gate.withPermits(1)(
          emitLocalItem(
            { fatal, daemonScope, delivery },
            reconciler,
            failure,
          ).pipe(
            Effect.timeoutFail({
              duration: "5 seconds",
              onTimeout: () =>
                new Error("emission waited on the delivery gate"),
            }),
          ),
        );
        expect([...delivery.state.localItems.values()]).toEqual([failure]);
      }),
    ),
  );
});
