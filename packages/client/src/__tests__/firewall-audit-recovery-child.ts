/** @file Repeated process termination exercises the same exclusive store and audit path. */

import { NodeRuntime } from "@effect/platform-node";
import { Config, ConfigProvider, Effect } from "effect";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { beginFirewallAudit } from "../delivery/firewall-audit.js";
import { openEndpointStore } from "../store/index.js";
import { makeAuditFixture } from "./firewall-audit-fixtures.js";

const program = Effect.gen(function* () {
  const directory = yield* Config.string("MOLTZAP_TEST_AUDIT_DIRECTORY");
  const block = yield* Config.boolean("MOLTZAP_TEST_AUDIT_BLOCK");
  const store = yield* openEndpointStore(directory);
  const fixture = yield* makeAuditFixture;
  const checkId = randomUUID();
  yield* store.beginFirewallAttempt({
    ...fixture,
    checkId,
    direction: "outgoing",
    revision: 0,
  });
  yield* store.finishFirewallAttempt({
    checkId,
    admit: false,
    canonicalResult: fixture.canonicalResult,
  });
  const audit = yield* beginFirewallAudit(join(directory, "audit.ndjson"), {
    readFirewallAuditPage: (after) =>
      block && after > 0
        ? Effect.sync(() => process.stdout.write("exporting\n")).pipe(
            Effect.zipRight(Effect.never),
          )
        : store.readFirewallAuditPage(after),
  });
  yield* Effect.sync(() => process.stdout.write("ready\n"));
  yield* audit.finish;
});

NodeRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
  ),
);
