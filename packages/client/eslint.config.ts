/**
 * @file Package ESLint configuration: the shared workspace preset plus the
 * rules that keep envelope signing in its owning modules.
 */
import { packageEslintConfig } from "../../eslint.shared.js";

/** Test files, which sign peer envelopes directly. */
const testFiles = ["src/**/*.test.ts", "src/__tests__/**"];

/**
 * Keeps `transport/messaging/outbox.ts` the one production module that signs
 * an outer envelope, which it stores before the Router worker sends it.
 * `transport/wire/` defines and re-exports the signers.
 */
const soleOuterSigner = {
  files: ["src/**/*.ts"],
  ignores: [
    "src/transport/messaging/outbox.ts",
    "src/transport/wire/**",
    ...testFiles,
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

/**
 * Keeps `transport/wire/encoding/codec.ts` the one module that calls
 * Identity's `SignedMessage.sign`, which it does for an outer envelope only
 * after sealing its body. The guard covers who signs, not what the outbox
 * enqueues: its port accepts any `SignedMessage`.
 */
const sealingSigner = {
  files: ["src/**/*.ts"],
  ignores: ["src/transport/wire/encoding/codec.ts", ...testFiles],
  rules: {
    "no-restricted-properties": [
      "error",
      {
        object: "SignedMessage",
        property: "sign",
        message:
          "Only transport/wire/encoding/codec.ts signs a SignedMessage, after sealing every outer body; queue the body through the engine outbox.",
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
  sealingSigner,
];
