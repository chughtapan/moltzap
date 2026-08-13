import { packageEslintConfig } from "../../eslint.shared.mjs";

// Cursor-opacity guard: only the DB-owned cursor codecs may decode a token.
// Banning raw base64url decoding elsewhere keeps consumers independent of the
// server-owned encoding.
const cursorOpacityGuard = {
  files: ["src/**/*.ts"],
  ignores: ["src/db/list-cursor.ts", "**/*.test.ts", "**/*.spec.ts"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.name='atob']",
        message:
          "Cursor tokens are opaque. Decode them only through a DB-owned cursor codec.",
      },
      {
        selector:
          "CallExpression[callee.object.name='Buffer'][callee.property.name='from'][arguments.1.value='base64url']",
        message:
          "Cursor tokens are opaque. Decode them only through a DB-owned cursor codec.",
      },
    ],
  },
};

const databaseRowRules = {
  files: [
    "src/db/database.ts",
    "src/conversation/conversation.service.ts",
    "src/message/message.service.ts",
    "src/identity/agents/handlers.ts",
    "src/db/schema-migration.test.ts",
    "src/standalone.ts",
  ],
  rules: {
    // Kysely and SQL row contracts retain the database's exact snake_case
    // identifiers; platform error-tag mocks likewise retain their upstream
    // constructor names.
    "@typescript-eslint/naming-convention": "off",
  },
};

export default [
  ...packageEslintConfig({
    customJsDocTags: ["internal"],
    tsconfigRootDir: import.meta.dirname,
  }),
  databaseRowRules,
  cursorOpacityGuard,
];
