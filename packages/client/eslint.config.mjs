import { packageEslintConfig } from "../../eslint.shared.mjs";

/**
 * Keeps `transport/messaging/outbox.ts` the one production module that signs
 * an outer envelope, so every outer body leaves through the path that seals
 * it. `transport/wire/` defines and re-exports the signers, and tests sign
 * peer envelopes directly.
 */
const soleOuterSigner = {
  files: ["src/**/*.ts"],
  ignores: [
    "src/transport/messaging/outbox.ts",
    "src/transport/wire/**",
    "src/**/*.test.ts",
    "src/__tests__/**",
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: "(^|/)wire/(encoding/)?(index|codec)\\.js$",
            importNames: ["signOuterPacket", "signOuterEvidence"],
            message:
              "Only transport/messaging/outbox.ts signs outer envelopes; queue the body through the engine outbox.",
          },
        ],
      },
    ],
  },
};

export default [
  ...packageEslintConfig({
    projects: [
      "./tsconfig.json",
      "./tsconfig.test.json",
      "./tsconfig.integration.json",
    ],
    tsconfigRootDir: import.meta.dirname,
  }),
  soleOuterSigner,
];
