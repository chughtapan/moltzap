import { packageEslintConfig } from "../../eslint.shared.mjs";

// `plugin.ts` keeps the OpenClaw registration and channel callbacks together
// so a reader can see the complete host contract in one place.
export default packageEslintConfig({
  maxLines: 1200,
  tsconfigRootDir: import.meta.dirname,
});
