import guard from "eslint-plugin-agent-code-guard";
import { packageEslintConfig } from "../../eslint.shared.mjs";

export default [
  ...packageEslintConfig(),
  {
    files: ["src/network/**/*.ts", "src/task/**/*.ts"],
    plugins: guard.configs.architecture.plugins,
    rules: {
      "agent-code-guard/architecture-directive-parse-error": "error",
      "agent-code-guard/no-upward-layer-import": [
        "error",
        {
          layers: [
            {
              name: "app-handlers",
              folders: ["app/handlers"],
              reason:
                "Application RPC handlers sit above task and network handlers; lower layers must not import them.",
            },
            {
              name: "task",
              folders: ["task"],
              reason:
                "Task handlers may depend on the network layer contract, but network handlers must not depend on task behavior.",
            },
            {
              name: "network",
              folders: ["network"],
              reason:
                "Network handlers are the lowest RPC layer and may only depend on shared lower-level contracts.",
            },
          ],
        },
      ],
    },
  },
];
