import { packageEslintConfig } from "../../eslint.shared.mjs";

export default [
  {
    ignores: ["nanoclaw-assets/**"],
  },
  ...packageEslintConfig({ tsconfigRootDir: import.meta.dirname }),
];
