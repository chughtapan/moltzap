import { RunSpec } from "@moltzap/simulator";
import { reactivePeer } from "/opt/moltzap/node_modules/@moltzap/evals/dist/peer.js";
import { decodeEvaluationCaseId } from "/opt/moltzap/node_modules/@moltzap/evals/dist/model.js";
import {
  controllerServicesFromEnvironment,
  supportImageFromEnvironment,
} from "/opt/moltzap/dist/cluster/controller/services.js";
import { runFaultExchange } from "/opt/moltzap/qualification/simulator-fault-program.mjs";

const CONTROLLER_NAME = "controller";
const HELD_NAME = "held";
const FREE_NAME = "free";

const heldDefinition = reactivePeer(
  decodeEvaluationCaseId("EVAL-998"),
  CONTROLLER_NAME,
  ["held-reply"],
);
const freeDefinition = reactivePeer(
  decodeEvaluationCaseId("EVAL-999"),
  CONTROLLER_NAME,
  ["free-reply"],
);
const applicationImage = supportImageFromEnvironment();

const agents = {
  [HELD_NAME]: heldDefinition.runtime(applicationImage),
  [FREE_NAME]: freeDefinition.runtime(applicationImage),
};

export const runSpec = RunSpec.define({
  id: "moltzap.fault-end-to-end/v1",
  events: [],
  agents,
  cluster: controllerServicesFromEnvironment(),
  execute: runFaultExchange,
});
