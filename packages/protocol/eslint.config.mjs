import { packageEslintConfig } from "../../eslint.shared.mjs";

// Protocol's strict layer stack (top → bottom):
//   app → task → network → identity → transport
//
// Each folder is its own layer. Imports flow downward only: a layer
// may import from any layer below it; the reverse fires
// `no-upward-layer-import`. Declaring layers also suppresses
// `no-cross-domain-sibling-import` between any two layered folders.
//
// Layer index convention: index 0 sits at the TOP of the stack
// (composition / entrypoints), higher indices are deeper foundations.
export default packageEslintConfig({
  maxLines: 1200,
  architecture: {
    layers: [
      {
        name: "app",
        folders: ["app"],
        reason:
          "Composition layer: AppHost RPCs composed over task, network, identity, transport descriptors.",
      },
      {
        name: "task",
        folders: ["task"],
        reason: "Task domain: conversations, messages, dispatch, TM authority.",
      },
      {
        name: "network",
        folders: ["network"],
        reason:
          "Network domain: ping, presence, connection liveness, actor-model types.",
      },
      {
        name: "identity",
        folders: ["identity"],
        reason: "Identity domain: agents, users, sessions, contact policy.",
      },
      {
        name: "transport",
        folders: ["transport"],
        reason:
          "Wire layer: Ajv frames, RpcDefinition primitives, dispatch — no domain semantics.",
      },
    ],
  },
});
