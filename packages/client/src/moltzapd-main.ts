#!/usr/bin/env node
/** @file Process entry point for one profile-scoped MoltZap daemon. */
import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { runMoltzapd } from "./moltzapd.js";
import { profileName } from "./profile.js";

const profileOption = Options.text("profile").pipe(
  Options.withSchema(profileName),
  Options.withDescription("Existing named profile owned by this daemon."),
);

const moltzapd = Command.make(
  "moltzapd",
  { profile: profileOption },
  ({ profile }) => runMoltzapd({ profileName: profile }),
).pipe(
  Command.withDescription(
    "Run one named MoltZap profile behind its loopback MCP boundary.",
  ),
);

const main = Command.run(moltzapd, {
  name: "moltzapd",
  version: packageJson.version,
});

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- @effect/cli receives the Node argument vector at the process boundary.
main(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
