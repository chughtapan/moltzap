import { rootEslintConfig } from "./eslint.shared.mjs";

export { packageEslintConfig } from "./eslint.shared.mjs";

export default rootEslintConfig({ tsconfigRootDir: import.meta.dirname });
