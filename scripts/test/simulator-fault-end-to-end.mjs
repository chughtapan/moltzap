import { RunSpec } from "@moltzap/simulator";
import { faultPeerRuntime } from "/opt/moltzap/qualification/simulator-fault-peer.mjs";
import {
  controllerServicesFromEnvironment,
  supportImageFromEnvironment,
} from "@moltzap/simulator/controller";
import { runFaultExchange } from "/opt/moltzap/qualification/simulator-fault-program.mjs";

const applicationImage = supportImageFromEnvironment();
const agents = {
  held: faultPeerRuntime(applicationImage, "held-reply"),
  free: faultPeerRuntime(applicationImage, "free-reply"),
};

export const runSpec = RunSpec.define({
  id: "moltzap.fault-end-to-end/v1",
  events: [],
  agents,
  cluster: controllerServicesFromEnvironment(),
  execute: runFaultExchange,
});
