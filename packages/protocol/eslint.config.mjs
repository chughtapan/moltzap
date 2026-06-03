import { packageEslintConfig } from "../../eslint.shared.mjs";

// Protocol's strict layer stack (top → bottom):
//   engine → app → task → network → identity → transport
//
// Each folder is its own layer. Imports flow downward only: a layer
// may import from any layer below it; the reverse fires
// `no-upward-layer-import`. Declaring layers also suppresses
// `no-cross-domain-sibling-import` between any two layered folders.
//
// Layer index convention: index 0 sits at the TOP of the stack
// (composition / entrypoints), higher indices are deeper foundations.
export default [
  ...packageEslintConfig({
    maxLines: 1200,
    customJsDocTags: ["error", "relatedNotification", "triggeredBy", "file"],
    architecture: {
      layers: [
        {
          name: "engine",
          folders: ["engine"],
          reason:
            "RpcServer engine + descriptor-aggregate: the genuine Requirement union, capability middlewares, server/client engine groups, CurrentPrincipal. Couples to the full rpc-registry catalog + the task-layer capability tags, so it sits ABOVE the domains.",
        },
        {
          name: "app",
          folders: ["app"],
          reason:
            "Composition layer: AppHost RPCs composed over task, network, identity, transport descriptors.",
        },
        {
          name: "task",
          folders: ["task"],
          reason:
            "Task domain: conversations, messages, dispatch, TM authority.",
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
  }),
  {
    // Documentation generators are byte-level scanners and TypeDoc
    // walkers. The strict production-code complexity / nesting
    // budgets are wrong for this code; relax those only.
    files: ["scripts/**/*.ts"],
    rules: {
      complexity: "off",
      "max-depth": "off",
      "max-lines-per-function": "off",
      "max-nested-callbacks": "off",
      "max-statements": "off",
      "no-nested-ternary": "off",
      "sonarjs/cognitive-complexity": "off",
      "sonarjs/cyclomatic-complexity": "off",
      "sonarjs/expression-complexity": "off",
      "sonarjs/max-lines-per-function": "off",
      "sonarjs/nested-control-flow": "off",
      "sonarjs/no-nested-conditional": "off",
      "sonarjs/no-nested-functions": "off",
      "sonarjs/no-nested-template-literals": "off",
      "sonarjs/too-many-break-or-continue-in-loop": "off",
      // Script entry points are short-lived processes; traces add
      // noise without value.
      "agent-code-guard/require-span-on-exported-effect": "off",
    },
  },
];
