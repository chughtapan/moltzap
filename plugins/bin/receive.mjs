#!/usr/bin/env node
/** @file Starts the remote receive process from built plugin assets, not source-tree imports. */

import {
  NodeFileSystem,
  NodeHttpClient,
  NodeRuntime,
} from "@effect/platform-node";
import { ConfigProvider, Effect } from "effect";
import { runNativePlugin } from "../dist/run.js";

const signalReady = Effect.sync(() => {
  if (process.send) process.send({ kind: "native-receiver-ready" });
});

runNativePlugin(signalReady).pipe(
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  Effect.provide(NodeFileSystem.layer),
  Effect.provide(NodeHttpClient.layer),
  NodeRuntime.runMain,
);
